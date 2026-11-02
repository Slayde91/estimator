# Document output CEASEFIRE audit

Reviewed 2 November 2026. This is an inventory for the owner's decision. Only the explicitly requested Item Details footer was removed. Other occurrences below were retained.

## Visible document text

| Where | Complete text/context | When it appears |
| --- | --- | --- |
| Shared PDF company header | `CEASEFIRE` / `ABN: 50 612 231 562` / `Phone: 1300 92 62 88` / `Email: sales@ceasefire.com.au` | These are the default company details. Saved company settings replace them. Confirmed in generated Breakdown, Item Details and certificate samples using the defaults. |
| Installation Certificate exclusions | `Certification is strictly limited to works completed by CEASEFIRE, as per:` | The company name is inserted from company settings. The displayed label also begins `Exclusions - `. |
| Installation Certificate declaration | `CEASEFIRE are approved by the manufacturers listed above to supply and install passive fire products in accordance with tested and certified systems. I am a properly qualified person and have a good working knowledge of the relevant codes and standards referenced above. The information contained in this statement is true and accurate to the best of my knowledge.` | Again, CEASEFIRE is the configured company name, rather than fixed declaration wording. |
| Pricing Library XLSX, Instructions A1:B1 | `CEASEFIRE PRICING LIBRARY` / `Edit products and services` | Current pricing workbook download. |
| Earlier pricing workbook, Instructions A1:B1 | `CEASEFIRE INVENTORY & RATES` / `How to update the combined pricing library` | Legacy exporter retained for compatibility; verified directly, not the current Pricing Library download. |
| Schedule template XLSX, Instructions A1:B1 | `CEASEFIRE SCHEDULE TEMPLATE` / calculator title | Verified for Steel (spray), Steel (intumescent), Steel (board) and Ductwork (spray/wrap). |
| Firestopping Item Details PDF footer | `Ceasefire ESTIMATOR \| Current captured item` | Removed as requested. Page numbers remain. |

The name, email, exclusions sentence and declaration use the shared company settings in `estimator/company_settings.py`, `estimator/report.py` and `estimator/certification_report.py`. With a custom company name/email the generated Item Details sample contains no CEASEFIRE in its visible text, while its PDF metadata still does.

## File properties and spreadsheet comments

These are complete field values, not sentences in the printed page.

| File/output | Property/context | Complete value |
| --- | --- | --- |
| Firestopping Item Details PDF | Title | `Ceasefire - Current Firestopping item` |
| Firestopping Item Details PDF | Author | `Ceasefire` |
| Breakdown PDF | Title fallback when the quote has no title key | `Ceasefire estimate` |
| Installation Certificate PDF | Author | Configured company name; `CEASEFIRE` with defaults |
| Calculator schedule and Firestopping Item Details XLSX | Creator | `Ceasefire` |
| Takeoff register XLSX | Creator | `CEASEFIRE` |
| Physical diagnostic XLSX | Title | `CEASEFIRE physical graph - UNAPPROVED DRAFT` |
| Physical diagnostic XLSX | Creator | `CEASEFIRE` |
| Physical matrix PDF | Author | `CEASEFIRE ESTIMATOR` |
| Older marked drawing export path | Title / Creator | `CEASEFIRE marked drawing` / `CEASEFIRE ESTIMATOR` |
| PDF page tools output | Title / Creator | `CEASEFIRE PDF page tools` / `CEASEFIRE ESTIMATOR` |
| Schedule template and legacy pricing header-cell comments | Comment author | `Ceasefire` |

The comment author was found on 56 cells across the generated templates and legacy pricing sample. The actual comment text is field guidance; all full comment texts and cell addresses are retained in the machine-readable audit. The newer batch marked-drawing exporter already uses `CLASSIFIRE Takeoff markups` and `CLASSIFIRE ESTIMATOR`.

## Supporting document references

The shipped data also retains the following real source references. They are distinct from application branding and were left intact:

- `Ceasefire Price List March 2025.pdf`
- `Ceasefire Price List March 2025.pdf; SHA256=ec9efbc5b3f8051c055421f15a40fdd26122c162c71a88eae6292e248b2ac681; page 1`
- `TBA - Ceasefire.pdf`
- `TBA - Ceasefire.pdf; SHA256=1dd8616beec76cd6292d7267466742b90aff5d90c2cfd15a617f9ce0d7277040; page 1`
- `https://ceasefire.com.au/wp-content/uploads/2024/05/Cafco-MANDOLITE-CP2-Application-Guide-AM.pdf`
- `https://ceasefire.com.au/wp-content/uploads/2024/05/Cafco-FENDOLITE-MII-Application-Guide-AM.pdf`

These occur in pricing provenance and vermiculite yield/reference data. They were found by source/data inspection, not as visible text in the empty schedule samples. Exported reference text depends on the selected product, references and document type.

## Download names and internal compatibility

The repository still contains exporter names such as `CEASEFIRE-Estimate.pdf`, `CEASEFIRE-Full-Schedule.pdf`, `CEASEFIRE-Full-Product-Summary.pdf`, `CEASEFIRE-Technical-Item.pdf`, `CEASEFIRE-Technical-Item.xlsx`, `CEASEFIRE-Firestopping-Item.pdf`, `CEASEFIRE-Firestopping-Item.xlsx`, `CEASEFIRE-Firestopping-Estimate.pdf`, `CEASEFIRE-Firestopping-Schedule.xlsx`, `ceasefire-pricing.xlsx`, calculator-specific `ceasefire-…` names, and `CEASEFIRE-…-Takeoffs.xlsx` / physical draft names.

The existing local runtime separately normalizes public download names, including `BREAKDOWN.pdf`, `FIRESTOPPING_ITEM.pdf` and `STEEL_SCHEDULE_SPRAY.xlsx`. That local filename work is not part of this change. Consequently an old exporter filename constant alone does not establish the current local Save dialog name. Frozen revision filenames can retain earlier names.

The project JSON format identifier `ceasefire-project`, default project filename `CEASEFIRE-Project.cf.json`, `.ceasefire-evidence` storage paths, workbook source filenames, font aliases such as `CeasefireVera`, and JavaScript namespaces such as `CeasefireDownloads` are compatibility/internal names. They are not additional printed sentences. Original workbook data retains CEASEFIRE headings; the sampled authored calculator schedules did not print those headings.

## Evidence and limits

Nineteen generated PDF/XLSX samples were inspected with pypdf/openpyxl; the edited Item Details PDF was also rendered with Poppler and visually checked. The samples produced 22 visible occurrences (including repeated company headers), 15 metadata fields and 56 comment-author occurrences. Source inspection covers the exporter constants plus shipped compressed/plain JSON data. Generated calculator schedules, templates and takeoff registers were included.

Local evidence directory: `C:\ESTIMATOR\outputs\document-labels-status-audit-20261102`. It includes sample files, `generated-output-findings.json` (full text and comments), `source-contexts.json`, `catalog-data-contexts.json`, and `reference-data-contexts.json`.

This cannot certify arbitrary user-entered content, uploaded cover sheets, original manufacturer PDFs, all saved projects or frozen historical downloads. Those can contain their own CEASEFIRE references. No other branding or supporting reference above was changed pending the owner's decision.
