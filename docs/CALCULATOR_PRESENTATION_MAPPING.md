# Calculator presentation mapping

Date: 2026-09-15. This is a source-backed presentation and reporting map, not a new calculation specification. Source cell addresses below are developer traceability keys; user labels use the workbook's meaningful headings. Source packages, formulas and original workbooks remain unchanged. The separately authorized reviewed material defaults populate existing editable inputs; their boundary is recorded below and in [CALCULATOR_EXCEPTIONS.md](CALCULATOR_EXCEPTIONS.md).

## Evidence and implementation boundary

The audit read the three immutable `data/calculators/*.json.gz` models, including literal cells, formulas, styles, merged ranges, source column dimensions, validation and field metadata. Their hashes are recorded in `data/calculators/index.json`. The detailed local audit is `.runtime/calculators-audit/presentation/source-audit.json`, with one source-cell TSV per page. Formula caches were used only to distinguish original demonstration rows from empty prepared rows; they must never supply runtime answers.

The existing architecture is a shared workbook evaluator, HTTP projection and browser worksheet renderer. The proposed change is a presentation projection of those same evaluated cells into labelled forms, compact note blocks and complete tables. It removes the 25-row paging interaction and spreadsheet spacing without introducing business arithmetic, databases or a second estimator. Saved inputs keep their existing worksheet/cell keys and source hash. No data migration is needed.

The new `POST /api/calculators/<id>/worksheet` projection returns every source-page row, `visible_columns`, shared `option_sets`, cell `options_ref` and semantic `presentation` hints. The older bounded `calculate` endpoint remains compatible. UI grouping should consume these evaluated values and current validation choices; it should not recalculate them or derive technical status from colours.

Source `section_cells` metadata supplies stable contents links and distinct
colour themes in source order. Vermiculite SETTINGS has eleven targets: its
eight numbered sections and three factor-helper sections. Its banner reads
Product Settings and Rules. A form's populated-cell structure
participates in its refresh signature so newly available output/source notes
appear without switching pages. Schedule controls remain in place for ordinary
value updates.

## Shared presentation rules

1. Keep all twelve page names. Show each selected worksheet as one page, with every prepared input row reachable by normal scrolling; do not split it into 25-row pages.
2. Separate introductory merged notes from tabular data. Render a merged heading/note once from its anchor, with natural wrapping. Do not create a tall table row for every merged child or preserve the workbook's print-oriented row heights.
3. Collapse rows and trailing columns that contain only decorative spacing. Keep every schedule and EXTRA BOARDS input row, even when its current result is blank. A formula returning `""` is not evidence that an input row is disposable.
4. Present normal inputs, advanced inputs and calculated outputs as visibly distinct groups. Use one output highlight for populated values and one for blanks; zero, error text and other nonblank results are populated. These colours indicate value presence only. Keep exact dependency-driven dropdowns and current read-only/write-validation rules; colour never grants edit permission or technical approval.
5. On forms, use a two-column field layout on desktop and one column on a phone. Put units beside the value and source explanations below the field. Long status and basis text must wrap without truncation.
6. On schedules, use one sticky header and sticky item identifier. Keep horizontal scrolling inside the table, with input widths suited to their contents. The page itself must fit a 390-pixel viewport. Numeric cells need roughly 110–130 px; product/section choices 190–260 px; status and detailed notes 300–420 px. These are UI recommendations, not source business constants.
7. Display numbers to two decimals at rest and retain the exact raw value. Focused numeric controls and choices must distinguish small values such as 0.005, 0.01 and 1e-8. Never write a rounded display value merely because a field was focused or blurred.
8. Retain all source qualification text and error/withheld states in the source graph and calculation results. The explicit browser omissions below do not alter those states or the PDF mapping. `NP`, an empty result and zero mean different things. Do not turn a missing quantity into zero or describe a displayed quantity as installation approval.
9. Keep numeric Settings inputs, units, read-only calculation basis and live outputs. Omit the requested date/source-ID/document-name metadata and separate reviewed-yield action/panel from Settings presentation. Developer evidence retains full provenance. Do not expose hidden reference databases as new editable settings.

## Source extents and spacing

“Blank rows” here means no nonempty literal and no formula anywhere inside the packaged page range; styling alone is ignored. Counts include hidden columns, so the vermiculite Settings value is not a measure of its visible empty space. Source dimensions remain useful for API coverage even when the UI removes decorative gaps.

| Calculator / page | Packaged range | Blank rows | Merged ranges | Last row with visible content |
| --- | --- | ---: | ---: | ---: |
| Vermiculite / CALCULATOR | A1:N41 | 15 | 52 | 40 |
| Vermiculite / SCHEDULE | A1:Y1009 | 3 | 12 | 1009 |
| Vermiculite / BAGS | A1:N29 | 10 | 24 | 27 |
| Vermiculite / SETTINGS | A1:BM558 | 2 | 626 | 373 |
| Ductwork / CALCULATOR | A1:CL310 | 4 | 9 | 310 |
| Ductwork / SUMMARY | A1:L45 | 18 | 10 | 43 |
| Ductwork / PRODUCT SETTINGS | A1:Q160 | 11 | 142 | 159 |
| Board / START | A1:L100 | 69 | 45 | 39 |
| Board / CALCULATOR | A1:AI208 | 1 | 20 | 208 |
| Board / BOARD SUMMARY | A1:L38 | 12 | 11 | 35 |
| Board / EXTRA BOARDS | A1:N45 | 2 | 2 | 45 |
| Board / SETTINGS | A1:Q51 | 2 | 2 | 51 |

The source-only spacer rows are:

- Vermiculite CALCULATOR: 2, 4, 19, 21–22, 24–25, 27, 31–32, 34, 36–37, 39, 41. SCHEDULE: 2, 6–7. BAGS: 2, 4–5, 15–16, 18, 25–26, 28–29.
- Ductwork CALCULATOR: 2, 4, 7–8. SUMMARY: 2–3, 5–7, 12–13, 15–16, 27–28, 33–34, 36–37, 42, 44–45. PRODUCT SETTINGS: 2, 5, 40, 47, 80, 84, 93, 135, 151–152, 160.
- Board START: 2, 4, 7, 14, 20, 24, 29, 33, 40–100. CALCULATOR: 3. BOARD SUMMARY: 2, 4, 7, 9–10, 30, 32–34, 36–38. EXTRA BOARDS and SETTINGS: 2, 4.

Vermiculite SETTINGS hides M:AM, BB:BD and BF:BM. Its nominally unhidden AN:BA and BE columns contain no literals or formulas. Normal presentation therefore needs only A:L; rows 374–558 contribute hidden reference records, not visible Settings controls. Preserve those records in the engine/package while avoiding an empty 65-column page.

## Actual source style roles

Style numbers are local to each workbook, not global role identifiers. Font/fill values below are original ARGB values. Use their meaning with Ceasefire's existing branding rather than copying every workbook colour.

| Workbook | Source evidence | Presentation meaning |
| --- | --- | --- |
| Vermiculite | CALCULATOR D6:D17 styles 34–36; SCHEDULE input styles 4–6; font `FF165BA8`, fill `FFEAF2FF` | Editable estimating inputs |
| Vermiculite | SETTINGS styles 61/62/67–69; font `FF1768AC`, fill `FFE9F1FD`, unlocked; helper styles 75/77/78 also blue/unlocked | Editable settings and helpers, including formula-backed direct yields |
| Vermiculite | Results use light green `FFE8F3EC`, sometimes bold dark green `FF164A2B`; section/label blocks use white text over `FF252A32` | Readonly outputs and clear group headings |
| Ductwork | CALCULATOR input styles 37/46/126/128/130/140; font `FF1668BC`, fill `FFEAF3FC` | Editable schedule fields |
| Ductwork | Settings styles 93/97 blue; calibration style 136 blue font `FF0070C0` without a coloured fill; yield selectors style 139 blue | All eleven allowed Settings inputs, including those without shading |
| Ductwork | Output styles use fill `FFEDF7F5`; summary headers use bold white over `FF147D78` or `FF202B34` | Readonly results and table headers |
| Board | Schedule input blue fonts/fills; EXTRA BOARDS styles 4/5/13 use font `FF1763A5`, fill `FFEAF3FC` | Editable schedule/allowance inputs |
| Board | Main results use font `FF047857`, fill `FFECFDF5`; result headers distinguish calculation columns | Calculated board quantities |
| Board | SETTINGS B10 is blue style 5, while the other 27 allowed settings use black styles 2/424 | User-authorized editable Settings; never infer this allowlist solely from blue shading |
| Board | START dark green `FF075C49` section banners; other headings use white over `FF17212B` | Heading/note structure, not editable values |

Most editable cells on the unprotected workbooks still have `locked=True`; only the protected vermiculite Settings sheet provides meaningful unlocked flags. Do not replace the existing explicit input allowlists with a `locked` or font-colour heuristic.

## Structural Steel (vermiculite)

### CALCULATOR

Use two adjacent cards rather than a fourteen-column spreadsheet: “Inputs” from A5/D6:D17 and “Thickness and quantities” from H5:N23. Keep seven selection/factor fields D6:D12 together, then quantity/geometry D14:D17. The empty D11, D16 and D17 inputs remain usable.

The output card contains published thickness H6, lookup status H9, ESA/M K12, Hp/A K13, usable estimating thickness K14, girth K15, spray area K16, coating volume K17, net bags K18, quantity status H20 and source H23. Preserve the distinction between published and usable estimating thickness. The later user instruction removes the third notes section below the comparison matrix from browser presentation only.

The “All published periods for this input” section starts at A26. A28:A30 supplies
the row labels and B28:I30 supplies eight period/thickness/status columns. The
implemented matrix gives those eight period columns equal independent widths;
G28:G30 is the 120-minute column, not a merge. Inheriting the narrow form spacer G
caused its malformed appearance. The merged J28:N30 comparison narrative and
the third notes section at rows 33–41 are omitted from browser presentation,
with their values retained in the source model. On phones the form stacks while this matrix retains
aligned columns in its own horizontal scroller.

Source widths: labels occupy merged A:C; inputs D:F; G is a 3-unit spacer. Results H:N use merged label/value regions. These merged groups support cards directly; multiplying each source column into a minimum-width web column creates excessive empty width.

### SCHEDULE

The top labels at rows 1, 2, 3 and 8 are omitted from the browser. Summary cards
A4/A5, G4/G5 and S4/S5 remain visible. The earlier removed
thickness/scope-block card M4/M5 is still calculated internally. The only schedule
header is row 9. Show all 1,000 rows 10–1009 together. A:L are inputs, M:Y source outputs;
hidden Z is the stable line ID and remains readonly/internal.

Below the cards, Running material totals lists each BAGS A20:A24 product, E20:E24
net bags, G20:G24 pooled whole bags and I20:I24 order status. The worksheet API
supplies these as `product_totals`; the UI never derives them by summing rounded
line quantities. Blank/withheld whole-bag values remain blank beside their
status. Updating these totals does not rebuild the schedule controls.

Input groups: A item; B:F product/case/temperature/method/section; G:H factor/period; I:L quantity/length/girth/area. Output groups: M:N lookup factors; O:P published/usable thickness; Q:U geometry/volume/bags. Source V/W/X status/source columns are explicitly hidden in this worksheet view, including advanced presentation; Y notes remain wide and wrapped. V/W/X stay in API/source results and the existing report projection. In particular, W continues to gate incomplete purchasing totals. Source width emphasis remains B25/C29/F22, compact numeric I9 and J:Q12, status V:W31, source X26 and notes Y64; these source widths do not require hidden columns to be displayed.

All prepared rows remain present even though 999 original example slots return blank formulas. The original workbook has one active example, not 1,000 completed estimates.

### BAGS

Create a “Manual material quantity” form from D6:D8, with live results D9:D14. Keep the source limitations H6 and H11 adjacent. This manual calculation is independent of the SCHEDULE order summary.

Below it, render the “Product order summary” heading A17, row 19 headers and five product rows A20:I24. Do not turn it into another 29-row spreadsheet. Keep order status I and incomplete count H visible even when whole bags G are blank. Notes A27 follow the table.

The implemented phone view stacks manual inputs/results in one form and leaves
the product-order matrix in a separate real table with its own horizontal scroll.
The later compact layout sizes the nine A:I order columns at
19/7/9/10/8/7/11/9/20 percent, reserving 20 percent for wrapped order status.
Blank J:N columns are omitted. All five product rows and quantities remain present,
and the manual form fits the available page width.
Each editable source field is rendered once.

Source table widths indicate product A29, normal numerical columns 12–16 units, whole bags G21 and order status I35. Use a readable sticky product column with wrapped order-status text.

### SETTINGS

Use a short section index that scrolls within the single page. Group source rows as follows:

| Group | Heading / extent | Editable cells | Required adjacent readonly material |
| --- | --- | --- | --- |
| Global settings | A9; rows 10–15 | D10:D14 | Comparison tolerance D15 |
| Common calculation rules | A17; rows 19–27 | None | Lookup, thickness holds, yield, orders and project-design explanations |
| CAFCO 300 | A31; rows 32–58 | D36:D39 | Read-only basis D42; yield/status 40–41, scope/evidence 45–52, exposure header 54 |
| MANDOLITE CP2 | A64; rows 65–90 | D69:D72 | Read-only basis D75; yield/status 73–74, source rules 78–84, exposure header 86 |
| FENDOLITE MII | A96; rows 97–167 | D101:D104 | Read-only basis D107; yield/status 105–106, special-factor rules 110–121, exposure header 123 |
| PERLIFOC HP ECO+ | A173; rows 174–223 | D178:D181 | Read-only basis D184; yield/status 182–183, rules 187–194, exposure header 196 |
| MONOKOTE MK-6 HY | A229; rows 230–264 | D234:D237 | Read-only basis D240; yield/status 238–239, exceptions 243–257, exposure header 259 |
| Operating rules | A270; rows 272–317 | None | Ordered source instructions with subsection labels at 272/276/280/284/288/292/296/300/304/308/312/316 |
| Factor helper | A341; rows 343–353 | D346:D348 | Hp/A D350 and ESA/M D351; evidence limitation 353 |
| Idealised hollow helper | A356; rows 358–367 | D358:D362 | Calculated area/perimeter/factors D364:D367 |
| Castellated helper | A370; rows 372–373 | D372 | Special factor D373 |

The five Material basis / reference values D42, D75, D107, D184 and D240 are
read-only. Exact existing saved overrides remain retained and displayed;
HTTP/storage-save validation rejects arbitrary new edits while accepting source
and reviewed-default text so Reset remains usable. The low-level evaluator
retains historical overlay support. Definitions can retain `defaults` and
`yield_review` as data separately from current inputs, but the browser no longer
shows the reviewed-yield action/panel. Settings date/source-ID/document-name
metadata rows 32–34, 65–67, 97–99, 174–176 and 230–232 are hidden in presentation;
their complete provenance stays in developer records and source packages.

The reviewed profile changes twenty existing settings: bag mass, direct yield,
inferred consumption and reference for each product. Store supplies it only when
no saved row exists. Existing saves, including an empty input overlay, remain
exact. Reset calculator defaults restores the profile and source example rows
in the draft; it does not write storage until Save calculator. Source graphs and explicit empty
engine calls retain original workbook defaults, with no migration. Direct yield
continues to take precedence over inferred dry-material consumption; the latter
is not installed coating density. See the qualified product choices in
[VERMICULITE_YIELD_REVIEW.md](VERMICULITE_YIELD_REVIEW.md).

Parameter-table headers are rows 35/68/100/177/233. Preserve product-specific units and explanation columns beside the editable values. D70, D102, D179 and D235 are deliberately editable formula-backed direct yields. An unchanged field must continue using its original formula; reading/rendering the Settings page must not create scalar overrides.

## Ductwork

### CALCULATOR

Render title, instructions and the source band headings in rows 1–9 above one table. Row 10 is its header; rows 11–310 are the full 300-row schedule. A contains fixed line numbers and is never imported. Inputs B:I are size, product, length, FRL, wall/floor counts, application and orientation.

Group results as J:P status/area/spray/wrap/roll/board quantities; Q:X wrap fixing/layers/local zones; Y:AC Maxilite strip geometry; AD:AJ penetration steel; AK:AM fixing/support instructions; AN:AO volume/yield; AP:AQ quantity qualifications/source. AR is a spacer. AS:CL are hidden helpers because source width is zero even though `hidden="0"`; omit them from normal presentation.

At the user's request, omit AK (column 37), **Penetration clearance guide**, from
both normal and advanced browser tables. This is a display omission only: all
300 source formulas and their guidance remain in the calculation model and full
worksheet response. AL **Penetration fixing guide**, AM support instructions,
all input columns, quantities and source settings remain available. The PDF
projection is unchanged.

Source widths deliberately give J35, H31/Q31, AK39, AL58, AM62 and AP85 units to long notes. Do not squeeze those into ordinary numeric widths or enlarge every other column to match them. Keep all qualification text reachable and wrapped. A 300-row table may scroll vertically and horizontally on this one page without changing row identities.

### SUMMARY

The current browser projection uses four independent tables, with each table
keeping its own columns and widths. This supersedes the earlier recommendation
to display every source commentary column:

| Section | Visible header | Visible data | Browser omission | Retained supporting text |
| --- | --- | --- | --- | --- |
| Product totals | A8:J8 | A9:J11 | K8:L11 basis/interpretation columns | A4 and A14 |
| Penetration angles by size/location | A18:F18 | A19:F26 | None; E:F basis/limitations remain | A17 heading |
| Working yields | A30:C30 | A31:C32 | D30:F32 | A29 heading and A35 scope |
| Maxilite board and cut strips | A39:G39 | A40:G41 | H39:L41 | A38 heading and A43 explanation |

The product totals retain all quantities and withheld counts through J. These
range-specific omissions must not hide E:F from the separate angle table or
change any evaluated values. Source widths and merges remain in the package;
independent browser tables avoid carrying the widest commentary columns into
unrelated sections. The report projection below retains its existing mappings.

### PRODUCT SETTINGS

Four source groups are explicit: CAFCO rows 6–46, MONOKOTE 48–92, FyreWrap 94–150, use notes 153–159. Keep source table headings 7/49/95 and auxiliary lookup headings 36/74/117/123/129/136. The browser omits the explanatory Both/Mixed block J6:Q21. This is a targeted presentation omission, not removal of the Both/Mixed technical rule, a change to product choices, or permission to hide other J:Q reference blocks. Its source cells and evaluated values remain intact.

Place the eleven editable controls prominently within their product groups: CAFCO B35/B44:B46; MONOKOTE B65/B73/B90:B92; FyreWrap B97/B100. Show CAFCO working yield B25 and coverage B26, MONOKOTE working yield B69, and FyreWrap actual roll area B112 as readonly outputs beside the related inputs. The rest is readonly source calibration/scope/reference data.

Source A:H parameter layout gives A43/B27 and H42 width units; J:Q contains separate notes with K40/Q39. On narrow screens use label/value/unit/basis cards and discrete reference tables; do not force all seventeen columns into the same grid.

## Structural Steel (board)

### START

This is an instruction page, not a schedule. The browser omits row 3, the three
counter labels/values in rows 5–6, and the source/traceability section in rows
34–39. Its contents navigation also omits the Sources link, so no link targets a
hidden section. Counters and source evidence remain in the source graph and
worksheet response. The five retained sections are A8 everyday workflow, A15
area calculation, A21 safety/scope, A25 optional controls and A30 reading row
notes, displayed as ordinary text/card groups.

Rows 40–100 are entirely decorative padding. There is no reason to display them as empty page height. Keep the source technical qualification wording and current scoped replacement of obsolete Excel-only instructions.

### CALCULATOR

Move merged introductory notes rows 1–7 above the table, retaining their live warnings. Replace the six source summary cards with one running-total row per board product. Row 8 supplies the schedule column labels. Render all 200 rows 9–208 in one table. A:L are normal inputs; M:X are advanced inputs and must be available through the existing advanced toggle; Y:AI are the primary results.

Split input groups into member/location, product/section or ESA/M, total lineal metres/exposure/FRL/member/temperature, then optional design/geometry controls. Row status AI9:AI208 remains visible and wrapped in normal font weight; the AI8 column heading stays bold. This presentation override does not alter the source style metadata or status text. Source Y:AI headers should not appear twice as ordinary body cells.

The required output distinctions are stack Z, layer count AA, total thickness AB, box girth AC, reference box area AD, actual net board AE, board with waste AF, standalone sheets AG, standalone purchase area AH and row notes AI. Do not relabel reference box area as board requirement. Hidden AJ:CI are retained calculation dependencies; the current source page extent intentionally presents only through AI.

The worksheet API supplies `board_product_totals`. It uses the existing Excel
evaluator's `SUMIF` to group schedule AD by product for **Box reference area
(m²)**, and BOARD SUMMARY G/I by product for **Net board required (m²)** and
**Whole sheets**. AD is bare box girth multiplied by the row's total lineal
length; it is not the actual exposed steel-profile surface. Thermal ESA/M or
Hp/A must not be used to invent a replacement surface-area measure. This area
distinction has been explained to the user.

BOARD SUMMARY G includes both board layers and valid EXTRA BOARDS; I retains
the source's product/thickness stock pooling and upward sheet rounding. Do not
sum schedule AG or divide a combined product area by an assumed stock size.
`COUNTIFS` supplies incomplete schedule and extra-board counts per product.
An incomplete row may still have a box reference area but no board quantity;
the available totals must stay accompanied by those counts and the source
warnings. An unrecognised/missing product is not represented by a known-product
total, so the original schedule status and overall incomplete warning remain
necessary. Valid extra boards can contribute even without a steel schedule row.

The retained native Excel default fixture gives the following independent
reference totals. These are source-example evidence, not a claim that the new
browser/API tests have passed:

| Product | Box reference m² | Net board m² | Pooled whole sheets | Incomplete / active schedule rows |
| --- | ---: | ---: | ---: | ---: |
| TRAFALGAR COREX | 13.456 | 21.014 | 11 | 5 / 16 |
| PROMATECT 250 | 1.1 | 1.35 | 1 | 0 / 2 |
| PROMATECT 100 | 6.392 | 10.172 | 5 | 3 / 11 |
| PROMATECT-XS | 11.82 | 25.94 | 10 | 1 / 7 |
| Total | 32.768 | 58.476 | 27 | 9 / 36 |

There are no entered extra-board allowances in that source example. Summing
the standalone schedule sheet counts would give 46 instead of the correct 27
pooled sheets. Values above retain audit precision; the browser displays two
decimals without changing the raw quantities.

### BOARD SUMMARY

Show three summary cards using labels A5/E5/I5 and values A6/E6/I6: net board
required, whole sheets and purchase area. Their source merged value ranges are
A6:C7, E6:G7 and I6:L7. Render the introductory A3 text once and retain the
live qualification A8:L9; omit duplicate source card rows from the table.
Rows 1–10 contain no editable fields. Render row 11 headers and all eighteen
product/thickness rows 12–29 as a purchasing table. Finish with A31 pooling
rules and A35 explanation of board area. Preserve source columns K/L as
reference/key information, optionally visually secondary.

Source A width is 25 units, numeric B:J15, references K:L21. Group columns into product/stock, box/extra/net area, waste, whole sheets and purchase area. Retain zero-quantity stock rows or offer a reversible display filter; filtering must never change the source pooled totals.

### EXTRA BOARDS

This source-hidden page is intentionally exposed because its inputs affect purchasing. Render its introduction once and row 5 as the header for all forty rows 6–45. Editable A:I and N cover item, product, thickness, pieces/cut dimensions or measured area, waste, purpose and evidence. J:M are live outputs/status.

Keep the alternative entry methods visibly grouped: pieces D × cut length E × cut width F **or** direct area G. Do not auto-clear one route when the other is entered: the existing source formula must show its conflict message. Include purpose I and evidence N alongside status M. Source I40/M36/N35 widths support generous wrapped text.

### SETTINGS

Present three independent tables stacked vertically, in this order:

| Table | Visible source range | Behavior |
| --- | --- | --- |
| General settings | A5:C34 | Setting, editable value and units; all 28 allowed values B6:B21 and B23:B34 remain. Row 22 is spacing. |
| Fire periods and temperatures | G5:N10 | Eight source headings from COREX FRL through Other beam temperature, with the original numeric choices. The empty No selection column remains part of the source table. |
| Diagnostic messages | P5:Q51 | Readonly code/message pairs, with naturally wrapped messages. |

The primary source table is A5:D34. Omit only D5:D34 (Basis) from browser
presentation. Remove only G12:N13, the dropdown table's final reference and
explanation rows; row 11 is blank. Do not omit whole rows 12/13, which also
contain editable B12/B13. These bounded omissions retain every source value,
formula and dependency. In particular, diagnostic P6:Q51 is a live VLOOKUP
source for schedule AI statuses, not disposable text.

General settings cover unit conventions/default waste (rows 6–10),
geometry/detail/temperature/tolerance (11–21), and COREX assessed limits
(23–34). The system identifiers B33/B34 remain editable strings, and B21's
1e-8 tolerance must retain its exact raw value. Stacking the independent tables
removes the oversized shared seventeen-column layout without changing input
keys, calculations, source packages or persistence.

## Report projection and quantity semantics

Reports must evaluate the current draft inputs, including settings, and present existing calculated values. Selecting a different page must not switch or reset the report's calculation state. No report projection should silently price these geometry workbooks; they contain no authoritative automatic transfer into Quote pricing.

The current PDF retains the main Full schedule, EXTRA BOARDS where applicable,
product and ancillary summary tables, and closing totals. Every populated
schedule row remains, including incomplete rows and the final prepared row when
entered. At the user's request, these four sections are removed:

- Schedule inputs, calculations and complete notes (the duplicate per-item
  detail appendix).
- Single-member calculator - separate from the schedule.
- Manual bag calculation - separate from the schedule.
- Settings used for this report.

The single-member and manual-bag calculators and numeric editable settings remain
available in the app. Settings still affect report quantities through the
captured input overlay; removing their appendix does not alter calculation.
The table below describes retained printed quantities and their source mapping,
not a promise that every intermediate worksheet cell is printed.

| Calculator | Exact report source | Meaning / limitation |
| --- | --- | --- |
| Vermiculite schedule | SCHEDULE A/B/F/I/J/O/P/R/T/U/V/W, rows 10–1009 | Item/product/section, quantity and length, published and usable thickness, spray area, net/per-line whole bags and main status |
| Vermiculite pooled ordering | BAGS A20:I24 | B line count, C area, D volume, E net bags, F waste, G whole bags by product, H incomplete count, I status |
| Ductwork schedule | CALCULATOR B/C/D/E/J/K/L/M/N/O, rows 11–310; PRODUCT SETTINGS B96 for wrap-layer thickness | Product/duct size, length, FRL, thickness, duct area, net spray bags, wrap area, roll equivalents and main status |
| Ductwork product totals | SUMMARY A9:L11 | C area; D bags; E wrap; F rolls; G board; H steel length; I/J withheld counts; K/L basis |
| Ductwork ancillary totals | SUMMARY A19:F26, A31:F32, A40:I41 | Angle sizes/locations, working yields and board-strip quantities with original limitations |
| Board schedule | CALCULATOR A/C/D/Z/AB/AD/AE/AF/AG/AN/AO/AR/AS, rows 9–208 | Item/product/section, design period/temperature, stack and thickness, reference box area, actual net/waste board areas, standalone sheet count and main status |
| Board extra detail | EXTRA BOARDS A:N, rows 6–45 | J net area, K area with waste, L stock key, M validity; invalid rows retain their status and no quantity |
| Board pooled purchasing | BOARD SUMMARY A6/E6/I6 and A12:K29 | Product/thickness pooling, including valid extra boards; use source whole-sheet and purchase-area totals |

For vermiculite ordering, use BAGS G20:G24. Do not sum the individually rounded SCHEDULE U values. Whole bags are withheld when the corresponding source incomplete/yield/waste conditions are not satisfied. Ductwork supplies net bags and roll equivalents, without an added waste factor or automatic whole-bag rounding.

For board purchasing, SUMMARY E is the sum of both box-layer areas grouped by product and thickness; F is matching EXTRA BOARDS J by stock key; G=E+F. H pools both box layers with waste and EXTRA BOARDS K. I rounds H divided by that stock sheet area upward; J is I times sheet area. A6 sums net box plus extra area; E6 sums pooled whole sheets; I6 sums purchase area. Never sum schedule AG to obtain the pooled job order.

Source activation rules are distinct from “different from default”:

- Duct CALCULATOR AS uses `COUNTA(B:I)>0`; an invalid/incomplete row remains active. CB marks available primary quantity and CC marks withheld penetration steel.
- Board CALCULATOR BD uses `COUNTA(A:X)>0`; AR determines `CLADDING ESTIMATE`, while AI contains the readable qualification. The original workbook's 36 demonstration rows are real entered rows until replaced or cleared.
- EXTRA BOARDS M is empty when A:I has no entered values. Evidence N alone does not activate a quantity. Valid allowance status is exactly `ENTERED ALLOWANCE`; invalid inputs are not silently priced or pooled.
- Vermiculite schedule output formulas gate on selected product B. BAGS product counts use matching B values. A report can retain a row containing other entered inputs as an incomplete entry, but must not invent a counted product or material quantity for it.

Default source examples are three duct rows, 36 board rows and one vermiculite schedule row. They must not be mistaken for an empty template or silently excluded because they equal workbook defaults.

## Acceptance checks for this presentation change

- All twelve complete-page responses cover their packaged extents, including the final editable schedule and EXTRA BOARDS rows. Display omissions are limited to the explicit presentation rules and source spacing; prepared input rows must not be discarded.
- Dropdowns retain numeric versus text values, source warning/stop behavior and dependencies, while repeated lists are shared without truncation.
- Advanced inputs remain present when requested; source hidden databases and calculated cells remain readonly.
- Forms display unchanged formula-backed settings without saving scalar overrides. Rendering, report generation and importing a draft do not persist inputs.
- Reset changes its declared draft scope, leaves saved records untouched until Save calculator, and retains later edits if a calculation response arrives late. The removed reviewed-yield action/panel must not reappear. An explicit empty engine overlay still matches original defaults.
- Calculator reports retain every populated main schedule item, applicable extras, product tables and closing totals; the four removed appendix/helper sections stay absent. They preserve invalid/withheld quantities and source ordering rules and never add manual BAGS results to schedule totals.
- Schedule product totals match BAGS net/pooled whole quantities, contents links target their declared source sections, and all eight fire-period columns remain aligned. Read-only basis values preserve existing saved text; arbitrary new changes are rejected at HTTP/storage-save boundaries while source/default reset values remain valid.
- Populated and blank outputs use their two prescribed highlight states consistently; zero and error text are populated. Hiding SCHEDULE V/W/X does not bypass W-dependent withheld orders or change PDF statuses. Settings source metadata and CALCULATOR third-section notes remain in source data despite their browser omission.
- Duct SUMMARY keeps four independent tables with the visible ranges above; hiding commentary in one table does not remove angle-table E:F or alter totals. PRODUCT SETTINGS omits only the Both/Mixed block J6:Q21. Board START omits its requested rows and Sources contents link, while board CALCULATOR retains every AI status in normal weight beneath a bold heading. These changes leave source formulas, input keys and PDFs unchanged.
- Board SETTINGS stacks three tables and keeps all 28 editable values, dependent dropdowns and diagnostic lookups. BOARD SUMMARY cards use their source totals without duplicated card rows. CALCULATOR product totals retain the box-reference area label, valid extras, original stock rounding and incomplete counts; incomplete/unknown-product rows must not silently become complete orders.
- Phone and desktop checks cover actual inputs, outputs and long qualification text, not only the page header. Source formula parity remains a separate regression gate.

This document records inspected source facts and implementation recommendations. Final UI, endpoint and report verification belongs in the current session evidence; this mapping alone does not claim those checks have passed.
