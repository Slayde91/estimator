# Workbook calculators

The current application names are **Steel (spray)**, **Steel (board)** and **Ductwork (spray/wrap)**. Each main schedule supports 1,000 items through the documented [application extension](SCHEDULE_EXTENSION.md). The source capacities and formula counts below describe the preserved original workbooks, not the current UI limit. New templates omit Line and include spray Location first; previous numbered templates and exact original legacy templates remain accepted.

The three new workbooks are separate estimating specifications. The existing
Quote estimator, pricing library and quote PDF continue to use `Quote.xlsm` and
`Inventory_list.xlsm`. Calculator material quantities are not automatically
inserted into a priced quote: the supplied files do not specify that mapping.

## Calculator downloads

Each calculator captures its complete current draft for three report downloads:

- **Download PDF Schedule** (`APPENDIX A.pdf`) contains the **Full schedule** and
  used-row statuses, without product summaries or EXTRA BOARDS.
- **Download XLSX Schedule** (`APPENDIX A.xlsx`) retains the complete Summary
  and Schedule sheets plus board Extra boards.
- **Download PDF Summary** contains **Material
  quantities and summary**, final product/ancillary tables, closing totals and
  populated extra-board details.

Both PDFs and the Excel register reuse `project_calculator_report`; the split
does not remove settings or extra-board quantities from the calculation. The
existing source exclusions, incomplete statuses and pooled purchasing rules
remain. Downloads neither save project files nor alter older saved estimates.
Input-only XLSX templates remain separate from the calculated Excel register.

Every PDF includes Project No., Client and Site Address plus Ceasefire's ABN,
phone and email. Schedule PDFs place **CALCULATORS | FULL SCHEDULE** beneath
the logo on each page; material-summary PDFs use
**CALCULATORS | MATERIALS & SUMMARY** there, with contacts on the right.
Source workbook/hash footnotes are omitted from PDFs.
All PDF and XLSX table headers and data are centred.

Steel (spray)'s summary omits the requested headings and the available-results,
display-rounding and pooled-bag explanation paragraphs. Ductwork's summary
omits the CAFCO/MONOKOTE calibration/example notes, FyreWrap interpretation note
and Working spray yields section. Ductwork's schedule also omits the
display-rounding sentence. Board's summary omits the display-rounding
paragraph, the two selected A8 ordering paragraphs, the EXTRA BOARDS heading,
introduction and empty message. Populated extra-board tables, other material
tables, quantities and statuses remain. These display exclusions do not remove
data from `project_calculator_report` or the complete Excel register.

Material-summary PDFs filter product and stock rows using the relevant raw
demand quantities, rather than counting visually zero cells or looking at stock
dimensions. Rows with confirmed zero demand and no unresolved quantity are
omitted; empty material tables and their headings are also omitted. Unknown,
failed, withheld, negative and tiny nonzero quantities remain visible. Unresolved
schedule products are identified separately where a stock thickness cannot be
established. The full schedule, source projection and XLSX register remain
complete. This is a presentation change and does not change pooled purchasing,
yield, geometry, thickness or material-calculation rules.

Editable Exposure cells use normal browser font weight only within vermiculite
SCHEDULE C10:C1009, board CALCULATOR M9:M1008 and duct CALCULATOR H11:H1010.
Main schedule headings, cells and controls are centred. Technical reference
labels, choices and source values are unchanged.

## Source inventory and pages

| Section | Source workbook | Source pages | Schedule capacity | Source formulas |
| --- | --- | --- | --- | ---: |
| Structural Steel (vermiculite) | Ceasefire_Steel_Vermiculite_Estimator_NEW.xlsx | CALCULATOR, SCHEDULE, BAGS, SETTINGS | 1,000 rows | 120,973 |
| Structural Steel (board) | Ceasefire_Structural_Steel_Board_Estimator_NEW.xlsx | START, CALCULATOR, BOARD SUMMARY, SETTINGS, EXTRA BOARDS | 200 rows | 16,534 |
| Ductwork | Ceasefire_Duct_Estimator_NEW.xlsx | CALCULATOR, SUMMARY, PRODUCT SETTINGS | 300 rows | 24,059 |

Source worksheet identities remain unchanged. Vermiculite also has browser
START and FACTOR CALCS tabs projected from SETTINGS. The board workbook's hidden
SETTINGS page is exposed to make its settings adjustable; EXTRA BOARDS is also
exposed because it supplies editable additional quantities to BOARD SUMMARY.
Other hidden reference tables remain private calculation data. All prepared
schedule rows are available on a continuous page. The browser has no Advanced
checkbox; the complete worksheet API still supports `include_advanced`.

Source hashes are recorded in `data/calculators/index.json`, each packaged model
and the independent Excel fixtures. Originals are never changed. No new source
contains VBA or external workbook links. Extraction retains all sheets, literals,
formulas, shared-formula expansion, local/global names, table definitions,
validation lists, styles, comments, row/column visibility and relationships.

## Calculation mapping

| Input | Workbook dependency | Implementation | Expected output evidence |
| --- | --- | --- | --- |
| Duct CALCULATOR B11:I310: size, product, length, FRL, wall/floor penetrations, exposure, orientation | PRODUCT SETTINGS, CALCULATOR J:CL, SUMMARY | Original formula graph in `ductwork.json.gz`; bounded `WorkbookEngine` | Duct native defaults and variations, including all product/FRL/exposure/orientation choices |
| Duct PRODUCT SETTINGS: 11 editable setting anchors | Application/yield selection, calibration, roll width and board gap | Exact setting overlays; unchanged remaining source constants | Every editable anchor varied in native scenarios |
| Board CALCULATOR A9:X208: section, member, stock, dimensions, quantity, waste and advanced geometry | STEEL LIBRARY, BOARD SYSTEMS, PRODUCTS, DETAILS & LIMITS, LOOKUP CACHE, SETTINGS; table `tSchedule` | Original formula graph in `steel_board.json.gz`, including structured references | All 1,342 steel IDs, all 18 stock records, advanced and boundary cases |
| Board EXTRA BOARDS A6:I45 and N6:N45; SETTINGS B6:B21/B23:B34 | Additional cuts/whole sheets and BOARD SUMMARY | Same engine, separate input and settings allowlists | Native default formulas and varied board scenarios |
| Vermiculite CALCULATOR D6:D12/D14:D17; SCHEDULE A10:L1009 | SECTIONS, THICKNESS DATA, ENGINE, SETTINGS, AUDIT | Original formula graph in `steel_vermiculite.json.gz` | All 553 active sections; 84 series, factor/period/ESA/web routes and boundaries |
| Vermiculite BAGS D6:D8 and 39 SETTINGS anchors | Yield, density, allowances, project flags and material totals | Formula-backed yields remain formulas until explicitly overridden | Five manual bag products and every editable setting varied |

The board data includes 1,342 steel IDs, 30 board systems, 18 stock records and
four products. The vermiculite data includes 1,449 named thickness records,
4,715 factor rows, 84 series, 3,784 product/case factors, 307 aliases and 11,299
suggestions. Source reconstruction tests compare the complete fresh extraction,
not only these counts. For example, the board native 200UC46 section factor is
138.16; it is not replaced with the different result of a geometry shortcut.

The interpreter evaluates source formulas, never cached formula outputs. It is a
small allowlisted Excel subset used by these files, not a general Excel service.
It implements source blank/error handling, lazy IF/IFERROR, case-insensitive
lookups, table/named references, aggregates, text and rounding functions. It uses
no Python eval/exec. Original literals and fixed technical identifiers are not
rewritten by relative formula translation. Formula caches are retained solely as
source evidence. Unsupported formulas fail visibly rather than returning zero.

The source has 31 cached error entries in the vermiculite auxiliary ENGINE/AUDIT
area. Native recalculated errors are reproduced, including their status context;
they are not silently turned into usable quantities. Existing source exclusions,
review flags and withheld quantities remain part of the output.

The only approved source-logic exception is the copied duct fixing-guide text.
See [CALCULATOR_EXCEPTIONS.md](CALCULATOR_EXCEPTIONS.md). Quantity formulas are
unchanged; both original and corrected text have independent Excel evidence.

## Inputs, persistence and schedule exchange

Runtime source packages are immutable. Each calculator has a separate draft
input overlay. **Save Project** captures all three overlays, their source hashes,
the active estimate and its complete pricing snapshot in one project file.
There is no separate Save calculator button. Recalculation, navigation, import
and report downloads never save. Before saving, all three calculator input sets
are materialized, including unopened calculators, without replacing open edits.
Reset Calc restores the application examples/defaults as a draft and requires
Save Project to persist.

Save Project opens a native Save As dialog with a quote-derived `Quote name.json`
filename and automatic `.json` extension. Earlier `.ceasefire-project.json`
filenames remain supported. The Windows dialog uses foreground window ownership
and raises the actual dialog and overwrite prompts; native helper compilation
was checked, but visual foreground verification remains a manual check after a
desktop automation initialization failure.

Saved projects lists complete files in the linked estimates folder and its
subfolders, with relative paths, search, sort and pagination. Large scans continue
in bounded batches with cached metadata and visible progress; full project
validation still occurs when opening a file. Load Project can also open a
received file. The persistent Current project area shows filename, known path,
last save and whether any calculator or estimate has unsaved changes.
Validation finishes before any calculator or
estimate draft is replaced. A future incompatible source hash is rejected
instead of silently changing the interpretation of saved inputs. The older
estimate-only section is removed from the UI; its records remain in SQLite.
Historical separate calculator saves remain compatible initial state for an
unopened calculator; new project saves use the combined file workflow. The
shared pricing library is separate from project pricing and is not overwritten
when a project is loaded.

Only source input/setting anchors can be edited. Database and calculated cells
are read-only. Clearing a source input produces a real blank. Formula-backed
settings retain the source formula when untouched. Values display two decimals
at rest, while numeric editing retains full precision. This is necessary for
small yields, tolerances and rounding-sensitive inputs; display formatting must
not change a workbook calculation.

Export XLSX Template produces a values-only `.xlsx` with the exact editable schedule
columns and an Instructions sheet containing reference choices. Duct templates
have eight input columns, board 24 (including advanced inputs), and vermiculite
13 including Location first. Every template has 1,000 prepared rows and omits
Line; physical row order supplies generated line numbers during import.
Templates are blank, not exports of the current estimate. Import replaces the
entire schedule, clearing any remaining previous rows, while preserving other
calculator inputs and settings. Source rows, including hidden/filtered rows, keep
their order. The file must use supported template headers and fit the 1,000-row
application capacity. Previous templates with Line and the original legacy
source layouts remain importable; dependent dropdowns in new exports use the
shifted input-column positions.

Import rejects formula/macro/external-link workbooks, invalid or duplicate
headers/cells, malformed archives and nonfinite/out-of-range numbers. The existing
5 MB limit and bounded ZIP validation are reused. Imported content is a draft;
rates or quoted prices are not altered by a schedule import. Pricing library
import remains its separate reviewed whole-library replacement workflow.

## Independent Excel verification

Committed fixtures in `tests/fixtures/calculators` come from Microsoft Excel
16.0 build 20326 recalculating disposable copies of the original XLSX workbooks.
Links, events and macros were disabled; each copy was rebuilt fully and closed
without saving. No application-generated expected result is used. The manifest
checks both native capture bytes and compressed fixture hashes, source hashes,
Excel provenance and complete output counts.

- Default captures contain every one of the 161,566 original formulas.
- A separate capture checks 300 approved duct fixing-guide outputs.
- 21 varied scenarios contain 3,471 schedule cases and 258,039 formula outputs.
- Variations cover all listed steel selections, all editable settings, stock and
  product choices, normal/zero/blank/decimal inputs, boundary factors and periods,
  manual overrides, invalid-input statuses and rounding-sensitive quantities.

Text, booleans and errors compare exactly. Numbers compare with relative
tolerance 1e-12 and absolute tolerance 1e-10, allowing only insignificant binary
floating-point differences. Whole purchasing quantities remain integral. This
is extensive regression evidence, not a mathematical proof of every possible
input combination or an independent certification of the workbook's fire design.

Developer regeneration tools are `scripts/import_calculators.py`,
`scripts/prepare_calculator_scenarios.py` and
`scripts/capture_calculator_oracle.ps1`. Native capture needs Windows, Microsoft
Excel and PowerShell 7. Normal runtime and fixture tests need neither Excel nor
the original files. `ESTIMATOR_CALCULATOR_SOURCE_DIR` can locate originals for optional
fresh source-reconstruction checks; see the test's documented default directory.

## Australian technical documents

`data/calculator_documents.json` contains 41 section entries linking 35 unique
official Australian manufacturer/distributor URLs, checked on 2026-09-13.
Entries distinguish installation manuals, PDS, SDS and report/request routes.
An unavailable exact assessment/report is labelled as a manufacturer request,
not presented as a public report or replaced with another product's approval.
These links support review; they do not overwrite workbook constants or select a
design automatically. For example, different MONOKOTE bag masses in public
documents do not silently replace the workbook's calibrated estimating yield.
