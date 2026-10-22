/* ------------------------------------------------------------------ *
 *  compare-export.js — Word (.docx) and Excel (.xlsx) export for the
 *  Compare page. Loaded on demand by compare-page.js (dynamic import).
 *
 *  Exports: exportWord(ctx), exportExcel(ctx)  — ctx is described at the
 *  top of compare-page.js. Both libraries are fetched from a CDN the
 *  first time they're needed, then cached for the session.
 *
 *  Two shapes of report:
 *    - one drawing each (ctx.setMode false): overview + one notes table
 *    - whole sets (ctx.setMode true): a summary of every sheet, then one
 *      section per sheet that has notes (overview of the pair + its notes)
 * ------------------------------------------------------------------ */

const LIBS = {
  docx: {
    label: "Word",
    check: () => window.docx && window.docx.Document,
    urls: [
      "https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js",
      "https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.min.js",
      "https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.js",
    ],
  },
  exceljs: {
    label: "Excel",
    check: () => window.ExcelJS && window.ExcelJS.Workbook,
    urls: [
      "https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js",
      "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js",
    ],
  },
};

const pending = {};

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { s.remove(); reject(new Error("load failed")); };
    document.head.appendChild(s);
  });
}

async function loadLib(name) {
  const lib = LIBS[name];
  if (lib.check()) return;
  if (!pending[name]) {
    pending[name] = (async () => {
      for (const url of lib.urls) {
        try { await loadScript(url); } catch (e) { continue; }
        if (lib.check()) return;
      }
      throw new Error(
        `The ${lib.label} export library couldn't be loaded. Check your connection, and that your site allows scripts from cdn.jsdelivr.net and cdnjs.cloudflare.com.`
      );
    })().catch((e) => { delete pending[name]; throw e; });
  }
  return pending[name];
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
}

/* ------------------------------------------------------------------ *
 *  Word
 * ------------------------------------------------------------------ */
const CAT_COLOR = { Changed: "B45309", Added: "047857", Removed: "B91C1C", Question: "5B3FD6", Other: "4B5563" };
const STATUS_COLOR = { changed: "B45309", same: "4B5563", onlyA: "B91C1C", onlyB: "047857", pending: "4B5563", unknown: "4B5563" };

function fit(w, h, maxW, maxH) {
  const s = Math.min(maxW / w, maxH / h, 1);
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

export async function exportWord(ctx) {
  await loadLib("docx");
  const d = window.docx;
  const { Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, WidthType,
          AlignmentType, BorderStyle, ShadingType, PageOrientation, Footer, PageNumber,
          VerticalAlign } = d;

  const line = { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" };
  const borders = { top: line, bottom: line, left: line, right: line };
  const cellMargins = { top: 70, bottom: 70, left: 100, right: 100 };

  const runs = (text, opts = {}) => {
    const parts = String(text ?? "").split(/\r?\n/);
    return parts.map((t, i) => new TextRun({ text: t, break: i ? 1 : 0, font: "Arial", size: 20, ...opts }));
  };
  const para = (children, opts = {}) => new Paragraph({ children, spacing: { after: 60 }, ...opts });
  const cell = (children, width, opts = {}) => new TableCell({
    children, borders, margins: cellMargins, verticalAlign: VerticalAlign.TOP,
    width: { size: width, type: WidthType.DXA }, ...opts,
  });
  const shade = { type: ShadingType.CLEAR, fill: "EDEBFA", color: "auto" };
  const multi = ctx.fileA.pages > 1 || ctx.fileB.pages > 1;

  // Notes table: number, type, zone (+ sheet), note text, and before/after crops of the spot.
  const NW = { n: 520, cat: 1100, zone: 1180, text: 5200, a: 3200, b: 3200 };   // = 14400 twips (10 in)
  async function notesTable(list) {
    const head = (t, w) => cell([para(runs(t, { bold: true, size: 18 }))], w, { shading: shade });
    const rows = [new TableRow({
      tableHeader: true, cantSplit: true,
      children: [head("#", NW.n), head("Type", NW.cat), head("Zone", NW.zone), head("Note", NW.text),
                 head("Drawing A (before)", NW.a), head("Drawing B (after)", NW.b)],
    })];
    for (const n of list) {
      const crops = await ctx.getCrops(n);      // one at a time to keep memory low
      const sa = fit(crops.a.w, crops.a.h, 200, 150), sb = fit(crops.b.w, crops.b.h, 200, 150);
      const where = ctx.setMode ? n.sheet : (multi ? `A p.${n.pageA} · B p.${n.pageB}` : "");
      rows.push(new TableRow({
        cantSplit: true,
        children: [
          cell([para(runs(String(n.n), { bold: true }))], NW.n),
          cell([para(runs(n.cat, { bold: true, color: CAT_COLOR[n.cat] || "333333" }))], NW.cat),
          cell([para(runs(n.zone, { bold: true })), ...(where ? [para(runs(where, { size: 16, color: "666666" }))] : [])], NW.zone),
          cell([para(runs(n.text || "—"))], NW.text),
          cell([para([new ImageRun({ data: crops.a.data, type: "png", transformation: sa })])], NW.a),
          cell([para([new ImageRun({ data: crops.b.data, type: "png", transformation: sb })])], NW.b),
        ],
      }));
    }
    return new Table({
      width: { size: 14400, type: WidthType.DXA },
      columnWidths: [NW.n, NW.cat, NW.zone, NW.text, NW.a, NW.b],
      rows,
    });
  }

  const modeCaption = ctx.mode === "overlay"
    ? (ctx.overlayNote || "Overlay view: dark = unchanged.")
    : "Slider view: A is left of the line, B is right of it.";

  // ----- header block -----
  const children = [
    new Paragraph({ children: [new TextRun({ text: ctx.title, bold: true, size: 36, font: "Arial" })], spacing: { after: 100 } }),
  ];
  if (ctx.setMode) {
    children.push(
      para(runs(`Set A (before): ${ctx.fileA.name} — ${ctx.fileA.pages} sheets`, { size: 20 })),
      para(runs(`Set B (after): ${ctx.fileB.name} — ${ctx.fileB.pages} sheets`, { size: 20 })),
    );
  } else {
    children.push(
      para(runs(`Drawing A (before): ${ctx.fileA.name}${ctx.fileA.pages > 1 ? ` — page ${ctx.fileA.page}` : ""}`, { size: 20 })),
      para(runs(`Drawing B (after): ${ctx.fileB.name}${ctx.fileB.pages > 1 ? ` — page ${ctx.fileB.page}` : ""}`, { size: 20 })),
    );
  }
  children.push(para(runs(`${ctx.preparedBy ? "Prepared by " + ctx.preparedBy + " · " : ""}${ctx.date}`, { size: 20, color: "555555" }), { spacing: { after: 160 } }));

  if (!ctx.setMode) {
    // ----- one drawing each: overview image (compare view with numbered pins), then the notes -----
    const ov = await ctx.getOverview(3e6);
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { after: 60 },
      children: [new ImageRun({ data: ov.data, type: "png", transformation: fit(ov.w, ov.h, 940, 520) })],
    }));
    children.push(para(runs(
      ctx.mode === "overlay" ? modeCaption : "Slider view: A is left of the line, B is right of it.",
      { size: 16, color: "666666", italics: true }), { alignment: AlignmentType.CENTER }));
    children.push(new Paragraph({
      pageBreakBefore: true, spacing: { after: 120 },
      children: [new TextRun({ text: `Notes (${ctx.notes.length})`, bold: true, size: 28, font: "Arial" })],
    }));
    children.push(await notesTable(ctx.notes));
  } else {
    // ----- whole sets: summary of every sheet, then one section per sheet that has notes -----
    const SW = { num: 1700, title: 5900, status: 3400, a: 1100, b: 1100, notes: 1200 };   // = 14400
    const sh = (t, w) => cell([para(runs(t, { bold: true, size: 18 }))], w, { shading: shade });
    const sumRows = [new TableRow({
      tableHeader: true, cantSplit: true,
      children: [sh("Sheet", SW.num), sh("Title", SW.title), sh("Status", SW.status), sh("Set A", SW.a), sh("Set B", SW.b), sh("Notes", SW.notes)],
    })];
    for (const s of ctx.sheets) {
      sumRows.push(new TableRow({
        cantSplit: true,
        children: [
          cell([para(runs(s.num || "—", { bold: true }))], SW.num),
          cell([para(runs(s.title || ""))], SW.title),
          cell([para(runs(s.statusText, { color: STATUS_COLOR[s.status] || "333333", bold: s.status === "changed" }))], SW.status),
          cell([para(runs(s.a ? `p.${s.a}` : "–"))], SW.a),
          cell([para(runs(s.b ? `p.${s.b}` : "–"))], SW.b),
          cell([para(runs(String(s.notes)))], SW.notes),
        ],
      }));
    }
    children.push(new Paragraph({
      spacing: { after: 100 },
      children: [new TextRun({ text: `Sheets (${ctx.sheets.length})`, bold: true, size: 28, font: "Arial" })],
    }));
    children.push(new Table({
      width: { size: 14400, type: WidthType.DXA },
      columnWidths: [SW.num, SW.title, SW.status, SW.a, SW.b, SW.notes],
      rows: sumRows,
    }));
    children.push(para(runs(
      "Change flags compare a reduced picture of each sheet and are a guide, not proof. " + modeCaption,
      { size: 16, color: "666666", italics: true }), { spacing: { before: 100 } }));

    // per-sheet sections
    for (const s of ctx.sheets) {
      if (!s.notes) continue;
      const list = ctx.notes.filter((n) => n.sheetIdx === s.idx);
      if (!list.length) continue;
      children.push(new Paragraph({
        pageBreakBefore: true, spacing: { after: 80 },
        children: [
          new TextRun({ text: s.num || "Sheet", bold: true, size: 28, font: "Arial" }),
          new TextRun({ text: s.title ? ` — ${s.title}` : "", size: 24, font: "Arial" }),
          new TextRun({ text: `    ${s.statusText}`, size: 20, color: STATUS_COLOR[s.status] || "666666", font: "Arial" }),
        ],
      }));
      const ov = await ctx.getOverview(2.5e6, s.a, s.b);
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { after: 100 },
        children: [new ImageRun({ data: ov.data, type: "png", transformation: fit(ov.w, ov.h, 940, 340) })],
      }));
      children.push(await notesTable(list));
    }

    // notes whose sheet pairing was changed afterwards
    const orphans = ctx.notes.filter((n) => n.sheetIdx === 9999);
    if (orphans.length) {
      children.push(new Paragraph({
        pageBreakBefore: true, spacing: { after: 80 },
        children: [new TextRun({ text: "Other notes", bold: true, size: 28, font: "Arial" })],
      }));
      children.push(await notesTable(orphans));
    }
  }
  children.push(para(runs(ctx.zoneNote, { size: 16, color: "666666", italics: true }), { spacing: { before: 120 } }));

  const doc = new Document({
    creator: ctx.preparedBy || "Drawings Hub",
    title: ctx.title,
    styles: { default: { document: { run: { font: "Arial", size: 20 } } } },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840, orientation: PageOrientation.LANDSCAPE },   // US Letter landscape
          margin: { top: 720, right: 720, bottom: 720, left: 720 },
        },
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: `${ctx.title} · Page `, size: 16, color: "777777", font: "Arial" }),
              new TextRun({ children: [PageNumber.CURRENT], size: 16, color: "777777", font: "Arial" }),
            ],
          })],
        }),
      },
      children,
    }],
  });

  const blob = await Packer.toBlob(doc);
  download(blob, `${ctx.slug}_${ctx.dateISO}.docx`);
}

/* ------------------------------------------------------------------ *
 *  Excel
 * ------------------------------------------------------------------ */
export async function exportExcel(ctx) {
  await loadLib("exceljs");
  const wb = new window.ExcelJS.Workbook();
  wb.creator = ctx.preparedBy || "Drawings Hub";
  wb.created = new Date();

  const thin = { style: "thin", color: { argb: "FFBFBFBF" } };
  const box = { top: thin, left: thin, bottom: thin, right: thin };
  const headerStyle = (row) => {
    row.height = 24;
    row.eachCell((c) => {
      c.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Arial", size: 11 };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF5B3FD6" } };
      c.alignment = { vertical: "middle", horizontal: "left" };
      c.border = box;
    });
  };

  /* ---- Sheet 1: Notes (one row per note; filterable; whole sets get a Sheet column) ---- */
  const ws = wb.addWorksheet("Notes", { views: [{ state: "frozen", ySplit: 1 }] });
  const cols = [{ header: "#", key: "n", width: 6 }];
  if (ctx.setMode) cols.push({ header: "Sheet", key: "sheet", width: 14 });
  cols.push(
    { header: "Type", key: "cat", width: 12 },
    { header: "Zone", key: "zone", width: 8 },
    { header: "Note", key: "text", width: 70 },
    { header: ctx.setMode ? "Set A page" : "Drawing A page", key: "pa", width: 15 },
    { header: ctx.setMode ? "Set B page" : "Drawing B page", key: "pb", width: 15 },
    { header: "Added", key: "t", width: 20 },
  );
  ws.columns = cols;
  headerStyle(ws.getRow(1));

  for (const n of ctx.notes) {
    const r = ws.addRow({ n: n.n, sheet: n.sheet, cat: n.cat, zone: n.zone, text: n.text || "",
                          pa: n.pageA || "–", pb: n.pageB || "–", t: new Date(n.created) });
    r.eachCell((c) => {
      c.font = { name: "Arial", size: 11 };
      c.alignment = { vertical: "top", wrapText: true };
      c.border = box;
    });
    r.getCell("t").numFmt = "yyyy-mm-dd hh:mm";
    r.getCell("n").alignment = { vertical: "top", horizontal: "center" };
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: "1:1" };

  /* ---- Sheet 2 (whole sets only): every sheet and its status ---- */
  if (ctx.setMode && ctx.sheets) {
    const ss = wb.addWorksheet("Sheets", { views: [{ state: "frozen", ySplit: 1 }] });
    ss.columns = [
      { header: "Sheet", key: "num", width: 16 },
      { header: "Title", key: "title", width: 50 },
      { header: "Status", key: "status", width: 24 },
      { header: "Set A page", key: "a", width: 12 },
      { header: "Set B page", key: "b", width: 12 },
      { header: "Notes", key: "notes", width: 9 },
    ];
    headerStyle(ss.getRow(1));
    for (const s of ctx.sheets) {
      const r = ss.addRow({ num: s.num, title: s.title, status: s.statusText, a: s.a || "–", b: s.b || "–", notes: s.notes });
      r.eachCell((c) => {
        c.font = { name: "Arial", size: 11 };
        c.alignment = { vertical: "top", wrapText: true };
        c.border = box;
      });
      if (s.status === "changed") r.getCell("status").font = { name: "Arial", size: 11, bold: true, color: { argb: "FFB45309" } };
      if (s.status === "onlyA") r.getCell("status").font = { name: "Arial", size: 11, color: { argb: "FFB91C1C" } };
      if (s.status === "onlyB") r.getCell("status").font = { name: "Arial", size: 11, color: { argb: "FF047857" } };
    }
    ss.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 6 } };
    ss.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: "1:1" };
  }

  /* ---- Details (what was compared) ---- */
  const ds = wb.addWorksheet("Details");
  ds.columns = [{ width: 22 }, { width: 80 }];
  const rows = ctx.setMode ? [
    ["Title", ctx.title],
    ["Prepared by", ctx.preparedBy || ""],
    ["Date", ctx.date],
    ["Set A (before)", `${ctx.fileA.name} — ${ctx.fileA.pages} sheets`],
    ["Set B (after)", `${ctx.fileB.name} — ${ctx.fileB.pages} sheets`],
    ["Sheets compared", ctx.sheets ? ctx.sheets.length : 0],
    ["Number of notes", ctx.notes.length],
    ["Change flags", "Compare a reduced picture of each sheet. A guide, not proof."],
    ["Zone key", ctx.zoneNote],
  ] : [
    ["Title", ctx.title],
    ["Prepared by", ctx.preparedBy || ""],
    ["Date", ctx.date],
    ["Drawing A (before)", ctx.fileA.name + (ctx.fileA.pages > 1 ? ` — page ${ctx.fileA.page} of ${ctx.fileA.pages}` : "")],
    ["Drawing B (after)", ctx.fileB.name + (ctx.fileB.pages > 1 ? ` — page ${ctx.fileB.page} of ${ctx.fileB.pages}` : "")],
    ["Number of notes", ctx.notes.length],
    ["Zone key", ctx.zoneNote],
  ];
  rows.forEach(([k, v]) => {
    const r = ds.addRow([k, v]);
    r.getCell(1).font = { bold: true, name: "Arial", size: 11 };
    r.getCell(2).font = { name: "Arial", size: 11 };
    r.getCell(2).alignment = { wrapText: true, vertical: "top", horizontal: "left" };
    r.getCell(1).alignment = { vertical: "top" };
  });

  const buf = await wb.xlsx.writeBuffer();
  download(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
           `${ctx.slug}_${ctx.dateISO}.xlsx`);
}
