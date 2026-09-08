import { requireLogin, api } from "./auth.js";
import { mountTopbarUser, fmtDate, toast } from "./ui.js";

const projectId = new URLSearchParams(location.search).get("project");
const state = { rows: [], q: "" };

function sheetRows(manifest) {
  const d = manifest.drawings || {};
  return Object.keys(d).sort().map((sheet) => ({ sheet, ...d[sheet] }));
}

function render() {
  const content = document.getElementById("content");
  const q = state.q.toLowerCase();
  const rows = state.rows.filter((r) => !q || `${r.sheet} ${r.title || ""}`.toLowerCase().includes(q));

  if (!state.rows.length) {
    document.getElementById("toolbar").style.display = "none";
    content.innerHTML = `
      <div class="empty-state">
        <i class="ph ph-tray"></i>
        <div class="es-title">No drawings yet</div>
        <div class="es-sub">Upload PDF drawings and the hub reads each sheet number from its title block, names it, and tracks revisions from there.</div>
        <a class="btn btn-primary hidden" id="emptyAdd" style="min-height:40px"><i class="ph ph-upload-simple"></i>Add drawings</a>
      </div>`;
    if (window.__isAdmin) document.getElementById("emptyAdd")?.classList.remove("hidden");
    document.getElementById("emptyAdd")?.addEventListener("click", goUpload);
    return;
  }

  document.getElementById("toolbar").style.display = "";
  content.innerHTML = `
    <table class="table">
      <thead><tr><th style="width:96px">Sheet</th><th>Title</th><th style="width:110px">Current rev</th><th style="width:118px">Issued</th><th style="width:150px">Status</th><th style="width:56px"></th></tr></thead>
      <tbody>${rows.map(rowHtml).join("") || `<tr><td colspan="6" style="padding:34px;text-align:center;color:var(--color-neutral-500)">No sheets match.</td></tr>`}</tbody>
    </table>`;
}

function rowHtml(r) {
  return `<tr>
    <td><span class="snum">${r.sheet}</span></td>
    <td><div class="stitle">${r.title || ""}</div>${r.note ? `<div class="ssub">${r.note}</div>` : ""}</td>
    <td><span class="rev">Rev ${r.currentRev}</span></td>
    <td><span class="issued">${fmtDate(r.issuedDate)}</span></td>
    <td><span class="status-current"><i class="ph-fill ph-check-circle"></i>Current</span></td>
    <td><div class="rowlink"><a href="./sheet.html?project=${encodeURIComponent(projectId)}&sheet=${encodeURIComponent(r.sheet)}"><i class="ph ph-caret-right" style="font-size:14px"></i></a></div></td>
  </tr>`;
}

function goUpload() { location.href = `./upload.html?project=${encodeURIComponent(projectId)}`; }

async function main() {
  if (!projectId) { location.href = "./index.html"; return; }
  const { admin } = await mountTopbarUser();
  window.__isAdmin = admin;
  document.getElementById("page").style.display = "";

  let manifest;
  try { manifest = await api(`get-manifest?project=${encodeURIComponent(projectId)}`); }
  catch (e) {
    document.getElementById("content").innerHTML = `<div class="empty-state"><i class="ph ph-warning-circle"></i><div class="es-title">Couldn't load this project</div><div class="es-sub">${e.message}</div></div>`;
    return;
  }

  const name = manifest.project?.name || projectId;
  document.getElementById("projName").textContent = name;
  document.getElementById("h1").textContent = name;
  document.getElementById("sub").textContent = manifest.project?.discipline || "";
  if (admin) {
    const add = document.getElementById("addBtn");
    add.classList.remove("hidden"); add.addEventListener("click", goUpload);
  }
  state.rows = sheetRows(manifest);
  render();
}

document.getElementById("search").addEventListener("input", (e) => { state.q = e.target.value; render(); });
requireLogin(main);
