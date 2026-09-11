# Ceasefire ESTIMATOR

A local estimating application reproducing `Quote.xlsm`'s Calculator with permanently imported pricing from `Inventory_list.xlsm`.

## Run

Requires Python 3.11 or newer and the dependencies in `requirements.txt`. ReportLab 4.4.9 generates quote PDFs; estimating calculations and storage use Python's standard library. Neither Excel nor the workbooks are required to run the app.

On Windows, double-click **[Start-Estimator.cmd](Start-Estimator.cmd)**. It starts ESTIMATOR in the background and opens your browser, or reopens the existing app if it is already running. The app keeps running after the launcher or chat closes; double-click the launcher again after restarting Windows. Saved quotes and pricing continue to use `.runtime/estimator.sqlite3`. The launcher prefers an installed Python with ReportLab and can also use the existing Codex Python runtime when available. It does not install software or register automatic startup. If startup fails, the launcher displays the problem; server startup logs are kept in `.runtime`. To select another port, run `Start-Estimator.cmd -Port 8766`; `-NoBrowser` starts or checks the app without opening a browser.

For manual installation and startup:

```powershell
cd C:\ESTIMATOR\app
python -m pip install -r requirements.txt
python -m estimator
```

Open http://127.0.0.1:8765 in a browser. Use `python -m estimator --port 8766` if the default port is occupied.

1. Name the estimate and select its workflow label.
2. Enter assessed coverage, product units, daily outputs, labour teams and allowances. Percentage controls display percentages: enter `10` for 10%.
3. Review the live total, material quantities and source-cell calculation breakdown.
4. Save the quote. Reopening preserves its input values and pricing snapshot. Use **Use current pricing** to explicitly apply current settings.
5. In **Pricing library**, edit supplier prices, markup, manual service prices or Calculator lookup rates/yields. **Reset row** restores imported defaults.
6. Use **Download PDF** for a branded quote report. An unchanged saved quote uses its stored results and source evidence. A new or edited estimate uses the inputs and pricing captured when you click, without saving the estimate. **Print** remains available for the browser's worksheet view.

The PDF contains the complete material and labour breakdown: products, coverage, yield, wastage, priced quantities, sell rates, labour teams and days, masking, freight, access, travel, accommodation, fees, adjustments and totals. Notes continue onto extra pages when needed. Calculation errors are identified explicitly and valid remaining amounts stay visible. The report uses the official logo supplied by Ceasefire, unchanged.

The Calculator does not derive quantities from geometry, fire rating or coating thickness. The source Steel/Duct sheets are collection templates without formulas. Workflow labels record context; the estimator supplies the required coverage/product quantities, as in Excel. No suitability rules or automatic dimension conversions have been invented.

## Data and pricing

- `data/baseline.json`: immutable import of 417 inventory records and 166 dropdown choices across 14 lookup groups, with original cells and workbook hashes.
- `data/calculator.json`: 64 unlocked inputs, 151 formulas and saved Excel results.
- `.runtime/estimator.sqlite3`: local settings and saved quotes; excluded from Git. Back this file up while the app is stopped.

The original Calculator reads stored inventory selling prices. Those imported values remain exact until a pricing input is edited. Supplier/markup edits calculate `supplier × (1 + markup)`; explicit lookup-rate overrides take priority. Quote snapshots materialize all effective lookup prices and yields, including unchanged defaults.

The app retains Excel's unusual quantity adjustments, masking calculations, weekly access charging, unrounded intermediate prices and error results. It rounds money only for display; B30 purchasing notes round positive quantities upward. See [Calculator specification](docs/CALCULATOR_SPEC.md) and [source mapping](docs/WORKBOOK_MAPPING.md).

## Verification

```powershell
python -m pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
node --check static/app.js
python scripts/build.py
```

Node is only needed for the JavaScript syntax check. Development requirements include pypdf for inspecting generated reports in tests. The build creates `dist/ceasefire-estimator.zip`, containing the application, imported data, original Ceasefire logo, README and `requirements.txt`. Extract it, install `python -m pip install -r requirements.txt`, then run `python -m estimator` in that directory. The archive does not bundle Python or installed packages.

The regression fixture contains **216 scenarios and 32,616 outputs independently recalculated by Microsoft Excel**. All 151 default results also match the source workbook's cached outputs. Excel refused to open the original XLSM copies through automation, so scenario capture used the original Calculator formulas in a fresh macro-free workbook with the original saved lookup values. This verifies formula and fixed-lookup parity; it does not prove execution of the original workbook's external-link refresh. Source filters and inventory links are independently checked by the importer.

To verify the import against the original files:

```powershell
$env:ESTIMATOR_WORKBOOK_DIR = 'C:\ESTIMATOR'
python -m unittest discover -s tests -v
```

Without the files, two source-reconstruction tests skip; all committed Excel fixtures still run. Oracle regeneration is optional developer tooling and needs Microsoft Excel, PowerShell 7, and openpyxl; see `docs/CALCULATOR_SPEC.md`.

## Operating boundary

This is a single-computer application bound to `127.0.0.1`. It rejects foreign hosts/origins, limits request sizes, validates inputs, uses parameterized SQLite queries and has no CDN or remote runtime calls. It is not an authenticated multi-user service and has not been deployed. Do not expose this local HTTP server publicly.
