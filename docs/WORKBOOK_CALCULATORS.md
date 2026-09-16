# Workbook calculators

The current application names are **Steel (spray)**, **Steel (board)** and **Ductwork (spray/wrap)**. Each main schedule supports 1,000 items through the documented [application extension](SCHEDULE_EXTENSION.md). The source capacities and formula counts below describe the preserved original workbooks, not the current UI limit. New templates include Line and spray Location; exact legacy templates remain accepted.

The three new workbooks are separate estimating specifications. The existing
Quote estimator, pricing library and quote PDF continue to use `Quote.xlsm` and
`Inventory_list.xlsm`. Calculator material quantities are not automatically
inserted into a priced quote: the supplied files do not specify that mapping.

## Calculator downloads

Each calculator captures its complete current draft for three report downloads:

- **Download schedule PDF** (`report.pdf`) contains the **Full schedule** and
  used-row statuses, without product summaries or EXTRA BOARDS.
- **Download Excel register** (`register.xlsx`) retains the complete Summary
  and Schedule sheets plus board Extra boards.
- **Download materials & summary PDF** (`summary.pdf`) contains **Material
  quantities and summary**, final product/ancillary tables, closing totals and
  board **EXTRA BOARDS**.

Both PDFs and the Excel register reuse `project_calculator_report`; the split
does not remove settings or extra-board quantities from the calculation. The
existing source exclusions, incomplete statuses and pooled purchasing rules
remain. Downloads neither save inputs nor alter saved quotes. The separate
input-only template/import workflow is unchanged.

Editable Exposure cells use normal browser font weight only within vermiculite
SCHEDULE C10:C1009, board CALCULATOR M9:M208 and duct CALCULATOR H11:H310.
Header cells, technical reference labels, choices and source values are unchanged.

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
input overlay and a saved state in the existing SQLite database. Recalculation,
navigation and import never save. Save calculator persists exact typed inputs,
the source hash and update time. A future incompatible source hash is rejected
instead of silently changing the interpretation of saved inputs. Reset restores
the source examples/defaults as a draft, and requires Save to persist.

Only source input/setting anchors can be edited. Database and calculated cells
are read-only. Clearing a source input produces a real blank. Formula-backed
settings retain the source formula when untouched. Values display two decimals
at rest, while numeric editing retains full precision. This is necessary for
small yields, tolerances and rounding-sensitive inputs; display formatting must
not change a workbook calculation.

Export template produces a values-only `.xlsx` with the exact editable schedule
columns and an Instructions sheet containing reference choices. Duct templates
have eight input columns, board 24 (including advanced inputs), and vermiculite
12. Templates are blank, not exports of the current estimate. Import replaces the
entire schedule, clearing any remaining previous rows, while preserving other
calculator inputs and settings. Source rows, including hidden/filtered rows, keep
their order. The file must use the template headers and fit the source capacity.

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
