# Session handoff

## Current work — 2026-09-13

Working checkout: `C:\ESTIMATOR\app`. Implementation branch: `feat/pricing-workbook-library`, based on `fix/windows-launcher` (`3b02f99`) above main (`615997c`). Local verification is complete below. GitHub PR/CI/merge results must be read from the publication record; the previous launcher PR #3 had an Actions billing failure, which is not an application test result.

User scope: add Excel export/import to Pricing library, support adding/removing products and dropdown choices, apply imported rates on Save, and remove redundant legacy cell references from the estimator and PDF presentation.

Implemented exchange: Export Excel writes the whole effective draft to Inventory, Rates and Instructions sheets. Import Excel validates the complete workbook and returns added/removed/updated counts. The UI reviews and applies it to the draft; Save pricing commits the active library. Import alone does not persist anything. Deleted products must also be removed or unlinked from Rates. Existing IDs stay stable; blank new IDs are assigned automatically. Users can supply a matching unique Inventory ID on both sheets to link a new product and choice together.

Pricing behavior: Supplier markup recalculates sell price after supplier/markup changes; unchanged inputs preserve stored values. Manual items accept direct sell prices. Inventory price source follows the linked item; editing a unit sell rate creates an Override, and choosing Inventory restores the link. Number, Blank, Empty text and Not used yield types preserve the engine's existing semantics. Inventory description blanks and descriptive dimension ranges from the initial source also survive exchange.

Storage change: configuration JSON gains optional `catalog` while retaining separate inventory/rates overrides. Original `data/baseline.json` stays immutable. New quote snapshots embed the used catalog and every effective lookup price/yield, preserving removed/renamed products through later library replacements. Old snapshots without `catalog` continue against the original baseline with signature protection. Explicit Use current pricing adopts the new library and leaves removed selections visibly unresolved until corrected. Source hashes retain original quote lineage and record imported pricing files. SQLite schema remains version 1; no eager migration or quote rewrite is required.

Presentation change: visible worksheet addresses are replaced by named inputs, cost categories and error descriptions in the estimator and PDFs. The complete materials/labour breakdown and supplied official logo remain. Worksheet keys remain internally in the explicit formula engine, stored outputs, tests and developer mappings; no Calculator arithmetic or source fixture was changed.

Dependencies: `requirements.txt` pins ReportLab 4.4.9 and openpyxl 3.1.5. Windows startup checks every pinned package, not only ReportLab. Import accepts the exported values-only `.xlsx` layout, at most 5 MB and 5,000 rows per list, and bounds archive contents. It rejects formulas, macros, external links, invalid headers, unsupported groups, duplicate choices and missing inventory links. Both data sheets participate in full, including hidden/filtered rows. Arbitrary supplier layouts are not automatically interpreted.

## Verification at this update

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

PDF reporting retains all 29 non-overlapping cost components and the supplied logo unchanged. Logo SHA-256: `b390a843144556546558d166207f476d7e2197070ec35a1a23064fbbb7da9ac7`. Saved report generation uses stored results without the original workbooks, OneDrive assets or current-pricing requests. Current visual checks are recorded above.

Workbook behaviors retained include double masking material adjustment, quantity-driven global adjustments, weekly access charging, no separate pinning labour and distinct blank/empty-text yields. Workflow labels use manually assessed coverage and quantities. No new geometry, thickness, FRL or technical suitability rules are supported without further authoritative business evidence.

Runtime databases, QA exports, bytecode and distribution archives remain ignored. Original XLSM and lock files are not committed. No public deployment, Windows login task or branch deletion is part of this feature.
