# Project state

Date: 2026-09-12. Code and checked results take precedence over this document.

The initial repository was README-only at `18d5058`. The application now implements the supplied Calculator in a local browser interface, backed by explicit Python calculations and SQLite. It uses permanently imported JSON inventory and has no workbook/Excel runtime dependency.

Implemented scope: 64 editable Calculator fields, 14 dropdown groups containing 166 options, 417 inventory records, 151 translated formulas, editable supplier/markup/manual rates and yields, full calculation breakdown, quote notes, saved pricing snapshots and printing.

The reporting extension adds the supplied Ceasefire logo and a direct PDF download with all 29 non-overlapping cost components. Unchanged saved quotes render their original stored results and source lineage; new or edited estimates render captured inputs/pricing without saving. ReportLab 4.4.9 is now a declared runtime dependency for PDF generation, and pypdf is a development dependency for report checks. All 47 tests passed with original workbook checks included, and 30 PDF pages across five representative documents were visually checked. See `SESSION_HANDOFF.md` for validation details; GitHub records publication status.

Validation evidence: source cached outputs and 216 independent Microsoft Excel scenarios, with 151 formula outputs per scenario. The original XLSM could not be opened by Excel automation; exact formulas were recalculated in an isolated macro-free harness using frozen source lookups. See `CALCULATOR_SPEC.md` for the evidence boundary. Original XLSM files were not modified.

Workflows use the same user-entered product quantities and coverage as Excel. They do not derive quantities from dimensions/FRL. No automatic geometry/technical-rule implementation is claimed because the source templates contain no such calculations.

Publication and final check results are recorded in `SESSION_HANDOFF.md` and GitHub Checks. The local application is not a production-hosted or multi-user deployment.

Windows startup now includes a double-click launcher in the checkout and distribution. It runs the app independently of the launching terminal, reuses an existing healthy server, checks the pinned PDF dependency, and reports occupied ports or missing dependencies. This addresses the local link becoming unavailable when the previous server process stops; it does not make localhost a permanently hosted URL.
