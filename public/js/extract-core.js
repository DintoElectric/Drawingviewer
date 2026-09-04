// extract-core.js — pure title-block logic shared by the browser upload page
// and the Node ingestion (GitHub Action / script). No dependencies: the caller
// passes an array of text items { str, x, y, h } in a top-left origin space
// (x grows right, y grows DOWN), already normalized to page 0..1 on both axes,
// plus the page's aspect. This keeps the crux identical everywhere.

// Sheet-number grammar for construction drawings: a discipline prefix
// (E, M, P, A, S, FA, FP, T, C, G, ID, EL...) then a number that may use a
// dash or a dot: E-101, E101, E-501, M-201, FA-101, E0.01, E1.1, A-101.
const DISCIPLINE = "(?:E|M|P|A|S|C|G|T|FA|FP|EL|ID|SP|LS|CD|AV)";
const SHEET_RE = new RegExp(`^${DISCIPLINE}[-\\s]?\\d{1,3}(?:[.\\-]\\d{1,3})?[A-Z]?$`, "i");
const SHEET_RE_LOOSE = new RegExp(`\\b(${DISCIPLINE}[-\\s]?\\d{1,3}(?:[.\\-]\\d{1,3})?[A-Z]?)\\b`, "i");

export function normalizeSheet(raw) {
  if (!raw) return null;
  let s = raw.toUpperCase().replace(/\s+/g, "");
  const m = s.match(new RegExp(`^(${DISCIPLINE})([-]?)(\\d.*)$`, "i"));
  if (m) {
    const [, disc, dash, rest] = m;
    // Dash convention (E101 -> E-101, FA101 -> FA-101). Dotted convention
    // (E0.01, E1.1) is already separated by the dot — leave it as-is.
    s = rest.includes(".") ? `${disc.toUpperCase()}${rest}` : `${disc.toUpperCase()}-${rest}`;
  }
  return s;
}

// Score a candidate by how title-block-like its position is: title blocks live
// in the bottom-right corner, and the sheet number is the largest text there.
function score(item) {
  const rightness = item.x;          // 0..1, want high
  const bottomness = item.y;         // 0..1 (top-left origin), want high
  const size = item.h || 0.01;       // taller text scores higher
  return rightness * 1.4 + bottomness * 1.6 + size * 30;
}

export function pickSheetNumber(items) {
  const exact = items
    .map((it) => ({ it, txt: it.str.trim() }))
    .filter((c) => SHEET_RE.test(c.txt));
  let pool = exact;
  if (!pool.length) {
    // fall back to a loose match embedded in a longer string
    pool = [];
    for (const it of items) {
      const m = it.str.match(SHEET_RE_LOOSE);
      if (m) pool.push({ it, txt: m[1] });
    }
  }
  if (!pool.length) return { sheet: null, confidence: 0 };
  pool.sort((a, b) => score(b.it) - score(a.it));
  const best = pool[0];
  // confidence: corner position + whether it was an exact standalone token
  const posConf = Math.min(1, (best.it.x * 0.5 + best.it.y * 0.5) + 0.15);
  const exactBonus = exact.includes(best) ? 0.35 : 0.0;
  const confidence = Math.max(0, Math.min(0.99, 0.45 + posConf * 0.4 + exactBonus));
  return { sheet: normalizeSheet(best.txt), confidence: Math.round(confidence * 100) / 100 };
}

export function pickTitle(items, sheetItemStr) {
  // Prefer a line right after a "SHEET TITLE" label, else the largest text in
  // the bottom-right that isn't the sheet number or a known label.
  const LABELS = /^(SHEET|TITLE|SHEET TITLE|SHEET NUMBER|REVISION|REVISIONS|DATE|SCALE|PROJECT|DRAWN|CHECKED|DINTO|ELECTRIC|CONTRACTORS)/i;
  const labelIdx = items.findIndex((it) => /SHEET\s*TITLE/i.test(it.str));
  if (labelIdx >= 0) {
    const label = items[labelIdx];
    const below = items
      .filter((it) => it !== label && Math.abs(it.x - label.x) < 0.12 && it.y > label.y && it.y - label.y < 0.06)
      .sort((a, b) => a.y - b.y)[0];
    if (below && below.str.trim().length > 2) return below.str.trim();
  }
  const cand = items
    .filter((it) => it.x > 0.6 && it.y > 0.5 && it.str.trim().length > 3 && !LABELS.test(it.str.trim()) && it.str.trim() !== sheetItemStr)
    .sort((a, b) => (b.h || 0) - (a.h || 0))[0];
  return cand ? cand.str.trim() : null;
}

export function pickPrintedRev(items) {
  // Look for a revision figure near a "REV" label in the title block region.
  const revLabel = items.find((it) => /\bREV(ISION)?S?\b/i.test(it.str) && it.x > 0.55);
  const scan = (revLabel ? items.filter((it) => it.y >= revLabel.y - 0.02 && it.y - revLabel.y < 0.08 && it.x > 0.5) : items)
    .map((it) => it.str);
  for (const s of scan) {
    const m = s.match(/\bREV(?:ISION)?\.?\s*#?\s*(\d{1,2})\b/i) || s.match(/^\s*(\d{1,2})\s+ISSUED/i);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

// Given what we read off one PDF and the current manifest, produce the plan:
// which sheet it supersedes, the new rev, the canonical filename, and where the
// old file moves. This is the single source of the "replace old versions" rule.
export function matchAndPlan(extracted, manifest, opts = {}) {
  const { sheet, confidence, printedRev, title, sourceFilename } = extracted;
  const drawings = manifest.drawings || {};
  const existing = sheet ? drawings[sheet] : null;

  if (!sheet) {
    return { status: "unmatched", sourceFilename, reason: "No sheet number found in the title block" };
  }

  let newRev, supersedes = null, archivePath = null;
  if (existing) {
    const cur = existing.currentRev || 0;
    // Trust a confidently-printed rev if it advances things; otherwise increment.
    newRev = printedRev && printedRev > cur ? printedRev : cur + 1;
    supersedes = cur;
    archivePath = existing.currentFile
      ? `drawings/archive/${existing.currentFile.split("/").pop()}`
      : null;
  } else {
    newRev = printedRev || 1;
  }

  const canonical = `${sheet}_Rev${newRev}.pdf`;
  return {
    status: existing ? "supersede" : "new",
    sheet,
    title: title || (existing && existing.title) || null,
    confidence,
    newRev,
    supersedes,
    sourceFilename,
    canonicalFile: `drawings/${canonical}`,
    archiveOldTo: archivePath,
  };
}
