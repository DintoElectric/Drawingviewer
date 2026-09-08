import { requireLogin, api, apiBlob } from "./auth.js";
import { fmtDate } from "./ui.js";

const params = new URLSearchParams(location.search);
const projectId = params.get("project");
const sheetId = params.get("sheet");
let entry = null;
let currentObjectUrl = null;

document.getElementById("back").href = `./project.html?project=${encodeURIComponent(projectId)}`;

async function showRev(rev) {
  const frame = document.getElementById("pdf");
  const empty = document.getElementById("empty");
  const dl = document.getElementById("downloadBtn");
  const archive = rev === entry.currentRev ? "0" : "1";
  const base = `get-drawing?project=${encodeURIComponent(projectId)}&sheet=${encodeURIComponent(sheetId)}&rev=${rev}&archive=${archive}`;

  document.getElementById("revpick").innerHTML =
    `Rev ${rev}${rev === entry.currentRev ? " · current" : ""} <i class="ph ph-caret-down" style="font-size:12px"></i>`;
  empty.classList.remove("hidden");
  empty.innerHTML = `<div class="muted">Loading…</div>`;
  frame.classList.add("hidden");
  dl.classList.add("hidden");

  try {
    // large sheets come back in pieces; stitch them into one PDF blob
    const meta = await api(`${base}&meta=1`);
    const parts = [];
    for (let i = 0; i < meta.chunks; i++) parts.push(await apiBlob(`${base}&chunk=${i}`));
    const blob = new Blob(parts, { type: "application/pdf" });
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = URL.createObjectURL(blob);
    frame.src = currentObjectUrl;
    frame.classList.remove("hidden");
    empty.classList.add("hidden");
    dl.href = currentObjectUrl;
    dl.setAttribute("download", `${sheetId}_Rev${rev}.pdf`);
    dl.classList.remove("hidden");
  } catch (e) {
    frame.classList.add("hidden");
    empty.classList.remove("hidden");
    empty.innerHTML = `<div>Couldn't load this revision.<br><span class="muted">${e.message}</span></div>`;
    dl.classList.add("hidden");
  }
  renderRevs(rev);
}

function renderRevs(activeRev) {
  const revs = (entry.history || []).slice().sort((a, b) => b.rev - a.rev);
  if (!revs.find((r) => r.rev === entry.currentRev)) revs.unshift({ rev: entry.currentRev, date: entry.issuedDate, reason: entry.note || "" });
  document.getElementById("revs").innerHTML = revs.map((r) => `
    <div class="hrev ${r.rev === activeRev ? "cur" : ""}" data-rev="${r.rev}">
      <div class="hr-top"><span class="hr-rev">Rev ${r.rev}</span>${r.rev === entry.currentRev ? `<span class="tag tag-outline" style="font-size:10px;padding:2px 8px">Issued</span>` : ""}</div>
      <div class="hr-meta">${fmtDate(r.date)}</div>
      ${r.reason ? `<div class="hr-reason">${r.reason}</div>` : ""}
    </div>`).join("");
  document.querySelectorAll(".hrev").forEach((el) => el.addEventListener("click", () => showRev(parseInt(el.dataset.rev, 10))));
}

async function main() {
  if (!projectId || !sheetId) { location.href = "./index.html"; return; }
  let manifest;
  try { manifest = await api(`get-manifest?project=${encodeURIComponent(projectId)}`); }
  catch (e) { document.getElementById("snum").textContent = sheetId; return; }
  entry = manifest.drawings?.[sheetId];
  document.getElementById("snum").textContent = sheetId;
  if (!entry) { document.getElementById("empty").classList.remove("hidden"); document.getElementById("empty").textContent = "Sheet not found."; return; }
  document.getElementById("stitle").textContent = entry.title || "";
  showRev(entry.currentRev);
}

requireLogin(main);
