import { requireLogin, api } from "./auth.js";
import { mountTopbarUser, toast } from "./ui.js";
import { itemsFromArrayBuffer, thumbnailFromArrayBuffer } from "./pdf-browser.js";
import { pickSheetNumber, pickTitle, matchAndPlan } from "./extract-core.js";

const projectId = new URLSearchParams(location.search).get("project");
let manifest = null;
const items = [];
let nextId = 1;

// same character rule the server enforces (safeSheet), so we never send a value
// that would 400 on publish.
const SHEET_RE = /^[A-Z0-9][A-Z0-9.\-]{0,31}$/;

const backHref = `./project.html?project=${encodeURIComponent(projectId)}`;
document.getElementById("closeBtn").href = backHref;
document.getElementById("cancelBtn").href = backHref;

function b64(buf) {
  let bin = ""; const bytes = new Uint8Array(buf); const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

// Best-effort sheet number from the file name, for scans the reader can't read.
// e.g. "Yale_OML-BRANCH-E35_02A[2].pdf" -> "E35-02A"
function guessSheetFromName(name) {
  let s = String(name || "").replace(/\.pdf$/i, "").replace(/\[[^\]]*\]$/, "").trim();
  s = s.replace(/[_\s]+/g, "-");
  const m = s.match(/([A-Za-z]{1,3}-?\d[\w.]*(?:-[\w.]+)*)$/);
  const guess = (m ? m[1] : "").toUpperCase().replace(/-+/g, "-");
  return SHEET_RE.test(guess) ? guess : "";
}

async function readFile(file) {
  const buf = await file.arrayBuffer();
  let detected = null, autoTitle = null;
  try {
    const { items: tItems } = await itemsFromArrayBuffer(buf);
    const sn = pickSheetNumber(tItems);
    detected = sn.sheet;
    autoTitle = pickTitle(tItems, sn.sheet);
  } catch {}
  const manualSheet = detected || guessSheetFromName(file.name) || "";
  let thumb = null; try { thumb = await thumbnailFromArrayBuffer(buf); } catch {}
  return {
    id: nextId++, filename: file.name, base64: b64(buf), thumb,
    detected, autoTitle, manualSheet,
  };
}

// The plan a row will publish with, driven by the sheet-number box.
function effectivePlan(row) {
  const manual = (row.manualSheet || "").trim().toUpperCase();
  if (!manual) return { status: "empty", sheet: null };
  if (!SHEET_RE.test(manual)) return { status: "bad-sheet", sheet: manual };
  return matchAndPlan({ sheet: manual, confidence: 1, printedRev: null, title: row.autoTitle || null, sourceFilename: row.filename }, manifest);
}

function planLine(row, p) {
  if (p.status === "supersede")
    return `<span class="tag tag-accent" style="font-size:10px;padding:2px 8px"><i class="ph-fill ph-arrow-circle-up"></i>Rev ${p.newRev} supersedes Rev ${p.supersedes}</span>`;
  if (p.status === "new")
    return `<span class="tag tag-neutral" style="font-size:10px;padding:2px 8px">New sheet · Rev ${p.newRev}</span>${row.detected ? ` <span class="conf">read from title block</span>` : row.manualSheet ? ` <span class="conf">from file name</span>` : ""}`;
  if (p.status === "bad-sheet")
    return `<span style="color:var(--color-accent-200)">Letters, numbers, dots and dashes only</span>`;
  return `<span style="color:var(--color-accent-200)"><i class="ph ph-arrow-left" style="font-size:12px"></i> Enter a sheet number</span>`;
}

function statusIcon(p) {
  const ok = p.status === "new" || p.status === "supersede";
  return ok ? `<i class="ph-fill ph-check-circle ok"></i>` : `<i class="ph ph-warning-circle" style="font-size:19px;color:var(--color-accent-400)"></i>`;
}

function rowHtml(row) {
  const p = effectivePlan(row);
  const needs = !(p.status === "new" || p.status === "supersede");
  return `<div class="matchrow ${needs ? "needs" : ""}" data-row="${row.id}">
    ${row.thumb ? `<img class="thumb" src="${row.thumb}" alt="">` : `<i class="ph-fill ph-file-pdf" style="font-size:21px;color:var(--color-neutral-500)"></i>`}
    <div class="mr-main">
      <div class="mr-file" title="${row.filename}">${row.filename}</div>
      <div class="mr-plan">${planLine(row, p)}</div>
    </div>
    <div class="mr-right">
      <input class="input sheet-input" data-sheet="${row.id}" list="sheetlist" placeholder="Sheet #"
             autocapitalize="characters" spellcheck="false"
             value="${row.manualSheet.replace(/"/g, "&quot;")}" style="width:130px;text-transform:uppercase">
      <span class="mr-status">${statusIcon(p)}</span>
    </div>
  </div>`;
}

function renderRows() {
  const wrap = document.getElementById("rows");
  wrap.innerHTML = items.map(rowHtml).join("");
  wrap.querySelectorAll("input[data-sheet]").forEach((inp) =>
    inp.addEventListener("input", () => updateRow(+inp.dataset.sheet, inp)));
  updatePublish();
}

// Patch only the changed row so typing never loses focus.
function updateRow(id, inp) {
  const row = items.find((r) => r.id === id);
  if (!row) return;
  row.manualSheet = inp.value;
  const el = document.querySelector(`[data-row="${id}"]`);
  const p = effectivePlan(row);
  const needs = !(p.status === "new" || p.status === "supersede");
  el.classList.toggle("needs", needs);
  el.querySelector(".mr-plan").innerHTML = planLine(row, p);
  el.querySelector(".mr-status").innerHTML = statusIcon(p);
  updatePublish();
}

function unresolved() {
  return items.filter((row) => { const s = effectivePlan(row).status; return s !== "new" && s !== "supersede"; });
}

function updatePublish() {
  const btn = document.getElementById("publishBtn"), hint = document.getElementById("publishHint"), label = document.getElementById("publishLabel");
  const bad = unresolved().length, n = items.length;
  label.textContent = n ? `Publish ${n} revision${n > 1 ? "s" : ""}` : "Publish revisions";
  if (!n) { btn.disabled = true; hint.textContent = ""; return; }
  if (bad) { btn.disabled = true; hint.textContent = `${bad} file${bad > 1 ? "s" : ""} still need${bad > 1 ? "" : "s"} a sheet number.`; }
  else {
    const sup = items.filter((r) => effectivePlan(r).status === "supersede").length;
    btn.disabled = false;
    hint.textContent = sup ? `Ready — ${sup} supersede an existing sheet.` : `Ready to publish ${n}.`;
  }
}

async function ingestFiles(fileList) {
  const pdfs = [...fileList].filter((f) => /\.pdf$/i.test(f.name));
  if (!pdfs.length) return;
  document.getElementById("dzTitle").textContent = `Reading ${pdfs.length} file${pdfs.length > 1 ? "s" : ""}…`;
  for (const f of pdfs) {
    try { items.push(await readFile(f)); }
    catch { items.push({ id: nextId++, filename: f.name, base64: null, thumb: null, detected: null, autoTitle: null, manualSheet: guessSheetFromName(f.name) }); }
    renderRows();
  }
  const prefilled = items.filter((r) => (r.manualSheet || "").trim()).length;
  document.getElementById("dzTitle").textContent = `${items.length} file${items.length > 1 ? "s" : ""} added`;
  document.getElementById("dzSub").textContent = prefilled
    ? `${prefilled} got a sheet number automatically — confirm each one, fix any blanks, then publish.`
    : `Type the sheet number for each, then publish.`;
}

async function publish() {
  const btn = document.getElementById("publishBtn");
  btn.disabled = true; document.getElementById("publishLabel").textContent = "Publishing…";
  const payload = {
    project: projectId,
    reason: document.getElementById("reason").value,
    issueDate: document.getElementById("issueDate").value || null,
    note: document.getElementById("note").value || null,
    files: items.map((row) => {
      const p = effectivePlan(row);
      return { sheet: p.sheet, newRev: p.newRev, status: p.status, title: row.autoTitle || null, base64: row.base64 };
    }),
  };
  try {
    const out = await api("publish-revisions", { method: "POST", body: payload });
    toast("Published", `${out.published.length} revision${out.published.length > 1 ? "s" : ""} saved.`, false);
    setTimeout(() => (location.href = backHref), 1200);
  } catch (e) {
    toast("Couldn't publish", e.message, true);
    document.getElementById("publishLabel").textContent = `Publish ${items.length} revisions`;
    btn.disabled = false;
  }
}

async function main() {
  if (!projectId) { location.href = "./index.html"; return; }
  const { admin } = await mountTopbarUser();
  if (!admin) {
    document.querySelector(".modal").innerHTML = `<div class="m-head"><div class="m-title">Admin only</div></div><div class="m-body" style="padding:0 20px 24px"><p class="muted" style="font-size:14px">Only the admin can add revisions. <a href="${backHref}">Back to the project</a>.</p></div>`;
    return;
  }
  manifest = await api(`get-manifest?project=${encodeURIComponent(projectId)}`);
  // datalist of existing sheet numbers, so superseding is a pick-or-type
  const existing = Object.keys(manifest.drawings || {}).sort();
  document.getElementById("sheetlist").innerHTML = existing.map((s) => `<option value="${s}">`).join("");
  document.getElementById("projSub").textContent = `${manifest.project?.name || projectId} — type or confirm the sheet number on each file`;
  document.getElementById("issueDate").valueAsDate = new Date();

  document.getElementById("fileInput").addEventListener("change", (e) => ingestFiles(e.target.files));
  const dz = document.getElementById("dropzone");
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => ingestFiles(e.dataTransfer.files));
  document.getElementById("publishBtn").addEventListener("click", publish);
}

requireLogin(main);
