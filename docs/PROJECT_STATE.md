# Project state

Date: 2026-09-06. Code and checked results take precedence over this document.

The initial repository was README-only at `18d5058`. The application now implements the supplied Calculator in a local browser interface, backed by explicit Python calculations and SQLite. It uses permanently imported JSON inventory and has no workbook/Excel runtime dependency.

Implemented scope: 64 editable Calculator fields, 14 dropdown groups containing 166 options, 417 inventory records, 151 translated formulas, editable supplier/markup/manual rates and yields, full calculation breakdown, quote notes, saved pricing snapshots and printing.

Validation evidence: source cached outputs and 216 independent Microsoft Excel scenarios, with 151 formula outputs per scenario. The original XLSM could not be opened by Excel automation; exact formulas were recalculated in an isolated macro-free harness using frozen source lookups. See `CALCULATOR_SPEC.md` for the evidence boundary. Original XLSM files were not modified.

Workflows use the same user-entered product quantities and coverage as Excel. They do not derive quantities from dimensions/FRL. No automatic geometry/technical-rule implementation is claimed because the source templates contain no such calculations.

Publication and final check results are recorded in `SESSION_HANDOFF.md` and GitHub Checks. The local application is not a production-hosted or multi-user deployment.
