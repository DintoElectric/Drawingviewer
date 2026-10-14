// /compare-store — ANY SIGNED-IN USER (not admin-only).
// Saves each person's Compare-page comparisons (both drawings + notes) under
// their own login so they can log out, log back in, and pick up where they left off.
//
//   GET  ?action=list
//   GET  ?action=get&id=
//   GET  ?action=file&id=&which=A|B&chunk=i     -> raw bytes of one piece
//   POST {action:"begin",  title, files:{A:{name,size,mime}, B:{...}}}  -> {id, chunkBytes}
//   POST {action:"chunk",  id, which, index, dataB64}
//   POST {action:"commit", id, state}
//   POST {action:"update", id, state}           (autosave: notes + view)
//   POST {action:"rename", id, title}
//   POST {action:"delete", id}
//
// Files are stored as CHUNK_BYTES pieces (no stitching on the server), so big
// scans never sit whole in a function's memory and every request stays small.
//
// NOTE: this uses the app's normal store(event). Netlify Blobs "strong"
// consistency is not available to functions in this setup, so reads can lag a
// moment behind writes. Every read that depends on a just-written value
// therefore retries briefly (see waitEntry / allPresent).
const crypto = require("crypto");
const { store, requireUser, readJSON, writeJSON, json, fail, httpError, safeIndex } = require("./lib/auth");

/* ---- limits: change these numbers to change the rules ---------------- */
const MAX_COMPARISONS = 12;                  // saved comparisons per person
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;   // total saved drawings per person
const MAX_FILE_BYTES = 50 * 1024 * 1024;     // largest single drawing
const CHUNK_BYTES = 3 * 1024 * 1024;         // piece size (upload and download)
const STALE_MS = 60 * 60 * 1000;             // half-finished uploads are cleared after 1 hour
const MAX_NOTES = 500;
const MB = 1024 * 1024;
const CATS = ["Changed", "Added", "Removed", "Question", "Other"];
const ID_RE = /^[a-z0-9]{8,32}$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- keys ------------------------------------------------------------- */
// Each person's private folder is a hash of their Identity user id.
function userKey(user) {
  const id = String(user.sub || user.email || "").trim().toLowerCase();
  if (!id) throw httpError(401, "Couldn't identify your account. Please sign in again.");
  return crypto.createHash("sha256").update(id).digest("hex").slice(0, 32);
}

const K = {
  index: (u) => `compare/${u}/index.json`,
  state: (u, id) => `compare/${u}/${id}/state.json`,
  chunk: (u, id, w, i) => `compare/${u}/${id}/${w}/${i}`,
};

function safeId(id) {
  const s = String(id || "").toLowerCase();
  if (!ID_RE.test(s)) throw httpError(400, "Bad comparison id.");
  return s;
}
function safeWhich(w) {
  const s = String(w || "").toUpperCase();
  if (s !== "A" && s !== "B") throw httpError(400, "Bad drawing slot.");
  return s;
}

/* ---- small sanitizers ------------------------------------------------ */
const str = (v, max) => String(v == null ? "" : v).slice(0, max);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function int(v, min, max, def) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? clamp(n, min, max) : def;
}
function num(v, min, max, def) {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, min, max) : def;
}

function cleanNote(n) {
  if (!n || typeof n !== "object") return null;
  const x = Number(n.x), y = Number(n.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    id: str(n.id, 40) || crypto.randomBytes(4).toString("hex"),
    x: clamp(x, 0, 1),
    y: clamp(y, 0, 1),
    pa: int(n.pa, 1, 9999, 1),
    pb: int(n.pb, 1, 9999, 1),
    cat: CATS.includes(n.cat) ? n.cat : "Other",
    text: str(n.text, 2000),
    t: num(n.t, 0, 4102444800000, Date.now()),
  };
}

function cleanState(s) {
  s = s && typeof s === "object" ? s : {};
  const v = s.view && typeof s.view === "object" ? s.view : {};
  const p = s.pages && typeof s.pages === "object" ? s.pages : {};
  return {
    title: str(s.title, 140).trim(),
    preparedBy: str(s.preparedBy, 80).trim(),
    notes: (Array.isArray(s.notes) ? s.notes : []).slice(0, MAX_NOTES).map(cleanNote).filter(Boolean),
    view: { mode: v.mode === "overlay" ? "overlay" : "slider", p: num(v.p, 0, 1, 0.5), opacity: num(v.opacity, 0, 1, 1) },
    pages: { A: int(p.A, 1, 9999, 1), B: int(p.B, 1, 9999, 1) },
    savedAt: new Date().toISOString(),
  };
}

function cleanFile(f, which) {
  if (!f || typeof f !== "object") throw httpError(400, `Drawing ${which} is missing.`);
  const name = str(f.name, 200).trim();
  if (!name) throw httpError(400, `Drawing ${which} has no file name.`);
  const size = parseInt(f.size, 10);
  if (!Number.isInteger(size) || size < 1) throw httpError(400, `Drawing ${which} looks empty.`);
  if (size > MAX_FILE_BYTES) {
    throw httpError(413, `"${name}" is ${(size / MB).toFixed(1)} MB. Saved drawings can be up to ${MAX_FILE_BYTES / MB} MB each.`);
  }
  const mime = str(f.mime, 100);
  const kind = /pdf/i.test(mime) || /\.pdf$/i.test(name) ? "pdf" : "image";
  return { name, size, mime, kind, chunks: Math.ceil(size / CHUNK_BYTES) };
}

/* ---- per-person index ------------------------------------------------ */
async function loadIndex(st, u) {
  const idx = await readJSON(st, K.index(u), null);
  return idx && Array.isArray(idx.items) ? idx : { items: [] };
}
const saveIndex = (st, u, idx) => writeJSON(st, K.index(u), idx);
const usedBytes = (idx) => idx.items.reduce((s, e) => s + (e.A?.size || 0) + (e.B?.size || 0), 0);
const limits = () => ({ maxComparisons: MAX_COMPARISONS, maxTotalBytes: MAX_TOTAL_BYTES, maxFileBytes: MAX_FILE_BYTES, chunkBytes: CHUNK_BYTES });

// Finds one entry in the person's index. Because reads can lag a moment behind
// writes, a missing (or not-yet-updated) entry is re-checked a few times.
async function waitEntry(st, u, id, status) {
  let idx, seen = null;
  for (let i = 0; i < 5; i++) {
    idx = await loadIndex(st, u);
    const e = idx.items.find((x) => x.id === id);
    if (e) {
      if (!status || e.status === status) return { idx, e };
      seen = e;
    }
    if (i < 4) await sleep(600);
  }
  if (seen) throw httpError(409, status === "ready" ? "That comparison isn't finished saving." : "That upload is already complete.");
  throw httpError(404, "That saved comparison wasn't found.");
}

// Deletes by explicit key (never by listing), so nothing is missed or left behind.
async function deleteEntryFiles(st, u, e) {
  const list = [K.state(u, e.id)];
  for (const w of ["A", "B"]) {
    const n = (e[w] && e[w].chunks) || 0;
    for (let i = 0; i < n; i++) list.push(K.chunk(u, e.id, w, i));
  }
  for (let i = 0; i < list.length; i += 8) {
    await Promise.all(list.slice(i, i + 8).map((k) => st.delete(k)));
  }
}

// Remove half-finished uploads (closed tab, lost connection) so they don't hold a slot.
async function purgeStale(st, u, idx) {
  const now = Date.now();
  const stale = idx.items.filter((e) => e.status === "uploading" && now - e.started > STALE_MS);
  if (!stale.length) return false;
  for (const e of stale) await deleteEntryFiles(st, u, e);
  idx.items = idx.items.filter((e) => !stale.includes(e));
  return true;
}

async function hasBlob(st, key) {
  if (typeof st.getMetadata === "function") return !!(await st.getMetadata(key));
  return (await st.get(key, { type: "arrayBuffer" })) != null;
}

// Confirms every uploaded piece is there, re-checking missing ones for a few seconds.
async function allPresent(st, u, id, e) {
  let missing = [];
  for (const w of ["A", "B"]) for (let i = 0; i < e[w].chunks; i++) missing.push([w, i]);
  for (let attempt = 0; attempt < 6 && missing.length; attempt++) {
    if (attempt) await sleep(700);
    const still = [];
    for (let i = 0; i < missing.length; i += 8) {
      const batch = missing.slice(i, i + 8);
      const res = await Promise.all(batch.map(([w, n]) => hasBlob(st, K.chunk(u, id, w, n))));
      batch.forEach((m, j) => { if (!res[j]) still.push(m); });
    }
    missing = still;
  }
  return missing.length === 0;
}

/* ---- actions --------------------------------------------------------- */
async function actList(st, u) {
  const idx = await loadIndex(st, u);
  if (await purgeStale(st, u, idx)) await saveIndex(st, u, idx);
  const items = idx.items.filter((e) => e.status === "ready").sort((a, b) => b.updated - a.updated);
  return json(200, { items, slotsUsed: idx.items.length, usedBytes: usedBytes(idx), limits: limits() });
}

async function actGet(st, u, q) {
  const id = safeId(q.id);
  const { e } = await waitEntry(st, u, id, "ready");
  const state = await readJSON(st, K.state(u, id), null);
  return json(200, { item: e, state, chunkBytes: CHUNK_BYTES });
}

async function actFile(st, u, q) {
  const id = safeId(q.id);
  const which = safeWhich(q.which);
  const i = safeIndex(q.chunk == null ? 0 : q.chunk);
  const { e } = await waitEntry(st, u, id, "ready");
  if (i >= e[which].chunks) throw httpError(416, "Chunk out of range.");
  const buf = await st.get(K.chunk(u, id, which, i), { type: "arrayBuffer" });
  if (!buf) throw httpError(404, "Saved drawing data not found.");
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/octet-stream", "Cache-Control": "private, max-age=3600" },
    body: Buffer.from(buf).toString("base64"),
    isBase64Encoded: true,
  };
}

async function actBegin(st, u, b) {
  const A = cleanFile(b.files && b.files.A, "A");
  const B = cleanFile(b.files && b.files.B, "B");
  const idx = await loadIndex(st, u);
  await purgeStale(st, u, idx);
  if (idx.items.length >= MAX_COMPARISONS) {
    throw httpError(409, `You have ${MAX_COMPARISONS} saved comparisons, which is the maximum. Delete one to make room.`);
  }
  if (usedBytes(idx) + A.size + B.size > MAX_TOTAL_BYTES) {
    throw httpError(409, `This would go over your ${MAX_TOTAL_BYTES / MB} MB of saved storage. Delete an older comparison first.`);
  }
  const now = Date.now();
  const id = crypto.randomBytes(8).toString("hex");
  idx.items.push({
    id, status: "uploading", started: now, created: now, updated: now,
    title: str(b.title, 140).trim(), notes: 0, A, B,
  });
  await saveIndex(st, u, idx);
  return json(200, { id, chunkBytes: CHUNK_BYTES, chunksA: A.chunks, chunksB: B.chunks });
}

async function actChunk(st, u, b) {
  const id = safeId(b.id);
  const which = safeWhich(b.which);
  const i = safeIndex(b.index);
  if (!b.dataB64) throw httpError(400, "Empty piece.");
  const { e } = await waitEntry(st, u, id, "uploading");
  const f = e[which];
  if (i >= f.chunks) throw httpError(400, "Piece number out of range.");
  const bytes = Buffer.from(String(b.dataB64), "base64");
  const expected = i < f.chunks - 1 ? CHUNK_BYTES : f.size - CHUNK_BYTES * (f.chunks - 1);
  if (bytes.length !== expected) throw httpError(400, "Piece is the wrong size. Please try saving again.");
  await st.set(K.chunk(u, id, which, i), bytes);
  return json(200, { ok: true, which, index: i });
}

async function actCommit(st, u, b) {
  const id = safeId(b.id);
  const { idx, e } = await waitEntry(st, u, id, "uploading");
  if (!(await allPresent(st, u, id, e))) {
    throw httpError(409, "The drawings didn't finish uploading. Please try saving again.");
  }
  const state = cleanState(b.state);
  await writeJSON(st, K.state(u, id), state);
  e.status = "ready";
  e.updated = Date.now();
  e.title = state.title || e.title || `${e.A.name} vs ${e.B.name}`.slice(0, 140);
  e.notes = state.notes.length;
  delete e.started;
  await saveIndex(st, u, idx);
  return json(200, { item: e });
}

async function actUpdate(st, u, b) {
  const id = safeId(b.id);
  const { idx, e } = await waitEntry(st, u, id, "ready");
  const state = cleanState(b.state);
  await writeJSON(st, K.state(u, id), state);
  e.updated = Date.now();
  e.notes = state.notes.length;
  if (state.title) e.title = state.title;
  await saveIndex(st, u, idx);
  return json(200, { ok: true, updated: e.updated, notes: e.notes });
}

async function actRename(st, u, b) {
  const id = safeId(b.id);
  const title = str(b.title, 140).trim();
  if (!title) throw httpError(400, "Give the comparison a name.");
  const { idx, e } = await waitEntry(st, u, id, "ready");
  e.title = title;
  e.updated = Date.now();
  const state = await readJSON(st, K.state(u, id), null);
  if (state) { state.title = title; await writeJSON(st, K.state(u, id), state); }
  await saveIndex(st, u, idx);
  return json(200, { ok: true, title });
}

// Deleting something that's already gone is fine (it just reports the current totals).
async function actDelete(st, u, b) {
  const id = safeId(b.id);
  let idx = await loadIndex(st, u);
  let e = idx.items.find((x) => x.id === id);
  if (!e) {
    await sleep(500);
    idx = await loadIndex(st, u);
    e = idx.items.find((x) => x.id === id);
  }
  if (e) {
    await deleteEntryFiles(st, u, e);              // files first, so a failure can be retried
    idx.items = idx.items.filter((x) => x.id !== id);
    await saveIndex(st, u, idx);
  }
  return json(200, { ok: true, slotsUsed: idx.items.length, usedBytes: usedBytes(idx) });
}

/* ---- entry point ------------------------------------------------------ */
exports.handler = async (event, context) => {
  try {
    const user = requireUser(context);          // 401 if not signed in
    const u = userKey(user);
    const st = store(event);
    const q = event.queryStringParameters || {};

    if (event.httpMethod === "GET") {
      if (q.action === "list") return await actList(st, u);
      if (q.action === "get") return await actGet(st, u, q);
      if (q.action === "file") return await actFile(st, u, q);
      throw httpError(400, "Unknown action.");
    }

    if (event.httpMethod !== "POST") throw httpError(405, "GET or POST only.");
    let b;
    try { b = JSON.parse(event.body || "{}"); } catch (e) { throw httpError(400, "Bad request body."); }
    switch (b.action) {
      case "begin": return await actBegin(st, u, b);
      case "chunk": return await actChunk(st, u, b);
      case "commit": return await actCommit(st, u, b);
      case "update": return await actUpdate(st, u, b);
      case "rename": return await actRename(st, u, b);
      case "delete": return await actDelete(st, u, b);
      default: throw httpError(400, "Unknown action.");
    }
  } catch (e) { return fail(e); }
};
