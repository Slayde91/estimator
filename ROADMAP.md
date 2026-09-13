# Roadmap

## Implemented

- Reconcile the empty remote repository and preserve original local workbooks.
- Extract 417 inventory records, 166 dropdown values, all 64 Calculator inputs and 151 formulas with source traceability.
- Translate all Calculator numeric and notes formulas, including blank/error behavior and unrounded pricing.
- Expose the Calculator controls, pricing configuration and calculated breakdown.
- Use the supplied Ceasefire logo and provide downloadable PDF quote reports with saved-result/source-lineage preservation.
- Export the complete pricing library to an Excel workbook with Inventory, Rates and Instructions sheets.
- Import added/removed inventory products, dropdown choices and prices as a reviewed draft; apply them only with Save pricing.
- Distinguish linked inventory prices from explicit rate overrides and preserve supported yield semantics.
- Save/reopen quotes with full catalog, input, lookup-price/yield and result snapshots; keep older quote records compatible after library replacements.
- Present named business inputs and cost breakdowns in the estimator and PDF, retaining original cell mappings internally for formula verification.
- Capture project number, client and site address, with automatic quote names and legacy-name compatibility.
- Generate and save a readable work summary from the selected workflow and existing calculated facts, without external AI or new technical rules.
- Display amounts and quantities to two decimal places in the app, PDF and XLSX while preserving untouched raw calculation precision.
- Use PDF download as the report action and remove the separate Print button; retain the official logo and apply its brand colours to the interface.
- Protect calculations with independently captured Excel scenarios and test import, persistence and HTTP behavior.
- Build a distribution without Microsoft Excel or original source workbooks, with declared PDF/XLSX dependencies and the original logo included.
- Start the local application with a Windows double-click launcher that checks all pinned runtime dependencies.

## Current verification and publication

Current work is on `feat/estimate-details-and-polish`, starting from pricing-library commit `ffba327` above main `615997c`. Local verification is complete: all 96 Python tests passed with original-source reconstruction enabled, all 17 UI tests passed, and JavaScript syntax/diff checks passed. The 216 × 151 Excel comparisons remain unchanged. Visual checks covered 20 PDF pages, both exported pricing data sheets, desktop and 390 px phone views. The 20-file distribution passed metadata, naming, persistence, work-summary, PDF and exact-cell pricing round-trip checks. The Windows launcher refreshed the main local app while preserving both saved quotes and settings content.

These results were recorded before Git publication. At reconciliation the prior work remained in open PR #4 and GitHub Actions was blocked by the account billing/spending limit. No new commit, push, successful CI run or merge is claimed here; publication results are recorded separately. The original workbooks, baseline, formulas and independent oracle were not changed.

Prior pricing-library evidence: `feat/pricing-workbook-library` passed all 77 Python tests with the original workbooks available, plus eight UI transition checks and JavaScript syntax validation. Workbook rendering, browser import/review/Save/calculation, five PDF pages, Windows startup and the extracted distribution were checked. All 216 independent Excel scenarios also passed after pricing export/import. These earlier results do not substitute for current-feature checks, and local checks do not imply GitHub CI success.

## Outside the rules supplied by these workbooks

Automatic dimension-to-coverage conversion, steel section-factor/thickness lookup, FRL-based product eligibility and technical system selection have no executable specification in the supplied files. Steel/Duct are blank collection templates with examples. The current workflow labels and manually entered quantities reflect that limit. Additional technical source tables or an approved business specification are needed before implementing these functions.

## Future operational work

An installer, authenticated shared deployment, concurrent multi-user editing and managed backups are not part of the current local application. They require an operating-environment decision; no public deployment has been performed. Existing SQLite quotes can be backed up locally while the application is stopped.
