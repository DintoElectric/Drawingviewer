// Node adapter: turn a PDF file into the normalized text-items array that
// extract-core expects. Uses the legacy pdfjs build (no DOM/worker needed).
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFile } from "node:fs/promises";

export async function itemsFromPdf(path) {
  const data = new Uint8Array(await readFile(path));
  const doc = await getDocument({ data, useSystemFonts: true }).promise;
  const page = await doc.getPage(1); // title block is on the sheet page
  const vp = page.getViewport({ scale: 1 });
  const W = vp.width, H = vp.height;
  const tc = await page.getTextContent();
  const items = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    // pdf.js transform: [a,b,c,d,e,f]; e,f are the position, d ~ glyph height.
    const [a, b, c, d, e, f] = it.transform;
    const xTopLeft = e / W;
    const yTopLeft = (H - f) / H; // flip to top-left origin
    const h = Math.abs(d) / H;
    items.push({ str: it.str, x: xTopLeft, y: yTopLeft, h });
  }
  await doc.destroy();
  return { items, aspect: W / H };
}
