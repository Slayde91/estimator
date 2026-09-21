# Ceasefire ESTIMATOR

A local estimating application reproducing `Quote.xlsm`'s Calculator and `Penetration_Calculator.xlsx` with shared pricing from `Inventory_list.xlsm`, plus the three supplied ductwork and structural-steel workbooks.

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

The application opens on **Home**, with direct cards for Estimator, Libraries,
Calculators and Saved Projects. **Help** provides a plain-English guide to the
main workflow and the meaning of each area. The browser interface uses the
bundled Montserrat font, so it does not depend on an internet font service.

The **Estimator** tab has two tiles. **Estimator** includes the **Firestopping
Schedule** below Material Requirements & Output, with its own totals and
PDF/XLSX downloads. **Firestopping Estimator** calculates one current item;
**Add to Schedule** copies it into the schedule using current project prices.
Editing the current item does not change existing
schedule lines. **Edit** loads a copy of a schedule line; **Update Schedule**
explicitly applies it, and **Cancel edit** restores the previous current item.
Both use the same project details and pricing library, and are saved together.
Scheduled materials, labour costs and days also contribute once to the main
quote totals and exports. The main global material and labour adjustments apply
once to the combined estimate and Firestopping cost base. Legacy per-item
Firestopping allowances and substrate, access and complexity multipliers no
longer affect estimates. The supplied workbook
formulas remain intact as the source reference.
See the [source and parity contract](docs/PENETRATION_CALCULATOR.md).
The Firestopping **Item Breakdown** is collapsed until it is needed. The
Firestopping Breakdown contains the complete schedule breakdown table followed
by its static summary, without a second nested Schedule breakdown section. Its
compact schedule PDF includes project details, totals, the
schedule and any calculation errors; Settings, Line Inputs and Calculated detail
appendices remain available in the XLSX register instead of the PDF.

The **Libraries** tab has **Pricing Library**, **Firestopping Library** and
**Technical Library** tiles. The two reference libraries support search,
filters, original diagrams, report-page links and navigation between related
records. Supplier files stay in a local bundle, separate from the public source
and application ZIP. To install an inspected bundle, run
`python scripts/install_reference_library.py <reviewed-bundle-directory>`;
an existing installation requires `--replace` and is retained as a backup.
See [local reference libraries](docs/REFERENCE_LIBRARIES.md) for the data contract.

Firestopping Library entries display stable **FL-ID-001** style identifiers and
their prices. **Edit Library Item** opens a separate Firestopping Estimator
session, retaining the current project's unsaved inputs and pricing. Each item
starts with its original workbook rates. **Refresh from Pricing Library**
explicitly captures the last **saved** shared rates for that item; unsaved shared
pricing edits and current-project prices are not used. Review the result and
choose **Save Library Item** to retain its inputs and captured prices. Later
shared-rate changes do not alter a saved item. **Cancel** discards only this
library editing session. Project Save / Save As does not save library edits.
Every Firestopping entry also has a trash button. It asks for confirmation, then
removes the entry and its mutable edit, diagram and manual-link overlays while
leaving the installed supplier bundle unchanged.
The editor can also save a compressed PNG, JPEG or WebP source diagram for the
item; its thumbnail appears on matching Firestopping Schedule rows. The supplier
workbook, PDFs and original diagrams stay unchanged; related technical
references continue to describe the original source entry after an item is edited.
**Add to Schedule** stays on the library page and confirms the recalculated
price beside the item. The current item in the Firestopping Estimator is retained.

1. Enter **Project No.**, **Client** and **Site Address**. The quote name is generated as `Project No.- Client- Site Address`, omitting empty parts.
2. Enter assessed coverage, product units, daily outputs, labour teams and allowances. Percentage controls display percentages: enter `10` for 10%.
3. Review the live total, **Material Breakdown** and **Labour Breakdown**. Firestopping Schedule materials, labour costs and days are included once in the quote and its PDF. The Estimator reconciles Firestopping labour into one row, while the PDF retains the task detail and adds total rows for its material and labour tables. The PDF Material Breakdown uses the same products and order as the Estimator Material column, with coverage, base units, wastage, priced units, sell rates and line amounts in one table. Repeated firestopping products are reconciled into one material row with summed quantities, totals and labour days. Global material and labour percentages each apply once to the combined main-estimate and firestopping cost base. Shared Board/Wrap hours are split by calculated quantities using eight hours per day. Firestopping Register allowance and Additional Labour have separate rows. Register Allowance defaults to 0.25 hours and is controlled project-wide in Firestopping **SETTINGS**; Pipe Labour uses project-editable diameter bands only for selected collars, multiplied by the **Wrap Multiplier** and Item QTY. The same SETTINGS tab contains the project-wide Firestopping Waste (%) controls. For every Plastic Pipes row with a selected collar and positive resolved Pipe Labour, a positive duplicated legacy Additional Labour value is omitted without rewriting the supplier package or saved source file. Register Allowance and Pipe Labour accept explicit values including zero; see [Firestopping labour rules](docs/PENETRATION_CALCULATOR.md#automatic-and-manual-labour-allowances). The labour table includes task, masking, extra-labour and mobilisation days. Pinning is included in meshing days. Use the main **NOTES** field for general notes. The separate historical Notes field is hidden; its stored text is retained.
4. Click **Save As** to choose a folder and filename for the estimate, its complete pricing library and all three calculators. **Save** updates the currently opened or saved project file without another file dialog. If no project file is open, use **Save As** first. Reopen a file through **Saved projects** or the native **Load Project** dialog; use **Use current pricing** when you want to replace its original prices with the last saved shared library. A file changed or removed outside the app must be reopened or saved through **Save As** before it can be overwritten.
5. In **Libraries → Pricing Library**, choose **Shared library** or **Current project pricing**. Each product has one row with an editable **Product/Service** label, supplier price, markup, two Estimator group boxes and one yield. Existing selection keys and independent rate overrides remain intact; **Show rate overrides** reveals the rate editor when needed. Yield units are read-only and follow the calculation. **Estimator availability** lets you edit both Main Estimator and Firestopping Estimator groups as semicolon-separated lists. Filter by either estimator, or search for an item or group; products unused by both estimators and standalone rates remain available. **Save pricing** stores shared-library edits, while **Apply project pricing** updates only the active estimate. **Save / Save As** stores its project prices in the project file.
6. Use **Download PDF** for a branded quote report named **CEASEFIRE-Estimate.pdf**. An unchanged saved quote uses its stored results and original pricing. A new or edited estimate uses the inputs and pricing captured when you click, without saving the estimate. PDF download is the report action; the separate Print button has been removed.

The Estimator groups inputs under **Project Details**, **Access & Travel**, **Teams/Crews**, **Masking/Cleaning**, **Material Requirements & Output**, **Global Adjustments** and **Additions**, with totals in **Quote Summary**. Every section from Access & Travel onward is expandable and starts collapsed. The labour selector is labelled **Masking/Cleaning labour**; its Masking/Cleaning card is hidden while that selector is `N/A`. Sqm/Items is in Project Details. The generated quote name remains in the current-project display and saved data; its duplicate field is hidden. **New project** and **Edit Project** sit together in the shared project toolbar, available from every page.

The PDF contains the complete material and labour breakdown: products, coverage, yield, wastage, priced quantities, sell rates, labour teams and days, masking, freight, access, travel, accommodation, fees, adjustments and totals. Notes continue onto extra pages when needed. Calculation errors are identified explicitly and valid remaining amounts stay visible. The report uses the official logo supplied by Ceasefire, unchanged.

The PDF omits the workflow subtitle beneath the quote title, the Work summary section, the Material pricing and quantities heading and its three explanatory paragraphs, the masking-allowance explanation, the duplicate Estimator notes subsection and the automatic generated material/allowance notes. The automatic **Quote notes and material requirements** section is also omitted from the Estimator page. Authored project notes remain under **NOTES**, and historical inputs, workflow values and generated notes remain in saved calculation evidence. Material, labour and cost tables remain complete; the separate calculator PDFs are unaffected.

The estimator and PDF present business labels instead of raw worksheet cell addresses. Internal formula mappings and saved calculation evidence remain available in the code and developer documentation; the calculation engine is unchanged.

The quote name is read-only: for example, project `CF-1042`, client `Example Client` and site `10 High Street` produce `CF-1042- Example Client- 10 High Street`. Partial details use only the populated parts. Older quotes retain their manual names until details are entered; a new estimate without details is called `Untitled quote`. Details and the generated work summary are saved with the quote. The summary describes recorded work only; it is produced locally from the existing calculation, with no external AI or inferred technical rules.

Coverage required needs a selected labour team for Spraying, Meshing, Access panels, Fan enclosure mesh, Primer, Topcoat, Board and Mastic. A nonzero entry with its team set to N/A or blank is rejected with **Select Teams**; Pins / clips are exempt. Deselecting a team preserves existing coverage but blocks calculations and saving until a team is selected or coverage is cleared. This rule is enforced by the server as well as the form. Older project files with missing teams can still be opened for correction; their totals remain unavailable until corrected.

The Estimator accepts whole-number edits for Access Qty, Sqm/Items, Masking/cleaning (%), Coverage required, Wastage %, Global Material Adjustment (%), Global Labour Adjustment (%), Mobilisation count and Administration count. Fractional entries show an error and must be corrected before saving or downloading. Global Adjustment ($) displays currency, including negative deductions. Daily output and extra labour days still accept decimals. Hover over Coverage required and Daily output fields to see their units. Primer, Topcoat and Board daily outputs are product quantities, rather than square metres; coverage remains in m². Existing fractional values in saved quotes or project files remain exact until deliberately edited; viewing or saving them does not round them. Calculated amounts, PDF values and Excel numeric formats retain two-decimal presentation without rounding the underlying calculations. The separate Calculators controls retain all entered digits. Percentage controls convert percentages to stored fractions. Product names, item codes and free-text notes keep their original text.

## Save and load a project

**Save As** opens the operating system's file dialog with the quote name, adding `.json` automatically. **Save** overwrites the current project file with the same complete estimate, pricing and three-calculator snapshot. The separate **Save quote** and **Save calculator** buttons remain removed. There is no `.ceasefire-project` suffix in new filenames; existing files using that suffix still load. You can choose the folder and rename the file. The filename replaces characters that a filesystem cannot accept. Cancelling the dialog leaves existing files unchanged and keeps the current project open.

The persistent **Current project** area shows the known location and last-saved time. Save state appears directly under the main logo, including when any estimate, project-pricing or calculator input has unsaved changes. Files opened through **Load Project** or **Saved projects** retain their save target for this app session. Imported browser-upload content has no authorized local path and requires **Save As**. If the app server restarts, reopen the file or use **Save As** before saving again. On Windows, native Save As, Load Project and folder dialogs are owned by the foreground application and the actual dialog, including overwrite prompts, is raised above it. Automated checks cover save/load behavior and native helper structure; native dialog foreground placement remains a manual visual check.

The file contains the active estimate's inputs, project details and notes, its complete catalog, prices, overrides and yields, and every calculator's exact input set, including settings and extra boards. Pending valid **Current project pricing** edits are applied before saving. All three calculator states are captured even if a calculator has not been opened in this session; existing local calculator saves or defaults supply an unopened initial state. A separate unsaved **Shared library** draft, Firestopping Library item edits and the collection of older estimates are not included. Results are recalculated locally from the saved inputs. Recalculation, navigation and report downloads do not save the project.

In **Saved projects**, choose **Link Project Folder**. Project files in that folder and all its subfolders appear in the library, and the linked folder becomes the default Save As location. Each entry shows its relative folder so identical filenames remain distinguishable. Search quote names, project details and paths, sort the results, and move through pages of 100 projects. Large folders scan in continuing batches while this page is open; progress and unreadable entries are reported. **Continue folder scan** resumes an unfinished scan, and **Refresh** checks for changes. File metadata is cached without recalculating projects; opening a project still validates the complete file. Symbolic links and junctions are not followed. Supported OneDrive cloud placeholders are accepted when their contents can be read.

If no folder is linked, the first successful project save links its folder. Saving elsewhere later does not change an existing folder link. Linking a folder does not move existing files. The linked path, shared pricing and older saves are stored in `C:\ESTIMATOR\app\.runtime\estimator.sqlite3` in the standard installation; `--database` changes that database location. Schema version 3 adds `app_preferences` while preserving previous settings and saves. Back up both the database and your project folder.

To receive somebody else's project, use **Load Project** to select their JSON file, or copy it into the linked folder and open it from **Saved projects**. Review its details before loading. The app validates the complete file and calculator source versions before replacing the estimate and all calculator drafts together. It retains the sender's pricing snapshot without changing the shared library. Files are limited to 16 MB; incompatible calculator versions are rejected instead of silently reinterpreted. **Save** updates the open file; **Save As** lets you choose another file. Loading or editing does not change the original file until you save.

The **Older estimate-only saves** section has been removed from the page. Its historical SQLite records and separate calculator saves are retained for compatibility; no stored records are deleted.

The shared Project No., Client and Site Address come from the active estimate. **Edit Project** takes you to those fields from any page. All PDF downloads include those details and the Ceasefire ABN, phone and email header; empty details are shown as not recorded. Workbook filenames and source-hash footnotes are omitted from PDFs while internal calculation provenance remains available.

The original Quote estimator uses assessed coverage/product quantities, as its Excel Calculator does. The separate Calculators section now derives the geometry, thickness and material quantities specified in the three new workbooks. These remain separate workflows; there is no automatic, unspecified transfer into a priced quote.

## Where downloads are saved

All PDF and XLSX exports, including calculator templates and pricing workbooks, are saved beside the active project file. The app uses the server-issued file selection from **Save As**, **Load Project** or opening a located file in **Saved projects**; a browser cannot supply an arbitrary destination path. For a new or unlocated project, including a browser-uploaded project without a local file selection, exports go to the operating system's **Downloads** folder on the computer running ESTIMATOR. The success message shows the actual saved path.

An existing export is never overwritten: duplicate filenames receive a numbered suffix. **Save As** and opening another project change the destination for subsequent exports; **New project** clears it. Each export captures its destination when clicked, so changing projects while a file is being prepared does not redirect that file. If a selected project file has become stale or inaccessible, the export reports the problem and asks you to reopen the project or use **Save As**, without silently falling back to Downloads. Exporting does not save pending project or pricing changes.

## Calculators

Choose **Calculators**, then **Steel (spray)**, **Steel (board)** or **Ductwork (spray/wrap)**. New main schedules start with one blank row and support up to 1,000 rows. **Add row** and **Undo remove** sit below each main schedule table; each row has its own **Remove** button. Removing a row clears all its editable inputs, including advanced fields, while its formula addresses and the remaining line numbers stay fixed. Added blank rows and removed rows are retained in project files. Editing a cleared row or reusing its slot retires its removal undo history so newer inputs cannot be overwritten. Steel schedules show a read-only Line column, and the spray schedule has an editable Location column after it. Vermiculite has START, LOOKUP, SCHEDULE, BAGS, SETTINGS and FACTOR CALCS tabs. Board and duct main tabs are labelled SCHEDULE; board SETTINGS and EXTRA BOARDS are also available. These are display aliases only: vermiculite LOOKUP and the board/duct SCHEDULE tabs still use their original `CALCULATOR` worksheet names, API identifiers and formula mappings. Large schedules load a moving window of up to 60 rows as you scroll; every entered row still contributes to calculations, saved projects and reports. Editable fields have controls; calculated outputs distinguish populated values from blanks, with a separate highlight for published thickness. Zero is a populated value. Main sections use white text on red headings. Single-member forms fit a phone, with comparison tables scrolling separately.

Recently viewed calculator tabs reopen faster while their inputs remain unchanged. Editing inputs, importing a schedule, resetting or loading a project refreshes dependent results; **Recalculate** always requests a fresh calculation. Pricing navigation also retains unchanged controls and pending edits. Initial calculator loads and calculations after edits can still take longer. Saving and report downloads continue to use the complete current inputs.

Vermiculite **START** shows the operating rules directly. **SETTINGS** has seven
global/product sections, and **FACTOR CALCS** has three helper sections. Choose a
folder tab to open a section; only that section is shown. Duct and board Settings
use the same folder-tab presentation and selection behavior. Other settings still affect calculations and are
retained when you save or download. The browser remembers the open section while
you switch tabs. In vermiculite SCHEDULE, Section ID opens a native list of source
sections. BAGS shows product ordering first, then the **MATERIAL QUANTITIES**
heading and separate manual calculation.

The redundant **SETTINGS & RULES** banner is hidden in all three calculators. Board settings also hide the introductory source-constants/wastage note. Other settings notes and the underlying source content remain unchanged.

Board and duct product/section/detail choices also use native lists. Choices
that allow a custom value keep a separate editor for that value. Board purchasing
dimensions show mm and purchase area shows m². The board schedule title and live
warning appear after its CALCULATED SUMMARY, directly above the member rows.

Enter inputs directly, or click **Export XLSX Template**, fill its schedule in Excel and use **Import XLSX Schedule**. Import automatically displays rows through the last entered item, preserving physical order, gaps and partially completed entries. Formatting and generated line numbers do not create extra rows. Import replaces the complete schedule, including clearing unused old rows, and preserves other calculator settings. It stays a draft until **Save / Save As**, which captures all calculators and the estimate together. Existing projects retain their exact inputs and automatically reveal populated rows even if older files have no row-display metadata. **Reset Calc** restores one blank schedule row and default settings as a draft; vermiculite uses the reviewed material defaults described below. **Recalculate** remains in the calculator heading. All main schedule headings, cells and input controls are centred.

Vermiculite starts with reviewed bag masses, direct yields, estimating consumption and basis values for five products when no saved calculator exists. Existing saves keep their exact values. Numeric material settings remain adjustable; **Material basis / reference** is read-only. The separate reviewed-yield action and review panel are removed. Original workbook formulas and technical lookup rules remain unchanged.

Direct yield takes priority. Estimating density means dry-material consumption inferred from the selected coverage; it is not installed coating density. Theoretical, batch/discontinuous and uninjected assumptions remain qualified; see the [developer yield review and evidence](docs/VERMICULITE_YIELD_REVIEW.md). Settings omit date, source-ID and document-name metadata rows from their visible presentation; retained source evidence and saved basis text are not deleted. Source defaults can still be reproduced with explicit empty calculation inputs; saved work is never migrated silently.

Vermiculite SCHEDULE shows running net and whole bags for every product. Whole bags come from the pooled BAGS calculation, including waste and withheld-quantity rules. They are not the sum of individually rounded schedule lines. The requested top labels and status/source columns are hidden from this worksheet view, while their underlying results remain available to the calculation and reports. The single-member LOOKUP tab (source worksheet `CALCULATOR`) omits its third notes section, and BAGS uses a compact table width.

The templates contain 1,000 prepared rows and reference instructions, with **no Line column**. Duct has eight editable fields, board 24 and spray 13 including Location as its first column; board retains its existing input order. Physical row order determines line numbers when imported. Previous templates with an informational Line column and original templates with their exact legacy headings remain importable. Import accepts the exported values-only `.xlsx` layout, up to 5 MB; it does not map an arbitrary schedule layout or execute uploaded formulas. The [schedule extension mapping](docs/SCHEDULE_EXTENSION.md) explains the application ranges and preserved source coordinates.

Calculator numbers display two decimals at rest. Selecting a numeric input reveals its exact value, and editing retains full precision so small yields and tolerances cannot be rounded into different results. The source databases, calculated cells and material-basis text are read-only. Numeric settings remain adjustable, including formula-backed yields. Hiding the requested worksheet commentary does not remove exclusions, errors or withheld-quantity rules from calculation, purchasing totals or PDF reports.

**Download PDF Schedule** creates a branded **Full schedule** named **APPENDIX A.pdf** for any of the three calculators, from the current draft without saving it. It contains every populated main-schedule item, with thicknesses, protection/material areas, applicable bag, sheet or wrap quantities and main statuses. Unused blank slots are omitted; incomplete entries stay visible.

**Download PDF Summary** creates the separate **Material quantities and summary** document. It contains the final product/material tables, ancillary quantities, closing totals and populated extra-board details. These sections are no longer appended to the schedule PDF. Both downloads use the same complete calculation, including editable settings and source limitations. The duplicate item-detail, single-member/manual-bag and settings appendices remain excluded. Spray and board ordering retain their pooled workbook rules; manual helpers are not added to schedule totals. Board and wrap do not use spray bags, and board reference box area remains distinct from actual board material area.

The board materials & summary PDF omits the display-rounding paragraph, the two pictured A8 ordering paragraphs, the EXTRA BOARDS heading/introduction/empty message and the source filename/hash paragraph. Populated extra-board items, all tables and totals, other warnings and the A31/A35 guidance remain. The full Excel register retains those notes and source details.

Every material-summary PDF places **CALCULATORS | MATERIALS & SUMMARY** beneath the Ceasefire logo, and every schedule PDF uses **CALCULATORS | FULL SCHEDULE** there. Steel (spray)'s summary omits the requested available-results, display-rounding and pooled-bag explanation paragraphs. Ductwork's summary omits the CAFCO/MONOKOTE calibration/example notes, FyreWrap interpretation note and **Working spray yields** section; its schedule PDF also omits the display-rounding sentence. Material-summary PDFs omit unused stock/product rows only when the relevant raw demand values are confirmed zero. Unknown, withheld, failed, negative and tiny nonzero quantities remain visible, and unresolved products are identified separately when necessary. Empty material tables are omitted. The calculation results and complete Excel registers retain their rows, qualifications and yield tables. All PDF and XLSX table headings and data are centred.

The calculator toolbar places **Download XLSX Schedule** before **Download PDF Schedule**, followed by **Download PDF Summary**. XLSX import/export actions are Excel green; **Save / Save As** is yellow and PDF download actions are red. Editable schedule Exposure values use normal-weight text; headings and technical reference labels keep their emphasis.

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
- Your linked estimates folder and subfolders: complete `Quote name.json` files, saved through **Save / Save As**. Older `.ceasefire-project.json` filenames remain supported. Back up this folder separately from SQLite.

The original Calculator reads stored inventory selling prices. Those imported values remain exact until a pricing input is edited. Supplier/markup edits calculate `supplier × (1 + markup)`; explicit lookup-rate overrides take priority. The original baseline stays immutable. The last saved shared library lives in SQLite; complete project files carry their own catalog/pricing snapshot. Existing projects keep their products and prices after shared-library replacements. **Use current pricing** explicitly adopts the last saved shared library and flags removed selections for review; Save or Save As is required to store that change in the file.

The **Pricing to edit** selector keeps shared-library and project-pricing drafts separate. **Save pricing** persists the shared inventory, rates and yields for the next launch; displayed units follow the calculation. **Discard changes** restores the last saved shared library. **Reset Library** loads the application's original products, prices and values into the draft; save to persist them, or discard to return to the previous save. In Current project pricing, the corresponding action is **Apply project pricing**, and Discard returns to the last applied project prices. Resetting that scope changes only its draft until applied and then saved with Save or Save As.

**Product/Service** replaces the three visible name/description columns. Before it is edited, the app selects the longest nonempty existing description or name, keeping one original label rather than combining potentially conflicting details. An explicit label then takes precedence. Editing it changes display text without renaming the stable selection keys used by existing estimates. Those keys and the original descriptions remain internal compatibility data.

**Estimator availability** contains two editable boxes. **Main Estimator groups** and **Firestopping Estimator groups** both accept group names separated by semicolons. The first box controls the Main Estimator selection lists. The second controls the Firestopping product dropdowns such as Collar Type, Wrap Type and Materials. Existing libraries initially retain their source-derived Firestopping memberships; once edited, the saved group list is authoritative. **Yield** is one value shared by the item's yield-bearing Main Estimator uses. It accepts a nonnegative number, `blank` or `empty text`; these last two preserve different calculation behavior. Different saved yields show **Mixed** and remain unchanged until explicitly replaced. One scalar cannot replace yields with different area/length dimensions. **Yield unit** remains read-only: `m² / unit` for area coverage or `m / unit` for mastic; uses without yields show no unit.

**Sell rate override** is hidden by default, not deleted: saved projects deliberately freeze rates and some imports contain independent rates. **Show rate overrides** reveals their matching semicolon-separated editor. A blank linked-rate override follows the product's sell price; a populated override is independent. The Sell price cell identifies retained estimator rates, so a product-price edit cannot silently appear to reprice a frozen use. Standalone rates retain their own editable Sell price.

### Export or replace the pricing library

1. Click the green **Export Excel** button in **Pricing library**. The `.xlsx` includes the entire effective library, including unsaved edits and items excluded by the current filter, with **Inventory & Rates** and **Instructions** sheets.
2. Nine visible columns contain **Item code**, **Product/Service**, **Supplier price**, **Markup**, **Sell price**, **Group**, **Firestopping groups**, **Yield** and **Yield unit**. The two group columns use semicolon-separated keys for their respective estimators. Product/Service is literal text, including any semicolon in the name. Yield is a single value; an unchanged Mixed value preserves differing saved yields. The locked unit column is derived from the Main Estimator groups.
3. Hidden columns preserve existing selection names, descriptions, independent rates, individual yields, IDs, ordering and optional product properties. Keep these columns and the source metadata when editing or sharing the workbook. Their per-use entries remain aligned semicolon-separated lists; follow Instructions for adding/removing uses and new products. Hidden rows and columns still import. The visible label and yield can be edited without manually editing those compatibility fields. Earlier workbook formats remain supported.
4. For linked rates, **Price source = Inventory** follows the inventory sell price. Editing a use's **Sell rate** makes it an **Override**; choose **Inventory** to restore the link. Supplier markup items calculate their sell price when supplier price or markup changes. Manual items accept a sell price directly.
5. Click the green **Import Excel** button, select the complete workbook, and review the added, removed and updated rows. Apply it to the selected pricing draft, then **Save pricing** for the shared library or **Apply project pricing** for the active estimate. Import alone does not save. Earlier 27- and 28-column compact workbooks, combined workbooks with separate **Inventory** and **Use** rows, and older exports with separate **Inventory** and **Rates** sheets are still accepted.

Each workbook replaces the inventory and uses in full, including hidden or filtered rows. The Instructions sheet explains markup, supported rate groups and the separate Number/Blank/Empty text/Not used yield types. Blank and empty-text yields have different estimating behavior and are preserved. Exported strings are literal text; import accepts values-only `.xlsx`, with no formulas, macros, external links or extra data sheets. The limit is 5 MB, 5,000 inventory records and 5,000 uses, with bounded ZIP contents and validated finite numbers. Use the exported template; arbitrary supplier spreadsheet layouts are not mapped automatically. The original `Inventory_list.xlsm` remains the immutable initial source, not the runtime import template.

The app retains Excel's unusual quantity adjustments, masking calculations, weekly access charging, unrounded intermediate prices and error results. It rounds money only for display; purchasing notes round positive quantities upward. See [Calculator specification](docs/CALCULATOR_SPEC.md) and [source mapping](docs/WORKBOOK_MAPPING.md).

## Verification

```powershell
python -m pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
node --check static/app.js
node --check static/calculators.js
node --check static/penetration.js
node --check static/downloads.js
node --check static/libraries.js
node --check static/library-editor.js
node tests/test_ui.cjs
node tests/test_calculators_ui.cjs
node tests/test_project_ui.cjs
node tests/test_penetration_ui.cjs
node tests/test_downloads_ui.cjs
node tests/test_libraries_ui.cjs
node tests/test_library_editor_ui.cjs
python scripts/build.py
```

Node is only needed for JavaScript syntax and UI regression checks. Development requirements include pypdf for inspecting generated reports in tests. The build creates `dist/ceasefire-estimator.zip`, containing the application, imported data, original Ceasefire logo, README and `requirements.txt`. Extract it, install `python -m pip install -r requirements.txt`, then run `python -m estimator` in that directory. The archive does not bundle Python or installed packages.

The regression fixture contains **216 scenarios and 32,616 outputs independently recalculated by Microsoft Excel**. All 151 default results also match the source workbook's cached outputs. Excel refused to open the original XLSM copies through automation, so scenario capture used the original Calculator formulas in a fresh macro-free workbook with the original saved lookup values. This verifies formula and fixed-lookup parity; it does not prove execution of the original workbook's external-link refresh. Source filters and inventory links are independently checked by the importer.

The three new XLSX calculators have separate native Microsoft Excel fixtures: every source formula, 300 corrected duct text outputs, and 258,039 varied outputs over 3,471 schedule cases. Those captures recalculate disposable copies of the actual original XLSX workbooks. Their committed fixtures run without Excel or OneDrive. See the mapping document for coverage, numeric tolerances and regeneration instructions.

To verify the import against the original files:

```powershell
$env:ESTIMATOR_WORKBOOK_DIR = 'C:\ESTIMATOR'
$env:ESTIMATOR_CALCULATOR_SOURCE_DIR = 'PATH TO BYTE-IDENTICAL ORIGINAL CALCULATOR WORKBOOKS'
python -m unittest discover -s tests -v
```

The second directory must contain the three original calculator filenames and
recorded source bytes. Editable OneDrive copies can differ after Excel saves
them. Strict reconstruction reports those differences even when separately
audited calculations agree; it never updates the frozen app source automatically.
See the [integrity audit](docs/CALCULATOR_INTEGRITY_AUDIT.md) and the later
[FyreWrap source reconciliation](docs/FYREWRAP_RULE_REVIEW.md).

Without the files, two source-reconstruction tests skip; all committed Excel fixtures still run. Tests also cover pricing workbook round trips, complete replacements, invalid imports, pricing links, quote metadata/names, deterministic work summaries, display precision and saved-quote isolation. Oracle regeneration is optional developer tooling and needs Microsoft Excel, PowerShell 7, and openpyxl; see `docs/CALCULATOR_SPEC.md`.

## Operating boundary

This is a single-computer application bound to `127.0.0.1`. It rejects foreign hosts/origins, limits request sizes, validates inputs, uses parameterized SQLite queries and has no CDN or remote runtime calls. It is not an authenticated multi-user service and has not been deployed. Do not expose this local HTTP server publicly.
