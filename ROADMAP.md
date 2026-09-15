# Roadmap

Current increment: separate vermiculite START, SETTINGS and FACTOR CALCS browser
views while retaining the four source worksheets and complete calculation state.
Operating rules display directly; seven setting choices and three factor-helper
choices replace the combined eleven-choice view. Refine headings, native Section
ID selection, BAGS placement and targeted cell emphasis. New Estimator Notes start
blank; its generated-summary panel is removed while saved/PDF summaries remain.

This extends existing presentation metadata and initialization only. No dependency,
calculation rule, source-package, export or storage migration is introduced.
Local checks pass: 111 UI checks (89 calculator, 22 Estimator), 29 API/cleanup
and 13 section/tab tests, 42 focused Estimator backend/PDF tests, syntax/diff
checks and the 35-file build. Native review, exact draft retention and
before/after source/export comparisons pass. The refreshed main app preserves
saved data, and final independent review found no remaining issues.
Commit/publication remain pending in SESSION_HANDOFF.md.

The preceding section-navigation increment merged in PR #18 as `de808e1` from
`d8d59c1`. Both exact-head CI runs passed 227 Python tests (223 passed, four
skipped) and 104 UI checks. Its verified local worksheet/export, browser and
saved-state comparisons are retained under `.runtime/section-navigation-qa`.
Those results do not validate this subsequent increment.

Previous published checkpoint `678ee3f` on `feat/workbook-calculators` / PR #6
recorded 189 Python tests and 65 UI checks passing locally. Its CI was blocked
before job steps by GitHub account payment/spending limits. That evidence does
not verify this subsequent presentation increment or its publication status.

## Implemented

- Original Quote Calculator inputs, formulas, editable pricing and saved snapshots.
- Official Ceasefire logo, complete material/labour PDFs, Project No./Client/Site Address, automatic names and saved/PDF work summaries.
- Estimator NOTES label on the existing measurement field, blank B12 notes for new estimates, and no generated-summary panel. Saved notes, summary data and internal workflow behavior remain intact.
- Whole-library Excel export/import with additions/removals, review and Save pricing.
- Two-decimal presentation while retaining raw calculation precision.
- Three workbook Calculators, source-backed browser tabs, board SETTINGS/EXTRA BOARDS and adjustable settings.
- Source-backed vermiculite START/SETTINGS/FACTOR CALCS views: operating rules shown directly, seven settings choices and three helper choices. Duct and board retain five/three settings choices; all preserve complete calculation/save/report scope. Scoped navigation, order-first BAGS, MEMBER SCHEDULE, published-value units/highlight and expanded board START.
- Permanent technical databases, original formulas and dependent dropdowns.
- Schedule templates/import, separate drafts/saved states and source-version guards.
- Continuous full-row calculator pages with separate source-backed sections, uniform red-and-white headings, black data grids, linked contents and labelled totals; first columns scroll horizontally with their tables.
- Six-column board purchasing table with retained summary cards; hidden extra-board evidence fields and no browser advanced-column checkbox. Saved hidden inputs and the advanced worksheet API remain supported.
- Independent presentation tables with full content height, explicit note/heading/blank-row display overrides, and browser-only omission of Duct USE NOTES. Prepared schedules retain their vertical scrollers.
- Explicit area/volume summary units, independent full-width running material totals, all Settings tables without vertical caps, and bounded reference-label/period-table formatting. Decorative BAGS G is omitted only from its manual form; pooled Whole bags remains visible below.
- Bounded detail-row layouts and helper spacer merges; pink technical headings, bold exposure/product labels and normal reference/support prose. Full-width board overviews retain summary cards; display titles use BOARD SUMMARY, EXTRA BOARDS, SUMMARY and PRODUCT SUMMARY without renaming worksheets.
- Vermiculite product bag totals from pooled BAGS formulas, an independently sized period matrix, and compact BAGS presentation.
- Read-only material-basis display; requested Settings metadata, review action/panel, schedule commentary columns/top labels and single-member notes section omitted from the worksheet view.
- Populated/blank output highlights, plus a scoped published-thickness highlight; zero remains populated. Vermiculite Section ID uses the source-backed native list without duplicating every option across the initial 1,000-row DOM.
- Reviewed five-product commercial defaults, isolated from source graphs and existing saved inputs; reset remains a draft until Save calculator. Numeric material settings stay adjustable.
- Schedule PDF downloads with thicknesses, areas, applicable quantities, additional boards, product/ancillary tables and closing totals. Duplicate detail, standalone helper and settings appendices are removed.
- Excel register downloads from the same draft/report projection, with typed exact values, Summary/Schedule and board Extra boards sheets, filters and retained statuses/qualifications. No state save or live Excel calculation is implied.
- Original exclusions/withheld quantities and the approved duct text correction.
- Australian manuals, PDS/SDS and clearly labelled report/request links.
- Independent native Microsoft Excel fixtures, HTTP/persistence and UI regressions.
- Standalone source distribution and Windows launcher without Excel at runtime.

## Verification and publication

Current final validation and Git results for the START/FACTOR CALCS increment belong
in SESSION_HANDOFF.md. Do not infer CI success from local checks
or treat a previous implementation checkpoint as verification of this change.

The previous source-parity checkpoint passed 419,905 native Excel comparisons,
covering 161,566 source formulas, 300 approved text outputs and 258,039 varied
outputs across 3,471 schedule cases. The original Quote fixture remains
216 × 151. Complete reconstruction tests protect database extraction. Reviewed
commercial defaults require additional input-profile, precedence, save-isolation
and display checks; source expectations stay unchanged. See
[yield evidence and qualifications](docs/VERMICULITE_YIELD_REVIEW.md).

## Meaningful remaining work

Commit and publish the locally verified change. Local regression, runtime,
saved-state, export and distribution checks and final independent review have
passed.
Verify the current PR's exact-head CI/review state before merging and confirm
the resulting merge commit. Earlier CI or billing results do not establish the
current outcome. Never bypass or relabel a failed check.

Future calculator-to-priced-quote transfer needs an explicit material, purchasing, product and labour mapping. The workbooks do not define it, so tools remain separate. Source revisions require fresh import, native comparison and intentional saved-state migration; hashes prevent silent changes today.

An installer, authenticated shared hosting, concurrent multi-user editing and managed backups require an operating-environment decision. No public deployment has occurred.

The historical 946f2c1 checkpoint recorded 176 Python tests, 56 UI checks and
subsequent report/HTTP/distribution checks, with CI blocked before job steps.
Those counts and renders predate both the PDF reductions/reviewed-default
profile and the latest presentation cleanup; current results belong in SESSION_HANDOFF.md.
