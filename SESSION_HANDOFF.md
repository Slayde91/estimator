# Session handoff

## Separate calculator PDFs and normal Exposure text - 2026-09-16

Branch: `feat/separate-calculator-pdfs`, based on verified PR #25 merge
`c4e1a79` (its post-merge CI also passed).

The existing `report.pdf` route now contains Full schedule only. New
`summary.pdf` serves Material quantities and summary: product and ancillary
tables, pooled orders, overall quantities and board EXTRA BOARDS. Both use the
complete draft and unchanged calculation projection; XLSX registers keep all
Summary/Schedule/Extra boards data. Neither PDF download saves the draft.
The toolbar puts schedule PDF before Excel register, then materials & summary
PDF. Editable Exposure schedule values use normal weight; headers retain bold.

Classification: report/presentation change and additive read-only export API.
No calculation, pricing, source-workbook, dependency or schema migration.

Verified before publication: 30 API/cleanup tests, all 11 PDF/projection tests
(including the corrected summary-only quantity assertion), nine display-metadata
tests, 128 UI checks (33 Estimator and 95 Calculator), JavaScript syntax and
scoped diff checks. Six HTTP-generated PDF scopes pass; the 1,000-item spray
schedule retains every unique mark across 67 pages, including the final item.
Rendered pages from every report type were reviewed, including repeating headers
and page breaks. Distribution build and isolated package wiring checks pass.
The full Python regression run is in progress. Exact-head CI/review, runtime
refresh and merge remain pending; later results belong in the local receipt.

Evidence is in `.runtime/calculator-pdf-split-qa`, including PDF render/checks,
API/UI logs, distribution checks, main-state backup and comparison records.
The user's 8765 browser tab has not been reloaded or edited. Browser QA uses
18787 with an isolated database. Preserve all open drafts and saved data.

Continue from current Git/checks. Finish the full regression run and current
head CI; record verified push/PR/merge in `publication.json`. Refresh only the
verified estimator server process, check both PDF routes and compare protected
saved data. Do not infer publication from this pre-publication checkpoint.

The pricing section below records the preceding work. PR #25 subsequently
merged at `c4e1a79`; its final receipt supersedes earlier pending statements.

## Historical: compact pricing workbook and restored use details — 2026-09-16

Current branch: `feat/compact-pricing-workbook`, based on PR #24 merge
`7408276`. That preceding release and its post-merge CI are verified; they do
not validate this increment.

The browser restores expandable Used in sections. Each product has one price
editor; each linked use retains its own category, selection, rate, price source
and yield. Search, group filters, unused products, standalone rates, remembered
open state and independent resets retain the existing pricing draft behavior.
Both pricing Excel actions remain green.

The new Inventory & Rates export has one row per product and 27 columns A:AA.
Product Sell price is distinct from use Sell rate. Group, Selection name, Price
source, Sell rate, Yield type, Yield, Rate ID and Use order are eight matching
semicolon CSV lists when a product has multiple uses. Empty positions are
preserved, embedded delimiters/quotes are escaped, and unequal list lengths are
rejected. A new blank-ID product receives one ID and its same-row uses link to
it. Standalone rate rows leave product fields blank. The previous combined
Inventory/Use rows and legacy Inventory/Rates sheets remain accepted. Import
still creates a reviewed draft until Save pricing; no commercial rule, catalog
model, dependency, SQL schema or saved quote is migrated.

Initial local checks: 34 unique workbook tests passed across runs
(ten compact and 24 legacy), including all three 216-scenario parity routes.
Five API integration tests initially passed in 159.698 seconds, and all 126 UI
checks pass (33 Estimator and 93 Calculator).
JavaScript syntax and scoped diff checks pass. The export contains 417 product rows with 166 uses in matching
same-row lists; reimport preserves every effective catalog value, link and
dropdown order exactly.

Excel 16.0 build 20326 opened both the preceding 583-row workbook and the new
417-row workbook with normal loading. A native SaveCopyAs followed by app import
preserved the exact catalog, with zero changes. Both new sheets were rendered
and reviewed, including the ten-use N/A row and two-use SBR product. Browser
review confirmed the SBR/Primers filter and restored closed/open details:
Primer draft yield 155 survived close/reopen while Topcoats retained 142.

Initial CI on pushed commit `ba98894` exposed three missed paths: a shared
column limit rejected board schedules, a server test expected the preceding
workbook layout, and openpyxl without lxml normalized quoted CRLF text. The
corrections retain the shared schedule envelope, adapt the server test without
dropping draft/snapshot checks, and restore exact strings before XML carriage
return escaping.

Correction checks pass: all 13 schedule tests (42.188 seconds), all 14 server
tests (21.797 seconds), and seven focused serializer/precision/security tests
with `OPENPYXL_LXML=False` (37.618 seconds). The serializer checks include forced
fallback, text-only sheets, mixed line endings and exact numeric values across
two saves. Schedule checks also verify that a pricing workbook uploaded to any
of the three calculators produces a validation error. That correction audit
found no issues; syntax and scoped diff checks pass. Both CI runs on `b0b058a`
passed 274 Python tests with four optional source skips, 126 UI checks and build.

A subsequent native Excel edge probe found that Excel saves CRLF using OOXML
text escapes. The final pricing-only correction decodes canonical text once
after archive preflight and protects literal escape-looking text on export.
It extends text exchange only, without changing commercial rules or calculator
templates. Five API tests with the final parser pass (55.331 seconds, no skips).
The native three-use probe preserves names, rates, yields and IDs exactly, with
zero import changes. Eight focused workbook tests pass (39.907 seconds),
covering canonical shared/inline/rich text, literal escapes, invalid Unicode
and references, duplicate cells, formula/nonfinite rejection and precision in
all supported layouts. The no-lxml path also passes.

The final native literal-text probe opened and saved normally in Excel 16.0
build 20326. Exact text survives native SaveCopyAs and app import: CRLF/LF,
quoted semicolons, spaces and literal `_x000D_`, `_x005F_` and bare `x005F_`.
All three precise rate/yield pairs and identities remain exact, with zero
import changes. The `b0b058a` CI success precedes this final correction: fresh
corrected-head CI, final runtime rechecks and publication remain pending.
Record final evidence in `.runtime/compact-pricing-qa/publication.json`; verify
current Git and runtime facts before extending this checkpoint.

Next action: publish the verified corrections through the existing PR and
finish refreshed-runtime/live-state validation. Keep CI running in the background while
completing independent review and evidence work. Tracked changes belong to this
pricing exchange/presentation increment; QA exports, logs and database copies
stay ignored. Preserve the user's open drafts and live saved data.

Resume prompt: Continue `feat/compact-pricing-workbook` from current repository
state. Read this checkpoint, inspect the five documentation files and current
diff, complete the outstanding refreshed-runtime/saved-state checks without
repeating verified work, then commit/push/PR/merge when exact-head
CI and review permit. Record the verified merge and remaining local changes in
`.runtime/compact-pricing-qa/publication.json`. Do not change pricing rules or
overwrite the user's drafts.

## Historical: visible pricing yields and Excel views — 2026-09-16

Published as PR #24, merge `7408276`, with successful post-merge CI. The evidence
below records that release; the current increment restores expandable browser
details and replaces its separate Excel Use rows with same-row lists.

Branch `fix/pricing-workbook-views-and-visible-yields` starts from verified
PR #23 merge `53c875dc4d4d7e576507f8d93bf1957e1c39e7ec`. The browser now shows
each use's category, selection name, sell rate and yield inline beside its
product. Shared product fields have one editor across multiple uses. Search,
group filtering, standalone/unused items and independent product/rate/yield
resets retain the existing draft and pricing semantics.

The user's exported workbook contained duplicate pane selections and a
nonexistent bottom-right pane on Instructions, matching Excel's sheet2 view
repair message. All 166 Use rows were also hidden. The exporter now configures
the final C2/A2 freeze once per sheet, replaces selections with valid unique
panes, and exports every Use row visible without row outlining. Inventory rows
still leave use-only fields blank; the Use rows own groups, price sources,
yields, Rate IDs and use order. Optional property columns P:Z remain expandable.
Typed values, exact headers, legacy imports, calculation rules, stable links,
storage and saved-quote snapshots are unchanged.

Verified locally: 24 pricing workbook tests passed in 198.670 seconds, including
the legacy and combined 216-scenario parity comparisons, import/security checks,
numeric precision, visible rows and OOXML view invariants. All 32 Estimator UI
checks and four integration tests (56.458 seconds) pass.

Microsoft Excel 16.0 build 20326 opened the corrected workbook read-only with
normal loading (`xlNormalLoad=0`), retaining both sheets and 583 data rows. The
original failed the same native open. Inventory & Rates freezes two columns
and one header row. All original/corrected cells in that sheet have exactly
equal values: 417 Inventory and 166 Use rows, all visible. Artifact Tool rendered
both sheets and confirmed the visible rows and legible instructions.

Browser verification changed SBR supplier cost to 300 and markup to 20%, making
both linked Primers/Topcoats rates 360. A Primer override of 400 and yield 155
left Topcoats unchanged. Reset rate retained yield 155; Reset yield restored
142. These checks preceded the successful PR #24 publication. Its release
evidence is retained in `.runtime/pricing-visible-yields-qa/publication.json`.

The reported workbook was read only and copied to
`.runtime/pricing-visible-yields-qa/before-pricing.xlsx`; source SHA-256 is
`d7f617fc180432b6258be40f67984eef84bfbfd72b32c5fe45fb5facfffc0baf`.
The same QA folder contains recovery and validation evidence. Preserve the
user's workbook, open Excel/browser drafts and live saved state during QA.
The earlier pricing layouts below are historical; the current behavior is
described at the top of this handoff.

## Calculator presentation polish — 2026-09-16

Published as PR #23, merge `53c875dc4d4d7e576507f8d93bf1957e1c39e7ec`.
The following text retains its original validation checkpoint.

Branch `feat/calculator-presentation-polish` starts from PR #22 merge
`a4c8ffca5757f8abb96adff6eb6ab133e29f74c9`. The twelve browser comments use
existing display metadata and shared styles: Excel-green Export template;
native quick Section ID; scoped omission of 15/45-minute comparison columns
and the dynamic source-reference row; one BAGS note spanning its redundant
blank spacer; consistent yellow label/value-cell surrounds; normal text-entry
weight and bold diagnostic labels. Source values and formula graphs remain.

Verified locally: 12 focused Python checks, 93 calculator UI checks and 30
Estimator UI checks pass. All 104,068 source cells/input properties and option
sets across twelve HTTP worksheets match the baseline. Browser checks cover
all five product settings, all three Excel toolbar styles, quick section
selection/recalculation, the material-note merge and desktop/mobile layout.
Independent production-diff review found no actionable defects. Full exact-head
CI and merge results belong in the final publication receipt.

The quick section choice remains strict and source-backed. Comparison omissions
must stay local to B28:B30 and D28:D30, since column D contains input fields
elsewhere. H23:N24 is display-only evidence removal. BAGS H6:N10 replaces the
display split at row 10 without hiding the yield value in D10.

Recovery, source-value comparisons, browser evidence and the eventual exact-head
CI/merge receipt are retained in `.runtime/calculator-polish-qa`. Test writes
use an isolated database; do not reload the user's own browser tab or save test
values to `.runtime/estimator.sqlite3`. Prior pricing release PR #22 is merged;
its receipt confirms unchanged stored quotes/settings and the live new template.

## Unified Inventory & Rates — 2026-09-16

Branch `feat/unified-inventory-rates` starts at PR #21's merge
`ab48bafc45c13cd6077647f10aa4894e4fa64fad`. Pricing now has one product/use
view with search, an explicit Used in Estimator filter and expandable use rows.
Each category's price/yield controls have distinct accessible labels and separate
reset actions. Unused products, standalone rates and imported price overrides
remain available. Pricing import/export actions use the shared Excel green.

The combined Inventory & Rates worksheet owns product values once and groups
Use rows beneath their linked inventory. Use groups start collapsed; collapsed
and filtered rows still import. IDs establish links independently of row order,
and Use order preserves dropdown order. Both this new format and previous
Inventory/Rates workbooks reuse the existing normalization/validation path.
No pricing rule, original model, database schema or stored quote was migrated.

Local validation passes: 22 workbook tests, four HTTP integration tests,
14 server tests, 11 Calculator tests and 122 UI checks. The 216-scenario Excel
oracle passes through both workbook layouts. Native browser review covers the
combined list, filter, shared pricing, local override/yield, reset and Save pricing
in an isolated test database. Artifact Tool rendered both new sheets for review;
the workbook's outline flags were also checked. Native Excel was not automated.

Recovery and evidence: `.runtime/unified-pricing-qa` holds the live database
backup/state digest, original and new template previews, focused logs, and the
publication receipt once CI and merge finish. The ready template is
`C:/ESTIMATOR/outputs/unified-inventory-rates/ceasefire-pricing.xlsx`.
The current live database is `.runtime/estimator.sqlite3`; test writes use only
the separate browser.sqlite3 or temporary test databases. Keep user's open
browser drafts intact during service refresh.

## Shared estimating notice — 2026-09-15

Branch `feat/shared-estimating-notice` starts from merged PR #20,
`e843cf7a09b6ec20f14ff93ebe7ad0863cbbb148`. The shared HTML footer now displays
the user's exact CEASEFIRE PFP estimating notice beneath all browser views,
with wrapping text. Pricing-library consolidation was discussed only; no
pricing schema, calculation, import/export or stored-data changes were made.

Verified locally: the note follows content in Estimator, Calculators, Pricing
library and Saved quotes; its layout was visually reviewed. All 117 existing
UI checks pass, `git diff --check` passes, and the 35-file distribution builds.
Publication evidence is retained in `.runtime/footer-notice-qa` once available.
The earlier labour/control checkpoint below is historical; PR #20's final
successful CI and merge are recorded in `.runtime/labour-controls-qa/publication.json`.

## Labour days and calculator controls — commit-preparation checkpoint, 2026-09-15

Work on `feat/labour-breakdown-calculator-controls` starts from PR #19's merge
`335f4b6e0eac2419cb2b7f8c98998c0f5661d5d7`. The latest 27 browser comments
extend the existing presentation boundaries:

- Estimator Labour breakdown sits between Calculation breakdown and quote
  notes. `labour_breakdown(result)` projects eight task-day values, B44 subtotal,
  B53 masking, C119 adjusted extra labour, half of C112 mobilisation count and
  F10 total days. B37 pinning mirrors meshing and is not added twice; F2 labour
  money is separate. Missing/error values remain unavailable or explicit errors.
  Fresh results include `labour`; older saved-quote responses add it to a copy
  using stored cells only. Saved data and existing report calculations remain.
- Vermiculite START omits SOURCE CONFLICTS rows 304–307 and ORIGINAL TAKE-OFF
  rows 316–319. A7 guidance moves from SETTINGS to START beneath A270. The quick
  calculator title is QUICK CALCULATOR with its subtitle removed; A356/A370
  factor titles are shorter. These are browser changes over retained source cells.
- Requested board schedule C/D/H/J and extra-board B/C choices and duct C/E/H/I
  choices use native selects. Original warning/allow-other fields keep explicit
  custom editors. Large lists, including 1,342 board steel sections, materialize
  on opening without tightening validation or rewriting saved choices.
- The board schedule title and live Y6 warning follow CALCULATED SUMMARY,
  directly before schedule rows. BOARD SUMMARY B/C/D12:29 show mm and J12:J29
  m² only for numeric values. Duct SUMMARY has four logical wrappers and blank
  spacing, with existing per-table columns and values retained.
- Shared toolbar helper text is removed. Import is yellow, Excel register green
  (#217346) beside Export template, and PDF red.

The native source audit `.runtime/labour-controls-qa/labour-source.json` records
Quote.xlsm labels, original formulas, imported matches and source SHA-256
`97fd43c4e55d3744e4348bf3596a3ab2a67357f12891524bfdb115f43b45c1a0`.
Native F10 is `SUM(B44,B53,C119)+0.5*C112`, labelled Total Days. Source inspection
was read-only; cached values are evidence, not runtime calculation answers.

Verified so far: all 92 calculator UI and 25 Estimator UI checks pass (117
total), plus both JavaScript syntax checks. Labour coverage includes literal
labels, missing/errors, exact totals, clearing and stale-response rejection.
Native review covers all 27 comments and confirms 13 labour rows and the default
0.50 days. All 104,068 calculator source cells across twelve API worksheets and
all three calculator PDF text/register-value projections match the baseline.
Six Estimator API cases preserve every pre-existing result field; only the
additive labour projection differs. Native evidence is retained in
`.runtime/labour-controls-qa/browser-checks.json`.

The full local Python run remains in progress at this checkpoint, including
slow optional native-workbook extraction. It encountered a legacy metadata
expectation that has since been corrected and one HTTP error awaiting its exact
trace. The complete affected modules still require a focused rerun as needed.
This record does not claim a clean full Python pass, distribution-build success
or refreshed-runtime verification.

Local classification: intended calculator projection, response enrichment,
presentation metadata, UI, tests and docs remain uncommitted; ignored audit and
runtime files stay under `.runtime/labour-controls-qa`. Source packages, workbook
formula rules, persisted input keys, schema and existing report calculations
are unchanged. Commit/push, PR, current-head CI/review and merge are pending.

Next action: classify and publish the prepared change while the remaining local
source audit finishes. Resolve the recorded test outcomes, require successful
exact-head CI/review before merge, and verify the refreshed runtime and merge.
The final receipt is `.runtime/labour-controls-qa/publication.json` after
publication. Verified Git, checks and that receipt supersede this checkpoint;
this document is not a claim that those later actions already succeeded.

Continue with: “Inspect current Git and test evidence in C:\ESTIMATOR\app.
Finish the labour-days and calculator-controls increment on
feat/labour-breakdown-calculator-controls. Preserve source formulas, stored
inputs, old quote snapshots and export calculations. Consult current Git/checks
and .runtime/labour-controls-qa/publication.json for outcomes beyond this
commit-preparation checkpoint; do not repeat already verified work.”

## START, factor tabs and Estimator cleanup — 2026-09-15

Work on `fix/calculator-start-factor-tabs` starts from PR #18's verified merge
`de808e13cd723853229358459c9ac03c8a696893`. The latest twelve browser comments
extend the current presentation and initialization boundaries:

- Vermiculite `display_pages` presents START, CALCULATOR, SCHEDULE, BAGS,
  SETTINGS and FACTOR CALCS. The source `pages` list remains the same four
  worksheets. START displays operating rules A270:N340 directly; SETTINGS has
  seven global/product choices, and FACTOR CALCS three helper choices. Every
  editable helper still uses its original SETTINGS cell key.
- Settings headings A9/A17/A31/A64/A96/A173/A229 and operating heading A270 use
  concise aliases without the original number/slash prefixes. BAGS places its
  order table first, then MATERIAL QUANTITIES, the subtitle and manual form.
- CALCULATOR H6 has a distinct pale-blue highlight; its numeric mm suffix and
  published-value semantics remain. SCHEDULE F10:F1009 uses native Section ID
  selection from 553 active source choices, populated on opening to avoid
  duplicating that list across 1,000 initial controls. Y10:Y1009 uses normal
  weight. Duct SUMMARY removes contents navigation. Board SETTINGS A6:A34 and
  P6:P51 use bold first-column labels.
- New Estimator estimates set Notes B12 to blank without modifying immutable
  `data/calculator.json`. Explicit saved notes, including `Allowances` and blank
  strings, still load/edit/save exactly. The generated Work summary panel and
  its DOM writes are removed; API, saved-quote and PDF summary data remain.

No technical rules, workbook formulas, source packages, persisted input keys,
storage schema or export contract change. The new browser tabs project the
existing source worksheet rather than creating alternate calculation scopes.

Verified locally: all 89 calculator UI checks and 22 Estimator UI checks
passed (111 total), as did JavaScript syntax and whitespace checks and the
35-file distribution build. The 29 API/cleanup tests passed in 148.342 seconds;
13 section/tab contract tests passed in 30.917 seconds. The earlier focused
42 Estimator calculator/quote-details/storage/PDF tests also passed. These are
local results; current-head CI has not yet run at this checkpoint.

All 104,068 evaluated source cells across twelve API worksheets match the
pre-change snapshot, with digest
`482e389f0498903ce98d921e6dfacf82fa72ac490ebf615e981e9d42d03a4a90`.
All three PDF extracted-text projections and three Excel-register worksheet
value sets also match. This is semantic export comparison, not binary equality.
Immutable calculator data and calculation/export/storage modules are unchanged.

Native browser checks covered all twelve comments. START shows operating rules
without a chooser or controls. SETTINGS starts with seven hidden panels and
25 retained controls; FACTOR CALCS starts with three hidden panels and nine
controls still keyed to SETTINGS. The selected helper and exact D346 draft
`1.23456789` survive START-to-FACTOR navigation. BAGS orders the product table
before MATERIAL QUANTITIES, its A3 subtitle and manual table, with A1/A3 each
rendered once. H6 shows `26.00 mm` with RGB(220, 238, 255).

All 1,000 schedule rows retain native F-column selects. Opening F10 exposes
554 choices: blank first, then `1000WB215`, through `Z350-32H`; the current
`410UB54` value is retained. Y10 uses normal weight 400; board SETTINGS A6:A34
and P6:P51 use bold weight 750. Duct SUMMARY has no contents navigation and
retains nine tables. New Estimator B12 is blank and the work-summary panel is
absent. Review found and fixed two issues: stale helper directions in SETTINGS
A7/BAGS A27 now point to FACTOR CALCS, and native lists retain blank-first order.
Final independent review confirmed both fixes and found no remaining issues.

The main service refreshed successfully on port 8765. Served index.html,
app.js, styles.css, calculators.js and calculators.css match current files;
the new display tabs are active. Saved state is unchanged: schema version 2,
two quotes, zero settings and zero calculator-state records, with digest
`c541e453134d10e4a014ac26b330745fa0113988d140c3274c57d61102902ce4`.
Test logs, source/export comparisons, live-asset hashes and before/after state
receipts are retained under ignored `.runtime/tabs-notes-qa`; `dist/` remains
ignored distribution output.

Publication is verified by `.runtime/tabs-notes-qa/publication.json`. Feature
head `cc1ccf9a43b8c139e1d26e2ac6c07b08925c4f4e` was pushed on
`fix/calculator-start-factor-tabs`. PR #19 merged on 2026-09-15 at 12:06:31 UTC
as `335f4b6e0eac2419cb2b7f8c98998c0f5661d5d7`; feature and merge trees match.
Exact-head push run 34966369826 and PR run 34966376062 passed 235 Python tests
(231 passed, four skipped) and 111 UI checks. No reviews were recorded. The
receipt records matching live assets, unchanged saved state and a clean tree;
local runtime evidence and distribution output remain ignored.

Continue with: “Inspect current Git and test evidence in C:\ESTIMATOR\app.
Complete the START/FACTOR CALCS and Estimator cleanup on
fix/calculator-start-factor-tabs, preserving workbook sources, input keys,
calculation/export semantics and saved quotes. Update this checkpoint with
verified validation and publication results; do not repeat completed work.”

## Calculator section navigation — 2026-09-15

Work on `fix/calculator-section-navigation` starts from merged main `364a024`
(PR #17). The latest 21 browser comments are implemented through existing
presentation metadata and browser rendering:

- All three SETTINGS & RULES pages initially hide their sections. Native buttons
  select exactly one of eleven vermiculite, five duct or three board sections.
  Client selection is retained during recalculation and page switching; hidden
  settings remain part of the full draft, validation, save/reset and both reports.
- Vermiculite CALCULATOR/BAGS and board START omit contents navigation. BAGS
  displays its existing product-order table before the manual form, retaining
  stable source/table identities and using bold A20:A24 product names.
- Vermiculite SCHEDULE adds MEMBER SCHEDULE above its prepared rows. CALCULATOR
  L6 displays PUBLISHED VALUE; only numeric H6 results receive the mm suffix.
  CAFCO SETTINGS D42 review prose uses normal weight. Duct PRODUCT SETTINGS J94
  displays FYREWRAP APPLICATION TABLE.
- Generic completed-calculation subtitles disappear. Duct CALCULATOR, SUMMARY
  and PRODUCT SETTINGS omit only the exact copied-fixing explanatory notice in
  the browser. Loading, invalid-input and calculation-error feedback, all other
  warnings, API/source evidence and the approved fixing correction remain.
- Board START content expands with page scrolling instead of a nested vertical
  pane. The existing schedule scrollers retain their behavior.

The exact Settings rectangles and retained source boundaries are recorded in
`docs/CALCULATOR_PRESENTATION_MAPPING.md`. There is no new dependency, storage
schema, input scope, formula engine or technical rule. Six section-specific tests
passed in 25.867 seconds and all 28 API/cleanup tests passed in 168.515 seconds.
All 84 calculator UI checks, 20 original UI checks, syntax/diff checks and the
35-file distribution build passed. Before/after API snapshots match all 104,068 cells
across twelve worksheets, including values, editability and dropdown choices;
the cell digest remains
`482e389f0498903ce98d921e6dfacf82fa72ac490ebf615e981e9d42d03a4a90`.
The source audit found all 73 editable Settings controls and five read-only
material references in exactly one declared section each.

All three PDF text projections and all three Excel-register worksheet values
match the preceding main version. Browser review confirmed all eleven/five/three
Settings sections initially hidden with 34/11/28 controls retained, and exactly
one selected section visible. An unsaved vermiculite draft value survived section
switching; the hidden board general-settings B6 control remained present when
Diagnostic messages was selected.

The browser also confirmed CALCULATOR's PUBLISHED VALUE and 26.00 mm display,
MEMBER SCHEDULE with all 1,000 prepared rows, five bold BAGS product names, normal
CAFCO review prose and the shorter independent FyreWrap application heading.
Requested contents navigation and success/copy notices were absent. Board START
had no nested vertical scroll: table client and scroll heights both measured
1,430 px, with no grid/table maximum height. Independent final diff review found
no actionable issues.

The main service refreshed successfully on port 8765. Saved state matched the
baseline exactly: schema version 2, two quotes, zero settings and zero calculator
states, with quote/settings digest
`c541e453134d10e4a014ac26b330745fa0113988d140c3274c57d61102902ce4`.
Publication is verified by `.runtime/section-navigation-qa/publication.json`.
Feature head `d8d59c196d35cd89c1ad1a2fef021290dce3efac` was pushed to
`origin/fix/calculator-section-navigation`. PR #18 merged into main on
2026-09-15 at 11:10:08 UTC as `de808e13cd723853229358459c9ac03c8a696893`.
The merge and feature trees match. Push run 34961318221 and PR run 34961325645
both passed at that exact feature head: 227 Python tests (223 passed, four
skipped), 84 calculator UI checks and 20 original UI checks. No reviews were
recorded. The receipt records a clean checkout, matching served assets and
unchanged saved state. Runtime evidence and distribution output remain ignored.

## Calculator Excel registers — 2026-09-15

Every calculator has Download Excel register beside Download schedule PDF.
The new `calculator_register.py` adapter reuses `project_calculator_report`,
openpyxl and the existing exact numeric serializer. The shared browser download
action captures the draft, preserves concurrent edits and does not save it.
`POST /api/calculators/<id>/register.xlsx` uses the existing PDF validation and
source-identity boundary. Source graphs, quantity rules and schemas are unchanged.

- Summary includes numeric overview totals, all existing material/product tables,
  source qualifications and notes, plus the source filename and SHA-256.
- Schedule contains the PDF-equivalent used items and statuses, with separate
  quantity/length fields where applicable. Row 5 is the filter header and row 6
  begins the data; C6 freezes headings and identifying columns in Excel.
- Board Extra boards retains item number and source A:K/M:N values, including
  evidence; internal L is excluded. An empty register has an explicit no-extras
  message. Valid extras retain their original effect on pooled board totals.
- Values stay typed and unrounded with two-decimal display. Literal text cannot
  become formulas, hyperlinks or native Excel error cells. Each sheet explains
  that updating the register requires recalculating and downloading from the app.
  Export template / Import schedule remains the separate input workflow.

Verified locally: seven register tests passed in 36.386 seconds, 14 API tests
passed in 52.104 seconds, all 81 calculator UI and 20 original UI checks passed,
and syntax checks and the 35-file distribution build passed. Browser downloads
returned HTTP 200 for all three calculators; the vermiculite download displayed
its success message without console errors.

The bundled artifact-tool imported the three app-produced XLSX samples and
rendered representative ranges from all seven sheets without changing the input
files. Visual review found one formatting issue: adjacent numeric and text cells
needed separation. Final ductwork Summary and Schedule previews verified the
shared N/A alignment and subtle vertical separators, with clear columns and
all content visible.
The helper, sample workbooks, PNGs and render manifest are ignored under
`.runtime/excel-register-qa`; the renderer adds no production dependency.

The refreshed local service returned all three registers equivalent to the final
samples, with correct MIME types, filenames and no-store headers. All four served
asset hashes matched disk. Before/after saved data remained two quotes, zero
settings and zero calculator states, schema version 2, with digest
`c541e453134d10e4a014ac26b330745fa0113988d140c3274c57d61102902ce4`.
Publication verified: PR #17 merged commit `89d29b7` into main as `364a024`.
Both exact-head push and PR CI runs passed 220 Python tests (216 passed, four
private-source skips) and 101 UI checks. The retained publication receipt
confirmed the upstream feature HEAD, merged main tree and clean tracked/untracked
state at that checkpoint: `.runtime/excel-register-qa/publication.json`.

## Calculator detail layout — 2026-09-15

Work on `fix/calculator-detail-layout` starts from merged main `d2707ee`
(PR #15). The preceding 23 browser comments use the existing presentation metadata,
renderer and CSS; the SETTINGS & RULES rename was already completed in PR #15.

- Vermiculite SETTINGS merges the D:G value region at rows 346–352, 358–368 and
  372–374 to absorb blank G dividers. A371:G371 becomes a collapsed decorative
  row while H371:N374 notes and all helper inputs/results remain intact.
- Vermiculite CALCULATOR's Thickness and quantities row 6 displays label L6
  first across three columns, then value H6 across four columns with left
  alignment. Source anchors and original row spans remain unchanged; the
  previously centered A28:I30 period table remains centered.
- SETTINGS technical-rule headings A48/A81/A113/A190/A246 use the pink
  table-header role. References D75/D107/D184/D240 use normal font weight.
  Exposure names A55:A58, A87:A90, A124:A167, A197:A223 and A260:A264 are bold,
  as are SCHEDULE Exposure/Case cells C10:C1009 and their selection controls.
- Duct CALCULATOR AM11:AM310 support prose uses normal weight; AM10 retains its
  existing heading style. PRODUCT SETTINGS A142:A150 extends the bold reference
  labels through Maxilite. Board purchasing product labels A12:A29 are bold.
- Board CALCULATOR, BOARD SUMMARY and EXTRA BOARDS overviews use full-width
  title/note rows and retain the three BOARD SUMMARY cards. Board A1 titles read
  BOARD SUMMARY and EXTRA BOARDS. The shared running-total sections read SUMMARY
  for board and PRODUCT SUMMARY for vermiculite; worksheet/input keys stay intact.

These are browser display changes. Source packages, values, merges, formula
graphs, input allowlists, technical rules, saved-data behavior, schema and PDF
projections remain unchanged. Verified locally:

- All 25 targeted Python tests passed in 96.918 seconds. All 75 calculator UI
  checks and 20 original UI checks passed, as did JavaScript syntax checks.
  The distribution build produced 34 files totaling 5,345,255 bytes.
- Before/after HTTP comparisons matched all 104,068 cells across 12 worksheets,
  including values, editable/calculated flags and shared choices. The cell digest
  remains `482e389f0498903ce98d921e6dfacf82fa72ac490ebf615e981e9d42d03a4a90`.
  All three PDF text comparisons matched: vermiculite 3 pages, board 8 and duct 4.
- Browser review confirmed L6 before H6 with spans 3/4. The H6 value of 26 was
  left-aligned at x=547.1328125, matching the neighboring value-column position.
  All five technical headings matched A54's pink fill and font weight. Four
  reference values used weight 400; exposure lookup text and the first/last
  schedule Exposure/Case controls used weight 750.
- Helper values spanned D:G without separate G dividers. Row 371 had zero
  height while its retained right-side note remained visible at 112.8 px high.
  All 300 duct AM prose cells used weight 400, and A142:A150 used weight 750.
- All three board title/note overviews were 1,203 px wide at x=31. The summary
  retained three cards in a 1,151 px region with a 26 px inset; all 18 purchasing
  product names used weight 750. Every requested title alias was correct.
  Browser logs contained no application errors; independent diff review was clean.

The main service refreshed successfully at port 8765. All four served assets
match the current files byte for byte, and the new presentation metadata is
active. Before/after database state matches exactly: two quotes, zero settings,
zero calculator-state records, schema version 2 and quote/settings digest
`c541e453134d10e4a014ac26b330745fa0113988d140c3274c57d61102902ce4`.
Recovery, test, browser, worksheet, PDF and runtime receipts are retained under
`.runtime/detail-layout-qa`.

Commit, push, exact-head CI/review and merge remain pending at this checkpoint.
The post-merge publication receipt will be retained separately in the ignored
QA folder after verification. Earlier entries below do not verify this increment.

## Settings title — 2026-09-15

The shared browser settings banner now reads **SETTINGS & RULES** in place of
Product Settings and Rules. This changes only the displayed A1 title on
SETTINGS/PRODUCT SETTINGS pages; worksheet names, source values, formulas and
reports retain their existing identities. The existing UI title check covers all
three calculator settings pages. Publication evidence for this increment belongs
in `.runtime/settings-title-qa/`; earlier entries below describe prior increments.
Local validation passed: JavaScript syntax and all 73 calculator UI checks. The
served `calculators.js` bytes match the updated file; no server restart is needed
for this static asset. Source files and database contents were not edited.

## Calculator units and table labels — 2026-09-15

Work on `fix/calculator-units-and-table-labels` starts from merged main
`7ce244d` (PR #13). The latest 21 browser comments are addressed through the
existing presentation metadata, renderer and CSS; no architecture or storage
migration is introduced.

- Vermiculite SCHEDULE A4/G4 display TOTAL ENTERED SPRAY AREA (m²) and COATING
  VOLUME QUANTIFIED (m³), retaining the source values and formulas.
- Vermiculite running material totals and board Board Totals are independent
  full-width sections after their overviews. Their explanatory notes use gold
  fill; source-derived quantities and summary cards remain intact.
- BAGS manual-form rows 6–15 show A:F and H:N, omitting only decorative G. The
  gold spacer becomes H10:N10; A10:C10 and D10:F10 retain the working-yield
  label/value. Order-table G19:G24, including pooled Whole bags, stays visible.
- All SETTINGS/PRODUCT SETTINGS tables expand to their content height, including
  tables outside explicit projections. Prepared schedule scrollers retain their
  existing vertical behavior, and horizontal overflow remains available.
- Duct SUMMARY labels A9:A11, A19:A26 and A31:A32 are bold. PRODUCT SETTINGS
  label anchors are A8:A35, A37:A39, A50:A73, A75:A79, A96:A115, A118:A121,
  A124:A127, A130:A134, A137:A141, J96:J104, J117:J130 and J137:J149.
  Adjacent ancillary prose retains its existing formatting.
- The user confirmed comment 21 targets the vermiculite CALCULATOR's complete
  published-period table. Alignment metadata centers A28:I30 only.

Source packages, source merges, formula graphs, input allowlists, technical
rules and PDF projections remain unchanged. Verified locally:

- All 25 targeted Python tests passed in 65.859 seconds. All 73 calculator UI
  checks and 20 original UI checks passed, as did JavaScript syntax checks.
  The distribution build produced 34 files totaling 5,344,425 bytes.
- Before/after HTTP comparisons matched all 104,068 cells across 12 worksheets,
  including values, editable/calculated flags and shared choices. The retained
  cell digest is `482e389f0498903ce98d921e6dfacf82fa72ac490ebf615e981e9d42d03a4a90`.
  All three PDF text comparisons matched: vermiculite 3 pages, board 8 and duct 4.
- Browser review confirmed the units and full-width material totals: grid,
  heading and table were each 1,203 px wide and shared the same 31 px left edge.
  All 27 A28:I30 header/data cells were centered. BAGS had 13 manual-form columns,
  no decorative G column, a gold H10 span of seven columns and the retained
  working-yield display of 0.07 at D10.
- Vermiculite SETTINGS had a 14,670 px content height, no height cap and equal
  client/scroll heights. All 134 targeted Duct labels had font weight at least
  700; all four Duct settings wrappers had no height cap or vertical overflow.
  Browser logs contained no errors. Independent review found no actionable issues.

The saved-database baseline contains two quotes, zero settings records and zero
calculator-state records. Recovery, test, worksheet and PDF evidence is retained
under `.runtime/units-labels-qa`. The retry successfully refreshed the main
service at port 8765. All four served assets match the current files byte for
byte, and the new presentation metadata is active. The before/after database
comparison retained all records exactly, with schema version 2 and quote/settings
digest `c541e453134d10e4a014ac26b330745fa0113988d140c3274c57d61102902ce4`.

Commit, push, exact-head CI/review and merge remain pending at this checkpoint.
The post-merge publication receipt will be recorded separately under the ignored
QA folder once those outcomes are verified. Earlier entries below are historical
and do not verify this increment.

## Estimator controls and calculator row presentation — 2026-09-15

The latest eleven browser comments remove the Estimator Workflow dropdown and
rename the existing dimensions/measurement textarea to NOTES. Its underlying
`measurements` field and stored text remain unchanged. Internal saved workflow
values and the existing new-estimate default continue to feed calculations,
saves and reports; removing the control does not change the workflow rules.

Independent presentation tables, including the board purchasing table, expand
to their full height without nested vertical caps. Horizontal overflow remains
available, and the prepared schedule scrollers retain their existing behavior.

The existing presentation metadata adds explicit browser-only cell overrides:

- Duct CALCULATOR A3 has a note role. Its title and note occupy full rows, with
  the note using the same gold fill as SUMMARY.
- Duct SUMMARY A17:L17 and A29:L29 replace the original A:F merges only in the
  browser, allowing both red section headings to span the full row.
- Duct PRODUCT SETTINGS merges each blank gray row J105:Q105, J108:Q108,
  J111:Q111, J131:Q131 and J136:Q136. Outside borders remain; internal dividers
  are removed without hiding adjacent text, settings or lookup records.
- Vermiculite BAGS merges the blank G10:N10 region into one gold span, retaining
  the A10:C10 label and D10:F10 working-yield value.
- Duct PRODUCT SETTINGS omits USE NOTES rows 153–159 and the associated contents
  link in the browser. The source cells, API values and report projection remain.

These are rendering and form-control changes with no source workbook/package,
formula, calculation rule, storage schema or report-scope change. No migration
is required. Verified locally on `fix/calculator-banners-and-spacing`, based
on merged main `8d460c9`:

- All 25 focused cleanup/presentation API tests, 71 calculator UI checks and
  20 original UI checks passed. Both JavaScript syntax checks and the 34-file
  distribution build passed. Independent review found no actionable issues.
- Before/after HTTP comparisons matched all 104,068 cells across 12 worksheets,
  including values, editability, calculated flags and shared choices. The three
  calculator PDFs retained identical extracted text (3/8/4 pages).
- Isolated browser checks confirmed the absent workflow selector, NOTES label,
  full-width duct introduction with a yellow note, single-cell full-row summary
  headings, five merged gray separators, retained 11 settings inputs, and no
  USE NOTES section/link. The retry also confirmed BAGS A10/D10/G10 as three
  cells with spans 3/3/8 and matching gold fills. Board purchasing retains 18
  stock rows, six columns and three cards; its wrapper has no height cap and
  equal client/scroll height (897 px), so no inner vertical scrolling remains.
- The live database was backed up before refresh. Test, saved-data comparison
  and publication records are under `.runtime/banner-spacing-qa`.

The user-authorized retry refreshed the main server successfully. The served
app, calculator and HTML asset hashes match the current files; all new Python
display metadata is active. Saved quotes, pricing/settings and calculator state
match the retained backup exactly. The QA server and both verification tabs
were closed; the user's original tabs were left untouched.

Commit, push and exact-head CI/merge are pending at this pre-publication
checkpoint. The final `.runtime/banner-spacing-qa/publication.json` and task
reply record verified publication outcomes. Earlier entries below do not
verify this increment.

## Calculator visible columns — 2026-09-15

The latest four browser comments request a smaller board purchasing table,
hidden extra-board evidence fields and removal of the advanced-column checkbox
throughout the calculators. The implementation extends the existing browser
presentation metadata and renderer; no architecture or data migration changes
are required.

BOARD SUMMARY rows 11–29 use an independent six-column table: A:D and I:J.
The four area columns E:H and the Stock source/Board key columns K:L are hidden
only within that table. All eighteen stock rows remain, together with the three
cards sourced from A6/E6/I6, the live qualification and notes A31/A35. Their
underlying formulas and intermediate quantities still support the original
pooled totals and report projection.

EXTRA BOARDS column N, Evidence reference, is omitted only from the browser.
Its editable API identity and existing N6:N45 saved values remain available;
all forty visible rows retain their other inputs and status. This bounded,
user-requested omission must be tested as an exception to the usual rule that
display omissions do not hide editable source fields.

All calculator tabs use the normal worksheet view without a Show advanced
columns checkbox. Browser instructions no longer direct users to that control.
The worksheet API retains `include_advanced`, and hidden advanced inputs keep
their saved values and calculation effects when a visible field is edited or
saved. Source packages, input allowlists, calculations and PDF scope stay intact.

Validated on `fix/calculator-visible-columns`, based on merged main `56f98d1`:

- All 12 cleanup/API tests passed, including first/last hidden evidence values,
  saved optional inputs and unchanged summary quantities after a visible edit.
- All 69 calculator UI and 17 original UI checks passed; JavaScript syntax and
  the 34-file distribution build passed. Independent diff review found no issues.
- Before/after HTTP comparison of all 12 pages matched all 104,068 cell values,
  editable/calculated flags and shared choices exactly. All three PDFs retained
  identical extracted text (vermiculite 3 pages, board 8, ductwork 4).
- Isolated browser verification confirmed six stock columns and 18 stock rows,
  all three summary cards and the A8/A31/A35 qualification/notes; EXTRA BOARDS
  retained 40 rows and 360 visible inputs with no evidence column or checkbox.
- The live database was backed up before refresh. Local evidence is under
  `.runtime/visible-column-qa`; the final saved-data comparison and publication
  record are written there after refresh/CI/merge verification.

Commit, push, exact-head CI and merge are pending at this pre-publication
checkpoint. Do not infer those outcomes from the local checks above. The final
publication record and task reply give the verified Git result. Results in the
preceding entries below are historical and do not verify this change.

## Calculator sections and black grids — 2026-09-15

Started from clean merged main `5998389` (PR #10), on
`fix/calculator-sections-and-grids`. The 27 browser comments are addressed
through the existing presentation metadata, shared renderer and CSS.

Vermiculite CALCULATOR stacks its input form, thickness/quantity results and
published-period table, with each source heading attached to its own table.
BAGS displays MATERIAL QUANTITIES and attaches PRODUCT ORDER SUMMARY to its
table below the manual form. Duct PRODUCT SETTINGS stacks the main FyreWrap,
application and penetration tables, retaining all side notes and the complete
H-selection lookup tail. Both requested Settings introductions are hidden.

Main sections share red backgrounds and white titles. All calculator data grids
have solid black lines; first columns scroll horizontally with their tables.
Populated notes share the existing populated-output fill, while blank output
cells keep their separate fill. Projected field labels and each table's column
headers are distinguished from section banners and adjacent workbook tables.
Decorative spacer rows above the period/order tables are omitted; prepared
input rows and blank calculated rows remain.

The marked duct roll width and board gap fields were already allowlisted,
editable suggested-value controls. Browser editing, recalculation, save and
reload retained 1.22 m and an exact 0.007 m gap. Their workbook rules have not
been broadened; fixed adjacent constants remain read-only. Focus reveals the
exact value and the resting display retains two-decimal formatting.

Verified locally:
- Three metadata/input-persistence checks passed (12.512 seconds), including
  immutable package hashes, omission safety, non-overlapping projections,
  lookup-tail retention and exact save/reload of the marked settings.
- All six native Excel regression tests passed (122.811 seconds), covering
  all three default workbooks and retained variations.
- All twelve worksheet/API/report checks passed (44.219 seconds). All 68
  calculator UI checks, 17 original UI checks, JavaScript syntax, build
  (34 distribution files) and whitespace checks passed.
- All 104,068 source cells, input/formula flags and dropdown choices across
  all twelve pages matched before/after and on the refreshed main service.
- PDF text matched before/after for vermiculite (3 pages), board (8 pages)
  and duct (4 pages).
- Live browser review covered all twelve tabs, main section styles, source
  headings attached to their tables, note highlights, black grids, unpinned
  first columns, 1,000/300/200 schedule rows and 40 extra-board rows, retained
  three board-summary cards and normal-weight Row status. Browser logs were empty.
- Independent actual-data renderer review found no missing/duplicated inputs,
  outputs or contents links, and confirmed precise values and control identity
  through recalculation. No actionable findings remained.

Runtime QA, PDF comparisons and the original-database recovery backup are
ignored under `.runtime/section-grid-qa`; distribution output stays in `dist/`.
The main service was refreshed with its existing database; served assets and
section metadata match the final code. Both saved quotes and all pricing and
calculator records matched the recovery baseline. The user's browser tab was
left untouched. Refresh after saving any current draft to load the new UI.
There are no source workbook/package, formula, technical rule, schema or pricing
changes. The existing external board XLSX re-save identity difference is
documented in PR #9 and is separate from this presentation change. Publication,
full CI and verified merge results are retained with the PR and local receipt.

## Calculator labels and column order — 2026-09-15

Started from clean merged main `ef5cfc6` (PR #9), on
`fix/calculator-labels-and-columns`. All twelve browser comments are implemented
as display changes. The user's clarification removes only the board schedule's
INPUTS / RESULTS labels and keeps all three BOARD SUMMARY total cards.

The board schedule title is STRUCTURAL STEEL BOARD SCHEDULE; the product table
heading is Board Totals. Requested production and introductory text is omitted,
while the live incomplete-order warning remains. Duct titles are DUCT PROTECTION
CALCULATOR and DUCT PROTECTION SUMMARY. The requested duct introductory text,
fixing/qualification/source columns and blank AR spacer are hidden in both
normal and advanced views. Spray body volume and working yield follow combined
angle length. Source coordinates, inputs, formulas and reports are unchanged.
Exact mappings are in docs/CALCULATOR_PRESENTATION_MAPPING.md.

Verified locally:
- The metadata/source-package preservation test passed (16.086 seconds), with
  no editable cells overlapping omitted rows, columns, ranges or title aliases.
- Four native Excel parity tests passed (69.891 seconds), covering duct and
  board defaults, retained variations and the approved duct instruction exception.
- All 63 calculator UI checks and 17 original UI checks, JavaScript syntax,
  build (34 files) and whitespace checks passed.
- All 36,176 source cells, input/formula flags and dropdown choices across the
  four affected pages matched before/after, including the refreshed main service.
- Board (8 pages) and duct (4 pages) PDF text matched the pre-change reports.
- Live browser review confirmed 200 board and 300 duct schedule rows, all inputs,
  retained three summary cards, renamed titles and normal/advanced column order.
  Doubling a test duct length from 10 to 20 m changed volume from 0.60 to 1.20 m³
  and bags from 11.70 to 23.40; the new layout survived recalculation. The test
  input was restored. Browser error logs were empty.
- Independent code and real-renderer review found no actionable issues; it also
  checked control retention, unchanged raw results and the live order warning.

The local service was refreshed with its original database. Both saved quotes
and all pricing/calculator records matched the recovery baseline. Served assets
and display metadata match the current code. The user's open tab was left
untouched; refresh it to load the new interface, after saving any current draft.
Isolated QA databases, PDFs, recovery backup and logs remain ignored under
`.runtime/label-column-qa`; the distribution is ignored under `dist/`.

This change does not alter source workbooks/packages, architecture, schema,
pricing or passive-fire rules. The external board workbook re-save identity
difference documented in PR #9 remains a separate existing limitation; no
fresh byte-for-byte source-file claim is made here. Current native calculation
regressions use the retained Excel results. Publication, exact-commit CI and
merge evidence are recorded in the associated PR and local publication receipt.

## Board settings and product totals — 2026-09-15

Started from clean merged main `2927cbe` (PR #8), on
`fix/board-settings-and-product-totals`. The seven board browser comments are
implemented. SETTINGS now has three stacked sections with contents links:
General settings, Fire periods and temperatures, and Diagnostic messages.
Only D5:D34 and G12:N13 are omitted from view; all 28 editable settings and
the diagnostic lookup remain. BOARD SUMMARY has three source-total cards.
CALCULATOR replaces six cards with live product totals and keeps normal-weight
Row status, including after recalculation and in the advanced view.

The area column is accurately labelled Box reference area: the workbook does
not provide a universal steel-profile surface-area output. Product net board
and whole-sheet quantities group the source BOARD SUMMARY stock totals,
including valid extra boards and product/thickness rounding. The default
example remains 58.476 m² net board, 27 whole sheets and 74.4 m² purchase area.
Summing the individually rounded schedule sheets would incorrectly give 46.
Source incomplete-row warnings and product-specific counts remain visible.

Verified locally:
- Three cleanup/native Excel parity tests passed (45.768 seconds), including
  original board formulas and retained native Excel variations.
- Nine new product-total tests passed (27.155 seconds), checking retained
  Excel outputs, length/waste changes, valid/invalid extras, pooled rounding,
  final input rows, blanks, zero, case matching, errors and source isolation.
- Twelve complete-worksheet/API/report tests passed (124.329 seconds).
- All 60 calculator UI checks, 17 original UI checks, JS syntax, build and
  whitespace checks passed. The distribution contains 34 files.
- All 10,433 board worksheet cells, input/formula flags and dropdown choices
  matched the pre-change baseline, including on the refreshed main server.
- The eight-page board PDF text matched the pre-change report exactly.
- Live browser review confirmed three settings sections/contents links,
  28 settings inputs, three summary cards, four product-total rows, all 200
  schedule rows and 4,800 advanced controls. Editing a test length from 10 m
  to 20 m updated net board to 77.12 m² and sheets to 33.00. Row status stayed
  at font weight 400, its heading at 750, and output fills retained both states.
  Browser error logs were empty. Independent code/renderer review found no
  actionable issues.

The local service was refreshed using the original database. Both saved quotes
and all pricing/calculator records were verified unchanged. The user's open
Ductwork tab has an unsaved draft and was deliberately left untouched; save
the draft before refreshing that tab to load the new assets. Isolated QA
databases, reports, recovery backup and logs are ignored under
`.runtime/board-layout-qa`; build output remains ignored in `dist/`. No source
workbook, formula, architecture, schema, pricing or passive-fire rule changes.
Publication/CI/merge evidence is retained in the associated PR and local
publication receipt.

## Calculator table cleanup — 2026-09-15

Started from clean merged main `9e9939a` (PR #7) on the focused branch
`fix/calculator-table-cleanup`. The eight browser comments are implemented as
presentation changes. Duct SUMMARY uses four independent tables; requested
basis/source/interpretation and area-check columns are omitted only within
their own table. Wrap/roll columns share the other numeric column widths.
PRODUCT SETTINGS hides only J6:Q21, retaining the later working lookup tables.
Board START hides the version subtitle, counters and Sources section/link;
CALCULATOR AI9:AI208 uses normal font weight, including after recalculation.
Exact source mappings are in docs/CALCULATOR_PRESENTATION_MAPPING.md.

An independent audit found no editable overlap or formula references into the
removed ranges across 40,593 duct/board formulas. Immutable source packages,
input keys, formula graphs, saved data and report projections are retained.

Verified locally:
- Five metadata/native Excel regression tests passed (64.734 seconds), covering
  original and varied duct and board calculations.
- Twelve complete-worksheet/API/report tests passed (45.203 seconds), covering
  all twelve pages, final prepared inputs, dropdowns and saved-state isolation.
- All 57 calculator UI checks and 17 original UI checks, JS syntax, build and
  diff whitespace checks passed. The distribution contains 34 files.
- Before/after comparison matched all 39,640 source cell values and edit/formula
  flags across the five affected pages. Refreshed port 8765 matched as well.
- Duct (4 pages) and board (8 pages) PDF text matched the pre-change output.
- Browser review verified all omissions, four summary table shapes, 125px
  product quantity columns, the eleven retained duct settings controls, later
  FyreWrap tables, five board START section links, all 200 board schedule rows,
  400-weight row status and bold heading after recalculation. Output fills remain
  the two existing states. Independent renderer review reported no findings.

The local app was restarted with its original database; the two saved quotes
and all pricing/calculator records were checked unchanged. The user's browser
tab was retained. QA databases, reports, backups and logs are ignored under
`.runtime/table-cleanup-qa`; build output remains ignored in `dist/`. No schema,
architecture, pricing or technical-rule change. Publication and merge evidence
is retained in the associated PR and local publication receipt.

## Duct clearance column display — 2026-09-14

Started from clean merged main `f60ef4f` (PR #6), with the same tree as the
previous tested feature head. Created `fix/duct-clearance-column` without
discarding local changes. The user requested removal of the Ductwork CALCULATOR
**Penetration clearance guide** column if safe.

Only browser omission metadata changes: AK (37) disappears in normal and advanced
views. The 300 AK formulas, settings, full worksheet response and PDF projection
are retained. No dependencies on AK were found across the 24,059 source formulas.
MONOKOTE and FyreWrap clearance tables and CAFCO approved-detail guidance remain
in Product Settings. Adjacent AL fixing and AM support guidance stay visible.

Verified: the existing metadata regression and both duct native Excel regression
tests passed (3 tests, 18.770 seconds). All 53 calculator UI checks, JS syntax and
the build passed. A before/after comparison found all 27,900 complete-page cell
values, edit flags and formula flags identical. Browser checks confirmed all
300 rows and the final input remain, AK is absent in both views, and all AL/AM
guide cells remain; browser error logs were empty.

The local server was refreshed and its complete-page comparison also passed.
A backup/check confirmed the two saved quotes and all pricing/calculator records
are unchanged. The user's open tab was retained. Local QA, backup and comparison
artifacts are ignored under `.runtime/duct-clearance-qa`; `dist/` remains ignored.
Publication and merge evidence is retained in the associated GitHub PR and its
local receipt. No architecture, schema, pricing or technical rule changes.

## Historical: calculator display cleanup and locked references — 2026-09-14

Starting state: clean `feat/workbook-calculators` at `7cf8ca0`, matching its
fetched upstream (0/0 divergence); fetched main remains `615997c`. This increment
implements the user's display removals and latest explicit requirement that
Material basis/reference be read-only. It does not revise the yield profile.

Removed the reviewed-default button/evidence panel and the five products'
date, source-ID and document-name rows from Settings. All three Settings banners
read **Product Settings and Rules**. Vermiculite SCHEDULE hides the requested
top instructions and V/W/X columns, retaining all 1,000 inputs, the three summary
cards and pooled product quantities. Section 03 retains the period comparison
and removes its adjacent and trailing notes. BAGS uses nine real table columns
and proportional form widths; no desktop horizontal overflow remains at 1280px.

The five references are readonly in both worksheet projections and user-facing
HTTP/save validation. Existing saved reference text, including valid historical
multiline/blank values, remains recoverable. Known source/reviewed defaults are
accepted for Reset. Numeric settings remain editable at full precision. There
is no saved-state migration, schema change or alteration to source workbooks,
packaged formulas, native fixtures, default quantities or PDF projection.

Every data output uses the same populated fill (`#fff0ce`) or empty fill
(`#f2f3f5`), including zero, text, errors and non-formula blank table cells.
Structural headings and navigation remain distinct. Browser review caught an
inferred heading on the calculated source label and unclassified blank summary
cells; both were corrected and covered by regression tests.

Verified in this increment:
- All **198 Python tests passed in 478.142 seconds**, with no skips. This includes
  source reconstruction from the actual supplied workbooks, 419,905 original
  native calculator comparisons, 32,616 original Quote comparisons, and the
  reviewed-yield native scenarios/profile checks.
- Nine new cleanup tests cover 50 rejected reference-edit requests without
  database writes, saved-reference recovery/import/report/save, numeric precision,
  known resets, version guards and retained W/Y incomplete-order dependencies.
- JavaScript syntax, **53 calculator UI checks and 17 existing UI checks** pass.
- Browser review covered all twelve pages. Every observed populated data output
  uses `rgb(255, 240, 206)` and every empty data output `rgb(242, 243, 245)`.
  All Settings banners and five locked references were checked. The schedules
  retain 1,000/300/200 rows and 40 extra-board rows. Editing direct yield to zero
  switched Yield Used to the empty fill; restoring and saving 0.0651 retained the
  populated fill and full input precision in the isolated QA state. All eight
  period columns were 132px wide. At 390px, BAGS forms fit the page and only the
  wide order table scrolls internally; the viewport override was reset. Browser
  error logs were empty.
- The 34-file source build is **5,338,995 bytes**, SHA-256
  `827b4a2d8d8e53407b9aed80d3a8fe7251cbd66adfa6f1b2590ace2c4c4d9fe5`.
  An extracted copy served all twelve complete worksheets and the three PDFs
  (3 vermiculite, 4 duct and 8 board pages) with source-workbook access blocked;
  there were no attempted workbook reads. PDF layout code is unchanged.
- The local server was refreshed using `Start-Estimator.ps1 -NoBrowser` after
  a database backup. The two saved quotes, zero pricing rows and zero calculator
  states remain identical. The quote/settings SHA-256 is still
  `c541e453134d10e4a014ac26b330745fa0113988d140c3274c57d61102902ce4`.
  The user's browser tab/draft is left open; refresh after retaining unsaved work.
- Main server PID **24820** serves the exact tested JS/CSS/HTML. Its metadata
  confirms readonly references and presentation exclusions; live default totals
  remain 172.02548458861258 net / 173 whole CAFCO bags.

The publication checkpoint is recorded below when verified.
At the starting head, PR #6 was open, unmerged, without reviews; both Checks jobs
had failed before steps with the already documented billing/spending blocker.
This is not a passing-CI claim for the current increment.

Local-change classification: intended runtime, UI, regression-test and
documentation changes only. Database backups, isolated QA state, logs and package
checks are ignored under `.runtime/calculator-cleanup-qa`; `dist/` and caches are
also ignored. No user workbook, secret or unrelated file is included.

## Historical: Australian yield review and calculator refinements — 2026-09-14

Starting state: clean `feat/workbook-calculators` at `e39f28d`, matching fetched
`origin/feat/workbook-calculators`; main remains `615997c`. This increment follows
the user's specific yield, settings, navigation, schedule-summary and PDF requests.
No unrelated local changes or user work were discarded.

The reviewed profile in `data/vermiculite_yield_defaults.json` supplies twenty
explicit SETTINGS inputs: bag mass, direct yield, equivalent dry-material
consumption and editable material reference for each of five products. CAFCO
uses Australian published coverage (65.10 L/bag); MONOKOTE uses the current
Australian 21.80 kg pack with the retained uninjected yield. MANDOLITE's conflicting
coverage, PERLIFOC's batch/continuous distinction and theoretical/site-loss limits
are documented in `docs/VERMICULITE_YIELD_REVIEW.md`. Consumption density is inferred,
not installed coating density. This authorized estimating-default exception does
not alter thickness rules, source graphs or original native fixtures.

Absent saved states receive the reviewed inputs without a database write. Existing
saves remain exact. Use reviewed yield defaults merges only those twenty fields
into the draft; Reset calculator defaults also restores source example rows. Both
require Save calculator to persist. Explicit empty calculation inputs still use
original workbook defaults. All five material references accept multiline text.

Vermiculite SCHEDULE has three top metrics and a live per-product net/whole-bag
table sourced from BAGS, preserving pooled rounding and incomplete status.
SETTINGS has eleven coloured section anchors and linked contents instead of the
old product banner. The single-member comparison uses equal independent period
columns, including 120 minutes. All source input rows remain available.

PDFs retain overview, full schedule, EXTRA BOARDS, product/ancillary summaries and
closing totals. The four requested detail/helper/settings sections are removed.
Default reports are 4 duct pages, 3 vermiculite pages and 8 board pages. All fifteen
pages were rendered and visually inspected with no text-boundary violations.

Current verification:
- Independent native Excel 16.0/build 20326 captured 6,565 selected outputs across
  five scenarios; all match. A further 863 numeric/status checks use the actual
  installed profile against those independently captured expectations.
- All 38 defaults/native/worksheet/API boundary tests passed after updating two
  original-default expectations to distinguish source inputs from app defaults.
  Both original Quote/inventory reconstruction tests passed with the actual files.
- JavaScript syntax and 48 calculator plus 17 existing UI checks passed. Independent
  review found a disabled-button state after reset; the fix is covered by reset,
  invalid-input and corrected-input regressions.
- Browser review covered all twelve pages, equal 120-minute widths, all five
  editable references, precision-preserving save/reopen, live bag totals, linked
  sections and phone containment. A real schedule PDF download confirmed the
  captured draft and retained unsaved status. No browser errors were recorded.
- The final 34-file source distribution is 5,338,548 bytes, SHA-256
  `957a64737a94fab6bda4b821b614d21e0c95b761d9af661247ae0e6116c08ef7`.
  An extracted copy served all twelve complete pages and three PDFs with original
  workbook filesystem access blocked; there were zero attempted source reads.
- The final complete suite passed all 189 tests in 508.802 seconds, with no skips.
  It includes original workbook reconstruction, all 419,905 original native
  calculator comparisons and 216 × 151 Quote comparisons, plus the new yield cases.

The main server was refreshed through Start-Estimator.ps1 and verified at
`http://127.0.0.1:8765/`, PID 11852. Served JS/CSS match the tested files. Its new
vermiculite state returns the reviewed profile and the original schedule gives
172.03 net bags / 173.00 pooled whole bags. A recovery backup preceded refresh;
the two saved quotes, zero pricing-setting rows and zero calculator-state rows
are identical afterward. Quote/settings content SHA-256 remains
`c541e453134d10e4a014ac26b330745fa0113988d140c3274c57d61102902ce4`.
The user's browser tab was preserved; refresh after retaining any unsaved draft.

All current scratch logs, source-download receipts, disposable Excel copies,
test databases, rendered PDFs and package checks are under ignored
`.runtime/yield-review`. `dist/` and caches are also ignored. New committed fixtures
are intentional native regression evidence; no source XLSX/XLSM or external PDF
is added to the runtime or repository.

Publication checkpoint: implementation `678ee3f295e8972f001e126fceaad59a6f8e8c0f`
(`Verify Australian spray yields and refine calculator reports`) was committed
and pushed to `origin/feat/workbook-calculators`; divergence was verified as 0/0.
[PR #6](https://github.com/Slayde91/estimator/pull/6) is updated, open and unmerged,
with no reviews. Its implementation-head Checks runs 34843699621 and 34843694841
both failed before any job step (`steps: []`). Both annotations explicitly cite
failed account payments or the spending limit. This is a verified account blocker,
not passing CI or a demonstrated code-test failure. No merge was attempted past
the failed checks. Resolve billing, rerun current-head CI, inspect review state
and merge only when supported. This follow-up documentation checkpoint makes no
runtime change; its own head must also be checked after push.

Local change classification: all intended source, documentation and native-fixture
changes belong to this increment and its follow-up checkpoint. Runtime databases,
backups, logs, downloaded source PDFs, disposable workbooks, QA renders, extracted
packages, caches and the built distribution remain ignored local artifacts.

## Historical: calculator presentation and full schedule PDFs — 2026-09-14

Starting state: clean feat/workbook-calculators at 4f60526, matching its fetched
upstream. PR #6 remains the existing feature PR; no user work or branches were
discarded. This increment removes row pagination, improves all twelve page
layouts, and adds a full schedule PDF for each calculator.

The complete worksheet endpoint shares typed dropdown lists and source-derived
presentation metadata. The old bounded calculate endpoint remains compatible.
The report module uses the existing workbook evaluator, fonts/logo and PDF
library. Every populated item, including incomplete/zero-input rows, is retained.
Reports distinguish published/usable thickness, board stack/total thickness,
spray area, board reference area, actual material area and pooled order quantities.
Board extras and all editable settings are included; independent vermiculite
helpers remain separate. No source formulas/packages, pricing, schema or saved
state semantics change.

Current source mapping: docs/CALCULATOR_PRESENTATION_MAPPING.md. New independent
HTTP/report regressions are in tests/test_calculator_presentation_api.py and
tests/test_calculator_report.py. Runtime screenshots, rendered PDFs, native
projection checks and test logs are ignored under
.runtime/calculator-presentation-qa.

Validation: all 176 Python tests passed in 442.513 seconds, including original
source reconstruction, all 419,905 native calculator comparisons and the old
216 × 151 Quote comparisons. After the last report layout changes, all 21
report/HTTP checks passed again in 132.865 seconds. JavaScript syntax, 39
calculator UI checks and 17 existing UI checks passed. Independent review found
and verified the fix for blank-to-populated source notes being omitted during
refresh; a separate regression protects formula-backed editable Settings values.

Desktop browser review covered every page; all prepared input rows and advanced
board fields were counted. Phone review at 390 × 844 confirmed page containment
for all three calculators and stacked single-member/bag forms with one copy of
each control. A real browser download captured an unsaved last-row duct entry;
the UI confirmed download and retained Unsaved calculator changes. No browser
errors were recorded. The temporary viewport override was reset.

The 32-file distribution built (5,332,788 bytes), and an isolated extracted copy
served all twelve complete pages and all three PDF downloads with original
workbook filesystem reads explicitly blocked. Default reports had 7 duct,
10 vermiculite and 23 board pages. A full 1,000-valid-item spray PDF retained all
1,000 detailed items across 370 pages. All 523 pages across seven representative
PDFs were rendered and checked for text bounds, layout and the official logo.

The main app was refreshed using Start-Estimator.ps1 and is running on port
8765 as process 30120. Served calculator JS/CSS match the tested files. The live
whole-sheet endpoint and source section styling were checked. A new SQLite
recovery backup preceded refresh; both quotes, the empty pricing settings and
empty calculator states remained identical. Quote/settings content SHA-256 is
c541e453134d10e4a014ac26b330745fa0113988d140c3274c57d61102902ce4.
The user's existing browser page was preserved; refresh it to load the new UI.

All changed tracked/new source files belong to this increment. Synthetic
databases, rendered reports, captures, backups and logs remain ignored in
.runtime; the distribution stays ignored in dist. Original workbooks, pricing
baseline, formula packages and the official logo bytes are unchanged.

Implementation commit 946f2c11c9670e5e107306b6ffadec1b470646e5,
“Polish calculator pages and add complete schedule PDF reports”, is pushed to
origin/feat/workbook-calculators. PR #6 was updated to “Add workbook calculators
with full schedules and PDF reports” and remains open and unmerged, with no
reviews. Both new implementation-head Checks runs failed before any job steps:
push 34833934393 / job 103943339708 and PR 34833938884 / job 103943353325.
Both annotations explicitly report failed recent account payments or a spending
limit requiring an increase. This is an external GitHub account blocker, not
passing CI or a failed application test. Resolve Billing & plans, rerun Checks
on the current PR head, then merge only when CI/review state permits. This
publication record changes documentation only; runtime validation remains valid.

## Current work — 2026-09-14

Repository: C:\ESTIMATOR\app. Branch feat/workbook-calculators starts at 01e3494120c324ccb491d92debf85359b0d06c43. Fetched origin/main: 615997c0f5dba856244421178a902e39af27a089. Starting tree was clean; previous estimate-details, pricing-library and launcher work is preserved. PR #5 is the prior publication and its Actions were blocked by account billing before job steps. Check the new PR's exact head independently before merging.

User scope: three exact workbook calculators, all visible tabs, adjustable settings, schedule XLSX templates/import, complete technical databases and Australian links. User approved correcting accidentally incremented duct fixing text from the first row; quantity formulas remain unchanged.

## Implementation

Source packages data/calculators/*.json.gz retain every literal, formula, validation, table/name, style, hidden worksheet and hash. workbook_catalog.py supplies independent catalog copies and editable allowlists. excel_engine.py parses/evaluates only the source Excel subset; cached answers and uploaded expressions never execute. workbook_calculators.py validates overlays, dependent dropdowns, pages, private sessions and the approved text exception.

schedule_workbook.py exports exact input templates and imports complete replacement schedules as drafts, preserving settings/other inputs. Store adds version-2 calculator_states, independent by calculator, with source-hash guards. Existing quote/pricing rows are unchanged. Existing loopback HTTP checks and bounded upload validation protect new definition/calculate/template/import/state routes. Only Save persists.

static/calculators.js/.css provide all 12 pages, direct row navigation, advanced columns, separate race-safe drafts, save/reset/import/export and document links. Controls display two decimals at rest and reveal exact values on focus; edits keep full precision. Numeric choices distinguish 0.005 from 0.01 when selecting. Explicit display-only source-note replacements remove redundant addresses without changing formulas, identifiers or calculated text.

No original source workbook, old Quote engine, original pricing baseline or old native fixture changed. New originals remain in the supplied OneDrive directory; runtime never requires them. New calculator quantities remain separate from priced Quote/PDF calculations because the files do not define automatic integration.

## Evidence and repeatable checks

See docs/WORKBOOK_CALCULATORS.md for mapping and coverage. Six immutable native fixtures retain actual Microsoft Excel capture bytes: all 161,566 source formulas, 300 approved text outputs and 258,039 varied outputs in 21 scenarios/3,471 schedule cases. All 419,905 comparisons passed, with zero mismatches/exceptions. Coverage includes all 1,342 board steel IDs, all 553 active vermiculite sections, 84 series and every editable setting. Strings/errors/bools compare exactly; numeric tolerance is relative 1e-12/absolute 1e-10.

Native checks resolved Excel blank-reference semantics, structured table references and nonformula OOXML whitespace. Normalized literals retain original text in source_value and honor inherited xml:space. Shared/inline/formula text is unchanged. The approved duct exception has separate original/corrected native evidence; docs/CALCULATOR_EXCEPTIONS.md records authorization and the supporting Australian M6 manual reference.

Run:

    python -m pip install -r requirements-dev.txt
    python -m unittest discover -s tests -v
    node --check static/app.js
    node --check static/calculators.js
    node tests/test_ui.cjs
    node tests/test_calculators_ui.cjs
    python scripts/build.py

Set ESTIMATOR_WORKBOOK_DIR=C:\ESTIMATOR for the old original-source checks. New source checks use ESTIMATOR_CALCULATOR_SOURCE_DIR, defaulting to the supplied OneDrive folder. Optional source reconstruction skips when originals are absent; native fixtures always run. Regeneration requires Microsoft Excel, PowerShell 7 and disposable copies. Never regenerate expected values with the application engine.

## Final verification and publication record

All 155 Python tests passed in 329.737 seconds, with original-source reconstruction enabled and all 419,905 new native Excel comparisons. The original 216 × 151 Quote comparisons also pass. JavaScript syntax checks, 17 existing UI checks, 29 calculator UI checks and diff whitespace checks pass. Review found and fixed a wildcard lookup performance defect: hostile input previously exceeded eight seconds; the bounded matcher returned the same result in 0.032 seconds. Focused engine and real HTTP regressions protect it.

The 31-file distribution built successfully and passed an isolated extracted-package smoke test with source-workbook filesystem access denied. All 12 page definitions/calculations, native default samples, three template/import/save/reopen paths and exact raw decimal preservation passed. Original quote/PDF/pricing checks passed, including a six-page branded material/labour report and exact-cell pricing roundtrip. No source workbook access occurred. Current/extracted engine and calculator UI hashes match.

Desktop browser checks confirmed numeric replacement, exact focus values, save/reload, small decimal dropdown choices and proportional worksheet widths. The 390 × 844 Chrome browser check passed all three sections without page overflow or JavaScript errors. It downloaded a template, uploaded a schedule, verified draft-only import, saved it and verified the exact imported decimal. Template input columns and Instructions were independently rendered and visually checked for all three formats.

The main app was refreshed through the Windows PowerShell launcher and is running on port 8765 (verified process 31908). A recovery backup was created before the additive version-2 migration. Both saved quote rows and the empty pricing settings table stayed identical; their before/after content SHA-256 is c541e453134d10e4a014ac26b330745fa0113988d140c3274c57d61102902ce4. New calculator_states is empty in the main database; synthetic test saves were confined to isolated databases.

Implementation commit 1bd8f9019ae2821111222b4b76bd173d812c16bb (Add native-validated ductwork and structural steel calculators) was committed and pushed to origin/feat/workbook-calculators. PR #6 targets main: https://github.com/Slayde91/estimator/pull/6. It includes the prior unmerged work from #3, #4 and #5. Those branches/PRs were preserved.

Both implementation-head Checks runs failed before executing any job step: push run 34762251562 and pull-request run 34762265325. GitHub's annotation says recent account payments failed or the spending limit needs to be increased. This is an external CI account blocker, not a failed application test, and is not CI success. PR #6 is open with no reviews and has not merged. Resolve GitHub Billing & plans, rerun Checks on the current PR head, then merge only after successful checks. The documentation-only publication record does not change the validated runtime files.

## Operation and local classification

Double-click Start-Estimator.cmd or run python -m estimator. The normal server uses port 8765 and .runtime/estimator.sqlite3. Stop it before file backups. No Windows login task or public deployment is installed. Existing quote PDFs retain the unchanged official logo and saved results.

All current implementation/documentation changes belong to this feature. Synthetic databases, native capture copies/results, template renders, logs, process snapshots and caches remain ignored under .runtime; distribution ZIPs remain ignored under dist. Original workbooks and external logo remain outside the repository. Do not stage runtime data, delete branches or discard unknown changes appearing after this baseline.
