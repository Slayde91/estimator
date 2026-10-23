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

The supplied FX6010 certificate describes three components, while [Dulux PC115 March 2026](https://www.duluxprotectivecoatings.com.au/media/a4xpo0tq/firetex_fx6010_march_2026.pdf) describes two. FX6010 density, solids, pack volume and component masses therefore start blank. Assessed DFT remains available; material quantities require verified settings for the matching formulation. Volume-based and component-mass-based packs are supported. No component mass or density is invented.

SC902 retains its published consumption calculation. Each product pools demand independently, applies its own waste once, then rounds up packs once. Unresolved items withhold that product's complete order; another product's valid order remains available. Full schedule details and PDF/XLSX exports retain product identity, table locator, source hashes and held statuses.

## Private installation and packaging

Complete matrices and source PDFs stay outside the repository and source ZIP. Import scripts reproduce the reviewed private JSON from the exact supplied PDF. Runtime and installer gates require the pinned bytes and valid schema; missing or altered evidence withholds only the affected product. Fresh evidence snapshots participate in calculation-cache identity.

For source mode set `CEASEFIRE_CALCULATOR_EVIDENCE_DIRECTORY` to an absolute directory outside the source checkout, containing the reviewed `firetex-fx5090-fc20571-01-c1.json` and `firetex-fx6010-fc21221-01-1-c1.json` alongside existing authorities. Deliverable installers require all five reviewed assessment files. Keep the SC902 report hash as the historical project compatibility identity; per-product evidence receipts identify the actual thickness sources.
