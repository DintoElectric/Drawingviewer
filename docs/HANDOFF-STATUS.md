# Handoff status — what's built vs. pending

Mapping this repo back to the five screens in the Nocturne handoff, so it's clear
what's live and what's deliberately left for a later pass. The design system
(`styles.css`) is used verbatim; colors, type, spacing, and the component classes
(`.btn`, `.tag`, `.input`, `.table`, `.card`, `.seg`, dialog) all come from it.

| # | Screen | Status | Where |
| - | ------ | ------ | ----- |
| 01 | Project hub / drawing index | **Built** — sheet table, rev status, search, filter chips, behind-set alert banner | `index.html`, `js/index-page.js` |
| 02 | Single sheet viewer | **Built** — header, revision picker, embedded PDF, download. Floating zoom/measure tool rail is not wired (the embedded PDF viewer supplies zoom). | `sheet.html`, `js/sheet-page.js` |
| 03 | Add revisions (auto-matched upload) | **Built — this is the core.** Drag-drop, title-block read, auto-match with confidence, supersede plan, unmatched → manual pick, reason/date/note, Publish. | `upload.html`, `js/upload-page.js`, `js/extract-core.js`, function + Action |
| 04 | Version history & compare | **Partial** — version history list is built (in the viewer's side panel). The visual Rev-to-Rev **compare** (overlay wipe, side-by-side, changed-area boxes) is **not built**; the handoff itself notes the diff highlights come from an external diff service. | history in `sheet-page.js`; compare pending |
| 05 | Field view (phone) | **Not built** — the index and viewer are responsive and usable on a phone, but the dedicated one-handed field layout + tab bar are pending. | pending |

## The upload requirement, specifically

Your ask — *easy upload that replaces old versions and names drawings from the name
on the drawing itself* — is fully implemented and tested end to end on both paths:

- **Names from the drawing, not the file:** a file called `weird_scan_name.pdf` whose
  title block reads E-501 is published as `E-501_Rev1.pdf`. Verified.
- **Replaces old versions:** re-uploading E-101 bumps it to the next rev, writes
  `E-101_Rev4.pdf`, and moves `E-101_Rev3.pdf` into `drawings/archive/`, with the manifest
  history updated. Verified.
- **Never guesses:** if no sheet number can be read, the file is flagged for a person to
  assign — the in-app row shows a sheet picker; the Action leaves the file in `incoming/`
  and reports it as skipped.

## Open questions from the handoff (still for the product owner)

1. Does a revision need engineer-of-record approval before the field sees it, or does
   publishing make it current immediately? (There's a `status: "pending"` hook in the
   manifest and viewer for the approval model if you want it.)
2. Do markups carry forward onto a new rev, or stay pinned to the rev they were drawn on?
3. Is Procore the system of record, or is this?
