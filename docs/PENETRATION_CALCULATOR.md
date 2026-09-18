# Firestopping Estimator

The Estimator page contains two independently editable estimates: the existing
Estimator and the Firestopping Estimator. They share project details and one
effective pricing snapshot. Their totals are separate; neither is automatically
added to the other.

The visible name is Firestopping Estimator. Source filenames, the internal
`penetration` project key and `/api/penetration` routes remain unchanged for
compatibility. The Firestopping Library uses a separate single-item editor with
the same calculation engine; its inputs and pricing do not replace the project
schedule. See [library item editing](REFERENCE_LIBRARIES.md#editing-a-firestopping-library-item).

## Source contract

The source is `Penetration_Calculator.xlsx`, SHA-256
`388bf5d51befe860304c82ec0475c01a6737c8be225a219a763d087851a5dfde`.
`scripts/import_penetration.py` reads its original OOXML without opening Excel or
resaving the workbook. `data/penetration.json.gz` preserves all 108 original
formulas, cell values, worksheet metadata, validation records, named ranges and
the source table definition. The original file is not a runtime dependency.

The 76 CALC/BREAKDOWN formulas execute through an isolated adapter of the existing
formula parser. The adapter supports this workbook's LET, XLOOKUP and ROWS
expressions. Existing estimator and calculator formula engines are unchanged.
Intermediate values are not rounded for display. Formula errors remain errors
in the screen, PDF and Excel register rather than becoming zero costs.

The 32 LISTS formulas filter the source inventory and look up selling prices,
widths, lengths and areas. The app materializes those lists from the same
effective inventory used by the pricing library, preserving source ordering,
case-insensitive first-match lookups and empty-text versus blank semantics.
All 417 cached source inventory descriptions, prices and dimensions matched the
app's imported baseline during implementation. Product display-name edits do not
rename the stable source selection keys. Independent rate overrides used by the
older Estimator do not replace this workbook's direct inventory selling prices.

Source lookup ranges support 2,098 inventory records and up to 1,000 entries per
filtered product list. A larger library is rejected explicitly by this calculator
rather than silently truncated. Other estimators retain their existing limits.

The original source includes one schedule item. Additional app items copy its
row formulas with Excel-relative-reference semantics, and summary SUM ranges
extend over all rows. The app supports 1–1,000 rows. The original workbook's
formulas in the packaged source are not rewritten. Project allowances remain the
source constants (LISTS BY2 = 650 and BZ2 = 2080), with the original global LAFHA,
day and percentage inputs. The source image cell S4 already contains a cached
`#VALUE!`; it is not a financial formula or an editable estimating input.

## Project and output behavior

A new penetration schedule starts with one blank row. Input groups separate
Penetration, Products and labour, Additional Allowances, Pipes, Cabletrays,
Substrate and Bulkhead. The selected item's calculated detail and
the complete schedule totals are shown separately. Numeric inputs retain their
full stored precision; percentages are shown and edited as percentages.

Item QTY is editable in the schedule and mirrors the selected item's input.
Invalid or incomplete numeric text remains visible and blocks calculation;
asynchronous results do not interrupt typing or replace newer inputs. Project
LAFHA, travel days and global percentages appear under Additional Allowances
and retain their project-wide scope. The library editor applies its separate
allowances only to that library item.

The selected item and library editor share a seven-row cost table: Labour,
Board, Collars, Mastic, Framing, Wrap and Other. Its five quantity values are
the source product quantities BS/CB/CJ/CQ/CU multiplied by Item QTY. No rounding
up is added. Task hours and costs include the existing global adjustments and
quantity so the subtotals are exactly the original G/F/DK outputs. Setup/register
hours come from the source named range; AI is allocated to Other materials and
AJ to Labour costs. The canonical DK result controls the source hours gate.
Blanks, zeros, negatives and calculation errors remain distinct. This is an
additive display projection, not a replacement calculation. Raw outputs and
export evidence remain complete. Summary and Multipliers remain available
separately below the table.

Save and Save As capture both estimates and the three existing calculators
together. Project version 1 gains an optional `penetration` object containing
only validated inputs and the source SHA-256. Older projects open with a blank
penetration schedule. Older browser code cannot overwrite a project containing
penetration inputs while omitting them. Unknown source hashes are rejected.

The project keeps its original pricing until the user explicitly applies new
project pricing or selects Use current pricing. Editing the shared library does
not change a saved project's original snapshot. Price changes recalculate both
estimates independently while preserving their entered quantities.

PDF and XLSX exports calculate the captured draft and its pricing once. Both
include project details, totals, schedule, inputs, calculated detail and any
errors. The XLSX register contains literal values, not executable formulas or
links, and preserves numeric precision. Downloads use the opened/saved project
folder, or the standard Downloads folder if no project is selected.

## Verification

Run the focused calculation and integration checks with:

```powershell
python -m unittest tests.test_penetration_calculator tests.test_penetration_integration -v
```

The cached source example matches all 76 CALC/BREAKDOWN outputs. The committed
`tests/fixtures/penetration_excel_oracle.json.gz` independently records **49
Microsoft Excel scenarios and 3,786 formula outputs**, all matched by the app
with zero differences at absolute tolerance 1e-10 / relative tolerance 1e-12.
Strings, blanks and errors compare exactly. This allows floating-point noise
well below displayed precision without substituting cached answers at runtime.

Coverage includes the source example, blank inputs, multipliers, travel/LAFHA,
global adjustments, additions, board/collar/mastic/wrap geometry, labour lookup
boundaries and maximum fallbacks, numeric zero versus blank diameter, changed
shared pricing, and multiple schedule items. Paired native cases establish that
a selected collar with blank diameter has blank labour, while diameter zero
returns 0.2 hours under the source formula. Unknown saved dropdown selections
remain visible with a diagnostic; their source formula result is not rewritten.

The fixture records Excel 16.0 build 20326 and the original source hash. Native
capture copies the original workbook and removes LISTS editing protection only
in that disposable copy. CALC/BREAKDOWN XML remains byte-identical. Before the
first native recalculation, the 32 external LISTS formula anchors are replaced
inside Excel using independently decoded source caches, including 18,510
empty-text sentinels. Explicit price-change scenarios update those frozen lookup
values. This verifies the workbook's financial formulas with identical inputs
and prices; it does not claim execution of a live external-link refresh.

To regenerate, decompress the fixture to a temporary JSON plan, then run:

```powershell
pwsh -File scripts/capture_penetration_oracle.ps1 -SourcePath <original.xlsx> -PlanPath <plan.json> -OutputPath <new-oracle.json> -WorkingDirectory <disposable-folder>
```

Capture creates and closes its own hidden Excel instance. It never changes the
supplied workbook, saves the native test session or attaches to the user's Excel
session. Source hashes are checked before and after. Runtime and CI use the
committed evidence and do not require Excel or the source workbook.
