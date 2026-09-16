# Calculator presentation mapping

Date: 2026-09-15. This is a source-backed presentation and reporting map, not a new calculation specification. Source cell addresses below are developer traceability keys; user labels use the workbook's meaningful headings. Source packages, formulas and original workbooks remain unchanged. The separately authorized reviewed material defaults populate existing editable inputs; their boundary is recorded below and in [CALCULATOR_EXCEPTIONS.md](CALCULATOR_EXCEPTIONS.md).

## Evidence and implementation boundary

The audit read the three immutable `data/calculators/*.json.gz` models, including literal cells, formulas, styles, merged ranges, source column dimensions, validation and field metadata. Their hashes are recorded in `data/calculators/index.json`. The detailed local audit is `.runtime/calculators-audit/presentation/source-audit.json`, with one source-cell TSV per page. Formula caches were used only to distinguish original demonstration rows from empty prepared rows; they must never supply runtime answers.

The existing architecture is a shared workbook evaluator, HTTP projection and browser worksheet renderer. The proposed change is a presentation projection of those same evaluated cells into labelled forms, compact note blocks and complete tables. It removes the 25-row paging interaction and spreadsheet spacing without introducing business arithmetic, databases or a second estimator. Saved inputs keep their existing worksheet/cell keys and source hash. No data migration is needed.

The new `POST /api/calculators/<id>/worksheet` projection returns every source-page row, `visible_columns`, shared `option_sets`, cell `options_ref` and semantic `presentation` hints. The older bounded `calculate` endpoint remains compatible. UI grouping should consume these evaluated values and current validation choices; it should not recalculate them or derive technical status from colours.

`presentation.display_cells` supplies explicitly bounded browser-only role,
merge, bold/normal weight and alignment overrides. Table `row_layouts` can change
the visual order and span of declared source anchors within one row while
retaining their identities and original row spans. These affect rendering, not the source cell values, merges,
formula graph or report projection. A decorative merge must contain no hidden
editable value or populated result; its outside table edges remain visible.

Source `section_cells` metadata supplies stable anchors. `navigation_mode`
selects ordinary contents links, no contents navigation, or the Settings section
picker. The three Settings pages initially show their banner and picker with
all sections hidden; choosing a native button shows only that section. Selection
is client-only state per calculator/page and survives recalculation and page
switching during that browser session. It does not narrow the draft, worksheet
response, validation, save, reset, PDF or Excel-register scope.
All main section headings use the existing DUCT PROTECTION SUMMARY red-gradient
background and white text, replacing the former multicolour heading scheme.
Contents/navigation styling remains separate. Vermiculite uses six browser
`display_pages` over its unchanged four source `pages`: START shows the existing
operating-rules section directly, SETTINGS offers seven choices, and FACTOR
CALCS offers three. These three views request source SETTINGS and preserve its
cell/input keys. Duct PRODUCT SETTINGS has five choices and board SETTINGS
three. Vermiculite CALCULATOR/BAGS, board START and duct SUMMARY omit contents
navigation while retaining their content and stable section anchors.
A form's populated-cell structure
participates in its refresh signature so newly available output/source notes
appear without switching pages. Schedule controls remain in place for ordinary
value updates.

## Shared presentation rules

1. Keep all twelve source-page identities and input keys. Browser `display_pages` can project declared source sections into separate tabs without narrowing calculation/save/export scope. Every prepared input row remains reachable by normal scrolling; do not split it into 25-row pages.
2. Separate introductory merged notes from tabular data. Render a merged heading/note once from its anchor, with natural wrapping. Main source title/section cells, section anchors, overview titles and stacked/projected section headings use the same white text on the red-gradient banner. Do not create a tall table row for every merged child or preserve the workbook's print-oriented row heights.
3. Collapse rows and trailing columns that contain only decorative spacing. Keep every schedule and EXTRA BOARDS input row, even when its current result is blank. A formula returning `""` is not evidence that an input row is disposable.
4. Use the normal worksheet view throughout the browser; no calculator tab offers a Show advanced columns checkbox. Advanced source inputs remain available through `include_advanced` in the worksheet API and retain their existing saved values and calculation effects. Keep normal inputs and calculated outputs visibly distinct. Use populated/blank output highlights and the scoped pale-blue published-thickness H6 highlight; zero, error text and other nonblank results are populated. Keep exact dependency-driven dropdowns and current read-only/write-validation rules; colour never grants edit permission or technical approval.
5. On forms, use a two-column field layout on desktop and one column on a phone. Put units beside the value and source explanations below the field. Long status and basis text must wrap without truncation.
6. On schedules, retain the vertical sticky header but let every column, including the item identifier, scroll horizontally together. No calculator schedule freezes its first column. Use solid black gridlines consistently across schedules, material totals, order summaries and other calculator data tables. Keep horizontal scrolling inside each table and input widths suited to their contents. Independent presentation tables, including BOARD SUMMARY purchasing, and all SETTINGS/PRODUCT SETTINGS tables expand to their complete height and use page scrolling instead of a nested vertical cap; the prepared schedule scrollers retain their existing vertical behavior. The page itself must fit a 390-pixel viewport. Numeric cells need roughly 110–130 px; product/section choices 190–260 px; status and detailed notes 300–420 px. These are UI recommendations, not source business constants.
7. Display numbers to two decimals at rest and retain the exact raw value. Focused numeric controls and choices must distinguish small values such as 0.005, 0.01 and 1e-8. Never write a rounded display value merely because a field was focused or blurred.
8. Retain all source qualification text and error/withheld states in the source graph and calculation results. The explicit browser omissions below do not alter those states or the PDF mapping. `NP`, an empty result and zero mean different things. Do not turn a missing quantity into zero or describe a displayed quantity as installation approval.
9. Keep numeric Settings inputs, units, read-only calculation basis and live outputs. Omit the requested date/source-ID/document-name metadata and separate reviewed-yield action/panel from Settings presentation. Developer evidence retains full provenance. Do not expose hidden reference databases as new editable settings.
10. Remove the shared toolbar helper text. Place the green (#217346) Excel-register action immediately after Export template, use yellow for Import schedule and red for the PDF action. These styles do not change their separate payloads or export behavior.
11. Omit generic completed-calculation subtitles in the browser while retaining loading, invalid-input and calculation-error feedback. Duct CALCULATOR, SUMMARY and PRODUCT SETTINGS omit only the exact copied-fixing explanatory notice from the browser warning list; all other warnings remain. The approved fixing correction, source/API warning and PDF/Excel-register content are unchanged.

## Related Estimator controls

The related Estimator form removes its Workflow dropdown and labels the
existing dimensions/measurement textarea **NOTES**. Its `measurements` identity
and stored text are unchanged. Saved workflow values continue to load and feed
calculation/save/report requests; new estimates use the existing default
workflow. Removing the selector does not introduce a replacement workflow rule
or migrate previously saved quotes.

New-estimate initialization sets the separate Notes input B12 to an explicit
empty string. The immutable field default remains `Allowances`; saved-quote
loading and backend normalization remain unchanged. Explicit saved text and
blanks survive. The auto-generated Work summary panel is removed from the
Estimator UI, while calculation responses, saved quotes and PDFs retain their
summary data.

The Labour breakdown table sits between Calculation breakdown and quote notes.
It projects stored result cells through `labour_breakdown(result)`, using the
existing task mappings and display names. The eight task-day values are
B35/B36/B38:B43; B44 is their source subtotal. B37 pinning equals B36 meshing and
is excluded from that subtotal. F10, labelled Total Days in native Quote.xlsm,
is `SUM(B44,B53,C119)+0.5*C112`: masking B53, adjusted extra labour C119 and half
a day per adjusted mobilisation C112 are separate rows. The table displays the
stored F10 as its total, never a sum of rounded browser values. F2 remains the
separate labour money amount; this display does not add or recalculate costs.

Fresh results add a `labour` object. Older saved-quote responses enrich a copy
using their own stored cells without current prices, recalculation or a saved
record write. Missing values remain unavailable, errors remain explicit and
loading/failure clears stale rows. The native dependency audit and workbook hash
are retained in `.runtime/labour-controls-qa/labour-source.json`; source workbook,
existing result fields and PDF calculations remain unchanged.

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

The browser displays A1 as **QUICK CALCULATOR** and omits the A3 subtitle.
After that heading, it renders three independent
sections in order: Inputs A5:F24, Thickness and quantities H5:N24, then All
published periods A26:I30. Each source heading appears once above its own
table, using anchors A5, H5 and A26. Inputs and outputs are vertically ordered,
replacing the earlier recommendation for two adjacent cards. Keep all eleven
inputs D6:D12/D14:D17, including blank D11/D16/D17, and help text A20:F24.

The output section contains the published thickness value at H6:K8 with its label at L6, lookup status H9, ESA/M K12, Hp/A K13, usable estimating thickness K14, girth K15, spray area K16, coating volume K17, net bags K18, quantity status H20 and source H23. Preserve the distinction between published and usable estimating thickness. The later user instruction removes the separate notes section below the comparison matrix from browser presentation only.

The “03 All published periods for this input” heading A26 stays with its
comparison table in the third section. A28:A30 supplies
the row labels and B28:I30 supplies eight period/thickness/status columns. The
implemented matrix gives those eight period columns equal independent widths;
G28:G30 is the 120-minute column, not a merge. Inheriting the narrow form spacer G
caused its malformed appearance. The merged J28:N30 comparison narrative and
the third notes section at rows 33–41 are omitted from browser presentation,
with their values retained in the source model. On phones the form stacks while this matrix retains
aligned columns in its own horizontal scroller.

The user-confirmed centering target is the complete published-period table
A28:I30, including its header and result rows. Browser alignment metadata centers
only those cells. In the separate Thickness and quantities form, row 6 displays
the Published thickness label at L6 first with a three-column span, then the
value at H6 with a four-column span and left alignment. L6 now reads
**PUBLISHED VALUE**, and the browser appends **mm** to numeric H6 output only.
H6 receives the explicit `published-thickness` pale-blue display highlight.
Blank, text and error results receive no numeric suffix. This scoped row layout
preserves both source anchors, their original row spans and evaluated values;
it does not swap source cell contents or alter the centered period table.

Source widths: labels occupy merged A:C; inputs D:F; G is a 3-unit spacer. Results H:N use merged label/value regions. The separate input/output form tables fit the available width; the comparison keeps independent numerical column widths. Source merges continue to identify labels and values without recreating the wide combined spreadsheet.

### SCHEDULE

The top labels at rows 1, 2, 3 and 8 are omitted from the browser. Summary cards
A4/A5, G4/G5 and S4/S5 remain visible. The earlier removed
thickness/scope-block card M4/M5 is still calculated internally. The only schedule
header is row 9, beneath the browser **MEMBER SCHEDULE** section banner. Show all 1,000 rows 10–1009 together. A:L are inputs, M:Y source outputs;
hidden Z is the stable line ID and remains readonly/internal.

Section ID F10:F1009 uses native select controls from the unchanged source
validation list of 553 active sections. The browser materializes the full list
when a control opens, preserving saved values and dependency-driven choices
without placing that list in every one of the 1,000 initial row controls.
The blank option remains first, and current/legacy values remain selectable;
opening the list must never change the stored selection.
Source note Y10:Y1009 uses normal font weight; its text and calculations remain.

Browser labels A4 and G4 read **TOTAL ENTERED SPRAY AREA (m²)** and
**COATING VOLUME QUANTIFIED (m³)**. Area and volume retain their existing values
and formulas; these two explicit display aliases add units without changing the
source captions or worksheet identity.

Below the cards, **PRODUCT SUMMARY** lists each BAGS A20:A24 product, E20:E24
net bags, G20:G24 pooled whole bags and I20:I24 order status. The worksheet API
supplies these as `product_totals`; the UI never derives them by summing rounded
line quantities. Blank/withheld whole-bag values remain blank beside their
status. This totals section is a full-width sibling after the overview, rather
than a child of its flex layout. Its explanatory text keeps the gold note fill.
Updating these totals does not rebuild the schedule controls.

Input groups: A item; B:F product/case/temperature/method/section; G:H factor/period; I:L quantity/length/girth/area. Output groups: M:N lookup factors; O:P published/usable thickness; Q:U geometry/volume/bags. Source V/W/X status/source columns are explicitly hidden in the browser; Y notes remain wide and wrapped. V/W/X stay in API/source results and the existing report projection. In particular, W continues to gate incomplete purchasing totals. Source width emphasis remains B25/C29/F22, compact numeric I9 and J:Q12, status V:W31, source X26 and notes Y64; these source widths do not require hidden columns to be displayed.

Exposure/Case cells C10:C1009 use normal-weight browser text, including their
existing selection controls. The C9 header and technical reference labels keep
their emphasis. Labels, choices, input identities and calculations remain
unchanged. All prepared rows remain present even though 999 original example
slots return blank formulas. The original workbook has one active example,
not 1,000 completed estimates.

### BAGS

The browser aliases A1 to **MATERIAL QUANTITIES** without changing the BAGS page
name or source title. It renders the product-order table first, then the
MATERIAL QUANTITIES heading, source subtitle A3 and independent manual form.
The manual presentation owns rows 1–15, using columns A:F and H:N and omitting
only decorative G from that
form. The three inputs D6:D8 and live results D9:D14 remain. Source limitations
H6 and H11 remain with that form. This calculation stays independent of the
SCHEDULE order summary.

Browser metadata merges the empty H10:N10 region into one gold spacer without
internal vertical rules. The A10:C10 label and D10:F10 working-yield value remain
separate and unchanged. Removing G from the manual form does not remove the
Whole bags header or pooled whole-bag values in G19:G24 of the order table above.
The source merges and calculated values are preserved.

The first independent table section owns the “Product order summary” heading
A17, row 19 headers and five product rows A20:I24. Product names A20:A24 are bold.
`display_table_order` reorders these two existing projections while their source
anchors and stable IDs stay intact. Keep order status I and
incomplete count H visible even when whole bags G are blank. Trailing notes A27
remain present.

The implemented phone view stacks manual inputs/results in one form and leaves
the product-order matrix in a separate real table with its own horizontal scroll.
The later compact layout sizes the nine A:I order columns at
19/7/9/10/8/7/11/9/20 percent, reserving 20 percent for wrapped order status.
Blank J:N columns are omitted. All five product rows and quantities remain present,
and the manual form fits the available page width.
Each editable source field is rendered once.

Source table widths indicate product A29, normal numerical columns 12–16 units, whole bags G21 and order status I35. Product and numerical columns scroll together; order-status text remains wrapped.

### START, SETTINGS and FACTOR CALCS

The source SETTINGS worksheet remains unchanged. Browser START displays
A270:N340 operating rules directly with no picker. Browser SETTINGS offers the
first seven ranges below; FACTOR CALCS offers the last three helper ranges.
Both picker views begin with no section selected and retain separate selections
while switching tabs. The complete source worksheet remains in calculation,
validation, save/reset and report scope. All eleven source ranges retain their
adjacent notes, controls and merges, subject to the declared browser omissions.

`display_pages` contains START, CALCULATOR, SCHEDULE, BAGS, SETTINGS and FACTOR
CALCS in that order. START/SETTINGS/FACTOR CALCS all resolve to source SETTINGS;
no new storage keys or workbook pages are introduced. Heading aliases A9, A17,
A31, A64, A96, A173, A229 and A270 remove source numbering/slash suffixes and
read GLOBAL SETTINGS, COMMON CALCULATION RULES, CAFCO 300, MANDOLITE CP2,
FENDOLITE MII, PERLIFOC HP ECO+, MONOKOTE MK-6 HY and COMPLETE WORKBOOK OPERATING
RULES respectively.

Source A7 guidance is displayed once on START immediately below A270, and is
omitted from the SETTINGS view. It and BAGS A27 direct users to FACTOR CALCS.
START omits SOURCE CONFLICTS A304:N307 and ORIGINAL TAKE-OFF A316:N319, with
those cells and formulas retained in the source model. Factor headings A356 and
A370 read **IDEALISED HOLLOW GEOMETRY** and **FENDOLITE CASTELLATED SECTION**
in both the section picker and section banner. These are browser-only mappings.

All Settings tables, including source content outside explicit table projections,
expand with the page and have no nested vertical height cap. Horizontal scrolling
remains available where needed; this rule does not apply to prepared schedules.

| Group | Heading / extent | Editable cells | Required adjacent readonly material |
| --- | --- | --- | --- |
| Global settings | A9:N16 | D10:D14 | Comparison tolerance D15 |
| Common calculation rules | A17:N30 | None | Lookup, thickness holds, yield, orders and project-design explanations |
| CAFCO 300 | A31:N63 | D36:D39 | Read-only basis D42; yield/status 40–41, scope/evidence 45–52, exposure header 54 |
| MANDOLITE CP2 | A64:N95 | D69:D72 | Read-only basis D75; yield/status 73–74, source rules 78–84, exposure header 86 |
| FENDOLITE MII | A96:N172 | D101:D104 | Read-only basis D107; yield/status 105–106, special-factor rules 110–121, exposure header 123 |
| PERLIFOC HP ECO+ | A173:N228 | D178:D181 | Read-only basis D184; yield/status 182–183, rules 187–194, exposure header 196 |
| MONOKOTE MK-6 HY | A229:N269 | D234:D237 | Read-only basis D240; yield/status 238–239, exceptions 243–257, exposure header 259 |
| Operating rules | A270:N340 | None | Ordered instructions; browser omits SOURCE CONFLICTS 304–307 and ORIGINAL TAKE-OFF 316–319 |
| Factor helper | A341:N355 | D346:D348 | Hp/A D350 and ESA/M D351; evidence limitation 353 |
| Idealised hollow helper | A356:N369 | D358:D362 | Calculated area/perimeter/factors D364:D367 |
| Castellated helper | A370:N374 | D372 | Special factor D373 and adjacent H371:N374 notes |

The five Material basis / reference values D42, D75, D107, D184 and D240 are
read-only. Exact existing saved overrides remain retained and displayed;
HTTP/storage-save validation rejects arbitrary new edits while accepting source
and reviewed-default text so Reset remains usable. The low-level evaluator
retains historical overlay support. Definitions can retain `defaults` and
`yield_review` as data separately from current inputs, but the browser no longer
shows the reviewed-yield action/panel. Introductory rows 3–4 and Settings
date/source-ID/document-name metadata rows 32–34, 65–67, 97–99, 174–176 and
230–232 are hidden in presentation; their complete provenance stays in developer
records and source packages.

Browser-only role overrides make the five technical-rule headings
A48, A81, A113, A190 and A246 use the pink table-header fill. These are local
table headings; the main section banners retain their red/white style. Reference
values D42, D75, D107, D184 and D240 explicitly use normal font weight, including
the CAFCO review prose. Exposure names
are bold at A55:A58, A87:A90,
A124:A167, A197:A223 and A260:A264. None of these weight changes affects the
read-only boundary, source text or technical lookup choices.

The factor helpers absorb their empty G divider into the D:G value region at
rows 346–352, 358–368 and 372–374. The blank left-side first row A371:G371 is a
collapsed decorative span; the notes at H371:N374 remain present with their
original source identity. The three helper groups keep every existing input,
result, unit and adjacent limitation, and their source merge records stay intact.

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

The browser displays A1 as **DUCT PROTECTION CALCULATOR** and omits introductory
rows 5, 6, 7 and 9. A3 has an explicit browser note role: the title and note each
occupy a full row, with A3 using the same gold note fill as SUMMARY. These are
display aliases/omissions; the source title, cells
and CALCULATOR page name remain unchanged. Row 10 is the table header; rows
11–310 remain the full 300-row schedule. A contains fixed line numbers and is
never imported. Inputs B:I are size, product, length, FRL, wall/floor counts,
application and orientation.

Product C11:C310, FRL E11:E310, application H11:H310 and orientation I11:I310
use native selects. These use the original choices and validation policy. A
source `allow_other` or warning/information field retains an explicit custom-value
editor, so the control change does not reject a permitted saved or new value.

Group results as J:P status/area/spray/wrap/roll/board quantities; Q:X wrap fixing/layers/local zones; Y:AC Maxilite strip geometry; AD:AJ penetration steel; AK:AM fixing/support instructions; AN:AO volume/yield; AP:AQ quantity qualifications/source. AR is a spacer. AS:CL are hidden helpers because source width is zero even though `hidden="0"`; omit them from normal presentation.

The browser omits columns 37/38/42/43/44 (AK, AL, AP, AQ and AR).
This includes the penetration clearance/fixing guides,
quantity qualification/source columns and spacer. Their formulas, text and
withheld-quantity rules remain in the calculation model and worksheet response.
The approved first-row-based copied-text correction to AL remains applied even
though its browser column is hidden; the PDF projection is unchanged.

The configured display order is 1–36, 40, 41, 37, 38, 39, 42, 43, 44. Applying
the omissions puts AN/AO volume/yield immediately after AJ, followed by AM
support instructions: A:AJ, AN, AO, AM. Advanced source columns remain available
through the worksheet API. Reordering affects headers and values together without
renaming input keys or moving source cells.

The support-instruction prose in AM11:AM310 explicitly uses normal font weight.
Its AM10 column heading retains its existing heading style, and neither the
instruction text nor the quantity qualifications are changed.

Editable fire-exposure/application cells H11:H310 also use normal weight,
preserving their native select controls. H10 and PRODUCT SETTINGS reference
exposure labels retain their heading/label emphasis.

Source widths deliberately give J35, H31/Q31, AK39, AL58, AM62 and AP85 units to long notes. Widths for omitted columns remain source evidence rather than visible layout requirements. Keep the remaining status/support text wrapped at readable widths. A 300-row table may scroll vertically and horizontally on this one page without changing row identities.

### SUMMARY

The browser displays A1 as **DUCT PROTECTION SUMMARY** while retaining the source
title and SUMMARY page name. Four logical section wrappers separate product
totals, penetration angles, working yields and Maxilite quantities by 24 px.
Each owns its heading, table and associated notes while keeping its own columns
and widths. This supersedes the earlier recommendation
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

The A17 and A29 section headings each span A:L in the browser through
display-only merges A17:L17 and A29:L29. Their original A:F source merges remain
unchanged; the expanded red banners do not change the following table's columns.

First-column reference labels are explicitly bold at A9:A11 (products),
A19:A26 (penetration angle rows) and A31:A32 (working yields). Adjacent quantities,
units and prose retain their existing formatting and values.

### PRODUCT SETTINGS

Four source groups are explicit: CAFCO rows 6–46, MONOKOTE 48–92, FyreWrap 94–150, use notes 153–159. Keep source table headings 7/49/95 and auxiliary lookup content. The browser omits introductory rows 3–4, the explanatory Both/Mixed block J6:Q21 and the complete USE NOTES section in rows 153–159, including its contents link. These are targeted presentation omissions, not removal of the Both/Mixed technical rule, a change to product choices, or permission to hide other J:Q reference blocks. Their source cells, API values and existing report projection remain intact.

The picker independently exposes CAFCO A6:H46, MONOKOTE A48:H92 and the three
FyreWrap rectangles below. All five start hidden. Bounds include columns as well
as rows, so selecting a left-hand product does not expose the application or
penetration table on the right. Existing omissions remain in effect.

| Section | Source range | Heading / header | Retained content |
| --- | --- | --- | --- |
| FyreWrap | A94:H151 | A94 heading; source parameter headers within the form | All core settings, roll-area output and product notes |
| FyreWrap application table | J94:Q113 | J94 displays FYREWRAP APPLICATION TABLE; row 95 header | Application choices and source requirements |
| Penetration takeoff | J115:Q149 | J115 heading; row 116 header | Standard details, auxiliary tables and live exposure list J137:J149 with K137:Q139 note |

Each selected heading appears once above its own data. Hidden sections retain
their values, inputs and calculation effects; the complete API page is unchanged.
Browser-only merges join each blank gray row J105:Q105, J108:Q108, J111:Q111,
J131:Q131 and J136:Q136. These rows retain their outside table borders without
internal vertical rules; the adjacent text, parameters and live lookup records
stay intact. This changes layout only; all eleven editable controls and
dependencies remain.

The following source-table label anchors are explicitly bold in the browser:

- A8:A35, A37:A39, A50:A73 and A75:A79 for CAFCO/MONOKOTE reference labels.
- A96:A115, A118:A121, A124:A127, A130:A134 and A137:A150 for FyreWrap and Maxilite reference labels.
- J96:J104, J117:J130 and J137:J149 for the application/penetration tables and live lookup list.

The A142:A150 extension makes the Maxilite first-column labels bold while the
adjacent explanatory column retains its existing presentation. Blank separators
and existing source section-heading styles remain separate. The whole PRODUCT SETTINGS
page uses its content height, including unprojected tables, with no nested
vertical cap. No input, lookup choice or technical rule changes with label weight.

Place the eleven editable controls prominently within their product groups: CAFCO B35/B44:B46; MONOKOTE B65/B73/B90:B92; FyreWrap B97/B100. Show CAFCO working yield B25 and coverage B26, MONOKOTE working yield B69, and FyreWrap actual roll area B112 as readonly outputs beside the related inputs. The rest is readonly source calibration/scope/reference data.

Source A:H parameter layout gives A43/B27 and H42 width units; J:Q contains separate notes with K40/Q39. On narrow screens use label/value/unit/basis cards and discrete reference tables; do not force all seventeen columns into the same grid.

## Structural Steel (board)

### START

This is an instruction page, not a schedule. The browser omits row 3, the three
counter labels/values in rows 5–6, and the source/traceability section in rows
34–39. Its contents navigation is omitted completely. Retained content uses page
scrolling without a nested vertical pane. Counters and source evidence remain in the source graph and
worksheet response. The five retained sections are A8 everyday workflow, A15
area calculation, A21 safety/scope, A25 optional controls and A30 reading row
notes, displayed as ordinary text/card groups.

Rows 40–100 are entirely decorative padding. There is no reason to display them as empty page height. Keep the source technical qualification wording and current scoped replacement of obsolete Excel-only instructions.

### CALCULATOR

The browser displays A1 as **STRUCTURAL STEEL BOARD SCHEDULE**. It omits rows
2, 5 and 7 plus Y1:AI1 and A6:L6 from the introduction, retaining the live Y6
incomplete-order warning. Source titles and the CALCULATOR page name remain
unchanged. The six source summary cards are replaced by one running-total row
per product under **CALCULATED SUMMARY**. This heading change does not remove the
three cards on the separate BOARD SUMMARY page. Row 8 supplies the schedule
column labels. All 200 rows 9–208 remain in one table. A:L are normal inputs;
M:X are advanced source inputs retained through the worksheet API and saved
state; they have no browser toggle. Y:AI are the primary results.

Product C9:C208, section D9:D208, FRL H9:H208 and member J9:J208 use native
selects. The 1,342 source steel choices are populated on opening to keep the
initial 200-row render small. A leading blank and current/legacy values are
retained; source-permitted custom values remain editable through the explicit
custom option. Dropdown presentation does not change source validation rules.

CALCULATED SUMMARY is a full-width section with its gold note text. The
STRUCTURAL STEEL BOARD SCHEDULE title and live Y6 warning follow those totals,
immediately before the schedule table. Its source-derived quantities and the
separate BOARD SUMMARY cards retain their existing behavior.
The board CALCULATOR, BOARD SUMMARY and EXTRA BOARDS overviews use full-width
title and note rows. The BOARD SUMMARY cards remain within that expanded layout.

Split input groups into member/location, product/section or ESA/M, total lineal metres/exposure/FRL/member/temperature, then optional design/geometry controls. Row status AI9:AI208 remains visible and wrapped in normal font weight; the AI8 column heading stays bold. This presentation override does not alter the source style metadata or status text. Source Y:AI headers should not appear twice as ordinary body cells.

Exposure layout M9:M208 uses normal-weight body text when rendered; the M8
heading remains unchanged. This advanced source input stays hidden in the
normal browser projection, with its values retained by the API and saved draft.

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

The browser A1 title reads **BOARD SUMMARY**; the original source caption and
worksheet identity are retained.

Show three summary cards using labels A5/E5/I5 and values A6/E6/I6: net board
required, whole sheets and purchase area. Their source merged value ranges are
A6:C7, E6:G7 and I6:L7. Render the introductory A3 text once and retain the
live qualification A8:L9; omit duplicate source card rows from the table.
Rows 1–10 contain no editable fields. Render row 11 headers and all eighteen
product/thickness rows 12–29 as an independent purchasing table showing A:D and
I:J: product, thickness, sheet dimensions, whole sheets and purchase area.
Hide E:H (Box board - net m2, Extra boards - net m2, Net total sqm and With waste
sqm) and K:L (Stock source and Board key) only within this table. Their source
values, formulas, report projection and use in pooled totals remain intact.
Finish with A31 pooling rules and A35 explanation of board area. The table's
scoped column selection must not remove the whole-sheet card at E6 or the other
two cards above it. Numeric thickness/sheet dimensions B12:D29 display an
` mm` suffix and purchase area J12:J29 displays ` m²`; missing/error values do
not receive units, and raw API/export values remain numeric and unmodified.

The purchasing table has no nested vertical height cap: all eighteen stock rows
contribute to the page height. This does not alter its horizontal overflow or
the prepared schedule tables' vertical scrollers.

Source A width is 25 units, numeric B:J15, references K:L21. These source widths
remain traceability evidence; the independent browser table gives its six
visible columns usable widths. Retain every stock row, including zero-quantity
rows; display omissions never change the source pooled totals.

Product labels A12:A29 are bold in the browser. The remaining stock quantities,
dimensions and qualification notes retain their existing formatting and values.

### EXTRA BOARDS

The browser A1 title reads **EXTRA BOARDS** without the former detail-takeoff
suffix. This is an explicit display alias, not a worksheet or data-key rename.
Product B6:B45 and thickness C6:C45 use native selects with the same original
choices, custom-value permission and dependent thickness behavior.

This source-hidden page is intentionally exposed because its inputs affect purchasing. Render its introduction once and row 5 as the header for all forty rows 6–45. Editable A:I cover item, product, thickness, pieces/cut dimensions or measured area, waste and purpose. J:M are live outputs/status. The user-requested Evidence reference column N is hidden only in the browser; its existing editable API identity and saved values remain intact. This is an explicit exception to the general rule against hiding editable fields, not removal of its input allowlist or stored data.

Keep the alternative entry methods visibly grouped: pieces D × cut length E × cut width F **or** direct area G. Do not auto-clear one route when the other is entered: the existing source formula must show its conflict message. Include purpose I alongside status M. Source I40/M36 widths support generous wrapped text; hiding N does not alter the PDF or quantity rules.

### SETTINGS

Present three independent choices in this order, with no section shown until
the user selects it:

| Table | Visible source range | Behavior |
| --- | --- | --- |
| General settings | A5:C34 | Setting, editable value and units; all 28 allowed values B6:B21 and B23:B34 remain. Row 22 is spacing. |
| Fire periods and temperatures | G5:N10 | Eight source headings from COREX FRL through Other beam temperature, with the original numeric choices. The empty No selection column remains part of the source table. |
| Diagnostic messages | P5:Q51 | Readonly code/message pairs, with naturally wrapped messages. |

The first-column labels A6:A34 and P6:P51 are bold through bounded browser
metadata. Adjacent editable values, units and diagnostic messages retain their
existing style and source data.

The primary source table is A5:D34. Omit only D5:D34 (Basis) from browser
presentation. Remove only G12:N13, the dropdown table's final reference and
explanation rows; row 11 is blank. Do not omit whole rows 12/13, which also
contain editable B12/B13. These bounded omissions retain every source value,
formula and dependency. In particular, diagnostic P6:Q51 is a live VLOOKUP
source for schedule AI statuses, not disposable text.

General settings cover unit conventions/default waste (rows 6–10),
geometry/detail/temperature/tolerance (11–21), and COREX assessed limits
(23–34). The system identifiers B33/B34 remain editable strings, and B21's
1e-8 tolerance must retain its exact raw value. Selecting independent tables
avoids the oversized shared seventeen-column layout without changing input
keys, calculations, source packages or persistence.

## Report projection and quantity semantics

Reports must evaluate the current draft inputs, including settings, and present existing calculated values. Selecting a different page must not switch or reset the report's calculation state. No report projection should silently price these geometry workbooks; they contain no authoritative automatic transfer into Quote pricing.

The complete projection is shared by two PDFs and the unchanged Excel register.
`report.pdf` / `build_calculator_report` renders **Full schedule** only, retaining
every populated main-schedule row, including incomplete rows and the final
prepared row when entered. `summary.pdf` / `build_calculator_summary_report`
renders **Material quantities and summary**, including **Final product and
material summary**, product/ancillary tables, closing totals and board
**EXTRA BOARDS**. Those summary sections do not appear in the schedule PDF.
The Excel register retains Summary/Schedule and board Extra boards sheets.
These four sections remain excluded from both PDFs:

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
- The browser has no advanced-column checkbox or instructions to use it. The worksheet API still returns advanced inputs when `include_advanced` is requested; source hidden databases and calculated cells remain readonly. Normal-view editing, recalculation and saving preserve existing hidden advanced input values.
- Forms display unchanged formula-backed settings without saving scalar overrides. Rendering, report generation and importing a draft do not persist inputs.
- Reset changes its declared draft scope, leaves saved records untouched until Save calculator, and retains later edits if a calculation response arrives late. The removed reviewed-yield action/panel must not reappear. An explicit empty engine overlay still matches original defaults.
- The schedule PDF retains every populated main-schedule item and its status; the materials & summary PDF retains applicable extras, product/ancillary tables and closing totals. The four removed appendix/helper sections stay absent from both. The complete shared projection and Excel register retain all quantities, invalid/withheld states and source ordering rules; manual BAGS results are never added to schedule totals.
- Schedule product totals match BAGS net/pooled whole quantities, contents links target their declared source sections, and all eight fire-period columns remain aligned. Read-only basis values preserve existing saved text; arbitrary new changes are rejected at HTTP/storage-save boundaries while source/default reset values remain valid.
- Populated and blank outputs use their two prescribed highlight states consistently; zero and error text are populated. Hiding SCHEDULE V/W/X does not bypass W-dependent withheld orders or change PDF statuses. Settings source metadata and CALCULATOR third-section notes remain in source data despite their browser omission.
- Duct SUMMARY keeps four independent tables with the visible ranges above; hiding commentary in one table does not remove angle-table E:F or alter totals. PRODUCT SETTINGS omits the explicitly listed introductory rows, Both/Mixed block J6:Q21 and USE NOTES rows 153–159, including that section's contents link. Board START omits its requested rows and Sources contents link, while board CALCULATOR retains every AI status in normal weight beneath a bold heading. These changes leave source formulas, input keys and PDFs unchanged.
- All picker pages initially hide their sections, expose exactly one selected panel and retain that client selection across recalculation and page switching. Vermiculite has seven Settings and three Factor choices; START directly shows operating rules. Together they cover the same eleven source rectangles, including adjacent/helper notes. Duct and board retain five/three choices. Board SETTINGS keeps all 28 editable values, dependent dropdowns and diagnostic lookups; hidden sections remain in the complete draft, validation, save, reset and both report scopes.
- BOARD SUMMARY cards use their source totals without duplicated card rows. CALCULATOR product totals retain the box-reference area label, valid extras, original stock rounding and incomplete counts; incomplete/unknown-product rows must not silently become complete orders.
- BOARD SUMMARY shows only A:D and I:J within rows 11–29, retaining all eighteen stock rows, three source-total cards, the live qualification and notes A31/A35. EXTRA BOARDS hides N while retaining all forty rows and editable A:I. Saving an unrelated visible edit preserves existing N6:N45 evidence and advanced input values. Complete API results, pooled quantities and PDF contents remain unchanged.
- Board CALCULATOR retains Y6 and every prepared input row after its introductory omissions; its CALCULATED SUMMARY section does not replace the three BOARD SUMMARY cards. Duct CALCULATOR's column order keeps header/value identities aligned, retains the underlying quantity holds and approved AL correction, and changes no source formula or report. A1 title aliases do not rename worksheet/input keys.
- Phone and desktop checks cover actual inputs, outputs and long qualification text, not only the page header. Source formula parity remains a separate regression gate.
- Horizontal scrolling moves the first column with the remaining schedule columns while vertical column headings can stay visible. Data-table gridlines are solid black; main source, overview, total and projected-section headings share the red/white banner. Populated/blank data fills remain separate from heading styling and do not change calculation semantics.
- Projected Inputs, Thickness and quantities, period comparison, product ordering and FyreWrap sections keep their own source headings with their data. Each original editable field occurs once; residual notes and unprojected source content remain available except for explicit omissions. BAGS displays MATERIAL QUANTITIES while retaining its original worksheet identity.
- Independent presentation tables and every SETTINGS/PRODUCT SETTINGS table use their full content height; long schedules retain their existing vertical scrollers. Duct CALCULATOR A3 renders as a full-row gold note. SUMMARY A17/A29 span A:L. The five listed blank PRODUCT SETTINGS J:Q rows render as gray spans with only outside borders; BAGS H10:N10 is a gold span while its label and working yield remain visible. Source merges, values, formulas and report projections remain unchanged.
- Vermiculite SCHEDULE uses the explicit m²/m³ summary labels and full-width PRODUCT SUMMARY; the board CALCULATED SUMMARY uses the same independent placement. BAGS omits G only in manual-form rows 6–15, preserving G19:G24 and all pooled order values. The confirmed A28:I30 period table is centered. Duct reference labels are bold only at the declared anchors, leaving adjacent explanatory prose unchanged.
- Factor-helper D:G spans remove only blank dividers; collapsing A371:G371 retains H371:N374 notes and every helper input/result. The Published thickness row renders L6 before left-aligned H6 with source identities and original row spans intact. Pink technical-rule headings, normal reference/support prose and bold reference exposure/product labels apply only to the listed anchors. Editable schedule Exposure cells use normal weight within vermiculite C10:C1009, board M9:M208 and duct H11:H310; headers remain unchanged. Board overview title/notes fill their rows while all three summary cards remain; BOARD SUMMARY and EXTRA BOARDS are browser title aliases only.
- Vermiculite CALCULATOR/BAGS, board START and duct SUMMARY omit contents links; board START uses page scrolling. BAGS orders its product table before the MATERIAL QUANTITIES heading, subtitle and manual form without duplicate IDs or inputs and uses bold A20:A24 names. MEMBER SCHEDULE, PUBLISHED VALUE, numeric-only H6 mm/highlight, normal schedule Y notes and the shorter J94 title are display changes. Generic success subtitles and only the exact duct copied-fixing notice are hidden; errors, other warnings, source/API text, PDF and Excel-register values remain intact.
- Native Section ID controls retain all 553 active source choices, saved values and blank behavior, including after recalculation. Opening a control materializes its options without changing input state. All 1,000 rows remain available.
- New-estimate B12 is blank; loading/saving explicit historical notes remains exact. The removed Work summary DOM element is never referenced by rendering or error paths, while API and stored/PDF summaries remain available.

This document records inspected source facts and implementation recommendations. Final UI, endpoint and report verification belongs in the current session evidence; this mapping alone does not claim those checks have passed.

The earlier detail-layout checkpoint had 25 targeted Python tests, 75 calculator UI
checks and 20 original UI checks passing, plus browser, unchanged worksheet/PDF
and refreshed-runtime evidence. Exact checks and retained artifacts are recorded
in its dated SESSION_HANDOFF.md entry. PR #18's section-navigation publication is
recorded there and in `.runtime/section-navigation-qa/publication.json`. The prior
START/FACTOR CALCS local validation passed 89 calculator UI and 22 Estimator UI
checks, 29 API/cleanup and 13 section/tab tests, the 42 focused Estimator
backend/PDF tests, syntax/whitespace checks and the 35-file build. Native review
covered the twelve requested changes, exact helper-draft retention and the
554-option native select with blank first. All twelve source-page cell sets and
all three PDF/register projections match before/after; the refreshed main app
preserves saved data. PR #19 published that increment as merge `335f4b6e0eac2419cb2b7f8c98998c0f5661d5d7`;
its receipt is `.runtime/tabs-notes-qa/publication.json`.

The labour/controls commit-preparation checkpoint passes 92 calculator UI and 25 Estimator
UI checks (117 total), plus both JavaScript syntax checks. Native
review confirms all thirteen labour rows in their requested location and the
source default 0.50 days, source-compatible choices, relocated guidance/titles,
purchasing units and four separated Duct SUMMARY groups. All 104,068 calculator
source cells across twelve pages and all three PDF/register projections match
the baseline, as do six Estimator API scenarios' pre-existing result fields.
The full local Python run is continuing, with a corrected legacy metadata
expectation and one HTTP error awaiting its exact trace. No clean full Python,
build or refreshed-runtime pass is claimed here. Commit/push, PR, exact-head
CI/review and merge remain pending at this checkpoint. Later verified Git/checks
and `.runtime/labour-controls-qa/publication.json` supersede this record.
