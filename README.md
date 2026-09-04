# Handoff: Drawings Hub (drawing version control for the field)

## Overview
A tablet-first hub for viewing electrical construction drawings and keeping revisions
straight. Five screens: a project drawing index, a single-sheet viewer, an upload flow
that auto-matches incoming files to the sheet they supersede, a version history with a
Rev-to-Rev compare, and a phone-sized field view.

The problem it solves: a foreman on site must never build off a superseded revision.
Every screen answers "is what I'm looking at current?" before it answers anything else.

Primary user: field foremen on a tablet in landscape. Secondary: detailers publishing
revisions from the office.

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes showing
the intended look and behavior. They are not production code to copy directly.

The task is to **recreate these designs in the target codebase's existing environment**
(React, Vue, SwiftUI, native, whatever is in play) using its established component
library, routing, and state patterns. If no environment exists yet, pick the framework
that best fits the product and implement the designs there.

`Drawings Hub.dc.html` is a single streaming component file with an inline-styles-only
convention. Do not port the inline styles verbatim — translate them into the target
codebase's styling approach (CSS modules, Tailwind, styled-components, etc.), using the
token table below as the source of truth for values.

## Fidelity
**High-fidelity.** Final colors, typography, spacing, and copy. Recreate the UI
pixel-accurately using the codebase's existing libraries where they cover a pattern
(buttons, tables, selects, modals) and match the documented values where they don't.

Two things in the mock are deliberately *not* final:
- **Drawing areas are placeholders.** Every sheet is drawn as a grey paper rectangle with
  a CSS grid, a few rectangles standing in for rooms, a title block, and a
  `PLACEHOLDER — SHEET RASTER` stamp. In production these are a PDF/raster tile viewer.
  Do not implement the placeholder geometry.
- **Changed-area highlights** on the compare screen are hand-placed boxes. In production
  they come from whatever diff service produces them.

## Design system
Nocturne — a dark, compact, low-chroma interface. Single accent (`#9184d9`) used as a
line, a tint, and a glow, never as a flood. Primary buttons are **outlined**, not filled.
The full token sheet and component classes are in `styles.css` (bundled here); it is the
authority for `.btn`, `.tag`, `.input`, `.field`, `.radio`, `.seg`, `.card`, `.table`.
Icons throughout are **Phosphor** (https://phosphoricons.com), regular and fill weights.

---

## Screens / Views

### 01 — Project hub / drawing index
**Purpose:** land here, find a sheet, and see at a glance which sheets are behind the
issued set.

**Frame:** 1194 × 834 (iPad landscape), `border-radius: 14px`, background `#161826`.
Vertical flex: top bar → body.

**Top bar** — height 58px, `padding: 0 18px`, `border-bottom: 1px solid var(--color-divider)`.
Left to right: 24×24 rounded-6px square outlined in the accent containing a monospace "D";
"Drawings" (Inter 500 / 15px); a 1px × 22px divider; a project picker button (transparent,
1px divider border, radius 8, padding 7px 11px, 13px text, `ph-buildings` leading icon at
15px in `--color-neutral-400`, `ph-caret-down` trailing at 12px, hover
`rgba(233,233,237,.07)`); then pushed right: a sync pill (padding 6px 11px, radius 8,
background `--color-accent-900`, text `--color-accent-200` 12px, `ph-fill ph-cloud-check`
14px in `--color-accent-400`, copy "Synced 4 min ago"), a 36×36 `.btn .btn-icon
.btn-secondary` with `ph-bell`, and a 32px circular avatar (`--color-neutral-800` fill,
`--color-neutral-200` initials "RM" at 12px/500).

**Left rail** — 208px fixed, `border-right: 1px solid var(--color-divider)`,
`padding: 18px 12px`, column flex with 22px between groups.
- Group label: monospace 10px, `letter-spacing: .12em`, uppercase, `--color-neutral-600`,
  `padding: 0 10px 8px`.
- Row: `padding: 10px`, radius 8, gap 10, 13px Inter, icon 15px, count right-aligned in
  monospace 12px. Idle text `--color-neutral-300`, count `--color-neutral-600`, hover
  `rgba(233,233,237,.06)`.
- Selected row (Electrical): background `--color-accent-900`, text `--color-accent-100`,
  `box-shadow: inset 0 0 0 1px var(--color-accent-700)`, icon `ph-fill ph-lightning` in
  `--color-accent-400`, count `--color-accent-300`, weight 500.
- Disciplines: Electrical 24 (`ph-lightning`), Mechanical 18 (`ph-fan`), Plumbing 11
  (`ph-drop`), Architectural 32 (`ph-blueprint`), Fire alarm 6 (`ph-fire-extinguisher`).
- "On this tablet" group: Pinned offline 6 (`ph-push-pin`), My markups 3
  (`ph-pencil-simple`).
- Bottom (margin-top auto): offline cache card — 1px divider border, radius 8, padding 11,
  label "Offline cache" 11px `--color-neutral-500`, a 4px track (`--color-neutral-800`,
  radius 2) with a 38% fill in `--color-accent-500`, and "412 MB of 1.1 GB" monospace 11px
  `--color-neutral-600`.

**Main column**
- Toolbar row, `padding: 16px 20px 14px`: search field (`.input`, min-height 40, max-width
  340, `padding-left: 34px`, `ph-magnifying-glass` 15px absolutely positioned 11px from
  left, placeholder "Sheet number, title or keyword"); filter chips at 8px 13px / radius 8
  / 13px — active chip is a `--color-neutral-800` fill with `--color-neutral-100` text,
  idle chips are 1px divider borders with `--color-neutral-300` text; the "New revs" chip
  carries a count badge (`--color-accent-800` fill, `--color-accent-200` monospace 11px,
  padding 1px 6px, radius 20). Right-aligned: `.btn .btn-primary` "Add revisions" with
  `ph-upload-simple`, min-height 40.
- Alert banner (conditional on `showRevAlert`): `margin: 0 20px 14px`, padding 13px 15px,
  radius 8, `background: linear-gradient(90deg, var(--color-accent-900), rgba(43,39,65,0))`,
  `box-shadow: inset 0 0 0 1px var(--color-accent-700)`. `ph-fill ph-warning-circle` 19px in
  `--color-accent-400`. Title "2 sheets on this tablet are behind the issued set" (13px/500,
  `--color-accent-100`); body "E-101 and E-301 were reissued Sept 2. Your pinned copies are
  Rev 3." (12px, `--color-neutral-400`). Actions: `.btn-primary` "Review changes" and
  `.btn-secondary` "Update all", both min-height 34.
- Sheet table (`.table`, 14px). Columns: Sheet 96px · Title (flex) · Current rev 110px ·
  Issued 118px · Status 186px · actions 64px. Header cells `padding: 8px 10px`; body cells
  `padding: 13px 10px`. Sheet number is monospace 14px/500 in `--color-accent-300`. Title
  has a 12px `--color-neutral-600` sub-line 3px below. Rev is monospace 13px
  `--color-neutral-300`; Issued is 13px `--color-neutral-400`.
  - Status "behind": `.tag .tag-accent` reading "New rev — you have Rev 3" with a leading
    `ph-fill ph-arrow-circle-up` at 12px.
  - Status current: inline 12px `--color-neutral-400` with `ph-fill ph-check-circle` 13px in
    `--color-accent-500` — "Current" or "Current · pinned".
  - Status pending: `.tag .tag-neutral` "Pending approval".
  - Actions cell: pin state (`ph-fill ph-push-pin` in `--color-accent-500` when pinned,
    `ph ph-push-pin-slash` in `--color-neutral-600` when not) then `ph-caret-right` 14px.
  - Rows (verbatim): E-101 Power Plan — Level 1 / "Issued for construction · 2 open
    markups" / Rev 4 / Sept 2, 2026 / new rev, unpinned. E-102 Power Plan — Level 2 /
    Rev 2 / Aug 12, 2026 / current · pinned. E-201 Lighting Plan — Level 1 / Rev 2 /
    Aug 12, 2026 / current · pinned. E-301 One-Line Diagram / "Revised switchgear feeder
    sizes" / Rev 4 / Sept 2, 2026 / new rev, pinned. E-401 Panel Schedules — H1 through H6 /
    Rev 1 / Jul 28, 2026 / current. E-501 Details — Feeder & Grounding / "In review by
    engineer of record" / Rev 2 / Aug 30, 2026 / pending approval. E-601 Site Lighting &
    Duct Bank / Rev 1 / Jul 28, 2026 / current.

### 02 — Single sheet viewer
**Purpose:** read the drawing. Chrome collapses to the top and bottom edges so the sheet
gets the screen.

**Header** — 56px, `padding: 0 16px`, 1px divider bottom. Back button (36×36 secondary
icon, `ph-arrow-left`); "E-101" monospace 15px/500 `--color-accent-300` beside "Power Plan
— Level 1" Inter 15px/500; a revision picker button (transparent, `1px solid
var(--color-accent-700)`, radius 8, padding 6px 10px, `--color-accent-200` 12px, hover
`rgba(145,132,217,.12)`) reading "Rev 3 · on this tablet" with `ph-caret-down`. Right:
secondary buttons "Compare revs" (`ph-git-diff`), "Markup" (`ph-pencil-simple`), "Share"
(`ph-share-network`), and a 36×36 `ph-dots-three`.

**Canvas** — flex 1, background `#0d0f1a`, `padding: 26px 26px 0`, centered. Sheet
placeholder: 1000 × 590, background `#e4e7f5`, radius 3, `box-shadow: 0 18px 50px
rgba(0,0,0,.6)`. **Replace with the real sheet renderer.** The title block (right strip,
158px wide, 2px `#595d6c` borders) shows DINTO ELECTRIC / RIVERBEND MEDICAL CENTER PHASE 2 /
POWER PLAN LEVEL 1 / E-101 — production should render the sheet's own title block.

**Floating tool rail** — absolutely positioned 24px from left, vertically centered.
Container: padding 6, radius 12, `background: rgba(35,37,50,.94)`, `box-shadow: 0 0 0 1px
#3f424d, 0 10px 26px rgba(0,0,0,.5)`, 4px gap. Seven 44×44 ghost icon buttons at 19px:
`ph-magnifying-glass-plus`, `ph-magnifying-glass-minus`, `ph-corners-out`, a 1px divider,
`ph-ruler`, `ph-pencil-simple`, `ph-stack-simple`. **44px is the minimum touch target —
keep it.**

**Rev toast** (conditional on `showRevAlert`) — bottom-right, 24px/26px inset, max-width
390, padding 13px 15px, radius 10, `background: rgba(35,37,50,.96)`, `box-shadow: 0 0 0 1px
var(--color-accent-700), 0 12px 30px rgba(0,0,0,.55)`. `ph-fill ph-arrow-circle-up` 20px in
`--color-accent-400`; "Rev 4 was issued Sept 2" (13px/500 `--color-accent-100`) over
"6 changed areas, mostly in the east wing." (12px `--color-neutral-400`); `.btn-primary`
"Compare" at min-height 34. It intentionally floats over the sheet.

**Sheet strip** — 96px tall, `padding: 0 16px`, 1px divider top. Thumbnails 78 × 62,
radius 4, 10px gap; the active one is `#e4e7f5` with `box-shadow: 0 0 0 2px
var(--color-accent)`, the rest `#cfd3e5` at 0.8 opacity. Each carries a 1px `#9397ab`
inner frame and a monospace 8px sheet number bottom-left. Right side: "Available offline"
(12px `--color-neutral-500` with `ph-fill ph-push-pin` in `--color-accent-500`) and
"1 of 24" in monospace 12px `--color-neutral-600`.

### 03 — Add revisions (auto-matched upload)
**Purpose:** publish new revisions in one pass. The system does the matching; the person
confirms it and states the reason for issue.

Modal over a dimmed hub: backdrop `rgba(13,15,26,.72)` + `backdrop-filter: blur(2px)`.
Dialog 820px wide, max-height 740, radius 14, `background: var(--color-surface)`,
`box-shadow: 0 0 0 1px #595d6c, 0 26px 60px rgba(0,0,0,.7)`.

- **Header** `padding: 18px 20px 14px`: "Add revisions" (17px/500) over "Riverbend Medical
  Center — Ph 2 · Electrical" (12px `--color-neutral-500`); 34×34 secondary `ph-x` right.
- **Drop summary** `margin: 0 20px 16px`, padding 20, radius 10, `1px dashed
  var(--color-accent-700)`, `background: var(--color-accent-900)`. `ph-file-arrow-up` 26px
  in `--color-accent-400`. "4 files read · sheet numbers pulled from the title block"
  (13px/500 `--color-accent-100`) over "3 matched an existing sheet. 1 looks new — confirm
  below." (12px `--color-neutral-400`). Secondary "Add more files" right.
- **Match rows** — 9px gap, each padding 13px 14px, radius 10, `background: var(--color-bg)`,
  `box-shadow: inset 0 0 0 1px var(--color-neutral-800)`. Left `ph-fill ph-file-pdf` 21px
  `--color-neutral-500`. Filename in monospace 13px `--color-neutral-200` with ellipsis
  overflow. Below: `ph-arrow-right` 12px, the matched sheet (12px `--color-neutral-400`), a
  `.tag .tag-accent` at 10px/padding 2px 8px reading "Rev N supersedes Rev N-1", and a
  confidence figure in 11px `--color-accent-400`. Right: ghost "Change" (12px, min-height 32)
  and `ph-fill ph-check-circle` 20px in `--color-accent-500`.
  Rows: `E-101_POWER-PLAN-L1_Rev4.pdf` → E-101, Rev 4 supersedes Rev 3, 98% match ·
  `E-301_ONE-LINE_R4_20260902.pdf` → E-301, Rev 4 supersedes Rev 3, 96% ·
  `E-501-details-grounding-rev3.pdf` → E-501, Rev 3 supersedes Rev 2, 91%.
- **Unmatched row** — same geometry but `box-shadow: inset 0 0 0 1px var(--color-accent-700)`
  and an accent file icon. `scan_2026-09-02_14-08.pdf`, `ph-question` 13px, copy "No sheet
  number found — pick a sheet or file it as new" in `--color-accent-200`. Right: a 236px
  `.input` select (min-height 34, 12px, `padding-right: 26px`) with options "Choose a
  sheet…", "E-102 Power Plan — Level 2", "E-201 Lighting Plan — Level 1", "File as a new
  sheet".
- **Footer fields** `padding: 18px 20px`, 1px divider top, 14px gap: "Reason for issue"
  select 262px (options Revised for construction / ASI or bulletin / RFI response / Permit
  comments); "Issue date" text field 150px, value "Sept 2, 2026"; "Note to the field
  (optional)" flexible, placeholder "e.g. feeder to H4 upsized to 4in, reroute above
  ceiling". All `.field` + `.input` at min-height 38 with 26px right padding on selects so
  the native caret clears the value.
- **Actions** `padding: 0 20px 20px`: a `.radio` checkbox, checked — "Notify the 6 people
  with these sheets pinned"; right, `.btn-secondary` "Save as draft" and `.btn-primary`
  "Publish 4 revisions" (`ph-check`), min-height 38.

### 04 — Version history & compare
**Purpose:** see what changed between the rev on the tablet and the rev that was issued,
then take the update.

**Header** — as screen 02, with "· version history" appended in 13px `--color-neutral-500`.
Right: a `.seg` with two `.seg-opt` radios — "Overlay wipe" (`ph-stack-simple`) and
"Side by side" (`ph-columns`) — then `.btn-primary` "Update my copy to Rev 4"
(`ph-download-simple`), min-height 36.

**Revision rail** — 288px, 1px divider right.
- Section label "Revisions" (monospace 10px uppercase, `--color-neutral-600`,
  `padding: 16px 16px 10px`).
- Each entry: 12px padding, radius 9, 11px gap, a 9px dot at 4px top offset.
  Selected (Rev 4): `background: var(--color-accent-900)`, `inset 0 0 0 1px
  var(--color-accent-700)`, dot `--color-accent-400` with `box-shadow: 0 0 0 4px
  rgba(145,132,217,.18)`, title `--color-accent-100`, a `.tag .tag-outline` "Issued",
  meta "Sept 2, 2026 · K. Alvarez", body "ASI-14: feeder to H4 upsized, east wing
  receptacles relocated.", footer "6 changed areas" in monospace 11px `--color-accent-400`.
  Rev 3: `inset 0 0 0 1px var(--color-neutral-800)`, dot `--color-neutral-500`, a
  `.tag-neutral` "On your tablet", meta "Aug 12, 2026 · K. Alvarez", body "Revised for
  construction." Rev 2 and Rev 1 are bare rows (dot `--color-neutral-700`, hover
  `rgba(233,233,237,.05)`) reading "Jul 28, 2026 · RFI-08 response" and "Jun 15, 2026 ·
  Permit set".
- **Changed areas** list (conditional on `showChangedAreas`), 1px divider top, padding
  14px 12px. Rows: 9px 10px padding, radius 8, a 20×20 numbered chip (radius 5), 12px label,
  trailing `ph-arrow-square-out` 13px. The active row is `rgba(145,132,217,.1)` with an
  `--color-accent-800` chip; others use `--color-neutral-800` chips. Items: "Feeder to panel
  H4 — 3in to 4in", "East wing receptacles relocated", "Note 6 revised — conduit routing",
  then a ghost "Show all 6". Selecting a row should pan the canvas to that area.

**Compare canvas** — background `#0d0f1a`. Legend bar (11px 16px padding, 1px divider
bottom): "Rev 3 · Aug 12" with a 10×2 `--color-neutral-500` swatch, "Rev 4 · Sept 2" with a
`--color-accent-400` swatch, and "Fit to width · 68%" in monospace right.

*Overlay wipe (default):* one sheet frame, max-width 760, `aspect-ratio: 1.5`,
`cursor: ew-resize`, `touch-action: none`, `user-select: none`. The Rev 3 render sits at the
bottom; the Rev 4 render is stacked above it and clipped with `clip-path: inset(0 {100-pos}%
0 0)`, so dragging reveals Rev 4 from the left. Rev 4's paper is very slightly lighter
(`#eeeffb`), its changed geometry is drawn in `#5d5294`/`#796cbf`, and changed areas carry a
2px `#796cbf` box on a `rgba(121,108,191,.12)` fill with a numbered label chip
(`#5d5294` fill, `#f5f4ff` monospace 10px). The divider is a 2px `var(--color-accent)`
column at `left: pos%` with `box-shadow: 0 0 14px rgba(145,132,217,.7)` and a centered 42px
round handle (`#232532`, `0 0 0 1px var(--color-accent)`, `ph-arrows-horizontal` 18px).
Corner chips label REV 4 (left) and REV 3 (right).

*Side by side:* two frames, max-width 400 each, 16px gap, `aspect-ratio: 1.5`. The Rev 4
frame gets `box-shadow: 0 0 0 1px var(--color-accent-700), …` and the numbered change boxes;
each frame has a corner chip ("REV 3 · AUG 12", "REV 4 · SEPT 2"). Panning and zooming
should be locked together across the two panes.

### 05 — Field view (phone)
**Purpose:** the one-handed check — what's current, what isn't.

**Frame:** 390 × 844, radius 38.
- Status bar row: 14px 24px 6px, "9:41" and `ph-fill ph-cell-signal-medium` /
  `ph-fill ph-battery-high`, all `--color-neutral-300` 13px/500.
- Header: "Riverbend Ph 2" (19px/500) over "Electrical · 24 sheets · synced 4 min ago"
  (12px `--color-neutral-500`); a 44×44 secondary `ph-magnifying-glass` right.
- Alert card (conditional on `showRevAlert`): `margin: 0 14px 12px`, padding 14, radius 10,
  `background: linear-gradient(135deg, var(--color-accent-900), rgba(43,39,65,.35))`,
  `inset 0 0 0 1px var(--color-accent-700)`. `ph-fill ph-warning-circle` 18px + "2 sheets
  have a newer rev" (14px/500 `--color-accent-100`); body "E-101 and E-301 were reissued
  Sept 2. Don't build off Rev 3." (13px/1.5 `--color-neutral-400`); `.btn-primary .btn-block`
  "Review and update" at min-height 44.
- Sheet rows: padding 14, radius 10, `background: var(--color-surface)`, 9px gap, 12px
  internal gap. A 44 × 56 thumbnail (radius 3; `#e4e7f5` for behind-rev sheets, `#cfd3e5`
  otherwise, 1px `#9397ab` inner frame). Sheet number monospace 14px/500 —
  `--color-accent-300` when behind, `--color-neutral-400` when current. Title 13px
  `--color-neutral-200`. Status line 11px — "Rev 4 issued · you have Rev 3" in
  `--color-accent-300`, or "Rev 2 · current · offline" in `--color-neutral-600`. Rows for
  behind-rev sheets add `box-shadow: inset 0 0 0 1px var(--color-accent-800)`. Trailing
  `ph-caret-right` 16px. Rows: E-101, E-102, E-201, E-301, E-401 (same titles as screen 01).
- Tab bar: 12px 8px 26px padding, 1px divider top, four items at `min-width: 56px;
  min-height: 44px` — Sheets (`ph-fill ph-blueprint`, active, `var(--color-accent)`),
  Markups (`ph-pencil-simple`), Offline (`ph-push-pin`), Activity (`ph-bell`), icons 21px,
  labels 10px.

---

## Interactions & Behavior

**Implemented in the prototype**
- Compare divider: `pointerdown` on the overlay frame starts a drag; `pointermove` on
  `window` maps `clientX` to a percentage of the frame's `getBoundingClientRect()`, clamped
  to 4–96; `pointerup` releases. The frame sets `touch-action: none` and `user-select: none`
  so it works under a finger. Position drives both `clip-path: inset(0 {100-pos}% 0 0)` on
  the Rev 4 layer and `left: {pos}%` on the handle. No transition — it tracks the finger.
- Overlay / side-by-side toggle via the segmented control.
- Hover tints on rails, chips, rows, and buttons (see token table).

**Specified, not implemented**
- Row tap on screen 01 → sheet viewer (02) at the current rev.
- "Compare revs", the rev toast's "Compare", and "Review changes" → screen 04.
- "Add revisions" → the modal (03). Files arrive by drop or picker; each is parsed for a
  sheet number and matched with a confidence score. ≥ ~90% auto-confirms with a check;
  anything lower or unparsed drops into the "needs a sheet" state with a select. "Change"
  reopens the sheet picker on an already-matched row.
- "Publish N revisions" validates that every row resolves to a sheet or is explicitly filed
  as new, writes the revs, and notifies the users who have those sheets pinned. Nothing
  publishes while an unmatched row remains — disable the button and say why.
- "Update my copy to Rev 4" / "Update all" downloads and re-pins, then clears the behind-rev
  state on the affected rows.
- Pin toggles in the actions cell add/remove the offline copy and move the cache meter.
- Changed-area row tap pans and zooms the compare canvas to that area.
- Sheet strip thumbnail tap loads that sheet.

**States to design for that the mock doesn't show:** empty project (no sheets yet), upload
in flight with per-file progress, a failed parse, offline with a stale cache, and a sheet
whose rev is pending approval (viewer should mark it clearly as not-for-construction).

## State Management
Prototype state (in the DC logic class):
- `pos` — compare divider position, 0–100, default 54.
- `mode` — `'overlay' | 'side'`, falls back to the `compareMode` prop.
- Props as feature flags: `showRevAlert` (bool, default true) toggles all three behind-rev
  notices; `showChangedAreas` (bool, default true) toggles the changed-areas list;
  `compareMode` (enum) sets the default compare view.

Real implementation will need, per project: the sheet list with each sheet's current rev,
issued date, status (issued / pending approval), pin state, and the locally cached rev; a
revision list per sheet (number, date, author, reason for issue, note to the field, diff
summary); an upload session (files, parsed sheet number, match confidence, resolution,
shared reason/date/note); and device state (cache size and budget, sync timestamp,
online/offline). The behind-rev flag is a derived value: `cachedRev < currentRev`.

## Design Tokens
All from `styles.css` (`:root`). Use the variables, not the literals.

| Token | Value | Use |
| --- | --- | --- |
| `--color-bg` | `#161826` | app ground, table rows |
| `--color-surface` | `#232532` | cards, modal, floating rails |
| `--color-text` | `#e9e9ed` | body text |
| `--color-accent` | `#9184d9` | outlines, the compare divider, active icons |
| `--color-divider` | `#e9e9ed` @ 16% | 1px rules |
| `--color-neutral-100…900` | `#f3f5fe` → `#292b31` | text ramps, surfaces, borders |
| `--color-accent-100…900` | `#f5f4ff` → `#2b2741` | tints, tags, accent text |
| `--space-1…8` | 2.8 / 5.6 / 8.4 / 11.2 / 16.8 / 22.4px | 0.7× density scale |
| `--radius-sm/md/lg` | 4 / 8 / 14px | controls / cards / frames |
| `--shadow-sm/md/lg` | hairline + ambient | elevation |
| `--font-heading`, `--font-body` | Inter | 400 body, 500 headings — never heavier |

Values used in this design that sit outside the token sheet, and why:
- `#0d0f1a` — the drawing canvas well, one step below `--color-bg` so the paper reads as lit.
- `#e4e7f5` / `#eeeffb` / `#cfd3e5` / `#b2b6ca` / `#9397ab` / `#75798c` / `#595d6c` /
  `#3f424d` — the paper and its linework, taken from the neutral ramp. Nocturne forbids pure
  white, so paper is `--color-neutral-200`, not `#fff`.
- `#5d5294` / `#796cbf` — accent-700/600 used for Rev 4 linework and changed-area boxes on
  the light paper, where the base accent would be too light.
- `rgba(35,37,50,.9….96)` — translucent `--color-surface` for floating chrome over the sheet.
- Hover tints `rgba(233,233,237,.05….07)` and `rgba(145,132,217,.1….12)` — the guide's
  `color-mix` hovers written out.

Type: everything is Inter. 34px/500 page title; 19px/500 mobile header; 17px/500 modal
title; 15px/500 screen titles; 14px body and table cells; 13px secondary; 12px meta; 11px
and 10px monospace for sheet numbers, revs, counts, and labels (`letter-spacing: .12em` on
uppercase micro-labels). **No interface text below 10px, and nothing below 11px carries
meaning that isn't repeated elsewhere.** Touch targets on the tablet tool rail and the phone
tab bar are 44px minimum.

## Assets
- **Icons:** Phosphor, regular + fill, via
  `https://unpkg.com/@phosphor-icons/web@2.1.1/src/{regular,fill}/style.css`. Swap for the
  codebase's Phosphor package if it has one.
- **Fonts:** Inter 400/500/600 from Google Fonts.
- **Drawings:** none. Every sheet is a CSS placeholder. Real sheet exports need to come from
  the drawing store; the viewer needs a PDF/tile renderer with pan, zoom, and measure.
- **No images or logos** are used. The "D" mark on screen 01 is a placeholder for the Dinto
  Electric brand mark.

## Files
- `Drawings Hub.dc.html` — all five screens. Layout is inline styles; the compare drag and
  the mode toggle are in the logic class at the bottom of the file.
- `styles.css` — the Nocturne token sheet and component classes. Authority for every
  `var(--*)` reference above.
- `nocturne-readme.md` — the design system guide: direction, color, type, interaction
  states, and the do/don't list. Read this before making any styling decision the screens
  don't already answer.

## Open questions for the product owner
1. Does a revision need engineer-of-record approval before the field sees it, or does
   publishing make it current immediately? Screen 01 shows a "Pending approval" state that
   implies the former.
2. Do markups carry forward onto a new rev automatically, or stay pinned to the rev they
   were drawn on?
3. Is Procore sync in scope, or is this the system of record?
