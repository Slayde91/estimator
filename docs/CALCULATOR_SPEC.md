# Calculator source contract

The supplied `Quote.xlsm` Calculator is the pricing specification. Its SHA-256 is
`97fd43c4e55d3744e4348bf3596a3ab2a67357f12891524bfdb115f43b45c1a0`.
The source workbook was inspected without saving it or executing its macros.
Inventory import and lookup lineage are described in [WORKBOOK_MAPPING.md](WORKBOOK_MAPPING.md).

## Source structure and input boundaries

The workbook contains five visible sheets: Lists, Calculator, Notes, Steel, and
Duct. Calculator rows 60 through 122 are hidden; most price calculations live
there. The sheet is protected. Its unlocked nonempty cells identify its saved
editable fields. Calculated cells are locked. The 14 real validation rules are
stored in the OOXML `x14:dataValidations` extension; openpyxl's regular validation
collection omits these rules.

| Cells | Input or result |
| --- | --- |
| B2:B7 | Hire, access freight, hire quantity, material freight, accommodation, travel |
| B8:B10 | Project area/items, masking percentage, masking type |
| B12 | Estimator notes, default `Allowances` |
| D2:D10 | Labour rate choices for spray, mesh, primer, topcoat, access panels, masking, fan enclosure, board, mastic |
| B15:E23 | Coverage, daily output, material choice, wastage for nine material lines |
| F16:F17, F19:F23 | Calculated material yields, read from Lists |
| B26:B28 | Material adjustment, labour adjustment, fixed quote adjustment |
| E26:F28 | Extra labour selection/quantity, mobilisation selection/quantity, administration selection/quantity |
| F2:F8 | Labour, material, access, travel, subtotal, grand total, price per project area/item |
| F10 | Total days including masking, extra days and mobilisation allowance |
| B30 | Generated notes and rounded purchasing quantities |

The Estimator presents D7 as **Masking/Cleaning labour**. When D7 is `N/A`, the
Masking/Cleaning percentage and type card is hidden; selecting an active labour
rate shows it again. This is presentation logic over the unchanged workbook
field and formulas.

The saved Calculator has all nine coverage inputs at zero; B8 is 30; B9 is 30%;
all adjustments are zero; extra days are zero; mobilisation and administration
quantities are one. Spray and masking labour use `1 Team - 1x`. Other task labour
selections are `N/A`. Access and travel selections are `N/A`, and hire quantity is
one. These defaults give labour/grand total **1260**, rate **42**, and total days
**0.5**. They are source defaults, not an empty zero-price quote.

| Line | Row | Saved material | Daily output | Wastage | Yield |
| --- | --- | --- | ---: | ---: | ---: |
| Spray/wrap | 15 | Promat Cafco 300 | 30 | 20% | not used |
| Mesh | 16 | Mesh (30SQM Roll) | 1.5 | 15% | 30 |
| Pins | 17 | Box of pins/clips (1000) | 45 | 5% | 40 |
| Access panels | 18 | Promasil 1100 Access Panels | 10 | 0% | not used |
| Fan enclosure mesh | 19 | Promat Promamesh | 2 | 10% | 2.4 |
| Primer | 20 | Luxepoxy 4 (4L- 50μm) Primer | 1 | 60% | 34.4 |
| Topcoat | 21 | Luxathane SPX (20L- 50μm) Topcoat | 1 | 60% | 208 |
| Board | 22 | Promasil-1100 Super - 1250x600x60mm | 1.5 | 15% | 0.75 |
| Mastic | 23 | TBA Firefly Intumastic 600ml | 48 | 20% | 10 |

Product labels in the checked-in baseline retain the source's actual characters,
including any existing replacement characters and trailing spaces.

## Exact calculation rules

These rules describe the source's actual formulas, including surprising behaviour.
They are not corrected commercial assumptions.

1. For spray and panels, base units are coverage × (1 + material adjustment).
   Other lines divide coverage by the selected yield first. Wastage multiplies
   the adjusted base units. The total units remain fractional when priced.
   For example, B63 = B15 × (1 + B26), C63 = B63 × E15,
   D63 = B63 + C63, and F63 = lookup price × D63.
2. Labour days are total material units / daily output × (1 + labour adjustment).
   Thus material adjustment also changes labour, masking, hire and accommodation.
   B35:B43 calculate days. B37 copies B36: pinning has no separate labour charge,
   and C17 does not affect the result. B44 excludes B37 to avoid counting it twice.
3. Masking days B53 = spray days B35 × B9. Masking labour B51 uses the selected
   daily labour rate. Masking material rate B52 already includes (1 + B26).
   B57 then adds another B26 adjustment on masking material cost. B56 is blank;
   there is no separate masking labour markup formula there. These effects must
   not be simplified to a single percentage applied to the final quote.
4. Mobilisation quantity C112 = F27 × (1 + B27). Administration quantity C113
   equals F28 without that adjustment. Material freight quantity C114 and travel
   quantity C117 equal F27. Access freight quantity C115 = F27 × B4.
5. Extra days C119 = F26 × (1 + B27). Total days F10 = B44 + B53 + C119
   + 0.5 × C112. Accommodation quantity C118 equals F10. Hire quantity C116
   = (F10 / 5) × B4. The B2 label says daily hire, but its actual Lists filter
   selects **weekly hire rates** and the calculation uses weeks.
6. F2 sums task labour, mobilisation, administration, extra days and masking
   labour. F3 sums task materials, material freight and masking material cost.
   F4 sums access freight and hire. F5 sums travel and accommodation.
   F6 = SUM(F2:F5), F7 = F6 + B28, F8 = F7 / B8.
   The second total path D26 = D120 + F107 + B58, D27 = B28,
   D28 = D26 + D27 must agree with F7 for valid numeric inputs.
7. Monetary number formats display two decimal places. The numeric price and
   total formulas contain no ROUND. Rounding intermediate prices to cents changes
   the source's results. B30 alone uses ROUNDUP(units, 0) for purchasing notes;
   those rounded counts do not feed priced quantities.
8. Missing selections, zero divisors and text yields retain Excel error behaviour.
   `N/A` is an actual zero-price option in several lists, not a universal bypass.
   Cached empty text in yield arrays is different from a genuinely blank cell:
   VLOOKUP may return `""`, producing `#VALUE!` when used as a divisor.
   A true blank lookup result becomes numeric zero and can produce `#DIV/0!`.
   Setting project area B8 to zero affects F8, not the rest of the quote totals.

## What the workbooks do not calculate

Steel and Duct contain collection templates and example dimensions/FRLs but no
formulas. Calculator has no references to those sheets. Notes links external
technical manuals and a Promat calculator. There is no workbook formula mapping
dimensions, substrate, FRL or dry-film thickness to spray/wrap quantity, or proving
a product suitable for a particular fire-resistance application. Coverage/units
must be supplied by the estimator. Workflow names in regression scenarios classify
the requested use; they do not certify the selected product for that use.

Static extraction of `xl/vbaProject.bin` found only one executable VBA procedure:
`Module1.Quoteinfo` selects and copies `A39:L39` and is assigned Ctrl+Q.
ThisWorkbook, Sheet1 and Sheet2 contain attribute declarations; Module2 and Module3
are empty. No VBA calculation or worksheet-change handler was found. The original
workbook also contains hidden XLM-flagged parameter names resolving to `#NAME?`;
they do not supply additional numerical rules in the inspected formulas.

## Independent Excel regression oracle

`scripts/prepare_excel_oracle.py` builds a temporary, macro-free XLSX harness. It
copies **every Calculator formula verbatim**, verifies those formulas after saving,
copies the actual named ranges, and freezes the source's saved Lists cache.
Explicit empty-text caches are represented by `=""` sentinels so Excel retains
their text semantics. It excludes VBA, XLM-flagged placeholder names and external
links. The source files are never overwritten.

`scripts/capture_excel_oracle.ps1` creates its own hidden Excel instance, disables
macros, link updates and events, opens the harness read-only, changes inputs only
in memory, and requests Excel's full recalculation for each scenario. It captures
151 Calculator formula outputs per scenario. It closes only the instance it
created and never saves the workbook. The regression fixture records Excel's
version/build, capture time, source hash, all inputs, lookup overrides and outputs.

This is Excel's calculation engine running extracted source formulas with fixed
lookup values. It does not prove live external workbook refresh, macro execution,
technical-system selection or the original XLSM's open/save behaviour. In this
environment, Excel opened and calculated a generated test XLSX but refused both an
untouched copy and a frozen-Lists copy of the source XLSM. Opening an openpyxl-saved
XLSX retaining the XLM-flagged names reported macro-enabled content. The fresh
formula harness avoids that source packaging problem without changing Calculator
formulas. Source XML caches provide an additional independent check of its default
results.

To regenerate on Windows with desktop Excel and Python/openpyxl installed:

```powershell
python scripts/prepare_excel_oracle.py --source ..\Quote.xlsm --output ..\.workbook-audit
pwsh -File scripts/capture_excel_oracle.ps1 -PlanPath ..\.workbook-audit\oracle-plan.json -OutputPath tests\fixtures\excel-calculator-oracle.json
```

These are development-only verification tools. The application does not open
Excel, use COM, require openpyxl, or read either source workbook at runtime.
