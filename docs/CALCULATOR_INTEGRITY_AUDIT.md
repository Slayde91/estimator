# Calculator integrity audit

## Current local-source review — 24 September 2026

The strict audit still correctly reports `ductwork` and `steel_board` as
different files from the frozen packages. The current local `steel_vermiculite`
workbook remains an exact match. The strict verdict includes byte identity,
Excel storage and presentation metadata, so a failed verdict does not by itself
mean that an estimating formula changed.

| Workbook | Strict result | Differences that can affect the runtime model | Other differences |
| --- | --- | --- | --- |
| Ductwork | 77,158 changed fields; current SHA-256 `7ad569ad83d66298d7fba3c291a836b6e75cbfbc687c02fc53df837e2e45299b`, frozen SHA-256 `9b2e5388a0118c4b3f66ea57f582d487d156585b45d9f34ebc8178f270ff7462` | No formula-logic differences and no fixed-literal differences. Twenty editable schedule defaults differ. | All 38 formula strings differ only by optional quotes around the simple `CALCULATOR` sheet name. The other 77,100 fields are source identity, styles, caches, shared-formula attributes, data types or workbook metadata. |
| Steel board | 188,521 changed fields; current SHA-256 `d74b970b701233a76162228b5edb81873f87920ca75bd696539a0ffe4f942b8e`, frozen SHA-256 `934e951e4255976a7d3fea64f77b0b0a7f1852174fecb126e76a640f0a38546d` | No formula-logic, fixed-literal or editable-default differences. | All 307 formula strings differ only by optional quotes around simple sheet names. The remaining changes are raw XML whitespace, source identity, styles, caches, shared-formula attributes, data types or workbook metadata. |

The 20 ductwork defaults are confined to editable cells `B13:I15`. Row 13
changes the example size from `250x250` to `500x500`, changes the G flag from
`1` to `0`, and changes Application/Orientation from `Internal`/`Mixed` to
`Both`/`Horizontal`. Rows 14 and 15 are newly populated `500x500` FyreWrap
examples with length 10 and FRL `120/120/120`. Their F/G flags are `1/0` and
`0/0`; their Application/Orientation choices are `Stair pressurisation`/
`Horizontal` and `Internal`/`Mixed`. These are sample starting inputs, not
calculation formulas.

The running Estimator loads the frozen `data/calculators/*.json.gz` models and
then applies the separately approved runtime policies. It does not read these
three local XLSX files during normal use. The current local differences therefore
do not stop projects, libraries, calculations, reports or saves from working.
They matter only if a current local workbook is proposed as a new authoritative
source package: the changed sample defaults would then need an explicit product
decision, a controlled reimport and renewed native Excel parity evidence.

The audit now reports an `impact_counts` section. It separates changed formula
logic, fixed literals and editable defaults from optional sheet-name quoting,
raw source-string storage and representation/provenance differences. This makes
the concern visible without weakening the exact source-identity failure or
silently accepting a changed workbook.

## 17 September 2026 review

The calculation-integrity investigation found no changed calculation logic in
the current source workbooks. The app's frozen source packages and runtime
formulas were not replaced or edited. The current board workbook is a different
Excel file from the preserved original, but the differences were fully inspected
and fresh native Microsoft Excel results match the application.

## Evidence and coverage

- Ductwork and steel spray reconstruct their packaged catalogs exactly, including
  source fingerprints, every cell, formula, literal, cache and extracted metadata.
- The preserved original board XLSX has SHA-256
  `934e951e4255976a7d3fea64f77b0b0a7f1852174fecb126e76a640f0a38546d`,
  exactly the source identity recorded by the board package and native fixtures.
- The current board XLSX has SHA-256
  `d74b970b701233a76162228b5edb81873f87920ca75bd696539a0ffe4f942b8e`.
  This file was not substituted for the preserved source.
- Both original-workbook regression tests completed successfully against
  byte-verified copies of all three original workbooks. Together with the catalog
  and new audit tests, 25 tests passed with no skips.
- An independent reader, without imports from the application's workbook reader,
  checked all 161,566 formulas and 289,861 populated literals. It independently
  expanded all 37,608 shared-formula followers using openpyxl's Translator.
- The original shared-formula boundary test also passed against the current
  workbooks, unchanged and without a skip.
- Microsoft Excel 16.0 build 20326 recalculated a disposable copy of the current
  board workbook with links, macros and events disabled. All 116,388 captured
  results across 11 scenarios matched the application: 16,534 default results
  plus 99,854 varied results. These cover steel catalogue selections, advanced
  choices, boundaries, stock, all editable settings, zero waste, rounding and
  manual geometry.
- Numbers use the existing native-oracle tolerances (absolute `1e-10`, relative
  `1e-12`); text, errors and types compare exactly. This is extensive measured
  coverage, not a claim to test every possible input combination.

## What changed in the current board file

The strict comparison found 188,521 differing stored fields. That count is not
a count of changed calculation rules.

| Evidence | Finding |
| --- | --- |
| Formula text | 16,227 of 16,534 strings match exactly. All remaining 307 differ only in redundant single quotes around simple worksheet names. Every other reference, function, operator and literal is identical. Both independent token comparison and parsed-expression comparison confirm this. |
| Literal values | All 48,025 populated board literals match, including numbers, text, blanks and zero. |
| Raw string storage | 1,081 raw `t=str` values lost leading/trailing XML whitespace. The frozen package already retains and normalizes this provenance according to verified native Excel loading behavior. Runtime values match. |
| Names and tables | Defined names, table calculation ranges and table columns match. |
| Validation | Effective rules match after grouping equivalent range declarations and default flags. No changed limits or permitted choices were found. |
| Calculation settings and protection | The only new calculation attribute is Excel's `calcId`. No precision, iteration or calculation-mode behavior changed. Workbook/worksheet protection and hidden row/column records match. |
| Empty records | 17,241 removed cell records contain no value or formula. |
| Cached formula answers | 7,701 caches were added; 14 numeric caches became the same numeric text. The application calculates formulas and does not use these caches as answers. |
| Presentation and encoding | Styles, shared-formula storage, metadata ordering, blank extents and the SETTINGS sheet's visibility differ. The app retains the preserved original package. |

The changed formula locations are `CALCULATOR!AI9:AI208`,
`BOARD SUMMARY!A8`, `BOARD SUMMARY!E12:E29`, `BOARD SUMMARY!H12:H29`,
`EXTRA BOARDS!L6:L45`, and `BOARD SYSTEMS!H6:H35`.
For example, `'CALCULATOR'!$AL$9:$AL$208` became
`CALCULATOR!$AL$9:$AL$208`; its references and calculation are unchanged.

## Verification improvement

The previous source test compared huge dictionaries using unittest's automatic
failure diff. Once a file differed, formatting that diff consumed excessive
time and memory and obscured the actual findings.

`scripts/check_calculator_integrity.py` now compares every extracted field and
reports category totals, exact JSON Pointer paths and bounded examples. Only
diagnostic output is capped. Formula changes, caches, values, styles, ordering,
types and source fingerprints all remain part of the strict verdict. File
fingerprints are checked before and after reading. Nothing is reimported,
rewritten or automatically accepted.

```powershell
python scripts/check_calculator_integrity.py --source-directory "PATH TO SOURCES"
python scripts/check_calculator_integrity.py --source steel_board="PATH TO BOARD.xlsx"
```

JSON is written to stdout and progress to stderr. Exit zero requires all three
workbooks to match exactly; missing files, read errors, changed fingerprints or
any difference return nonzero. Preserve original filenames when auditing exact
copies, because filenames are part of the recorded provenance.

The current board file correctly still returns a **strict file/catalog mismatch**.
That is a completed identity check with the differences explained above, not an
unresolved calculation comparison. The original-source comparison passes. No
hash whitelist, ignored differences, changed baseline, reimport or calculator
formula fix was introduced to make a check pass.

## Preservation boundary

All source XLSX files, the preserved original board copy, packaged catalogs,
calculation engine, native fixtures, saved project data and live database were
left unchanged. Existing approved runtime exceptions and schedule extensions
remain documented in [CALCULATOR_EXCEPTIONS.md](CALCULATOR_EXCEPTIONS.md) and
[SCHEDULE_EXTENSION.md](SCHEDULE_EXTENSION.md).
