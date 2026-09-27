# Manual Steel and Duct takeoffs

TAKEOFFS adds a drawing and evidence register to the existing project. It does
not change calculator formulas, shared pricing, frozen project prices or the
priced quote. Steel and Duct are the available modes. Other disciplines and AI
are outside this release.

## Working with a drawing

1. Upload the original PDF and open its page. Use Fit page, zoom and Pan to
   inspect the source. Search reports the pages inspected, empty text pages and
   failures. It does not perform OCR.
2. Calibrate a known distance on that page, in metres, and explicitly confirm
   that the scale is uniform. Name separate scales on the same page. A
   calibration never carries over to another page. A distorted scan or
   perspective photograph cannot support this measurement method.
3. Trace a steel member or duct centreline, or mark a source region and enter
   the dimension actually stated there. A column/riser height needs its own
   cited dimension; a plan line does not establish height.
4. Enter the physical quantity and required properties. Each repeated physical
   member has its own persistent identity. Extra supporting references do not
   add quantity. Split ducts at branches or changes of size, orientation,
   protection or mechanical system.
5. Select register rows to inspect their source. Filtering, sorting and grouping
   retain item IDs. Bulk changes show the affected count and form one undoable
   edit. Split and merge create successors with predecessor IDs and invalidate
   review. Delete is recoverable through Undo and retained history.
6. Review the exact revision, then explicitly confirm it. Missing evidence,
   invalid dimensions/quantities and unsuccessful rendering prevent confirmation.
   An edit invalidates the current approval; historical receipts remain readable.

Unknown properties remain blank. Review and confirmation record a local
user/session action, not an authenticated person's identity or a manufacturer
approval of technical suitability.

## Transferring to calculators

Choose the explicit destination and exact database section/product choices.
Steel spray and steel board have separate section databases; no fuzzy mapping
is performed. Preview shows normalized inputs and proposed changes before they
are applied to the current project draft.

| Destination | Inputs supplied by the register |
| --- | --- |
| Steel spray | Physical quantity and per-member length, exact section, product, exposure, fire period and critical temperature |
| Steel board | Total lineal metres once, exact section, board product, sides, fire period, beam/column and critical temperature |
| Ductwork | Rectangular width/height, run length, product, FRL, exposure, orientation and explicit wall/floor penetration counts |

Circular ducts can be recorded, reviewed and exported, but the current calculator
accepts rectangular ducts only. A repeated duct group must be split into its
actual runs before transfer: the calculator rounds overlaps and strip counts
per run, so combining disconnected runs could change material quantities.

The batch is rejected before application if an item is unsupported, invalid or
unconfirmed, or the 1,000-row schedule capacity is exceeded. Appending uses only
entirely empty, unowned rows, including hidden inputs. An identical repeat is a
no-op. Changed source items require fresh confirmation and **Update linked
rows**. Manual destination edits, deletion, imports and stale previews create
conflicts. Detach links explicitly retains the row as a manual entry and keeps
its historical lineage. There is no automatic transfer to the priced quote.

CSV and values-only XLSX exports require current confirmations and verified
source evidence. They include IDs, member identities, measurement basis, source
pages/hashes and confirmation references. Transfer history in a register export
is the last receipt; it is not a fresh approval of a separately edited schedule.

## Saving and moving a project

Projects with takeoffs use project format version 2. Projects without takeoffs
retain version 1. PDF bytes are never embedded in JSON. Save/Save As publishes
and verifies the immutable evidence files first, then atomically replaces the
JSON last. A cancelled or failed save leaves the previous project intact.

Keep the JSON together with its recorded relative companion folder:
`.ceasefire-evidence/<persistent-project-id>/`. Save As copies required originals
and history to the destination; renaming a JSON file does not change project
identity. Originals and audit segments are content-addressed and are not
automatically deleted. To replace a drawing, ingest its new bytes as a new
document revision and explicitly update affected objects. Historical evidence
remains retained.

Missing or damaged evidence can reopen for diagnosis but cannot authorize
confirmation, transfer or approved export. Imported receipt text is insufficient:
each load matches the project identity and content digest against the local
confirmation registry. A project moved to another installation requires fresh
human review, even when its portable evidence is intact.

## Implementation and bounds

- `takeoff_documents.py` manages exact-byte originals, upload ownership, verified
  snapshots, companion files and immutable history. Uploads use retry-checked
  binary chunks of at most 8 MiB. Limits are 100 PDFs, 250 MiB each and 2,000
  total pages; exceeding a limit is an error, never truncation.
- `takeoff_pdf_worker.py` parses with pinned pypdf in a child process with time,
  memory and CPU limits. Encrypted or malformed PDFs are explicitly rejected.
- `takeoff_model.py` validates typed state and computes lengths in metres from
  original, unrotated PDF coordinates. CropBox, page rotation and UserUnit are
  retained. Screen zoom/device pixel ratio affect display only. Precision is
  retained until display/export formatting.
- `takeoff_workspace.py` controls expected revisions, idempotent commands,
  review/confirmation, transfer receipts and paged history. Small additive SQLite
  tables store local approval/transfer authority.
- `takeoff_transfer.py` uses the existing public calculator model and validation
  choices. The browser applies the preview through a reserved public calculator
  interface, preserving unrelated rows/settings and detecting draft races.
- `takeoff_http.py` exposes bounded, same-origin capability routes. Host/Origin,
  path containment, regular-file/reparse-point and manifest checks remain active.
  PDF range reads use a bounded verified snapshot cache instead of rehashing
  250 MiB for each range. Sensitive approval/export gates reverify originals.
- `takeoffs.js`, `takeoff-geometry.js` and `takeoffs.css` provide the manual
  workspace. Rendering, page thumbnails, search results and register pages are
  bounded and loaded on demand.

PDF.js **6.3.289 legacy display build** is bundled under `static/vendor/pdfjs`,
with its matching worker, fonts, CMaps, decoder assets, Apache licence and a
per-file SHA-256 manifest. `scripts/vendor_pdfjs.py` reproduces these files from
the checksum-pinned official release. The application uses same-origin assets,
non-WASM decoding and built-in font rendering under the strict default CSP.
PDF scripting and XFA are not enabled. TAKEOFFS does not require annotation
compatibility or a CSP exception.

## Validation

Run focused Python tests with `python -m unittest discover -s tests -p
'test_takeoff*.py' -v`; run `node tests/test_takeoffs_ui.cjs` for browser module
contracts. `npm ci`, `npx playwright install chromium`, then
`npm run test:takeoffs-browser` runs the rendered production-app journey with
synthetic drawings, a disposable database and controlled save dialogs.
`node tests/browser/pdf_render_gate.cjs` independently checks strict-CSP fonts,
scans, crop/rotation/UserUnit coordinates and JPEG2000 rendering.
`npm run test:takeoffs-capacity` exercises 100 separate PDFs and 2,000 pages
through the rendered upload/search workflow, including complete search coverage
and bounded document workers and thumbnails.
`npm run test:takeoffs-timeouts` verifies that a stalled PDF request becomes a
visible failure, blocks its evidence and permits a healthy retry. PDF opening,
page loading, rendering and text extraction each have a 30-second deadline.

The rendered tests never connect to the user's running server. CI also runs the
complete existing Python/JavaScript regression suites and distribution build.
Live activation remains a separate saved-draft/restart approval.
