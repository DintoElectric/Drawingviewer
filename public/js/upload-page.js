import { requireLogin, api } from "./auth.js";
import { mountTopbarUser, toast } from "./ui.js";
import { itemsFromArrayBuffer, thumbnailFromArrayBuffer } from "./pdf-browser.js";
import { pickSheetNumber, pickTitle, matchAndPlan } from "./extract-core.js";

const projectId = new URLSearchParams(location.search).get("project");
let manifest = null;
const items = [];
let nextId = 1;

const SHEET_RE = /^[A-Z0-9][A-Z0-9.\-]{0,31}$/;
const CHUNK = 3 * 1024 * 1024; // 3 MB raw per chunk (~4 MB as base64, under the 6 MB request limit)

const backHref = `./project.html?project=${encodeURIComponent(projectId)}`;
document.getElementById("closeBtn").href = backHref;
document.getElementById("cancelBtn").href = backHref;

// base64-encode a Uint8Array (or a subarray view of one)
function b64(bytes) {
  let bin = ""; const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  return btoa(bin);
}

function newUploadId() {
  const raw = (crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return raw.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 40);
}

function guessSheetFromName(name) {
  let s = String(name || "").replace(/\.pdf$/i, "").replace(/\[[^\]]*\]$/, "").trim();
  s = s.replace(/[_\s]+/g, "-");
  const m = s.match(/([A-Za-z]{1,3}-?\d[\w.]*(?:-[\w.]+)*)$/);
  const guess = (m ? m[1] : "").toUpperCase().replace(/-+/g, "-");
  return SHEET_RE.test(guess) ? guess : "";
}

async function readFile(file) {
  const buf = await file.arrayBuffer();
  let detected = null, autoTitle = null, thumb = null;
  try {
    const { items: tItems } = await itemsFromArrayBuffer(buf.slice(0)); // copy — reader detaches its buffer
    const sn = pickSheetNumber(tItems);
    detected = sn.sheet;
    autoTitle = pickTitle(tItems, sn.sheet);
  } catch {}
  try { thumb = await thumbnailFromArrayBuffer(buf.slice(0)); } catch {}
  // keep the File itself; the bytes are re-read at publish time and streamed up in chunks
  return {
    id: nextId++, filename: file.name, file, thumb,
    detected, autoTitle, manualSheet: detected || guessSheetFromName(file.name) || "",
    readOk: file.size > 0,
  };
}

function effectivePlan(row) {
  const manual = (row.manualSheet || "").trim().toUpperCase();
  if (!manual) return { status: "empty", sheet: null };
  if (!SHEET_RE.test(manual)) return { status: "bad-sheet", sheet: manual };
  return matchAndPlan({ sheet: manual, confidence: 1, printedRev: null, title: row.autoTitle || null, sourceFilename: row.filename }, manifest);
}

function planLine(row, p) {
  if (!row.readOk)
    return `<span style="color:var(--color-accent-200)">Couldn't read this file — remove it and add it again</span>`;
  if (p.status === "supersede")
    return `<span class="tag tag-accent" style="font-size:10px;padding:2px 8px"><i class="ph-fill ph-arrow-circle-up"></i>Rev ${p.newRev} supersedes Rev ${p.supersedes}</span>`;
  if (p.status === "new")
    return `<span class="tag tag-neutral" style="font-size:10px;padding:2px 8px">New sheet · Rev ${p.newRev}</span>${row.detected ? ` <span class="conf">read from title block</span>` : row.manualSheet ? ` <span class="conf">from file name</span>` : ""}`;
  if (p.status === "bad-sheet")
    return `<span style="color:var(--color-accent-200)">Letters, numbers, dots and dashes only</span>`;
  return `<span style="color:var(--color-accent-200)"><i class="ph ph-arrow-left" style="font-size:12px"></i> Enter a sheet number</span>`;
}

function rowResolved(row) {
  if (!row.readOk) return false;
  const s = effectivePlan(row).status;
  return s === "new" || s === "supersede";
}

function statusIcon(row) {
  return rowResolved(row) ? `<i class="ph-fill ph-check-circle ok"></i>` : `<i class="ph ph-warning-circle" style="font-size:19px;color:var(--color-accent-400)"></i>`;
}

function rowHtml(row) {
  const p = effectivePlan(row);
  const needs = !rowResolved(row);
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
      <span class="mr-status">${statusIcon(row)}</span>
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

function updateRow(id, inp) {
  const row = items.find((r) => r.id === id);
  if (!row) return;
  row.manualSheet = inp.value;
  const el = document.querySelector(`[data-row="${id}"]`);
  const p = effectivePlan(row);
  el.classList.toggle("needs", !rowResolved(row));
  el.querySelector(".mr-plan").innerHTML = planLine(row, p);
  el.querySelector(".mr-status").innerHTML = statusIcon(row);
  updatePublish();
}

function unresolved() { return items.filter((row) => !rowResolved(row)); }

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
    catch { items.push({ id: nextId++, filename: f.name, file: null, thumb: null, detected: null, autoTitle: null, manualSheet: guessSheetFromName(f.name), readOk: false }); }
    renderRows();
  }
  const prefilled = items.filter((r) => (r.manualSheet || "").trim()).length;
  document.getElementById("dzTitle").textContent = `${items.length} file${items.length > 1 ? "s" : ""} added`;
  document.getElementById("dzSub").textContent = prefilled
    ? `${prefilled} got a sheet number automatically — confirm each one, fix any blanks, then publish.`
    : `Type the sheet number for each, then publish.`;
}

// upload one file's bytes to Blobs in chunks, then return its uploadId + count
async function uploadInChunks(row, label, fileNo, fileCount) {
  const buf = await row.file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (!bytes.length) throw new Error("empty file");
  const total = Math.max(1, Math.ceil(bytes.length / CHUNK));
  const uploadId = newUploadId();
  for (let i = 0; i < total; i++) {
    label.textContent = `Uploading ${fileNo} of ${fileCount}${total > 1 ? ` · part ${i + 1} of ${total}` : ""}…`;
    const slice = bytes.subarray(i * CHUNK, (i + 1) * CHUNK);
    await api("upload-chunk", { method: "POST", body: { project: projectId, uploadId, index: i, total, dataB64: b64(slice) } });
  }
  return { uploadId, chunks: total };
}

async function publish() {
  const btn = document.getElementById("publishBtn"), label = document.getElementById("publishLabel");
  btn.disabled = true;
  const rows = items.slice();
  const meta = {
    reason: document.getElementById("reason").value,
    issueDate: document.getElementById("issueDate").value || null,
    note: document.getElementById("note").value || null,
  };
  let done = 0; const failed = [];
  for (const row of rows) {
    const p = effectivePlan(row);
    try {
      const { uploadId, chunks } = await uploadInChunks(row, label, done + 1, rows.length);
      label.textContent = `Saving ${done + 1} of ${rows.length}…`;
      await api("publish-revisions", {
        method: "POST",
        body: {
          project: projectId, reason: meta.reason, issueDate: meta.issueDate, note: meta.note,
          files: [{ sheet: p.sheet, newRev: p.newRev, status: p.status, title: row.autoTitle || null, uploadId, chunks }],
        },
      });
      done++;
    } catch (e) {
      failed.push(`${row.filename} (${e.message})`);
    }
  }
  if (!failed.length) {
    toast("Published", `${done} revision${done > 1 ? "s" : ""} saved.`, false);
    setTimeout(() => (location.href = backHref), 1200);
  } else {
    toast(`Published ${done} of ${rows.length}`, `Couldn't publish: ${failed.join("; ")}`, true);
    label.textContent = `Publish ${items.length} revisions`;
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
