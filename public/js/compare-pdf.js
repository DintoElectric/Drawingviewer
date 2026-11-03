/* ------------------------------------------------------------------ *
 *  compare-pdf.js — a PDF of the comparison at an exact paper size (Arch E, Arch D, ...).
 *  Loaded on demand by compare-page.js.
 *
 *  The sheets are embedded as VECTOR pages (not pictures), so lines stay sharp at any size and the
 *  file stays small. The overlay is built the same way as on screen: the newer sheet and the older
 *  sheet are each tinted ("lighten"), then laid over each other ("multiply"), using PDF transparency.
 *  Open the PDF in Bluebeam (or any viewer) and print at 100% / Actual size: it is already the paper size.
 *
 *  Exports: buildLargeFormatPdf(job, onProgress, signal) -> { blob, pages, scales }
 * ------------------------------------------------------------------ */

const PDF_LIB_URLS = [
  "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js",
  "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js",
  "https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js",
];

// long side x short side, in inches (landscape)
export const PAPERS = {
  arche:   { name: "Arch E",   long: 48, short: 36 },
  arche1:  { name: "Arch E1",  long: 42, short: 30 },
  archd:   { name: "Arch D",   long: 36, short: 24 },
  archc:   { name: "Arch C",   long: 24, short: 18 },
  ansie:   { name: "ANSI E",   long: 44, short: 34 },
  ansid:   { name: "ANSI D",   long: 34, short: 22 },
  tabloid: { name: "Tabloid",  long: 17, short: 11 },
  letter:  { name: "Letter",   long: 11, short: 8.5 },
};

let pdfLibPromise = null;
function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { s.remove(); reject(new Error("load failed")); };
    document.head.appendChild(s);
  });
}
async function loadPdfLib() {
  if (window.PDFLib && window.PDFLib.PDFDocument) return window.PDFLib;
  if (!pdfLibPromise) {
    pdfLibPromise = (async () => {
      for (const url of PDF_LIB_URLS) {
        try { await loadScript(url); } catch (e) { continue; }
        if (window.PDFLib && window.PDFLib.PDFDocument) return window.PDFLib;
      }
      throw new Error("The PDF library couldn't be loaded. Check your connection, and that your site allows scripts from cdnjs.cloudflare.com or cdn.jsdelivr.net.");
    })().catch((e) => { pdfLibPromise = null; throw e; });
  }
  return pdfLibPromise;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const hex = (h) => [1, 3, 5].map((i) => parseInt(String(h).slice(i, i + 2), 16) / 255);

// Standard PDF fonts only know Latin-1: tidy anything else so a sheet title can never break the file.
const clean = (t) => String(t == null ? "" : t)
  .replace(/\u2194/g, " <-> ").replace(/[\u2013\u2014]/g, "-").replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
  .replace(/\u2026/g, "...").replace(/\s+/g, " ")
  .replace(/[^\x20-\x7E\u00A1-\u00FF]/g, "?").trim();

function wrapText(text, font, size, maxW) {
  const lines = [];
  let cur = "";
  for (let word of clean(text).split(" ")) {
    while (font.widthOfTextAtSize(word, size) > maxW && word.length > 1) {       // a word longer than the line: cut it
      let n = word.length;
      while (n > 1 && font.widthOfTextAtSize(word.slice(0, n), size) > maxW) n--;
      if (cur) { lines.push(cur); cur = ""; }
      lines.push(word.slice(0, n)); word = word.slice(n);
    }
    const t = cur ? cur + " " + word : word;
    if (font.widthOfTextAtSize(t, size) <= maxW) cur = t;
    else { if (cur) lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

// Turns a source (a PDF page, or an image) into something that can be drawn: a form XObject with known size.
async function imageToPng(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 8192 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Couldn't read an image."))), "image/png"));
  const out = { bytes: new Uint8Array(await blob.arrayBuffer()), w: bmp.width, h: bmp.height };
  c.width = c.height = 0; bmp.close && bmp.close();
  return out;
}

export async function buildLargeFormatPdf(job, onProgress, signal) {
  const PL = await loadPdfLib();
  const { PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState, setGraphicsState, concatTransformationMatrix,
          drawObject, rectangle, clip, endPath, moveTo, lineTo, closePath, appendBezierCurve, fill, stroke,
          setFillingRgbColor, setStrokingRgbColor, setLineWidth, setLineCap, setLineJoin, LineCapStyle, LineJoinStyle } = PL;
  const paper = PAPERS[job.paper];
  if (!paper) throw new Error("Unknown paper size.");
  const check = () => { if (signal && signal.aborted) throw new Error("Cancelled."); };

  const out = await PDFDocument.create();
  const ctx = out.context;
  out.setTitle(clean(job.header.title) || "Drawing comparison");
  out.setCreator("Drawings Hub");
  out.setProducer("Drawings Hub");
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);

  /* ---------- sources: embed every needed page once ---------- */
  const sheets = job.items.filter((it) => !it.noImage);
  const layers = new Map();                                   // "A:3" -> { ref, W, H, m }
  for (const which of ["A", "B"]) {
    const wanted = [...new Set(sheets.map((it) => (which === "A" ? it.pa : it.pb)).filter(Boolean))].sort((x, y) => x - y);
    if (!wanted.length) continue;
    const file = job.files[which];
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    check();
    if (isPdf) {
      let src;
      try { src = await PDFDocument.load(new Uint8Array(await file.arrayBuffer())); }
      catch (e) {
        if (/encrypt/i.test(String(e && (e.name + e.message)))) throw new Error(`"${file.name}" is protected, so its pages can't be copied into a new PDF.`);
        throw new Error(`Couldn't read "${file.name}" (${(e && e.message) || "unknown problem"}).`);
      }
      const pages = wanted.map((n) => src.getPage(n - 1));
      const boxes = pages.map((p) => { const cb = p.getCropBox(); return { left: cb.x, bottom: cb.y, right: cb.x + cb.width, top: cb.y + cb.height }; });
      let emb;
      try { emb = await out.embedPages(pages, boxes); }
      catch (e) { throw new Error(`Couldn't copy pages from "${file.name}" (${(e && e.message) || "unknown problem"}).`); }
      pages.forEach((p, i) => {
        const cb = p.getCropBox(), rot = ((p.getRotation().angle % 360) + 360) % 360;
        const w = cb.width, h = cb.height;
        const m = rot === 90 ? [0, -1, 1, 0, 0, w] : rot === 180 ? [-1, 0, 0, -1, w, h] : rot === 270 ? [0, 1, -1, 0, h, 0] : [1, 0, 0, 1, 0, 0];
        layers.set(`${which}:${wanted[i]}`, { ref: emb[i].ref, W: rot % 180 ? h : w, H: rot % 180 ? w : h, m });
      });
    } else {                                                  // a picture of a drawing
      const img = await imageToPng(file);
      const pi = await out.embedPng(img.bytes);
      layers.set(`${which}:1`, { ref: pi.ref, W: img.w, H: img.h, m: [img.w, 0, 0, img.h, 0, 0] });
    }
  }
  const layerOf = (which, n) => (n ? layers.get(`${which}:${n}`) || null : null);

  // A sheet on paper-white, optionally tinted: the page is drawn, then a colour is "lightened" over it, so black lines
  // take the colour and white stays white. Wrapped in a transparency group so it can be blended as a whole.
  const lightenGs = ctx.register(ctx.obj({ Type: "ExtGState", BM: "Lighten" }));
  function group(layer, tint) {
    const res = ctx.obj({ XObject: { Src: layer.ref }, ExtGState: { GSL: lightenGs } });
    let c = `1 1 1 rg 0 0 ${layer.W} ${layer.H} re f q ${layer.m.join(" ")} cm /Src Do Q`;
    if (tint) c += ` q /GSL gs ${tint.map((v) => v.toFixed(4)).join(" ")} rg 0 0 ${layer.W} ${layer.H} re f Q`;
    return ctx.register(ctx.stream(c, { Type: "XObject", Subtype: "Form", BBox: [0, 0, layer.W, layer.H], Resources: res, Group: { S: "Transparency", I: true, K: false } }));
  }

  const colA = hex(job.colors.a), colB = hex(job.colors.b);
  const scales = [];
  let pageCount = 0;

  /* ---------- one page per sheet ---------- */
  for (let i = 0; i < sheets.length; i++) {
    check();
    if (onProgress) onProgress(i, sheets.length, sheets[i].num);
    const it = sheets[i];
    const lb = layerOf("B", it.pb), la = layerOf("A", it.pa);
    const frameL = lb || la;
    if (!frameL) continue;
    const WB = frameL.W, HB = frameL.H;                                  // the frame is the newer sheet (or the older one if that is all there is)
    const land = WB >= HB;
    const pw = (land ? paper.long : paper.short) * 72, ph = (land ? paper.short : paper.long) * 72;
    const page = out.addPage([pw, ph]);
    pageCount++;

    const fs = clamp((pw / 72) * 0.28, 7, 16);                           // legend text size
    const legendH = fs * 3.2;
    let m, s, tx, ty, compact = false;
    if (job.fit) {                                                       // fit to the paper, with a margin and a strip for the legend
      m = Math.max(14, Math.min(pw, ph) * 0.012);
      const availW = pw - 2 * m, availH = ph - 2 * m - legendH;
      s = Math.min(availW / WB, availH / HB);
      tx = m + (availW - WB * s) / 2; ty = m + legendH + (availH - HB * s) / 2;
    } else {                                                             // actual size: exactly 100% if it fits the paper, otherwise shrunk just enough; no margins
      m = 0;
      s = Math.min(1, pw / WB, ph / HB);
      tx = (pw - WB * s) / 2; ty = (ph - HB * s) / 2;
      compact = ty < legendH + 4;                                        // no free strip for the legend: one small line inside the sheet's own margin
    }
    const fw = WB * s, fh = HB * s;
    scales.push({ num: it.num, percent: Math.round(s * 100) });

    page.drawRectangle({ x: 0, y: 0, width: pw, height: ph, color: rgb(1, 1, 1) });

    // frame position helpers (normalised 0..1 of the newer sheet, y down)  ->  page points (y up)
    const px = (nx) => tx + nx * fw, py = (ny) => ty + (1 - ny) * fh;
    const place = (name, mat, gs, clipRect) => {
      const ops = [pushGraphicsState()];
      if (clipRect) ops.push(rectangle(clipRect[0], clipRect[1], clipRect[2], clipRect[3]), clip(), endPath());
      if (gs) ops.push(setGraphicsState(gs));
      ops.push(concatTransformationMatrix(...mat), drawObject(name), popGraphicsState());
      page.pushOperators(...ops);
    };
    // the older sheet sits inside the newer sheet's frame, fitted and centred (as on screen)
    const aMat = (la) => {
      const sa = Math.min(WB / la.W, HB / la.H) * s;
      return [sa, 0, 0, sa, tx + (fw - la.W * sa) / 2, ty + (fh - la.H * sa) / 2];
    };

    if (job.style === "overlay") {
      if (lb) place(page.node.newXObject("GB", group(lb, colB)), [s, 0, 0, s, tx, ty]);
      if (la) {
        const gsM = page.node.newExtGState("GSM", ctx.obj({ Type: "ExtGState", BM: "Multiply", ca: clamp(job.opacity, 0, 1), CA: clamp(job.opacity, 0, 1) }));
        place(page.node.newXObject("GA", group(la, colA)), aMat(la), gsM);
      }
    } else {                                                             // split view: older on the left of the line, newer on the right
      const dx = tx + fw * clamp(job.divider, 0, 1);
      if (lb) place(page.node.newXObject("GB", group(lb, null)), [s, 0, 0, s, tx, ty]);
      page.drawRectangle({ x: tx, y: ty, width: dx - tx, height: fh, color: rgb(1, 1, 1) });      // nothing on the left if the older sheet is missing
      if (la) place(page.node.newXObject("GA", group(la, null)), aMat(la), null, [tx, ty, dx - tx, fh]);
      const lw = Math.max(1.5, pw * 0.0009);
      page.pushOperators(pushGraphicsState(), setStrokingRgbColor(0.486, 0.435, 0.941), setLineWidth(lw), moveTo(dx, ty), lineTo(dx, ty + fh), stroke(), popGraphicsState());
    }

    /* ---------- highlights (same look as on screen: translucent, lines show through) ---------- */
    if (it.marks && it.marks.length) {
      const gs = (a) => page.node.newExtGState("GSH", ctx.obj({ Type: "ExtGState", BM: "Multiply", ca: a, CA: a }));
      const g30 = gs(0.3), g45 = gs(0.45), g100 = gs(1);
      const bw = Math.max(1.2, pw * 0.0008), mw = Math.max(8, fw / 70);
      const K = 0.5522847498;
      const ellipse = (cx, cy, rx, ry) => [moveTo(cx + rx, cy),
        appendBezierCurve(cx + rx, cy + K * ry, cx + K * rx, cy + ry, cx, cy + ry), appendBezierCurve(cx - K * rx, cy + ry, cx - rx, cy + K * ry, cx - rx, cy),
        appendBezierCurve(cx - rx, cy - K * ry, cx - K * rx, cy - ry, cx, cy - ry), appendBezierCurve(cx + K * rx, cy - ry, cx + rx, cy - K * ry, cx + rx, cy), closePath()];
      for (const mk of it.marks) {
        const c = hex(mk.color);
        if (mk.shape === "free") {
          const ops = [pushGraphicsState(), setGraphicsState(g45), setStrokingRgbColor(...c), setLineWidth(mw), setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round)];
          for (let k = 0; k + 1 < mk.pts.length; k += 2) ops.push(k ? lineTo(px(mk.pts[k]), py(mk.pts[k + 1])) : moveTo(px(mk.pts[0]), py(mk.pts[1])));
          ops.push(stroke(), popGraphicsState());
          page.pushOperators(...ops);
          continue;
        }
        const x = px(mk.x), y = py(mk.y + mk.h), w = mk.w * fw, h = mk.h * fh;
        const shape = mk.shape === "ellipse" ? ellipse(x + w / 2, y + h / 2, w / 2, h / 2) : [rectangle(x, y, w, h)];
        page.pushOperators(pushGraphicsState(), setGraphicsState(g30), setFillingRgbColor(...c), ...shape, fill(), popGraphicsState());
        page.pushOperators(pushGraphicsState(), setGraphicsState(g100), setStrokingRgbColor(...c), setLineWidth(bw), ...(mk.shape === "ellipse" ? ellipse(x + w / 2, y + h / 2, w / 2, h / 2) : [rectangle(x, y, w, h)]), stroke(), popGraphicsState());
      }
    }

    /* ---------- numbered pins for notes ---------- */
    if (it.notes && it.notes.length) {
      const r = clamp(fw / 120, 9, 40);
      const K = 0.5522847498;
      for (const n of it.notes) {
        const cx = px(n.x), cy = py(n.y);
        page.pushOperators(pushGraphicsState(), setFillingRgbColor(0.357, 0.247, 0.839), setStrokingRgbColor(1, 1, 1), setLineWidth(r / 6),
          moveTo(cx + r, cy), appendBezierCurve(cx + r, cy + K * r, cx + K * r, cy + r, cx, cy + r), appendBezierCurve(cx - K * r, cy + r, cx - r, cy + K * r, cx - r, cy),
          appendBezierCurve(cx - r, cy - K * r, cx - K * r, cy - r, cx, cy - r), appendBezierCurve(cx + K * r, cy - r, cx + r, cy - K * r, cx + r, cy), closePath(), PL.fillAndStroke(), popGraphicsState());
        const label = String(n.n), size = r * 1.15, w = bold.widthOfTextAtSize(label, size);
        page.drawText(label, { x: cx - w / 2, y: cy - size * 0.35, size, font: bold, color: rgb(1, 1, 1) });
      }
    }

    /* ---------- legend, bottom left: what this is, the colour key, and the scale ---------- */
    const h = job.header;
    const head = it.num ? `${clean(it.num)}${it.title ? " - " + clean(it.title) : ""}${it.status ? "   [" + clean(it.status) + "]" : ""}` : clean(h.title);
    const lfs = compact ? clamp(fs * 0.62, 6, 9) : fs;                   // legend text size
    const lx0 = compact ? 8 : (job.fit ? m : tx), ly = compact ? 6 : (job.fit ? m : Math.max(4, ty - legendH + fs * 0.6));
    const keyW = () => (job.style === "overlay" ? 3 * lfs * 1.4 + font.widthOfTextAtSize("Only in A (older)   Only in B (newer)   In both   ", lfs) : font.widthOfTextAtSize("Split view: A (older) is left of the line, B (newer) is right.   ", lfs));
    const scaleText = `Scale ${Math.round(s * 100)}%${compact ? "" : " of the original sheet"}   Printed ${clean(h.printed)}`;
    const names = compact ? "" : `${h.setMode ? "Set A" : "A"}: ${clean(h.aName)}   ${h.setMode ? "Set B" : "B"}: ${clean(h.bName)}   `;
    if (compact) {                                                       // a white backing so the line stays readable over the sheet's border
      const w = keyW() + font.widthOfTextAtSize(scaleText, lfs) + 16;
      page.pushOperators(pushGraphicsState(), setGraphicsState(page.node.newExtGState("GSW", ctx.obj({ Type: "ExtGState", ca: 0.9, CA: 0.9 }))),
        setFillingRgbColor(1, 1, 1), rectangle(lx0 - 4, ly - 3, w, lfs + 7), fill(), popGraphicsState());
    } else {
      page.drawText(head, { x: lx0, y: ly + lfs * 1.45, size: lfs * 1.1, font: bold, color: rgb(0.1, 0.1, 0.12) });
    }
    let lx = lx0;
    const text = (t, f = font) => { const w = f.widthOfTextAtSize(t, lfs); page.drawText(t, { x: lx, y: ly, size: lfs, font: f, color: rgb(0.2, 0.2, 0.22) }); lx += w; };
    const swatch = (c) => { page.drawRectangle({ x: lx, y: ly - lfs * 0.12, width: lfs, height: lfs, color: rgb(...c), borderColor: rgb(0.4, 0.4, 0.4), borderWidth: 0.4 }); lx += lfs * 1.4; };
    if (job.style === "overlay") {
      swatch(colA); text("Only in A (older)   "); swatch(colB); text("Only in B (newer)   "); swatch([0.1, 0.1, 0.1]); text("In both   ");
    } else {
      text("Split view: A (older) is left of the line, B (newer) is right.   ");
    }
    if (names) text(names);
    text(scaleText);
  }

  /* ---------- notes: plain text pages (Letter), so they stay readable ---------- */
  const noteRows = job.notesList || [];
  if (noteRows.length) {
    const PW = 612, PH = 792, M = 40, size = 9.5, lead = 12.5;
    const cols = { n: M, type: M + 26, sheet: M + 92, zone: M + 190, text: M + 232 }, textW = PW - M - cols.text;
    let page = null, y = 0;
    const newPage = (first) => {
      page = out.addPage([PW, PH]); pageCount++;
      page.drawText(first ? "Notes" : "Notes (continued)", { x: M, y: PH - M - 6, size: 16, font: bold, color: rgb(0.1, 0.1, 0.12) });
      page.drawText(clean(job.header.title), { x: M, y: PH - M - 24, size: 9.5, font, color: rgb(0.35, 0.35, 0.38) });
      y = PH - M - 48;
      for (const [k, label] of [["n", "#"], ["type", "Type"], ["sheet", "Sheet"], ["zone", "Zone"], ["text", "Note"]]) page.drawText(label, { x: cols[k], y, size: 8.5, font: bold, color: rgb(0.35, 0.35, 0.38) });
      page.drawLine({ start: { x: M, y: y - 4 }, end: { x: PW - M, y: y - 4 }, thickness: 0.6, color: rgb(0.7, 0.7, 0.72) });
      y -= 18;
    };
    newPage(true);
    for (const n of noteRows) {
      const lines = wrapText(n.text || "-", font, size, textW);
      const need = lines.length * lead + 6;
      if (y - need < M + 20) newPage(false);
      page.drawText(String(n.n), { x: cols.n, y, size, font: bold, color: rgb(0.1, 0.1, 0.12) });
      page.drawText(clean(n.cat), { x: cols.type, y, size, font, color: rgb(0.1, 0.1, 0.12) });
      wrapText(n.sheet || "", font, size, cols.zone - cols.sheet - 6).slice(0, 2).forEach((l, i) => page.drawText(l, { x: cols.sheet, y: y - i * lead, size, font, color: rgb(0.1, 0.1, 0.12) }));
      page.drawText(clean(n.zone), { x: cols.zone, y, size, font, color: rgb(0.1, 0.1, 0.12) });
      lines.forEach((l, i) => page.drawText(l, { x: cols.text, y: y - i * lead, size, font, color: rgb(0.1, 0.1, 0.12) }));
      y -= need;
    }
    if (job.zoneNote) page.drawText(clean(job.zoneNote), { x: M, y: M - 4, size: 8, font, color: rgb(0.4, 0.4, 0.42) });
  }

  check();
  if (!pageCount) throw new Error("There was nothing to put in the PDF.");
  const bytes = await out.save();
  return { blob: new Blob([bytes], { type: "application/pdf" }), pages: pageCount, scales };
}
