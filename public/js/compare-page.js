import { requireLogin } from "./auth.js";
import * as cloud from "./compare-cloud.js";
import * as colors from "./cmp-colors.js";

/* ------------------------------------------------------------------ *
 *  Compare page: two drawings (PDF or image) or two whole drawing sets,
 *  slider/overlay compare, pinch/pan zoom, numbered notes, print, export,
 *  and saved comparisons (per login) with a single-file export (.dhcompare).
 *
 *  Whole sets: each set is one multi-page PDF. Sheets are matched by sheet
 *  number (read from each page's title block) or by page order, every matched
 *  pair gets a "changed / no visible change" flag, and notes belong to a pair
 *  (they already store a page number for A and for B; 0 = no matching sheet).
 *
 *  Word/Excel export contract (implemented in compare-export.js):
 *    exportWord(ctx)  /  exportExcel(ctx)
 *    ctx = {
 *      title, preparedBy, date, dateISO, slug, zoneNote, mode, overlayNote, setMode,
 *      fileA: {name, page, pages}, fileB: {name, page, pages},
 *      sheets: [{idx, num, title, status, statusText, a, b, notes}]    // set mode only
 *      notes: [{n, id, cat, text, zone, x, y, pageA, pageB, created, sheet, sheetIdx}],
 *      getOverview(maxPx, pa?, pb?) -> Promise<{data:Uint8Array, w, h}>   // PNG
 *      getCrops(note)               -> Promise<{a:{data,w,h}, b:{data,w,h}}>
 *    }
 * ------------------------------------------------------------------ */

const pdfjsLib = window.pdfjsLib;
if (pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}
document.body.classList.add("viewer-page");

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dpr = () => Math.min(window.devicePixelRatio || 1, 3);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const yieldUI = () => new Promise((r) => setTimeout(r, 0));
const baseName = (n) => String(n || "").replace(/\.[^.]+$/, "");
const fmtWhen = (ms) => {
  const d = new Date(ms);
  return isNaN(d) ? "" : d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
};

const viewport = $("viewport");
const stage = $("stage");
const divider = $("divider");
const handle = divider.querySelector(".handle");
const pinsEl = $("pins");
const emptyEl = $("empty");

// overlay colors (a personal preference kept in this browser)
colors.init();
colors.bindLegend($("legend"));
colors.bindButton($("colorBtn"));

/* ---------- limits (conservative for iPad Safari canvas memory) ---------- */
const MIN_Z = 0.4, MAX_Z = 12;
const BASE_MAX_PX = 4e6;               // sheet bitmap cap: keeps sheets quick to draw and turn (zooming re-renders sharply)
const DETAIL_MAX_PX = 9e6;
const PRINT_MAXPX = 8e6;
const SET_PRINT_MAXPX = 4e6;             // per-sheet overview when printing a whole set
const CROP_W = 300, CROP_RATIO = 0.75, CROP_K = 2.4;   // crop region in stage units (stage width = 1000)
const ZCOLS = 8, ZROWS = 6;

// whole-set change checking
const WORK_PX = 1400;                    // long side of the reduced picture used to look for changes
const CHG_MIN_PX = 45;                   // fewer different pixels than this = "no visible change"
const SHEET_RE = /^[A-Z]{1,3}[-. ]?\d{1,3}(?:\.\d{1,3})?[A-Z]?$/;   // E-101, E101, ES-001, E-101.1, E-101A
const TB_REGION = { br: [0.72, 0.72], right: [0.82, 0], none: [2, 2] };   // [left edge, top edge] left out of the check
const LOOK_PX = 220, LOOK_GX = 32, LOOK_GY = 24, LOOK_MIN = 0.45;   // matching sheets by how they look, when numbers can't be read
const CACHE_MAX = 8;                     // finished sheet bitmaps kept so turning back and forth is instant

/* ---------- state ---------- */
const S = { z: 1, tx: 0, ty: 0, vw: 800, vh: 600, W0: 800, H0: 600 };
const view = { mode: "slider", p: 0.5, opacity: 1, noting: false };
const slots = { A: null, B: null };      // {doc, page}   doc = {name, fp, file, numPages, getPage, destroy}; page 0 = blank (no matching sheet)
let cpOn = false;
let notes = [];                          // {id,x,y,pa,pb,cat,text,t}
let selId = null;
let edit = null;                         // note (or draft) open in the editor

let cloudId = null;                      // id of the saved copy on the server (null = not saved)
let autosaver = null;
let lastSave = "saved";                  // "saving" | "saved" | "error"
let savedData = null;                    // last list shown on the start screen

// whole sets
const setS = { on: false, match: "number", tb: "br", pairs: [], cur: 0, idx: { A: [], B: [] },
               filter: "all", run: 0, done: 0, total: 0, notice: "" };
let bgRun = 0, bgTask = null;            // background work (preparing neighbouring sheets, checking for changes)
let mountBusy = false, lastNav = 0;
const baseCache = new Map();             // finished sheet bitmaps, newest last

// Saved lists can lag a moment behind changes on the server, so remember what was
// saved / deleted / renamed during this visit and apply it to every list we show.
const sessionAdded = new Map();          // id -> item saved during this visit
const sessionGone = new Set();           // ids deleted during this visit
const sessionRenamed = new Map();        // id -> new title

/* ---------- toast helpers ---------- */
function toast(title, body, err = true, ms = 4200) {
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : "");
  t.innerHTML = `<div><div class="t-title">${esc(title)}</div>${body ? `<div class="t-body">${esc(body)}</div>` : ""}</div>`;
  document.body.appendChild(t);
  if (ms) setTimeout(() => t.remove(), ms);
  return t;
}
const flash = (title, body) => toast(title, body, true);

/* ------------------------------------------------------------------ *
 *  Opening a file (PDF via pdf.js, or an image wrapped to look like a page)
 * ------------------------------------------------------------------ */
function imagePage(img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  return {
    getViewport({ scale = 1, offsetX = 0, offsetY = 0 } = {}) {
      return { width: w * scale, height: h * scale, scale, offsetX, offsetY };
    },
    render({ canvasContext, viewport: vp }) {
      let cancelled = false;
      const promise = Promise.resolve().then(() => {
        if (cancelled) { const e = new Error("cancelled"); e.name = "RenderingCancelledException"; throw e; }
        canvasContext.imageSmoothingEnabled = true;
        canvasContext.imageSmoothingQuality = "high";
        canvasContext.drawImage(img, vp.offsetX, vp.offsetY, w * vp.scale, h * vp.scale);
      });
      return { promise, cancel() { cancelled = true; } };
    },
  };
}

// A blank white sheet, used on the side of a pair that has no matching sheet.
function blankPage(w, h) {
  return {
    getViewport({ scale = 1, offsetX = 0, offsetY = 0 } = {}) {
      return { width: w * scale, height: h * scale, scale, offsetX, offsetY };
    },
    render() { return { promise: Promise.resolve(), cancel() {} }; },
  };
}

async function openFile(file) {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const fp = `${file.name}|${file.size}|${file.lastModified}`;
  if (isPdf) {
    if (!pdfjsLib) throw new Error("The PDF library didn't load. Check your connection and reload.");
    try {
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
      return { name: file.name, fp, file, isPdf: true, numPages: pdf.numPages, getPage: (n) => pdf.getPage(n),
               destroy() { try { pdf.destroy(); } catch (e) {} } };
    } catch (e) {
      if (e && e.name === "PasswordException") throw new Error("That PDF is password-protected.");
      throw new Error("Couldn't open that PDF.");
    }
  }
  if (!/^image\//.test(file.type) && !/\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(file.name)) {
    throw new Error("That file type isn't supported. Choose a PDF, JPG or PNG.");
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try { await img.decode(); }
  catch (e) { URL.revokeObjectURL(url); throw new Error("Couldn't read that image. Try a PDF, JPG or PNG."); }
  const page = imagePage(img);
  return { name: file.name, fp, file, isPdf: false, numPages: 1, getPage: async () => page, destroy() { URL.revokeObjectURL(url); } };
}

// The two pages of a pair. A missing side (page 0) becomes a blank sheet the size of the other one.
async function pagePair(pa, pb) {
  let pageA = pa ? await slots.A.doc.getPage(pa) : null;
  let pageB = pb ? await slots.B.doc.getPage(pb) : null;
  if (!pageA && !pageB) throw new Error("This sheet has no pages to show.");
  if (!pageA) { const v = pageB.getViewport({ scale: 1 }); pageA = blankPage(v.width, v.height); }
  if (!pageB) { const v = pageA.getViewport({ scale: 1 }); pageB = blankPage(v.width, v.height); }
  return { pageA, pageB };
}

/* ------------------------------------------------------------------ *
 *  Layers (same structure as the sheet viewer)
 * ------------------------------------------------------------------ */
function makeLayer(canvas, cls, tintCls) {
  const el = document.createElement("div");
  el.className = `layer ${cls}`;
  stage.insertBefore(el, canvas);
  el.appendChild(canvas);
  canvas.classList.remove("hidden");
  const tint = document.createElement("div");
  tint.className = `tint ${tintCls}`;
  el.appendChild(tint);
  return { el, canvas, tint, detail: null, page: null, pw: 0, ph: 0, box: null,
           dens: 1, baseTask: null, detailTask: null, gen: 0, dgen: 0, pid: null, cacheKey: null, blank: false };
}
const LB = makeLayer($("cvB"), "layer-b", "tint-b");   // Drawing B (newer) underneath
const LA = makeLayer($("cvA"), "layer-a", "tint-a");   // Drawing A (older) on top, clipped / blended
stage.classList.add("hidden");

function cancel(t) { try { t && t.cancel(); } catch (e) { /* ignore */ } }

/* ---------- geometry ---------- */
function measure() {
  const r = viewport.getBoundingClientRect();
  S.vw = r.width || 800;
  S.vh = r.height || 600;
}
function computeStage() {
  const pad = 14;
  const s = Math.min((S.vw - pad * 2) / LB.pw, (S.vh - pad * 2) / LB.ph);
  S.W0 = Math.max(50, LB.pw * s);
  S.H0 = Math.max(50, LB.ph * s);
  stage.style.width = S.W0 + "px";
  stage.style.height = S.H0 + "px";
}
function boxFor(L) {
  if (L === LB) return { x: 0, y: 0, w: S.W0, h: S.H0 };
  const s = Math.min(S.W0 / L.pw, S.H0 / L.ph);   // contain-fit if sheet sizes differ
  const w = L.pw * s, h = L.ph * s;
  return { x: (S.W0 - w) / 2, y: (S.H0 - h) / 2, w, h };
}
function clampT() {
  const cw = S.W0 * S.z, ch = S.H0 * S.z, m = 40;
  S.tx = cw + 2 * m <= S.vw ? (S.vw - cw) / 2 : clamp(S.tx, S.vw - cw - m, m);
  S.ty = ch + 2 * m <= S.vh ? (S.vh - ch) / 2 : clamp(S.ty, S.vh - ch - m, m);
}
function applyTransform() {
  stage.style.transform = `translate(${S.tx}px, ${S.ty}px) scale(${S.z})`;
  stage.style.setProperty("--inv", String(1 / S.z));
  $("zoomLevel").textContent = Math.round(S.z * 100) + "%";
  positionHandle();
}
function positionHandle() {
  if (view.mode !== "slider") return;
  handle.style.top = clamp((S.vh / 2 - S.ty) / S.z, 0, S.H0) + "px";
}
function zoomAt(z2, cx, cy) {
  z2 = clamp(z2, MIN_Z, MAX_Z);
  const px = (cx - S.tx) / S.z, py = (cy - S.ty) / S.z;
  S.z = z2; S.tx = cx - px * z2; S.ty = cy - py * z2;
  clampT(); applyTransform();
}
function fitView() { S.z = 1; clampT(); applyTransform(); }
function withAnim(fn) {
  stage.classList.add("anim"); fn();
  setTimeout(() => stage.classList.remove("anim"), 230);
}

/* ---------- rendering ---------- */
function renderFit(page, canvas) {
  const v1 = page.getViewport({ scale: 1 });
  const s = Math.min(canvas.width / v1.width, canvas.height / v1.height);
  const vp = page.getViewport({
    scale: s,
    offsetX: (canvas.width - v1.width * s) / 2,
    offsetY: (canvas.height - v1.height * s) / 2,
  });
  return page.render({ canvasContext: canvas.getContext("2d"), viewport: vp });
}

// pageNum 0 = no matching sheet: show a blank sheet the size of the layer it is paired with.
async function setLayer(L, doc, pageNum, like) {
  if (!pageNum) {
    const w = like && like.pw ? like.pw : 612, h = like && like.ph ? like.ph : 792;
    L.page = blankPage(w, h);
    L.pw = w; L.ph = h;
    L.pid = null; L.blank = true;
    return;
  }
  const pn = clamp(pageNum, 1, doc.numPages);
  L.page = await doc.getPage(pn);
  L.pid = `${doc.fp}#${pn}`; L.blank = false;
  const vp = L.page.getViewport({ scale: 1 });
  L.pw = vp.width; L.ph = vp.height;
}

function clearDetail(L) {
  L.dgen++; cancel(L.detailTask); L.detailTask = null;
  if (L.detail) { L.detail.remove(); L.detail = null; }
}

// Size of the finished bitmap for a sheet drawn into box b (same rule everywhere, so prepared sheets can be reused).
function rasterFor(b) {
  const dens = Math.max(0.5, Math.min(dpr(), Math.sqrt(BASE_MAX_PX / (b.w * b.h))));
  return { w: Math.max(1, Math.round(b.w * dens)), h: Math.max(1, Math.round(b.h * dens)) };
}
const rasterKey = (pid, r) => `${pid}@${r.w}x${r.h}`;
function newRaster(r) {
  const c = document.createElement("canvas");
  c.width = r.w; c.height = r.h;
  c.dataset.keep = "1";
  return c;
}
function freeCanvas(c) { try { c.width = c.height = 0; } catch (e) { /* ignore */ } }
function takeCache(key) { const c = baseCache.get(key); if (c) baseCache.delete(key); return c || null; }
function putCache(key, c) {
  if (baseCache.has(key)) { freeCanvas(baseCache.get(key)); baseCache.delete(key); }
  baseCache.set(key, c);
  while (baseCache.size > CACHE_MAX) { const k = baseCache.keys().next().value; freeCanvas(baseCache.get(k)); baseCache.delete(k); }
}
function clearCache() { baseCache.forEach(freeCanvas); baseCache.clear(); }

async function renderBase(L) {
  if (!L.page) return;
  const my = ++L.gen;
  cancel(L.baseTask); L.baseTask = null;
  clearDetail(L);
  const b = boxFor(L); L.box = b;
  const r = rasterFor(b);
  const key = L.pid ? rasterKey(L.pid, r) : null;
  const place = (c) => {
    c.style.left = b.x + "px"; c.style.top = b.y + "px";
    c.style.width = b.w + "px"; c.style.height = b.h + "px";
    L.dens = c.width / b.w;
  };
  // already showing exactly this sheet at this size: nothing to draw
  if (key && L.cacheKey === key && L.canvas && L.canvas.dataset.keep && L.canvas.width) { place(L.canvas); return; }
  const finish = (c) => {
    place(c);
    const old = L.canvas;
    L.el.replaceChild(c, old);              // swap in only when finished, so there's no blank flash
    if (old && old.dataset.keep) { if (L.cacheKey && old.width) putCache(L.cacheKey, old); else freeCanvas(old); }
    L.canvas = c; L.cacheKey = key;
  };
  const hit = key ? takeCache(key) : null;   // a sheet prepared earlier appears instantly
  if (hit) { finish(hit); return; }
  const c = newRaster(r);
  const task = renderFit(L.page, c);
  L.baseTask = task;
  try { await task.promise; }
  catch (e) { freeCanvas(c); if (my !== L.gen || e?.name === "RenderingCancelledException") return; throw e; }
  if (my !== L.gen) { freeCanvas(c); return; }
  L.baseTask = null;
  finish(c);
}

let detailTimer = null;
function scheduleDetail(delay = 170) {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(() => { renderDetail(LB); renderDetail(LA); }, delay);
}

// Re-renders just the visible region at full screen resolution so zoomed-in text stays sharp.
async function renderDetail(L) {
  if (!L.page || !L.box) return;
  const k = S.z * dpr();
  if (k <= L.dens * 1.1) { clearDetail(L); return; }
  const my = ++L.dgen;
  cancel(L.detailTask);
  const b = L.box, pad = 0.1;
  const vx0 = -S.tx / S.z, vy0 = -S.ty / S.z;
  const vx1 = (S.vw - S.tx) / S.z, vy1 = (S.vh - S.ty) / S.z;
  const w0 = vx1 - vx0, h0 = vy1 - vy0;
  const x0 = Math.max(b.x, vx0 - w0 * pad), y0 = Math.max(b.y, vy0 - h0 * pad);
  const x1 = Math.min(b.x + b.w, vx1 + w0 * pad), y1 = Math.min(b.y + b.h, vy1 + h0 * pad);
  const rw = x1 - x0, rh = y1 - y0;
  if (rw < 2 || rh < 2) { clearDetail(L); return; }
  let kk = k;
  const area = rw * kk * rh * kk;
  if (area > DETAIL_MAX_PX) kk *= Math.sqrt(DETAIL_MAX_PX / area);
  if (kk <= L.dens * 1.05) { clearDetail(L); return; }
  const d = document.createElement("canvas");
  d.width = Math.max(1, Math.round(rw * kk));
  d.height = Math.max(1, Math.round(rh * kk));
  const ke = d.width / rw;
  d.style.left = x0 + "px"; d.style.top = y0 + "px";
  d.style.width = rw + "px"; d.style.height = rh + "px";
  const vp = L.page.getViewport({
    scale: (b.w / L.pw) * ke,
    offsetX: -(x0 - b.x) * ke,
    offsetY: -(y0 - b.y) * ke,
  });
  const task = L.page.render({ canvasContext: d.getContext("2d"), viewport: vp });
  L.detailTask = task;
  try { await task.promise; }
  catch (e) { return; }
  if (my !== L.dgen) return;
  L.detailTask = null;
  L.el.insertBefore(d, L.tint);
  if (L.detail) L.detail.remove();
  L.detail = d;
}

/* ---------- mounting both drawings ---------- */
let mountSeq = 0;
async function mountBoth(keep) {
  const my = ++mountSeq;
  bgRun++; cancel(bgTask);                   // anything running in the background steps aside
  mountBusy = true; lastNav = performance.now();
  try { await mountInner(my, keep); }
  finally { if (my === mountSeq) { mountBusy = false; lastNav = performance.now(); } }
  if (my === mountSeq && setS.on && cpOn) background();
}

async function mountInner(my, keep) {
  try {
    if (slots.B.page) {
      await setLayer(LB, slots.B.doc, slots.B.page);
      await setLayer(LA, slots.A.doc, slots.A.page, LB);
    } else {
      await setLayer(LA, slots.A.doc, slots.A.page);
      await setLayer(LB, slots.B.doc, 0, LA);
    }
  } catch (e) {
    stage.classList.add("hidden");
    emptyEl.classList.remove("hidden");
    emptyEl.innerHTML = `<div>Couldn't show these drawings.<br><span class="muted">${esc(e.message)}</span></div>`;
    return;
  }
  if (my !== mountSeq) return;
  const first = stage.classList.contains("hidden");
  const oW = S.W0, oH = S.H0;
  measure(); computeStage();
  if (!keep || first || Math.abs(oW - S.W0) > 1 || Math.abs(oH - S.H0) > 1) fitView();
  else { clampT(); applyTransform(); }
  stage.classList.remove("hidden");
  emptyEl.classList.add("hidden");
  applyMode();
  renderPins();
  await Promise.all([renderBase(LB), renderBase(LA)]);
  if (my !== mountSeq) return;
  scheduleDetail(60);
}

/* ------------------------------------------------------------------ *
 *  UI sync
 * ------------------------------------------------------------------ */
function syncChrome() {
  for (const w of ["A", "B"]) {
    const s = slots[w];
    if (!s) continue;
    $("name" + w).textContent = s.doc.name;
    $("name" + w).title = s.doc.name;
    $("pages" + w).classList.toggle("hidden", setS.on || s.doc.numPages < 2);
    $("pageInd" + w).textContent = `${s.page || "–"} / ${s.doc.numPages}`;
    $("pagePrev" + w).disabled = s.page <= 1;
    $("pageNext" + w).disabled = s.page >= s.doc.numPages;
  }
  const lbl = (w) => {
    const s = slots[w];
    if (!s) return "";
    if (!s.page) return `${w} · no matching sheet`;
    return setS.on ? `${w} · ${s.doc.name} · p.${s.page}` : `${w} · ${s.doc.name}`;
  };
  $("lblA").textContent = lbl("A");
  $("lblB").textContent = lbl("B");
  $("pageTitle").textContent = setS.on ? "Compare two sets" : "Compare two drawings";
  renderPairNav();
  syncMatchBtn();
}

function applyMode() {
  const slider = view.mode === "slider";
  stage.classList.add("cmp-on");
  stage.classList.toggle("mode-slider", slider);
  stage.classList.toggle("mode-overlay", !slider);
  divider.classList.toggle("hidden", !slider);
  $("modeSlider").classList.toggle("on", slider);
  $("modeOverlay").classList.toggle("on", !slider);
  $("opacityWrap").classList.toggle("hidden", slider);
  $("colorBtn").classList.toggle("hidden", slider);
  $("legend").classList.toggle("hidden", slider);
  if (slider) applySlider();
  else { LA.el.style.clipPath = ""; LA.el.style.webkitClipPath = ""; }
  LA.el.style.opacity = slider ? "" : String(view.opacity);
}
function applySlider() {
  const pct = view.p * 100;
  divider.style.left = pct + "%";
  const clip = `inset(0 ${100 - pct}% 0 0)`;
  LA.el.style.clipPath = clip; LA.el.style.webkitClipPath = clip;
  positionHandle();
}

$("modeSlider").addEventListener("click", () => { view.mode = "slider"; applyMode(); changed(); });
$("modeOverlay").addEventListener("click", () => { view.mode = "overlay"; applyMode(); changed(); });
$("opacity").addEventListener("input", (e) => {
  view.opacity = parseInt(e.target.value, 10) / 100;
  LA.el.style.opacity = String(view.opacity);
});
$("opacity").addEventListener("change", () => changed());

/* ------------------------------------------------------------------ *
 *  Busy dialog (progress for saving / opening / reading sheets / exporting)
 * ------------------------------------------------------------------ */
let busyCtl = null;
const busyActive = () => !$("busy").classList.contains("hidden");
function busyShow(title, text, ctl) {
  busyCtl = ctl || null;
  $("busyTitle").textContent = title;
  $("busyText").textContent = text || "";
  $("busyBar").style.width = "0%";
  $("busyCancel").classList.toggle("hidden", !ctl);
  $("busy").classList.remove("hidden");
}
function busyProgress(p) {
  const verb = p.phase === "upload" ? "Saving" : "Downloading";
  const what = (setS.on ? "Set " : "Drawing ") + p.which;
  $("busyText").textContent = `${verb} ${what}… ${cloud.fmtBytes(p.done)} of ${cloud.fmtBytes(p.total)}`;
  $("busyBar").style.width = Math.min(100, p.total ? (p.done / p.total) * 100 : 0) + "%";
}
function busyHide() { $("busy").classList.add("hidden"); busyCtl = null; }
$("busyCancel").addEventListener("click", () => {
  if (busyCtl) { $("busyText").textContent = "Cancelling…"; busyCtl.abort(); }
});
window.addEventListener("beforeunload", (e) => {
  if (busyActive()) { e.preventDefault(); e.returnValue = ""; }
});

/* ------------------------------------------------------------------ *
 *  Whole sets: reading sheet numbers, matching sheets, checking for changes
 * ------------------------------------------------------------------ */
const keyOf = (s) => String(s || "").toUpperCase().replace(/[\s\-_]/g, "");
const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });

const STATUS_TEXT = {
  changed: "Changed", same: "No visible change", onlyA: "Removed (only in A)",
  onlyB: "New (only in B)", pending: "Checking…", unknown: "Couldn't check",
};
const STATUS_SHORT = { changed: "Changed", same: "No change", onlyA: "Removed", onlyB: "New", pending: "Checking…", unknown: "Couldn't check" };

function statusOf(p) {
  if (!p.a) return "onlyB";
  if (!p.b) return "onlyA";
  if (p.chg == null) return "pending";
  if (p.chg < 0) return "unknown";
  return p.chg >= CHG_MIN_PX ? "changed" : "same";
}
const curPair = () => setS.pairs[setS.cur] || null;
const notesOnPair = (p) => notes.filter((n) => n.pa === p.a && n.pb === p.b).length;
const pairIndexOf = (n) => setS.pairs.findIndex((p) => p.a === n.pa && p.b === n.pb);
function sheetOf(n) {
  const i = pairIndexOf(n);
  if (i >= 0) return setS.pairs[i].num || `Sheet ${i + 1}`;
  return `A p.${n.pa || "–"} / B p.${n.pb || "–"}`;
}

// Picks the sheet number (and a guess at the title) out of one page's text.
function pickSheet(page, items) {
  const inRegion = (i) => (i.x > 0.5 && i.y > 0.5) || i.x > 0.85;     // bottom-right corner, or a right-hand strip
  const pool = items.filter((i) => SHEET_RE.test(i.s.toUpperCase()) && inRegion(i)).sort((a, b) => b.size - a.size);
  const best = pool[0];
  if (!best) return { page, number: "", title: "" };
  const LABEL = /^(sheet|title|date|scale|drawn|checked|project|revision|rev|no\.?|number|job|drawing|dwg)\b/i;
  const near = items.filter((i) => i !== best && Math.abs(i.x - best.x) < 0.25 && i.y < best.y + 0.08 && i.y > best.y - 0.15 &&
    i.size >= best.size * 0.3 && i.s.length >= 4 && !LABEL.test(i.s) && !SHEET_RE.test(i.s.toUpperCase()));
  near.sort((a, b) => a.y - b.y || a.x - b.x);
  return {
    page,
    number: best.s.toUpperCase().replace(/\s+/g, "-"),
    title: near.map((i) => i.s).join(" ").replace(/\s+/g, " ").trim().slice(0, 80),
  };
}

// Reads every page of a set: its sheet number and title. A page with no readable text (a scan) gets a blank number.
async function readIndexOf(doc, tick, signal) {
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    if (signal && signal.aborted) throw new Error("Cancelled.");
    let entry = { page: p, number: "", title: "" };
    try {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items = [];
      for (const it of tc.items) {
        const s = String(it.str || "").trim();
        if (!s) continue;
        const m = pdfjsLib.Util.transform(vp.transform, it.transform);
        items.push({ s, x: m[4] / vp.width, y: m[5] / vp.height, size: Math.hypot(m[2], m[3]) });
      }
      entry = pickSheet(p, items);
    } catch (e) { /* leave blank; the person can pair this sheet by hand */ }
    out.push(entry);
    if (tick) tick();
    await yieldUI();
  }
  return out;
}

function buildPairs(idxA, idxB, mode) {
  const pairs = [];
  if (mode === "order") {
    const n = Math.max(idxA.length, idxB.length);
    for (let i = 0; i < n; i++) {
      const a = idxA[i], b = idxB[i];
      pairs.push({ a: a ? a.page : 0, b: b ? b.page : 0,
        num: labelOf(a, b, `Page ${i + 1}`),
        title: (b && b.title) || (a && a.title) || "", manual: false, chg: null });
    }
    return pairs;
  }
  const mapA = new Map();
  idxA.forEach((e) => {
    const k = keyOf(e.number);
    if (!k) return;
    if (!mapA.has(k)) mapA.set(k, []);
    mapA.get(k).push(e);
  });
  const usedA = new Set();
  idxB.forEach((b) => {
    const k = keyOf(b.number);
    const q = k ? mapA.get(k) : null;
    const a = q && q.length ? q.shift() : null;
    if (a) usedA.add(a.page);
    pairs.push({ a: a ? a.page : 0, b: b.page, num: b.number || `B p.${b.page}`,
      title: b.title || (a && a.title) || "", manual: false, chg: null });
  });
  idxA.forEach((a) => {
    if (!usedA.has(a.page)) pairs.push({ a: a.page, b: 0, num: a.number || `A p.${a.page}`, title: a.title || "", manual: false, chg: null });
  });
  pairs.sort((x, y) => natural(x.num, y.num) || (x.b - y.b) || (x.a - y.a));
  return pairs;
}

// How a pair is named: the shared sheet number, or both numbers ("E-101 ↔ E-102") when the two sheets
// carry different numbers (a pair made by hand, or sets matched by page order).
function labelOf(ea, eb, fallback) {
  const na = ea && ea.number, nb = eb && eb.number;
  if (na && nb && keyOf(na) !== keyOf(nb)) return `${na} ↔ ${nb}`;
  return nb || na || fallback;
}
function numberFor(p) {
  const ea = p.a ? setS.idx.A[p.a - 1] : null, eb = p.b ? setS.idx.B[p.b - 1] : null;
  return labelOf(ea, eb, p.b ? `B p.${p.b}` : `A p.${p.a}`);
}
function titleFor(p) {
  const tb = p.b && setS.idx.B[p.b - 1] && setS.idx.B[p.b - 1].title;
  const ta = p.a && setS.idx.A[p.a - 1] && setS.idx.A[p.a - 1].title;
  return tb || ta || "";
}

// How a sheet looks (a coarse grid of line density) and which words it contains. Used to match sheets
// whose number couldn't be read, e.g. scanned sets or unusual title blocks.
async function fingerprintPage(doc, n) {
  const page = await doc.getPage(n);
  const v = page.getViewport({ scale: 1 });
  const k = LOOK_PX / Math.max(v.width, v.height);
  const w = Math.max(16, Math.round(v.width * k)), h = Math.max(16, Math.round(v.height * k));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.fillStyle = "#fff"; x.fillRect(0, 0, w, h);
  await renderFit(page, c).promise;
  const d = x.getImageData(0, 0, w, h).data;
  c.width = c.height = 0;
  const [rx, ry] = TB_REGION[setS.tb] || TB_REGION.br;
  const vec = new Float32Array(LOOK_GX * LOOK_GY), cnt = new Float32Array(LOOK_GX * LOOK_GY);
  for (let yy = 0; yy < h; yy++) {
    const gy = Math.min(LOOK_GY - 1, Math.floor((yy / h) * LOOK_GY));
    for (let xx = 0; xx < w; xx++) {
      const g = gy * LOOK_GX + Math.min(LOOK_GX - 1, Math.floor((xx / w) * LOOK_GX));
      cnt[g]++;
      if (xx >= rx * w && yy >= ry * h) continue;                        // title block left out
      const i = (yy * w + xx) * 4;
      vec[g] += (255 - Math.min(d[i], d[i + 1], d[i + 2])) / 255;
    }
  }
  for (let g = 0; g < vec.length; g++) vec[g] = cnt[g] ? vec[g] / cnt[g] : 0;
  const toks = new Set();
  try {
    const tc = await page.getTextContent();
    for (const it of tc.items) String(it.str || "").toUpperCase().split(/[^A-Z0-9]+/).forEach((t) => { if (t.length >= 3) toks.add(t); });
  } catch (e) { /* scans have no text */ }
  return { vec, toks };
}

// Pairs up pages from the two lists that look alike. Returns [{i, j, score}] (indexes into leftA / leftB).
async function matchByLook(leftA, leftB, tick, signal) {
  const fa = [], fb = [];
  for (const p of leftA) { if (signal && signal.aborted) throw new Error("Cancelled."); fa.push(await fingerprintPage(slots.A.doc, p.a)); tick(); await yieldUI(); }
  for (const p of leftB) { if (signal && signal.aborted) throw new Error("Cancelled."); fb.push(await fingerprintPage(slots.B.doc, p.b)); tick(); await yieldUI(); }
  const all = [...fa, ...fb];
  const cells = LOOK_GX * LOOK_GY;
  // take out what every sheet has in common (border, title block): only meaningful with enough sheets to average
  if (all.length >= 6) {
    const mean = new Float32Array(cells);
    all.forEach((f) => { for (let i = 0; i < cells; i++) mean[i] += f.vec[i] / all.length; });
    all.forEach((f) => { for (let i = 0; i < cells; i++) f.vec[i] -= mean[i]; });
  }
  all.forEach((f) => {
    let n = 0;
    for (let i = 0; i < cells; i++) n += f.vec[i] * f.vec[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < cells; i++) f.vec[i] /= n;
  });
  // words found on most sheets say nothing about which sheet this is
  const df = new Map();
  all.forEach((f) => f.toks.forEach((t) => df.set(t, (df.get(t) || 0) + 1)));
  const maxDf = Math.max(2, 0.4 * all.length);
  all.forEach((f) => { f.words = new Set([...f.toks].filter((t) => df.get(t) <= maxDf)); });

  const cands = [];
  fa.forEach((a, i) => fb.forEach((b, j) => {
    let vis = 0;
    for (let k = 0; k < cells; k++) vis += a.vec[k] * b.vec[k];
    vis = Math.max(0, vis);
    let score = all.length >= 6 ? vis : vis * 0.6;                    // too few sheets to average: be stricter
    if (a.words.size >= 5 && b.words.size >= 5) {
      let inter = 0;
      a.words.forEach((t) => { if (b.words.has(t)) inter++; });
      score = 0.5 * vis + 0.5 * (inter / (a.words.size + b.words.size - inter));
    }
    cands.push({ i, j, score });
  }));
  cands.sort((x, y) => y.score - x.score);
  const usedA = new Set(), usedB = new Set(), out = [];
  for (const c of cands) {
    if (c.score < LOOK_MIN) break;
    if (usedA.has(c.i) || usedB.has(c.j)) continue;
    usedA.add(c.i); usedB.add(c.j); out.push(c);
  }
  return out;
}

// Page order for sets without usable sheet numbers: follow set B's pages; a sheet that only exists in A
// goes right after the sheet that came before it in A.
function orderByPages(pairs) {
  const out = pairs.filter((p) => p.b).sort((x, y) => x.b - y.b);
  const onlyA = pairs.filter((p) => !p.b).sort((x, y) => x.a - y.a);
  for (const p of onlyA) {
    let at = -1, best = 0;
    out.forEach((q, i) => { if (q.a && q.a < p.a && q.a > best) { best = q.a; at = i; } });
    out.splice(at + 1, 0, p);
  }
  return out;
}

// Reads both sets and builds (or restores) the sheet pairs. `saved` = a saved/exported sets state, or null.
async function prepareSets(saved, ctl) {
  setS.match = saved && saved.match === "order" ? "order" : "number";
  setS.tb = saved && ["br", "right", "none"].includes(saved.tb) ? saved.tb : "br";
  const nA = slots.A.doc.numPages, nB = slots.B.doc.numPages;
  const signal = ctl && ctl.signal;
  let done = 0, total = nA + nB;
  const bar = (text) => { $("busyText").textContent = text; $("busyBar").style.width = Math.min(100, (done / total) * 100) + "%"; };
  const tick = () => { done++; bar(`Reading sheet numbers… ${done} of ${total}`); };
  setS.idx.A = await readIndexOf(slots.A.doc, tick, signal);
  setS.idx.B = await readIndexOf(slots.B.doc, tick, signal);
  setS.notice = "";

  const usable = saved && Array.isArray(saved.pairs) && saved.pairs.length &&
    saved.pairs.every((p) => p && p.a <= nA && p.b <= nB && (p.a || p.b));
  if (usable) {
    setS.pairs = saved.pairs.map((p) => ({ a: p.a | 0, b: p.b | 0, num: p.num || "", title: p.title || "",
      manual: !!p.manual, chg: typeof p.chg === "number" ? p.chg : null }));
    setS.cur = clamp(parseInt(saved.cur, 10) || 0, 0, setS.pairs.length - 1);
    return;
  }

  setS.cur = 0;
  setS.pairs = buildPairs(setS.idx.A, setS.idx.B, "number");
  const readA = setS.idx.A.filter((e) => e.number).length, readB = setS.idx.B.filter((e) => e.number).length;

  // pages with no readable number: match them by how they look (and the words on them)
  const blankA = new Set(setS.idx.A.filter((e) => !e.number).map((e) => e.page));
  const blankB = new Set(setS.idx.B.filter((e) => !e.number).map((e) => e.page));
  const leftA = setS.pairs.filter((p) => p.a && !p.b && blankA.has(p.a));
  const leftB = setS.pairs.filter((p) => p.b && !p.a && blankB.has(p.b));
  let byLook = 0;
  if (leftA.length && leftB.length) {
    done = 0; total = leftA.length + leftB.length;
    const tickL = () => { done++; bar(`Matching sheets by how they look… ${done} of ${total}`); };
    const hits = await matchByLook(leftA, leftB, tickL, signal);
    const gone = new Set();
    hits.forEach((h) => {
      const pa = leftA[h.i], pb = leftB[h.j];
      pb.a = pa.a; pb.look = true; pb.num = `Page ${pb.b}`; pb.title = pb.title || pa.title;
      gone.add(pa);
    });
    byLook = hits.length;
    setS.pairs = setS.pairs.filter((p) => !gone.has(p));
  }
  // with unreadable numbers, "Page 10" would sort before "Page 2" by name: list by page position instead
  if (byLook || readA < 0.9 * nA || readB < 0.9 * nB) setS.pairs = orderByPages(setS.pairs);

  const matched = setS.pairs.filter((p) => p.a && p.b).length;
  if (matched < 0.4 * Math.min(nA, nB) && (readA < 0.6 * nA || readB < 0.6 * nB)) {
    // neither numbers nor looks lined the sets up: the last resort is page order
    setS.match = "order";
    setS.pairs = orderByPages(buildPairs(setS.idx.A, setS.idx.B, "order"));
    setS.notice = "Couldn't line these sets up by sheet number or by how the sheets look, so they are matched by page order. Check the pairs, and re-pair any sheet by hand.";
  } else if (byLook) {
    setS.notice = `${byLook} sheet${byLook === 1 ? "" : "s"} had no readable sheet number, so ${byLook === 1 ? "it was" : "they were"} matched by how ${byLook === 1 ? "it looks" : "they look"}. Please check ${byLook === 1 ? "that pair" : "those pairs"}.`;
  }
}

function applyPairToSlots() {
  const p = curPair();
  if (!p) return;
  slots.A.page = p.a;
  slots.B.page = p.b;
}

async function selectPair(i) {
  if (!setS.on || i < 0 || i >= setS.pairs.length) return;
  setS.cur = i;
  applyPairToSlots();
  selId = null;
  syncChrome(); renderNotes(); renderSets(); renderPairEditor();
  changed();
  await mountBoth(false);
}

function nextChanged() {
  const n = setS.pairs.length;
  for (let k = 1; k <= n; k++) {
    const i = (setS.cur + k) % n;
    if (statusOf(setS.pairs[i]) === "changed") { selectPair(i); return; }
  }
  const waiting = setS.pairs.some((p) => statusOf(p) === "pending");
  toast(waiting ? "Still checking sheets" : "No other changed sheets", waiting ? "Try again in a moment." : "", false, 2500);
}

// Moves a sheet to a different page on one side. A page can belong to only one pair, so it is taken from any other pair.
function repair(side, page) {
  const p = curPair();
  if (!p) return;
  const other = side === "a" ? "b" : "a";
  if (!page && !p[other]) { renderPairEditor(); return; }          // a sheet needs at least one side
  if (p[side] === page) return;
  if (page) setS.pairs.forEach((q) => {
    if (q !== p && q[side] === page) { q[side] = 0; q.chg = null; q.manual = true; q.num = numberFor(q); q.title = titleFor(q); }
  });
  p[side] = page; p.manual = true; p.chg = null;
  p.num = numberFor(p); p.title = titleFor(p);
  setS.pairs = setS.pairs.filter((q) => q === p || q.a || q.b);
  setS.cur = setS.pairs.indexOf(p);
  applyPairToSlots();
  syncChrome(); renderNotes(); renderSets(); renderPairEditor();
  changed();
  mountBoth(false);
}

/* ---------- change check ---------- */
function inkMap(data, w, h) {
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    out[j] = Math.min(data[i], data[i + 1], data[i + 2]) < 170 ? 1 : 0;       // dark or coloured line work counts as ink
  }
  return out;
}
function dilate(src, w, h) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) tmp[r + x] = src[r + x] | (x > 0 ? src[r + x - 1] : 0) | (x < w - 1 ? src[r + x + 1] : 0);
  }
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) out[r + x] = tmp[r + x] | (y > 0 ? tmp[r - w + x] : 0) | (y < h - 1 ? tmp[r + w + x] : 0);
  }
  return out;
}

// How many pixels of line work differ between two sheets, once the title block is left out.
async function measureChange(pa, pb) {
  const [pageA, pageB] = await Promise.all([slots.A.doc.getPage(pa), slots.B.doc.getPage(pb)]);
  const vB = pageB.getViewport({ scale: 1 });
  const k = WORK_PX / Math.max(vB.width, vB.height);
  const w = Math.max(50, Math.round(vB.width * k)), h = Math.max(50, Math.round(vB.height * k));
  const ink = async (page) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.fillStyle = "#fff"; x.fillRect(0, 0, w, h);
    await renderFit(page, c).promise;
    const map = inkMap(x.getImageData(0, 0, w, h).data, w, h);
    c.width = c.height = 0;
    return map;
  };
  const inkA = await ink(pageA);
  await yieldUI();
  const inkB = await ink(pageB);
  const dA = dilate(inkA, w, h), dB = dilate(inkB, w, h);
  const [rx, ry] = TB_REGION[setS.tb] || TB_REGION.br;
  const x0 = Math.floor(rx * w), y0 = Math.floor(ry * h);
  let diff = 0;
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      if (x >= x0 && y >= y0) continue;                              // title block: ignored
      const i = r + x;
      if ((inkA[i] && !dB[i]) || (inkB[i] && !dA[i])) diff++;
    }
  }
  return diff;
}

// Waits until nothing is being turned or drawn, so background work never slows down a page turn.
async function settle(my) {
  while (my === bgRun) {
    if (!mountBusy && performance.now() - lastNav > 350) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

// Where a pair of sheets will be drawn (same rule as the main view), so neighbours can be drawn ahead of time.
async function layoutFor(pa, pb) {
  const { pageA, pageB } = await pagePair(pa, pb);
  const vA = pageA.getViewport({ scale: 1 }), vB = pageB.getViewport({ scale: 1 });
  const pad = 14;
  const s = Math.min((S.vw - pad * 2) / vB.width, (S.vh - pad * 2) / vB.height);
  const W0 = Math.max(50, vB.width * s), H0 = Math.max(50, vB.height * s);
  const sa = Math.min(W0 / vA.width, H0 / vA.height);
  const wa = vA.width * sa, ha = vA.height * sa;
  return { pageA, pageB, boxB: { x: 0, y: 0, w: W0, h: H0 }, boxA: { x: (W0 - wa) / 2, y: (H0 - ha) / 2, w: wa, h: ha } };
}

// Draws the next and previous sheet pairs ahead of time, so turning to them is instant.
async function prefetchNeighbors(my) {
  for (const d of [1, -1]) {
    const p = setS.pairs[setS.cur + d];
    if (!p) continue;
    let lay;
    try { lay = await layoutFor(p.a, p.b); } catch (e) { continue; }
    for (const [num, page, box, which] of [[p.b, lay.pageB, lay.boxB, "B"], [p.a, lay.pageA, lay.boxA, "A"]]) {
      if (my !== bgRun) return;
      if (!num) continue;
      const r = rasterFor(box);
      const key = rasterKey(`${slots[which].doc.fp}#${num}`, r);
      if (baseCache.has(key)) continue;
      const c = newRaster(r);
      bgTask = renderFit(page, c);
      try { await bgTask.promise; }
      catch (e) { freeCanvas(c); if (my !== bgRun) return; continue; }
      if (my !== bgRun) { freeCanvas(c); return; }
      putCache(key, c);
      await yieldUI();
    }
  }
}

async function analyzePending(my) {
  const todo = setS.pairs.filter((p) => p.a && p.b && p.chg == null);
  setS.total = todo.length; setS.done = 0;
  paintProgress();
  for (const p of todo) {
    if (my !== bgRun || !cpOn || !setS.on) return;
    try { p.chg = await measureChange(p.a, p.b); }
    catch (e) { p.chg = -1; }
    setS.done++;
    scheduleSetsList();
    paintProgress();
    await yieldUI();
    if (!(await settle(my))) return;
  }
  if (my !== bgRun) return;
  setS.total = 0; setS.done = 0;
  paintProgress(); renderSets(); renderPairNav();
  if (todo.length) changed();
}

// Quiet work after a sheet is on screen: get the neighbours ready first, then check sheets for changes.
async function background() {
  if (!setS.on || !cpOn) return;
  const my = ++bgRun;
  if (!(await settle(my))) return;
  try { await prefetchNeighbors(my); } catch (e) { /* not critical */ }
  if (my !== bgRun) return;
  await analyzePending(my);
}

/* ---------- sheets panel ---------- */
let listRaf = 0;
function scheduleSetsList() {
  if (listRaf) return;
  listRaf = requestAnimationFrame(() => { listRaf = 0; renderSetsList(); renderPairNav(); });
}

function paintProgress() {
  const el = $("spProgress");
  const running = setS.total > 0 && setS.done < setS.total;
  el.classList.toggle("hidden", !running);
  if (running) {
    $("spBar").style.width = (setS.done / setS.total) * 100 + "%";
    $("spProgText").textContent = `Checking for changes… ${setS.done} of ${setS.total}`;
  }
}

function renderPairNav() {
  const on = setS.on;
  $("pairGroup").classList.toggle("hidden", !on);
  $("pairRule").classList.toggle("hidden", !on);
  $("setsToggle").classList.toggle("hidden", !on);
  if (!on) return;
  const p = curPair();
  $("pairInd").textContent = p ? `${p.num || "Sheet"} · ${setS.cur + 1} of ${setS.pairs.length}` : "—";
  $("pairInd").title = p && p.title ? p.title : "";
  $("pairPrev").disabled = setS.cur <= 0;
  $("pairNext").disabled = setS.cur >= setS.pairs.length - 1;
  $("setsToggleLabel").textContent = `Sheets (${setS.pairs.length})`;
}

function renderSetsList() {
  if (!setS.on) return;
  const counts = { changed: 0, same: 0, onlyA: 0, onlyB: 0, pending: 0, unknown: 0 };
  setS.pairs.forEach((p) => { counts[statusOf(p)]++; });
  const bits = [`${counts.changed} changed`, `${counts.same} no change`];
  if (counts.onlyB) bits.push(`${counts.onlyB} new`);
  if (counts.onlyA) bits.push(`${counts.onlyA} removed`);
  if (counts.unknown) bits.push(`${counts.unknown} couldn't be checked`);
  if (counts.pending) bits.push(`${counts.pending} still checking`);
  $("spSummary").textContent = `${setS.pairs.length} sheets: ${bits.join(" · ")}`;

  const keep = (p) => {
    if (setS.filter === "review") return ["changed", "onlyA", "onlyB", "unknown"].includes(statusOf(p));
    if (setS.filter === "notes") return notesOnPair(p) > 0;
    return true;
  };
  const rows = [];
  setS.pairs.forEach((p, i) => {
    if (!keep(p)) return;
    const st = statusOf(p), nn = notesOnPair(p);
    rows.push(`<div class="sp-row${i === setS.cur ? " cur" : ""}" data-i="${i}" role="button" tabindex="0">
      <span class="st st-${st}"></span>
      <span class="sp-num">${esc(p.num || "Sheet " + (i + 1))}</span>
      <span class="sp-title">${esc(p.title)}</span>
      ${nn ? `<span class="sp-n">${nn}</span>` : "<span></span>"}
      <span class="sp-tag">${esc(STATUS_SHORT[st])}${p.manual ? " · paired by hand" : ""}</span>
    </div>`);
  });
  $("spList").innerHTML = rows.length ? rows.join("") : `<div class="sp-empty">${setS.filter === "notes" ? "No notes yet." : "Nothing to review here."}</div>`;
  const cur = $("spList").querySelector(".sp-row.cur");
  if (cur && cur.scrollIntoView && !listRaf) cur.scrollIntoView({ block: "nearest" });
}

function renderPairEditor() {
  if (!setS.on) return;
  const p = curPair();
  const opts = (idx) => `<option value="0">— none —</option>` +
    idx.map((e) => `<option value="${e.page}">p.${e.page}${e.number ? " · " + esc(e.number) : ""}</option>`).join("");
  $("spPairA").innerHTML = opts(setS.idx.A);
  $("spPairB").innerHTML = opts(setS.idx.B);
  $("spPairA").value = String(p ? p.a : 0);
  $("spPairB").value = String(p ? p.b : 0);
  $("spMatch").value = setS.match;
  $("spTb").value = setS.tb;
  $("spNotice").classList.toggle("hidden", !setS.notice);
  $("spNotice").textContent = setS.notice;
}

function renderSets() {
  const on = setS.on;
  $("setsPanel").classList.toggle("hidden", !on);
  if (!on) return;
  renderSetsList();
  paintProgress();
}

$("spList").addEventListener("click", (e) => {
  const r = e.target.closest("[data-i]");
  if (!r) return;
  selectPair(parseInt(r.dataset.i, 10));
  $("setsPanel").classList.remove("open");
});
$("spList").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const r = e.target.closest("[data-i]");
  if (r) { e.preventDefault(); selectPair(parseInt(r.dataset.i, 10)); }
});
$("spFilter").addEventListener("click", (e) => {
  const b = e.target.closest("[data-filter]");
  if (!b) return;
  setS.filter = b.dataset.filter;
  $("spFilter").querySelectorAll("[data-filter]").forEach((x) => x.classList.toggle("on", x === b));
  renderSetsList();
});
$("spPairA").addEventListener("change", (e) => repair("a", parseInt(e.target.value, 10) || 0));
$("spPairB").addEventListener("change", (e) => repair("b", parseInt(e.target.value, 10) || 0));
$("pairPrev").addEventListener("click", () => selectPair(setS.cur - 1));
$("pairNext").addEventListener("click", () => selectPair(setS.cur + 1));
$("nextChanged").addEventListener("click", nextChanged);
$("setsToggle").addEventListener("click", () => $("setsPanel").classList.toggle("open"));

$("spMatch").addEventListener("change", (e) => {
  const v = e.target.value === "order" ? "order" : "number";
  if (v === setS.match) return;
  if ((setS.pairs.some((p) => p.manual) || notes.length) &&
      !confirm("Re-matching starts the pairing over. Your notes stay saved, but they may no longer line up with a sheet. Continue?")) {
    e.target.value = setS.match;
    return;
  }
  setS.match = v;
  setS.notice = "";
  setS.pairs = buildPairs(setS.idx.A, setS.idx.B, v);
  setS.cur = 0;
  applyPairToSlots();
  syncChrome(); renderNotes(); renderSets(); renderPairEditor();
  changed();
  mountBoth(false);
});
$("spTb").addEventListener("change", (e) => {
  setS.tb = ["br", "right", "none"].includes(e.target.value) ? e.target.value : "br";
  setS.pairs.forEach((p) => { p.chg = null; });
  renderSets(); renderPairNav();
  changed();
  background();
});

function currentSets() {
  return {
    on: true, match: setS.match, tb: setS.tb, cur: setS.cur,
    pairs: setS.pairs.map((p) => ({ a: p.a, b: p.b, num: p.num, title: p.title, manual: !!p.manual, chg: p.chg })),
  };
}

/* ------------------------------------------------------------------ *
 *  Start screen + choosing / replacing / swapping files
 * ------------------------------------------------------------------ */
function showStartMsg(msg, isErr) {
  const el = $("startMsg");
  if (!msg) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  el.classList.toggle("err", !!isErr);
  el.textContent = msg;
}

function updateDz(w) {
  const s = slots[w];
  $("dzName" + w).textContent = s ? s.doc.name : "Tap to choose, or drop a file here";
  $("dz" + w).classList.toggle("has-file", !!s);
}

function resetSlots() {
  clearCache();
  for (const w of ["A", "B"]) {
    if (slots[w]) { try { slots[w].doc.destroy(); } catch (e) {} }
    slots[w] = null;
    updateDz(w);
  }
}

// Two PDFs where either has several sheets are compared as sets (sheets matched up automatically).
const wantSets = () => !!(slots.A && slots.B && slots.A.doc.isPdf && slots.B.doc.isPdf &&
  (slots.A.doc.numPages > 1 || slots.B.doc.numPages > 1));

function turnOffSets() {
  bgRun++; cancel(bgTask);
  setS.on = false; setS.pairs = []; setS.idx = { A: [], B: [] }; setS.cur = 0; setS.total = 0; setS.done = 0; setS.notice = "";
  slots.A.page = 1; slots.B.page = 1;
  renderSets(); renderPairNav();
}

async function setFile(which, file) {
  if (!file) return;
  showStartMsg(`Reading ${file.name}…`, false);
  let doc;
  try { doc = await openFile(file); }
  catch (e) {
    if (cpOn) flash("Couldn't open that file", e.message);
    else showStartMsg(e.message, true);
    return;
  }
  if (slots[which]) { try { slots[which].doc.destroy(); } catch (e) {} }
  slots[which] = { doc, page: 1 };
  clearCache();
  showStartMsg("");
  updateDz(which);
  if (cpOn) {
    detachCloud();          // the person already confirmed this when they tapped Replace
    selId = null;
    loadState();            // a different pair of files gets its own notes
    if (wantSets()) {
      const ok = await rePrepareSets();
      if (!ok) return;
      setS.on = true;
    } else if (setS.on) {
      turnOffSets();
    }
    syncChrome(); renderNotes();
    await mountBoth(false);
  } else if (slots.A && slots.B) {
    startCompare({ sets: wantSets() });
  }
}

async function rePrepareSets() {
  const ctl = new AbortController();
  busyShow("Reading sheets…", "Starting…", ctl);
  try {
    await prepareSets(readLocalSets(), ctl);
    busyHide();
    applyPairToSlots();
    renderSets(); renderPairEditor();
    return true;
  } catch (e) {
    busyHide();
    if (e.message !== "Cancelled.") flash("Couldn't read the sheets", e.message);
    await startOver();
    return false;
  }
}

// ---- "Match sheets" for a comparison that is already open and not matched up (older saved comparisons) ----
function syncMatchBtn() {
  $("matchBtn").classList.toggle("hidden", !(cpOn && !setS.on && wantSets()));
}

// Pages are matched up by sheet number (or by how they look). Notes stay on the pages they were made on:
// any pair of pages that a note was made on is kept as a pair, even if the automatic match would pair them differently.
function keepNotePairs() {
  const combos = new Map();
  notes.forEach((n) => { if (n.pa && n.pb) combos.set(n.pa + ":" + n.pb, [n.pa, n.pb]); });
  let forced = 0;
  for (const [a, b] of combos.values()) {
    if (setS.pairs.some((p) => p.a === a && p.b === b)) continue;
    setS.pairs.forEach((p) => { if (p.a === a) { p.a = 0; p.chg = null; } if (p.b === b) { p.b = 0; p.chg = null; } });
    setS.pairs = setS.pairs.filter((p) => p.a || p.b);
    const np = { a, b, num: "", title: "", manual: true, chg: null };
    np.num = numberFor(np); np.title = titleFor(np);
    setS.pairs.push(np);
    forced++;
  }
  if (forced) {
    const readable = setS.pairs.every((p) => {
      const e = (p.b && setS.idx.B[p.b - 1]) || (p.a && setS.idx.A[p.a - 1]);
      return e && e.number;
    });
    if (readable) setS.pairs.sort((x, y) => natural(x.num, y.num) || (x.b - y.b) || (x.a - y.a));
    else setS.pairs = orderByPages(setS.pairs);
  }
  return forced;
}

async function matchExisting() {
  if (!cpOn || setS.on || !wantSets()) return;
  const curA = slots.A.page, curB = slots.B.page;
  const ctl = new AbortController();
  busyShow("Matching sheets…", "Starting…", ctl);
  try {
    await prepareSets(null, ctl);
    busyHide();
  } catch (e) {
    busyHide();
    setS.pairs = []; setS.idx = { A: [], B: [] }; setS.cur = 0;
    if (e.message !== "Cancelled.") flash("Couldn't match the sheets", e.message);
    return;
  }
  setS.on = true;
  const forced = keepNotePairs();
  let i = setS.pairs.findIndex((p) => p.a === curA && p.b === curB);   // stay on the sheets being looked at, if they pair up
  if (i < 0) i = setS.pairs.findIndex((p) => p.b === curB);
  setS.cur = Math.max(0, i);
  setS.filter = "all";
  $("spFilter").querySelectorAll("[data-filter]").forEach((x) => x.classList.toggle("on", x.dataset.filter === "all"));
  applyPairToSlots();
  selId = null;
  renderSets(); renderPairEditor();
  syncChrome(); renderNotes();
  changed();                                         // a saved comparison keeps its new pairing
  const n = setS.pairs.filter((p) => p.a && p.b).length;
  toast(`Matched ${n} sheet${n === 1 ? "" : "s"}`,
    (forced ? `${forced} pair${forced === 1 ? "" : "s"} kept where you already had notes. ` : "") + "Use the arrows to step through them together.", false, 5000);
  await mountBoth(false);
}
$("matchBtn").addEventListener("click", matchExisting);

["A", "B"].forEach((w) => {
  const dz = $("dz" + w);
  ["dragenter", "dragover"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => { const f = e.dataTransfer?.files?.[0]; if (f) setFile(w, f); });
  $("file" + w).addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) setFile(w, f); });
  $("replace" + w).addEventListener("click", () => {
    if (cloudId && !confirm("Replacing a drawing starts a new comparison, because notes belong to a pair of drawings. Your saved copy stays as it is. Continue?")) return;
    $("file" + w).click();
  });
  $("pagePrev" + w).addEventListener("click", () => gotoPage(w, slots[w].page - 1));
  $("pageNext" + w).addEventListener("click", () => gotoPage(w, slots[w].page + 1));
});

async function gotoPage(w, n) {
  const s = slots[w];
  n = clamp(n, 1, s.doc.numPages);
  if (n === s.page) return;
  s.page = n;
  syncChrome(); renderNotes(); changed();
  await mountBoth(true);
}

async function swapAB() {
  if (cloudId && !confirm("Swapping A and B makes this a new comparison. Your saved copy stays as it is. Continue?")) return;
  detachCloud();
  [slots.A, slots.B] = [slots.B, slots.A];
  notes.forEach((n) => { const t = n.pa; n.pa = n.pb; n.pb = t; });
  if (setS.on) {
    setS.pairs.forEach((p) => { const t = p.a; p.a = p.b; p.b = t; });
    [setS.idx.A, setS.idx.B] = [setS.idx.B, setS.idx.A];
    renderSets(); renderPairEditor();
  }
  changed(); syncChrome(); renderNotes();
  await mountBoth(false);
}
$("swapBtn").addEventListener("click", swapAB);

async function startCompare(opts = {}) {
  const asSets = !!(opts.sets || (opts.state && opts.state.sets && opts.state.sets.on));
  if (asSets) {
    const ctl = new AbortController();
    busyShow("Reading sheets…", "Starting…", ctl);
    try {
      await prepareSets(opts.state ? opts.state.sets : readLocalSets(), ctl);
      busyHide();
    } catch (e) {
      busyHide();
      detachCloud();
      resetSlots();
      setS.on = false;
      showStartMsg(e.message === "Cancelled." ? "" : "Couldn't read the sheets: " + e.message, e.message !== "Cancelled.");
      return;
    }
  }
  setS.on = asSets;
  cpOn = true;
  $("startScreen").classList.add("hidden");
  $("cpApp").classList.remove("hidden");
  $("newBtn").classList.remove("hidden");
  if (opts.state) applyState(opts.state); else loadState();
  if (setS.on) { applyPairToSlots(); setS.filter = "all"; $("spFilter").querySelectorAll("[data-filter]").forEach((x) => x.classList.toggle("on", x.dataset.filter === "all")); }
  renderSets(); renderPairEditor();
  syncChrome(); renderNotes(); syncSaveUI();
  await nextFrame();
  await mountBoth(false);
  if (!setS.on && wantSets()) toast("These files have several sheets", "Tap Match sheets to line them up and compare them in pairs.", false, 6000);
}

async function startOver() {
  const wasCloud = !!cloudId;
  if (wasCloud && autosaver) {
    await autosaver.flush();
    if (lastSave === "error" && !confirm("Your latest changes couldn't be saved to your account. Close anyway?")) return;
  }
  detachCloud();
  if (!wasCloud) persist();
  cpOn = false;
  mountSeq++;
  bgRun++; cancel(bgTask);                     // stops any background work in progress
  clearCache();
  setS.on = false; setS.pairs = []; setS.idx = { A: [], B: [] }; setS.cur = 0; setS.total = 0; setS.done = 0; setS.notice = "";
  renderSets(); renderPairNav();
  $("setsPanel").classList.remove("open");
  setNoting(false);
  closeEditor();
  for (const L of [LA, LB]) { cancel(L.baseTask); clearDetail(L); L.page = null; }
  resetSlots();
  notes = []; selId = null;
  stage.classList.add("hidden");
  $("cpApp").classList.add("hidden");
  $("newBtn").classList.add("hidden");
  $("startScreen").classList.remove("hidden");
  showStartMsg("");
  refreshSaved();
}
$("newBtn").addEventListener("click", startOver);

/* ------------------------------------------------------------------ *
 *  Saved comparisons (on the server, under this login)
 * ------------------------------------------------------------------ */
function currentState() {
  return {
    title: $("docTitle").value.trim(),
    preparedBy: $("preparedBy").value.trim(),
    notes: notes.map((n) => ({ id: n.id, x: n.x, y: n.y, pa: n.pa, pb: n.pb, cat: n.cat, text: n.text, t: n.t })),
    view: { mode: view.mode, p: view.p, opacity: view.opacity },
    pages: { A: slots.A ? Math.max(1, slots.A.page) : 1, B: slots.B ? Math.max(1, slots.B.page) : 1 },
    sets: setS.on ? currentSets() : { on: false },
  };
}

// Loads notes / title / view settings from a saved comparison or an imported file.
function applyState(s) {
  s = s || {};
  notes = (Array.isArray(s.notes) ? s.notes : []).map((n) => ({
    id: n.id, x: n.x, y: n.y, pa: n.pa, pb: n.pb, cat: n.cat, text: n.text || "", t: n.t || Date.now(),
  }));
  $("docTitle").value = s.title || "";
  let by = s.preparedBy || "";
  if (!by) { try { by = localStorage.getItem("dh-compare-by") || ""; } catch (e) {} }
  $("preparedBy").value = by;
  const v = s.view || {};
  view.mode = v.mode === "overlay" ? "overlay" : "slider";
  view.p = typeof v.p === "number" ? clamp(v.p, 0, 1) : 0.5;
  view.opacity = typeof v.opacity === "number" ? clamp(v.opacity, 0, 1) : 1;
  $("opacity").value = String(Math.round(view.opacity * 100));
  const pg = s.pages || {};
  slots.A.page = clamp(parseInt(pg.A, 10) || 1, 1, slots.A.doc.numPages);
  slots.B.page = clamp(parseInt(pg.B, 10) || 1, 1, slots.B.doc.numPages);
  selId = null;
}

function onSaveStatus(s, err) {
  lastSave = s;
  const el = $("saveStatus");
  el.className = "save-status " + s;
  el.textContent = s === "saving" ? "Saving…" : s === "saved" ? "All changes saved" : "Couldn't save. Retrying…";
  el.title = s === "error" && err ? err.message : "";
}

function syncSaveUI() {
  $("saveBtnLabel").textContent = cloudId ? "Saved" : "Save";
  $("saveBtn").classList.toggle("on", !!cloudId);
  $("saveBtn").title = cloudId
    ? "Saved to your account. Changes save automatically."
    : "Save this comparison to your account";
  if (!cloudId) { $("saveStatus").textContent = ""; $("saveStatus").className = "save-status"; }
}

function attachCloud(id) {
  if (autosaver) autosaver.stop();
  cloudId = id;
  autosaver = cloud.createAutosaver({ id, getState: currentState, onStatus: onSaveStatus });
  onSaveStatus("saved");
  syncSaveUI();
}
function detachCloud() {
  if (autosaver) { autosaver.stop(); autosaver = null; }
  cloudId = null;
  syncSaveUI();
}

// Called whenever notes, title, pages, sheet pairs or view settings change.
function changed() {
  if (!cpOn) return;
  persist();                                   // local copy (only when not saved to the server)
  if (cloudId && autosaver) autosaver.schedule();
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden && autosaver) autosaver.flush();
});

/* ---------- list of saved comparisons ---------- */
// Applies what happened during this visit on top of whatever the server says.
function mergeList(d) {
  const items = d.items.filter((i) => !sessionGone.has(i.id));
  for (const [id, it] of sessionAdded) {
    if (!sessionGone.has(id) && !items.some((i) => i.id === id)) items.push(it);
  }
  const out = items
    .map((i) => (sessionRenamed.has(i.id) ? { ...i, title: sessionRenamed.get(i.id) } : i))
    .sort((a, b) => b.updated - a.updated);
  const used = out.reduce((s, i) => s + (i.A?.size || 0) + (i.B?.size || 0), 0);
  return { ...d, items: out, slotsUsed: out.length, usedBytes: used };
}
async function loadSaved() {
  return mergeList(await cloud.listComparisons());
}

function renderSavedList(container, items, { compact = false } = {}) {
  container.innerHTML = items.map((it) => {
    const nn = it.notes || 0;
    const open = compact ? "" :
      `<button class="btn btn-primary" data-act="open" data-id="${esc(it.id)}" style="min-height:40px">Open</button>`;
    const kind = it.kind === "sets" ? `<span class="sv-kind">Whole sets${it.pairs ? " · " + it.pairs + " sheets" : ""}</span>` : "";
    return `
    <div class="sv-item" data-id="${esc(it.id)}">
      <div class="sv-main">
        <div class="sv-title">${esc(it.title || "Untitled comparison")}</div>
        <div class="sv-files">
          <span class="cp-chip-tag cp-tag-a">A</span><span class="sv-fn">${esc(it.A.name)}</span>
          <span class="cp-chip-tag cp-tag-b">B</span><span class="sv-fn">${esc(it.B.name)}</span>
        </div>
        <div class="sv-meta">${kind}${nn} note${nn === 1 ? "" : "s"} · ${cloud.fmtBytes((it.A.size || 0) + (it.B.size || 0))} · ${esc(fmtWhen(it.updated))}</div>
      </div>
      <div class="sv-actions">
        ${open}
        <button class="btn btn-secondary" data-act="export" data-id="${esc(it.id)}" style="min-height:40px" title="Export to a file you can reopen later"><i class="ph ph-package"></i>Export</button>
        <button class="btn btn-secondary" data-act="rename" data-id="${esc(it.id)}" style="min-height:40px" aria-label="Rename"><i class="ph ph-pencil-simple"></i></button>
        <button class="btn btn-secondary" data-act="delete" data-id="${esc(it.id)}" style="min-height:40px" aria-label="Delete"><i class="ph ph-trash"></i></button>
      </div>
    </div>`;
  }).join("");
}

function paintSaved(d) {
  savedData = d;
  const msg = $("savedMsg");
  $("savedMeta").textContent =
    `${d.slotsUsed} of ${d.limits.maxComparisons} saved · ${cloud.fmtBytes(d.usedBytes)} of ${cloud.fmtBytes(d.limits.maxTotalBytes)} used`;
  msg.classList.toggle("hidden", d.items.length > 0);
  msg.textContent = d.items.length ? "" :
    "Nothing saved yet. After you compare two drawings, tap Save to keep the comparison and its notes here.";
  renderSavedList($("savedList"), d.items);
}

async function refreshSaved() {
  const msg = $("savedMsg");
  try {
    const d = await loadSaved();
    paintSaved(d);
    return d;
  } catch (e) {
    $("savedMeta").textContent = "";
    msg.classList.remove("hidden");
    msg.textContent = "Couldn't load your saved comparisons. " + e.message;
    $("savedList").innerHTML = "";
    return null;
  }
}

function wireList(container) {
  container.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    listAction(b.dataset.act, b.dataset.id);
  });
}
wireList($("savedList"));
wireList($("fullList"));

async function listAction(act, id) {
  const it = savedData && savedData.items.find((x) => x.id === id);
  if (act === "open") return openSaved(id);
  if (act === "export") return exportSavedItem(id);
  if (act === "rename") return openRename(id, it ? it.title : "");
  if (act === "delete") return deleteSaved(id, it);
}

async function openSaved(id) {
  const ctl = new AbortController();
  busyShow("Opening comparison…", "Starting…", ctl);
  try {
    const { item, state } = await cloud.getComparison(id);
    const files = await cloud.downloadFiles(item, { signal: ctl.signal, onProgress: busyProgress });
    $("busyText").textContent = "Loading the drawings…";
    const dA = await openFile(files.A);
    let dB;
    try { dB = await openFile(files.B); } catch (e) { dA.destroy(); throw e; }
    resetSlots();
    slots.A = { doc: dA, page: 1 };
    slots.B = { doc: dB, page: 1 };
    updateDz("A"); updateDz("B");
    attachCloud(id);
    busyHide();
    await startCompare({ state });
  } catch (e) {
    busyHide();
    if (e.message === "Cancelled.") toast("Cancelled", "", false, 2000);
    else flash("Couldn't open that comparison", e.message);
  }
}

async function exportSavedItem(id) {
  const ctl = new AbortController();
  busyShow("Preparing your file…", "Starting…", ctl);
  try {
    await cloud.exportSaved(id, { signal: ctl.signal, onProgress: busyProgress });
    busyHide();
    toast("Comparison file created", "Look in your Downloads (the Files app on iPad). You can now delete the saved copy to free a slot.", false, 6000);
  } catch (e) {
    busyHide();
    if (e.message === "Cancelled.") toast("Cancelled", "", false, 2000);
    else flash("Couldn't export", e.message);
  }
}

async function deleteSaved(id, it) {
  const name = it && it.title ? `"${it.title}"` : "this comparison";
  if (!confirm(`Delete ${name}? This can't be undone. If you may want it later, cancel and use Export first.`)) return;
  try {
    await cloud.deleteComparison(id);
    sessionGone.add(id); sessionAdded.delete(id);
    if (cloudId === id) detachCloud();
    toast("Deleted", "", false, 2000);
  } catch (e) { flash("Couldn't delete", e.message); }
  if (savedData) paintSaved(mergeList(savedData));       // show the change right away
  await refreshSaved();
  if (fullOpen) await refreshFull();
}

/* ---------- rename ---------- */
let renameId = null;
function openRename(id, current) {
  renameId = id;
  $("renameInput").value = current || "";
  $("renameDlg").classList.remove("hidden");
  setTimeout(() => { $("renameInput").focus(); $("renameInput").select(); }, 50);
}
function closeRename() { renameId = null; $("renameDlg").classList.add("hidden"); }
async function doRename() {
  const title = $("renameInput").value.trim();
  if (!renameId) return;
  if (!title) { flash("Give it a name", ""); return; }
  const id = renameId;
  try {
    await cloud.renameComparison(id, title);
    sessionRenamed.set(id, title);
    if (sessionAdded.has(id)) sessionAdded.set(id, { ...sessionAdded.get(id), title });
    closeRename();
    await refreshSaved();
    if (fullOpen) await refreshFull();
  } catch (e) { flash("Couldn't rename", e.message); }
}
$("renameSave").addEventListener("click", doRename);
$("renameCancel").addEventListener("click", closeRename);
$("renameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doRename(); } });
$("renameDlg").addEventListener("pointerdown", (e) => { if (e.target === $("renameDlg")) closeRename(); });

/* ---------- saving the open comparison ---------- */
let fullOpen = false, fullReason = "";

function roomFor(d) {
  const add = (slots.A ? slots.A.doc.file.size : 0) + (slots.B ? slots.B.doc.file.size : 0);
  return d.slotsUsed < d.limits.maxComparisons && d.usedBytes + add <= d.limits.maxTotalBytes;
}

function openFull(d, reason) {
  fullOpen = true;
  fullReason = reason;
  $("fullDlg").classList.remove("hidden");
  applyFull(d);
}
function applyFull(d) {
  savedData = d;
  renderSavedList($("fullList"), d.items, { compact: true });
  const room = roomFor(d);
  $("fullRetry").classList.toggle("hidden", !room);
  $("fullSub").textContent = room
    ? "There's room now. Tap Save now to save this comparison."
    : `${fullReason} Export one to a file if you may want it later, then delete it to make room.`;
}
async function refreshFull() {
  try { applyFull(await loadSaved()); }
  catch (e) { flash("Couldn't refresh the list", e.message); }
}
function closeFull() { fullOpen = false; $("fullDlg").classList.add("hidden"); }
$("fullCancel").addEventListener("click", closeFull);
$("fullRetry").addEventListener("click", () => { closeFull(); saveToCloud(); });
$("fullDlg").addEventListener("pointerdown", (e) => { if (e.target === $("fullDlg")) closeFull(); });

async function saveToCloud() {
  if (!cpOn) return;
  if (cloudId) { if (autosaver) await autosaver.flush(); return; }     // already saved: save pending changes now
  const A = slots.A.doc.file, B = slots.B.doc.file;
  let d;
  try { d = await loadSaved(); }
  catch (e) { flash("Couldn't reach your account", e.message); return; }
  savedData = d;
  const L = d.limits;
  const big = [A, B].find((f) => f.size > L.maxFileBytes);
  if (big) {
    flash("File too large to save",
      `"${big.name}" is ${cloud.fmtBytes(big.size)}. Saved drawings can be up to ${cloud.fmtBytes(L.maxFileBytes)} each. You can still export a comparison file instead.`);
    return;
  }
  if (d.slotsUsed >= L.maxComparisons) { openFull(d, `You have ${d.slotsUsed} of ${L.maxComparisons} saved comparisons.`); return; }
  if (d.usedBytes + A.size + B.size > L.maxTotalBytes) {
    openFull(d, `Saving this would go over your ${cloud.fmtBytes(L.maxTotalBytes)} of saved storage.`);
    return;
  }

  const ctl = new AbortController();
  busyShow("Saving comparison…", "Starting…", ctl);
  try {
    const item = await cloud.saveComparison({ A, B, state: currentState(), signal: ctl.signal, onProgress: busyProgress });
    busyHide();
    sessionAdded.set(item.id, item);
    sessionGone.delete(item.id);
    attachCloud(item.id);
    toast("Saved to your account", item.title || "", false, 2500);
  } catch (e) {
    busyHide();
    if (e.message === "Cancelled.") toast("Save cancelled", "", false, 2500);
    else flash("Couldn't save", e.message);
  }
}
$("saveBtn").addEventListener("click", saveToCloud);

/* ---------- single-file export / import (.dhcompare) ---------- */
$("exFile").addEventListener("click", () => {
  closeMenu();
  if (!cpOn) return;
  try {
    const st = currentState();
    const A = slots.A.doc.file, B = slots.B.doc.file;
    cloud.saveBlob(cloud.buildExport({ A, B, state: st }), cloud.exportFileName(st, A, B));
    toast("Comparison file created", "Look in your Downloads (the Files app on iPad). Use Open saved file on this page to reopen it.", false, 5000);
  } catch (e) { flash("Couldn't create the file", e.message); }
});

async function importFile(file) {
  showStartMsg(`Reading ${file.name}…`, false);
  try {
    const parsed = await cloud.parseExport(file);
    const dA = await openFile(parsed.A);
    let dB;
    try { dB = await openFile(parsed.B); } catch (e) { dA.destroy(); throw e; }
    resetSlots();
    slots.A = { doc: dA, page: 1 };
    slots.B = { doc: dB, page: 1 };
    updateDz("A"); updateDz("B");
    showStartMsg("");
    await startCompare({ state: parsed.state });
  } catch (e) {
    showStartMsg(e.message, true);
  }
}
$("fileImport").addEventListener("change", (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (f) importFile(f);
});

/* ------------------------------------------------------------------ *
 *  Zoom buttons + keyboard
 * ------------------------------------------------------------------ */
$("zoomIn").addEventListener("click", () => { withAnim(() => zoomAt(S.z * 1.4, S.vw / 2, S.vh / 2)); scheduleDetail(260); });
$("zoomOut").addEventListener("click", () => { withAnim(() => zoomAt(S.z / 1.4, S.vw / 2, S.vh / 2)); scheduleDetail(260); });
$("fitBtn").addEventListener("click", () => { withAnim(fitView); scheduleDetail(260); });
$("zoomLevel").addEventListener("click", () => { withAnim(fitView); scheduleDetail(260); });

document.addEventListener("keydown", (e) => {
  if (busyActive()) return;
  if (!$("renameDlg").classList.contains("hidden")) { if (e.key === "Escape") closeRename(); return; }
  if (!$("fullDlg").classList.contains("hidden")) { if (e.key === "Escape") closeFull(); return; }
  if (!$("noteDlg").classList.contains("hidden")) { if (e.key === "Escape") closeEditor(); return; }
  if (e.key === "Escape") { closeMenu(); if (view.noting) setNoting(false); return; }
  if (!cpOn) return;
  if (e.target.matches && e.target.matches("input,select,textarea")) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") { e.preventDefault(); doPrint(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "+" || e.key === "=") { withAnim(() => zoomAt(S.z * 1.25, S.vw / 2, S.vh / 2)); scheduleDetail(260); }
  else if (e.key === "-") { withAnim(() => zoomAt(S.z / 1.25, S.vw / 2, S.vh / 2)); scheduleDetail(260); }
  else if (e.key === "0") { withAnim(fitView); scheduleDetail(260); }
  else if (setS.on && e.key === "[") selectPair(setS.cur - 1);
  else if (setS.on && e.key === "]") selectPair(setS.cur + 1);
});

/* ------------------------------------------------------------------ *
 *  Slider divider drag
 * ------------------------------------------------------------------ */
let draggingDivider = false;
function moveDivider(e) {
  const r = viewport.getBoundingClientRect();
  view.p = clamp((e.clientX - r.left - S.tx) / S.z / S.W0, 0, 1);
  applySlider();
}
divider.addEventListener("pointerdown", (e) => {
  e.preventDefault(); e.stopPropagation();
  draggingDivider = true;
  try { divider.setPointerCapture(e.pointerId); } catch (err) {}
  moveDivider(e);
});
divider.addEventListener("pointermove", (e) => { if (draggingDivider) moveDivider(e); });
["pointerup", "pointercancel", "lostpointercapture"].forEach((t) =>
  divider.addEventListener(t, () => { if (draggingDivider) { draggingDivider = false; changed(); } }));

/* ------------------------------------------------------------------ *
 *  Pinch / pan / tap
 * ------------------------------------------------------------------ */
const ptrs = new Map();
let g = null;
let lastTap = null;

function relPos(e) {
  const r = viewport.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function beginGesture() {
  const pts = [...ptrs.values()];
  if (pts.length === 1) {
    g = { type: "pan", sx: pts[0].x, sy: pts[0].y, tx0: S.tx, ty0: S.ty, moved: 0, t0: performance.now(), multi: false };
  } else if (pts.length === 2) {
    const [a, b] = pts;
    g = { type: "pinch", d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
          mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, z0: S.z, tx0: S.tx, ty0: S.ty };
  }
}

// Single tap: open a pin, drop a new note (in note mode), or (double-tap) zoom.
function onTap(x, y) {
  const hit = pinAt(x, y);
  if (hit) { selId = hit.id; renderPins(); renderNotes(); openEditor(hit); return; }
  if (view.noting) {
    const fx = (x - S.tx) / (S.z * S.W0), fy = (y - S.ty) / (S.z * S.H0);
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
    openEditor({ id: null, x: fx, y: fy, cat: "Changed", text: "", pa: slots.A.page, pb: slots.B.page });
    return;
  }
  const now = performance.now();
  if (lastTap && now - lastTap.t < 320 && Math.hypot(x - lastTap.x, y - lastTap.y) < 40) {
    lastTap = null;
    withAnim(() => { if (S.z > 1.6) fitView(); else zoomAt(2.5, x, y); });
    scheduleDetail(260);
  } else {
    lastTap = { t: now, x, y };
  }
}

viewport.addEventListener("pointerdown", (e) => {
  if (draggingDivider || !cpOn) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  if (ptrs.size >= 2) return;
  try { viewport.setPointerCapture(e.pointerId); } catch (err) {}
  ptrs.set(e.pointerId, relPos(e));
  beginGesture();
  viewport.classList.add("grabbing");
});

viewport.addEventListener("pointermove", (e) => {
  const p = ptrs.get(e.pointerId);
  if (!p || !g) return;
  Object.assign(p, relPos(e));
  if (g.type === "pan" && ptrs.size === 1) {
    const dx = p.x - g.sx, dy = p.y - g.sy;
    g.moved = Math.max(g.moved, Math.hypot(dx, dy));
    S.tx = g.tx0 + dx; S.ty = g.ty0 + dy;
    clampT(); applyTransform();
  } else if (g.type === "pinch" && ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const z2 = clamp(g.z0 * d / g.d0, MIN_Z, MAX_Z);
    const px = (g.mx - g.tx0) / g.z0, py = (g.my - g.ty0) / g.z0;
    S.z = z2; S.tx = mx - px * z2; S.ty = my - py * z2;
    clampT(); applyTransform();
  }
});

function endPointer(e) {
  if (!ptrs.has(e.pointerId)) return;
  const was = ptrs.size;
  ptrs.delete(e.pointerId);
  if (g && g.type === "pan" && was === 1) {
    const dt = performance.now() - g.t0;
    if (!g.multi && g.moved < 8 && dt < 400 && e.type === "pointerup") onTap(g.sx, g.sy);
    g = null;
    scheduleDetail();
  } else if (g && g.type === "pinch") {
    if (ptrs.size === 1) {
      const p = [...ptrs.values()][0];
      g = { type: "pan", sx: p.x, sy: p.y, tx0: S.tx, ty0: S.ty, moved: 99, t0: 0, multi: true };
    } else g = null;
    scheduleDetail();
  }
  if (ptrs.size === 0) viewport.classList.remove("grabbing");
}
["pointerup", "pointercancel", "lostpointercapture"].forEach((t) => viewport.addEventListener(t, endPointer));

viewport.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (!cpOn) return;
  const { x, y } = relPos(e);
  const mul = e.deltaMode === 1 ? 16 : 1;
  const dx = e.deltaX * mul, dy = e.deltaY * mul;
  if (e.ctrlKey || e.metaKey) zoomAt(S.z * Math.exp(-clamp(dy, -30, 30) * 0.01), x, y);
  else { S.tx -= dx; S.ty -= dy; clampT(); applyTransform(); }
  scheduleDetail();
}, { passive: false });

let gz0 = 1;
viewport.addEventListener("gesturestart", (e) => { e.preventDefault(); gz0 = S.z; });
viewport.addEventListener("gesturechange", (e) => {
  e.preventDefault();
  if (ptrs.size) return;
  const r = viewport.getBoundingClientRect();
  zoomAt(gz0 * e.scale, e.clientX - r.left, e.clientY - r.top);
});
viewport.addEventListener("gestureend", (e) => { e.preventDefault(); scheduleDetail(); });
viewport.addEventListener("dblclick", (e) => e.preventDefault());

let resizeTimer = null;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(onResize, 120); }).observe(viewport);
async function onResize() {
  if (!cpOn || !LB.page) return;
  const r = viewport.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return;
  if (Math.abs(S.vw - r.width) < 1 && Math.abs(S.vh - r.height) < 1) return;
  await mountBoth(false);
}

/* ------------------------------------------------------------------ *
 *  Notes
 * ------------------------------------------------------------------ */
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const onThisView = (n) => slots.A && slots.B && n.pa === slots.A.page && n.pb === slots.B.page;

function zoneOf(x, y) {
  const c = clamp(Math.floor(x * ZCOLS) + 1, 1, ZCOLS);
  const r = clamp(Math.floor(y * ZROWS), 0, ZROWS - 1);
  return String.fromCharCode(65 + r) + "-" + c;
}
const ZONE_NOTE = `Zone = row letter (A–${String.fromCharCode(64 + ZROWS)}, top to bottom) and column number (1–${ZCOLS}, left to right) on Drawing B.`;

function setNoting(on) {
  view.noting = on;
  $("noteBtn").setAttribute("aria-pressed", String(on));
  $("noteBtn").classList.toggle("on", on);
  $("noteBanner").classList.toggle("hidden", !on);
  viewport.classList.toggle("noting", on);
}
$("noteBtn").addEventListener("click", () => setNoting(!view.noting));
$("notesToggle").addEventListener("click", () => $("notesPanel").classList.toggle("open"));

function renderPins() {
  pinsEl.innerHTML = notes.map((n, i) => onThisView(n)
    ? `<div class="pin cat-${n.cat.toLowerCase()}${n.id === selId ? " sel" : ""}" data-id="${n.id}" style="left:${n.x * 100}%;top:${n.y * 100}%">${i + 1}</div>`
    : "").join("");
}

function pinAt(x, y) {
  let best = null, bd = 26;
  for (const n of notes) {
    if (!onThisView(n)) continue;
    const d = Math.hypot(S.tx + n.x * S.W0 * S.z - x, S.ty + n.y * S.H0 * S.z - y);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

function whereOf(n) {
  const zone = `Zone ${zoneOf(n.x, n.y)}`;
  if (setS.on) return `${sheetOf(n)} · ${zone}`;
  const multi = slots.A && slots.B && (slots.A.doc.numPages > 1 || slots.B.doc.numPages > 1);
  return multi ? `${zone} · A p.${n.pa} / B p.${n.pb}` : zone;
}

function renderNotes() {
  $("notesToggleLabel").textContent = `Notes (${notes.length})`;
  $("noteEmpty").classList.toggle("hidden", notes.length > 0);
  $("clearNotes").classList.toggle("hidden", notes.length === 0);
  $("noteList").innerHTML = notes.map((n, i) => `
    <div class="np-item cat-${n.cat.toLowerCase()}${n.id === selId ? " sel" : ""}${onThisView(n) ? "" : " off"}" data-id="${n.id}">
      <span class="np-n">${i + 1}</span>
      <div class="np-body">
        <div class="np-top"><span class="np-cat">${esc(n.cat)}</span><span class="np-where">${esc(whereOf(n))}</span></div>
        <div class="np-text">${n.text ? esc(n.text) : '<i class="muted">No text</i>'}</div>
      </div>
      <button class="np-edit" data-edit="${n.id}" aria-label="Edit note ${i + 1}"><i class="ph ph-pencil-simple"></i></button>
    </div>`).join("");
  if (setS.on) renderSetsList();
}

$("noteList").addEventListener("click", (e) => {
  const ed = e.target.closest("[data-edit]");
  if (ed) { const n = notes.find((x) => x.id === ed.dataset.edit); if (n) openEditor(n); return; }
  const it = e.target.closest(".np-item");
  if (it) focusNote(it.dataset.id);
});

async function focusNote(id) {
  const n = notes.find((x) => x.id === id);
  if (!n) return;
  selId = id;
  if (!onThisView(n)) {
    if (setS.on) {
      const i = pairIndexOf(n);
      if (i >= 0) setS.cur = i;
      renderSets(); renderPairEditor();
    }
    slots.A.page = n.pa; slots.B.page = n.pb;
    syncChrome();
    await mountBoth(true);
  }
  const z = Math.max(S.z, 2);
  withAnim(() => {
    S.z = z;
    S.tx = S.vw / 2 - n.x * S.W0 * z;
    S.ty = S.vh / 2 - n.y * S.H0 * z;
    clampT(); applyTransform();
  });
  scheduleDetail(260);
  renderPins(); renderNotes();
  $("notesPanel").classList.remove("open");
}

$("clearNotes").addEventListener("click", () => {
  if (!notes.length || !confirm(`Delete all ${notes.length} note${notes.length === 1 ? "" : "s"}?`)) return;
  notes = []; selId = null;
  changed(); renderNotes(); renderPins();
});

/* ---------- note editor ---------- */
function openEditor(n) {
  edit = n;
  const idx = n.id ? notes.findIndex((x) => x.id === n.id) : -1;
  $("noteDlgTitle").textContent = n.id ? `Note ${idx + 1}` : "New note";
  $("noteDlgSub").textContent = whereOf(n);
  $("noteCat").value = n.cat;
  $("noteText").value = n.text;
  $("noteDelete").classList.toggle("hidden", !n.id);
  $("noteDlg").classList.remove("hidden");
  setTimeout(() => $("noteText").focus(), 50);
}
function closeEditor() {
  edit = null;
  $("noteDlg").classList.add("hidden");
}
$("noteCancel").addEventListener("click", closeEditor);
$("noteDlg").addEventListener("pointerdown", (e) => { if (e.target === $("noteDlg")) closeEditor(); });
$("noteSave").addEventListener("click", () => {
  if (!edit) return;
  const cat = $("noteCat").value, text = $("noteText").value.trim();
  if (edit.id) {
    const n = notes.find((x) => x.id === edit.id);
    if (n) { n.cat = cat; n.text = text; }
  } else {
    const n = { id: newId(), x: edit.x, y: edit.y, pa: edit.pa, pb: edit.pb, cat, text, t: Date.now() };
    notes.push(n); selId = n.id;
  }
  closeEditor(); changed(); renderNotes(); renderPins();
});
$("noteDelete").addEventListener("click", () => {
  if (!edit || !edit.id) return;
  notes = notes.filter((x) => x.id !== edit.id);
  if (selId === edit.id) selId = null;
  closeEditor(); changed(); renderNotes(); renderPins();
});

/* ---------- local copy of notes in this browser (only for comparisons not saved to the server) ---------- */
const LS_INDEX = "dh-compare-index";
function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
function stateKey() { return "dh-compare:" + hash([slots.A.doc.fp, slots.B.doc.fp].sort().join("||")); }

function persist() {
  if (cloudId || !slots.A || !slots.B) return;
  try {
    const key = stateKey();
    localStorage.setItem(key, JSON.stringify({
      title: $("docTitle").value, preparedBy: $("preparedBy").value, notes, t: Date.now(),
      sets: setS.on ? { ...currentSets(), fpA: slots.A.doc.fp } : null,
    }));
    let idx = JSON.parse(localStorage.getItem(LS_INDEX) || "[]").filter((k) => k !== key);
    idx.push(key);
    while (idx.length > 25) localStorage.removeItem(idx.shift());
    localStorage.setItem(LS_INDEX, JSON.stringify(idx));
  } catch (e) { /* storage full or blocked: notes still work for this session */ }
}
// Sheet pairs kept in this browser for these two files (only if A and B are in the same order as before).
function readLocalSets() {
  try {
    const raw = localStorage.getItem(stateKey());
    if (!raw) return null;
    const s = JSON.parse(raw).sets;
    return s && s.on && s.fpA === slots.A.doc.fp ? s : null;
  } catch (e) { return null; }
}
function loadState() {
  notes = [];
  let title = "", by = "";
  try {
    const raw = localStorage.getItem(stateKey());
    if (raw) {
      const d = JSON.parse(raw);
      title = d.title || ""; by = d.preparedBy || "";
      if (Array.isArray(d.notes)) notes = d.notes.filter((n) => n && typeof n.x === "number" && typeof n.y === "number" && n.cat);
    }
  } catch (e) { /* ignore */ }
  if (!by) { try { by = localStorage.getItem("dh-compare-by") || ""; } catch (e) {} }
  $("docTitle").value = title;
  $("preparedBy").value = by;
}
let metaTimer = null;
["docTitle", "preparedBy"].forEach((id) => $(id).addEventListener("input", () => {
  clearTimeout(metaTimer);
  metaTimer = setTimeout(() => {
    changed();
    try { localStorage.setItem("dh-compare-by", $("preparedBy").value); } catch (e) {}
  }, 400);
}));

/* ------------------------------------------------------------------ *
 *  Rendering the overview + before/after crops (print + export)
 * ------------------------------------------------------------------ */
const canvasBlob = (c) => new Promise((res, rej) =>
  c.toBlob((b) => (b ? res(b) : rej(new Error("Couldn't build the image"))), "image/png"));
async function canvasBytes(c) {
  const b = await canvasBlob(c);
  const out = { data: new Uint8Array(await b.arrayBuffer()), w: c.width, h: c.height };
  c.width = c.height = 0;
  return out;
}

function tintCanvas(c, color) {
  const x = c.getContext("2d");
  x.globalCompositeOperation = "lighten";
  x.fillStyle = color;
  x.fillRect(0, 0, c.width, c.height);
  x.globalCompositeOperation = "source-over";
}

// Numbered pins for the notes that belong to one pair of pages.
function drawPins(ctx, W, H, pa, pb) {
  const r = Math.max(14, W / 100);
  ctx.save();
  ctx.font = `700 ${Math.round(r * 1.15)}px Arial, sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  notes.forEach((n, i) => {
    if (n.pa !== pa || n.pb !== pb) return;
    const cx = n.x * W, cy = n.y * H;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "#5b3fd6"; ctx.fill();
    ctx.lineWidth = Math.max(2, r / 6); ctx.strokeStyle = "#fff"; ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.fillText(String(i + 1), cx, cy + 1);
  });
  ctx.restore();
}

// One pair of pages (default: the pair on screen) as a single image, with its note pins.
async function buildOverview(maxPx, pa = slots.A.page, pb = slots.B.page) {
  const { pageA, pageB } = await pagePair(pa, pb);
  const vB = pageB.getViewport({ scale: 1 });
  let s = Math.min(Math.sqrt(maxPx / (vB.width * vB.height)), 4.2);
  s = Math.min(s, 7000 / Math.max(vB.width, vB.height));
  const W = Math.max(1, Math.round(vB.width * s)), H = Math.max(1, Math.round(vB.height * s));
  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  await renderFit(pageB, out).promise;

  const tmp = document.createElement("canvas");
  tmp.width = W; tmp.height = H;
  await renderFit(pageA, tmp).promise;
  if (view.mode === "overlay") {
    const col = colors.get();
    tintCanvas(out, col.b);            // Drawing B (newer) in its color
    tintCanvas(tmp, col.a);            // Drawing A (older) in its color
    ctx.globalCompositeOperation = "multiply";
    ctx.globalAlpha = view.opacity;
    ctx.drawImage(tmp, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
  } else {
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W * view.p, H); ctx.clip();
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    ctx.drawImage(tmp, 0, 0);
    ctx.restore();
    const lw = Math.max(3, W / 900);
    ctx.fillStyle = "#7c6ff0";
    ctx.fillRect(W * view.p - lw / 2, 0, lw, H);
  }
  tmp.width = tmp.height = 0;
  drawPins(ctx, W, H, pa, pb);
  return out;
}

// Side-by-side crops of the area around one note, from both drawings.
async function renderCrops(n) {
  const { pageA: pA, pageB: pB } = await pagePair(n.pa, n.pb);
  const vB = pB.getViewport({ scale: 1 }), vA = pA.getViewport({ scale: 1 });
  const W0 = 1000, H0 = 1000 * vB.height / vB.width;
  const cw = Math.min(CROP_W, W0), ch = Math.min(cw * CROP_RATIO, H0);
  const rx = clamp(n.x * W0 - cw / 2, 0, W0 - cw), ry = clamp(n.y * H0 - ch / 2, 0, H0 - ch);
  const k = CROP_K;
  const sA = Math.min(W0 / vA.width, H0 / vA.height);
  const boxA = { x: (W0 - vA.width * sA) / 2, y: (H0 - vA.height * sA) / 2, w: vA.width * sA };
  const boxB = { x: 0, y: 0, w: W0 };

  async function one(page, v, box) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(cw * k)); c.height = Math.max(1, Math.round(ch * k));
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    const vp = page.getViewport({ scale: (box.w / v.width) * k, offsetX: -(rx - box.x) * k, offsetY: -(ry - box.y) * k });
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    ctx.beginPath();
    ctx.arc((n.x * W0 - rx) * k, (n.y * H0 - ry) * k, 12 * k, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(3, 1.2 * k); ctx.strokeStyle = "#d9261c"; ctx.stroke();
    return c;
  }
  const a = await one(pA, vA, boxA);
  const b = await one(pB, vB, boxB);
  return { a, b };
}

/* ------------------------------------------------------------------ *
 *  Print
 * ------------------------------------------------------------------ */
let printUrls = [];
const titleOrDefault = () =>
  $("docTitle").value.trim() || `${baseName(slots.A.doc.name)} vs ${baseName(slots.B.doc.name)}`;

function setPageStyle(landscape) {
  let st = $("pageStyle");
  if (!st) { st = document.createElement("style"); st.id = "pageStyle"; document.head.appendChild(st); }
  st.textContent = `@page { size: ${landscape ? "landscape" : "portrait"}; margin: 8mm; }`;
}

const noteRowHtml = (n, i, ua, ub, showSheet) => `<tr>
  <td class="pn-n">${i + 1}</td>
  <td class="pn-cat">${esc(n.cat)}</td>
  <td class="pn-zone">${zoneOf(n.x, n.y)}<span>${showSheet ? esc(sheetOf(n)) : `A p.${n.pa} · B p.${n.pb}`}</span></td>
  <td class="pn-text">${n.text ? esc(n.text) : ""}</td>
  <td class="pn-img"><img src="${ua}" alt=""></td>
  <td class="pn-img"><img src="${ub}" alt=""></td></tr>`;
const NOTE_HEAD = `<thead><tr><th>#</th><th>Type</th><th>Zone</th><th>Note</th><th>Drawing A</th><th>Drawing B</th></tr></thead>`;

async function cropUrls(n, urls) {
  const { a, b } = await renderCrops(n);
  const ua = URL.createObjectURL(await canvasBlob(a)); a.width = a.height = 0;
  const ub = URL.createObjectURL(await canvasBlob(b)); b.width = b.height = 0;
  urls.push(ua, ub);
  return [ua, ub];
}

async function doPrint() {
  if (!cpOn || !LB.page || !LA.page) return;
  const btn = $("printBtn"), label = btn.querySelector("span");
  const prev = label ? label.textContent : "";
  btn.disabled = true;
  if (label) label.textContent = "Preparing…";
  const urls = [];
  try {
    if (setS.on) await buildSetPrint(urls);
    else await buildSinglePrint(urls);
    printUrls.forEach((u) => URL.revokeObjectURL(u));
    printUrls = urls;
    await Promise.all([...$("printArea").querySelectorAll("img")].map((im) => im.decode().catch(() => {})));
    window.print();
  } catch (e) {
    urls.forEach((u) => URL.revokeObjectURL(u));
    flash("Couldn't prepare the print", e.message);
  } finally {
    btn.disabled = false;
    if (label) label.textContent = prev;
  }
}

async function buildSinglePrint(urls) {
  $("printArea").classList.remove("sets-print");
  const canvas = await buildOverview(PRINT_MAXPX);
  const landscape = canvas.width >= canvas.height;
  const ovUrl = URL.createObjectURL(await canvasBlob(canvas));
  canvas.width = canvas.height = 0;
  urls.push(ovUrl);

  const rows = [];
  for (let i = 0; i < notes.length; i++) {
    const [ua, ub] = await cropUrls(notes[i], urls);
    rows.push(noteRowHtml(notes[i], i, ua, ub, false));
  }

  const printed = new Date().toLocaleDateString();
  const modeText = view.mode === "overlay"
    ? colors.overlayText("A", "B")
    : "Slider: A is left of the line, B is right of it";
  const by = $("preparedBy").value.trim();
  $("printHead").innerHTML =
    `<div class="ph-title"><b>${esc(titleOrDefault())}</b></div>` +
    `<div class="ph-sub">A (before): ${esc(slots.A.doc.name)} · B (after): ${esc(slots.B.doc.name)}</div>` +
    `<div class="ph-sub">${esc(modeText)} · ${by ? "Prepared by " + esc(by) + " · " : ""}Printed ${esc(printed)}</div>`;
  $("printNotes").innerHTML = notes.length
    ? `<div class="pn-title">Notes (${notes.length})</div>
       <table class="pn-table">${NOTE_HEAD}<tbody>${rows.join("")}</tbody></table>
       <div class="pn-foot">${esc(ZONE_NOTE)}</div>`
    : `<div class="pn-title">No notes recorded</div>`;
  setPageStyle(landscape);
  $("printImg").src = ovUrl;
}

// A whole set: a summary of every sheet, then one section per sheet that has notes.
async function buildSetPrint(urls) {
  $("printArea").classList.add("sets-print");
  $("printImg").removeAttribute("src");

  const groups = [];
  const seen = new Set();
  setS.pairs.forEach((p) => {
    const list = notes.filter((n) => n.pa === p.a && n.pb === p.b);
    if (!list.length) return;
    list.forEach((n) => seen.add(n.id));
    groups.push({ num: p.num, title: p.title, status: STATUS_TEXT[statusOf(p)], pa: p.a, pb: p.b, list });
  });
  const orphans = notes.filter((n) => !seen.has(n.id));
  if (orphans.length) groups.push({ num: "Other notes", title: "", status: "", list: orphans, noImage: true });

  let landscape = true, first = true;
  const sections = [];
  for (const g of groups) {
    let imgHtml = "";
    if (!g.noImage) {
      const canvas = await buildOverview(SET_PRINT_MAXPX, g.pa, g.pb);
      if (first) { landscape = canvas.width >= canvas.height; first = false; }
      const u = URL.createObjectURL(await canvasBlob(canvas));
      canvas.width = canvas.height = 0;
      urls.push(u);
      imgHtml = `<img class="ps-img" src="${u}" alt="">`;
    }
    const rows = [];
    for (const n of g.list) {
      const [ua, ub] = await cropUrls(n, urls);
      rows.push(noteRowHtml(n, notes.indexOf(n), ua, ub, g.noImage));
    }
    sections.push(`<section class="ps-sec">
      <div class="ps-head"><b>${esc(g.num)}</b>${g.title ? " — " + esc(g.title) : ""} <span>${esc(g.status)}</span></div>
      ${imgHtml}
      <table class="pn-table">${NOTE_HEAD}<tbody>${rows.join("")}</tbody></table>
    </section>`);
  }

  const sumRows = setS.pairs.map((p) => `<tr>
    <td class="pn-n">${esc(p.num)}</td><td class="pn-text">${esc(p.title)}</td>
    <td class="pn-cat">${esc(STATUS_TEXT[statusOf(p)])}</td>
    <td class="pn-n">${p.a ? "p." + p.a : "–"}</td><td class="pn-n">${p.b ? "p." + p.b : "–"}</td>
    <td class="pn-n">${notesOnPair(p)}</td></tr>`).join("");

  const printed = new Date().toLocaleDateString();
  const modeText = view.mode === "overlay"
    ? colors.overlayText("A", "B")
    : "Slider: A is left of the line, B is right of it";
  const by = $("preparedBy").value.trim();
  $("printHead").innerHTML =
    `<div class="ph-title"><b>${esc(titleOrDefault())}</b></div>` +
    `<div class="ph-sub">Set A (before): ${esc(slots.A.doc.name)} · ${slots.A.doc.numPages} sheets · Set B (after): ${esc(slots.B.doc.name)} · ${slots.B.doc.numPages} sheets</div>` +
    `<div class="ph-sub">${esc(modeText)} · ${by ? "Prepared by " + esc(by) + " · " : ""}Printed ${esc(printed)}</div>`;
  $("printNotes").innerHTML =
    `<div class="pn-title">Sheets (${setS.pairs.length})</div>
     <table class="pn-table ps-sum"><thead><tr><th>Sheet</th><th>Title</th><th>Status</th><th>Set A</th><th>Set B</th><th>Notes</th></tr></thead><tbody>${sumRows}</tbody></table>
     <div class="pn-foot">Change flags compare a reduced picture of each sheet and are a guide, not proof. ${esc(ZONE_NOTE)}</div>
     ${sections.join("")}`;
  setPageStyle(landscape);
}

$("printBtn").addEventListener("click", doPrint);
window.addEventListener("afterprint", () => {
  setTimeout(() => {
    printUrls.forEach((u) => URL.revokeObjectURL(u));
    printUrls = [];
    $("printImg").removeAttribute("src");
    $("printNotes").innerHTML = "";
    $("printArea").classList.remove("sets-print");
  }, 1500);
});

/* ------------------------------------------------------------------ *
 *  Export (Word / Excel) — builders live in compare-export.js
 * ------------------------------------------------------------------ */
function closeMenu() {
  $("exportMenu").classList.add("hidden");
  $("exportBtn").setAttribute("aria-expanded", "false");
}
$("exportBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const open = $("exportMenu").classList.toggle("hidden") === false;
  $("exportBtn").setAttribute("aria-expanded", String(open));
});
document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".cp-menu-wrap")) closeMenu(); });

function buildCtx() {
  const now = new Date();
  const title = titleOrDefault();
  const sets = setS.on;
  const list = notes.map((n, i) => {
    const si = sets ? pairIndexOf(n) : 0;
    return { n: i + 1, id: n.id, cat: n.cat, text: n.text, zone: zoneOf(n.x, n.y),
             x: n.x, y: n.y, pageA: n.pa, pageB: n.pb, created: n.t,
             sheet: sets ? sheetOf(n) : "", sheetIdx: sets ? (si >= 0 ? si : 9999) : 0 };
  });
  if (sets) list.sort((a, b) => a.sheetIdx - b.sheetIdx || a.n - b.n);
  return {
    title,
    preparedBy: $("preparedBy").value.trim(),
    date: now.toLocaleDateString(),
    dateISO: now.toISOString().slice(0, 10),
    slug: title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_").slice(0, 60) || "Drawing_Comparison",
    zoneNote: ZONE_NOTE,
    mode: view.mode,
    setMode: sets,
    overlayNote: colors.overlayText("A", "B") + ".",
    fileA: { name: slots.A.doc.name, page: slots.A.page, pages: slots.A.doc.numPages },
    fileB: { name: slots.B.doc.name, page: slots.B.page, pages: slots.B.doc.numPages },
    sheets: sets ? setS.pairs.map((p, idx) => {
      const st = statusOf(p);
      return { idx, num: p.num, title: p.title, status: st, statusText: STATUS_TEXT[st], a: p.a, b: p.b, notes: notesOnPair(p) };
    }) : null,
    notes: list,
    async getOverview(maxPx = 3e6, pa, pb) {
      return canvasBytes(await buildOverview(maxPx, pa == null ? slots.A.page : pa, pb == null ? slots.B.page : pb));
    },
    async getCrops(note) {
      const src = notes.find((x) => x.id === note.id);
      const { a, b } = await renderCrops(src);
      return { a: await canvasBytes(a), b: await canvasBytes(b) };
    },
  };
}

async function runExport(kind) {
  closeMenu();
  if (!cpOn) return;
  if (!notes.length) { flash("No notes to export yet", "Add at least one note first."); return; }
  const btn = $("exportBtn");
  btn.disabled = true;
  const t = toast("Building your file…", "This can take a few seconds.", false, 0);
  try {
    const mod = await import("./compare-export.js");
    const ctx = buildCtx();
    await (kind === "word" ? mod.exportWord(ctx) : mod.exportExcel(ctx));
  } catch (e) {
    flash("Couldn't export", e.message);
  } finally {
    t.remove();
    btn.disabled = false;
  }
}
$("exWord").addEventListener("click", () => runExport("word"));
$("exExcel").addEventListener("click", () => runExport("excel"));

/* ------------------------------------------------------------------ */
requireLogin(() => {
  if (!pdfjsLib) showStartMsg("The PDF viewer library didn't load. Images will still work; reload to retry PDFs.", true);
  refreshSaved();
});
