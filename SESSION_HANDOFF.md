# Session handoff

Working checkout: `C:\ESTIMATOR\app`. Sources remain at `C:\ESTIMATOR\Quote.xlsm` and `C:\ESTIMATOR\Inventory_list.xlsm`. Root was not a Git repository; its files were preserved. Remote baseline was `origin/main` at `18d5058`, with no open PRs or other remote branches at inspection.

Implementation branch: `feat/calculator-excel-parity`. The repository includes runtime code, imported data, UI, independent Excel fixtures, extraction/capture scripts, tests, architecture and scope documentation. See the branch/PR history for publication evidence.

Run: `python -m estimator` from the checkout. Default URL is `http://127.0.0.1:8765`. Data is local SQLite at `.runtime/estimator.sqlite3`. Build: `python scripts/build.py`; archive goes to ignored `dist/`.

Checks: `python -m unittest discover -s tests -v`, `node --check static/app.js`, `python scripts/build.py`. Set `ESTIMATOR_WORKBOOK_DIR=C:\ESTIMATOR` to include both source-reconstruction tests. Without source files, those two optional checks skip but all Excel scenario fixtures remain required.

Observed local validation: all 36 tests passed with both original source workbooks included. JavaScript syntax and Python distribution build passed. Browser checks exercised all 64 visible input controls, decimal spray adjustments (total 3767.746652, displayed $3,767.75), quote saving, supplier price 100 and markup 40% (sell price 140), preserved saved pricing, and explicit repricing (total 4689.450842, displayed $4,689.45). This is evidence of the checked scenarios, not a claim of original XLSM live-link execution or public deployment.

The independently captured Excel fixture contains 216 scenarios ×151 outputs. Default source results match all151 formulas. Workbook issues retained: double masking material adjustment, quantity-driven global adjustments, weekly hire under a daily label, no separate pinning labour and blank B56. Cached empty text and true blank yields remain distinct.

No technical suitability rules were inferred. The next product extension beyond Calculator parity requires authoritative quantity/coverage/thickness/FRL rules not present in the source files. Preserve the current tested formula behavior when adding any new workflow.

Temporary inspection evidence lives in `C:\ESTIMATOR\.workbook-audit` and `.inventory-audit`, outside the application repository. Runtime database, bytecode and distribution archives are intentionally ignored; source XLSM and lock files are not committed. No deployment or branch deletion is authorized by a publication result alone.
