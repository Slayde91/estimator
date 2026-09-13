# Session handoff

## Current estimate-details work — 2026-09-13

Working checkout: `C:\ESTIMATOR\app`. Feature commit `75c16ee0308a9e1dfba584e1525171ecaebbe497` (Add project details, automatic work summaries and polished quote presentation) was committed and pushed on `feat/estimate-details-and-polish`, tracking the matching origin branch. [PR #5](https://github.com/Slayde91/estimator/pull/5) targets main and includes the prior launcher and pricing-library changes from #3 and #4. Both fresh Checks runs (`34757647608`, `34757674356`) failed before any job step executed: GitHub reports failed account payments or a spending-limit issue. The PR is open, has no reviews and has not merged. Local validation passes; CI success is not claimed. Resolve GitHub billing, rerun Checks on the current PR head, then merge after successful checks.

Current scope adds Project No., Client and Site Address; automatic quote names; a generated work summary; two-decimal display; removal of the Print button in favour of PDF download; and interface refinement using the official logo/brand colours. Pricing exchange remains a whole-library draft/review/Save replacement, and the original pricing baseline stays immutable.

Quote details are bounded optional strings: project number 100 characters, client 200 and site address 400, with control characters rejected. The title joins populated values in project/client/site order with the exact separator `- `, yielding `Project No.- Client- Site Address`; omitted parts do not add separators. The combined title can be 704 characters. Legacy titles remain for older records without metadata; a new empty estimate is `Untitled quote`. Metadata-only updates preserve saved inputs, workflow, measurements and pricing. Explicit empty metadata clears it, and clearing all details on a metadata-based quote falls back to `Untitled quote` unless an explicit legacy title is supplied.

`estimator/quote_details.py` provides validation, deterministic naming and `compile_work_summary(workflow, result)`. It reads existing inputs and calculated values, reuses the material/addition mappings, and describes active products/quantities/yields/wastage, labour teams/days, masking, selected services, extra labour and adjustments. Server calculations supply the summary to the UI, and quote saves store it. Older PDFs derive a display-only summary from their stored result if needed. It is local formatting over existing facts, with no external AI, technical-suitability inference, geometry calculation or duplicate pricing formulas.

Amounts and quantities use two decimal places in app controls, generated numeric text, PDF presentation and XLSX number formats. Viewing or saving untouched data preserves its raw values and unrounded calculation results. Deliberately editing an app numeric input stores two displayed decimal places; percentages are then converted to fractions. Excel number formatting leaves the exported underlying numeric values intact. Literal product names, IDs and free-text notes are preserved. PDF download is now the report action; no separate Print UI button remains.

The new fields and summary extend existing quote JSON. Existing configuration JSON, SQLite schema/version, original workbook inputs/formulas and oracle fixtures remain unchanged. No old quote is rewritten merely by reading or reporting it. Current UI, PDF and spreadsheet visual verification is recorded below; it used fresh outputs rather than prior screenshots.

Fresh source review: `Quote.xlsm` SHA-256 remains `97fd43c4e55d3744e4348bf3596a3ab2a67357f12891524bfdb115f43b45c1a0`; `Inventory_list.xlsm` remains `1da308509611a8c099c62d29acc310d3d39ec6a84176e895f39e8711eba720e1`. All 26 catalog checks including both original-source reconstructions and all eight calculator checks including the 216 × 151 independent Excel oracle passed. No source workbook, immutable baseline, calculator formula or oracle fixture changed.

### Current feature verification

All 96 Python tests passed in 318.045 seconds with the original source checks enabled. All 17 UI tests, JavaScript syntax and diff checks passed. Independent review found no actionable issues in server/storage/quote-details/report semantics, preservation of raw numeric precision or legacy snapshot compatibility.

All 20 pages of three newly generated PDFs were rendered and visually checked: normal estimate (six pages), calculation errors (six), and long metadata (eight). The exported Inventory and Rates sheets were independently rendered, confirming two-decimal presentation while their underlying raw numeric values remained unchanged.

The packaged distribution contains 20 runtime files. Its smoke checks passed for metadata, automatic naming, persistence, generated work summaries and PDF reporting. Pricing export/import retained exact calculator cells. Desktop and 390 px phone browser checks passed for metadata and naming, workflow/product changes, two-decimal presentation, saving/reopening, and navigation scroll behavior.

The main local app at port 8765 was refreshed using the Windows PowerShell 5.1 launcher. Its two saved quote rows and zero settings rows were preserved exactly. The SQLite file bytes changed only at header counters (bytes 27 and 95), so a whole-file hash change was not interpreted as changed quote data. The stored-content SHA-256 remained `9acf16b5c3276ceb95ff8e8e361ab22185cdfaf5aa99a92fd8bdc66d42a8139c`. Local runtime/QA/build artifacts remain ignored. These verified local results do not establish GitHub CI, push or merge outcomes.

## Prior pricing-library delivery — 2026-09-13

Working checkout: `C:\ESTIMATOR\app`. Implementation branch: `feat/pricing-workbook-library`, based on `fix/windows-launcher` (`3b02f99`) above main (`615997c`). Local verification is complete below. GitHub PR/CI/merge results must be read from the publication record; the previous launcher PR #3 had an Actions billing failure, which is not an application test result.

User scope: add Excel export/import to Pricing library, support adding/removing products and dropdown choices, apply imported rates on Save, and remove redundant legacy cell references from the estimator and PDF presentation.

Implemented exchange: Export Excel writes the whole effective draft to Inventory, Rates and Instructions sheets. Import Excel validates the complete workbook and returns added/removed/updated counts. The UI reviews and applies it to the draft; Save pricing commits the active library. Import alone does not persist anything. Deleted products must also be removed or unlinked from Rates. Existing IDs stay stable; blank new IDs are assigned automatically. Users can supply a matching unique Inventory ID on both sheets to link a new product and choice together.

Pricing behavior: Supplier markup recalculates sell price after supplier/markup changes; unchanged inputs preserve stored values. Manual items accept direct sell prices. Inventory price source follows the linked item; editing a unit sell rate creates an Override, and choosing Inventory restores the link. Number, Blank, Empty text and Not used yield types preserve the engine's existing semantics. Inventory description blanks and descriptive dimension ranges from the initial source also survive exchange.

Storage change: configuration JSON gains optional `catalog` while retaining separate inventory/rates overrides. Original `data/baseline.json` stays immutable. New quote snapshots embed the used catalog and every effective lookup price/yield, preserving removed/renamed products through later library replacements. Old snapshots without `catalog` continue against the original baseline with signature protection. Explicit Use current pricing adopts the new library and leaves removed selections visibly unresolved until corrected. Source hashes retain original quote lineage and record imported pricing files. SQLite schema remains version 1; no eager migration or quote rewrite is required.

Presentation change: visible worksheet addresses are replaced by named inputs, cost categories and error descriptions in the estimator and PDFs. The complete materials/labour breakdown and supplied official logo remain. Worksheet keys remain internally in the explicit formula engine, stored outputs, tests and developer mappings; no Calculator arithmetic or source fixture was changed.

Dependencies: `requirements.txt` pins ReportLab 4.4.9 and openpyxl 3.1.5. Windows startup checks every pinned package, not only ReportLab. Import accepts the exported values-only `.xlsx` layout, at most 5 MB and 5,000 rows per list, and bounds archive contents. It rejects formulas, macros, external links, invalid headers, unsupported groups, duplicate choices and missing inventory links. Both data sheets participate in full, including hidden/filtered rows. Arbitrary supplier layouts are not automatically interpreted.

## Prior pricing-library verification

All 77 Python tests passed in 110.876 seconds, including both original-workbook reconstruction checks and all 216 independent Excel scenarios before and after export/import. Eight JavaScript UI transition checks pass and now run in CI. They protect concurrent edits, separate confirmation dialogs, saved-quote dropdown isolation, import cancellation and draft-only application. JavaScript syntax and diff checks pass.

Repeatable checks:

```powershell
python -m pip install -r requirements-dev.txt
$env:ESTIMATOR_WORKBOOK_DIR = 'C:\ESTIMATOR'
python -m unittest discover -s tests -v
node --check static/app.js
node tests/test_ui.cjs
python scripts/build.py
```

Independent artifact-tool inspection/rendering checked all three workbook sheets. A valid editor output without optional worksheet dimensions exposed a compatibility bug; regression now covers missing and stale dimensions without dropping rows. Browser QA imported that edited workbook into a separate database: one product and one rate remained drafts until Save, then the new choice used its $125 rate for 12 priced units ($1,500), with a $3,866.56 quote total. HTTP tests also delete choices and confirm historical quotes retain their original results and options. Export returned valid XLSX bytes and the browser invoked the export endpoint; the in-app browser did not expose its download event to automation.

All five pages of the revised complete-breakdown PDF were rendered and visually checked, and six PDF tests preserve the numeric and snapshot assertions. The distribution builds with 19 runtime files; its extracted import/export, exact default calculation and PDF smoke checks pass. Windows PowerShell 5.1 launched the app with both pinned dependencies. The live server at port 8765 was refreshed, preserving the one saved quote, zero settings rows and checksum `2a71afce674c21f23dfcb825dbf2f4be36bcf303b945c9422db8035512cfb368`. QA databases, workbooks, renders and logs remain ignored under `.runtime`; the archive is ignored under `dist`. No original source data, calculator arithmetic or oracle fixture changed.

## Operating and evidence context

Original sources remain at `C:\ESTIMATOR\Quote.xlsm` and `C:\ESTIMATOR\Inventory_list.xlsm`, outside the application checkout. The initial root was not a Git repository and its files were preserved. The original remote was README-only at `18d5058`; subsequent implementation and startup work are preserved in repository history.

Run by double-clicking `Start-Estimator.cmd`, or install `python -m pip install -r requirements.txt` and run `python -m estimator` from the checkout. Default URL is `http://127.0.0.1:8765`. Saved quotes/settings use `.runtime/estimator.sqlite3`; stop the application before making a file backup. After Windows restarts, run the launcher again. Startup logs and QA files are ignored under `.runtime`; the build archive is ignored under `dist/` and includes runtime requirements, launcher files and the original logo.

Prior independent evidence established default source results and 216 Excel scenarios × 151 outputs. The original XLSM would not open through Excel automation; scenario capture used verbatim Calculator formulas in a fresh macro-free harness with frozen Lists values. This demonstrates formula/fixed-lookup parity, not the original workbook's live external-link refresh. Keep the committed fixture independent of the application engine.

PDF reporting retains all 29 non-overlapping cost components and the supplied logo unchanged. Logo SHA-256: `b390a843144556546558d166207f476d7e2197070ec35a1a23064fbbb7da9ac7`. Saved report generation uses stored results without the original workbooks, OneDrive assets or current-pricing requests. Both historical pricing-library checks and fresh current estimate-details/report checks are recorded above with their separate scopes.

Workbook behaviors retained include double masking material adjustment, quantity-driven global adjustments, weekly access charging, no separate pinning labour and distinct blank/empty-text yields. Workflow labels use manually assessed coverage and quantities. No new geometry, thickness, FRL or technical suitability rules are supported without further authoritative business evidence.

Runtime databases, QA exports, bytecode and distribution archives remain ignored. Original XLSM and lock files are not committed. No public deployment, Windows login task or branch deletion is part of this feature.


Current local classification: the tracked implementation and documentation belong to this feature. Synthetic QA databases, PDF/XLSX renders, test logs, the local restart snapshot and generated packages remain ignored under `.runtime` and `dist`. The original XLSM sources remain outside the checkout. No unrelated user changes were staged; no branches were deleted. Temporary QA browser/server sessions were closed, and the normal local server remains available at port 8765.
