# Architecture

## Verified starting point

GitHub `Slayde91/estimator` contained only README.md at `18d5058` (Initial commit). `C:\ESTIMATOR` contained the two workbooks and an Excel lock file, with no Git checkout or application files. A clean clone was created at `C:\ESTIMATOR\app`; source workbooks were preserved outside the repository. No local commits or divergent implementation existed to reconcile.

## Implementation decision

The initial architecture decision introduced a small local Python application with explicit calculation functions, JSON baseline data, SQLite persistence and a browser interface. The reason was to reproduce the workbook without Excel at runtime while keeping business rules independently testable and avoiding unnecessary dependencies.

Consequences: Python 3.11+ is required; there is no frontend bundler, server framework or remote service. The original Excel files are permanently imported rather than required at runtime. Later PDF and pricing-workbook extensions add the dependencies described below. The built-in HTTP server is intentionally restricted to a single local computer. Multi-user hosting would require a separate reviewed authentication/deployment design. Migration impact: initial application creation only; no user database existed. The initial SQLite schema was version 1; the workbook calculator extension below adds version 2.

## PDF reporting extension

Previous architecture: Calculator results and pricing snapshots existed in the local application, with a browser print view. The reporting extension adds server-generated PDF reports using ReportLab 4.4.9 and the user-supplied Ceasefire logo. The reason is to provide a downloadable branded document that retains the quote's calculation evidence and can be generated without a print dialog. PDF download is now the application report action; the separate Print UI action has been removed.

Consequences: install `requirements.txt` before running PDF generation; `requirements-dev.txt` adds pypdf for report inspection in tests. Report generation consumes existing calculated or stored results and does not change Calculator formulas. The original logo bitmap is packaged unchanged and scaled proportionally for presentation. Migration impact: no database schema change or quote rewrite is required.

`POST /api/quote-report` builds a report from captured current inputs and pricing without saving a quote. Edited saved quotes include their source quote ID so the server can preserve the original source hashes when pricing is unchanged. `GET /api/quotes/<id>/report.pdf` renders the stored quote's result and source lineage directly, so an unchanged saved report remains available after catalogue changes. The UI selects the saved endpoint only when a saved quote has no unsaved edits. It captures its request before awaiting the response, validates the PDF response and starts a file download through a temporary blob URL.

## Components

On Windows, `Start-Estimator.cmd` invokes the adjacent PowerShell launcher. It reuses a healthy local app or starts the existing server as a hidden, detached process, waits for readiness, and opens the browser. Runtime discovery checks Python 3.11+ and every package pin in `requirements.txt`, currently ReportLab 4.4.9 and openpyxl 3.1.5; it can use an already-installed Codex runtime as a fallback. Startup logs remain in `.runtime`. There is no Windows service, login task or automatic package installation. After restarting Windows, the user runs the launcher again.

| Component | Responsibility |
| --- | --- |
| `scripts/import_workbooks.py` | Developer-only OOXML extraction, shared formulas, original lookup-filter reconciliation and source hashes |
| `data/baseline.json` | Original inventory records, stored selling prices, dimensions/yields and linked Calculator dropdowns |
| `data/calculator.json` | Original editable-field metadata, formulas, default inputs and cached expected values |
| `estimator/catalog.py` | Immutable baseline, validated replacement catalogs, separate overrides, supplier/markup propagation and explicit rate precedence |
| `estimator/pricing_workbook.py` | Values-only XLSX export/import, complete-list validation, stable IDs and replacement preview; no persistence |
| `estimator/calculator.py` | Explicit cell-addressed formula evaluation, dependency/error propagation and unrounded binary floating-point results |
| `estimator/presentation.py` | Named business labels and error descriptions shared by the UI API and PDF presentation |
| `estimator/quote_details.py` | Bounded project/client/site metadata, deterministic quote naming and work-summary formatting over existing calculated values |
| `estimator/storage.py` | Current library/settings, quote metadata/work summaries, saved full inputs, complete catalog/rate/yield snapshots, result evidence and source hashes |
| `estimator/report.py` | Branded PDF presentation of quote details, generated work summaries, existing results and inputs using business labels |
| `estimator/server.py` | Loopback-only allowlisted HTTP/JSON interface and request validation |
| `static/` | Accessible estimate-details controls, automatic quote names, draft pricing editor/import review, Excel export, quote persistence, named cost breakdown, original logo and PDF download |

## Pricing library extension

Previous architecture: a fixed workbook-derived catalog plus separately persisted user overrides. Proposed and implemented change: configuration JSON gains an optional `catalog` containing the active inventory and all 14 rate groups; the existing `inventory` and `rates` override maps remain separate. openpyxl 3.1.5 reads and writes the exchange workbook. This enables requested additions/removals and new prices while extending the existing calculator, configuration and SQLite boundaries.

`POST /api/pricing/export` serializes the entire effective draft into Inventory & Rates and Instructions sheets. Inventory rows own product details and purchasing values; visible Use rows own the rate group, selection name, price source, rate and yield, linked by explicit Inventory ID. Use-only fields stay blank on Inventory rows. Rate IDs remain stable and Use order preserves dropdown order independently of product grouping or spreadsheet sorting. `POST /api/pricing/import` adapts the combined rows into the existing inventory/rate validation path and also accepts older separate Inventory and Rates sheets. It returns a replacement configuration with added/removed/updated counts and never writes settings or quotes. The user reviews the replacement in the draft editor and applies it through the existing Save pricing operation. A removed row is removed from the active catalog after saving, while empty rate categories remain explicit. Unsupported category keys, duplicate choices, dangling inventory links and malformed values are rejected.

Existing IDs retain identity; new rows with blank IDs receive IDs. A user can supply a new unique Inventory ID in both lists when creating a linked product and rate together. A rate's `price_mode` distinguishes inventory-linked pricing from an explicit rate. Per-rate overrides still take final precedence. Its `uses_yield` flag derives from the fixed category rules, so new products do not need artificial worksheet references.

Consequences: `.xlsx` is a values-only exchange format with exact headers, a 5 MB file limit, 5,000 rows per list and bounded archive contents. Formula cells, macro-bearing files, external links and unexpected data sheets are rejected; filtered/hidden rows still participate. Export preserves numeric values and literal strings. Import reconciles unchanged Excel-precision values with the existing catalog to avoid incidental price drift. Inventory dimensions may include descriptive ranges, while calculation yields retain their numeric/blank/empty-text semantics.

The unified browser presentation replaces the former Inventory/Rates switch with
one product list and a filter based on actual rate-group membership. Category,
selection name, sell rate and yield now appear inline beside each product,
replacing the earlier expandable details. Shared product cells span their use
rows, so each product price has one editor. Unused inventory and unlinked rates
remain accessible, with independent product, rate and yield resets.
The existing inventory and rate models, override precedence, fixed field-to-group
mapping and name-within-group lookup remain unchanged. The workbook adaptation
and presentation add no runtime dependency, SQL migration or alternate calculation
path. Imports remain reviewed drafts and saved quotes retain their snapshots.

Excel Use rows are no longer outlined or hidden by default. Optional property
columns P:Z retain their existing outline. `_format_sheet` receives each sheet's
final freeze point once (C2 for Inventory & Rates, A2 for Instructions) and
reinitializes matching, unique pane selections. This fixes stale duplicate and
nonexistent pane records caused by changing an earlier E2 freeze. It changes
worksheet views only; the typed values, headers and import contract are retained.

Migration impact: no SQL schema change or eager quote rewrite. New and revised quotes embed the base catalog and freeze all effective prices/yields. Older configurations without `catalog` continue to resolve against the immutable original baseline, not the new global library. Their signature guard remains. Source hashes identify the catalog used and the imported pricing file; an unchanged saved quote retains its original lineage. Stored reports continue to use stored results directly.

## Estimate details and formatting extension

Previous architecture: quote JSON stored a manual title, workflow, notes, calculation result and pricing snapshot. The current change adds optional `project_no`, `client` and `site_address` fields and a server-generated `work_summary`. A small `quote_details.py` module extends the existing domain/presentation boundary. It does not add a service, AI dependency, business-rule engine or alternate calculation path.

Metadata is trimmed and bounded to 100 characters for project number, 200 for client and 400 for site address; control characters are rejected. The quote name joins nonempty project/client/site values with the exact separator `- `, giving `Project No.- Client- Site Address` and a maximum of 704 characters. The server derives the name rather than trusting a manually supplied title when metadata is present. Omitted metadata retains previous values during updates; explicit empty strings clear them. Legacy manual names remain available for records without metadata, and a new empty record uses `Untitled quote`.

`compile_work_summary(workflow, result)` reads only the given workflow, inputs and calculated cells. It describes active products and coverage, quantities/yields/wastage, labour teams and days, masking, selected services, extra labour and adjustments. It shares existing material and addition labels and reads calculated values without reimplementing their formulas. Calculation responses and quote saves retain the summary, and PDFs still include it; the Estimator's generated-summary panel is removed. Older reports can derive a summary from their saved snapshot without changing the stored record or consulting current prices. A summary is a description of entered estimating facts, not technical product approval or geometry inference.

New-estimate initialization explicitly sets the existing Notes input B12 to an
empty string. The immutable workbook field default remains `Allowances`;
backend normalization and saved-quote loading keep their existing semantics.
Explicit saved notes, including `Allowances` and blank text, are preserved.
The separate measurement textarea retains its NOTES label and stored identity.

The Estimator's Labour breakdown is an additive `result.labour` projection of
stored calculation cells, produced by `labour_breakdown(result)`. It reuses the
existing task mapping and display labels. The table explains source F10 total
project days: eight task-day outputs, masking, adjusted extra days and
`0.5*C112` mobilisation days. B37 pinning mirrors meshing and is excluded from
the task subtotal. F10 remains the authoritative displayed total; F2 remains
the separate labour-money calculation. Missing cells and Excel errors remain
missing/errors rather than becoming zero.

Fresh calculations include this projection. A saved-quote response lacking it
gets a result copy enriched from its own stored cells, without recalculation,
current-price reads or a write to the saved record. The browser clears the
table while calculating or after failure and ignores stale responses through
the existing revision guard. Existing PDF calculations and layout are unchanged.

Display formatting uses two decimal places for numeric app controls, generated numeric descriptions, PDF values and XLSX numeric formats. Untouched original values stay in raw client/server state and exported cells; all calculation arithmetic remains unrounded. An intentional edit in a numeric app control records two displayed decimal places, including conversion from a displayed percentage to its stored fraction. This distinction prevents merely opening or saving an old quote from changing its totals. Literal product labels, IDs and notes are preserved.

Consequences: metadata, naming and summaries use the existing quote JSON in SQLite; current library configuration JSON remains unchanged. No database schema or schema-version change, bulk rewrite or quote migration is needed. The official logo remains unchanged, and the interface update uses its red/orange brand colours with clearer estimate-detail grouping. Final UI/PDF visual verification belongs to the current feature checks rather than earlier screenshots.

## Workbook calculators extension

Previous architecture: an explicit 151-formula Quote calculator, immutable JSON
pricing baseline, SQLite, local HTTP server and plain JavaScript. The three new
sources add 161,566 formulas with large interdependent technical tables. The
implemented extension packages their complete source graphs in compressed JSON
and adds a bounded, allowlisted scalar Excel interpreter. This avoids manually
duplicating thousands of lookup rules while retaining source-cell traceability.
The existing Quote calculation engine, pricing semantics and PDF path are reused
unchanged; there is no new server, database, framework or runtime dependency.

`workbook_catalog.py` loads immutable source packages and input allowlists;
`excel_engine.py` evaluates their original formulas without eval/exec or cached
answers. `workbook_calculators.py` validates typed overlays, resolves dependent
dropdowns and serves exact worksheet pages. `schedule_workbook.py` extends the
existing openpyxl/OOXML validation boundary for schedule-only template exchange.
`static/calculators.js` owns separate calculator drafts, race-safe recalculation,
precision-preserving controls, complete worksheets and explicit saving.

Consequences: a bounded engine now implements only the Excel functions present
in the supplied files. Any future formula feature requires explicit support and
new independent native Excel evidence. Calculation sessions are cached for six
exact input states; each has a lock and private dependency/lookup caches. Source
models remain immutable, and public catalog loading returns independent copies.
Original raw string text is retained when Excel's verified OOXML whitespace
semantics require a different literal value. Unsupported formula features fail
visibly, and source error/status behavior is preserved.

Migration impact: SQLite schema version 2 adds `calculator_states` to the existing
database, with one separate state per calculator. Quotes and global pricing rows
are not rewritten. Saved calculator state contains exact inputs and the source
hash; a mismatched source refuses silent reinterpretation. GET/calculate/import
remain read-only; PUT state is the explicit save. Reference databases and
calculated cells outside declared editable settings cannot be supplied through
the API. The existing loopback Host/Origin checks, request
limits and safe values-only XLSX reader remain in force.

Every visible tab is a page; hidden board SETTINGS and EXTRA BOARDS are also
exposed as required input features. Source-hidden/zero-width columns are initially
hidden. Source display notes can replace redundant addresses with exact business
labels without changing the returned formula value. Numeric input focus reveals
the exact value; intentional calculator edits keep full precision, unlike the
earlier Quote UI's two-decimal edit policy. No calculator quantity is automatically
mapped into pricing because the new workbooks do not specify that integration.

The approved duct fixing-text correction is isolated from the immutable source
and quantity formulas. See [mapping and native evidence](docs/WORKBOOK_CALCULATORS.md)
and [exception record](docs/CALCULATOR_EXCEPTIONS.md).

### Continuous worksheet presentation and schedule documents

The existing paged projection is retained for compatibility. A `worksheet` POST
returns the complete bounded source page with shared typed dropdown option sets,
visible columns and source-derived presentation roles. The browser renders every
prepared schedule row, retaining hidden/advanced input choices. Explicit
presentation omissions hide the requested vermiculite commentary and source
metadata without removing their cells from the source graph. Shared datalists
remain available. Vermiculite Section ID uses a native select whose full source
option list is materialized when opened, avoiding 553 options in each of 1,000
rows at initial render. Main-section metadata supplies stable contents anchors
and colour themes.
The quick calculator uses this same strict native section control. Its 15/45
minute comparison columns and source-reference row are omitted only through
scoped display ranges; the engine and available fire-period inputs retain them.
The manual BAGS note spans its adjacent blank spacer in display metadata.
Shared label/input-cell surrounds use the populated yellow fill, while editable
text remains normal weight and explicit diagnostic labels remain bold.
Requested board and duct choices also use native selects. Board steel choices
use the same deferred-option loading for 1,342 source sections. Where original
validation permits warning/custom input, an explicit custom-value editor remains
available; this does not tighten the source validation contract.
Non-schedule occupancy is part of the render signature, so a newly populated
formula note is not lost during an in-place output refresh. The single-member
period matrix has its own equal-width period columns rather than inheriting the
form's narrow spacer. Neither presentation roles nor display rounding change
calculated values. Read-only outputs have two value-presence highlight states:
populated and blank. Numeric zero belongs to the populated state. The published
thickness H6 has an explicit pale-blue display highlight; none of these colors
interprets a technical status as acceptable or rejected.

The same presentation metadata declares section rectangles, navigation modes
and browser `display_pages`. Vermiculite adds START and FACTOR CALCS around its
four unchanged source pages. START directly displays the operating rules from
SETTINGS; SETTINGS offers seven global/product choices and FACTOR CALCS three
helper choices. Duct PRODUCT SETTINGS retains five choices and board SETTINGS
three. Picker pages initially have no selected panel; native buttons reveal one
section and retain that selection in client memory per display page. START has
no picker. All three vermiculite views continue to request source SETTINGS and
retain SETTINGS cell keys for edits. The complete evaluated worksheet
and draft still drive validation, recalculation, save/reset and PDF/Excel-register
downloads. Column-bounded rectangles keep side-by-side duct/board tables
independent without copying inputs or creating another calculation path.

Existing presentation-table metadata controls the BAGS order and stable anchors;
display aliases and a numeric-only suffix place mm beside the published value.
The product-order table now precedes the MATERIAL QUANTITIES heading, subtitle
and manual form. Settings/operating headings use concise aliases without their
source numbering or slash suffixes. Duct SUMMARY omits contents navigation;
vermiculite schedule note Y uses normal weight, and board Settings columns A/P
use bold reference labels.
Board purchasing dimensions and area use numeric-only mm/m² suffixes. Board
schedule titles and its live warning follow CALCULATED SUMMARY, directly before
the schedule. Duct SUMMARY groups its existing scoped tables into four section
wrappers with spacing. Vermiculite START omits the requested original-takeoff
and source-conflict blocks, carries the relocated A7 guidance, and the quick
calculator/factor views use concise titles. These changes preserve source cells.
Targeted browser text filtering removes generic success subtitles and the exact
duct copied-fixing notice while preserving failures, other warnings and source
responses. Board START expands with page scrolling. These are extensions of the
existing renderer, with no dependency, source-graph or storage migration.

Vermiculite SCHEDULE receives `product_totals` from the existing BAGS product
formulas, with net bags, pooled whole bags and order status. Its browser table
refreshes from these server results without rebuilding schedule controls. The
removed thickness/scope-block summary card remains in the source result graph.
The later display cleanup hides SCHEDULE V/W/X and requested top labels, removes
the CALCULATOR third notes section, and gives BAGS compact independent widths.
These browser omissions do not change PDF content or pooled ordering values.

`calculator_report.py` projects a normalized input snapshot through the same
workbook engine and approved exception. `POST /api/calculators/<id>/report.pdf`
uses the existing ReportLab/fonts/logo pipeline and never writes saved state.
Documents retain the main full schedule, including unresolved rows, additional
board allowances, product/ancillary tables and closing totals. At the user's
request, the duplicate detailed-item appendix, separate single-member and manual
bag sections, and settings appendix are omitted. Settings still affect the
snapshot's calculation; removing an appendix does not change its values. Bag,
sheet, roll, surface-area and reference-box semantics remain distinct.

The Excel register is a second output adapter over that same report projection.
`calculator_register.py` calls `project_calculator_report` and writes a values-only
XLSX through the existing openpyxl dependency and `_serialize_exact` helper from
`pricing_workbook.py`. This adds an Excel view of the calculated register without
creating another formula engine or redefining the PDF's quantity/ordering rules.
`POST /api/calculators/<id>/register.xlsx` accepts the same captured input payload
and read-only/source validation as the PDF endpoint and does not write state.

Every register has Summary and Schedule sheets; board registers also have Extra
boards, including an explicit empty message when no extra rows are entered.
Summary contains the overview totals, existing product/material tables, notes,
qualifications and source filename/SHA-256. Schedule retains all used report
items and incomplete statuses. Extra boards retains the PDF's A:K/M:N values and
item number, excluding internal column L. Populated detail tables have filters,
repeated print headings and C6 freeze panes; Summary uses B5. These are workbook
view settings, separate from the browser's horizontal scrolling behavior.

The browser's shared calculated-download action captures the draft before the
request, validates the returned file type and keeps any edits made while the
download is running. Numeric values remain unrounded with two-decimal number
formats; strings are written as literal text rather than formulas or hyperlinks.
The exported workbook is a result snapshot: changing it does not recalculate the
app's model. Users update the app inputs and download again. Existing input-only
template/import behavior remains separate. No new runtime dependency or storage
migration is required; the bundled artifact renderer is used only for local QA.

Consequences: larger complete-page responses replace repeated 25-row requests;
source extents and input limits still bound the workload. No new dependencies,
storage schema, business formulas or source packages are introduced. Existing
saved states and quote/pricing snapshots require no migration. See the
[per-page presentation and output mapping](docs/CALCULATOR_PRESENTATION_MAPPING.md).

### Reviewed commercial input defaults

Previous architecture: an absent saved calculator state produced an empty input
overlay and therefore the source workbook's original defaults. The implemented
change adds `calculator_defaults.py` and a separately reviewed JSON profile for
five vermiculite products. It supplies twenty existing SETTINGS inputs: bag mass,
direct yield, inferred dry-material consumption and retained basis/reference.
The reason is the user's authorized manufacturer-evidence review of commercial
estimating assumptions. Source graphs, hashes, thickness tables and original
native Excel fixtures remain unchanged; this is not a second formula engine.

`Store.calculator_state` returns the profile only when no saved row exists and
does not persist during that read. Existing saved rows are returned exactly,
including an explicit empty overlay. Calculator definitions expose `defaults`
and `yield_review` separately from current `inputs`. Reset copies the default
overlay into the draft and restores source example rows. The separate reviewed
yield action and review panel were subsequently removed from the browser at the
user's request. The existing PUT state is the only save.

The normalizer, engine/session factory and report projection do not inject the
profile. Explicit `{}` inputs still evaluate original workbook defaults, and
caller-supplied values remain authoritative. A saved numeric direct yield is an
explicit override, so later bag-mass edits do not rescale it implicitly. The
source direct-yield precedence, blank/zero/error behavior and separate waste
application are unchanged. The latest presentation request makes material-basis
text read-only and removes visible review dates, source IDs and document names
from Settings. Existing basis overrides and full source evidence remain retained.
The HTTP and storage-save boundary rejects arbitrary new basis text. Exact
existing saved values, original source text and reviewed-default text remain
accepted so unchanged saves and Reset do not require a migration. The low-level
source evaluator still supports historical input evidence; it is not the write
authorization boundary.

Consequences: a new unsaved vermiculite calculator starts with reviewed commercial
assumptions; existing work changes only through deliberate input actions. The
underlying profile and developer review retain numeric precision and linked
basis evidence without displaying a separate review panel. Density means inferred dry-material consumption rather than
installed coating density. Migration impact: no schema/version change, saved-row
rewrite, package replacement or data migration. Source-default reconstruction
and commercial-overlay validation remain separate checks. See the
[yield review](docs/VERMICULITE_YIELD_REVIEW.md) and
[authorized exception](docs/CALCULATOR_EXCEPTIONS.md).

## Calculation and state boundaries

The UI sends values only. New or edited estimates recompute prices, calculations and totals on the server; saved PDF reports use their stored results. No expression strings are executed or evaluated. Numeric empty inputs use Excel's blank arithmetic; missing lookup text and empty-text yields retain Excel error propagation. API text selections can produce `#N/A` for imported/invalid values; the UI offers the quote's applicable catalog choices and blank affordance. Calculated cells cannot be supplied as inputs.

The original baseline never changes at runtime. A saved library replacement becomes the active catalog; edits remain separate configuration overrides. Changes to an inventory price propagate to linked rates unless a rate uses explicit pricing. Changing inventory display text alone does not alter a rate selection key; Use rows control choices explicitly (or Rates in a legacy template). Quote saves freeze the catalog and all effective rate prices/yields so later replacements cannot silently reprice saved work. Explicitly adopting current pricing can leave removed or renamed selections unresolved; those errors require a new valid selection rather than an invented fallback.

Worksheet addresses remain in the deterministic formula engine, result snapshots, regression fixtures and developer source mappings. The estimator and PDF use named business fields and error descriptions. Removing redundant presentation references does not remove the original formula traceability or alter arithmetic.

Workbook H contains stored selling prices; P is the supplier-plus-markup formula. The application retains original H until users change supplier/markup, then recalculates the sell value as explicitly required by the product request. This is an editable-pricing extension, documented separately from formula parity.

## Test evidence

Quote configurations carry a fingerprint of lookup IDs, names and inventory links. New snapshots validate it against their own embedded catalog, so global replacements do not affect recalculation. Older snapshots without a catalog retain the original identity guard; they cannot silently reinterpret old positional rate IDs if the original baseline itself is changed. The original saved result remains in SQLite, and original source hashes remain attached until current pricing is explicitly adopted.

The committed fixture was captured by Microsoft Excel 16.0 build 20326 from verbatim Calculator formulas and saved Lists values. It covers 216 scenarios × 151 outputs. The app engine is never used to generate expected values. Source import tests independently reconcile source filters, exact strings, prices, yields and workbook hashes. Pricing exchange tests cover values-only round trips, replacements, links, invalid data and pricing precision. Quote-detail tests cover complete/partial/cleared metadata, legacy names, deterministic summaries, error handling and unchanged calculation snapshots. HTTP tests exercise real local requests; persistence tests verify restart and complete snapshot isolation, including old records. Build checks compile Python and package only allowlisted runtime files.
