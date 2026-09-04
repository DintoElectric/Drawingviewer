# Drawings Hub — Paul Dinto Electrical

Drawing revision control for the field. The whole point: **the field never builds
off a superseded revision**, and publishing a new drawing is one drag-and-drop —
the system reads the sheet number off the drawing's **own title block** and names
and versions the file for you. The uploaded file name is ignored; `random_scan_08.pdf`
containing sheet E-501 becomes `E-501_Rev1.pdf` automatically.

Built from the Nocturne design handoff. Static site + one serverless function,
deployed **GitHub → Netlify** (same pipeline as the as-built QR app).

## What's here

```
public/                     the deployable site (Netlify publish dir)
  index.html                Drawing index — every sheet + its current rev (screen 01)
  sheet.html                Sheet viewer + version history (screens 02 / 04-lite)
  upload.html               Add revisions — the drag-drop upload flow (screen 03)
  styles.css                Nocturne design-system tokens (verbatim from the handoff)
  app.css                   app layout on top of the tokens
  manifest.json             SOURCE OF TRUTH: sheets, current rev, version history
  drawings/                 the PDFs, canonically named <SHEET>_Rev<N>.pdf
    archive/                superseded revisions land here automatically
  js/
    extract-core.js         the title-block + supersede logic (shared everywhere)
    pdf-browser.js          reads a PDF in the browser (pdf.js from CDN)
    manifest.js, *-page.js  page logic
netlify/functions/
  publish-revisions.js      secure GitHub commit for the in-app upload (token stays server-side)
scripts/
  ingest.mjs                the folder-drop upload path (same extract-core)
  pdf-node.mjs              reads a PDF in Node (pdfjs-dist)
.github/workflows/
  ingest-drawings.yml       runs ingest.mjs when files land in /incoming, then commits
incoming/                   drop-zone for the folder path
```

## The one idea that matters: naming from the title block

`extract-core.js` is the single source of the naming + versioning rule, and **both**
upload paths use it, so they behave identically:

1. Read the PDF's text with positions, find the sheet-number token (`E-101`, `M-201`,
   `FA-101`, `E0.01`…), preferring the bottom-right title-block corner where it's largest.
2. Look it up in `manifest.json`.
   - **Found** → new rev = current + 1 (or the printed rev if it's higher). The new file
     is written as `<SHEET>_Rev<N>.pdf`; the file it **supersedes moves to `drawings/archive/`**.
   - **Not found** → new sheet at Rev 1.
   - **No sheet number readable** → flagged for a human to pick the sheet (never guessed).

That's "replace old versions" and "name from the drawing itself," done in one place.

## Two ways to upload (pick either or both)

### A) In-app, one click — `upload.html`
Drag PDFs onto the page. It reads each title block **in the browser**, shows the auto-match
("E-101 · Rev 4 supersedes Rev 3 · 98% match"), lets you fix anything flagged, then
**Publish** commits everything in one atomic commit via the Netlify function. Netlify redeploys.

Enable it by setting these in **Netlify → Site settings → Environment variables**:

| Var | Value |
| --- | --- |
| `GH_TOKEN` | a fine-grained GitHub token with **Contents: read & write** on this repo |
| `GH_REPO` | `your-org/dinto-drawings-hub` |
| `GH_BRANCH` | `main` (or your deploy branch) |
| `PUBLISH_KEY` | *(optional)* a shared secret; if set, the page must send it — a light gate before this goes fully public |

Until those are set, Publish falls back to downloading a `publish-plan.json` so the flow is
never a dead end.

### B) Folder drop — `/incoming` + the GitHub Action
No app needed. In GitHub, **Add file → Upload files** into `incoming/`, or `git push` PDFs there.
The **Ingest drawings** Action reads the title blocks, renames/archives/updates the manifest,
and commits. Good for bulk drops and for anyone who'd rather live in GitHub. Run it locally too:

```bash
npm install
cp ~/Downloads/*.pdf incoming/
npm run ingest      # then commit the result
```

## Deploy

1. Create the GitHub repo and push this folder.
2. In Netlify: **Add new site → Import from Git**, pick the repo. `netlify.toml` already sets
   publish dir `public/` and the functions dir — no other settings needed.
3. (For in-app publishing) add the env vars above and redeploy.
4. Replace the sample sheets: delete the files in `public/drawings/`, clear `manifest.json`'s
   `drawings` to `{}` (keep the `project` block), and upload your real set through either path.

## Run locally

```bash
npm install
npm run serve       # serves ./public  (the in-app Publish uses the download fallback locally)
```

## Notes / honest edges

- The sheet-number grammar covers standard discipline prefixes; add yours in `extract-core.js`
  (`DISCIPLINE`) if you use others. It's tuned to prefer the title-block corner and to **flag,
  never guess**, when it can't read a number.
- The viewer embeds the sheet PDF and lists its version history from the manifest. The full
  Rev-to-Rev visual **compare** (overlay wipe / changed-area boxes) from the handoff is not
  built yet — see `docs/HANDOFF-STATUS.md` for exactly what's in vs. pending.
- Sample data (Riverbend Medical Center) is fictional placeholder content from the mockup.
