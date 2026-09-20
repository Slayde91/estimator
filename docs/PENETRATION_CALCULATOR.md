# Firestopping Estimator

The main Estimator contains the Firestopping Schedule below Material Requirements
& Output. The Firestopping Estimator is an independent single-item calculator.
They share project details and one effective pricing snapshot. Schedule materials,
labour costs and days are included once in the main quote summary and quote PDF.
The independent current item contributes only after it is added to the schedule.

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
extend over all rows. The app supports 0–1,000 schedule rows; the current-item
calculator always has one row. An empty schedule overlays zero summary and
BREAKDOWN outputs and clears template inputs, so it charges no travel or setup.
The original workbook's formulas and constants in the packaged source are not
rewritten. The effective application policy disables the legacy Firestopping
LAFHA, travel days, labour/material percentages and
substrate/access/complexity surcharges. The main Estimator's global material
and labour adjustments still apply once to the combined quote cost base. It
overlays J2:M2 with No/0/0/0 and BI/BJ/BK with zero for every row, regardless of
legacy inputs or current pricing. Historical inputs remain portable but cannot
reactivate those effects. Explicit row materials, manual hours and adjustments
(AE:AJ), quantity and project Waste settings remain active. The effective labour policy replaces
the source's combined 0.10-hour setup and 0.15-hour register charge with an
project-wide Register Allowance, defaulting to 0.25 hours per item. It also replaces
the source collar labour lookup with editable Pipe Labour multiplied by the
Pipes Multiplier (AN). Item QTY (O) then applies once to these hours.
The source image cell S4 already contains a cached
`#VALUE!`; it is not a financial formula or an editable estimating input.

## Project and output behavior

A new Firestopping Schedule starts empty. Its columns include Service Type,
Penetration Type, Substrate Orientation, FRL, editable Item QTY and a compact
source-diagram thumbnail when the library item has an image. A separate
current item starts blank. Input groups separate
Penetration, Products and labour, Additional Allowances, Unlagged Pipes,
Plastic Pipes, Cables/Bundles, Cabletrays, Substrate and Bulkhead. Only the pipe
group matching Service Type is shown, and Bulkhead is shown only when Type is
Bulkheads. Cabletrays is shown only for cable/bundle services, Cable Trays and
the source-backed Lagged Pipes entries that use those fields. Substrate appears
only when Penetration Type is Oversized. SETTINGS contains Register Allowance,
the six editable Pipe Labour diameter bands and the six project-wide Waste (%)
values for Additional Allowances, Pipes/Cables, Cabletrays, Substrate, Bulkhead
board and Bulkhead framing. Hover help names each Waste setting's applicable
section. Legacy row wastage and Register Allowance values are migrated once into
these project settings and no longer change one row independently. The
current-item heading uses Type and Service Type, while the longer Items/Services
description remains in its input. **Item Summary** stays beside the editor while
scrolling at desktop widths.
The current item's calculated detail and
the complete schedule totals are calculated independently. Numeric fields use
native number controls, retain their full stored precision and use the following
arrow-step sizes: Item QTY, Material QTY, dollar adjustments, Waste settings and
multipliers use 1; Mastic Qty and Additional Labour use 0.25; Register Allowance
uses 0.05; cable-tray, wrap, board and bulkhead dimensions use 5 mm. Other
numeric fields accept their existing precision. Percentages are shown and edited
as percentages.

FRL uses one canonical list: N/A, -/60/60, -/90/90, -/120/120, -/180/180 and
-/240/240. Legacy library and saved-item values such as `120 min` are presented
as `-/120/120` without rewriting the installed supplier source package.

**Add to Schedule** copies the current item's inputs using current project prices
and the effective calculation policy. **Edit** copies a schedule row into the current-item
form; only **Update Schedule** applies those edits. **Cancel edit** restores the
previous current item. Library additions leave both library navigation and the
current item intact, with the recalculated price displayed beside the library action.
When the edited row is linked to a Firestopping Library item, **Add to Schedule**
asks for OK or Cancel. OK adds the edited inputs as a new independent schedule row
without a library item ID and retains the original linked row; Cancel changes neither row.
Each library Add counts one item: its first addition creates a row with Item QTY 1,
and later clicks increase that row's quantity. The library card shows the current
schedule quantity, including manual edits, removal and Undo. A stored library item
ID preserves this behavior across Save/Open without replacing edited row inputs.
For older rows without this ID, an explicit Add adopts at most one row whose inputs
match the library item exactly apart from quantity and empty values. Other existing
rows remain unchanged, preserving their fixed per-row charges.

Item QTY is editable in the schedule without changing the independent current item.
Invalid or incomplete numeric text remains visible and blocks calculation;
asynchronous results do not interrupt typing or replace newer inputs. Current-item
and schedule global allowance controls, Access and Complexity are omitted.
Substrate remains descriptive. Products and labour labels the crew selector
**Teams/Crews** and the board selector **Board or Batt Type**. Library edits and existing saved items use the
same effective policy; their frozen product and labour prices remain independent.

The selected item and library editor share an eight-row cost table: Additional
Labour, Register allowance, Board, Collars, Mastic, Framing, Wrap and Other.
Additional Labour uses the existing manual AH/DJ hours and the AJ monetary
adjustment; those hours are no longer duplicated under Other. Register allowance
uses the selected Teams/Crews unit price (CW), as does Pipe Labour. Quantity values use the source
BS/CB/CJ/CQ/CU product quantities, Mastic Qty AC, collar multiplier AN and
additional material AF with its AG wastage, each multiplied by Item QTY once.
No rounding up or main-quote global allowance is added inside the independent
Firestopping calculation. Collar quantities appear only when
a collar product is selected; the underlying Pipes Multiplier remains available
to pipe-wrap calculations. Task hours and costs use Item QTY and reconcile to
the effective G/F/DK outputs. AI is allocated to Other materials and is
multiplied by Item QTY; AJ is allocated to Additional Labour costs once per
line, without multiplication by Item QTY.
The canonical DK result controls the effective hours gate.
Blanks, zeros, negatives and calculation errors remain distinct. This is a
display projection. Summary remains available below the table; removed allowance
and multiplier values are omitted from the UI and exports. All table cells are
centred. The schedule has a
separate aggregate table: costs and task hours sum across schedule lines, with
canonical schedule subtotals. Matching product unit prices are shown once.
Material quantities sum only for the same product, source context and unit;
different rates stay separate in Unit Prices. Non-collar entries without a
selected product remain per line, and grouped entries retain their contributing row IDs.
Summary retains each line's effective values.

### Automatic and manual labour allowances

The project setting `register_allowance_hours` and row input
`pipe_labour_hours` are stored separately from workbook cell inputs. Register
Allowance is one SETTINGS value for every item. Older per-row Register Allowance
values are accepted for compatibility, migrated to the shared setting and removed
from normalized rows. Missing or null Pipe Labour means automatic; an explicit
number, including zero, is a manual override. Clearing it or choosing **Use
automatic** restores automatic calculation. The server returns the resolved pipe
default separately, so merely opening an item does not write that value into its
saved row. Both values accept finite, nonnegative hours. Additional Labour retains
its existing AH input semantics.

For Plastic Pipes, a selected collar with positive resolved Pipe Labour makes a
positive Additional Labour entry a duplicate. Draft normalization clears that
duplicate AH value for every library, current-item, schedule and saved-project
path. Zero or missing Pipe Labour, zero or negative Additional Labour, rows
without a collar, and other Service Types retain their entered AH value. The
installed supplier library remains unchanged.

Register Allowance defaults to 0.25 hours and is editable in project SETTINGS.
Pipe Labour is enabled and applied
only with a selected collar and uses the pipe diameter (AL). Its six banded
defaults are editable in project SETTINGS:

| Pipe diameter | Hours per pipe |
| --- | ---: |
| Up to and including 50 mm | 0.25 |
| Over 50, up to 100 mm | 0.30 |
| Over 100, up to 150 mm | 0.35 |
| Over 150, up to 200 mm | 0.40 |
| Over 200, up to 250 mm | 0.45 |
| Over 250, up to 300 mm | 0.50 |

A selected collar with a missing/nonpositive diameter or a diameter above
300 mm requires manual Pipe Labour hours. Its calculation is unavailable until
that value is supplied; it is not silently priced with zero labour. Manual
values survive diameter changes. Removing a collar selection clears Pipe Labour
so it remains nil while no collar is selected; the pipe multiplier is retained.

These rules apply to current items, existing library items, schedules and quote
exports. The calculation policy version invalidates cached library prices.
Original source formulas and the source-oracle calculation path remain intact.

The quote PDF Material Breakdown follows the same product order as the
Estimator Material column. Main and Firestopping products share the columns
Material / yield, Coverage, Base units, Wastage % / units, Priced units, Unit
sell rate and Line amount; there is no second Firestopping materials table.
Firestopping coverage, pre-wastage base units and wastage units come from the
recorded schedule result. Older frozen results without those added presentation
fields display them as unavailable and are never recalculated from current prices.
Labour allocation happens per schedule item before rows with the same selected
product are reconciled across contexts and captured rates. Quantities, line
amounts and hours are summed; the displayed sell rate is the exact weighted
average when captured rates differ. The combined Board task
is split between Substrate and Bulkhead in proportion to their calculated
quantities; Wrap is split between Pipes and Cabletrays in the same way. The last
share retains any floating-point remainder so each task's hours are counted once.
Zero total quantities do not receive invented labour days. The Estimator Labour
Breakdown reconciles all Firestopping components into one `Firestopping` row and
sums their days. The quote PDF keeps the detailed task rows under `Firestopping
Labour` and adds totals for task hours, labour days and labour amount. Its main
labour, Masking / cleaning, and Additions and project costs tables also include
the requested days and amount totals. Register allowance and Additional Labour
remain separate inputs in the detailed Firestopping calculation; monetary
adjustments do not create hours. Explicit AI
material adjustments appear separately with quantity one and their extended rate.

The source-oracle path retains the original workbook formulas. The application
quote path calculates the main components without the two workbook percentage
adjustments, adds the schedule's canonical material cost, labour cost and days,
then applies the global material and global labour percentages once to their
respective combined cost bases. Fixed adjustment remains a separate dollar value.
Native projects store the schedule and composer separately; quote snapshots also
freeze the schedule used for their combined result. Older stored quote results
remain unchanged until explicitly recalculated.

Save and Save As capture both estimates and the three existing calculators
together. Project version 1 gains an optional `penetration` object containing
only validated inputs and the source SHA-256. Its `draft` is the schedule;
optional `composer` stores the independent current item's one-row draft and
allowances. Rows may also carry an optional `library_item_id`, an opaque library
identity outside workbook inputs. The same ID can occur once per draft; a matching
composer copy remains independent. Old firestopping projects retain their full schedule and start a
default current item; projects without firestopping inputs start empty. Older
browser code cannot overwrite a project while omitting stored firestopping inputs
or its composer. A request-only tracking version also prevents older browser code
from dropping saved library item IDs; it is not stored in the project file.
Unknown source hashes are rejected. Editing mode is transient;
a reopened current item is independent until explicitly added or used in a new edit.

The project keeps its original pricing until the user explicitly applies new
project pricing or selects Use current pricing. Editing the shared library does
not change a saved project's original snapshot. Price changes recalculate both
estimates independently while preserving their entered quantities.

Schedule PDF and XLSX exports calculate only the captured schedule and its pricing once. Both
include project details, totals, schedule, inputs, calculated detail and any
errors. The XLSX register contains literal values, not executable formulas or
links, and preserves numeric precision. Downloads use the opened/saved project
folder, or the standard Downloads folder if no project is selected.

## Verification

Run the focused calculation and integration checks with:

```powershell
python -m unittest tests.test_penetration_calculator tests.test_penetration_integration -v
```

The raw source engine (`engine_for_draft(..., effective=False)`, used only by
source regression tests) matches all 76 cached CALC/BREAKDOWN outputs. The committed
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
