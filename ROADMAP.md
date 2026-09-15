# Roadmap

Current increment: add explicit m²/m³ to the vermiculite summary captions,
give running material totals full-width sections, omit the decorative BAGS
manual-form column, expand all Settings tables with the page, emphasize source
reference labels and center the confirmed published-period table. Prepared
schedules, source values, formulas, saved state and PDF projections retain their
existing scope.
Validation and publication for this increment belong in SESSION_HANDOFF.md.

Previous published checkpoint `678ee3f` on `feat/workbook-calculators` / PR #6
recorded 189 Python tests and 65 UI checks passing locally. Its CI was blocked
before job steps by GitHub account payment/spending limits. That evidence does
not verify this subsequent presentation increment or its publication status.

## Implemented

- Original Quote Calculator inputs, formulas, editable pricing and saved snapshots.
- Official Ceasefire logo, complete material/labour PDFs, Project No./Client/Site Address, automatic names and work summaries.
- Estimator NOTES label on the existing measurement field; saved/default workflow behavior retained internally without a Workflow dropdown.
- Whole-library Excel export/import with additions/removals, review and Save pricing.
- Two-decimal presentation while retaining raw calculation precision.
- Three workbook Calculators, every visible tab, board SETTINGS/EXTRA BOARDS and adjustable settings.
- Permanent technical databases, original formulas and dependent dropdowns.
- Schedule templates/import, separate drafts/saved states and source-version guards.
- Continuous full-row calculator pages with separate source-backed sections, uniform red-and-white headings, black data grids, linked contents and labelled totals; first columns scroll horizontally with their tables.
- Six-column board purchasing table with retained summary cards; hidden extra-board evidence fields and no browser advanced-column checkbox. Saved hidden inputs and the advanced worksheet API remain supported.
- Independent presentation tables with full content height, explicit note/heading/blank-row display overrides, and browser-only omission of Duct USE NOTES. Prepared schedules retain their vertical scrollers.
- Explicit area/volume summary units, independent full-width running material totals, all Settings tables without vertical caps, and bounded reference-label/period-table formatting. Decorative BAGS G is omitted only from its manual form; pooled Whole bags remains visible below.
- Vermiculite product bag totals from pooled BAGS formulas, an independently sized period matrix, and compact BAGS presentation.
- Read-only material-basis display; requested Settings metadata, review action/panel, schedule commentary columns/top labels and single-member notes section omitted from the worksheet view.
- One populated-output highlight and one blank-output highlight; zero remains populated. Vermiculite Settings retains section navigation under SETTINGS & RULES.
- Reviewed five-product commercial defaults, isolated from source graphs and existing saved inputs; reset remains a draft until Save calculator. Numeric material settings stay adjustable.
- Schedule PDF downloads with thicknesses, areas, applicable quantities, additional boards, product/ancillary tables and closing totals. Duplicate detail, standalone helper and settings appendices are removed.
- Original exclusions/withheld quantities and the approved duct text correction.
- Australian manuals, PDS/SDS and clearly labelled report/request links.
- Independent native Microsoft Excel fixtures, HTTP/persistence and UI regressions.
- Standalone source distribution and Windows launcher without Excel at runtime.

## Verification and publication

Current final validation and Git results for the units and table-label cleanup belong
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

Finish and record the current regression, runtime, saved-input preservation,
PDF and distribution checks, then commit and publish the verified change.
Verify the current PR's exact-head CI/review state before merging and confirm
the resulting merge commit. Earlier CI or billing results do not establish the
current outcome. Never bypass or relabel a failed check.

Future calculator-to-priced-quote transfer needs an explicit material, purchasing, product and labour mapping. The workbooks do not define it, so tools remain separate. Source revisions require fresh import, native comparison and intentional saved-state migration; hashes prevent silent changes today.

An installer, authenticated shared hosting, concurrent multi-user editing and managed backups require an operating-environment decision. No public deployment has occurred.

The historical 946f2c1 checkpoint recorded 176 Python tests, 56 UI checks and
subsequent report/HTTP/distribution checks, with CI blocked before job steps.
Those counts and renders predate both the PDF reductions/reviewed-default
profile and the latest presentation cleanup; current results belong in SESSION_HANDOFF.md.
