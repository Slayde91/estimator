# Ceasefire ESTIMATOR

A local estimating application reproducing `Quote.xlsm`'s Calculator with permanently imported pricing from `Inventory_list.xlsm`, plus the three supplied ductwork and structural-steel workbooks.

## Run

Requires Python 3.11 or newer and the dependencies in `requirements.txt`: ReportLab 4.4.9 generates PDFs and openpyxl 3.1.5 reads/writes pricing workbooks, calculator templates and Excel registers. Estimating calculations and storage use Python's standard library. Microsoft Excel and the original source workbooks are not required to run the app.

On Windows, double-click **[Start-Estimator.cmd](Start-Estimator.cmd)**. It starts ESTIMATOR in the background and opens your browser, or reopens the existing app if it is already running. The app keeps running after the launcher or chat closes; double-click the launcher again after restarting Windows. Shared pricing, the linked estimates-folder preference and older saves use `.runtime/estimator.sqlite3`; complete projects are separate files in the folder you choose. The launcher checks every pinned package in `requirements.txt`, prefers an installed compatible Python, and can also use the existing Codex Python runtime when available. It does not install software or register automatic startup. If startup fails, the launcher displays the problem; server startup logs are kept in `.runtime`. To select another port, run `Start-Estimator.cmd -Port 8766`; `-NoBrowser` starts or checks the app without opening a browser.

For manual installation and startup:

```powershell
cd C:\ESTIMATOR\app
python -m pip install -r requirements.txt
python -m estimator
```

Open http://127.0.0.1:8765 in a browser. Use `python -m estimator --port 8766` if the default port is occupied.

1. Enter **Project No.**, **Client** and **Site Address**. The quote name is generated as `Project No.- Client- Site Address`, omitting empty parts.
2. Enter assessed coverage, product units, daily outputs, labour teams and allowances. Percentage controls display percentages: enter `10` for 10%.
3. Review the live total, material quantities, named cost breakdown and **Labour breakdown**. The labour table shows task, masking, extra-labour and mobilisation days leading to total project days. Pinning is included in meshing days. Use the main **NOTES** field for general notes. The separate Notes field under Job and access is hidden; its stored text is retained.
4. Click **Save Project** to save the estimate, its complete pricing library and all three calculators together. Choose the folder and filename in Save As. Reopen the file through **Saved projects** or **Load Project**; use **Use current pricing** when you want to replace its original prices with the last saved shared library.
5. In **Pricing library**, choose **Shared library** or **Current project pricing**. Each product has one row with editable supplier price, markup, uses, selection names, rate overrides, yields and yield units. Matching semicolon-separated entries represent multiple uses. Filter by **Used in Estimator** or search for an item or use; unused products and standalone rates remain available. **Save pricing** stores shared-library edits, while **Apply project pricing** updates only the active estimate. **Save Project** stores its project prices in the project file.
6. Use **Download PDF** for a branded quote report named **CEASEFIRE-Estimate.pdf**. An unchanged saved quote uses its stored results and original pricing. A new or edited estimate uses the inputs and pricing captured when you click, without saving the estimate. PDF download is the report action; the separate Print button has been removed.

The PDF contains the complete material and labour breakdown: products, coverage, yield, wastage, priced quantities, sell rates, labour teams and days, masking, freight, access, travel, accommodation, fees, adjustments and totals. Notes continue onto extra pages when needed. Calculation errors are identified explicitly and valid remaining amounts stay visible. The report uses the official logo supplied by Ceasefire, unchanged.

The PDF omits the Work summary section, the Material pricing and quantities heading and its three explanatory paragraphs, the masking-allowance explanation and the duplicate Estimator notes subsection. The main notes heading is **NOTES**. Generated material notes remain unchanged, including any retained historical Job and access note text. Material, labour and cost tables remain complete; the separate calculator PDFs are unaffected.

The estimator and PDF present business labels instead of raw worksheet cell addresses. Internal formula mappings and saved calculation evidence remain available in the code and developer documentation; the calculation engine is unchanged.

The quote name is read-only: for example, project `CF-1042`, client `Example Client` and site `10 High Street` produce `CF-1042- Example Client- 10 High Street`. Partial details use only the populated parts. Older quotes retain their manual names until details are entered; a new estimate without details is called `Untitled quote`. Details and the generated work summary are saved with the quote. The summary describes recorded work only; it is produced locally from the existing calculation, with no external AI or inferred technical rules.

The Estimator accepts whole-number edits for Access Qty, Sqm/Items, Masking/cleaning (%), Coverage required, Wastage %, Global Material Adjustment (%), Global Labour Adjustment (%), Mobilisation count and Administration count. Fractional entries show an error and must be corrected before saving or downloading. Global Adjustment ($) displays currency, including negative deductions. Daily output and extra labour days still accept decimals. Existing fractional values in saved quotes or project files remain exact until deliberately edited; viewing or saving them does not round them. Calculated amounts, PDF values and Excel numeric formats retain two-decimal presentation without rounding the underlying calculations. The separate Calculators controls retain all entered digits. Percentage controls convert percentages to stored fractions. Product names, item codes and free-text notes keep their original text.

## Save and load a project

**Save Project** is the single save action for an estimate and all three calculators. The separate **Save quote** and **Save calculator** buttons have been removed. It opens the operating system's **Save As** dialog with the quote name and `.ceasefire-project.json` extension. You can choose the folder and rename the file. The filename replaces characters that a filesystem cannot accept. Cancelling the dialog leaves existing files unchanged and keeps the current project open.

The file contains the active estimate's inputs, project details and notes, its complete catalog, prices, overrides and yields, and every calculator's exact input set, including settings and extra boards. Pending valid **Current project pricing** edits are applied before saving. All three calculator states are captured even if a calculator has not been opened in this session; existing local calculator saves or defaults supply an unopened initial state. A separate unsaved **Shared library** draft and the collection of older estimates are not included. Results are recalculated locally from the saved inputs. Recalculation, navigation and report downloads do not save the project.

In **Saved projects**, choose **Link estimates folder**. Its project files appear in the library and that folder becomes the default Save As location. If no folder is linked, the first successful project save links its folder. Saving elsewhere later does not change an existing folder link. The list reads files directly from the linked folder, without scanning subfolders; use **Refresh** after adding a file. Linking a folder does not move existing files. The linked path, shared pricing and older saves are stored in `C:\ESTIMATOR\app\.runtime\estimator.sqlite3` in the standard installation; `--database` changes that database location. Schema version 3 adds `app_preferences` while preserving previous settings and saves. Back up both the database and your project folder.

To receive somebody else's project, use **Load Project** to select their JSON file, or copy it into the linked folder and open it from **Saved projects**. Review its details before loading. The app validates the complete file and calculator source versions before replacing the estimate and all calculator drafts together. It retains the sender's pricing snapshot without changing the shared library. Files are limited to 16 MB; incompatible calculator versions are rejected instead of silently reinterpreted. **Save Project** writes an updated file through Save As. Loading or editing does not change the original file until you save.

**Older estimate-only saves** remain available inside Saved projects. They contain estimate inputs and original pricing, but no combined calculator snapshot. Opening one starts all three calculators from defaults; use Save Project to keep subsequent work together. Their historical SQLite records and calculator saves remain available for compatibility and are not deleted.

The shared Project No., Client and Site Address come from the active estimate. **Edit project details** takes you to those fields from any page. All PDF downloads include those details and the Ceasefire ABN, phone and email header; empty details are shown as not recorded. Workbook filenames and source-hash footnotes are omitted from PDFs while internal calculation provenance remains available.

The original Quote estimator uses assessed coverage/product quantities, as its Excel Calculator does. The separate Calculators section now derives the geometry, thickness and material quantities specified in the three new workbooks. These remain separate workflows; there is no automatic, unspecified transfer into a priced quote.

## Calculators

Choose **Calculators**, then **Steel (spray)**, **Steel (board)** or **Ductwork (spray/wrap)**. Every main schedule has 1,000 rows. Steel schedules show a read-only Line column, and the spray schedule now has an editable Location column after it. Vermiculite has START, CALCULATOR, SCHEDULE, BAGS, SETTINGS and FACTOR CALCS tabs. Board SETTINGS and EXTRA BOARDS are also available. All prepared rows are on one continuous page; scroll through the table to reach them. Editable fields have controls; calculated outputs distinguish populated values from blanks, with a separate highlight for published thickness. Zero is a populated value. Main sections use white text on red headings. Single-member forms fit a phone, with comparison tables scrolling separately.

Vermiculite **START** shows the operating rules directly. **SETTINGS** has seven
global/product sections, and **FACTOR CALCS** has three helper sections. Choose a
folder tab to open a section; only that section is shown. Duct and board Settings
use the same folder-tab presentation and selection behavior. Other settings still affect calculations and are
retained when you save or download. The browser remembers the open section while
you switch tabs. In vermiculite SCHEDULE, Section ID opens a native list of source
sections. BAGS shows product ordering first, then the **MATERIAL QUANTITIES**
heading and separate manual calculation.

Board and duct product/section/detail choices also use native lists. Choices
that allow a custom value keep a separate editor for that value. Board purchasing
dimensions show mm and purchase area shows m². The board schedule title and live
warning appear after its CALCULATED SUMMARY, directly above the member rows.

Enter inputs directly, or click **Export XLSX Template**, fill its schedule in Excel and use **Import XLSX Schedule**. Import replaces the complete schedule, including clearing unused old rows, and preserves other calculator settings. It stays a draft until **Save Project**, which captures all calculators and the estimate together. **Reset Calc** restores the example schedule and default settings as a draft; vermiculite uses the reviewed material defaults described below. **Recalculate** remains in the calculator heading. All main schedule headings, cells and input controls are centred.

Vermiculite starts with reviewed bag masses, direct yields, estimating consumption and basis values for five products when no saved calculator exists. Existing saves keep their exact values. Numeric material settings remain adjustable; **Material basis / reference** is read-only. The separate reviewed-yield action and review panel are removed. Original workbook formulas and technical lookup rules remain unchanged.

Direct yield takes priority. Estimating density means dry-material consumption inferred from the selected coverage; it is not installed coating density. Theoretical, batch/discontinuous and uninjected assumptions remain qualified; see the [developer yield review and evidence](docs/VERMICULITE_YIELD_REVIEW.md). Settings omit date, source-ID and document-name metadata rows from their visible presentation; retained source evidence and saved basis text are not deleted. Source defaults can still be reproduced with explicit empty calculation inputs; saved work is never migrated silently.

Vermiculite SCHEDULE shows running net and whole bags for every product. Whole bags come from the pooled BAGS calculation, including waste and withheld-quantity rules. They are not the sum of individually rounded schedule lines. The requested top labels and status/source columns are hidden from this worksheet view, while their underlying results remain available to the calculation and reports. The single-member CALCULATOR omits its third notes section, and BAGS uses a compact table width.

The templates contain 1,000 prepared rows and reference instructions, with **no Line column**. Duct has eight editable fields, board 24 and spray 13 including Location as its first column; board retains its existing input order. Physical row order determines line numbers when imported. Previous templates with an informational Line column and original templates with their exact legacy headings remain importable. Import accepts the exported values-only `.xlsx` layout, up to 5 MB; it does not map an arbitrary schedule layout or execute uploaded formulas. The [schedule extension mapping](docs/SCHEDULE_EXTENSION.md) explains the application ranges and preserved source coordinates.

Calculator numbers display two decimals at rest. Selecting a numeric input reveals its exact value, and editing retains full precision so small yields and tolerances cannot be rounded into different results. The source databases, calculated cells and material-basis text are read-only. Numeric settings remain adjustable, including formula-backed yields. Hiding the requested worksheet commentary does not remove exclusions, errors or withheld-quantity rules from calculation, purchasing totals or PDF reports.

**Download PDF Schedule** creates a branded **Full schedule** named **APPENDIX A.pdf** for any of the three calculators, from the current draft without saving it. It contains every populated main-schedule item, with thicknesses, protection/material areas, applicable bag, sheet or wrap quantities and main statuses. Unused blank slots are omitted; incomplete entries stay visible.

**Download PDF Summary** creates the separate **Material quantities and summary** document. It contains the final product/material tables, ancillary quantities, closing totals and populated extra-board details. These sections are no longer appended to the schedule PDF. Both downloads use the same complete calculation, including editable settings and source limitations. The duplicate item-detail, single-member/manual-bag and settings appendices remain excluded. Spray and board ordering retain their pooled workbook rules; manual helpers are not added to schedule totals. Board and wrap do not use spray bags, and board reference box area remains distinct from actual board material area.

The board materials & summary PDF omits the display-rounding paragraph, the two pictured A8 ordering paragraphs, the EXTRA BOARDS heading/introduction/empty message and the source filename/hash paragraph. Populated extra-board items, all tables and totals, other warnings and the A31/A35 guidance remain. The full Excel register retains those notes and source details.

Every material-summary PDF places **CALCULATORS | MATERIALS & SUMMARY** beneath the Ceasefire logo. Steel (spray)'s summary omits the requested available-results, display-rounding and pooled-bag explanation paragraphs. Ductwork's summary omits the CAFCO/MONOKOTE calibration/example notes, FyreWrap interpretation note and **Working spray yields** section. The calculation results, other material tables and statuses remain; the complete Excel register retains its qualifications and yield table. All PDF and XLSX table headings and data are centred.

The calculator toolbar places **Download XLSX Schedule** before **Download PDF Schedule**, followed by **Download PDF Summary**. XLSX import/export actions are Excel green; **Save Project** is yellow and PDF download actions are red. Editable schedule Exposure values use normal-weight text; headings and technical reference labels keep their emphasis.

**Download XLSX Schedule** captures the same calculated draft as **APPENDIX A.xlsx**
for any of the three calculators, without saving it. Summary contains totals, material tables and source
qualifications; Schedule contains the used items with filters and statuses.
Board registers also include Extra boards. Numbers retain their exact values
and display two decimals. The register contains calculated values, not live
formulas: recalculate in the app and download again to update it. To prepare
inputs for import, continue using **Export XLSX Template** and **Import XLSX Schedule**.

Each section has Australian technical-document links with clearly identified manuals, product data, safety data and report availability. The copied duct fixing-guide text uses the user-approved first-row correction; quantity formulas are unchanged. The reviewed vermiculite material profile is a separately authorized commercial input change. See [calculator mapping and validation](docs/WORKBOOK_CALCULATORS.md) and [approved exceptions](docs/CALCULATOR_EXCEPTIONS.md).

## Data and pricing

- `data/baseline.json`: immutable import of 417 inventory records and 166 dropdown choices across 14 lookup groups, with original cells and workbook hashes.
- `data/calculator.json`: 64 unlocked inputs, 151 formulas and saved Excel results.
- `data/calculators/`: permanently packaged literals, databases, metadata and all 161,566 formulas from the three new workbooks. Runtime recalculates formulas; it never uses their cached answers.
- `data/calculator_documents.json`: Australian technical-document links and availability descriptions.
- `data/vermiculite_yield_defaults.json`: reviewed commercial starting inputs and evidence, separate from the original source graph and existing saves.
- `.runtime/estimator.sqlite3`: shared pricing/settings, the linked project-folder preference, older estimate records and historical calculator saves; excluded from Git. Back this file up while the app is stopped.
- Your linked estimates folder: complete `.ceasefire-project.json` files, saved through **Save Project**. Back up this folder separately from SQLite.

The original Calculator reads stored inventory selling prices. Those imported values remain exact until a pricing input is edited. Supplier/markup edits calculate `supplier × (1 + markup)`; explicit lookup-rate overrides take priority. The original baseline stays immutable. The last saved shared library lives in SQLite; complete project files carry their own catalog/pricing snapshot. Existing projects keep their products and prices after shared-library replacements. **Use current pricing** explicitly adopts the last saved shared library and flags removed selections for review; Save Project is required to store that change in the file.

The **Pricing to edit** selector keeps shared-library and project-pricing drafts separate. **Save pricing** persists the shared inventory, rates, yields and units for the next launch. **Discard changes** restores the last saved shared library. **Reset Library** loads the application's original products, prices and values into the draft; save to persist them, or discard to return to the previous save. In Current project pricing, the corresponding action is **Apply project pricing**, and Discard returns to the last applied project prices. Resetting that scope changes only its draft until applied and then saved with Save Project.

Product uses are edited on the same row as item code, product, supplier price, markup, sell price and description. **Used in Estimator**, **Selection name**, **Sell rate override**, **Yield** and **Yield unit** contain matching semicolon-separated entries. A blank linked-rate override follows the product's sell price; a populated override is intentionally independent. Saved project snapshots may contain fixed overrides, so clear an override explicitly if it should follow an edited product price. Yield accepts a number, `blank` or `empty text`; these last two preserve different calculation behavior. Unit labels are editable descriptions and do not convert the value. Standalone rates retain their own rows because they have no inventory product.

### Export or replace the pricing library

1. Click the green **Export Excel** button in **Pricing library**. The `.xlsx` includes the entire effective library, including unsaved edits and items excluded by the current filter, with **Inventory & Rates** and **Instructions** sheets.
2. Each product occupies one row, with its supplier price, markup and **Sell price** alongside its uses. **Sell rate** belongs to a use and is separate from the product's Sell price. For several uses, nine use columns contain matching semicolon-separated lists: **Group**, **Selection name**, **Price source**, **Sell rate**, **Yield type**, **Yield**, **Yield unit**, **Rate ID** and **Use order**. Entries in the same position describe the same use. Keep the same number of entries in every list, including empty positions; import rejects mismatches. A name containing a semicolon needs double quotes, such as `"Primer; special"`; double an embedded quote, as in `"12"" sleeve"`.
3. Add or delete products and choices while preserving existing IDs. A new product with a blank **Inventory ID** receives an ID and its same-row uses link to it automatically. Standalone rate rows leave all product fields blank. **Use order** preserves dropdown order after sorting. The workbook has 28 columns (A:AB), including eleven optional product properties grouped and initially hidden in R:AB; keep its headers and supported group keys.
4. For linked rates, **Price source = Inventory** follows the inventory sell price. Editing a use's **Sell rate** makes it an **Override**; choose **Inventory** to restore the link. Supplier markup items calculate their sell price when supplier price or markup changes. Manual items accept a sell price directly.
5. Click the green **Import Excel** button, select the complete workbook, and review the added, removed and updated rows. Apply it to the selected pricing draft, then **Save pricing** for the shared library or **Apply project pricing** for the active estimate. Import alone does not save. Earlier 27-column compact workbooks, combined workbooks with separate **Inventory** and **Use** rows, and older exports with separate **Inventory** and **Rates** sheets are still accepted.

Each workbook replaces the inventory and uses in full, including hidden or filtered rows. The Instructions sheet explains markup, supported rate groups and the separate Number/Blank/Empty text/Not used yield types. Blank and empty-text yields have different estimating behavior and are preserved. Exported strings are literal text; import accepts values-only `.xlsx`, with no formulas, macros, external links or extra data sheets. The limit is 5 MB, 5,000 inventory records and 5,000 uses, with bounded ZIP contents and validated finite numbers. Use the exported template; arbitrary supplier spreadsheet layouts are not mapped automatically. The original `Inventory_list.xlsm` remains the immutable initial source, not the runtime import template.

The app retains Excel's unusual quantity adjustments, masking calculations, weekly access charging, unrounded intermediate prices and error results. It rounds money only for display; purchasing notes round positive quantities upward. See [Calculator specification](docs/CALCULATOR_SPEC.md) and [source mapping](docs/WORKBOOK_MAPPING.md).

## Verification

```powershell
python -m pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
node --check static/app.js
node --check static/calculators.js
node tests/test_ui.cjs
node tests/test_calculators_ui.cjs
node tests/test_project_ui.cjs
python scripts/build.py
```

Node is only needed for JavaScript syntax and UI regression checks. Development requirements include pypdf for inspecting generated reports in tests. The build creates `dist/ceasefire-estimator.zip`, containing the application, imported data, original Ceasefire logo, README and `requirements.txt`. Extract it, install `python -m pip install -r requirements.txt`, then run `python -m estimator` in that directory. The archive does not bundle Python or installed packages.

The regression fixture contains **216 scenarios and 32,616 outputs independently recalculated by Microsoft Excel**. All 151 default results also match the source workbook's cached outputs. Excel refused to open the original XLSM copies through automation, so scenario capture used the original Calculator formulas in a fresh macro-free workbook with the original saved lookup values. This verifies formula and fixed-lookup parity; it does not prove execution of the original workbook's external-link refresh. Source filters and inventory links are independently checked by the importer.

The three new XLSX calculators have separate native Microsoft Excel fixtures: every source formula, 300 corrected duct text outputs, and 258,039 varied outputs over 3,471 schedule cases. Those captures recalculate disposable copies of the actual original XLSX workbooks. Their committed fixtures run without Excel or OneDrive. See the mapping document for coverage, numeric tolerances and regeneration instructions.

To verify the import against the original files:

```powershell
$env:ESTIMATOR_WORKBOOK_DIR = 'C:\ESTIMATOR'
python -m unittest discover -s tests -v
```

Without the files, two source-reconstruction tests skip; all committed Excel fixtures still run. Tests also cover pricing workbook round trips, complete replacements, invalid imports, pricing links, quote metadata/names, deterministic work summaries, display precision and saved-quote isolation. Oracle regeneration is optional developer tooling and needs Microsoft Excel, PowerShell 7, and openpyxl; see `docs/CALCULATOR_SPEC.md`.

## Operating boundary

This is a single-computer application bound to `127.0.0.1`. It rejects foreign hosts/origins, limits request sizes, validates inputs, uses parameterized SQLite queries and has no CDN or remote runtime calls. It is not an authenticated multi-user service and has not been deployed. Do not expose this local HTTP server publicly.
