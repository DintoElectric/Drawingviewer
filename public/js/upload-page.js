import { loadManifest, sheetRows } from "./manifest.js";
import { itemsFromArrayBuffer, thumbnailFromArrayBuffer } from "./pdf-browser.js";
import { pickSheetNumber, pickTitle, pickPrintedRev, matchAndPlan } from "./extract-core.js";

let manifest = null;
let sheetOptions = [];       // [{sheet, title}] for the manual picker
const items = [];            // upload rows: { id, filename, buf, base64, plan, thumb, override }
let nextId = 1;

const AUTO_CONFIRM = 0.9;    // >= this confidence auto-confirms the match

function b64(buf) {
  let bin = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

async function readFile(file) {
  const buf = await file.arrayBuffer();
  const { items: tItems } = await itemsFromArrayBuffer(buf);
  const sn = pickSheetNumber(tItems);
  const title = pickTitle(tItems, sn.sheet);
  const printedRev = pickPrintedRev(tItems);
  const plan = matchAndPlan(
    { sheet: sn.sheet, confidence: sn.confidence, printedRev, title, sourceFilename: file.name },
    manifest
  );
  let thumb = null;
  try { thumb = await thumbnailFromArrayBuffer(buf); } catch {}
  return {
    id: nextId++, filename: file.name, buf, base64: b64(buf),
    plan, thumb, override: null,
    reason: null, // per-file reason falls back to the shared footer value
  };
}

// The plan a row will actually publish with, factoring any manual sheet override.
function effectivePlan(row) {
  if (row.override && row.override !== "__new__") {
    // user picked an existing sheet for an unmatched/relabeled file
    const forced = matchAndPlan(
      { sheet: row.override, confidence: 1, printedRev: null, title: null, sourceFilename: row.filename },
      manifest
    );
    return forced;
  }
  if (row.override === "__new__" && row.plan.status === "unmatched") {
    return { status: "new-manual", sheet: null, sourceFilename: row.filename, note: "Filed as a new sheet — needs a sheet number assigned by the office" };
  }
  return row.plan;
}

function planLine(p) {
  if (p.status === "supersede")
    return `<i class="ph ph-arrow-right" style="font-size:12px"></i> ${p.sheet} · <span class="tag tag-accent" style="font-size:10px;padding:2px 8px"><i class="ph-fill ph-arrow-circle-up"></i>Rev ${p.newRev} supersedes Rev ${p.supersedes}</span>`;
  if (p.status === "new")
    return `<i class="ph ph-arrow-right" style="font-size:12px"></i> ${p.sheet} · <span class="tag tag-neutral" style="font-size:10px;padding:2px 8px">New sheet · Rev ${p.newRev}</span>`;
  if (p.status === "new-manual")
    return `<span style="color:var(--color-accent-200)">Filed as new — office assigns the sheet number</span>`;
  return `<span style="color:var(--color-accent-200)"><i class="ph ph-question" style="font-size:13px"></i> No sheet number found — pick a sheet</span>`;
}

function renderRows() {
  const wrap = document.getElementById("rows");
  wrap.innerHTML = items.map((row) => {
    const p = effectivePlan(row);
    const needs = p.status === "unmatched" || p.status === "new-manual";
    const conf = row.plan.confidence ? `<span class="conf">${Math.round(row.plan.confidence * 100)}% match</span>` : "";
    const picker = needs ? `
      <select class="input" data-pick="${row.id}">
        <option value="">Choose a sheet…</option>
        ${sheetOptions.map((o) => `<option value="${o.sheet}" ${row.override===o.sheet?"selected":""}>${o.sheet} ${o.title}</option>`).join("")}
        <option value="__new__" ${row.override==="__new__"?"selected":""}>File as a new sheet</option>
      </select>` : `
      <button class="btn btn-ghost" style="font-size:12px" data-change="${row.id}">Change</button>
      <i class="ph-fill ph-check-circle ok"></i>`;
    return `
      <div class="matchrow ${needs ? "needs" : ""}">
        ${row.thumb ? `<img class="thumb" src="${row.thumb}" alt="">` : `<i class="ph-fill ph-file-pdf" style="font-size:21px;color:var(--color-neutral-500)"></i>`}
        <div class="mr-main">
          <div class="mr-file" title="${row.filename}">${row.filename}</div>
          <div class="mr-plan">${planLine(p)} ${needs ? "" : conf}</div>
        </div>
        <div class="mr-right">${picker}</div>
      </div>`;
  }).join("");

  wrap.querySelectorAll("select[data-pick]").forEach((sel) =>
    sel.addEventListener("change", (e) => {
      const row = items.find((r) => r.id === +sel.dataset.pick);
      row.override = e.target.value || null;
      renderRows(); updatePublish();
    }));
  wrap.querySelectorAll("button[data-change]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const row = items.find((r) => r.id === +btn.dataset.change);
      row.override = row.override || "__reset__";
      row.override = null;
      row.plan = { ...row.plan, status: "unmatched", reason: "Reassign the sheet" };
      renderRows(); updatePublish();
    }));
}

function unresolved() {
  return items.filter((row) => {
    const p = effectivePlan(row);
    return p.status === "unmatched" || p.status === "new-manual";
  });
}

function updatePublish() {
  const btn = document.getElementById("publishBtn");
  const hint = document.getElementById("publishHint");
  const label = document.getElementById("publishLabel");
  const bad = unresolved().length;
  const n = items.length;
  label.textContent = n ? `Publish ${n} revision${n > 1 ? "s" : ""}` : "Publish revisions";
  if (!n) { btn.disabled = true; hint.textContent = ""; return; }
  if (bad) { btn.disabled = true; hint.textContent = `${bad} file${bad>1?"s":""} still need${bad>1?"":"s"} a sheet before you can publish.`; }
  else { btn.disabled = false; hint.textContent = `Ready — ${items.filter(r=>effectivePlan(r).status==="supersede").length} supersede an existing sheet.`; }
}

function dzBusy(msg) { document.getElementById("dzTitle").textContent = msg; }
function dzReset() {
  document.getElementById("dzTitle").textContent = "Drop PDF drawings here, or choose files";
  document.getElementById("dzSub").textContent = "Each file's sheet number is pulled from its title block — the file name doesn't matter.";
}

async function ingestFiles(fileList) {
  const pdfs = [...fileList].filter((f) => /\.pdf$/i.test(f.name));
  if (!pdfs.length) return;
  dzBusy(`Reading ${pdfs.length} file${pdfs.length>1?"s":""}…`);
  for (const f of pdfs) {
    try { items.push(await readFile(f)); }
    catch (e) { items.push({ id: nextId++, filename: f.name, buf: null, base64: null, plan: { status: "unmatched", sourceFilename: f.name, reason: "Couldn't read this PDF" }, thumb: null, override: null }); }
    renderRows(); updatePublish();
  }
  const matched = items.filter((r) => effectivePlan(r).status !== "unmatched").length;
  document.getElementById("dzTitle").textContent = `${items.length} file${items.length>1?"s":""} read · sheet numbers pulled from the title block`;
  document.getElementById("dzSub").textContent = `${matched} matched a sheet automatically. Confirm anything flagged below.`;
}

function toast(title, body, isErr) {
  const t = document.createElement("div");
  t.className = "toast" + (isErr ? " err" : "");
  t.innerHTML = `<i class="${isErr ? "ph ph-warning-circle" : "ph-fill ph-check-circle"}" style="font-size:20px;color:${isErr ? "var(--color-neutral-300)" : "var(--color-accent-400)"}"></i>
    <div><div class="t-title">${title}</div><div class="t-body">${body}</div></div>`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 6000);
}

async function publish() {
  const btn = document.getElementById("publishBtn");
  btn.disabled = true;
  document.getElementById("publishLabel").textContent = "Publishing…";

  const payload = {
    project: manifest.project?.id || null,
    reason: document.getElementById("reason").value,
    issueDate: document.getElementById("issueDate").value || null,
    note: document.getElementById("note").value || null,
    files: items.map((row) => {
      const p = effectivePlan(row);
      return { sheet: p.sheet, newRev: p.newRev, canonicalFile: p.canonicalFile, archiveOldTo: p.archiveOldTo, status: p.status, title: p.title || null, base64: row.base64 };
    }),
  };

  try {
    const res = await fetch("/.netlify/functions/publish-revisions", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const out = await res.json();
    toast("Published", `${payload.files.length} revision${payload.files.length>1?"s":""} committed. Netlify will redeploy in a moment.`, false);
    setTimeout(() => (location.href = "./index.html"), 1800);
    return out;
  } catch (e) {
    // No function configured yet (e.g. running the static site locally): fall back
    // to a downloadable publish bundle so the flow is never a dead end.
    downloadBundle(payload);
    toast("Saved a publish bundle", `The commit service isn't wired up yet, so the confirmed revisions were downloaded as a bundle. See the README to enable one-click publishing.`, true);
    document.getElementById("publishLabel").textContent = `Publish ${items.length} revisions`;
    btn.disabled = false;
  }
}

// Fallback: emit a manifest + rename map the office can commit by hand / via the Action.
function downloadBundle(payload) {
  const plan = {
    generatedAt: new Date().toISOString(),
    reason: payload.reason, issueDate: payload.issueDate, note: payload.note,
    revisions: payload.files.map(({ base64, ...meta }) => meta),
  };
  const blob = new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "publish-plan.json";
  a.click();
}

// wiring --------------------------------------------------------------
async function main() {
  manifest = await loadManifest();
  sheetOptions = sheetRows(manifest).map((r) => ({ sheet: r.sheet, title: r.title }));
  document.getElementById("projSub").textContent =
    `${manifest.project?.name || "Project"} · ${manifest.project?.discipline || ""} — sheet numbers read from each title block`;
  document.getElementById("issueDate").valueAsDate = new Date();

  const input = document.getElementById("fileInput");
  input.addEventListener("change", (e) => ingestFiles(e.target.files));

  const dz = document.getElementById("dropzone");
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => ingestFiles(e.dataTransfer.files));

  document.getElementById("publishBtn").addEventListener("click", publish);
}

main();
