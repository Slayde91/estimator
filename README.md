# Ceasefire ESTIMATOR

A local estimating application reproducing `Quote.xlsm`'s Calculator with permanently imported pricing from `Inventory_list.xlsm`.

## Run

Requires Python 3.11 or newer and the dependencies in `requirements.txt`: ReportLab 4.4.9 generates quote PDFs and openpyxl 3.1.5 reads/writes pricing workbooks. Estimating calculations and storage use Python's standard library. Microsoft Excel and the original source workbooks are not required to run the app.

On Windows, double-click **[Start-Estimator.cmd](Start-Estimator.cmd)**. It starts ESTIMATOR in the background and opens your browser, or reopens the existing app if it is already running. The app keeps running after the launcher or chat closes; double-click the launcher again after restarting Windows. Saved quotes and pricing continue to use `.runtime/estimator.sqlite3`. The launcher checks every pinned package in `requirements.txt`, prefers an installed compatible Python, and can also use the existing Codex Python runtime when available. It does not install software or register automatic startup. If startup fails, the launcher displays the problem; server startup logs are kept in `.runtime`. To select another port, run `Start-Estimator.cmd -Port 8766`; `-NoBrowser` starts or checks the app without opening a browser.

For manual installation and startup:

```powershell
cd C:\ESTIMATOR\app
python -m pip install -r requirements.txt
python -m estimator
```

Open http://127.0.0.1:8765 in a browser. Use `python -m estimator --port 8766` if the default port is occupied.

1. Enter **Project No.**, **Client** and **Site Address**. The quote name is generated as `Project No.- Client- Site Address`, omitting empty parts. Select the estimating workflow.
2. Enter assessed coverage, product units, daily outputs, labour teams and allowances. Percentage controls display percentages: enter `10` for 10%.
3. Review the automatically generated **Work summary**, live total, material quantities and named cost breakdown. The summary updates from the selected workflow, products, quantities, labour and allowances.
4. Save the quote. Reopening preserves its input values and pricing snapshot. Use **Use current pricing** to explicitly apply current settings.
5. In **Pricing library**, edit supplier prices, markup, manual service prices or lookup rates/yields. **Reset row** restores that row's imported values. Use **Save pricing** to apply your changes.
6. Use **Download PDF** for a branded quote report containing the estimate details and work summary. An unchanged saved quote uses its stored results and original pricing. A new or edited estimate uses the inputs and pricing captured when you click, without saving the estimate. PDF download is the report action; the separate Print button has been removed.

The PDF contains the complete material and labour breakdown: products, coverage, yield, wastage, priced quantities, sell rates, labour teams and days, masking, freight, access, travel, accommodation, fees, adjustments and totals. Notes continue onto extra pages when needed. Calculation errors are identified explicitly and valid remaining amounts stay visible. The report uses the official logo supplied by Ceasefire, unchanged.

The estimator and PDF present business labels instead of raw worksheet cell addresses. Internal formula mappings and saved calculation evidence remain available in the code and developer documentation; the calculation engine is unchanged.

The quote name is read-only: for example, project `CF-1042`, client `Example Client` and site `10 High Street` produce `CF-1042- Example Client- 10 High Street`. Partial details use only the populated parts. Older quotes retain their manual names until details are entered; a new estimate without details is called `Untitled quote`. Details and the generated work summary are saved with the quote. The summary describes recorded work only; it is produced locally from the existing calculation, with no external AI or inferred technical rules.

Amounts and quantities display two decimal places in the app, PDF and exported Excel formats. Existing raw values and unrounded calculation results are retained when you merely view or save them. Deliberately editing a numeric app control records its value to two displayed decimal places; percentage controls still convert percentages to their stored fractional values. Excel number formatting does not round the underlying exported values. Product names, item codes and free-text notes keep their original text.

The Calculator does not derive quantities from geometry, fire rating or coating thickness. The source Steel/Duct sheets are collection templates without formulas. Workflow labels record context; the estimator supplies the required coverage/product quantities, as in Excel. No suitability rules or automatic dimension conversions have been invented.

## Data and pricing

- `data/baseline.json`: immutable import of 417 inventory records and 166 dropdown choices across 14 lookup groups, with original cells and workbook hashes.
- `data/calculator.json`: 64 unlocked inputs, 151 formulas and saved Excel results.
- `.runtime/estimator.sqlite3`: local settings and saved quotes; excluded from Git. Back this file up while the app is stopped.

The original Calculator reads stored inventory selling prices. Those imported values remain exact until a pricing input is edited. Supplier/markup edits calculate `supplier × (1 + markup)`; explicit lookup-rate overrides take priority. The original baseline stays immutable. The active library, its separate overrides and each saved quote's complete catalog/pricing snapshot live in SQLite. Existing saved quotes keep their products and prices after library replacements; **Use current pricing** explicitly adopts the new library and flags removed selections for review.

### Export or replace the pricing library

1. Click **Export Excel** in **Pricing library**. The `.xlsx` includes the entire effective library, including unsaved edits, with **Inventory**, **Rates** and **Instructions** sheets.
2. Edit values, add rows or delete products and choices. Preserve existing IDs. Blank IDs receive new IDs; to link a new product and rate in the same file, enter your own matching unique Inventory ID in both sheets. Remove or unlink any rates pointing to a deleted product. Keep the provided headers and supported group keys.
3. For linked rates, **Price source = Inventory** follows the inventory sell price. Editing a unit sell rate makes it an **Override**; choose **Inventory** to restore the link. Supplier markup items calculate their sell price when supplier price or markup changes. Manual items accept a sell price directly.
4. Click **Import Excel**, select the complete workbook, and review the added, removed and updated rows. Apply it to the draft, then click **Save pricing** to update the active library and dropdown choices. Import alone does not save. **Discard changes** keeps the previously saved library.

Each workbook replaces both lists in full, including hidden or filtered rows. The Instructions sheet explains markup, supported rate groups and the separate Number/Blank/Empty text/Not used yield types. Blank and empty-text yields have different estimating behavior and are preserved. Exported strings are literal text; import accepts values-only `.xlsx`, with no formulas, macros, external links or extra data sheets. The limit is 5 MB and 5,000 rows per list, with bounded ZIP contents and validated finite numbers. Use the exported template; arbitrary supplier spreadsheet layouts are not mapped automatically. The original `Inventory_list.xlsm` remains the immutable initial source, not the runtime import template.

The app retains Excel's unusual quantity adjustments, masking calculations, weekly access charging, unrounded intermediate prices and error results. It rounds money only for display; purchasing notes round positive quantities upward. See [Calculator specification](docs/CALCULATOR_SPEC.md) and [source mapping](docs/WORKBOOK_MAPPING.md).

## Verification

```powershell
python -m pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
node --check static/app.js
node tests/test_ui.cjs
python scripts/build.py
```

Node is only needed for JavaScript syntax and UI regression checks. Development requirements include pypdf for inspecting generated reports in tests. The build creates `dist/ceasefire-estimator.zip`, containing the application, imported data, original Ceasefire logo, README and `requirements.txt`. Extract it, install `python -m pip install -r requirements.txt`, then run `python -m estimator` in that directory. The archive does not bundle Python or installed packages.

The regression fixture contains **216 scenarios and 32,616 outputs independently recalculated by Microsoft Excel**. All 151 default results also match the source workbook's cached outputs. Excel refused to open the original XLSM copies through automation, so scenario capture used the original Calculator formulas in a fresh macro-free workbook with the original saved lookup values. This verifies formula and fixed-lookup parity; it does not prove execution of the original workbook's external-link refresh. Source filters and inventory links are independently checked by the importer.

To verify the import against the original files:

```powershell
$env:ESTIMATOR_WORKBOOK_DIR = 'C:\ESTIMATOR'
python -m unittest discover -s tests -v
```

Without the files, two source-reconstruction tests skip; all committed Excel fixtures still run. Tests also cover pricing workbook round trips, complete replacements, invalid imports, pricing links, quote metadata/names, deterministic work summaries, display precision and saved-quote isolation. Oracle regeneration is optional developer tooling and needs Microsoft Excel, PowerShell 7, and openpyxl; see `docs/CALCULATOR_SPEC.md`.

## Operating boundary

This is a single-computer application bound to `127.0.0.1`. It rejects foreign hosts/origins, limits request sizes, validates inputs, uses parameterized SQLite queries and has no CDN or remote runtime calls. It is not an authenticated multi-user service and has not been deployed. Do not expose this local HTTP server publicly.
