import { loadManifest, fmtDate } from "./manifest.js";

const params = new URLSearchParams(location.search);
const sheetId = params.get("sheet");

function fileForRev(entry, rev) {
  if (rev === entry.currentRev && entry.currentFile) return entry.currentFile;
  const h = (entry.history || []).find((x) => x.rev === rev);
  return h ? h.file : null;
}

function showPdf(path) {
  const frame = document.getElementById("pdf");
  const empty = document.getElementById("empty");
  const dl = document.getElementById("downloadBtn");
  if (path) {
    frame.src = "./" + path;
    frame.classList.remove("hidden");
    empty.classList.add("hidden");
    dl.href = "./" + path;
    dl.classList.remove("hidden");
  } else {
    frame.classList.add("hidden");
    empty.classList.remove("hidden");
    empty.innerHTML = `<div>No file on record for this revision yet.<br><span class="muted">Publish it from the Add-revisions page and it will appear here.</span></div>`;
    dl.classList.add("hidden");
  }
}

function renderRevs(entry, activeRev, onPick) {
  const revs = [];
  const seen = new Set();
  for (const h of (entry.history || [])) { revs.push(h); seen.add(h.rev); }
  if (!seen.has(entry.currentRev)) revs.push({ rev: entry.currentRev, date: entry.issuedDate, reason: entry.note || "", file: entry.currentFile });
  revs.sort((a, b) => b.rev - a.rev);

  document.getElementById("revs").innerHTML = revs.map((r) => `
    <div class="hrev ${r.rev === activeRev ? "cur" : ""}" data-rev="${r.rev}" style="cursor:pointer">
      <div class="hr-top">
        <span class="hr-rev">Rev ${r.rev}</span>
        ${r.rev === entry.currentRev ? `<span class="tag tag-outline" style="font-size:10px;padding:2px 8px">Issued</span>` : ""}
      </div>
      <div class="hr-meta">${fmtDate(r.date)}</div>
      ${r.reason ? `<div class="hr-reason">${r.reason}</div>` : ""}
    </div>`).join("");

  document.querySelectorAll(".hrev").forEach((el) =>
    el.addEventListener("click", () => onPick(parseInt(el.dataset.rev, 10))));
}

async function main() {
  const manifest = await loadManifest();
  const entry = manifest.drawings?.[sheetId];
  if (!entry) {
    document.getElementById("snum").textContent = sheetId || "?";
    showPdf(null);
    return;
  }
  document.getElementById("snum").textContent = sheetId;
  document.getElementById("stitle").textContent = entry.title || "";

  let active = entry.currentRev;
  function pick(rev) {
    active = rev;
    document.getElementById("revpick").innerHTML =
      `Rev ${rev}${rev === entry.currentRev ? " · current" : ""} <i class="ph ph-caret-down" style="font-size:12px"></i>`;
    showPdf(fileForRev(entry, rev));
    renderRevs(entry, active, pick);
  }
  pick(active);
}

main();
