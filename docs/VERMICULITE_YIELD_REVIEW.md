# Structural steel vermiculite: yield evidence review

Reviewed 14 September 2026. This records the evidence behind the implemented commercial estimating profile in `data/vermiculite_yield_defaults.json`. `estimator/calculator_defaults.py` exposes the profile as explicit SETTINGS inputs; new unsaved calculator states use it, while existing saved inputs and the original formula graph remain separate. This is not fire-protection design approval. The public PDFs were read, downloaded and hashed, and the material-property and coverage pages were checked visually. No source workbook, packaged formula or pre-existing native Excel expectation was changed.

## Recommendation

The profile replaces CAFCO 300's inherited estimating assumption with its published Australian theoretical coverage. It retains the other four products' existing coverage basis with clearer qualifications and uses the current Australian MONOKOTE bag mass. These are starting estimates before site losses, not guaranteed site yields.

The density fallback must mean **equivalent dry-material consumption per cubic metre of applied coating**. It is inferred from the chosen yield, not a second manufacturer measurement. Installed/cured density and loose-powder SDS density must remain separate reference properties. The direct-yield setting takes priority over this fallback.

| Product | Bag mass kg | Direct yield m³/bag | Equivalent estimating consumption kg/m³ | Selected basis |
| --- | ---: | ---: | ---: | --- |
| CAFCO 300 | 20 | 0.0651 | `20 / 0.0651` = 307.2196620583717… | Australian theoretical coverage, 217 m²/tonne at 15 mm. [Promat, February 2025, PDF p4](https://media.promat.com/doc_367862_au/original/-1912786977/cafco-300-tds-en-au-2025-current.pdf#page=4). |
| MANDOLITE CP2 | 20 | 0.0516 | `20 / 0.0516` = 387.5968992248062… | Australian pack and PDS coverage, 172 m²/tonne at 15 mm; conflicting guide values remain disclosed. [Promat, November 2009, PDF pp2, 4](https://media.promat.com/doc_368491_au/original/1472508648/promat-pds-cafco-mandolite-cp2-en.pdf#page=2). |
| FENDOLITE MII | 20 | 0.031 | `20 / 0.031` = 645.1612903225806… | Theoretical 1.24 m² per 20 kg bag at 25 mm. [Promat guide, September 2008, PDF p15 / printed p13](https://ceasefire.com.au/wp-content/uploads/2024/05/Cafco-FENDOLITE-MII-Application-Guide-AM.pdf#page=15). |
| PERLIFOC HP ECO+ | 17 | `17 / 350` = 0.04857142857142857… | 350 | Tremco Australia's minimum theoretical consumption, 3.5 kg/m²/cm; qualified batch/discontinuous estimating basis. [Australian-hosted product brochure, code 170821, PDF p3](https://www.tremco.com.au/TremcoAustralia/media/SiteAssets/Products/Certification%20and%20Technical%20Documents/Perlifoc%20HP%20ECO/PERLIFOC-HP-ECO-Structural-Steel-Spray-Fire-Protection.pdf?ext=.pdf#page=3). |
| MONOKOTE MK-6 HY | 21.8 | `27 × 0.002359737216` = 0.063712904832 | `21.8 / 0.063712904832` = 342.1598820126450… | Retained uninjected 27 board-foot nozzle-yield assumption. [GCP chart, 2016, PDF p1](https://tfire.com.au/documents/fire-spray-Monokote-Yield-Chart#page=1); current pack [GCP Australia PDS, 29 April 2026, PDF p5](https://gcpat.com.au/sites/default/files/pdf/current/resource/GCPAT_monokote_mk_6hy_mk_6s_au_5546.pdf#page=5). |

The expressions above define the numbers; the displayed decimal expansions are not values to round and feed back into calculations. A physical-density tolerance is not a confidence interval for site coverage. No new wastage percentage is inferred by this research.

## Workbook trace

The immutable source is `Ceasefire_Steel_Vermiculite_Estimator_NEW.xlsx`, SHA-256 `1ea62906d13f2f5d34bae9c6f2391e084f26da5d597c9d69b154ad99579028ad`. This review inspected the packaged source model and `data/calculator_documents.json`, then checked the actual public documents rather than trusting filenames or prior link-status notes.

| Product | SETTINGS bag / direct / density / yield used | Original values and dependency |
| --- | --- | --- |
| CAFCO 300 | D36 / D37 / D38 / D40 | 20 / blank / 390; yield is `20 / 390` = 0.05128205128205128… . D42 explicitly describes inherited assumptions, not verified manufacturer yield. |
| MANDOLITE CP2 | D69 / D70 / D71 / D73 | 20 / `D69*R330*S330/1000` / blank; R330=172 and S330=0.015. |
| FENDOLITE MII | D101 / D102 / D103 / D105 | 20 / `D101*R331*S331/1000` / blank; R331=62 and S331=0.025. |
| PERLIFOC HP ECO+ | D178 / D179 / D180 / D182 | 17 / `D178/(R332*S332)` / blank; R332=3.5 and S332=100. |
| MONOKOTE MK-6 HY | D234 / D235 / D236 / D238 | 21.9 / `R333*S333` / blank; R333=27 and S333=0.002359737216. |

Each Yield used formula chooses a positive numeric direct yield first. A truly blank direct yield permits positive bag mass divided by positive estimating density. A zero, negative or nonempty invalid direct value does not silently activate the fallback. The material-basis notes are D42, D75, D107, D184 and D240. These precedence and blank semantics must remain unchanged.

Changing bag mass alone does not rescale a fixed direct yield. Some original direct-yield formulas reference bag mass; an explicit numeric override replaces that formula. The application profile records its selected basis independently of the immutable original model. Saved/user overrides retain their own inputs.

## Product findings and limits

### CAFCO 300

The Australian February 2025 manual supports `217 × 0.015 × 20 / 1000 = 0.0651 m³/bag`. Its ASTM E605 physical density is 310 kg/m³ ±15% without accelerator, with a separate approximate accelerator adjustment. That physical property neither supports the workbook's inherited 390 nor precisely equals the coverage-derived consumption of 307.219662… . Use the explicit coverage for the estimating default. It is theoretical coverage, with no measured Ceasefire site recovery established. [Promat Australian manual, PDF p4; edition on p6](https://media.promat.com/doc_367862_au/original/-1912786977/cafco-300-tds-en-au-2025-current.pdf#page=4).

### MANDOLITE CP2

The currently available Promat AU-hosted PDS is an older November 2009 edition. It specifies the Australian 20 kg pack and gives `172 × 0.015 × 20 / 1000 = 0.0516 m³/bag`. The listed 390 kg/m³ ±15% is expressly dry and installed density. [Promat PDS, PDF pp2, 4, 6](https://media.promat.com/doc_368491_au/original/1472508648/promat-pds-cafco-mandolite-cp2-en.pdf#page=2).

The April 2010 Promat application guide contradicts that coverage and itself: 285 m²/tonne at 10 mm implies 0.057 m³ per 20 kg; 3.65 m² per 12.5 kg at 10 mm implies 0.0584 m³ per 20 kg. Its separately stated installed density does not settle the discrepancy. Retaining 0.0516 uses the explicitly Australian PDS basis and avoids selecting the larger disputed yields. It is a qualified estimating choice, not proof that either guide figure is a typographical error. [Promat application guide hosted by Ceasefire, PDF p15 / printed p14; edition on PDF p24](https://ceasefire.com.au/wp-content/uploads/2024/05/Cafco-MANDOLITE-CP2-Application-Guide-AM.pdf#page=15).

### FENDOLITE MII

The Asia-Pacific guide hosted by Ceasefire gives both 62 m²/tonne at 25 mm and 1.24 m² per 20 kg bag at 25 mm: both yield 0.031 m³/bag. It identifies practical coverage as dependent on equipment, application and losses. The equivalent powder consumption is 645.161290… kg/m³; the cited 775 kg/m³ installed density is not interchangeable. [Promat guide, PDF p15 / printed p13](https://ceasefire.com.au/wp-content/uploads/2024/05/Cafco-FENDOLITE-MII-Application-Guide-AM.pdf#page=15).

Promat's publicly accessible global PDS corroborates 62 m²/tonne at 25 mm and specifies 20 kg bags outside North America. Its 50 lb North American packaging and board-foot parenthesis must not be substituted for the Australian metric basis. Its web availability is current; this review does not infer a new publication date from search-engine indexing. [Promat global PDS, PDF p2](https://www.promat.com/siteassets/industry/downloads/technical-data-sheets-tds/cementitious-sprays/de/promat-fendolite-mii-product-data-sheet.pdf/Download?v=490367#page=2).

### PERLIFOC HP ECO+

Tremco Australia's brochure gives 17 kg bags and minimum theoretical consumption of 3.5 kg/m² per centimetre: `3.5 × 100 = 350 kg/m³`, hence `17 / 350 m³/bag`. It separately lists density of 550 kg/m³ ±15%. The minimum-consumption figure gives an optimistic theoretical coverage bound; 550 must not replace 350 as if both describe dry powder consumed per coating volume. [Tremco-hosted brochure, PDF p3, document code on p6](https://www.tremco.com.au/TremcoAustralia/media/SiteAssets/Products/Certification%20and%20Technical%20Documents/Perlifoc%20HP%20ECO/PERLIFOC-HP-ECO-Structural-Steel-Spray-Fire-Protection.pdf?ext=.pdf#page=3).

The August 2022 Altex PDS, a manufacturer-branded New Zealand distribution edition, distinguishes 3.5 ±15% kg/m²/cm for discontinuous mixing from 4.1 ±15% for continuous mixing. The latter nominal rate implies `17 / 410 = 0.04146341463414634… m³/bag`. Laboratory mixing conditions affect both yield and hardened density. This is useful corroboration of method sensitivity, not evidence that the New Zealand edition supersedes Tremco Australia's brochure. Do not present one default as valid for every machine. [Altex PDS, PDF pp1–2, distribution statement pp4–5](https://api.altexcoatings.com/download.cfm?download=pds&productid=647#page=1).

### MONOKOTE MK-6 HY

The current Australian manufacturer PDS states 21.8 kg for MK-6/HY; MK-6s is a different 21.3 kg product. Its 240 kg/m³ minimum installed dry density and 640–720 kg/m³ wet mixer range are not purchasing yields. [GCP Australia PDS, updated 29 April 2026, PDF pp3–6](https://gcpat.com.au/sites/default/files/pdf/current/resource/GCPAT_monokote_mk_6hy_mk_6s_au_5546.pdf#page=3).

The GCP chart distributed by Trafalgar lists uninjected nozzle yields of 27, 27.5 and 28 board feet per bag; injected rows are 40, 42, 44 and 45.7. One board foot is `0.3048 × 0.3048 × 0.0254 = 0.002359737216 m³`. Retain the existing 27 row as the specified uninjected estimate. It corresponds to 24.3 pcf in the visual table, not the neighbouring 23.4 pcf row. These are nozzle targets, not installed recovery after overspray. [GCP simplified chart, copyright 2016, PDF p1](https://tfire.com.au/documents/fire-spray-Monokote-Yield-Chart#page=1).

Trafalgar's 030521 manual lists 21.9 kg packs and points to the yield chart. The newer manufacturer PDS wins for nominal current bag mass. The chart does not establish that its yield changes proportionally with this 0.1 kg difference; do not automatically rescale the direct yield. Verify the delivered pack and actual uninjected application basis. [Trafalgar technical manual, PDF p8](https://tfire.com.au/documents/fire-spray-for-steel-protection-technical-manual#page=8).

## SDS checks: useful identification, unsuitable coverage substitutes

| Product | Observed SDS property | Meaning for this review |
| --- | --- | --- |
| CAFCO 300 | Bulk density 50–90 kg/m³; relative density 1. Australian SDS dated 23 April 2026, revision 5. [PDF p3](https://media.promat.com/doc_367854_au/original/157331560/cafco300---2022.pdf#page=3). | Loose-powder/safety properties do not define applied coating yield. The filename still says 2022. |
| MANDOLITE CP2, P20 and patch mixes | Bulk density 230 kg/m³. Australian SDS dated 23 April 2026, revision 3. [PDF p4](https://media.promat.com/pi266219/original/713660739/cafco-cp2-patch-mix-exp-2026.pdf#page=4). | A shared powder SDS is not a product-specific installed consumption measurement. |
| FENDOLITE MII and TG | Bulk density 400–440 kg/m³. Australian SDS dated 23 April 2026. [PDF p4](https://media.promat.com/pi59463/original/17968033/cafco-fendolite-mii-tg.pdf#page=4). | Do not turn this shared loose-powder range into MII applied yield. |
| PERLIFOC HP ECO+ | Specific gravity 0.380; density undetermined. Tremco Australia SDS dated 16 November 2021. [PDF p4](https://www.tremco.com.au/TremcoAustralia/media/SiteAssets/Safety%20Data%20Sheets%20%28SDS%29/Perlifoc_Hp_Eco_-Aust_-_SDS.pdf?ext=.pdf#page=4). | Does not establish 380 kg of powder consumed per m³ of installed coating. |
| MONOKOTE MK-6 HY | Density undetermined. GCP Australia SDS revised 3 September 2024. [PDF p5](https://tfire.com.au/documents/MONOKOTE-MSDS#page=5). | Provides no alternative application yield. |

The existing document registry describes CAFCO and CP2 SDS contents as December 2022. Both stable URLs now return April 2026 content, so those descriptions need reconciliation when the defaults are implemented. Read document contents and dates, not URL filenames.

## Implementation boundary and verification record

The recommended defaults are a separately traceable commercial estimating profile. Keep original source formulas, databases and native Excel fixtures immutable; maintain an explicit way to reproduce the original workbook defaults. Saved calculator inputs and deliberate user overrides must not silently adopt later manufacturer assumptions. Keep unrounded values in calculation, persistence and export; display precision must not become arithmetic precision.

The later user presentation instruction removes the visible reviewed-yield action
and review panel, and omits Settings date/source-ID/document-name metadata. This
developer evidence record deliberately retains its dates, exact document titles,
URLs, qualifications and derivations. Removing visible provenance does not delete
the retained source material or change a selected yield.

Material-basis text is now read-only. New arbitrary edits are rejected at HTTP
and storage-save boundaries; exact existing saved overrides are preserved, and
original-source/reviewed-default text can still be restored through Reset. The
low-level evaluator continues to accept historical evidence overlays. Numeric
material settings remain adjustable, and the profile still applies only to new
unsaved states or an explicit reset. The latest worksheet hiding/colour/width
changes do not modify quantities or the existing PDF contents.

No new passive-fire thickness or suitability rule follows from this review. Native Microsoft Excel 16.0, build 20326, was used on 14 September 2026 to recalculate a byte-identical disposable copy of the original workbook. Macros, external links and events were disabled; the workbook was not saved. Both the original and disposable copy retained SHA-256 `1ea62906d13f2f5d34bae9c6f2391e084f26da5d597c9d69b154ad99579028ad` after capture.

The five retained scenarios cover the original defaults without any overlay, reviewed direct yields for all five products, blank direct yields with equivalent-density fallback, precise user yield and waste overrides, and invalid direct/fallback values. Each varied scenario has two representative rows per product plus a last-row sentinel, exercising decimal lengths, area overrides, pooled product purchasing totals and cleared rows. Representative steel inputs came from previously captured native Excel quantified examples; no expected value came from the application's engine.

All 6,565 selected outputs matched the application engine. An additional test used the actual installed `default_calculator_inputs('steel_vermiculite')` profile with the independently captured schedule, checking 863 numeric and quantity-status outputs against native Excel. Reviewed basis text was deliberately excluded from this additional comparison because it replaces the original workbook's old commentary. Numeric comparison used absolute tolerance `1e-10` and relative tolerance `1e-12`; strings, errors, booleans and blanks used exact comparisons. The four focused regression tests passed in 19.405 seconds. This proves both the explicit input scenarios and the implemented default profile produce the captured quantities; commercial-default persistence and final application checks are verified separately by the main implementation task.

Reproduction uses `scripts/prepare_yield_scenarios.py --output-directory <new ignored run directory>`, followed by `scripts/capture_calculator_oracle.ps1 -PlanPath <run directory>/plan.json -OutputDirectory <run directory>/results` in PowerShell 7 with native Excel available. The preparation script refuses to overwrite an existing run directory and checks source/copy hashes. Exact unmodified native capture bytes are retained in `tests/fixtures/calculators/steel_vermiculite-reviewed-yields.json.gz`, with hashes and provenance in its adjacent `.meta.json`; `tests/test_reviewed_yield_parity.py` performs the regression. The existing original-default and varied-input fixtures remain unchanged.

Research artifacts are ignored under `.runtime/yield-review/`: `sources.json` records the 15 downloaded source PDFs, canonical and final URLs, SHA-256 hashes and PDF metadata; extracted page text and selected renders support the visual checks. `evidence-draft.json` records the proposed numeric inputs, calculation basis and qualifications. Full source documents are research artifacts, not new runtime dependencies or files to commit.
