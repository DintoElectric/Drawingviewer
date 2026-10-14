import { requireLogin, api, apiBlob } from "./auth.js";
import { fmtDate } from "./ui.js";
import * as colors from "./cmp-colors.js";

/* ------------------------------------------------------------------ *
 *  Sheet viewer: pdf.js canvas rendering, pinch/pan zoom,
 *  revision compare (slider + overlay), and print.
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

const params = new URLSearchParams(location.search);
const projectId = params.get("project");
const sheetId = params.get("sheet");
let entry = null;

$("back").href = `./project.html?project=${encodeURIComponent(projectId)}`;

const viewport = $("viewport");
const stage = $("stage");
const divider = $("divider");
const handle = divider.querySelector(".handle");
const emptyEl = $("empty");
const dlBtn = $("downloadBtn");

// overlay colors (a personal preference kept in this browser)
colors.init();
colors.bindLegend($("legend"));
colors.bindButton($("colorBtn"));

/* ---------- limits (kept conservative for iPad Safari canvas memory) ---------- */
const MIN_Z = 0.4, MAX_Z = 12;
const BASE_MAX_PX = 8e6;     // base bitmap per layer
const DETAIL_MAX_PX = 9e6;   // sharp "detail" bitmap per layer when zoomed in
const dpr = () => Math.min(window.devicePixelRatio || 1, 3);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------- state ---------- */
const S = { z: 1, tx: 0, ty: 0, vw: 800, vh: 600, W0: 800, H0: 600, fit: true };
const view = {
  revB: null, revA: null,        // B = revision being viewed, A = revision compared against
  docB: null, docA: null,
  pageNum: 1, numPages: 1,
  cmp: false, mode: "slider", p: 0.5, opacity: 1,
};

/* ---------- layers (wrapper div > canvas + tint) ---------- */
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
           dens: 1, baseTask: null, detailTask: null, gen: 0, dgen: 0 };
}
const LB = makeLayer($("cvB"), "layer-b", "tint-b");
const LA = makeLayer($("cvA"), "layer-a", "tint-a");
LA.el.classList.add("hidden");
stage.classList.add("hidden");

function cancel(t) { try { t && t.cancel(); } catch (e) { /* ignore */ } }

/* ---------- loading PDFs (chunked, as before) ---------- */
const docCache = new Map(); // rev -> Promise<{pdf,url,rev}>

function loadDoc(rev) {
  if (!docCache.has(rev)) {
    const p = fetchDoc(rev).catch((e) => { docCache.delete(rev); throw e; });
    docCache.set(rev, p);
  }
  return docCache.get(rev);
}

async function fetchDoc(rev) {
  const archive = rev === entry.currentRev ? "0" : "1";
  const base = `get-drawing?project=${encodeURIComponent(projectId)}&sheet=${encodeURIComponent(sheetId)}&rev=${rev}&archive=${archive}`;
  // large sheets come back in pieces; stitch them into one PDF blob
  const meta = await api(`${base}&meta=1`);
  const parts = [];
  for (let i = 0; i < meta.chunks; i++) parts.push(await apiBlob(`${base}&chunk=${i}`));
  const blob = new Blob(parts, { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const buf = await blob.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  return { pdf, url, rev };
}

function trimCache() {
  if (docCache.size <= 3) return;
  for (const [rev, p] of docCache) {
    if (docCache.size <= 3) break;
    if (rev === view.revA || rev === view.revB) continue;
    docCache.delete(rev);
    p.then((d) => { try { d.pdf.destroy(); } catch (e) {} URL.revokeObjectURL(d.url); }).catch(() => {});
  }
}

/* ---------- revision helpers ---------- */
function revList() {
  const set = new Set((entry.history || []).map((r) => r.rev));
  set.add(entry.currentRev);
  return [...set].sort((a, b) => b - a);
}
function revDate(rev) {
  const h = (entry.history || []).find((r) => r.rev === rev);
  return h?.date || (rev === entry.currentRev ? entry.issuedDate : null);
}
function defaultCompareRev(b) {
  const revs = revList();
  const lower = revs.filter((r) => r < b)[0];
  if (lower != null) return lower;
  const higher = revs.filter((r) => r > b).pop();
  return higher ?? null;
}

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
  if (!view.cmp || view.mode !== "slider") return;
  handle.style.top = clamp((S.vh / 2 - S.ty) / S.z, 0, S.H0) + "px";
}
function zoomAt(z2, cx, cy) {
  z2 = clamp(z2, MIN_Z, MAX_Z);
  const px = (cx - S.tx) / S.z, py = (cy - S.ty) / S.z;
  S.z = z2; S.tx = cx - px * z2; S.ty = cy - py * z2;
  S.fit = false;
  clampT(); applyTransform();
}
function fitView() { S.z = 1; S.fit = true; clampT(); applyTransform(); }
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

async function setLayer(L, pdf, pageNum) {
  L.page = await pdf.getPage(clamp(pageNum, 1, pdf.numPages));
  const vp = L.page.getViewport({ scale: 1 });
  L.pw = vp.width; L.ph = vp.height;
}

function clearDetail(L) {
  L.dgen++; cancel(L.detailTask); L.detailTask = null;
  if (L.detail) { L.detail.remove(); L.detail = null; }
}

async function renderBase(L) {
  if (!L.page) return;
  const my = ++L.gen;
  cancel(L.baseTask); L.baseTask = null;
  clearDetail(L);
  const b = boxFor(L); L.box = b;
  let dens = Math.min(dpr() * 1.5, Math.sqrt(BASE_MAX_PX / (b.w * b.h)));
  dens = Math.max(dens, 0.5);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(b.w * dens));
  c.height = Math.max(1, Math.round(b.h * dens));
  c.style.left = b.x + "px"; c.style.top = b.y + "px";
  c.style.width = b.w + "px"; c.style.height = b.h + "px";
  L.dens = c.width / b.w;
  const task = renderFit(L.page, c);
  L.baseTask = task;
  try { await task.promise; }
  catch (e) { if (my !== L.gen || e?.name === "RenderingCancelledException") return; throw e; }
  if (my !== L.gen) return;
  L.baseTask = null;
  L.el.replaceChild(c, L.canvas);   // swap in only when finished, so there's no blank flash
  L.canvas = c;
}

let detailTimer = null;
function scheduleDetail(delay = 170) {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(() => {
    renderDetail(LB);
    if (view.cmp) renderDetail(LA);
  }, delay);
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
  catch (e) { if (my !== L.dgen || e?.name === "RenderingCancelledException") return; return; }
  if (my !== L.dgen) return;
  L.detailTask = null;
  L.el.insertBefore(d, L.tint);
  if (L.detail) L.detail.remove();
  L.detail = d;
}

/* ---------- mounting docs into the viewer ---------- */
let mountSeq = 0;
async function mountDocs(dB, dA, keep) {
  const my = ++mountSeq;
  view.docB = dB; view.docA = dA;
  view.numPages = dB.pdf.numPages;
  view.pageNum = clamp(view.pageNum, 1, view.numPages);
  await setLayer(LB, dB.pdf, view.pageNum);
  if (dA) await setLayer(LA, dA.pdf, view.pageNum);
  else { LA.page = null; cancel(LA.baseTask); clearDetail(LA); }
  if (my !== mountSeq) return;

  const first = stage.classList.contains("hidden");
  const oW = S.W0, oH = S.H0;
  measure(); computeStage();
  if (!keep || first || Math.abs(oW - S.W0) > 1 || Math.abs(oH - S.H0) > 1) fitView();
  else { clampT(); applyTransform(); }

  stage.classList.remove("hidden");
  emptyEl.classList.add("hidden");
  syncChrome();
  await Promise.all([renderBase(LB), dA ? renderBase(LA) : null]);
  if (my !== mountSeq) return;
  scheduleDetail(60);
  trimCache();
}

/* ---------- UI sync ---------- */
function syncChrome() {
  dlBtn.href = view.docB.url;
  dlBtn.setAttribute("download", `${sheetId}_Rev${view.revB}.pdf`);
  dlBtn.classList.remove("hidden");
  $("pageGroup").classList.toggle("hidden", view.numPages < 2);
  $("pageInd").textContent = `${view.pageNum} / ${view.numPages}`;
  $("pagePrev").disabled = view.pageNum <= 1;
  $("pageNext").disabled = view.pageNum >= view.numPages;
  syncCompareUI();
}

function syncCompareUI() {
  const on = view.cmp;
  const few = revList().length < 2;
  const cmpBtn = $("cmpBtn");
  cmpBtn.disabled = few;
  cmpBtn.title = few ? "Only one revision is on file for this sheet" : "Compare two revisions";
  cmpBtn.setAttribute("aria-pressed", String(on));
  cmpBtn.classList.toggle("on", on);
  $("cmpGroup").classList.toggle("hidden", !on);
  $("lblA").classList.toggle("hidden", !on);
  $("lblB").classList.toggle("hidden", !on);
  $("modeSlider").classList.toggle("on", view.mode === "slider");
  $("modeOverlay").classList.toggle("on", view.mode === "overlay");
  const ov = on && view.mode === "overlay";
  $("opacityWrap").classList.toggle("hidden", !ov);
  $("colorBtn").classList.toggle("hidden", !ov);
  $("legend").classList.toggle("hidden", !ov);
  if (on && view.revA != null && view.revB != null) {
    const sel = $("cmpSelect");
    sel.innerHTML = revList().filter((r) => r !== view.revB)
      .map((r) => `<option value="${r}">Rev ${r}${r === entry.currentRev ? " · current" : ""}</option>`).join("");
    sel.value = String(view.revA);
    $("lblA").textContent = `Rev ${view.revA}`;
    $("lblB").textContent = `Rev ${view.revB}`;
    const aOlder = view.revA < view.revB;
    colors.setLabels({ a: `Rev ${view.revA}`, b: `Rev ${view.revB}` });
    $("legend").innerHTML =
      `<span>${colors.swatchBtn("a")}<b>Rev ${view.revA}</b> only${aOlder ? " (removed)" : " (added)"}</span>` +
      `<span>${colors.swatchBtn("b")}<b>Rev ${view.revB}</b> only${aOlder ? " (added)" : " (removed)"}</span>` +
      `<span><i class="sw sw-k"></i>Unchanged</span>`;
  }
  applyMode();
}

function applyMode() {
  const on = view.cmp;
  stage.classList.toggle("cmp-on", on);
  stage.classList.toggle("mode-slider", on && view.mode === "slider");
  stage.classList.toggle("mode-overlay", on && view.mode === "overlay");
  LA.el.classList.toggle("hidden", !on);
  divider.classList.toggle("hidden", !(on && view.mode === "slider"));
  if (on && view.mode === "slider") applySlider();
  else { LA.el.style.clipPath = ""; LA.el.style.webkitClipPath = ""; }
  LA.el.style.opacity = on && view.mode === "overlay" ? String(view.opacity) : "";
}

function applySlider() {
  const pct = view.p * 100;
  divider.style.left = pct + "%";
  const clip = `inset(0 ${100 - pct}% 0 0)`;
  LA.el.style.clipPath = clip; LA.el.style.webkitClipPath = clip;
  positionHandle();
}

function flash(title, body) {
  const t = document.createElement("div");
  t.className = "toast err";
  t.innerHTML = `<div><div class="t-title">${esc(title)}</div>${body ? `<div class="t-body">${esc(body)}</div>` : ""}</div>`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

/* ---------- showing a revision ---------- */
let token = 0;
async function showRev(rev) {
  const my = ++token;
  view.revB = rev;
  if (view.cmp && (view.revA == null || view.revA === rev)) view.revA = defaultCompareRev(rev);
  $("revpick").innerHTML =
    `Rev ${rev}${rev === entry.currentRev ? " · current" : ""} <i class="ph ph-caret-down" style="font-size:12px"></i>`;
  emptyEl.classList.remove("hidden");
  emptyEl.innerHTML = `<div class="loading-pill">Loading…</div>`;
  try {
    const dB = await loadDoc(rev);
    if (my !== token) return;
    let dA = null;
    if (view.cmp && view.revA != null) {
      try { dA = await loadDoc(view.revA); }
      catch (e) { flash("Couldn't load Rev " + view.revA, e.message); view.cmp = false; }
      if (my !== token) return;
    }
    await mountDocs(dB, dA, true);
  } catch (e) {
    if (my !== token) return;
    view.docB = null;
    stage.classList.add("hidden");
    emptyEl.classList.remove("hidden");
    emptyEl.innerHTML = `<div>Couldn't load this revision.<br><span class="muted">${esc(e.message)}</span></div>`;
    dlBtn.classList.add("hidden");
  }
  renderRevs(rev);
}

function renderRevs(activeRev) {
  const revs = (entry.history || []).slice().sort((a, b) => b.rev - a.rev);
  if (!revs.find((r) => r.rev === entry.currentRev)) revs.unshift({ rev: entry.currentRev, date: entry.issuedDate, reason: entry.note || "" });
  $("revs").innerHTML = revs.map((r) => `
    <div class="hrev ${r.rev === activeRev ? "cur" : ""}" data-rev="${r.rev}">
      <div class="hr-top"><span class="hr-rev">Rev ${r.rev}</span>${r.rev === entry.currentRev ? `<span class="tag tag-outline" style="font-size:10px;padding:2px 8px">Issued</span>` : ""}${view.cmp && r.rev === view.revA ? `<span class="tag tag-outline" style="font-size:10px;padding:2px 8px">Compare</span>` : ""}</div>
      <div class="hr-meta">${fmtDate(r.date)}</div>
      ${r.reason ? `<div class="hr-reason">${r.reason}</div>` : ""}
    </div>`).join("");
  document.querySelectorAll(".hrev").forEach((el) => el.addEventListener("click", () => showRev(parseInt(el.dataset.rev, 10))));
}

/* ---------- compare controls ---------- */
async function setCompare(on) {
  if (!view.docB) return;
  if (on) {
    if (revList().length < 2) { flash("Only one revision on file"); return; }
    if (view.revA == null || view.revA === view.revB) view.revA = defaultCompareRev(view.revB);
    try {
      const dA = await loadDoc(view.revA);
      view.cmp = true;
      await mountDocs(view.docB, dA, true);
    } catch (e) { view.cmp = false; flash("Couldn't load Rev " + view.revA, e.message); }
  } else {
    view.cmp = false;
    await mountDocs(view.docB, null, true);
  }
  syncCompareUI();
  renderRevs(view.revB);
}

$("cmpBtn").addEventListener("click", () => setCompare(!view.cmp));

$("cmpSelect").addEventListener("change", async (e) => {
  const r = parseInt(e.target.value, 10);
  try {
    const dA = await loadDoc(r);
    view.revA = r;
    await mountDocs(view.docB, dA, true);
  } catch (err) { flash("Couldn't load Rev " + r, err.message); e.target.value = String(view.revA); }
  syncCompareUI(); renderRevs(view.revB);
});

$("modeSlider").addEventListener("click", () => { view.mode = "slider"; syncCompareUI(); });
$("modeOverlay").addEventListener("click", () => { view.mode = "overlay"; syncCompareUI(); });
$("opacity").addEventListener("input", (e) => {
  view.opacity = parseInt(e.target.value, 10) / 100;
  LA.el.style.opacity = String(view.opacity);
});

/* ---------- page nav + zoom buttons ---------- */
async function gotoPage(n) {
  n = clamp(n, 1, view.numPages);
  if (n === view.pageNum || !view.docB) return;
  view.pageNum = n;
  await mountDocs(view.docB, view.docA, true);
}
$("pagePrev").addEventListener("click", () => gotoPage(view.pageNum - 1));
$("pageNext").addEventListener("click", () => gotoPage(view.pageNum + 1));

$("zoomIn").addEventListener("click", () => { withAnim(() => zoomAt(S.z * 1.4, S.vw / 2, S.vh / 2)); scheduleDetail(260); });
$("zoomOut").addEventListener("click", () => { withAnim(() => zoomAt(S.z / 1.4, S.vw / 2, S.vh / 2)); scheduleDetail(260); });
$("fitBtn").addEventListener("click", () => { withAnim(fitView); scheduleDetail(260); });
$("zoomLevel").title = "Fit to screen";
$("zoomLevel").addEventListener("click", () => { withAnim(fitView); scheduleDetail(260); });

document.addEventListener("keydown", (e) => {
  if (e.target.matches && e.target.matches("input,select,textarea")) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") { e.preventDefault(); doPrint(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "+" || e.key === "=") { withAnim(() => zoomAt(S.z * 1.25, S.vw / 2, S.vh / 2)); scheduleDetail(260); }
  else if (e.key === "-") { withAnim(() => zoomAt(S.z / 1.25, S.vw / 2, S.vh / 2)); scheduleDetail(260); }
  else if (e.key === "0") { withAnim(fitView); scheduleDetail(260); }
});

/* ---------- slider divider drag ---------- */
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
  divider.addEventListener(t, () => { draggingDivider = false; }));

/* ---------- pinch / pan / double-tap ---------- */
const ptrs = new Map();   // pointerId -> {x,y} in viewport coords
let g = null;             // current gesture
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
function handleTap(x, y) {
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
  if (draggingDivider) return;
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
    S.fit = false;
    clampT(); applyTransform();
  }
});

function endPointer(e) {
  if (!ptrs.has(e.pointerId)) return;
  const was = ptrs.size;
  ptrs.delete(e.pointerId);
  if (g && g.type === "pan" && was === 1) {
    const dt = performance.now() - g.t0;
    if (!g.multi && g.moved < 8 && dt < 400 && e.type === "pointerup") handleTap(g.sx, g.sy);
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

// desktop: Ctrl/Cmd + wheel (and trackpad pinch) zooms, plain wheel pans
viewport.addEventListener("wheel", (e) => {
  e.preventDefault();
  const { x, y } = relPos(e);
  const mul = e.deltaMode === 1 ? 16 : 1;
  const dx = e.deltaX * mul, dy = e.deltaY * mul;
  if (e.ctrlKey || e.metaKey) zoomAt(S.z * Math.exp(-clamp(dy, -30, 30) * 0.01), x, y);
  else { S.tx -= dx; S.ty -= dy; clampT(); applyTransform(); }
  scheduleDetail();
}, { passive: false });

// Safari (macOS trackpad pinch). Ignored while touch pointers are down so iPad doesn't double-zoom.
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

/* ---------- keep layout right on resize / iPad rotation ---------- */
let resizeTimer = null;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(onResize, 120); }).observe(viewport);
async function onResize() {
  if (!view.docB) return;
  const ow = S.vw, oh = S.vh;
  const r = viewport.getBoundingClientRect();
  if (Math.abs(ow - r.width) < 1 && Math.abs(oh - r.height) < 1) return;
  await mountDocs(view.docB, view.docA, false);   // re-fit to the new size
}

/* ---------- print ---------- */
let printUrl = null;

function tintCanvas(c, color) {
  const x = c.getContext("2d");
  x.globalCompositeOperation = "lighten";
  x.fillStyle = color;
  x.fillRect(0, 0, c.width, c.height);
  x.globalCompositeOperation = "source-over";
}

async function buildPrintCanvas() {
  const maxPx = view.cmp ? 10e6 : 14e6;
  let s = Math.min(Math.sqrt(maxPx / (LB.pw * LB.ph)), 4.2);       // ~300 dpi ceiling
  s = Math.min(s, 7000 / Math.max(LB.pw, LB.ph));
  const W = Math.max(1, Math.round(LB.pw * s)), H = Math.max(1, Math.round(LB.ph * s));
  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  await renderFit(LB.page, out).promise;
  if (!view.cmp || !LA.page) return out;

  const tmp = document.createElement("canvas");
  tmp.width = W; tmp.height = H;
  await renderFit(LA.page, tmp).promise;
  if (view.mode === "overlay") {
    const col = colors.get();
    tintCanvas(out, col.b);
    tintCanvas(tmp, col.a);
    ctx.globalCompositeOperation = "multiply";
    ctx.globalAlpha = view.opacity;
    ctx.drawImage(tmp, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
  } else {
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W * view.p, H); ctx.clip();
    ctx.drawImage(tmp, 0, 0);
    ctx.restore();
    const lw = Math.max(3, W / 900);
    ctx.fillStyle = "#7c6ff0";
    ctx.fillRect(W * view.p - lw / 2, 0, lw, H);
  }
  tmp.width = tmp.height = 0;
  return out;
}

async function doPrint() {
  if (!view.docB || !LB.page) return;
  const btn = $("printBtn");
  const label = btn.querySelector("span");
  const prev = label ? label.textContent : "";
  btn.disabled = true;
  if (label) label.textContent = "Preparing…";
  try {
    const canvas = await buildPrintCanvas();
    const landscape = canvas.width >= canvas.height;
    const blob = await new Promise((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error("Couldn't build the print image"))), "image/png"));
    canvas.width = canvas.height = 0;

    // header: sheet, revision, and a warning if it's not the current issue
    const printed = new Date().toLocaleDateString();
    const dateOf = (r) => { const d = revDate(r); return d ? fmtDate(d) : "—"; };
    let sub, warn = "";
    if (view.cmp) {
      const detail = view.mode === "overlay"
        ? colors.overlayText(`Rev ${view.revA}`, `Rev ${view.revB}`)
        : `Slider compare: Rev ${view.revA} (left) vs Rev ${view.revB} (right)`;
      sub = `${detail} · Printed ${printed}`;
      warn = "Comparison print — not an issued drawing";
    } else {
      sub = `Rev ${view.revB} · Issued ${dateOf(view.revB)} · Printed ${printed}`;
      if (view.revB !== entry.currentRev) warn = `SUPERSEDED — current revision is Rev ${entry.currentRev}`;
    }
    $("printHead").innerHTML =
      `<div class="ph-title"><b>${esc(sheetId)}</b>${entry.title ? " — " + esc(entry.title) : ""}</div>` +
      `<div class="ph-sub">${esc(sub)}</div>` +
      (warn ? `<div class="ph-warn">${esc(warn)}</div>` : "");

    let st = $("pageStyle");
    if (!st) { st = document.createElement("style"); st.id = "pageStyle"; document.head.appendChild(st); }
    st.textContent = `@page { size: ${landscape ? "landscape" : "portrait"}; margin: 8mm; }`;

    if (printUrl) URL.revokeObjectURL(printUrl);
    printUrl = URL.createObjectURL(blob);
    const img = $("printImg");
    img.src = printUrl;
    try { await img.decode(); } catch (e) { /* print anyway */ }
    window.print();
  } catch (e) {
    flash("Couldn't prepare the print", e.message);
  } finally {
    btn.disabled = false;
    if (label) label.textContent = prev;
  }
}
$("printBtn").addEventListener("click", doPrint);
window.addEventListener("afterprint", () => {
  setTimeout(() => {
    if (printUrl) { URL.revokeObjectURL(printUrl); printUrl = null; }
    $("printImg").removeAttribute("src");
  }, 1500);
});

/* ---------- boot ---------- */
async function main() {
  if (!projectId || !sheetId) { location.href = "./index.html"; return; }
  let manifest;
  try { manifest = await api(`get-manifest?project=${encodeURIComponent(projectId)}`); }
  catch (e) { $("snum").textContent = sheetId; return; }
  entry = manifest.drawings?.[sheetId];
  $("snum").textContent = sheetId;
  if (!entry) { emptyEl.classList.remove("hidden"); emptyEl.textContent = "Sheet not found."; return; }
  $("stitle").textContent = entry.title || "";
  if (!pdfjsLib) {
    emptyEl.classList.remove("hidden");
    emptyEl.innerHTML = `<div>The PDF viewer library didn't load.<br><span class="muted">Check your connection and reload.</span></div>`;
    return;
  }
  syncCompareUI();
  showRev(entry.currentRev);
}

requireLogin(main);
