# Architecture

## Verified starting point

GitHub `Slayde91/estimator` contained only README.md at `18d5058` (Initial commit). `C:\ESTIMATOR` contained the two workbooks and an Excel lock file, with no Git checkout or application files. A clean clone was created at `C:\ESTIMATOR\app`; source workbooks were preserved outside the repository. No local commits or divergent implementation existed to reconcile.

## Implementation decision

The initial architecture decision introduced a small local Python application with explicit calculation functions, JSON baseline data, SQLite persistence and a browser interface. The reason was to reproduce the workbook without Excel at runtime while keeping business rules independently testable and avoiding unnecessary dependencies.

Consequences: Python 3.11+ is required; there is no frontend bundler, server framework, remote service or runtime workbook parser. The built-in HTTP server is intentionally restricted to a single local computer. Multi-user hosting would require a separate reviewed authentication/deployment design. Migration impact: initial application creation only; no user database existed. SQLite schema version is 1.

## PDF reporting extension

Current architecture: Calculator results and pricing snapshots already exist in the local application, with a browser print view. The extension adds server-generated PDF reports using ReportLab 4.4.9 and the user-supplied Ceasefire logo. The reason is to provide a downloadable branded document that retains the quote's calculation evidence and can be generated without a print dialog.

Consequences: install `requirements.txt` before running PDF generation; `requirements-dev.txt` adds pypdf for report inspection in tests. Report generation consumes existing calculated or stored results and does not change Calculator formulas. The original logo bitmap is packaged unchanged and scaled proportionally for presentation. Migration impact: no database schema change or quote rewrite is required.

`POST /api/quote-report` builds a report from captured current inputs and pricing without saving a quote. Edited saved quotes include their source quote ID so the server can preserve the original source hashes when pricing is unchanged. `GET /api/quotes/<id>/report.pdf` renders the stored quote's result and source lineage directly, so an unchanged saved report remains available after catalogue changes. The UI selects the saved endpoint only when a saved quote has no unsaved edits. It captures its request before awaiting the response, validates the PDF response and starts a file download through a temporary blob URL.

## Components

| Component | Responsibility |
| --- | --- |
| `scripts/import_workbooks.py` | Developer-only OOXML extraction, shared formulas, original lookup-filter reconciliation and source hashes |
| `data/baseline.json` | Original inventory records, stored selling prices, dimensions/yields and linked Calculator dropdowns |
| `data/calculator.json` | Original editable-field metadata, formulas, default inputs and cached expected values |
| `estimator/catalog.py` | Immutable baseline, validated overrides, supplier/markup propagation and explicit rate precedence |
| `estimator/calculator.py` | Explicit cell-addressed formula evaluation, dependency/error propagation and unrounded binary floating-point results |
| `estimator/storage.py` | Settings, saved full input sets, effective lookup snapshots, result evidence and source hashes |
| `estimator/report.py` | Branded PDF presentation of existing quote results, inputs and source evidence |
| `estimator/server.py` | Loopback-only allowlisted HTTP/JSON interface and request validation |
| `static/` | Accessible input controls, pricing editor, quote persistence, current calculations, original logo, PDF download and print presentation |

## Calculation and state boundaries

The UI sends values only. New or edited estimates recompute prices, calculations and totals on the server; saved PDF reports use their stored results. No expression strings are executed or evaluated. Numeric empty inputs use Excel's blank arithmetic; missing lookup text and empty-text yields retain Excel error propagation. API text selections can produce `#N/A` for imported/invalid values; the UI offers the workbook's dropdown choices and blank affordance. Calculated cells cannot be supplied as inputs.

Imported data never changes at runtime. User configuration stores overrides separately. Changes to an inventory price propagate to every linked rate unless that rate has an explicit override. Changing product display text does not change the source selection key. Quote saves freeze all effective rate prices/yields, not only changed values, so a future default-price refresh does not silently reprice saved work. Removing or renaming source identities requires a deliberate data migration; no runtime import is exposed.

Workbook H contains stored selling prices; P is the supplier-plus-markup formula. The application retains original H until users change supplier/markup, then recalculates the sell value as explicitly required by the product request. This is an editable-pricing extension, documented separately from formula parity.

## Test evidence

Quote configurations carry a fingerprint of lookup IDs, names and inventory links. If a future source import reorders or replaces those identities, recalculation fails with an explicit catalogue-migration message instead of interpreting old prices against new products. The original saved result remains in SQLite. Original source hashes remain attached until current pricing is explicitly adopted.

The committed fixture was captured by Microsoft Excel 16.0 build 20326 from verbatim Calculator formulas and saved Lists values. It covers 216 scenarios × 151 outputs. The app engine is never used to generate expected values. Import tests independently reconcile source filters, exact strings, prices, yields and workbook hashes. HTTP tests exercise real local requests; persistence tests verify restart and pricing-snapshot isolation. Build checks compile Python and package only allowlisted runtime files.
