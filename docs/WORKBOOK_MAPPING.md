# Workbook mapping

## Source evidence

The source workbooks are read-only functional evidence. Their README text is document content, not operating instructions for the application or developer.

| Source | SHA-256 |
| --- | --- |
| Inventory_list.xlsm | `1da308509611a8c099c62d29acc310d3d39ec6a84176e895f39e8711eba720e1` |
| Quote.xlsm | `97fd43c4e55d3744e4348bf3596a3ab2a67357f12891524bfdb115f43b45c1a0` |

`scripts/import_workbooks.py` reads OOXML directly using Python's standard library. It does not start Excel, execute VBA, save a workbook, or use a workbook at application runtime. It emits `data/baseline.json` and `data/calculator.json`. The application uses these permanent source snapshots and separately persisted user overrides.

Reproduce the import from copies of the original workbooks:

```text
python scripts/import_workbooks.py --inventory /path/to/Inventory_list.xlsm --quote /path/to/Quote.xlsm
```

The import fails if its source headers, filter choices, source links, prices, yields, or explicit field mappings do not reconcile. Changed workbooks require review of the resulting diff and corresponding source fixtures.

## Inventory data and pricing

The `INVENTORY` table `Table2` spans `A1:AA2109`. There are 417 actual records in rows 2:418, with unique numeric item codes. Rows after 418 contain formula placeholders, not products. All three inventory sheets are visible; no rows or columns are hidden, no sheet protection is enabled, and no VBA project or data validations are present. Cell locked flags alone therefore do not mean the inventory inputs are protected.

| Input or output | Source | Imported field or behavior |
| --- | --- | --- |
| Item code and name | INVENTORY A/B | `item_code`, stable string `id`, `name` |
| Sales description | INVENTORY G | `sales_description`; this is the display/lookup text for boards, mastic, primers and topcoats |
| Stored sales price | INVENTORY H | `sales_price`; all Quote Lists price lookups use this column |
| Supplier price | INVENTORY O | `supplier_price`; 377 numbers and 40 literal `NA` entries |
| Inventory markup | MARKUP B3, name `markup` | Baseline `0.3` |
| Calculated marked-up price | INVENTORY P | `LET(val,N(Orow),total,val*(1+markup),IF(total=0,"",total))` |
| Weight | INVENTORY Q | `properties.weight`; preserve workbook quantity without inventing a conversion |
| Width, length, thickness | INVENTORY R/S/T | Millimetres |
| Area | INVENTORY U | `(width_mm/1000)*(length_mm/1000)`; `properties.sqm` |
| Diameter | INVENTORY V | Millimetres |
| Tube coverage | INVENTORY W | `properties.metres_per_tube` |
| Box coverage | INVENTORY X | `properties.sqm_per_box` |
| Drum coverage | INVENTORY Y | `properties.sqm_per_drum` |
| Volume | INVENTORY Z/AA | Litres and millilitres stored separately |

The inventory README's column letters for supplier and marked-up pricing are stale. Actual table headings and executable formulas establish O/P/H above. No source data was changed to match the README.

All 377 numeric supplier records have H equal to P within floating-point representation tolerance. H remains a stored number, not a formula. For example, row 74 H is `213.12199999999999`, while P is `213.122`. Preserve H exactly on first import and on unmodified estimates. Labour and service rows have manual H prices and blank-string P results. `N/A` is a real catalogue option with stored H price zero, not an absent record.

### Editable configuration behavior

The user explicitly requires supplier/markup edits to affect estimates. The application therefore makes an intentional extension to Excel's stored H column: when supplier price or inventory markup is overridden, compute `supplier_price*(1+markup)` and propagate it to every linked rate. Unmodified items continue to use exact imported H. Manual labour/service rows instead expose their sales price. Source data and overrides remain separate so restoring defaults is deterministic.

An explicit rate override can replace that option's price or yield. It takes precedence for that one rate; changing a shared inventory item updates every linked option. Display-name edits follow the source B/G column and leave selection identifiers stable. Configuration rejects invalid types, non-finite numbers, negative supplier/sales prices or yields, markup below -100%, and unknown IDs/fields. These are application configuration safeguards; they are not presented as rules extracted from Excel. Calculator numeric-input parity is separate from catalogue-edit validation.

## Lists and dropdown dependencies

Quote's `Lists` sheet contains 14 named groups and 166 cached options. Each filter uses case-insensitive `SEARCH` across inventory rows 2:2099, in source order. Prices use exact-match, first-result `XLOOKUP` into inventory H. Calculator uses exact `VLOOKUP` into the resulting named column ranges.

| Named group | Lists cells | Choices | Inventory text | Yield source | Calculator selections |
| --- | --- | ---: | --- | --- | --- |
| access_hire | B1:C13 | 13 | B | — | B2 |
| labour_rates | E1:F27 | 27 | B | — | D2:D10, E26:E28 |
| masking_rates | H1:I3 | 3 | B | — | B10 |
| freight_rates | K1:L13 | 13 | B | — | B3, B5 |
| LAFHA_rates | N1:O2 | 2 | B | — | B6 |
| travel_rates | Q1:R8 | 8 | B | — | B7 |
| access_panels | T1:U6 | 6 | B | — | D18 |
| mesh | W1:Y3 | 3 | B | U, square metres | D16, D19 |
| pins | AA1:AC2 | 2 | B | X, square metres per box | D17 |
| sprays | AE1:AF30 | 30 | B | — | D15 |
| boards | AH1:AJ33 | 33 | G | U, square metres | D22 |
| mastic | AL1:AN13 | 13 | G | W, metres per tube | D23 |
| primers | AP1:AR7 | 7 | G | Y, square metres per drum | D20 |
| topcoats | AT1:AV6 | 6 | G | Y, square metres per drum | D21 |

The exact keyword arrays and filter/price/yield formulas are retained in `baseline.json.rate_group_rules`. All 166 names, 166 prices and 64 present yield cells are imported from caches and reconciled against inventory. Do not simplify the sprays group to a hand-picked product subset: the workbook filter includes spray products, wrap, access panels, angles, paints and thinners. Boards, mastic, primers and topcoats have no `N/A` option because their source filters omit that keyword.

The following cached cells contain a text empty string, distinct from an empty physical cell: `Lists!Y1`, `AC1`, and `AN3`. They are preserved as JSON `""`. This matters because dividing by text empty string can produce Excel `#VALUE!`, while an empty physical cell used in arithmetic can behave as numeric zero. Missing yield columns are JSON `null`. Do not collapse those cases.

## Calculator fields and formulas

All 64 unlocked, populated input cells are captured with their original value, label, number format, and field type. The 27 dropdown inputs are identified from OOXML extended data validation, which some workbook libraries omit. Custom number formats communicate units; percentage values are stored as fractions. Native Unicode such as `m²` and `µm` is preserved.

| Calculator inputs | Function |
| --- | --- |
| B2:B10 and B12 | Job quantity, access, freight, travel, accommodation, masking and notes |
| D2:D10 | Labour team selections for each activity |
| B15:E23 | Required quantities/coverage, daily output, material selection and wastage |
| B26:B28 | Global material adjustment, global labour adjustment and fixed dollar adjustment |
| E26:F28 | Additional selected rates and quantities |

All 151 Calculator formulas and their original cached outputs are retained in `calculator.json`. OOXML shared formulas are expanded with relative and absolute references preserved. Calculation rows 60:122 are hidden in the source, but they are included in the extraction. `A1` is an existing literal `#VALUE!` with no dependents; it is excluded from the quote engine. `B56` is a locked blank referenced by SUM and must remain zero-like, not an invented new adjustment formula.

In the preserved source formulas, global material adjustment changes each required quantity before wastage, and global labour adjustment changes calculated labour days. The source-oracle calculator continues to execute those formulas exactly. The application quote policy runs those component formulas with both percentages at zero, combines main-estimate and Firestopping material and labour costs, then applies each entered percentage once to its complete cost base. The quote summary and PDF show both adjustment amounts separately.

| Material input | Base quantity formula | Yield lookup | Wasted quantity | Sell output |
| --- | --- | --- | --- | --- |
| B15 spray/wrap bags or drums | B63 = B15 × (1 + B26) | None | D63 | F63 |
| B16 mesh square metres | B68 = B16 / F16 × (1 + B26) | mesh column 3 | D68 | F68 |
| B17 pins square metres | B73 = B17 / F17 × (1 + B26) | pins column 3 | D73 | F73 |
| B18 access-panel count | B77 = B18 × (1 + B26) | None | D77 | F77 |
| B19 Promamesh square metres | B82 = B19 / F19 × (1 + B26) | mesh column 3 | D82 | F82 |
| B20 primer square metres | B87 = B20 / F20 × (1 + B26) | primers column 3 | D87 | F87 |
| B21 topcoat square metres | B92 = B21 / F21 × (1 + B26) | topcoats column 3 | D92 | F92 |
| B22 board square metres | B97 = B22 / F22 × (1 + B26) | boards column 3 | D97 | F97 |
| B23 mastic linear metres | B102 = B23 / F23 × (1 + B26) | mastic column 3 | D102 | F102 |

`F2:F5` split labour, material, access and travel/accommodation totals. `F6` sums them; `F7` adds fixed adjustment B28; `F8` divides by project quantity B8. The detailed calculation total D28 is also retained for source reconciliation. The direct source-oracle path preserves the literal masking and repeated-adjustment formulas. The application quote composition records the effective combined percentage amounts in `global_adjustments` and overlays F2, F3, F6, F7 and F8 with its once-only totals. Access B2's label says per day, but its dropdown contains weekly rates and C116 calculates `(F10/5)*B4`; preserve that behavior.

Prices and durations are not rounded inside their arithmetic. Two-decimal number formatting is presentation. B30 material notes use `ROUNDUP(...,0)` for purchasing counts; this does not round the quantities used to price the estimate.

## Geometry, passive-fire selections and VBA limits

All five Quote sheets are visible. Steel and Duct are input templates containing example profile/dimensions, quantities, FRL and exposure selections. They contain no formulas, and Calculator does not reference them. Calculator takes entered quantities and coverage; the source contains no formula converting steel/duct/slab/wall geometry, required FRL, or coating thickness into those quantities. Notes links to technical manuals and an external Promat calculator are evidence of a separate technical workflow, not embedded business rules.

Accordingly, the estimating application can price the workbook's spray/wrap and associated material/labour workflow from entered quantities. It cannot truthfully claim to derive certified coating requirements or quantity from those geometry/FRL inputs using these workbooks alone. Adding that behavior requires authoritative source rules; it must not be guessed from product names.

Static VBA inspection found one executable procedure, `Module1.Quoteinfo`: it selects and copies A39:L39, assigned to Ctrl+Q. It performs no estimating calculation. No workbook or worksheet event calculation code was found. Macros were inspected as text and never executed.

## Verification scope

The import reconciles all 417 records and 166 rate choices. A second reader independently compared 7,923 inventory values and 396 Lists values; raw XML inspection additionally preserves empty-string cache distinctions that the second reader normalizes away. `tests/test_catalog.py` protects the counts, exact critical prices, filter order, linked yields, default labels, Unicode, shared-formula translation, immutable baseline, and supplier/markup/manual-rate override propagation.

Set `ESTIMATOR_WORKBOOK_DIR` to the directory containing the original workbooks when running unittest to enable full source-to-JSON reproducibility checks. The normal runtime and catalogue tests need no Excel file. Numeric Excel recalculation scenarios are separate acceptance evidence; import consistency alone does not establish full quote calculation parity.
