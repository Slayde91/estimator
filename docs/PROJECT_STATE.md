# Project state

Date: 2026-09-14. Executable code and checked results take precedence over this document.

ESTIMATOR is a local Python/browser application in C:\ESTIMATOR\app with SQLite storage and permanently imported workbook data. The original Quote estimator contains 64 inputs, 151 formulas, 417 inventory records and 166 choices across 14 rate groups. It retains project/client/site details, automatic quote names and work summaries, pricing import/export, the official logo and complete material/labour PDF reports. Saved quotes freeze their inputs, catalog, prices, yields and results. Pricing replacements remain drafts until Save pricing.

## Workbook calculators

Calculators adds Structural Steel (vermiculite), Structural Steel (board) and Ductwork. Every visible source tab has a page with its original name; board SETTINGS and EXTRA BOARDS are additionally exposed. Original formulas, hidden databases, names, table references, validation choices, styles and source hashes are permanently packaged. Excel and OneDrive are unnecessary at runtime. These new workbooks supply geometry, thickness and quantity rules absent from the original Quote workbook.

Settings remain adjustable, including source formula-backed yields. Reference databases and calculated fields are read-only. Each calculator has separate draft and saved inputs. Export template and Import schedule use exact values-only XLSX fields. Import replaces the schedule, clearing remaining previous rows while preserving other inputs/settings; only Save calculator persists. Capacities match Excel: 1,000 vermiculite, 200 board and 300 duct rows. Import rejects formulas, macros, external links and malformed data.

Values display two decimals at rest; focused controls reveal exact values. New calculator edits retain full precision, including small yields and tolerances. Numeric choices reveal exact values when choosing between options that round to the same display. This intentionally differs from the older Quote UI's two-decimal edit policy. Raw calculated values stay unrounded in both paths; product, fastener and report identifiers remain literal.

The only approved source exception fixes duct copied instruction text using the first row's fixed technical references, including M6 and AS4254. Original formulas remain packaged and quantity formulas are unchanged. See [exception record](CALCULATOR_EXCEPTIONS.md).

Australian document links identify manuals, PDS, SDS and report availability. An unavailable exact report is labelled as a manufacturer request. Links never silently replace workbook calibration. Source exclusions, review flags, errors and withheld quantities remain part of the output.

## Architecture and verification

The extension reuses the HTTP server, SQLite database, browser UI and openpyxl dependency. An allowlisted formula interpreter evaluates immutable source graphs without eval/exec or cached answers. SQLite version 2 adds calculator_states; quote/settings rows are not rewritten. Saved source hashes prevent silent reinterpretation after a source revision. This remains a loopback-only application, with no shared hosting or public deployment.

Calculator quantities remain separate from priced quotes: the files do not specify an automatic mapping into pricing. Existing PDFs still report the original Quote estimate and complete breakdown.

All 419,905 new native Excel comparisons passed: 161,566 original formula outputs, 300 approved text outputs, and 258,039 varied outputs over 3,471 schedule cases. Expected values came from Microsoft Excel 16.0 build 20326 recalculating disposable copies of the original XLSX workbooks. Coverage includes every steel selection and editable setting. Text, booleans and errors compare exactly; numeric tolerance is relative 1e-12 and absolute 1e-10. See [mapping and evidence limits](WORKBOOK_CALCULATORS.md).

The original Quote fixture remains 216 scenarios × 151 outputs, captured with verbatim Calculator formulas and saved lookups in a macro-free harness. That earlier evidence does not prove live XLSM external-link refresh.

Current branch: feat/workbook-calculators, based on 01e3494 and preserving prior PR #5 work. Main was fetched at 615997c; no user changes were discarded. Complete-suite/build/runtime/publication outcomes are recorded in SESSION_HANDOFF.md. Prior PR #5 CI was blocked by GitHub billing before job steps; current PR CI must be checked independently.

Implementation commit 1bd8f90 is pushed to origin/feat/workbook-calculators. [PR #6](https://github.com/Slayde91/estimator/pull/6) is open and unmerged, with no reviews. Both fresh implementation-head Checks runs failed before job steps because GitHub reported account payment/spending-limit problems. All 155 Python tests and 46 UI checks passed locally; the distribution and refreshed local app were verified. Resolve the account blocker and require successful current-head CI before merging.
