/* ------------------------------------------------------------------ *
 *  compare-export.js — Word (.docx) and Excel (.xlsx) export for the
 *  Compare page. Loaded on demand by compare-page.js (dynamic import).
 *
 *  Exports: exportWord(ctx), exportExcel(ctx)  — ctx is described at the
 *  top of compare-page.js. Both libraries are fetched from a CDN the
 *  first time they're needed, then cached for the session.
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

const fmtDateTime = (ms) => {
  const d = new Date(ms);
  return isNaN(d) ? "" : d.toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

/* ------------------------------------------------------------------ *
 *  Word
 * ------------------------------------------------------------------ */
const CAT_COLOR = { Changed: "B45309", Added: "047857", Removed: "B91C1C", Question: "5B3FD6", Other: "4B5563" };

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

  // ----- header block -----
  const children = [
    new Paragraph({ children: [new TextRun({ text: ctx.title, bold: true, size: 36, font: "Arial" })], spacing: { after: 100 } }),
    para(runs(`Drawing A (before): ${ctx.fileA.name}${ctx.fileA.pages > 1 ? ` — page ${ctx.fileA.page}` : ""}`, { size: 20 })),
    para(runs(`Drawing B (after): ${ctx.fileB.name}${ctx.fileB.pages > 1 ? ` — page ${ctx.fileB.page}` : ""}`, { size: 20 })),
    para(runs(`${ctx.preparedBy ? "Prepared by " + ctx.preparedBy + " · " : ""}${ctx.date}`, { size: 20, color: "555555" }), { spacing: { after: 160 } }),
  ];

  // ----- overview image (compare view with numbered pins) -----
  const ov = await ctx.getOverview(3e6);
  const ovSize = fit(ov.w, ov.h, 940, 520);
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 60 },
    children: [new ImageRun({ data: ov.data, type: "png", transformation: ovSize })],
  }));
  children.push(para(runs(
    ctx.mode === "overlay"
      ? "Overlay view: red = only in A, cyan = only in B, dark = unchanged."
      : "Slider view: A is left of the line, B is right of it.",
    { size: 16, color: "666666", italics: true }), { alignment: AlignmentType.CENTER }));

  // ----- notes table -----
  const W = { n: 520, cat: 1100, zone: 1180, text: 5200, a: 3200, b: 3200 };   // = 14400 twips (10 in)
  const total = Object.values(W).reduce((a, b) => a + b, 0);
  const head = (t, w) => cell([para(runs(t, { bold: true, size: 18 }))], w,
    { shading: { type: ShadingType.CLEAR, fill: "EDEBFA", color: "auto" } });

  const rows = [new TableRow({
    tableHeader: true, cantSplit: true,
    children: [head("#", W.n), head("Type", W.cat), head("Zone", W.zone), head("Note", W.text), head("Drawing A (before)", W.a), head("Drawing B (after)", W.b)],
  })];

  for (const n of ctx.notes) {
    const crops = await ctx.getCrops(n);      // one at a time to keep memory low
    const sa = fit(crops.a.w, crops.a.h, 200, 150), sb = fit(crops.b.w, crops.b.h, 200, 150);
    const multi = ctx.fileA.pages > 1 || ctx.fileB.pages > 1;
    rows.push(new TableRow({
      cantSplit: true,
      children: [
        cell([para(runs(String(n.n), { bold: true }))], W.n),
        cell([para(runs(n.cat, { bold: true, color: CAT_COLOR[n.cat] || "333333" }))], W.cat),
        cell([para(runs(n.zone, { bold: true })), ...(multi ? [para(runs(`A p.${n.pageA} · B p.${n.pageB}`, { size: 16, color: "666666" }))] : [])], W.zone),
        cell([para(runs(n.text || "—"))], W.text),
        cell([para([new ImageRun({ data: crops.a.data, type: "png", transformation: sa })])], W.a),
        cell([para([new ImageRun({ data: crops.b.data, type: "png", transformation: sb })])], W.b),
      ],
    }));
  }

  children.push(new Paragraph({
    pageBreakBefore: true, spacing: { after: 120 },
    children: [new TextRun({ text: `Notes (${ctx.notes.length})`, bold: true, size: 28, font: "Arial" })],
  }));
  children.push(new Table({
    width: { size: total, type: WidthType.DXA },
    columnWidths: [W.n, W.cat, W.zone, W.text, W.a, W.b],
    rows,
  }));
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

  /* ---- Sheet 1: Notes (one row per note; filterable) ---- */
  const ws = wb.addWorksheet("Notes", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "#", key: "n", width: 6 },
    { header: "Type", key: "cat", width: 12 },
    { header: "Zone", key: "zone", width: 8 },
    { header: "Note", key: "text", width: 70 },
    { header: "Drawing A page", key: "pa", width: 15 },
    { header: "Drawing B page", key: "pb", width: 15 },
    { header: "Added", key: "t", width: 20 },
  ];

  const head = ws.getRow(1);
  head.height = 24;
  head.eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Arial", size: 11 };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF5B3FD6" } };
    c.alignment = { vertical: "middle", horizontal: "left" };
    c.border = box;
  });

  for (const n of ctx.notes) {
    const r = ws.addRow({ n: n.n, cat: n.cat, zone: n.zone, text: n.text || "",
                          pa: n.pageA, pb: n.pageB, t: new Date(n.created) });
    r.eachCell((c) => {
      c.font = { name: "Arial", size: 11 };
      c.alignment = { vertical: "top", wrapText: true };
      c.border = box;
    });
    r.getCell("t").numFmt = "yyyy-mm-dd hh:mm";
    r.getCell("n").alignment = { vertical: "top", horizontal: "center" };
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 7 } };
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: "1:1" };

  /* ---- Sheet 2: Details (what was compared) ---- */
  const ds = wb.addWorksheet("Details");
  ds.columns = [{ width: 22 }, { width: 80 }];
  const rows = [
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
