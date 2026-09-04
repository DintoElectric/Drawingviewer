// ingest.mjs — the folder-drop upload path. Anything a person adds to /incoming
// (drag-drop in the GitHub web UI, a git push, etc.) is processed here: read the
// title block, rename to the canonical <SHEET>_Rev<N>.pdf, archive the file it
// supersedes, and rewrite manifest.json. Runs in the GitHub Action, and locally.
//
//   node scripts/ingest.mjs
//
// Uses the SAME extract-core.js as the browser upload page, so both paths name
// and version files identically.

import { readdir, readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { itemsFromPdf } from "./pdf-node.mjs";
import { pickSheetNumber, pickTitle, pickPrintedRev, matchAndPlan } from "../public/js/extract-core.js";

const ROOT = path.resolve(".");
const INCOMING = path.join(ROOT, "incoming");
const SITE = path.join(ROOT, "public");
const DRAWINGS = path.join(SITE, "drawings");
const ARCHIVE = path.join(DRAWINGS, "archive");
const MANIFEST = path.join(SITE, "manifest.json");
const REASON = process.env.INGEST_REASON || "Revised for construction";
const TODAY = new Date().toISOString().slice(0, 10);

async function main() {
  if (!existsSync(INCOMING)) { console.log("No incoming/ folder — nothing to do."); return; }
  const files = (await readdir(INCOMING)).filter((f) => /\.pdf$/i.test(f));
  if (!files.length) { console.log("incoming/ is empty — nothing to do."); return; }

  await mkdir(ARCHIVE, { recursive: true });
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  manifest.drawings = manifest.drawings || {};

  const published = [];
  const skipped = [];

  for (const fname of files) {
    const abs = path.join(INCOMING, fname);
    let sheet, confidence, title, printedRev;
    try {
      const { items } = await itemsFromPdf(abs);
      const sn = pickSheetNumber(items);
      sheet = sn.sheet; confidence = sn.confidence;
      title = pickTitle(items, sheet);
      printedRev = pickPrintedRev(items);
    } catch (e) {
      skipped.push(`${fname} — couldn't read (${e.message})`);
      continue;
    }

    const plan = matchAndPlan({ sheet, confidence, printedRev, title, sourceFilename: fname }, manifest);
    if (plan.status === "unmatched") {
      skipped.push(`${fname} — no sheet number found in the title block; leave it in incoming/ and assign it by hand`);
      continue;
    }

    const entry = manifest.drawings[plan.sheet] || { title: plan.title || plan.sheet, history: [] };

    // archive the superseded current file
    if (plan.status === "supersede" && plan.archiveOldTo && entry.currentFile) {
      const oldAbs = path.join(SITE, entry.currentFile);
      const archAbs = path.join(SITE, plan.archiveOldTo);
      if (existsSync(oldAbs)) {
        await rename(oldAbs, archAbs);
        const prev = (entry.history || []).find((h) => h.rev === entry.currentRev);
        if (prev) prev.file = plan.archiveOldTo;
      }
    }

    // move the incoming file to its canonical name
    const destAbs = path.join(SITE, plan.canonicalFile);
    await mkdir(path.dirname(destAbs), { recursive: true });
    await rename(abs, destAbs);

    entry.title = plan.title || entry.title || plan.sheet;
    entry.currentRev = plan.newRev;
    entry.currentFile = plan.canonicalFile;
    entry.issuedDate = TODAY;
    entry.status = "issued";
    entry.history = (entry.history || []).filter((h) => h.rev !== plan.newRev);
    entry.history.push({ rev: plan.newRev, date: TODAY, reason: REASON, file: plan.canonicalFile });
    manifest.drawings[plan.sheet] = entry;

    published.push(`${plan.sheet} → Rev ${plan.newRev} (from ${fname}${confidence ? `, ${Math.round(confidence*100)}% match` : ""})`);
  }

  if (published.length) {
    manifest.project = manifest.project || {};
    manifest.project.syncedAt = new Date().toISOString();
    await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  }

  console.log("=== Ingest summary ===");
  published.forEach((p) => console.log("  published: " + p));
  skipped.forEach((s) => console.log("  skipped:   " + s));

  // expose a flag the Action reads to decide whether to commit
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `published=${published.length}\n`, { flag: "a" });
  }
  if (!published.length) process.exitCode = 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
