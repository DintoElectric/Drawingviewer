/* ------------------------------------------------------------------ *
 *  compare-cloud.js — talks to /compare-store (saved comparisons per
 *  login) and reads/writes the single-file ".dhcompare" export.
 *
 *  Server side:  netlify/functions/compare-store.js
 *  Used by:      compare-page.js
 * ------------------------------------------------------------------ */
import { api, apiBlob } from "./auth.js";

const FN = "compare-store";
const MB = 1024 * 1024;

export const FILE_EXT = ".dhcompare";
const MAGIC = "DHCMP001";                 // first 8 bytes of every export file
const MAX_HEADER = 2 * MB;                // sanity limit for the notes/header block
const MAX_IMPORT_FILE = 200 * MB;         // sanity limit for a drawing inside an export
const MAX_NOTES = 500;
const MAX_PAIRS = 1000;
const CATS = ["Changed", "Added", "Removed", "Question", "Other"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qs = (o) => new URLSearchParams(o).toString();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const baseName = (n) => String(n || "").replace(/\.[^.]+$/, "");

export function fmtBytes(n) {
  if (n < 1024) return n + " B";
  if (n < MB) return Math.round(n / 1024) + " KB";
  if (n < 100 * MB) return (n / MB).toFixed(1) + " MB";
  return Math.round(n / MB) + " MB";
}

function checkAbort(signal) {
  if (signal && signal.aborted) throw new Error("Cancelled.");
}

// Retries a flaky request (iPad on weak wifi) a couple of times. Never retries a sign-in problem.
async function retry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      if (/sign in/i.test(e.message || "")) throw e;
      if (i < tries - 1) await sleep(700 * (i + 1));
    }
  }
  throw last;
}

function toB64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("Couldn't read the file from this device."));
    r.readAsDataURL(blob);
  });
}

function mimeFor(meta) {
  if (meta.kind === "pdf" || /\.pdf$/i.test(meta.name)) return "application/pdf";
  return meta.mime && /^image\//.test(meta.mime) ? meta.mime : "image/jpeg";
}

/* ------------------------------------------------------------------ *
 *  Saved comparisons on the server
 * ------------------------------------------------------------------ */

// -> { items:[{id,title,notes,kind,pairs,created,updated,A:{name,size,...},B:{...}}], slotsUsed, usedBytes, limits }
export function listComparisons() {
  return api(`${FN}?${qs({ action: "list" })}`);
}

// -> { item, state }
export function getComparison(id) {
  return api(`${FN}?${qs({ action: "get", id })}`);
}

// Pulls both drawings back down as File objects (same kind the file picker gives the page).
export async function downloadFiles(item, { onProgress, signal } = {}) {
  const total = item.A.size + item.B.size;
  let done = 0;
  const out = {};
  for (const w of ["A", "B"]) {
    const meta = item[w];
    const parts = [];
    for (let i = 0; i < meta.chunks; i++) {
      checkAbort(signal);
      const blob = await retry(() => apiBlob(`${FN}?${qs({ action: "file", id: item.id, which: w, chunk: i })}`));
      parts.push(blob);
      done += blob.size;
      if (onProgress) onProgress({ phase: "download", which: w, done, total });
    }
    const file = new File(parts, meta.name, { type: mimeFor(meta), lastModified: item.created || Date.now() });
    if (file.size !== meta.size) throw new Error(`Drawing ${w} didn't download completely. Please try again.`);
    out[w] = file;
  }
  return out;
}

// Saves a NEW comparison. If anything fails or is cancelled, the half-saved copy is removed
// so it doesn't use up one of the person's slots.
// state = { title, preparedBy, notes, view:{mode,p,opacity}, pages:{A,B}, sets }
export async function saveComparison({ A, B, state, onProgress, signal }) {
  const total = A.size + B.size;
  const begin = await api(FN, {
    method: "POST",
    body: {
      action: "begin",
      title: state.title || "",
      files: {
        A: { name: A.name, size: A.size, mime: A.type },
        B: { name: B.name, size: B.size, mime: B.type },
      },
    },
  });
  const id = begin.id, cb = begin.chunkBytes;
  let done = 0;
  try {
    for (const [w, file] of [["A", A], ["B", B]]) {
      const n = Math.ceil(file.size / cb);
      for (let i = 0; i < n; i++) {
        checkAbort(signal);
        const piece = file.slice(i * cb, Math.min(file.size, (i + 1) * cb));
        const dataB64 = await toB64(piece);
        await retry(() => api(FN, { method: "POST", body: { action: "chunk", id, which: w, index: i, dataB64 } }));
        done += piece.size;
        if (onProgress) onProgress({ phase: "upload", which: w, done, total });
      }
    }
    checkAbort(signal);
    const res = await api(FN, { method: "POST", body: { action: "commit", id, state } });
    return res.item;
  } catch (e) {
    try { await api(FN, { method: "POST", body: { action: "delete", id } }); } catch (_) { /* best effort */ }
    throw e;
  }
}

// Saves changed notes / view settings / sheet pairings for an already-saved comparison.
export function updateState(id, state) {
  return api(FN, { method: "POST", body: { action: "update", id, state } });
}
export function renameComparison(id, title) {
  return api(FN, { method: "POST", body: { action: "rename", id, title } });
}
export function deleteComparison(id) {
  return api(FN, { method: "POST", body: { action: "delete", id } });
}

// Autosave helper: call schedule() every time notes change. It waits for a pause, saves once,
// never runs two saves at the same time, and retries after a failure.
//   onStatus("saving" | "saved" | "error", error?)
export function createAutosaver({ id, getState, onStatus, delay = 1500 }) {
  let timer = null, running = false, dirty = false, stopped = false, curId = id;
  const say = (s, e) => { if (onStatus) onStatus(s, e); };

  async function run() {
    if (running || stopped || !curId) return;
    running = true; dirty = false;
    say("saving");
    try {
      await updateState(curId, getState());
      say(dirty ? "saving" : "saved");
    } catch (e) {
      dirty = true;
      say("error", e);
      if (!stopped) { clearTimeout(timer); timer = setTimeout(run, 6000); }
    } finally {
      running = false;
    }
    if (dirty && !stopped && !timer) timer = setTimeout(run, delay);
  }

  return {
    schedule() { if (stopped) return; dirty = true; say("saving"); clearTimeout(timer); timer = setTimeout(() => { timer = null; run(); }, delay); },
    async flush() {
      clearTimeout(timer); timer = null;
      while (running) await sleep(60);
      if (dirty && !stopped) await run();
    },
    setId(next) { curId = next; },
    stop() { stopped = true; clearTimeout(timer); timer = null; },
  };
}

/* ------------------------------------------------------------------ *
 *  The single-file export (.dhcompare)
 *
 *  Layout:  8 bytes  "DHCMP001"
 *           4 bytes  header length N (little-endian)
 *           N bytes  header JSON (title, notes, view, sheet pairs, file names + sizes)
 *           drawing A bytes, then drawing B bytes
 *  Built from Blob pieces, so big scans are never copied into memory.
 * ------------------------------------------------------------------ */
const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };

function cleanNotes(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX_NOTES).map((n) => {
    if (!n || typeof n !== "object") return null;
    const x = Number(n.x), y = Number(n.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const pa = parseInt(n.pa, 10), pb = parseInt(n.pb, 10);
    return {
      id: String(n.id || Math.random().toString(36).slice(2, 10)).slice(0, 40),
      x: clamp(x, 0, 1), y: clamp(y, 0, 1),
      pa: Number.isInteger(pa) && pa >= 0 ? pa : 1,       // 0 = no matching sheet in set A
      pb: Number.isInteger(pb) && pb >= 0 ? pb : 1,       // 0 = no matching sheet in set B
      cat: CATS.includes(n.cat) ? n.cat : "Other",
      text: String(n.text == null ? "" : n.text).slice(0, 2000),
      t: Number.isFinite(Number(n.t)) ? Number(n.t) : Date.now(),
    };
  }).filter(Boolean);
}

function cleanView(v) {
  v = v && typeof v === "object" ? v : {};
  const p = Number(v.p), o = Number(v.opacity);
  return {
    mode: v.mode === "overlay" ? "overlay" : "slider",
    p: Number.isFinite(p) ? clamp(p, 0, 1) : 0.5,
    opacity: Number.isFinite(o) ? clamp(o, 0, 1) : 1,
  };
}

// Whole-set comparisons: which page of set A goes with which page of set B.
export function cleanSets(s) {
  if (!s || typeof s !== "object" || !s.on) return { on: false };
  const pairs = (Array.isArray(s.pairs) ? s.pairs : []).slice(0, MAX_PAIRS).map((p) => {
    p = p && typeof p === "object" ? p : {};
    const a = parseInt(p.a, 10), b = parseInt(p.b, 10);
    const chg = p.chg == null ? null : Number(p.chg);
    return {
      a: Number.isInteger(a) && a > 0 ? Math.min(a, 9999) : 0,
      b: Number.isInteger(b) && b > 0 ? Math.min(b, 9999) : 0,
      num: String(p.num == null ? "" : p.num).slice(0, 40),
      title: String(p.title == null ? "" : p.title).slice(0, 120),
      manual: !!p.manual,
      chg: Number.isFinite(chg) ? clamp(chg, -1, 1e9) : null,
    };
  }).filter((p) => p.a || p.b);
  const cur = parseInt(s.cur, 10);
  return {
    on: true,
    match: s.match === "order" ? "order" : "number",
    tb: ["br", "right", "none"].includes(s.tb) ? s.tb : "br",
    cur: Number.isInteger(cur) ? clamp(cur, 0, Math.max(0, pairs.length - 1)) : 0,
    pairs,
  };
}

export function exportFileName(state, A, B) {
  const raw = (state.title || "").trim() || `${baseName(A.name)} vs ${baseName(B.name)}`;
  const slug = raw.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_").slice(0, 60) || "Drawing_Comparison";
  return slug + FILE_EXT;
}

// -> Blob. state = { title, preparedBy, notes, view, pages, sets }
export function buildExport({ A, B, state }) {
  const header = {
    format: "dhcompare", version: 1, created: Date.now(),
    title: state.title || "", preparedBy: state.preparedBy || "",
    notes: cleanNotes(state.notes), view: cleanView(state.view),
    pages: { A: (state.pages && state.pages.A) || 1, B: (state.pages && state.pages.B) || 1 },
    sets: cleanSets(state.sets),
    files: {
      A: { name: A.name, size: A.size, type: A.type },
      B: { name: B.name, size: B.size, type: B.type },
    },
  };
  const hb = new TextEncoder().encode(JSON.stringify(header));
  return new Blob([MAGIC, u32le(hb.length), hb, A, B], { type: "application/octet-stream" });
}

// Reads a .dhcompare file -> { state, A: File, B: File }. Rejects anything damaged or unrelated.
export async function parseExport(file) {
  const damaged = () => new Error("This saved comparison file looks damaged or incomplete.");
  if (file.size < 14) throw new Error("That isn't a saved comparison file.");
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (String.fromCharCode(...head.subarray(0, 8)) !== MAGIC) throw new Error("That isn't a saved comparison file.");
  const hlen = new DataView(head.buffer, 8, 4).getUint32(0, true);
  if (hlen < 2 || hlen > MAX_HEADER || 12 + hlen > file.size) throw damaged();

  let h;
  try { h = JSON.parse(await file.slice(12, 12 + hlen).text()); } catch (e) { throw damaged(); }
  if (!h || h.format !== "dhcompare") throw new Error("That isn't a saved comparison file.");
  if (h.version !== 1) throw new Error("This file was made by a newer version of the app. Reload the page and try again.");

  const fa = h.files && h.files.A, fb = h.files && h.files.B;
  const sA = fa && parseInt(fa.size, 10), sB = fb && parseInt(fb.size, 10);
  if (!Number.isInteger(sA) || !Number.isInteger(sB) || sA < 1 || sB < 1) throw damaged();
  if (sA > MAX_IMPORT_FILE || sB > MAX_IMPORT_FILE) throw new Error("A drawing inside this file is too large to open.");
  if (12 + hlen + sA + sB !== file.size) throw damaged();     // exact size check catches truncated downloads

  const when = Number.isFinite(Number(h.created)) ? Number(h.created) : Date.now();
  const mk = (meta, size, offset, fallback) => {
    const name = String(meta.name || fallback).slice(0, 200) || fallback;
    const type = /pdf/i.test(meta.type || "") || /\.pdf$/i.test(name) ? "application/pdf"
               : (/^image\//.test(meta.type || "") ? String(meta.type).slice(0, 100) : "image/jpeg");
    return new File([file.slice(offset, offset + size)], name, { type, lastModified: when });
  };
  const A = mk(fa, sA, 12 + hlen, "Drawing A.pdf");
  const B = mk(fb, sB, 12 + hlen + sA, "Drawing B.pdf");

  const pa = parseInt(h.pages && h.pages.A, 10), pb = parseInt(h.pages && h.pages.B, 10);
  return {
    A, B,
    state: {
      title: String(h.title || "").slice(0, 140),
      preparedBy: String(h.preparedBy || "").slice(0, 80),
      notes: cleanNotes(h.notes),
      view: cleanView(h.view),
      pages: { A: Number.isInteger(pa) && pa > 0 ? pa : 1, B: Number.isInteger(pb) && pb > 0 ? pb : 1 },
      sets: cleanSets(h.sets),
    },
  };
}

// Hands a Blob to the browser as a download (Downloads / Files app on iPad).
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
}

// Export a comparison that's saved on the server (used by "Export" in My comparisons, so a
// person can export it and then delete it to free a slot).
export async function exportSaved(id, { onProgress, signal } = {}) {
  const { item, state } = await getComparison(id);
  const files = await downloadFiles(item, { onProgress, signal });
  const blob = buildExport({ A: files.A, B: files.B, state });
  saveBlob(blob, exportFileName(state, files.A, files.B));
  return item;
}
