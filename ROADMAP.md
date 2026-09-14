# Roadmap

## Implemented

- Original Quote Calculator inputs, formulas, editable pricing and saved snapshots.
- Official Ceasefire logo, complete material/labour PDFs, Project No./Client/Site Address, automatic names and work summaries.
- Whole-library Excel export/import with additions/removals, review and Save pricing.
- Two-decimal presentation while retaining raw calculation precision.
- Three workbook Calculators, every visible tab, board SETTINGS/EXTRA BOARDS and adjustable settings.
- Permanent technical databases, original formulas and dependent dropdowns.
- Schedule templates/import, separate drafts/saved states and source-version guards.
- Continuous full-row calculator pages with branded forms, headings and labelled totals.
- Full schedule PDF downloads with thicknesses, areas, applicable material quantities, settings and pooled product summaries.
- Original exclusions/withheld quantities and the approved duct text correction.
- Australian manuals, PDS/SDS and clearly labelled report/request links.
- Independent native Microsoft Excel fixtures, HTTP/persistence and UI regressions.
- Standalone source distribution and Windows launcher without Excel at runtime.

## Verification and publication

feat/workbook-calculators extends 01e3494; fetched main is 615997c. Current final validation and Git results belong in SESSION_HANDOFF.md. Do not infer CI success from local checks. Prior PR #5 CI was blocked by account billing before any job step.

All 419,905 new native Excel comparisons pass, covering all 161,566 source formulas, 300 approved text outputs and 258,039 varied outputs across 3,471 schedule cases. The original Quote fixture remains 216 × 151. Complete reconstruction tests protect database extraction, not just representative records.

## Meaningful remaining work

Publish the current feature PR and merge only when current CI/review state supports it. Resolve any recurring external CI account problem; never bypass or relabel a failed check.

Future calculator-to-priced-quote transfer needs an explicit material, purchasing, product and labour mapping. The workbooks do not define it, so tools remain separate. Source revisions require fresh import, native comparison and intentional saved-state migration; hashes prevent silent changes today.

An installer, authenticated shared hosting, concurrent multi-user editing and managed backups require an operating-environment decision. No public deployment has occurred.

Implementation commit 1bd8f90 is pushed to origin/feat/workbook-calculators. [PR #6](https://github.com/Slayde91/estimator/pull/6) is open and unmerged, with no reviews. Both fresh implementation-head Checks runs failed before job steps because GitHub reported account payment/spending-limit problems. All 155 Python tests and 46 UI checks passed locally; the distribution and refreshed local app were verified. Resolve the account blocker and require successful current-head CI before merging.
