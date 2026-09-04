import { loadManifest, sheetRows, fmtDate, relTime } from "./manifest.js";

// Which sheets the local tablet is "behind" on. In a real deployment this comes
// from the device's cached revs; with no device state we treat a sheet issued in
// the last few days as one the field may still have an older pinned copy of.
// You can wire real cached-rev tracking later; the render path already supports it.
function isBehind(row, cachedRev) {
  if (cachedRev == null) return false;
  return cachedRev < row.currentRev;
}

const state = { rows: [], filter: "all", q: "" };

function statusCell(row) {
  if (row.status === "pending") return `<span class="tag tag-neutral">Pending approval</span>`;
  return `<span class="status-current"><i class="ph-fill ph-check-circle"></i>Current</span>`;
}

function render() {
  const tbody = document.getElementById("rows");
  const q = state.q.toLowerCase();
  const list = state.rows.filter((r) => {
    if (state.filter === "behind" && !r._behind) return false;
    if (state.filter === "pinned" && !r._pinned) return false;
    if (q && !(`${r.sheet} ${r.title}`.toLowerCase().includes(q))) return false;
    return true;
  });

  tbody.innerHTML = list.map((r) => `
    <tr>
      <td><span class="snum">${r.sheet}</span></td>
      <td>
        <div class="stitle">${r.title || ""}</div>
        ${r.note ? `<div class="ssub">${r.note}</div>` : ""}
      </td>
      <td><span class="rev">Rev ${r.currentRev}</span></td>
      <td><span class="issued">${fmtDate(r.issuedDate)}</span></td>
      <td>${statusCell(r)}</td>
      <td>
        <div class="rowlink">
          <a href="./sheet.html?sheet=${encodeURIComponent(r.sheet)}" title="Open sheet"><i class="ph ph-caret-right" style="font-size:14px"></i></a>
        </div>
      </td>
    </tr>`).join("");

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="padding:40px 10px;text-align:center;color:var(--color-neutral-500)">No sheets match.</td></tr>`;
  }
}

function renderBanner() {
  const behind = state.rows.filter((r) => r._behind);
  const el = document.getElementById("banner");
  document.getElementById("behindBadge").textContent = behind.length;
  if (!behind.length) { el.innerHTML = ""; return; }
  const names = behind.map((r) => r.sheet).join(" and ");
  el.innerHTML = `
    <div class="alert">
      <i class="ph-fill ph-warning-circle" style="font-size:19px;color:var(--color-accent-400)"></i>
      <div>
        <div class="atitle">${behind.length} sheet${behind.length>1?"s":""} on this tablet are behind the issued set</div>
        <div class="abody">${names} ${behind.length>1?"were":"was"} reissued recently. Your pinned copies are older.</div>
      </div>
      <div class="aactions">
        <a class="btn btn-primary" style="min-height:34px" href="./sheet.html?sheet=${encodeURIComponent(behind[0].sheet)}">Review changes</a>
      </div>
    </div>`;
}

async function main() {
  try {
    const manifest = await loadManifest();
    document.getElementById("projName").textContent =
      `${manifest.project?.name || "Project"}${manifest.project?.discipline ? " · " + manifest.project.discipline : ""}`;
    document.getElementById("syncLabel").textContent = "Synced " + relTime(manifest.project?.syncedAt);
    const rows = sheetRows(manifest);
    // Demo behind-state: none wired to a device yet. Flip these from real
    // cached-rev tracking when the offline layer lands.
    for (const r of rows) { r._pinned = false; r._behind = isBehind(r, null); }
    state.rows = rows;
    document.getElementById("elecCount").textContent = rows.length;
    renderBanner();
    render();
  } catch (e) {
    document.getElementById("rows").innerHTML =
      `<tr><td colspan="6" style="padding:40px 10px;text-align:center;color:var(--color-neutral-500)">Couldn't load manifest.json — ${e.message}</td></tr>`;
  }
}

document.getElementById("search").addEventListener("input", (e) => { state.q = e.target.value; render(); });
document.querySelectorAll(".chip[data-filter]").forEach((c) =>
  c.addEventListener("click", () => {
    document.querySelectorAll(".chip[data-filter]").forEach((x) => x.classList.remove("active"));
    c.classList.add("active");
    state.filter = c.dataset.filter;
    render();
  }));

main();
