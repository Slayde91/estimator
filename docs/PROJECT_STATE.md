# Project state

Date: 2026-09-16. Executable code and checked results take precedence over this document.

Current implementation: Pricing library has one Inventory & Rates view, a
Used in Estimator filter, searchable product rows and expandable category/rate/
yield details. Products with multiple uses share one inventory price owner;
unused inventory and standalone rates remain accessible. Excel actions are green.

The new values-only workbook has Inventory & Rates and Instructions sheets.
Inventory rows own purchasing values; collapsed Use rows preserve explicit IDs,
group memberships, independent rates/yields and dropdown order. Old two-sheet
pricing imports remain supported. The shared parser, calculation rules, catalogue
model, SQLite schema and saved-quote snapshots are unchanged.

Local checks: 22 workbook tests (including the 216-scenario Excel oracle through
both formats), four API integration tests, 14 server tests, 11 Calculator tests,
and 122 UI checks pass. Browser review verified filtering, both uses of SBR Latex,
linked prices, a separate override, independent resets and save/reload. Both new
workbook sheets were rendered and reviewed. CI/merge evidence is recorded after
publication in `.runtime/unified-pricing-qa/publication.json`.

Prior release: shared estimating notice PR #21 merged at
`ab48bafc45c13cd6077647f10aa4894e4fa64fad` with both CI runs passing.
The checkpoints below describe earlier work.

Shared estimating notice: the application footer now carries the requested
CEASEFIRE PFP guidance note beneath every browser view. The footer wraps on
narrow screens. Pricing-library behavior, imports and calculations are unchanged.
Local validation: all four main views checked in the browser, footer visually
reviewed, 117 existing UI checks passed, and the 35-file distribution built.

The preceding labour/control work below was subsequently merged as PR #20 at
`e843cf7a09b6ec20f14ff93ebe7ad0863cbbb148`; both exact-head CI runs succeeded.
Its final receipt is `.runtime/labour-controls-qa/publication.json`.

Commit-preparation checkpoint on `feat/labour-breakdown-calculator-controls`: the latest
27 browser comments add an Estimator Labour breakdown and refine calculator
controls, titles, units, spacing and action styling.

The new table reads stored calculation cells and explains F10 total project
days through eight task rows, masking, adjusted extra labour and mobilisation.
Pinning mirrors meshing and is excluded from the task subtotal. The separate
F2 labour cost remains unchanged. Legacy saved-quote responses receive the
additive detail from their own stored cells without rewriting the saved record.
Missing values/errors remain visible; stale or failed calculations cannot leave
an old labour table displayed.

Requested board and duct choices use native selects, while source-approved
custom/warning values retain an explicit editor. Large section lists are loaded
on opening. Board purchasing dimensions/area show numeric-only mm/m² suffixes;
its title and live warning follow CALCULATED SUMMARY. Duct SUMMARY uses four
separated wrappers over its existing tables. Vermiculite START hides the two
requested source-history blocks and gains the relocated guidance; QUICK
CALCULATOR and factor titles are shorter. Toolbar actions have the requested
colors and order, with the extra helper text removed.

Verified so far: 92 calculator UI and 25 Estimator UI checks pass (117 total),
as do both JavaScript syntax checks. Native review covers all 27 comments and the
13-row labour table and default 0.50 total. All 104,068 source cells across
twelve calculator pages, all three PDF text/register-value projections, and
six Estimator API scenarios' existing result fields match before/after; only
the additive labour projection is new. Evidence is retained under
`.runtime/labour-controls-qa`, including the read-only native Quote.xlsm F10 audit.

The full local Python run is still continuing at this checkpoint. It encountered
a legacy metadata expectation that has been corrected and one HTTP error whose
exact trace remains pending. No clean full Python run, build or refreshed-runtime
success is claimed. Commit/push, PR, exact-head CI/review and merge are pending.
Current Git/check evidence and the eventual `.runtime/labour-controls-qa/publication.json`
receipt take precedence over this commit-preparation record.

The preceding START/factor increment is published: PR #19 merged as
`335f4b6e0eac2419cb2b7f8c98998c0f5661d5d7` from feature head
`cc1ccf9a43b8c139e1d26e2ac6c07b08925c4f4e`. Its two exact-head CI runs passed
235 Python tests (231 passed, four skipped) and 111 UI checks. The receipt is
`.runtime/tabs-notes-qa/publication.json`; those results verify PR #19, not the
current increment. Source packages, formula rules, saved input keys, storage
schema and existing report calculations remain unchanged.

Each calculator has **Download Excel register** immediately after Export template.
The workbook contains Summary and Schedule sheets, plus Extra boards for board
protection. It captures the same calculated draft as the PDF: used items,
incomplete statuses, material quantities, pooled totals, qualifications and
source identity. Downloading does not save or change the calculator.

Registers contain typed values rather than Excel calculation formulas. Numbers
retain their unrounded values and display two decimals; text remains literal.
Recalculate in the app and download again to update a register. Export template
and Import schedule retain their separate input-only workflow.

The export reuses the existing report projection, openpyxl dependency and exact
number serializer. No source formulas, business rules or storage schema change.
The Excel-register checkpoint passed seven register tests, 14 API tests, 81 calculator UI
checks, 20 original UI checks, syntax and a 35-file build. Representative renders
cover all seven default workbook sheets, with final shared table styling verified.
The refreshed service returned all three registers correctly, served matching
assets and preserved saved data. PR #17 merged as `364a024`; both exact-head CI
runs passed 220 Python tests (216 passed, four skipped) and 101 UI checks. Its
publication receipt is under `.runtime/excel-register-qa`; those prior checks
do not validate the current labour-days and calculator-controls increment.

The preceding 23 browser comments refine calculator detail layout. Vermiculite
factor helpers absorb blank dividers and collapse one blank left-side row while
retaining adjacent notes, inputs and results. The Published thickness label
appears before its left-aligned result. Five technical-rule headings use pink
table-header styling; selected references use normal text and exposure names
use bold text.

Duct support-instruction prose uses normal weight beneath its existing column
heading. Maxilite reference labels and board purchasing product labels are bold.
Board calculator, summary and extra-board titles/notes fill their overview rows,
with all three BOARD SUMMARY cards retained. Browser titles read BOARD SUMMARY
and EXTRA BOARDS; running-total sections read PRODUCT SUMMARY for vermiculite
and now CALCULATED SUMMARY for board. Worksheet identities and underlying source captions
remain unchanged. The exact cell/range boundaries are recorded in
[the presentation mapping](CALCULATOR_PRESENTATION_MAPPING.md).

These changes extend the existing presentation metadata and renderer without
altering calculations, source merges, technical rules, saved inputs, schemas or
PDF projections. Local checks passed 25 targeted Python tests, 75 calculator UI
checks, 20 original UI checks, JavaScript syntax and the 34-file build. All
104,068 worksheet cells and three PDF text projections matched before/after.
Browser review confirmed the row order/alignment, helper spans, label weights,
pink headings, full-width board overviews, retained cards and title aliases with
no application errors. Independent diff review was clean.

The main service was refreshed successfully: four served assets match the current
files and the new presentation metadata is active. Database state retained two
quotes, no settings or calculator-state records and schema version 2 exactly.
Publication and exact-head CI/merge were pending at that earlier documentation
checkpoint. Its evidence belongs in the dated SESSION_HANDOFF.md entry and
`.runtime/detail-layout-qa`; it does not verify the current increment.

The shared calculator settings banner now displays **SETTINGS & RULES**. This is
a browser title change only; worksheet names, source values and calculations are unchanged.

The preceding 21 browser comments refined calculator units, table layout and label
formatting. Vermiculite SCHEDULE's area and volume summary captions explicitly
show m² and m³. Its running material totals and the board schedule's Board Totals
occupy their own full-width sections with gold explanatory notes.

The BAGS manual form omits decorative column G only in rows 6–15, preserving
the working-yield label/value and the Whole bags quantities in the order table
below. Its blank yield-row span is now H10:N10. Every SETTINGS/PRODUCT SETTINGS
table expands with the page, while prepared schedule scrollers retain their
existing vertical behavior. Duct SUMMARY and PRODUCT SETTINGS use bold first-column
reference labels at explicit source anchors, keeping ancillary prose separate.
The user-confirmed published-period table at vermiculite CALCULATOR A28:I30 is
centered. Exact bounds are recorded in
[the presentation mapping](CALCULATOR_PRESENTATION_MAPPING.md).

These browser changes preserve source values, merges, formulas, input identities,
saved-state behavior and PDF projections. Local validation passed 25 targeted
Python tests, 73 calculator UI checks, 20 original UI checks, JavaScript syntax
and the 34-file build. All 104,068 worksheet cells and three PDF text projections
matched before/after. Browser checks confirmed the unit labels, full-width totals,
centered period table, scoped BAGS omission, uncapped Settings tables and bold
reference labels without errors; independent review found no actionable issues.

The saved-data baseline contains two quotes and no settings or calculator-state
records. The main service was successfully refreshed: all four served assets
match the current files, and the new presentation metadata is active. The final
database comparison preserved every record and schema version 2 exactly.
Publication and current-head CI/merge were pending at that prior documentation
checkpoint; its final publication receipt is under `.runtime/units-labels-qa`.
Current evidence belongs at the top of SESSION_HANDOFF.md; successful local and
runtime checks do not establish publication.

The preceding eleven browser comments simplify the Estimator form and refine
calculator table presentation. The Workflow dropdown is removed while saved
workflow values and the existing new-estimate default remain in calculation,
save and report requests. The existing dimensions/measurement field is labelled
NOTES; its stored identity and text remain unchanged.

Independent presentation tables, including board purchasing, expand to their
full content height; prepared schedule scrollers keep their existing behavior.
Duct CALCULATOR's introduction note has a full-width gold row. Two SUMMARY
section headings span the full table width, five blank PRODUCT SETTINGS rows
lose internal dividers, and the blank BAGS yield-row region becomes one gold
span. USE NOTES rows 153–159 and their contents link are hidden from Duct
PRODUCT SETTINGS. Exact browser-only overrides are recorded in
[the presentation mapping](CALCULATOR_PRESENTATION_MAPPING.md). Source values,
merges, formulas, saved data, report projections and schemas remain intact.
Validation and publication for this increment belong in SESSION_HANDOFF.md.

The preceding browser cleanup hides six requested BOARD SUMMARY table columns:
the four intermediate area columns and the Stock source and Board key columns.
Its independent purchasing table retains product, thickness, sheet dimensions,
whole sheets and purchase area for all eighteen stock rows. All three summary
cards, the live qualification and the pooling/area notes remain visible.

EXTRA BOARDS hides Evidence reference in the browser while preserving its
existing input identity, stored values and API support. Every calculator tab
uses the normal view without a Show advanced columns checkbox. Advanced values
remain in saved state and calculations and can still be requested through the
worksheet API. These are browser presentation changes; source formulas,
quantities, report projections and storage schema remain unchanged. Current
validation and publication evidence belongs at the top of SESSION_HANDOFF.md.

The preceding browser presentation increment removes frozen first columns from
calculator schedules, adds solid black gridlines across calculator data tables,
and gives every main section the existing red-and-white DUCT PROTECTION SUMMARY
heading style. Vertical column headings can remain visible while scrolling.
Source, overview, product-total and stacked/projected section headings share
that style; navigation retains its existing appearance. The two populated/blank
data fills remain distinct, with zero counted as populated.

Vermiculite CALCULATOR now orders Inputs, Thickness and quantities and the
period comparison as separate sections, each with its own source heading and
data. BAGS displays MATERIAL QUANTITIES, with the product-order heading and
table together after the manual form. Duct PRODUCT SETTINGS presents FyreWrap,
its application table and penetration takeoff as separate vertical sections,
and hides its requested introductory rows. Vermiculite SETTINGS also omits its
introductory rows 3–4. All existing inputs, source notes
outside explicit omissions, lookup lists and material quantities are retained.
Source formulas, input identities, saved precision and PDF contents are unchanged. Current
validation and publication evidence belongs in SESSION_HANDOFF.md.

The preceding browser cleanup changes the displayed board schedule title to
STRUCTURAL STEEL BOARD SCHEDULE and its product-summary heading to Board Totals.
It removes the requested introductory rows/blocks while retaining the live
incomplete-order warning and all 200 schedule rows. The separate BOARD SUMMARY
page keeps its three cards, as clarified by the user.

Ductwork displays DUCT PROTECTION CALCULATOR and DUCT PROTECTION SUMMARY. Its
schedule omits the requested introductory rows and clearance/fixing/qualification
columns, and places volume/yield before support instructions. Source page names,
input keys, formulas, quantity holds, the approved copied-text correction and
PDFs remain unchanged. Exact aliases, omissions and column order are recorded in
[the presentation mapping](CALCULATOR_PRESENTATION_MAPPING.md). Current checks
and publication outcomes belong in SESSION_HANDOFF.md and are not claimed here.

The preceding board-only browser cleanup stacks SETTINGS into General settings,
Fire periods and temperatures, and Diagnostic messages. It hides the primary
Basis column and the dropdown table's final two reference/explanation rows
using bounded display ranges. All 28 editable settings, exact values,
dependent dropdown choices and diagnostic lookup records remain intact.
BOARD SUMMARY presents three source-based cards for net board required, whole
sheets and purchase area, retaining its incomplete-order warning.

Board CALCULATOR replaces its six summary cards with running totals per product:
box reference area, net board required and pooled whole sheets, with incomplete
schedule/extra-board counts. The existing formula evaluator groups schedule
box-reference areas and the source BOARD SUMMARY totals; valid extras and
product/thickness stock rounding are preserved. Box reference area is not the
steel profile's surface area, and the user has been informed of that distinction.
No new geometry or purchasing rule is introduced. Source packages, formulas,
saved inputs and PDF quantities remain unchanged. Exact ranges and independent
source-example totals are in
[the presentation mapping](CALCULATOR_PRESENTATION_MAPPING.md). Current
validation and publication must be checked against Git/checks and the latest
receipt; this paragraph does not claim those checks have passed.

The preceding browser cleanup gives Ductwork SUMMARY four independent tables:
product totals, penetration angles, working yields and Maxilite strips. It
omits the requested commentary columns while retaining all product quantities,
withheld counts and the complete angle table. PRODUCT SETTINGS omits the
Both/Mixed explanation block. Board START omits the requested introduction,
counters and Sources section/link; board CALCULATOR shows row statuses in
normal font weight beneath their bold heading. These are display changes only:
source packages, formulas, input keys, calculated values and PDFs are unchanged.
Exact retained/omitted ranges are recorded in
[the presentation mapping](CALCULATOR_PRESENTATION_MAPPING.md). Validation and
publication outcomes for this increment belong in SESSION_HANDOFF.md.

The preceding display change hides Ductwork's Penetration clearance guide column
in the browser. Its underlying values and Product Settings
guidance remain intact, as do the adjacent fixing/support columns and all
calculations. See SESSION_HANDOFF.md for current verification evidence.

The preceding increment simplifies the calculator display and makes material-basis
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
summary values and shared section dropdowns. Main sections have uniform
red-and-white headings and scoped navigation. Vermiculite operating rules and
factor helpers have separate browser tabs; SETTINGS has seven section choices.
Material-basis text is read-only. Outputs distinguish populated and blank values,
with numeric zero populated and a separate published-thickness highlight.
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

The historical `feat/workbook-calculators` publication checkpoint recorded
implementation 946f2c1 and [PR #6](https://github.com/Slayde91/estimator/pull/6),
with CI initially blocked before job steps by GitHub account payment/spending
limits. PR #6 and the subsequent column cleanup in PR #7 have since merged.
That older checkpoint's
176 Python tests, 56 UI checks and subsequent 21 report/HTTP checks are historical.
Current complete-suite, build, runtime, commit, push, CI and merge evidence belongs
in SESSION_HANDOFF.md and must be checked independently for this change.
