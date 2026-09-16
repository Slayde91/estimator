# Roadmap

Current increment: Estimator PDF cleanup on `feat/estimator-pdf-cleanup`, based
on PR #26 merge `3d3e1ed`. Remove the requested Work summary, material-pricing
explanation, masking explanation and duplicate Estimator notes subsection;
retain every financial table and generated material note. Main NOTES remains,
while the Job and access B12 editor is hidden without deleting its values.
Draft and saved PDFs download as `CEASEFIRE-Estimate.pdf`.

All 25 focused report/server tests pass (30.421 seconds), together with 36
Estimator UI checks and JavaScript syntax checks. Content and visual review
passed all 12 PDF pages (five complete-estimate and seven incomplete/long-note
pages). The 35-file package and 13 HTTP checks pass. The isolated browser journey
passed after a transient review-capacity interruption: a legacy quote's main
NOTES was edited, saved and reopened; no B12 editor appeared, and generated
notes retained the historical Job and access text. API checks confirmed the
original B12 value, pricing snapshot and calculated cells are unchanged.
Independent diff review found no issues.

Code is committed as `567f200` (Trim Estimator PDF sections and simplify notes
entry). After two transient automatic-review capacity rejections, the third
authorized push succeeded; the branch now tracks `origin/feat/estimator-pdf-cleanup`
at `567f200`. PR, CI and merge remain pending. The main app
remains at PR #26 merge `3d3e1ed`. A broader local packaged regression is running,
explicitly excluding two external `WorkbookSourceRegressionTests` because the
native board original differs from the package; no pass is claimed yet. The
earlier aborted comparison belonged to PR #26. Current Git evidence and
`.runtime/estimator-pdf-cleanup-qa/publication.json` govern the final outcome.

Historical PR #26 merged at `3d3e1ed`; both CI runs passed with 283 tests
(four optional source skips), 128 UI checks and build. Its checkpoint below is
historical and does not validate this Estimator-only change.

Previous increment: separate calculator schedule and materials/summary PDFs on
`feat/separate-calculator-pdfs`, based on PR #25 merge `c4e1a79`.
The existing report endpoint now contains Full schedule only; the new summary
endpoint contains Material quantities and summary, including final material
orders, ancillary tables and board EXTRA BOARDS. Excel retains the complete
Summary/Schedule/Extra boards projection. Exposure inputs use normal weight
only in the three source-backed schedule columns; headings and reference
labels remain emphasized. The toolbar orders schedule PDF before Excel register
and the new materials & summary PDF.

Verified before publication: 30 API/cleanup tests, all 11 PDF/projection tests
(including the corrected summary-only quantity assertion), nine display-metadata
tests, 128 UI checks (33 Estimator and 95 Calculator), JavaScript syntax and
scoped diff checks. Six HTTP-generated PDF scopes pass; the 1,000-item spray
schedule retains every unique mark across 67 pages, including the final item.
Rendered pages from every report type were reviewed, including repeating headers
and page breaks. Distribution build and isolated package wiring checks pass.
The full Python regression run is in progress. Exact-head CI/review, runtime
refresh and merge remain pending; later results belong in the local receipt.
Evidence: `.runtime/calculator-pdf-split-qa`.

Historical PR #25 merged at `c4e1a79` with verified successful post-merge CI.
It restored expandable pricing uses and introduced compact one-row product
exports with eight aligned use lists, both older import formats and native
Excel text preservation. Its final receipt is
`.runtime/compact-pricing-qa/publication.json`; those checks do not validate
the current PDF split.

Historical PR #24 merged at `7408276` with successful post-merge CI. It repaired
freeze-pane metadata and temporarily used an inline browser table with separate
visible Excel Use rows. Its native Excel open, parity and browser results are
retained in `.runtime/pricing-visible-yields-qa/publication.json`.

Calculator dropdown/display polish merged in PR #23 at `53c875d`. Its scoped
omissions, native quick dropdown and styles remain implemented. Release evidence
is retained in `.runtime/calculator-polish-qa`.

The unified Inventory & Rates release merged in PR #22 at `a4c8ffc` with
257 Python passes, four optional source-workbook skips and 122 UI checks on
both pre-merge CI runs. Explicit IDs and use order preserve mapping; old pricing
templates remain accepted. Its runtime and data-preservation receipt is in
`.runtime/unified-pricing-qa/publication.json`.

The preceding shared footer merged in PR #21 at `ab48baf`, following the labour
breakdown/calculator control work in PR #20 at `e843cf7`. Both releases have
successful exact-head CI receipts in their corresponding `.runtime` QA folders.

The preceding START/factor increment merged in PR #19 as `335f4b6` from
`cc1ccf9`. Both exact-head CI runs passed 235 Python tests (231 passed, four
skipped) and 111 UI checks. Its evidence is retained under `.runtime/tabs-notes-qa`;
those results do not validate this subsequent increment.

Previous published checkpoint `678ee3f` on `feat/workbook-calculators` / PR #6
recorded 189 Python tests and 65 UI checks passing locally. Its CI was blocked
before job steps by GitHub account payment/spending limits. That evidence does
not verify this subsequent presentation increment or its publication status.

## Implemented

- Original Quote Calculator inputs, formulas, editable pricing and saved snapshots.
- Labour-days breakdown from stored result cells, with correct pinning exclusion, source F10 total, explicit error/missing states and read-only enrichment for older saved-quote responses.
- Official Ceasefire logo, complete material/labour tables in PDFs, Project No./Client/Site Address, automatic names and saved work-summary data. The PDF omits the requested explanatory blocks and Work summary section.
- Estimator NOTES label on the existing measurement field; Job and access B12 editor and duplicate PDF subsection hidden. Saved notes, generated material notes, summary data and internal workflow behavior remain intact.
- Whole-library Excel export/import with additions/removals, review and Save pricing.
- Unified Inventory & Rates with a use filter, expandable category/rate/yield details, one shared product-price editor and separate resets. Compact one-row product exports retain independent uses through aligned lists, valid freeze panes and both previous template formats on import.
- Two-decimal presentation while retaining raw calculation precision.
- Three workbook Calculators, source-backed browser tabs, board SETTINGS/EXTRA BOARDS and adjustable settings.
- Source-backed vermiculite START/SETTINGS/FACTOR CALCS views: operating rules shown directly, seven settings choices and three helper choices. Duct and board retain five/three settings choices; all preserve complete calculation/save/report scope. Scoped navigation, order-first BAGS, MEMBER SCHEDULE, published-value units/highlight and expanded board START.
- Permanent technical databases, original formulas and dependent dropdowns. Requested board/duct controls use native selects with source-permitted custom values retained; large steel lists populate when opened.
- Schedule templates/import, separate drafts/saved states and source-version guards.
- Continuous full-row calculator pages with separate source-backed sections, uniform red-and-white headings, black data grids, linked contents and labelled totals; first columns scroll horizontally with their tables.
- Six-column board purchasing table with retained summary cards; hidden extra-board evidence fields and no browser advanced-column checkbox. Saved hidden inputs and the advanced worksheet API remain supported.
- Independent presentation tables with full content height, explicit note/heading/blank-row display overrides, and browser-only omission of Duct USE NOTES. Prepared schedules retain their vertical scrollers.
- Explicit area/volume summary units, independent full-width running material totals, all Settings tables without vertical caps, and bounded reference-label/period-table formatting. Decorative BAGS G is omitted only from its manual form; pooled Whole bags remains visible below.
- Bounded detail-row layouts and helper spacer merges; pink technical headings, bold exposure/product labels and normal reference/support prose. Full-width board overviews retain summary cards; display titles use BOARD SUMMARY, EXTRA BOARDS, CALCULATED SUMMARY and PRODUCT SUMMARY without renaming worksheets.
- Vermiculite product bag totals from pooled BAGS formulas, an independently sized period matrix, and compact BAGS presentation.
- Read-only material-basis display; requested Settings metadata, review action/panel, schedule commentary columns/top labels and single-member notes section omitted from the worksheet view.
- Populated/blank output highlights, plus a scoped published-thickness highlight; zero remains populated. Vermiculite Section ID uses the source-backed native list without duplicating every option across the initial 1,000-row DOM.
- Reviewed five-product commercial defaults, isolated from source graphs and existing saved inputs; reset remains a draft until Save calculator. Numeric material settings stay adjustable.
- Schedule-only PDF downloads retain used items, thicknesses, areas, applicable quantities and statuses. A separate materials & summary PDF retains product/ancillary tables, closing totals and board extras; both use the same complete calculation. Duplicate detail, standalone helper and settings appendices remain excluded.
- Excel register downloads from the same draft/report projection, with typed exact values, Summary/Schedule and board Extra boards sheets, filters and retained statuses/qualifications. No state save or live Excel calculation is implied.
- Original exclusions/withheld quantities and the approved duct text correction.
- Australian manuals, PDS/SDS and clearly labelled report/request links.
- Independent native Microsoft Excel fixtures, HTTP/persistence and UI regressions.
- Standalone source distribution and Windows launcher without Excel at runtime.

## Verification and publication

SESSION_HANDOFF.md records the current Estimator PDF-cleanup checkpoint.
Use current Git/checks and `.runtime/estimator-pdf-cleanup-qa/publication.json` for later
validation and publication outcomes. Do not infer CI success from local checks
or treat a previous implementation checkpoint as verification of this change.

The previous source-parity checkpoint passed 419,905 native Excel comparisons,
covering 161,566 source formulas, 300 approved text outputs and 258,039 varied
outputs across 3,471 schedule cases. The original Quote fixture remains
216 × 151. Complete reconstruction tests protect database extraction. Reviewed
commercial defaults require additional input-profile, precedence, save-isolation
and display checks; source expectations stay unchanged. See
[yield evidence and qualifications](docs/VERMICULITE_YIELD_REVIEW.md).

## Meaningful remaining work

Validate the cleaned Estimator PDF and hidden B12 field, verify the refreshed
runtime and saved state, then publish the increment.
Verify the current PR's exact-head CI/review state before merging and confirm
the resulting merge commit. Earlier CI or billing results do not establish the
current outcome. Never bypass or relabel a failed check.

Future calculator-to-priced-quote transfer needs an explicit material, purchasing, product and labour mapping. The workbooks do not define it, so tools remain separate. Source revisions require fresh import, native comparison and intentional saved-state migration; hashes prevent silent changes today.

An installer, authenticated shared hosting, concurrent multi-user editing and managed backups require an operating-environment decision. No public deployment has occurred.

The historical 946f2c1 checkpoint recorded 176 Python tests, 56 UI checks and
subsequent report/HTTP/distribution checks, with CI blocked before job steps.
Those counts and renders predate both the PDF reductions/reviewed-default
profile and the latest presentation cleanup; current results belong in SESSION_HANDOFF.md.
