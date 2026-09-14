# Project state

Date: 2026-09-14. Executable code and checked results take precedence over this document.

The current increment simplifies the calculator display and makes material-basis
text read-only. Source graphs, calculated results, saved states and schedule PDF
contents are unchanged by this presentation request. Its current checks and Git
outcome belong in SESSION_HANDOFF.md; no new pass or publication claim is made here.

The earlier `678ee3f` checkpoint on `feat/workbook-calculators` recorded 189 Python
tests, 65 UI checks, build, PDF and extracted-runtime checks passing locally.
PR #6 was unmerged and CI blocked before steps by account payment/spending limits
at that checkpoint. These are historical results, not verification of this increment.

## Current calculator presentation and schedule reports

The calculator pages now expose every prepared row on one continuous page:
1,000 vermiculite items, 300 duct items, 200 board items and 40 extra-board items.
Forms and tables use the official colours, clearer source headings, labelled
summary values and shared section dropdowns. Main sections have distinct colour
themes and linked contents. Vermiculite SETTINGS uses the Product Settings and
Rules banner with its section links; material-basis text is read-only. Outputs
use two highlight states: populated and blank, with numeric zero populated.
The single-member period matrix has independent column widths, including the
120-minute column. Forms fit a phone while comparison tables scroll separately.

Vermiculite SCHEDULE retains running net/whole-bag totals for each product.
The requested top labels and columns V/W/X are hidden in the worksheet view;
their status/source values remain in the original result graph and PDF mapping.
Product totals come directly from BAGS, including pooled rounding and withheld
values; the browser does not sum rounded schedule rows. The single-member
CALCULATOR omits its third notes section, and BAGS uses compact column widths.

Every calculator has a draft PDF download containing the populated full
schedule, thicknesses, relevant surface/material areas, applicable bags/sheets/
wrap quantities, main row statuses, additional boards and final product/quantity
totals. The duplicate item-detail appendix, separate single-member/manual-bag
sections and settings appendix have been removed at the user's request.
Incomplete items remain visible in the main schedule. The manual helpers remain
available in the application and are not added to schedule totals. Downloading
uses a captured draft and does not save the calculator.
See [presentation and report mapping](CALCULATOR_PRESENTATION_MAPPING.md).

Current validation and publication outcomes belong at the top of
SESSION_HANDOFF.md. The older implementation evidence below is historical, not
proof of current tests, CI or publication success.

## Reviewed vermiculite estimating defaults

The five reviewed product profiles are explicit input overlays in
`data/vermiculite_yield_defaults.json`, separate from the immutable workbook
graph. Each profile supplies bag mass, direct yield, inferred dry-material
consumption and retained basis/reference: twenty SETTINGS values in total.
Numeric fields remain editable; basis text is read-only in the current product.
See [yield evidence and qualifications](VERMICULITE_YIELD_REVIEW.md) and the
[authorized exception](CALCULATOR_EXCEPTIONS.md).

When no saved calculator state exists, Store returns these starting inputs
without writing a database row. Existing saves, including an explicit empty
overlay, retain their exact stored inputs. Reset calculator defaults restores
the reviewed profile and source example rows in the draft, requiring Save
calculator to persist. The separate reviewed-default action and evidence panel
are removed from the UI. Settings hide review dates, source IDs and document
names; the evidence remains in retained source data and developer documentation.
No saved-input migration occurs.

Direct yield retains the workbook's existing precedence. Estimating density is
coverage-derived dry-material consumption, not installed coating density. Batch,
theoretical and uninjected yield assumptions remain adjustable and qualified.
No thickness, exposure, suitability, wastage or lookup rule is changed. Calling
the calculation engine with an explicit empty overlay still reproduces original
workbook defaults. Calculations, controls on focus, saved inputs and exports
retain full precision. Hidden presentation text is not deleted from stored evidence.

ESTIMATOR is a local Python/browser application in C:\ESTIMATOR\app with SQLite storage and permanently imported workbook data. The original Quote estimator contains 64 inputs, 151 formulas, 417 inventory records and 166 choices across 14 rate groups. It retains project/client/site details, automatic quote names and work summaries, pricing import/export, the official logo and complete material/labour PDF reports. Saved quotes freeze their inputs, catalog, prices, yields and results. Pricing replacements remain drafts until Save pricing.

## Workbook calculators

Calculators adds Structural Steel (vermiculite), Structural Steel (board) and Ductwork. Every visible source tab has a page with its original name; board SETTINGS and EXTRA BOARDS are additionally exposed. Original formulas, hidden databases, names, table references, validation choices, styles and source hashes are permanently packaged. Excel and OneDrive are unnecessary at runtime. These new workbooks supply geometry, thickness and quantity rules absent from the original Quote workbook.

Numeric settings remain adjustable, including source formula-backed yields. Reference databases, material-basis text and calculated fields outside the declared editable settings are read-only. Each calculator has separate draft and saved inputs. Export template and Import schedule use exact values-only XLSX fields. Import replaces the schedule, clearing remaining previous rows while preserving other inputs/settings; only Save calculator persists. Capacities match Excel: 1,000 vermiculite, 200 board and 300 duct rows. Import rejects formulas, macros, external links and malformed data.

Values display two decimals at rest; focused controls reveal exact values. New calculator edits retain full precision, including small yields and tolerances. Numeric choices reveal exact values when choosing between options that round to the same display. This intentionally differs from the older Quote UI's two-decimal edit policy. Raw calculated values stay unrounded in both paths; product, fastener and report identifiers remain literal.

The approved formula-text exception fixes duct copied instruction text using the first row's fixed technical references, including M6 and AS4254. The separately authorized vermiculite commercial defaults change explicit starting inputs, not source formulas or passive-fire thickness rules. See [exception record](CALCULATOR_EXCEPTIONS.md).

Australian document links identify manuals, PDS, SDS and report availability. An unavailable exact report is labelled as a manufacturer request. Links never silently replace workbook calibration. Source exclusions, review flags, errors and withheld quantities remain part of the output.

## Architecture and verification

The extension reuses the HTTP server, SQLite database, browser UI and openpyxl dependency. An allowlisted formula interpreter evaluates immutable source graphs without eval/exec or cached answers. SQLite version 2 adds calculator_states; quote/settings rows are not rewritten. Saved source hashes prevent silent reinterpretation after a source revision. This remains a loopback-only application, with no shared hosting or public deployment.

Calculator quantities remain separate from priced quotes: the files do not specify an automatic mapping into pricing. Existing PDFs still report the original Quote estimate and complete breakdown.

The prior source-parity checkpoint passed 419,905 native Excel comparisons: 161,566 original formula outputs, 300 approved text outputs, and 258,039 varied outputs over 3,471 schedule cases. Expected values came from Microsoft Excel 16.0 build 20326 recalculating disposable copies of the original XLSX workbooks. Coverage includes every steel selection and editable setting. Text, booleans and errors compare exactly; numeric tolerance is relative 1e-12 and absolute 1e-10. Reviewed defaults need separate overlay/precedence and save-isolation checks; they do not replace those original fixtures. See [mapping and evidence limits](WORKBOOK_CALCULATORS.md).

The original Quote fixture remains 216 scenarios × 151 outputs, captured with verbatim Calculator formulas and saved lookups in a macro-free harness. That earlier evidence does not prove live XLSM external-link refresh.

Work continues on `feat/workbook-calculators`, preserving earlier implementation
and saved data. The prior publication checkpoint recorded pushed implementation
946f2c1 and [PR #6](https://github.com/Slayde91/estimator/pull/6), with CI blocked
before job steps by GitHub account payment/spending limits. That checkpoint's
176 Python tests, 56 UI checks and subsequent 21 report/HTTP checks are historical.
Current complete-suite, build, runtime, commit, push, CI and merge evidence belongs
in SESSION_HANDOFF.md and must be checked independently for this change.
