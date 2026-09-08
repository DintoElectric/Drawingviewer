import { requireLogin, api } from "./auth.js";
import { mountTopbarUser, toast } from "./ui.js";
import { itemsFromArrayBuffer, thumbnailFromArrayBuffer } from "./pdf-browser.js";
import { pickSheetNumber, pickTitle, pickPrintedRev, matchAndPlan } from "./extract-core.js";

const projectId = new URLSearchParams(location.search).get("project");
let manifest = null;
let sheetOptions = [];
const items = [];
let nextId = 1;

const backHref = `./project.html?project=${encodeURIComponent(projectId)}`;
document.getElementById("closeBtn").href = backHref;
document.getElementById("cancelBtn").href = backHref;

function b64(buf) {
  let bin = ""; const bytes = new Uint8Array(buf); const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

async function readFile(file) {
  const buf = await file.arrayBuffer();
  const { items: tItems } = await itemsFromArrayBuffer(buf);
  const sn = pickSheetNumber(tItems);
  const title = pickTitle(tItems, sn.sheet);
  const printedRev = pickPrintedRev(tItems);
  const plan = matchAndPlan({ sheet: sn.sheet, confidence: sn.confidence, printedRev, title, sourceFilename: file.name }, manifest);
  let thumb = null; try { thumb = await thumbnailFromArrayBuffer(buf); } catch {}
  return { id: nextId++, filename: file.name, base64: b64(buf), plan, thumb, override: null };
}

function effectivePlan(row) {
  if (row.override && row.override !== "__new__")
    return matchAndPlan({ sheet: row.override, confidence: 1, printedRev: null, title: null, sourceFilename: row.filename }, manifest);
  if (row.override === "__new__" && row.plan.status === "unmatched")
    return { status: "new-manual", sheet: null, sourceFilename: row.filename };
  return row.plan;
}

function planLine(p) {
  if (p.status === "supersede") return `<i class="ph ph-arrow-right" style="font-size:12px"></i> ${p.sheet} · <span class="tag tag-accent" style="font-size:10px;padding:2px 8px"><i class="ph-fill ph-arrow-circle-up"></i>Rev ${p.newRev} supersedes Rev ${p.supersedes}</span>`;
  if (p.status === "new") return `<i class="ph ph-arrow-right" style="font-size:12px"></i> ${p.sheet} · <span class="tag tag-neutral" style="font-size:10px;padding:2px 8px">New sheet · Rev ${p.newRev}</span>`;
  if (p.status === "new-manual") return `<span style="color:var(--color-accent-200)">Filed as new — assign a sheet number</span>`;
  return `<span style="color:var(--color-accent-200)"><i class="ph ph-question" style="font-size:13px"></i> No sheet number found — pick a sheet</span>`;
}

function renderRows() {
  const wrap = document.getElementById("rows");
  wrap.innerHTML = items.map((row) => {
    const p = effectivePlan(row);
    const needs = p.status === "unmatched" || p.status === "new-manual";
    const conf = row.plan.confidence ? `<span class="conf">${Math.round(row.plan.confidence * 100)}% match</span>` : "";
    const picker = needs
      ? `<select class="input" data-pick="${row.id}"><option value="">Choose a sheet…</option>${sheetOptions.map((o) => `<option value="${o.sheet}" ${row.override===o.sheet?"selected":""}>${o.sheet} ${o.title||""}</option>`).join("")}<option value="__new__" ${row.override==="__new__"?"selected":""}>File as a new sheet</option></select>`
      : `<button class="btn btn-ghost" style="font-size:12px" data-change="${row.id}">Change</button><i class="ph-fill ph-check-circle ok"></i>`;
    return `<div class="matchrow ${needs ? "needs" : ""}">
      ${row.thumb ? `<img class="thumb" src="${row.thumb}" alt="">` : `<i class="ph-fill ph-file-pdf" style="font-size:21px;color:var(--color-neutral-500)"></i>`}
      <div class="mr-main"><div class="mr-file" title="${row.filename}">${row.filename}</div><div class="mr-plan">${planLine(p)} ${needs ? "" : conf}</div></div>
      <div class="mr-right">${picker}</div>
    </div>`;
  }).join("");

  wrap.querySelectorAll("select[data-pick]").forEach((sel) => sel.addEventListener("change", (e) => {
    items.find((r) => r.id === +sel.dataset.pick).override = e.target.value || null; renderRows(); updatePublish();
  }));
  wrap.querySelectorAll("button[data-change]").forEach((btn) => btn.addEventListener("click", () => {
    const row = items.find((r) => r.id === +btn.dataset.change);
    row.override = null; row.plan = { ...row.plan, status: "unmatched" }; renderRows(); updatePublish();
  }));
}

function unresolved() { return items.filter((row) => { const p = effectivePlan(row); return p.status === "unmatched" || p.status === "new-manual"; }); }

function updatePublish() {
  const btn = document.getElementById("publishBtn"), hint = document.getElementById("publishHint"), label = document.getElementById("publishLabel");
  const bad = unresolved().length, n = items.length;
  label.textContent = n ? `Publish ${n} revision${n > 1 ? "s" : ""}` : "Publish revisions";
  if (!n) { btn.disabled = true; hint.textContent = ""; return; }
  if (bad) { btn.disabled = true; hint.textContent = `${bad} file${bad>1?"s":""} still need${bad>1?"":"s"} a sheet.`; }
  else { btn.disabled = false; hint.textContent = `Ready — ${items.filter(r=>effectivePlan(r).status==="supersede").length} supersede an existing sheet.`; }
}

async function ingestFiles(fileList) {
  const pdfs = [...fileList].filter((f) => /\.pdf$/i.test(f.name));
  if (!pdfs.length) return;
  document.getElementById("dzTitle").textContent = `Reading ${pdfs.length} file${pdfs.length>1?"s":""}…`;
  for (const f of pdfs) {
    try { items.push(await readFile(f)); }
    catch { items.push({ id: nextId++, filename: f.name, base64: null, plan: { status: "unmatched", sourceFilename: f.name }, thumb: null, override: null }); }
    renderRows(); updatePublish();
  }
  const matched = items.filter((r) => effectivePlan(r).status !== "unmatched").length;
  document.getElementById("dzTitle").textContent = `${items.length} file${items.length>1?"s":""} read · sheet numbers from the title block`;
  document.getElementById("dzSub").textContent = `${matched} matched automatically. Confirm anything flagged below.`;
}

async function publish() {
  const btn = document.getElementById("publishBtn");
  btn.disabled = true; document.getElementById("publishLabel").textContent = "Publishing…";
  const payload = {
    project: projectId,
    reason: document.getElementById("reason").value,
    issueDate: document.getElementById("issueDate").value || null,
    note: document.getElementById("note").value || null,
    files: items.map((row) => { const p = effectivePlan(row); return { sheet: p.sheet, newRev: p.newRev, status: p.status, title: p.title || null, base64: row.base64 }; }),
  };
  try {
    const out = await api("publish-revisions", { method: "POST", body: payload });
    toast("Published", `${out.published.length} revision${out.published.length>1?"s":""} saved.`, false);
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
  sheetOptions = Object.keys(manifest.drawings || {}).sort().map((s) => ({ sheet: s, title: manifest.drawings[s].title }));
  document.getElementById("projSub").textContent = `${manifest.project?.name || projectId} — sheet numbers read from each title block`;
  document.getElementById("issueDate").valueAsDate = new Date();

  document.getElementById("fileInput").addEventListener("change", (e) => ingestFiles(e.target.files));
  const dz = document.getElementById("dropzone");
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => ingestFiles(e.dataTransfer.files));
  document.getElementById("publishBtn").addEventListener("click", publish);
}

requireLogin(main);
