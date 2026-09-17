# FyreWrap rule review - 17 September 2026

This review separates the continuous duct covering, local penetration layers,
directional fire ratings and material geometry. The existing layer-area formulas
do not add a local second or third layer on top of the same numbered continuous
layer. The unresolved issue is which assessed penetration detail applies to an
external or multilayer system, not a demonstrated duplicate in those formulas.

The figures below are independent calculation expectations. Automated checks
assert these literal quantities separately from the preserved native Excel
fixtures; they do not establish project-specific installation approval.

## Source identity and reading method

- [Current Trafalgar FyreWrap technical manual](https://tfire.com.au/documents/FyreWrap_Technical_Manual):
  printed version `290426`, PDF metadata dated 29 April 2026, 48 pages, SHA-256
  `de05b23cc328d4cb776f4fba767933f2eed539ba19205929e312fa02eff72e1b`.
- [Dated Trafalgar manual](https://docadmin.tfire.com.au/exfiles/FyreWrap%20/TFire_FyreWrap_ductwork_technical_manual_111024.pdf):
  printed version `111024`, PDF metadata dated 11 October 2024, 46 pages, SHA-256
  `556ec9dbc0cbf8ba6834d0c5f071245e502a25ef6377e1c17c1a10b5e7361758`.
- The [external assessment](https://tfire.com.au/documents/FyreWrap-external-fire-test-report)
  reviewed was BRANZ `FC17299-01-1`,
  28 February 2023, 40 pages, SHA-256
  `f3352deadf454964829bcc56ce7a2a53eb50d8f8442ea20512507d7cdc3c98ee`.
- The [internal assessment](https://tfire.com.au/documents/FyreWrap-Test-Report)
  reviewed was CSIRO `FCO-3226 Rev F`,
  31 July 2025, 74 pages, SHA-256
  `22f1ebd6e78ddd9513f3431a0a26e9674129bcfcd17b780583a6a19057215bf9`.

Page numbers below are the printed PDF page numbers. Relevant tables and
drawings were rendered and read visually. Text extraction corrupts some digits
in the manuals' embedded fonts, so extracted numeric strings alone are not
reliable evidence. PDF binaries and rendered pages are not published with this
document.

## Continuous layers and directional FRLs

The current manual's pages 8-9 separate the number of layers from the internal
and external fire ratings. The layer counts cannot be obtained by adding the
internal and external columns together.

| Application in the manual | Continuous layers | External fire FRL | Internal fire FRL |
| --- | ---: | --- | --- |
| Kitchen exhaust inside the kitchen compartment | 1 | Not required in this application table | -/30/30 |
| Kitchen exhaust outside the kitchen, diesel pump ventilation, other exhaust | 1 | Not required in this application table | 120/120/120 |
| Combined kitchen/smoke exhaust, smoke exhaust, stair pressure relief | 1 | 120/120/- | 120/120/120 |
| Stair or fire-escape pressurisation | 2 | 120/120/60 | Not required in this application table |
| Other ducts supplying air to pressurise a compartment | 3 | 120/120/120 | Not required in this application table |

The manual presents these as application requirements for compartments up to
two hours. It does not make `120/120/60` equivalent to `120/120/120`. A generic
full external FRL and a named stair-pressurisation application therefore must
not be treated as the same requirement merely because both contain `120`.
Similarly, the p8 combined exhaust cases have external stability/integrity
requirements without the same external insulation requirement as their internal
rating. A generic `Both` interpretation must not silently demand external
120-minute insulation and replace their one-layer application rule with three
layers.

BRANZ FC17299-01-1 sections 4.2.3-4.2.5 (p.11) and the conclusion (p.16)
assess external exposure as one layer for 180/180/30, two for 180/180/60 and
three for 240/240/120, subject to the report's complete conditions. This
independently confirms that external insulation duration changes the layer
requirement. It does not establish a universal mapping from a single number
such as `120` to a particular application.

## Local layers and the unresolved external detail

For the internal system, manual p12 describes two layers at a wall and a
possible third layer at a floor. Table 4 (p24) names the extension of the second
layer from the wall. Table 5 (p25) separately names second- and third-layer
extensions and explicitly identifies its source as an internal-fire assessment.

The p26 wall drawing shows one continuous layer and one local layer on each
wall face. The floor drawings on pp38-39 show the local extensions above the
slab. CSIRO Rev F sections 3.1-3.2 (pp5-6), Figure 30 (p39), Tables 4-6
(pp43-45) and the field of application (p45) confirm this internal-fire scope
and the top-side floor extensions. `Second layer` means layer number two,
not two additional layers. The third layer is a separate outer layer over its
own stated length.

There is a material difference between the manual editions. The 2024 manual's
p9 two- and three-layer pressurisation rows have no local-layer asterisk. The
2026 manual marks both rows with an asterisk referring to additional local
layers under Tables 4 and 5. However, the external assessment gives different
detail references:

- FC17299-01-1 section 4.4 (p13) refers to Figures 4-7 for the wall collar.
  Figure 7 (p23) and the corresponding plasterboard Figure 11 (p27) show layers
  selected for the required FRL, sealed to the Maxilite interface. They do not
  dimension the internal manual's local second-layer extension.
- Section 4.7 (p15) refers to the external floor detail in Figure 24 (p40).
  That drawing also selects the layers for the required FRL and does not
  dimension the internal table's local second- and third-layer extensions.

The current manual footnote and the assessment drawings do not, by themselves,
resolve how Tables 4-5 are to be combined with two or three continuous layers
for every external application. Neither adding all local allowances nor
subtracting continuous layers is an established universal rule. Unresolved
external/multilayer penetration wrap totals must remain withheld until a
matching assessed detail is identified. This uncertainty must not be displayed
as zero additional material or a complete validated takeoff.

### Existing formulas do not duplicate numbered layers

In the preserved `CALCULATOR` formulas, `R` is the continuous-layer count.
`W` uses the full-run layer-two area when `R >= 2`; otherwise it uses the
eligible local layer-two zones. `X` makes the corresponding choice for layer
three when `R >= 3`. Neither branch sums both alternatives. `V` is layer one,
and `N` sums the available layer areas subject to the eligibility gates.

The internal examples below therefore need one continuous layer plus the
specified local extensions. An external case cannot be certified merely by
observing that the arithmetic avoids duplicate layer numbers.

## Independently calculated examples with overlaps

Use a 10m run, full four-sided rectangular wrap, 38mm blanket thickness,
0.61m roll width, 7.62m roll length and 0.10m overlaps. Added waste is zero.
The requested internal/exhaust rating is 120/120/120. Wall local zones occur
on both wall faces; floor local zones occur above the slab only. The combined
wall/floor example assumes separate zones that fit within the entered run;
it is a quantity fixture, not a drawing approving a particular route.

The existing rectangular material geometry is:

```text
P = 2 * (width + height)                           [dimensions in metres]
t = 0.038; o = 0.10; b = 0.61; r = 7.62
C(k) = P + 8*k*t                                  [outer perimeter, layer k]
Q(k) = C(k) + max(1, ceil(C(k)/(r-o))) * o         [cut length around duct]
n(z) = max(1, ceil((z-o)/(b-o)))                   [axial strips for z > 0]
A(z) = z + (n(z)-1)*o                            [axial material length]
area(k,z) = Q(k) * A(z)
roll equivalents = total material area / (b*r)
```

For these values, a 10m run needs 20 axial strips and `A(10)=11.9m`.
The roll-area denominator is `0.61*7.62=4.6482m²`, not the rounded marketing
area of 4.65m². Every local zone has its own overlaps. These examples do not
activate the existing run-length cap and do not round intermediate results.

The 250x250mm case is within the first manual table band: wall second layer
1.80m per face, floor second layer 2.00m, no floor third layer. The 1000x500mm
case is in the 600-1200mm width / up-to-600mm height band: wall second layer
2.15m per face, floor second layer 2.55m and floor third layer 1.25m. These
values agree with the corresponding 0.6x0.6m and 0.6x1.2m bounding rows in
CSIRO Tables 4 and 6; no shorter interpolated length is assumed.

| Calculation | 250x250mm, 10m | 1000x500mm, 10m |
| --- | ---: | ---: |
| Bare duct surface | 10.0000m² | 30.0000m² |
| Layer-one cut length around duct `Q(1)` | 1.404m | 3.404m |
| Layer-two cut length around duct `Q(2)` | 1.708m | 3.708m |
| Layer-three cut length around duct `Q(3)` | 2.012m | 4.012m |
| Continuous layer one | 16.7076m² | 40.5076m² |
| Extra layer two for one wall, both faces | `1.708*2*2.1 = 7.1736m²` | `3.708*2*2.55 = 18.9108m²` |
| Extra layer two for one floor, top only | `1.708*2.3 = 3.9284m²` | `3.708*2.95 = 10.9386m²` |
| Extra layer three for one floor, top only | 0m² | `4.012*1.45 = 5.8174m²` |
| Total: one wall, no floor | 23.8812m² | 59.4184m² |
| Total: no wall, one floor | 20.6360m² | 57.2636m² |
| Total: one wall and one floor | **27.8096m²** | **76.1744m²** |
| Roll equivalents: one wall and one floor | 5.9828750914 | 16.3879351147 |

The difference between bare duct area and purchased wrap area is explained by
layer thickness, circumferential overlaps, axial overlaps and local extensions.
It is not evidence of duplicate layers. Roll equivalents are not a rounded
whole-roll purchase order.

## Other source boundaries discovered during review

The manual's broad highest wall-size band cannot be treated as a complete
substitute for the detailed report. Manual Table 4 (p24) lists 2.70m / 3.75m
for the 2400-3600mm width-and-height band at 60/120 minutes. CSIRO Rev F
Table 4 (p43) lists 2.90m / 4.10m for an exact 3.6x3.6m duct. The manual
numbers match the report's 2.4x3.6m row, not every larger square in that band.
The source conflict affects that final wall band; it does not invalidate the
two small examples calculated above. Automatic final-band wall quantities
should be withheld rather than treating the summary as a proven upper bound.

Penetration positions are not inputs to the current schedule. Capping summed
local lengths to the total run cannot establish the union of physical zones,
the treatment of short ends, or the correct cut layout. Those installation
details require the actual route. Board collars, angles, fixings and support
requirements remain separate quantities and must not be multiplied by the
number of continuous wrap layers.

## Approved application behavior and regression coverage

The user chose the highest application FRL with the actual directional
requirements retained. The simplified FyreWrap Internal/Both choices therefore
mean the exhaust applications on p8. Known lower application ratings are
promoted to 120/120/120, including kitchen ductwork inside the compartment.
Both denotes internal 120/120/120 and external 120/120/-, not full external
insulation. Stair/Other pressurisation keep their separate p9 rules. A generic
External choice still calls for the selected full external rating; a 60-minute
selection uses two layers and 90/120 minutes uses three. Ratings above the
existing 120-minute automatic-system limit remain unavailable.

All four schedule dropdowns are closed. Canonical aliases apply across loaded
projects, imported schedules, worksheet calculations, PDFs and Excel registers.
Unrecognized historical values remain visible for correction without producing
complete wrap totals. Files and database records are not rewritten on read.
The two steel calculators, generic Excel evaluator, source packages and native
fixtures are unchanged.

Regression coverage is in `test_ductwork_policy.py`, `test_fyrewrap_rules.py`
and `test_fyrewrap_outputs.py`, with browser-state checks in the existing
calculator/project JavaScript suites. It covers the literal hand takeoffs
above, separate wall/floor zones, short-run caps, both pressurisation cases,
generic external ratings, unsupported inputs, row 1000, aliases, strict XLSX
templates, normalized imports, and directional notes in both PDFs and Excel.
The original native parity suite continues to evaluate the unchanged source
formulas separately from the approved application overrides.
