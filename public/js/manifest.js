// manifest.js — load the manifest and expose small derived-state helpers.
// The "behind the issued set" flag the whole UI turns on is derived here.

export async function loadManifest() {
  const res = await fetch("./manifest.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`manifest.json: ${res.status}`);
  return res.json();
}

// Turn the drawings map into a sorted array of rows the tables render from.
export function sheetRows(manifest) {
  const d = manifest.drawings || {};
  return Object.keys(d)
    .sort()
    .map((sheet) => {
      const s = d[sheet];
      return {
        sheet,
        title: s.title || "",
        currentRev: s.currentRev || 0,
        currentFile: s.currentFile || null,
        issuedDate: s.issuedDate || null,
        status: s.status || "issued",
        note: s.note || null,
        history: (s.history || []).slice().sort((a, b) => a.rev - b.rev),
      };
    });
}

export function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function relTime(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return fmtDate(iso.slice(0, 10));
}
