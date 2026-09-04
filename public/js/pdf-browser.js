// pdf-browser.js — browser side of the title-block reader. Loads pdf.js from a
// CDN and returns the same normalized { items, aspect } shape that the Node
// adapter (scripts/pdf-node.mjs) returns, so extract-core.js behaves identically
// whether a file is read in the upload page or by the GitHub Action.

const PDFJS_VERSION = "4.0.379";
const PDFJS_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.mjs`;
const WORKER_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.mjs`;

let pdfjsLib = null;
async function lib() {
  if (!pdfjsLib) {
    pdfjsLib = await import(PDFJS_URL);
    pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URL;
  }
  return pdfjsLib;
}

// Read the title block from the first page of an ArrayBuffer.
export async function itemsFromArrayBuffer(buf) {
  const pdfjs = await lib();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const W = vp.width, H = vp.height;
  const tc = await page.getTextContent();
  const items = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, c, d, e, f] = it.transform;
    items.push({ str: it.str, x: e / W, y: (H - f) / H, h: Math.abs(d) / H });
  }
  await doc.destroy();
  return { items, aspect: W / H };
}

// Render page 1 to a data URL for the little upload preview thumbnails.
export async function thumbnailFromArrayBuffer(buf, maxW = 220) {
  const pdfjs = await lib();
  const doc = await pdfjs.getDocument({ data: buf.slice(0) }).promise;
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const scale = maxW / base.width;
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  const url = canvas.toDataURL("image/png");
  await doc.destroy();
  return url;
}
