# FIRETEX intumescent calculation policy

Steel (intumescent) supports FIRETEX FX5090 and FIRETEX FX6010 alongside Nullifire SC902. Existing calculator ID, schedule coordinates, SC902 settings and compatibility source hash remain unchanged. New product settings are independent persistent fields; browsing a settings panel does not copy values between products.

## Authority

The supplied BRANZ certificates contain the loading tables used for DFT:

| Product | Certificate | Issued | Tables | Source SHA-256 |
| --- | --- | --- | --- | --- |
| FX5090 | FC20571/01/C1 | 8 April 2025 | 1-40 | `3e26ff0c292717614fa8a6b5a691913b9f6ddfd0b8f44158d174ec74219fe07a` |
| FX6010 | FC21221-01-1-C1 | 31 October 2025 | 1-46 | `3b3703934511e1e30c86474fb023aee343f66a172537e9adcbcc1588cad6c5c3` |

They reference full assessments FC20571-01-1 and FC21221-01-1. A certificate is not a substitute for the complete assessment or project suitability review. DFT is intumescent only, excluding primers and topcoats. Decimal millimetres are converted exactly to integer micrometres; published dashes remain unavailable.

## Scope and selection

I/H three-sided beam tables require concrete slab contact. Four-sided I/H columns and beams have separate schedule choices. RHS/SHS three-sided beams also require slab contact. Fully exposed RHS/SHS columns, CHS columns and four-sided RHS/SHS beams use the applicable table family; circular beams are unsupported.

| Product | I/H 3-sided beam | I/H 4-sided column | RHS/SHS 3-sided beam | Hollow 4-sided column |
| --- | --- | --- | --- | --- |
| FX5090 periods (min) | 15,20,30,45,60,75,90,105,120,150,180 | same | 15,30,45,60,75,90,105,120,150 | 15,20,30,45,60,75,90,105,120 |
| FX6010 periods (min) | 15,20,30,45,60,75,90,105,120 | same plus 150 | same as 3-sided I/H | same as 3-sided I/H |

FX6010 has separate rectangular and circular column tables and temperature axes. FX5090 has a shared hollow-column table. The four-sided beam transfers use the column tables subject to both the certificate's beam factor range and DFT cap: FX5090 I/H 5.282 mm, RHS/SHS 5.180 mm; FX6010 I/H 5.770 mm and factor 400 m^-1, RHS/SHS 5.661 mm and factor 350 m^-1. Unavailable cells and these caps still apply at every period.

FIRETEX requires an exact temperature printed in the selected table. It does not inherit SC902's temperature-floor or below-minimum-factor permission. FX5090 contains temperature nonmonotonicities (Tables 11 and 39), so temperature flooring cannot be assumed conservative. For an in-range factor between printed rows, the next higher row is an application estimating policy, not report-authorized interpolation. Both bounding cells must be numeric and nondecreasing; otherwise the interval is withheld. There is no interpolation, extrapolation or filling of blank cells.

The actual printed cells remain authoritative even where source summaries differ: FX5090 Table 23 prints 0.192 mm while the cover lists a 0.201 mm RHS/SHS beam minimum. Table 37's heading says Hollow Beams but its explicit footnote identifies four-sided hollow columns and the capped rectangular-beam transfer.

Section factor is m^-1. A/V and Hp/A are equivalent for the same heated perimeter; ESA/M (m²/t) is converted using the selected product's steel density. Named sections provide retained geometry only and must match the selected member family and exposure.

## Quantity settings

FX5090 starts with [Dulux PC112 January 2026](https://www.duluxprotectivecoatings.com.au/media/2d2oftc5/firetex_fx5090_jan_2026.pdf): one component, 69% volume solids, 18 L packs. The published 1.39 kg/L transport weight is labelled as an editable mass estimate. Litres = area × DFT(mm) / solids; pack rounding and waste apply once per product.

FX6010 is the two-component Australian product described by [Dulux PC115 March 2026](https://www.duluxprotectivecoatings.com.au/media/a4xpo0tq/firetex_fx6010_march_2026.pdf): an 18 L kit, 71:1 A:B by volume and 92% volume solids. The project owner confirmed on 24 October 2026 that the certificate's three-component description is a typo. This clarification does not alter the retained certificate bytes or its DFT tables.

New and explicitly reset estimates start with 18 L and 92% solids, so litres and whole kits can be calculated without density or component masses. The linked Australian SDS identify [Part A as 17.75 L, code 783-H0379](https://go.lupinsys.com/duluxgroup/harms/pm/3739868c196437476cf0724526e2d06b-published/attachment/aus-ghs.pdf) and [Part B catalyst as 0.25 L, code 976-H0393](https://go.lupinsys.com/duluxgroup/harms/pm/a32eba52f1e98495a8d32cd6af2bbb30-published/attachment/aus-ghs.pdf). These volumes are not kilograms. The PDS's 1.46 kg/L transportation average is not seeded as a verified mixed density; mixed density and exact A/B masses remain blank and editable. Component-mass basis uses A+B and requires positive A/B masses and mixed density. Missing masses or density leave the corresponding kilogram outputs unavailable without blocking volume-based kit orders.

Saved input values, including omitted fields and explicit blanks, are not filled or migrated on load. The FX6010-only **Use Australian kit defaults** action updates the pack settings after confirmation, preserves schedule rows, other products, waste and steel density, and remains unsaved until Save. The old H74 Part C address remains accepted for project compatibility. A retained nonzero or invalid Part C value holds FX6010 material quantities with a review message; it is never silently added to or discarded from the two-component kit. Blank or numeric zero C is accepted. The action explicitly clears that legacy value. DFT remains available during quantity review.

SC902 retains its published consumption calculation. Each product pools demand independently, applies its own waste once, then rounds up packs once. Unresolved items withhold that product's complete order; another product's valid order remains available. Full schedule details and PDF/XLSX exports retain product identity, table locator, source hashes and held statuses.

## Private installation and packaging

Complete matrices and source PDFs stay outside the repository and source ZIP. Import scripts reproduce the reviewed private JSON from the exact supplied PDF. Runtime and installer gates require the pinned bytes and valid schema; missing or altered evidence withholds only the affected product. Fresh evidence snapshots participate in calculation-cache identity.

For source mode set `CEASEFIRE_CALCULATOR_EVIDENCE_DIRECTORY` to an absolute directory outside the source checkout, containing the reviewed `firetex-fx5090-fc20571-01-c1.json` and `firetex-fx6010-fc21221-01-1-c1.json` alongside existing authorities. Deliverable installers require all five reviewed assessment files. Keep the SC902 report hash as the historical project compatibility identity; per-product evidence receipts identify the actual thickness sources.
