# PROMATECT 100 / 250 board assessment

The application thickness authority is BRANZ **FC15555-01-03**, issued **13 August
2025**, 70 pages, SHA-256
`e2b47d71893d5837625a4280aca6ee7939c6c23bf53018e954e54ba32894128e`.
The manufacturer URL supplied for revision -02 currently returns revision -03:
<https://media.promat.com/cert_371265_au/original/2114005927/promatect-250--100-as4100-final-fc15555-01-02.pdf?brand=promatconstruction&market=au>.

`data/promat_board_fc15555_01_03.json` contains the numerical values and explicit
unavailable cells from Tables 5–23: 19 tables, 1,045 section-factor rows and 5,225
cells. It is bound to a reviewed digest in `promat_board_assessment.py`. Original
compressed workbook models, source identities and native Excel captures remain
unchanged; the application engine replaces only the older PROMATECT selection.

## Conservative selection

- Section factor is calculated at full precision. Select the next published
  factor at or above it; values below 30 use the minimum 30 row (§3.11).
- Select the next published period at or above the required period: 30, 60, 90,
  120 or 180 minutes. No period above 180 is resolved.
- Select the next lower published temperature, as §3.11 permits a table at one
  temperature for a higher critical temperature. The application retains the
  assessed 350–700°C range.
- Four-sided beams use the four-sided column tables (§3.11). Three-sided beams
  use the beam tables. Three-sided columns and one/two-sided arrangements remain
  for project review, without an automatic thickness.
- Tables include hollow and re-entrant sections (§§3.8–3.9). The retained circular
  geometry rule covers four-sided exposure; partial circular exposure is held.
- A blank table cell stays unavailable. No interpolation across blanks,
  extrapolation, temperature default or stock preference can extend its scope.

## Stock and geometry

PROMATECT 250 uses 30 mm stock. PROMATECT 100 uses 15 and 20 mm stock: 15, 20,
15+15, 20+15 or 20+20 mm. For two different thicknesses, the thicker board is the
inner layer (§3.3.1). The report describes single and double layers and its test
window is 10–45 mm (§3.10). A 45 mm required result therefore remains visible as
an assessment requirement but does not authorise three 15 mm layers. A 31–45 mm
required P250 result does not authorise 60 mm from two 30 mm boards. Unsupported
stock/preference combinations produce no board-order quantities.
The same stock restrictions apply to manual Extra Boards allowances: historical
unsupported values remain stored and visible for review, with quantities withheld.

Board purchasing uses the rectangular enclosure around all section families,
including circular steel. Heated perimeter for thickness selection is a separate
quantity: CHS uses its circumference; other section families use the selected box
orientation. Cutting areas include the butt-joint lap widths of each board layer,
with outer layers surrounding inner layers. Soldiers, stiffeners, cover strips
and other supports must be added separately. The clearly labelled Net Steel sqm
reference remains the physical exposed steel-profile quantity, counted once per
used stock thickness and multiplied by member quantity and length.

New Steel ID choices omit product-tagged `[P100]` identities. Saved identities
continue to resolve unchanged. An untagged CHS alias may use an exact archived
CHS geometry record only when that exact untagged designation is absent; existing
untagged catalogue IDs always take precedence. Nominal dimensions or wall/mass
values are never rounded to guess an alias.

## Integration and validation

`PromatBoardEngine(model, inputs, formula_overrides)` is the shared worksheet,
summary, PDF and XLSX evaluation path. `promat_result(row)` supplies the report
requirement, stock layers, source/table/pages, selected axes and unresolved reason.
`required_missing_by_row` is set before evaluation for newly edited rows; missing
required inputs prevent automatic thickness and purchasing. Historical omitted
Quantity inputs retain a factor of one. Explicit blank Quantity is incomplete.

Focused tests independently check published source cells, blank/window limits,
stock holds, four-sided beam table selection, CHS geometry/legacy identity,
20+15 purchasing groups, Quantity, physical steel reference separation and the
unchanged non-Promat native Excel oracle. Existing raw workbook parity tests
continue to validate the immutable historical formulas.
