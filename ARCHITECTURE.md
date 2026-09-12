# Architecture

## Verified starting point

GitHub `Slayde91/estimator` contained only README.md at `18d5058` (Initial commit). `C:\ESTIMATOR` contained the two workbooks and an Excel lock file, with no Git checkout or application files. A clean clone was created at `C:\ESTIMATOR\app`; source workbooks were preserved outside the repository. No local commits or divergent implementation existed to reconcile.

## Implementation decision

The initial architecture decision introduced a small local Python application with explicit calculation functions, JSON baseline data, SQLite persistence and a browser interface. The reason was to reproduce the workbook without Excel at runtime while keeping business rules independently testable and avoiding unnecessary dependencies.

Consequences: Python 3.11+ is required; there is no frontend bundler, server framework or remote service. The original Excel files are permanently imported rather than required at runtime. Later PDF and pricing-workbook extensions add the dependencies described below. The built-in HTTP server is intentionally restricted to a single local computer. Multi-user hosting would require a separate reviewed authentication/deployment design. Migration impact: initial application creation only; no user database existed. SQLite schema version is 1.

## PDF reporting extension

Current architecture: Calculator results and pricing snapshots already exist in the local application, with a browser print view. The extension adds server-generated PDF reports using ReportLab 4.4.9 and the user-supplied Ceasefire logo. The reason is to provide a downloadable branded document that retains the quote's calculation evidence and can be generated without a print dialog.

Consequences: install `requirements.txt` before running PDF generation; `requirements-dev.txt` adds pypdf for report inspection in tests. Report generation consumes existing calculated or stored results and does not change Calculator formulas. The original logo bitmap is packaged unchanged and scaled proportionally for presentation. Migration impact: no database schema change or quote rewrite is required.

`POST /api/quote-report` builds a report from captured current inputs and pricing without saving a quote. Edited saved quotes include their source quote ID so the server can preserve the original source hashes when pricing is unchanged. `GET /api/quotes/<id>/report.pdf` renders the stored quote's result and source lineage directly, so an unchanged saved report remains available after catalogue changes. The UI selects the saved endpoint only when a saved quote has no unsaved edits. It captures its request before awaiting the response, validates the PDF response and starts a file download through a temporary blob URL.

## Components

On Windows, `Start-Estimator.cmd` invokes the adjacent PowerShell launcher. It reuses a healthy local app or starts the existing server as a hidden, detached process, waits for readiness, and opens the browser. Runtime discovery checks Python 3.11+ and every package pin in `requirements.txt`, currently ReportLab 4.4.9 and openpyxl 3.1.5; it can use an already-installed Codex runtime as a fallback. Startup logs remain in `.runtime`. There is no Windows service, login task, database migration or automatic package installation. After restarting Windows, the user runs the launcher again.

| Component | Responsibility |
| --- | --- |
| `scripts/import_workbooks.py` | Developer-only OOXML extraction, shared formulas, original lookup-filter reconciliation and source hashes |
| `data/baseline.json` | Original inventory records, stored selling prices, dimensions/yields and linked Calculator dropdowns |
| `data/calculator.json` | Original editable-field metadata, formulas, default inputs and cached expected values |
| `estimator/catalog.py` | Immutable baseline, validated replacement catalogs, separate overrides, supplier/markup propagation and explicit rate precedence |
| `estimator/pricing_workbook.py` | Values-only XLSX export/import, complete-list validation, stable IDs and replacement preview; no persistence |
| `estimator/calculator.py` | Explicit cell-addressed formula evaluation, dependency/error propagation and unrounded binary floating-point results |
| `estimator/presentation.py` | Named business labels and error descriptions shared by the UI API and PDF presentation |
| `estimator/storage.py` | Current library/settings, saved full input sets, complete catalog/rate/yield snapshots, result evidence and source hashes |
| `estimator/report.py` | Branded PDF presentation of existing quote results and inputs using business labels |
| `estimator/server.py` | Loopback-only allowlisted HTTP/JSON interface and request validation |
| `static/` | Accessible input controls, draft pricing editor/import review, Excel export, quote persistence, named cost breakdown, original logo, PDF download and print presentation |

## Pricing library extension

Previous architecture: a fixed workbook-derived catalog plus separately persisted user overrides. Proposed and implemented change: configuration JSON gains an optional `catalog` containing the active inventory and all 14 rate groups; the existing `inventory` and `rates` override maps remain separate. openpyxl 3.1.5 reads and writes the exchange workbook. This enables requested additions/removals and new prices while extending the existing calculator, configuration and SQLite boundaries.

`POST /api/pricing/export` serializes the entire effective draft into Inventory, Rates and Instructions sheets. `POST /api/pricing/import` validates both lists and returns a replacement configuration with added/removed/updated counts; it never writes settings or quotes. The user reviews the replacement in the draft editor and applies it through the existing Save pricing operation. A removed row is removed from the active catalog after saving, while empty rate categories remain explicit. Unsupported category keys, duplicate choices, dangling inventory links and malformed values are rejected.

Existing IDs retain identity; new rows with blank IDs receive IDs. A user can supply a new unique Inventory ID in both lists when creating a linked product and rate together. A rate's `price_mode` distinguishes inventory-linked pricing from an explicit rate. Per-rate overrides still take final precedence. Its `uses_yield` flag derives from the fixed category rules, so new products do not need artificial worksheet references.

Consequences: `.xlsx` is a values-only exchange format with exact headers, a 5 MB file limit, 5,000 rows per list and bounded archive contents. Formula cells, macro-bearing files, external links and unexpected data sheets are rejected; filtered/hidden rows still participate. Export preserves numeric values and literal strings. Import reconciles unchanged Excel-precision values with the existing catalog to avoid incidental price drift. Inventory dimensions may include descriptive ranges, while calculation yields retain their numeric/blank/empty-text semantics.

Migration impact: no SQL schema change or eager quote rewrite. New and revised quotes embed the base catalog and freeze all effective prices/yields. Older configurations without `catalog` continue to resolve against the immutable original baseline, not the new global library. Their signature guard remains. Source hashes identify the catalog used and the imported pricing file; an unchanged saved quote retains its original lineage. Stored reports continue to use stored results directly.

## Calculation and state boundaries

The UI sends values only. New or edited estimates recompute prices, calculations and totals on the server; saved PDF reports use their stored results. No expression strings are executed or evaluated. Numeric empty inputs use Excel's blank arithmetic; missing lookup text and empty-text yields retain Excel error propagation. API text selections can produce `#N/A` for imported/invalid values; the UI offers the quote's applicable catalog choices and blank affordance. Calculated cells cannot be supplied as inputs.

The original baseline never changes at runtime. A saved library replacement becomes the active catalog; edits remain separate configuration overrides. Changes to an inventory price propagate to linked rates unless a rate uses explicit pricing. Changing inventory display text alone does not alter a rate selection key; the Rates sheet controls choices explicitly. Quote saves freeze the catalog and all effective rate prices/yields so later replacements cannot silently reprice saved work. Explicitly adopting current pricing can leave removed or renamed selections unresolved; those errors require a new valid selection rather than an invented fallback.

Worksheet addresses remain in the deterministic formula engine, result snapshots, regression fixtures and developer source mappings. The estimator and PDF use named business fields and error descriptions. Removing redundant presentation references does not remove the original formula traceability or alter arithmetic.

Workbook H contains stored selling prices; P is the supplier-plus-markup formula. The application retains original H until users change supplier/markup, then recalculates the sell value as explicitly required by the product request. This is an editable-pricing extension, documented separately from formula parity.

## Test evidence

Quote configurations carry a fingerprint of lookup IDs, names and inventory links. New snapshots validate it against their own embedded catalog, so global replacements do not affect recalculation. Older snapshots without a catalog retain the original identity guard; they cannot silently reinterpret old positional rate IDs if the original baseline itself is changed. The original saved result remains in SQLite, and original source hashes remain attached until current pricing is explicitly adopted.

The committed fixture was captured by Microsoft Excel 16.0 build 20326 from verbatim Calculator formulas and saved Lists values. It covers 216 scenarios × 151 outputs. The app engine is never used to generate expected values. Source import tests independently reconcile source filters, exact strings, prices, yields and workbook hashes. Pricing exchange tests cover values-only round trips, replacements, links, invalid data and pricing precision. HTTP tests exercise real local requests; persistence tests verify restart and complete snapshot isolation, including old records. Build checks compile Python and package only allowlisted runtime files.
