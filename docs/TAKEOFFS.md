# Manual drawing takeoffs

TAKEOFFS adds a drawing and evidence register to the existing project. It does
not change calculator formulas, shared pricing, frozen project prices or the
priced quote. Steel, Duct, Walls, Slabs and a manual Penetrations draft workspace
are available. AI proposals, independent visual validation and Physical Model
Locks are not part of this increment.

## Working with a drawing

1. Upload the original PDF and open its page. Use Fit page, zoom and Pan to
   inspect the source. Search reports the pages inspected, empty text pages and
   failures. It does not perform OCR.
2. Choose a printed scale from the calibration dropdown for an original-size
   PDF, or Calibrate a known distance in metres. A calibration never carries
   over to another page. Use a named Viewport for a separately scaled detail.
   A distorted scan or perspective photograph cannot support uniform calibration.
3. Trace a steel member or duct centreline. Complete it with a double-click or
   Enter; there is no separate Finish trace button. For a source-stated dimension,
   select the item in the register and use Change length basis with its exact
   citation and evidence. A column/riser height needs its own cited dimension;
   a plan line does not establish height.
4. Enter the physical quantity and required properties. Each repeated physical
   member has its own persistent identity. Extra supporting references do not
   add quantity. Split ducts at branches or changes of size, orientation,
   protection or mechanical system.
5. Select register rows to inspect their source. **Edit item** expands all fields,
   calculator-specific choices and evidence actions inside that row. **Apply item
   edits** keeps the changes; **Discard edits** restores the stored values. There
   is no separate Item Inspector. Filtering, sorting and grouping
   retain item IDs. Bulk changes show the affected count and form one undoable
   edit. Split and merge create successors with predecessor IDs and invalidate
   confirmation. Delete is recoverable through Undo and retained history.
   For Steel, split partitions an explicit repeated-member quantity while keeping
   the original member identities and per-member length. Merge reunites compatible
   records with identical properties and measurement basis. For Duct, split/merge
   operates on adjoining measured segments of an individual run. Neither operation
   infers physical steel cuts or resolves conflicting properties.
6. Inspect the exact revision, then explicitly Confirm it. There is no separate
   Review button: register items are Confirmed or Unconfirmed, with blocking
   issues shown separately. Missing evidence,
   invalid dimensions/quantities and unsuccessful rendering prevent confirmation.
   An edit invalidates the current approval; historical receipts remain readable.

Unknown properties remain blank. Confirmation records a local
user/session action, not an authenticated person's identity or a manufacturer
approval of technical suitability.

## Scale presets, viewports and drawing controls

The calibration dropdown initially shows **No Scale Selected**. It includes
1:2, 1:5, 1:10, 1:15, 1:20, 1:25, 1:30,
1:40, 1:50, 1:75, 1:100, 1:125, 1:150, 1:200, 1:250 and 1:300. A printed
ratio uses the original PDF's physical dimensions: metres per source coordinate
unit = UserUnit × 0.0254 / 72 × scale denominator. It cannot detect a drawing
that was resized before being placed in the PDF. Check its stated dimension;
use a manually calibrated baseline when the original sheet scale is uncertain.
Manual calibration already converts source coordinates to metres and therefore
must not apply UserUnit a second time.

Click **Viewport** to open the Viewports panel beside the drawing. Its rows show
the viewports on the current page, with a separate scale dropdown in each row.
Use **Add viewport** (+), mark two opposite corners, name the detail, and select
its printed scale or **Calibrate a known dimension**. For a manual viewport, click
the baseline endpoints inside it and enter the known distance. A trace starting
inside a viewport selects that viewport's calibration. Active viewports cannot
overlap, and one measured object cannot cross between scales. Split the actual
object at the boundary with separately supported geometry instead. A new viewport
can invalidate an existing page-scaled object in that region; reassign its basis
and confirm it again. Calibration revisions and Undo retain the previous evidence.
Select a viewport row, then use **Delete viewport** (trash) to remove it. Deletion
retains the original revision and invalidates affected confirmations and links;
it never silently gives those items another scale. Reassign an applicable scale
and confirm them again. Existing calculator values remain unchanged. Undo restores
the viewport, with fresh confirmation still required. The row's more button edits
its name, and the panel heading closes the panel.
Shared page scales and viewport outlines are available in Penetrations too; they
do not infer physical service quantities or approve the physical draft.

Zoom buttons retain the drawing point at the viewport centre. Ctrl/Cmd-wheel
retains the point under the cursor. Double left-click finishes a length/surface
trace without duplicating its final vertex; right-click cancels an unfinished
trace. Enter, Backspace and Escape remain available. The pointer, hand, length,
calibration, viewport, PDF upload, fit-page, cancel, search, stop-search,
page-navigation, linked-row update/detach, register export and schedule
buttons use icons with accessible names and the original labels on hover.

Drawing tools occupy the narrow vertical rail to the left of the plan. The
compact **Drawing document** selector, page controls, zoom and text search sit
below the plan and above the register. Source PDFs remain in the project; the
old document list and page thumbnails no longer occupy the tool rail.

In Select mode, selected measured markups show control points at their original PDF vertices.
Click a point to choose it, then use Ctrl/Cmd+Z while the drawing has focus, or
right-click that point and choose **Delete control point**. With one selected
markup and no chosen point, Ctrl/Cmd+Z removes its final outer vertex; with
multiple selected markups, choose a point explicitly. During an unfinished
trace, the shortcut removes only the last pending vertex. Text fields retain
their normal text-undo shortcut, and unapplied item or Settings edits must be
finished before changing stored geometry. A line keeps at least two vertices;
surface and exclusion boundaries keep at least three. Deleting a point never
silently deletes the entire item. The server validates the new geometry and
recalculates quantities, invalidates confirmation and marks linked rows stale.
Calculator inputs stay unchanged. **Undo last edit** restores the prior geometry;
review and confirm the restored item again before using its quantities.
Cited dimensions retain their source-region markers; use Re-trace geometry to
replace that evidence region. A single trace supports all 10,000 permitted
vertices. Larger combined selections disclose the 10,000-handle display limit;
select fewer markups to inspect the remaining points.

Drag a selected control point to reshape a measured line, surface or excluded
opening. The preview follows the pointer in original PDF coordinates; releasing
it submits one geometry edit for server validation. Invalid edits restore the
last saved geometry. Valid edits recalculate the measurement and invalidate its
confirmation and linked approval while preserving calculator values and source
evidence. Right-click the markup itself and choose **Delete markup** to remove
that object after confirmation. Other selected objects are retained, and
**Undo last edit** restores the removed draft.
Moving a cited dimension's source-region point changes its evidence marker;
the explicitly entered source length remains unchanged and needs fresh confirmation.

Surface tracing displays a closed boundary with a central square-metre preview.
Moving a surface control point also displays a provisional area. After an edit
is committed, the central label shows the server-calculated net area, including
excluded openings. Preview labels do not confirm an item or authorise transfer.

Ordinary mouse-wheel scrolling over the drawing scrolls the application page
until you click or keyboard-focus the drawing. The focus outline indicates when
the wheel scrolls inside a zoomed plan. Clicking or focusing outside the plan,
or pressing Escape, returns wheel control to the page. At a plan scroll boundary,
remaining wheel movement can continue onto the page. Ctrl/Cmd-wheel still zooms
around the cursor, and Pan continues to move the drawing.

Displayed lengths in the register, item summaries and transfer previews use two
decimal places. Stored measurements, calculator inputs, confirmation digests and
exported numeric values retain their full precision; display rounding never changes
quantities or calculation outputs.

The steel creation dialog captures Member mark, Level, Member type, Steel section,
Fire period, Exposure description, Product and Qty, plus Exposed sides for the
Board destination (with critical temperature where required). New Duct records
are rectangular and have no Shape
or Diameter input. Older circular records keep their original values and remain
ineligible for rectangular calculator transfer; opening them never converts them.

## Riser/Drop additions

Select a Steel or Duct item and use **Riser/Drop** to enter each additional length
in millimetres, its source page and a citation. Both risers and drops add positive
travel length; a drop is not a negative deduction. The effective per-member length
is the traced/cited base length plus the sum of these additions divided by 1,000.
The user's explicit repeated-steel rule is to add the amount to **each member**:
10 m + 500 mm at Qty 2 yields 10.5 m per member and 21 m total.

Additions keep persistent IDs and evidence, can be edited/removed, are undoable,
and invalidate confirmation and linked-transfer eligibility when changed. They
remain in saved projects and confirmed exports. Duct runs with additions cannot
be split/merged until the additions are explicitly reassigned, preventing an
unmeasured riser from being duplicated across successor runs. Compatible Steel
group operations retain the same per-member additions. Surface and physical-draft
records have no length additions.

## Walls and Slabs

Choose WALLS or SLABS, calibrate the applicable page scale, then **Trace surface**.
Click the boundary vertices in order and finish the trace; closure is automatic.
Identify the actual treated surface, its source reference, substrate, nominated
treatment and FRL. A wall polygon must depict a true wall face, such as an
elevation. A slab polygon explicitly identifies its top or soffit. A wall plan
footprint does not establish a wall-face area; no height or second face is inferred.

Each item represents one distinct physical treatment surface. Use **Add exclusion**
to trace an opening within the selected boundary and record its source/reason.
Exclusions must be strictly inside, without touching or overlapping each other
or the outer boundary. The register reports gross, excluded and net square metres.
The backend squares the calibration scale and keeps unrounded results; page
rotation, CropBox offsets, UserUnit, zoom and screen density do not change area.

The expanded register row can re-trace the boundary, edit original PDF vertices and edit or
remove individual exclusions. Each exclusion has a persistent ID. These edits
invalidate confirmation and can be undone. Bulk edits, row/source
selection, filtering, grouping, confirmation and project persistence use
the shared workspace. Surface split/merge is explicitly unavailable; grouping
separate surfaces preserves their individual identities.

Confirmed CSV/XLSX registers retain all exclusion geometry and source-bound area
checks. Surface items have no mapping to the existing length-based calculators
or priced quote, so calculator transfer is blocked for every area item.
Each surface supports at most 1,000 total vertices and 64 exclusions. Invalid,
self-crossing, degenerate or out-of-page geometry is rejected without changing
the current item. Multiple page scales must be separately calibrated.

## Penetrations: manual physical draft

The hierarchy is **Barrier → Defect → Opening → Service**. Create the barrier
first, then explicitly choose each child's parent. A defect may have several
openings; an opening may have several service types or no services at all.
An empty opening remains visible with zero services. Existing services require
an explicit positive integer quantity. No quantity is inferred from photographs,
image occurrences or missing inputs.

Each record has a persistent ID, its own typed fields, uncertainty and source
references. Parent fields are shown as context rather than copied into children.
Selecting a row opens its cited source page/region; supported evidence overlays
and register rows share selection and hover. Unknown dimensions and properties
remain blank. The hierarchical register can filter and page records while
retaining their parent context. Bulk edits preview all affected IDs and form
one undoable operation. Reparenting and cascade deletion require explicit
preview. Deleted records retain their identities, fields and evidence and can
be restored. A restore does not silently revive descendants deleted earlier.

Use **Extract images from selected PDF page** to retain the actual embedded
image evidence. The gallery identifies source, page, extraction and image
occurrence. Repeated views remain separate provenance occurrences but never
create physical records or quantities. Link an image to the specific barrier,
defect, opening or service it supports; one image may support several records.
The original source page remains available for text and surrounding context.

The original encoded PDF image stream and typed PDF metadata are retained
separately from the PNG display derivative. Inline images retain their exact
decoded BI–EI span and original enclosing content streams; normalized decoder
input is labelled separately. A PNG is not the original stream or a composite
rendering of the PDF page. Unsupported appearance effects, masks, colour spaces,
clipping, annotations and extraction failures are visible diagnostic issues.
Coverage states identify requested, processed, complete, failed and unrequested
pages. The application does not claim that an extracted image depicts all visible
page content. Text remains available through the shared PDF search, without OCR.

All physical records in this increment are **UNAPPROVED DRAFT**. CSV and
values-only XLSX exports retain the hierarchy, source/image hashes, quantities
asserted by the user, uncertainty and tombstone history with that label. They
cannot represent approved quantities, create calculator rows or advance a priced
quote. Independent image validation and a verified Physical Model Lock are
required by the later approval workflow.

## Transferring to calculators

Choose the explicit destination and exact database section/product choices.
Steel spray and steel board have separate section databases; no fuzzy mapping
is performed. Preview shows normalized inputs and proposed changes before they
are applied to the current project draft.
For Steel Board, preview also evaluates the proposed rows with the existing
calculator. An unavailable board design blocks the batch and shows the
calculator's reason. Supported designs retain its technical notes in the
preview; the application never changes project requirements to find a match.

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
After split/merge, successor transfers are blocked while a predecessor still has
an occupied linked row in that destination. Resolve the prior row explicitly;
the application never clears its quantities automatically. Historical links are
listed for review and detachment. Detaching retains the manual row's quantities,
so check them before adding successor quantities to the same schedule.

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

The nested takeoff snapshot remains schema version 1 for existing measurement
projects. The first physical edit or image extraction records an explicit
upgrade to nested schema version 2. Old audit files retain their original hashes.
Image manifests, original streams and display derivatives live in the companion
folder and are published before the JSON, including assets retained only in
history. Save As binds the window to the new copy of every retained asset.
An intact imported image manifest can be inspected and saved as a diagnostic
draft, but requires fresh local extraction before it can support later physical
approval. Its local extraction registry is never reconstructed from imported text.

Missing or damaged evidence can reopen for diagnosis but cannot authorize
confirmation, transfer or approved export. Imported receipt text is insufficient:
each load matches the project identity and content digest against the local
confirmation registry. A project moved to another installation requires fresh
human review, even when its portable evidence is intact.

## Implementation and bounds

### Register, markup controls and drawing downloads

The register's Select and Hide header checkboxes apply to every row matching the
current filters, including rows on later register pages. A checked Hide box hides
the corresponding markup. Expanding Item Details grows the page vertically.
Zone, Group and Notes are retained in saved data and provenance but are no longer
editable in the shared item forms. Existing Zone values still contribute to the
steel calculator Location. Spray exposure descriptions already identify exposed
sides; the separate numeric Exposed sides input is shown for Steel Board, where
the existing calculator requires it.

In Select mode, drag on blank drawing space to select markups fully contained by
the blue selection rectangle. Drag a selected markup to move the selected marks
on that page. A move preserves quantities and lengths, but invalidates review,
confirmation and calculator-link freshness because the source position changed.
It cannot move geometry outside its source page or calibration viewport. Source
citations and riser/drop references stay pinned to their original evidence.

The Settings gear opens a panel for the selected items. Multiple selection shows
the first item's values and applies only fields explicitly edited by the user.
The same pending-edit guard protects both Settings and Item Details. Markup
colour, fill, opacity and line width are presentation settings; changing them is
audited but does not change measurement confirmation or calculator inputs. Line
width is in physical PDF points (0.25–20); opacity ranges from zero to one.

Download XLSX copies the entire current Takeoffs type, including hidden and
unconfirmed items. It retains numeric precision with two-decimal length display,
labels drafts explicitly and leaves unknown values blank. Existing confirmed
CSV/XLSX register exports remain available separately.

Download PDF creates a static, compressed copy of the current source PDF with
visible markups of the active Takeoffs type. Each source page has a CEASEFIRE
legend identifying the marks, steel sections or duct dimensions and total
lengths; overflow legends continue on additional labelled pages. Drawing content
uses lossless compression; the app logo is rendered at print resolution. Adding
marks and legends does not guarantee a smaller file than the source.
Original drawings and calculator rows are not modified. Linked steel thickness
or board selections appear only when the locally registered confirmation and
transfer receipt match the exact current calculator row and source version.
Missing or stale calculator results are labelled Unavailable. Export does not
confirm an item or approve technical suitability.

The PDF derivative retains optional drawing layers and their default visibility,
but excludes source actions and attachments. Borderless links without a visible
appearance can be omitted. Visible source annotations or form widgets currently
require a flattened source PDF; the export reports this limitation instead of
silently dropping drawing content. Its bounded worker also rejects unsupported
page sizes, excessive output or a legend row that cannot fit on a continuation
page. These failures leave the original and the Takeoffs project unchanged.

- `takeoff_documents.py` manages exact-byte originals, upload ownership, verified
  snapshots, companion files and immutable history. Uploads use retry-checked
  binary chunks of at most 8 MiB. Limits are 100 PDFs, 250 MiB each and 2,000
  total pages, including retained document history. Removing a visible document
  does not free that capacity. Exceeding a limit is an error, never truncation.
- `takeoff_pdf_worker.py` parses with pinned pypdf in a child process with time,
  memory and CPU limits. Encrypted or malformed PDFs are explicitly rejected.
- `takeoff_model.py` validates typed state and computes lengths in metres from
  original, unrotated PDF coordinates. CropBox, page rotation and UserUnit are
  retained. Screen zoom/device pixel ratio affect display only. Precision is
  retained until display/export formatting.
- `takeoff_area.py` validates bounded polygon topology and computes true-surface
  areas and exclusions with the square of the retained page calibration.
- `takeoff_physical.py` and `takeoff_physical_operations.py` validate the separate
  draft graph and atomic previews. There are at most 10,000 entities including
  tombstones, 32 references per entity and 100 commands per bulk operation.
- `takeoff_image_worker.py` extracts images in a restricted child process;
  `takeoff_image_evidence.py` verifies every inventory path, byte hash, source
  binding and PNG dimension before retaining the result. A batch supports one
  to 25 explicit pages, 512 image occurrences, 16 megapixels per image, 256 MiB
  of files and a 16 MiB manifest. A project retains at most 2,000 extraction
  descriptors and 4 GiB of image evidence, including history. Limits fail
  explicitly; images are never resized or omitted to disguise incomplete work.
- The local image extraction registry records only this installation's verified
  worker results. Extraction provenance alone does not approve a physical fact.
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
- `takeoffs.js`, `takeoff-geometry.js`, `takeoff-physical.js` and `takeoffs.css` provide the manual
  workspace. Rendering, search results and register pages are
  bounded and loaded on demand.

Project JSON is limited to 16 MiB. Retained audit history is limited to 10,000
events, 32 MiB per segment and 256 MiB in total. These bounds can stop further
edits or saves before the PDF limits are reached; history is never automatically
discarded to make room.

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
`npm run test:takeoffs-lineage` checks Steel member partition/reunion and prevents
split successors from duplicating quantities in a retained predecessor row.
`npm run test:takeoffs-markups` exercises register header controls, sparse bulk
Settings edits, selection and movement on rotated/cropped drawings, save/reopen
and current drawing/schedule downloads using only disposable fixtures.
`npm run test:takeoffs-control-points` exercises selected PDF-coordinate handles,
targeted point deletion, minimum vertices, keyboard/text-edit guards, undo and
save/reopen, and actual browser-wheel focus and boundary behaviour.
`npm run test:takeoffs-plan-tools` checks the left tool rail and compact drawing
navigation, measured-line/surface/exclusion point dragging, live and committed
area labels, invalid-edit rollback, markup deletion/undo, save/reopen and downloads.
`npm run test:takeoffs-capacity` exercises 100 separate PDFs and 2,000 pages
through the rendered upload/search workflow, including complete search coverage
and bounded document workers without eager page thumbnails.
`npm run test:takeoffs-timeouts` verifies that a stalled PDF request becomes a
visible failure, blocks its evidence and permits a healthy retry. PDF opening,
page loading, rendering and text extraction each have a 30-second deadline.
`npm run test:takeoffs-areas` exercises wall/slab tracing, exclusions, rotated and
cropped sources with UserUnit 2, bulk edit/undo, confirmation, Save As/reopen and
CSV/XLSX export while checking that calculator state is unchanged.
`npm run test:takeoffs-penetrations` covers the rendered manual hierarchy,
retained images, evidence associations, bulk edit/undo, source navigation and
draft export through Save As/reopen. `node tests/test_takeoff_physical_ui.cjs`
checks the physical module's controlled-edit and stale-review contracts.

The rendered tests never connect to the user's running server. CI also runs the
complete existing Python/JavaScript regression suites and distribution build.
Live activation remains a separate saved-draft/restart approval.
