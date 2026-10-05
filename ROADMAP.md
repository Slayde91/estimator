# CEASEFIRE Estimator roadmap

Updated 5 October 2026. This roadmap separates implemented source behaviour,
release verification and planned work. PR #154 carries the current controls and
library update; its final publication and live activation are established by the
dated release receipts, not by this document. The verified baseline for that
release is PR #153, merge `7488b4a023562a3d4b0832d0f713b282a81e7c94`.

## Delivered capabilities

| Area | Implemented capability and retained boundary |
| --- | --- |
| Workbook calculation | Local Python calculation engines, immutable imported workbook definitions, source fingerprints, independently checked formula parity and explicit reviewed exceptions. Stored and calculated precision is retained. |
| Estimator | Material and labour estimating, local quote persistence, error propagation, project identity, branded PDF and saved pricing snapshots. |
| Workbook calculators | Steel spray, Steel board and Duct protection; separate schedule and materials/summary PDFs, values-only XLSX exchange, 1,000-row schedules and legacy template compatibility. Purchasing, layers, waste and coverage retain their calculator-specific rules. |
| Board summary | Approved Net Steel sqm uses exposed steel-profile surface once per member/product/thickness row without layer/waste multipliers. Missing geometry is disclosed. Purchase sqm and workbook formulas are unchanged (PR #152). |
| Firestopping estimating | Editable reviewed settings and groups, library-backed choices, labour/pricing integration, schedule reports and retained project inputs. A technical reference is not automatic approval for an installation. |
| Pricing Library | Product/Service editing, supplier price, markup, calculated sell price, separate estimator-use groups, yield and complete values-only import/export. Shared catalogue updates do not rewrite frozen project pricing. |
| Technical and Firestopping libraries | Source-bound reports, revision/page context, diagrams, configuration/substrate/service/FRL filters, manufacturer imports and duplicate-review tooling. Runtime inventory contents are private local state and require current verification. |
| Portable projects | Validated versioned project JSON, capability-bound native saves, complete calculator drafts, library drafts, immutable companion evidence/history, explicit load validation and late-edit guards. |
| Manual drawing Takeoffs | Original-PDF retention, text search, zoom/pan/text selection, CropBox/rotation/UserUnit handling, per-page scale, calibrated named viewports and original-coordinate markups. No OCR is implied. |
| Steel and Duct Takeoffs | Traced lengths, manual source-cited lengths, steel counted lengths with persistent member IDs, standalone counts, rise/drop additions, item edits, column filters, selection/hiding, split/merge, undo/history and explicit confirmation. |
| Walls and Slabs | Calibrated polygon area, exclusions, true-surface inputs and standalone lengths; source geometry, revisions and confirmation retained. |
| Manual physical drafts | Defect Reports uses Defect → Barrier → Service; Service Plans uses a separate Barrier → Service graph. Persistent display IDs, explicit service quantities, source-position markers, generated call-outs and reviewed image extraction are retained. These are unapproved physical drafts. |
| Drawing/register exports | XLSX registers, static marked drawing PDFs, visible call-outs, calibrated measurements and current linked thickness where provenance allows it; separate draft Passive Fire Matrix PDF (PR #151). |
| Explicit calculator transfers | Confirmed supported Steel/Duct items can be previewed and applied to an explicit destination. Local provenance, source identity, row conflicts, stale links, updates and detach remain explicit. Standalone counts/lengths and physical drafts cannot become priced quantities through those paths. |
| Navigation and desktop | Home/Estimates/Calculators/Takeoffs/Libraries/Projects/Help, accessible disclosure menus, compact icon controls, local launcher and Standard Windows desktop packaging. Standard packaging excludes Takeoffs. Passing build checks is not a new published installer. |

Recent merged increments include original-coordinate editing/export (PRs #121–125),
count/scale tools (#127), smooth viewer interaction (#138, #148), column filters
(#139), item details and Fit page (#140), surface/Count controls (#144), project
and markup controls (#146–147), header menus (#149), thickness/legends (#150),
Estimates/Passive Fire Matrix (#151), Net Steel sqm (#152) and viewer/navigation
feedback (#153). See [Takeoffs](docs/TAKEOFFS.md),
[architecture](docs/TAKEOFFS_ARCHITECTURE.md),
[calculator mapping](docs/CALCULATOR_PRESENTATION_MAPPING.md) and
[project state](docs/PROJECT_STATE.md) for the detailed contracts.

## Current release: controls and library polish, PR #154

The original 26 browser comments are implemented in this release:

- Scale moves to the top-left overlay before the document and search controls;
  narrow Settings panes start below these controls.
- Active rail tools show light red. Call-out defaults are `#FF3300`, `#FFDD33`,
  `#000000`, width 4, fill enabled and 75% opacity; explicit saved styles win.
- Width/Marker edits accept 1–100 PDF points; Opacity accepts 1–100 percent.
  Untouched historical fractions, zero opacity and stored precision are preserved.
- Project files advertises drag/drop. One Save action updates an authorized file
  or opens the existing destination dialog when no target is bound.
- Header navigation fits its icons, icon footprints/strokes are consistent,
  Sigma is centred, Save aligns on the same row, and the supplied Takeoffs image
  remains byte-for-byte unchanged.
- Steel/Duct length copying works with Settings closed; native text copying stays
  available. New legends fit their wrapped text; saved legend positions/sizes persist.
- Filtered selection toggles matching rows without clearing selection outside the
  filter. Duct shares the compact controls; redundant Clear/sort/group controls go.
- Drawing and marked-PDF measurement labels show two decimal places; raw numeric
  records and calculator/export values retain their original precision.
- Physical registers add presentation-only Select/Hide controls and Service Size
  filtering. Hidden markers are omitted from the visible drawing download while
  physical records and quantities remain unchanged.
- Pricing Library fits smaller viewports and uses the requested heading/eyebrow.
  Technical Library exposes whole-inventory totals, manufacturer totals and the
  count not linked to Firestopping. The typing cursor stops at the final character.

Local focused checks and full CI are recorded separately. Merge/activation require
successful CI for the exact final feature commit, preserved source/data receipts,
fresh served-asset checks and rendered live-browser acceptance. No migration of
calculator source files or saved project data is part of this release.

## Implemented extension: eight requested browser changes

These changes build on PR #154 and are implemented in the search/free-call-out
extension. Its exact-head CI, publication and live activation remain separate
release gates recorded in the release receipts.

| Comment | Required behaviour | Acceptance evidence |
| --- | --- | --- |
| 1 | Unique Ctrl+key shortcuts for every left-rail tool except Upload PDFs in every Takeoffs section; tooltip includes the assignment. Verify the claimed existing Viewport shortcut before choosing keys. | All visible/enabled tools work by keyboard; disabled tools stay disabled; native editing, copy/paste/cut, undo, browser shortcuts and IME composition are preserved. |
| 2 | Search results appear as an anchored dropdown below the search input while typing. | Keyboard/touch selection, viewport clipping, changing document/scope and old asynchronous responses tested. |
| 3 | Clearing input clears both result list and highlights immediately. | In-flight search cannot restore stale results after clear. |
| 4 | Search first finds the nearest result to the current page position; repeated activation advances through that page's matches and wraps to the first. | Ordered result identity, initial distance and repeat/wrap verified at multiple zooms/rotations. Explicitly resolve the no-match-on-current-page case during implementation. |
| 5 | Stop search cancels the run and empties the field, results and highlights. | Cancellation tested during PDF loading and extraction, followed by a new query. |
| 6 | Relevant sentence/context is yellow, with searched words in a distinct colour. | Phrase/repeated-word matches, multi-run text, rotated/cropped PDFs and search coverage limits verified. No OCR claim. |
| 7 | Legend can be activated only when relevant Length and/or Count markups exist. | Empty document, document switch, deletion/undo, hidden items and already-visible legend tested. |
| 8 | Physical Count becomes Call-out with its supplied icon and a shortcut distinct from Count. Add free call-outs in Steel/Duct/Walls/Slabs, with shared defaults/settings and only a rich-text Item Details box. | Existing physical hierarchy/IDs/quantities survive rename; free call-outs add no register or calculator quantity; save/reopen, undo, marked PDF, style and rich-text safety verified. |

The original Comment 8 PNG was located in the source conversation and copied
unchanged as `static/icons/takeoff-callout.png`: SHA-256
`068c58a46525a2618709cb4c77056214a9b1f4ff289d4785e1db8b7f50c9c8dd`.
Search stays on the current page when it has no match; a dropdown selection
explicitly navigates elsewhere. Search caps at 500 hits with incomplete coverage
disclosed. Exact matches use measured PDF text bounds, with a disclosed text-run
fallback where glyph bounds are unavailable. No OCR is introduced.

The [implemented architecture](docs/TAKEOFFS_ARCHITECTURE.md#implemented-extension-eight-new-comments)
defines the separate optional annotation collection, safe text and persistence
boundaries. Free notes add no register rows or quantities. Text supports bounded
paragraphs/lists and bold/italic/underline; overfull boxes or PDF-font limitations
fail explicitly while retaining the note. Legacy projects gain no collection by
opening. No automated technical approval or matching is introduced.

## Planned work that remains outside this release

- AI-assisted extraction/proposals and independent visual validation (historical
  Phases 5/6) remain paused. No Physical Model Lock is delivered.
- Takeoff-to-Firestopping candidate matching remains a design direction. Route
  candidates by applicability before ranking; require explicit reviewed multi-member
  assignments when one installation covers several barriers/services. Shared
  barriers alone do not establish a shared opening. No automatic priced transfer.
- Wider deployment, multi-user authentication and a refreshed publicly distributed
  installer require their own reviewed work and evidence. The current HTTP server
  remains a local application.

The superseded PR #29-era roadmap is retained as
[historical evidence](docs/history/ROADMAP_PRE_OCTOBER_2026.md). Old statements of
pending checks or publication describe their own time boundary, not today's release.


### 6 October 2026 — browser feedback and explicit library-selection links

Implement the fifteen browser comments within the shared viewer and existing
physical draft workflow: supplied header GIF with typing-bound stop, automatic
new PDF display, four-corner free Call-out editing/selection/context deletion and
pointer copy/paste, full-width rich details/supplied icons, hidden-only Visibility
state, viewer rotation/page/zoom shortcuts, outside search dismissal and readable
composited highlights. Explicit Search Item/New Item creation imports selected
Firestopping Library fields into stable physical draft identities. Separately
versioned project-owned assignments require commercial link/quantity confirmation
before guarded idempotent Firestopping Schedule contribution. Existing formulas,
source bytes, prices, projects and physical authority boundaries remain protected.
AI Phases 5/6, Physical Model Lock and automatic matching remain outside scope.
Publication, actual CI/merge and activation are recorded in the release receipts.
