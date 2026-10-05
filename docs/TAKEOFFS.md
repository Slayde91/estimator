# Manual drawing takeoffs

The PR #154 controls baseline and the search/free Call-out extension are described
here. Publication and live activation require their dated release receipts. See
[roadmap](../ROADMAP.md) and [Takeoffs architecture](TAKEOFFS_ARCHITECTURE.md)
for source behaviour, model boundaries and release gates.

TAKEOFFS adds a drawing and evidence register to the existing project. It does
not change calculator formulas, shared pricing, frozen project prices or the
priced quote. Steel, Duct, Walls, Slabs and a manual Penetrations draft workspace
are available. AI proposals, independent visual validation and Physical Model
Locks are not part of this increment.

## Working with a drawing

Typing into Search opens results directly below the field. Yellow highlights show
the sentence context; orange highlights show the measured matched words. Phrases
can cross text runs. Clear the input or choose **Stop search** to cancel extraction
and clear the field, list and highlights. Old work cannot restore cleared results.
Use Up/Down in the dropdown, Enter to choose and Escape to close it.

**Search** first chooses the closest match to the centre of the current view.
Repeated activation advances in the current page's display reading order and
wraps. Equal distances retain that order. Changing page starts the nearest cycle
again. A page without a match stays in place and reports it; choose another page
explicitly from the dropdown. Scans have no searchable text without a text layer.
The 500-result cap and missing/failed page coverage are disclosed. Where exact
glyph geometry is unavailable, the result labels its whole-text-run fallback.

## Drawing shortcuts

Every tool has its assignment in its tooltip. Upload PDFs has no shortcut.
These apply while focus is inside Takeoffs and outside an editor or dialog.
Disabled/hidden actions, IME composition and repeated keydown events are guarded.
Ctrl+0 still fits the page. Native copying, pasting, cutting, selecting, saving,
undo and browser navigation retain their existing keys.

| Action | Shortcut |
| --- | --- |
| Select | Ctrl+; |
| Pan | Ctrl+[ |
| Settings | Ctrl+] |
| Viewport | Ctrl+backslash |
| Calibrate | Ctrl+F1 |
| Trace length | Ctrl+F2 |
| Count | Ctrl+F3 |
| Count steel lengths | Ctrl+F7 |
| Trace surface | Ctrl+F8 |
| Add exclusion | Ctrl+F9 |
| Length | Ctrl+F10 |
| Markups | Ctrl+comma |
| Legend | Ctrl+period |
| Visibility | Ctrl+/ |
| Call-out | Ctrl+apostrophe |

## Free Call-outs

In Steel, Duct, Walls or Slabs, choose **Call-out** and click the drawing.
**Item Details** contains rich text with bold, italic, underline and bullet/number
lists. Paste inserts plain text. Shared appearance controls and **Set as default**
apply to new free and physical Call-outs; existing saved styles remain intact.
The physical Call-out action keeps its existing draft hierarchy and quantities.
Both actions use the original supplied icon.

A free Call-out is a drawing note with its own persistent ID and source location.
It adds no register entry, measurement, quantity, physical approval or calculator
transfer. Select it to edit, drag its box to reposition the label, drag its source
point to move the note, or drag its bottom-right handle to resize. Finish Item
Details before drawing moves. **Undo last edit** restores its retained identity
and original coordinates. Project Save/reopen and marked PDF retain the note.
**Hide Call-out** affects the visible PDF; open Settings and choose **Show hidden
Call-outs** to restore hidden notes. **Discard pending edits** restores the latest
accepted note while allowing an already-sent update to settle.

Notes support at most 8,000 characters, 64 text blocks and 256 formatted runs;
there are at most 1,000 free notes in a project. Text that cannot fit or contains
a character unsupported by the PDF font fails export explicitly, with the original
text retained. Resize the box or edit that text before exporting.

1. Upload the original PDF and open its page. Use Fit page, zoom and Pan to
   inspect the source. Search reports the pages inspected, empty text pages and
   failures. It does not perform OCR.
2. Choose a printed scale from the calibration dropdown for an original-size
   PDF, or Calibrate a known distance in metres. A calibration never carries
   over to another page. Use a named Viewport for a separately scaled detail.
   A distorted scan or perspective photograph cannot support uniform calibration.
3. Trace a steel member or duct centreline. Complete it with a double-click or
   Enter; there is no separate Finish trace button. A rise or drop needs an
   explicitly entered length at a control point; a plan line does not establish
   height. Previously saved source-cited lengths retain their original basis.
4. Enter the physical quantity and required properties. Each repeated physical
   member has its own persistent identity. Extra supporting references do not
   add quantity. Split ducts at branches or changes of size, orientation,
   protection or mechanical system.
5. Select register rows to inspect their source. **Edit item** expands all fields,
   calculator-specific choices inside that row. **Apply item
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

The **Scale** ruler button opens or hides the scale dropdown, **Calibrate**
and **Edit calibration** controls. Escape closes this panel and returns focus to
the button. The button's tooltip reports the current page scale.

After a page renders successfully, a clear supported scale in its PDF footer/title
block is applied automatically and retained with its source text, location and
document hash. Existing page or viewport calibrations are never replaced.
Ambiguous scales, NTS/AS SHOWN, scans without extractable text and mismatched
explicit paper sizes remain manual. This detects printed text, not distortion
within a drawing. Review the Scale control or calibrate a known dimension when
needed. Without a detected scale the dropdown shows **No Scale Selected**. It includes
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
Use **Add viewport** (+), click the first corner, then double-click the opposite
corner to finish the filled rectangular preview and open the name/scale dialog.
A single click adjusts the opposite corner; Enter finishes two chosen corners.
Right-click or Escape cancels without creating a scale. Choose a printed scale
or **Calibrate a known dimension**. For a manual viewport, click
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
retains the point under the cursor. Wheel and trackpad movement scales by its
distance, with a visible preview each animation frame and a sharper PDF bitmap
after the gesture settles. The page and markups remain together while rendering;
older renders cannot replace a newer zoom or reset a pan. This shared viewer
applies to every Takeoffs type, including portrait, landscape and rotated plans.
Double left-click finishes a length/surface
trace without duplicating its final vertex; right-click cancels an unfinished
trace. Enter, Backspace and Escape remain available. The pointer, hand, length,
viewport, PDF upload, fit-page, search, stop-search,
page-navigation, linked-row update/detach, register export and schedule
buttons use icons with accessible names and the original labels on hover.

Drawing tools occupy the narrow vertical rail to the left of the plan. The
text search sits immediately above the viewer, with page/zoom controls centred
in its bottom edge. Scale sits at the top left before the source selector and search controls.
Drawing XLSX/PDF downloads sit in the applicable register header; workspace
choices are in the Takeoffs header disclosure.
Source PDFs remain in the project; the
old document list and page thumbnails no longer occupy the tool rail.

**Source documents** is above the drawing. Use **Select PDF text** (the I-beam)
in the bottom toolbar to drag across embedded PDF text, then press Ctrl/Cmd+C.
The native selection stays aligned while zooming. Scanned image pages have no
selectable text unless the original PDF already includes a text layer; this
tool does not perform OCR. Switch to **Select** to edit markups or **Pan** to
move the drawing.

The Steel register filters from **Confirmation**, **Member mark**, **Level**,
**Member type**, **Steel section** and **Fire period (min)**. The Duct register
filters from **Confirmation**, **Item**, **Level**, **WxH (mm)**, **FRL** and
**Orientation**. Each filter has a value
search, checkboxes, **Apply filter** and **Reset filter**. Multiple selected values
within one column are alternatives; filters across columns must all match.
The register search further narrows those results. Filters do not change saved
records, confirmation or quantities and are cleared when another project opens.
Steel and Duct retain separate filter selections. Their old confirmation, sort
and grouping dropdowns are replaced by these column filters. Steel and Duct use one filtered-selection toggle: it selects matching items
or deselects them when all matching items are selected. Selection outside the
filter is retained. The old separate Clear selection action is removed.
**Detach links** retains manual calculator values. Historical links are still
accessible through the calculator row's **Open takeoff** action.

## Count steel members

Choose **Count steel lengths**, then click once for each physical member.
Each marker requires a manually entered length in metres; no drawing calibration
is required or used to infer that length. **Use this length for additional counts**
reuses the entered value for the rest of this Count. Otherwise, each marker opens
the length dialog. Double-click or Enter finishes without adding an extra marker.
Right-click or Escape cancels the unfinished count.

Finishing opens **Count details** on the left of the drawing. All markers in that Count
share the steel section, fire requirements, product and other details. Start a
new Count for different details. Different manual lengths form separate register
rows within the Count; equal lengths form one row. **Length per member (m)**
automatically updates that group's manual length and combines matching lengths in the same
Count while retaining every member identity. Separate Counts stay separate.

Qty is read-only and comes from the number of markers. Right-click a marker and
choose **Delete count marker** to remove that exact member and reduce Qty. The
last marker removes its row. **Undo last edit** restores the marker identities;
quantity or length changes require fresh confirmation and leave linked calculator
values unchanged until an explicit update. Generic quantity split/merge and
trace-vertex deletion do not apply to Count markers.

The panel also controls circle, square, triangle or diamond symbols, size in
physical PDF points, stroke/fill colours, opacity and fill. Appearance changes
apply to the whole Count and do not change quantities or confirm technical
suitability. Saved projects and exports retain Count/member identities, original
PDF coordinates and the full manual length precision. Marked PDFs draw independent
symbols without connecting lines. Existing Steel calculator transfer mappings
remain unchanged: each row supplies its per-member length and marker-derived Qty.

## Standalone counts and lengths

In Duct, **Count** below **Trace length** counts markers without a
length or calibration, using a crosshair cursor. Enter Item, Level and WxH (mm), and choose FRL and
Orientation. **Total Count/QTY** comes from the retained markers and cannot be
typed independently. Continuing a count retains its member identities; deleting
a marker reduces only that count. Steel's standalone **Count** creation button
is hidden; saved standalone Steel counts retain their register, editing,
continuation, history and export behavior. **Count steel lengths** remains available.

In Walls and Slabs, **Length** below **Add exclusion** measures a calibrated
polyline in metres. Enter its Item and Level. If its calibration is removed,
attach a current calibration to calculate the length again.

Standalone rows appear below ordinary calculator items in the register. They
are saved with their source geometry and included in register and drawing
exports. Every calculator transfer path rejects them. They do not change
existing counted steel lengths or surface measurements. Duct's visible **Item**
label retains the same stored identifier field used by earlier projects.

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
Cited dimensions retain their source-region markers and source-stated lengths.
A single trace supports all 10,000 permitted
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

Displayed lengths in the register, item summaries, transfer previews, drawing
and marked-PDF measurement labels use two decimal places; drawing area labels
also use two decimal places. Stored measurements, calculator inputs, confirmation digests and
exported numeric values retain their full precision; display rounding never changes
quantities or calculation outputs.

The steel creation dialog captures Member mark, Level, Member type, Steel section,
Fire period, Exposure description, Product and Qty, plus Exposed sides for the
Board destination (with critical temperature where required). New Duct records
are rectangular and have no Shape
or Diameter input. Older circular records keep their original values and remain
ineligible for rectangular calculator transfer; opening them never converts them.

With the drawing focused, select calibrated Steel or Duct Length markups and use
**Ctrl/Cmd+C**, move the pointer onto the drawing, then **Ctrl/Cmd+V**. The first
copied line's first point lands at the pointer; other selected lines keep their
relative positions. Copies keep their entered details, explicit quantities,
appearance and supporting citations, but receive new identities and start
unconfirmed without calculator links. The destination page/viewport calibration
recalculates their lengths. A stale copied source, ambiguous scale, out-of-page
placement or viewport crossing is rejected without creating partial copies.
Count markers, cited dimensions and surfaces are not Length copies. Text fields
retain ordinary copy/paste. Clicking empty drawing space clears selection in
both the drawing and register without deleting any objects.

## Rise/Drop additions

Select a traced Steel or Duct item, right-click a control point and choose
**Insert Rise / Drop**. Enter Type and Additional length in millimetres. The
source document, page and precise control point are retained automatically;
no citation is required. Both rises and drops add positive
travel length; a drop is not a negative deduction. The effective per-member length
is the traced/cited base length plus the sum of these additions divided by 1,000.
The user's explicit repeated-steel rule is to add the amount to **each member**:
10 m + 500 mm at Qty 2 yields 10.5 m per member and 21 m total.

Additions keep persistent IDs and evidence, can be edited/removed, are undoable,
and invalidate confirmation and linked-transfer eligibility when changed. They
remain in saved projects and confirmed exports. Anchored additions are labelled
on the drawing and its marked PDF download. Moving a control point carries its
addition with it; deleting that point requires removing its addition first.
Ambiguous re-tracing is rejected rather than guessing a new anchor. Existing
unanchored additions and their citations remain valid. Duct runs with additions cannot
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
The Add surface dialog includes Level, FRL, Substrate, Treatment, Protection
system and Protection product alongside the required surface identity, basis,
source citation and explicit single-surface quantity. These details are retained
in Item Details and the register after creation.

Each item represents one distinct physical treatment surface. Use **Add exclusion**
to trace an opening within the selected boundary and record its source/reason.
Exclusions must be strictly inside, without touching or overlapping each other
or the outer boundary. The register reports gross, excluded and net square metres.
The backend squares the calibration scale and keeps unrounded results; page
rotation, CropBox offsets, UserUnit, zoom and screen density do not change area.

The expanded register row can re-trace the boundary, edit original PDF vertices and edit or
remove individual exclusions. Each exclusion has a persistent ID. These edits
invalidate confirmation and can be undone. Bulk edits, row/source
selection, filtering, confirmation and project persistence use the shared
workspace. Surface split/merge is explicitly unavailable.

The column filters cover **Confirmation**, **Wall ID** or **Slab / zone ID**,
**Level**, **Surface basis**, **Substrate**, **Treatment**, **Protection system**,
**Protection product** and **FRL / fire rating**. They use the same value search,
checkboxes, Apply and Reset as the other registers; values within a column are
alternatives and active columns must all match. Wall and Slab filter selections
stay separate. These filters replace the confirmation, sort and grouping menus.

Selecting a surface opens Item Details in the left Settings pane. Clicking the
sole selected surface again or empty drawing space clears selection and closes
the pane. Modifier keys keep multiple selection available. Pending field edits
finish saving before selection changes or the pane closes; selecting or clearing
items does not change their evidence, geometry or physical quantity.

Confirmed CSV/XLSX registers retain all exclusion geometry and source-bound area
checks. Surface items have no mapping to the existing length-based calculators
or priced quote, so calculator transfer is blocked for every area item.
Each surface supports at most 1,000 total vertices and 64 exclusions. Invalid,
self-crossing, degenerate or out-of-page geometry is rejected without changing
the current item. Multiple page scales must be separately calibrated.

## Penetrations: Defect Reports and Service Plans

**Defect Reports** retains the existing **Defect → Barrier → Service** hierarchy.
Use **Add defect** to
create a root row. On that row, the **+** in the Barrier ID column creates a
child barrier; on a barrier row, the **+** in the Service ID column creates a
child service. A defect may have several barriers, and a barrier may have
several service types or no services. There is no Opening level or Opening
field in the active workflow. An empty barrier remains visible with zero
services. Existing services require
an explicit positive integer quantity. No quantity is inferred from photographs,
image occurrences or missing inputs.

**Service Plans** is a separate **Barrier → Service** register in the same
project. It has no defect record or Defect ID column. **Add substrate** opens
the barrier form; a barrier's **+** creates a child service. FRL is stored on
the barrier, uses the Firestopping choices, and is displayed as
inherited context for its services. Switching sub-tabs never copies, merges or
reparents records between these two hierarchies. Both retain their own numbered
identities and are saved in the project.

In Defect Reports, **Call-out** arms a crosshair. Clicking the
original PDF shows a pending source marker and opens **Add Defect**. The existing
reviewed creation flow retains the exact source hash, page and clicked PDF point
in a small source-location annotation clipped to the page. This annotation does
not infer physical size, area, barriers, services or quantities. Cancelling the
form or review creates no record. The register's **Add defect** can still create
an unplaced defect. An unmarked barrier's Item Details has **Place count marker**
to add its position later. In Service Plans, **Call-out** uses a crosshair to
place an existing or new barrier directly on the original PDF page.
Each marker has an automatic callout derived from
the barrier fields and its active services. Editing those records updates the
description; the marker does not infer or multiply service quantities. Selecting
a marker opens **Item Details** on the left of the PDF; deselecting it closes
the pane. In Defect Reports it
opens the parent Defect first while keeping the actual marker selected for
drawing actions. A compact **Defect | Barrier | Service** dropdown table lists
all active IDs and switches the details pane to the chosen record. Service
Plans uses **Barrier | Service** without a Defect column. Register selection
opens the selected record's details directly.
The **Settings** button also opens that pane. Barrier Item Details includes an
**Add service** action, and Defect Item Details can add a child barrier.
The former inspector below the
register is removed; reviewed changes, source associations and retained-image
actions are available through Item Details. Ordinary field edits validate and
apply automatically after a short typing pause or when leaving the field. There
is no Preview physical edits button. Invalid input is retained for correction,
and edits made during a save are applied in order. These changes remain drafts;
creation, reparenting and cascade deletion retain their existing review dialogs.

Marker positions use the original page coordinates and retained source hash.
In Select mode, drag the marker to move its position or drag its callout to move
the description. Clicking or keyboard-selecting a callout selects it for moving
or resizing and leaves Item Details open or closed as it was. A selected callout has four corner handles
for resizing. Its text wraps to the available width and adjusts to fit its
height. Marker and callout movement use server validation and retain their source
identity. **Remove count marker** removes only its
position: the barrier, services and evidence remain. Deleting a barrier uses the
existing reviewed cascade choice and retains its marker in the tombstone for
restoration. Drawing PDF downloads include the selected sub-tab's markers and
derived descriptions; original PDF bytes are preserved.

The red **+** and trash icons sit directly below the register, above pagination.
In Item Details, Add service uses the same compact red **+** button class and
styling as Add Substrate beneath the register, and discard sits beside
trash at the bottom of the pane. Selection and clear-selection use checked and unchecked box
icons; the bulk-edit icon opens the existing same-type edit review. CSV and XLSX
use the standard dark download buttons. Icon-only actions retain accessible
names and hover descriptions.

Each record retains a UUID and receives a visible sequential ID: **D-0001**,
**B-0001** or **S-0001**. The server assigns each type's sequence independently
within each workspace. IDs remain unchanged through edits, reparenting, deletion,
Undo, save and reopen; deleted or undone IDs are never reused. Each record has
its own typed fields, uncertainty and source references. Parent fields are
shown as context rather than copied into children.
Selecting a row opens its cited source page/region; supported evidence overlays
and register rows share selection and hover. Unknown dimensions and properties
remain blank. The hierarchical register can filter and page records while
retaining their parent context. Column filters support multiple values, blanks
and value search for State / uncertainty, Location, FRL, Substrate, Orientation,
Category and Service type. Different columns combine to narrow the results; the
register search searches those filtered results. Required ancestor rows remain
visible as context. Bulk edits preview all affected IDs and form
one undoable operation. Reparenting and cascade deletion require explicit
preview. Deleted records retain their identities, fields and evidence and can
be restored. A restore does not silently revive descendants deleted earlier.

Saved version 1 physical graphs retain their original
**Barrier → Defect → Opening → Service** relationships, fields, UUIDs and evidence.
They are read-only in Penetrations and remain available for inspection, save,
reopen and export. New relationships must be assigned explicitly before those
graphs can use the new workflow; there is no migration or relationship-assignment
UI yet. Opening records are never silently removed or converted.

Use **Extract images from selected PDF page** to retain the actual embedded
image evidence. The gallery identifies source, page, extraction and image
occurrence. Repeated views remain separate provenance occurrences but never
create physical records or quantities. Link an image to the specific defect,
barrier or service it supports; one image may support several records.
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
include the visible Defect, Barrier and Service IDs alongside the exact UUID
links. Defect Reports version 2 XLSX exports have Defects, Barriers and Services
sheets, with no Opening sheet or fields. Service Plans version 3 exports contain
Barriers and Services, with barrier FRL and no defect relationships. Each export
contains only its selected sub-tab. Legacy exports retain their original format. They
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
retain version 1. PDF bytes are never embedded in JSON. Save publishes
and verifies the immutable evidence files first, then atomically replaces the
JSON last. A cancelled or failed save leaves the previous project intact.

Keep the JSON together with its recorded relative companion folder:
`.ceasefire-evidence/<persistent-project-id>/`. Choosing a new Save destination copies required originals
and history to the destination; renaming a JSON file does not change project
identity. Originals and audit segments are content-addressed and are not
automatically deleted. To replace a drawing, ingest its new bytes as a new
document revision and explicitly update affected objects. Historical evidence
remains retained.

The nested takeoff snapshot remains schema version 1 for existing measurement
projects. The first physical edit or image extraction records an explicit
upgrade to nested schema version 2. Old audit files retain their original hashes.
The physical graph has its own version: new Defect Reports graphs use version 2
for Defect → Barrier → Service, while saved version 1 physical graphs remain
unchanged and read-only. The optional `service_plans` graph uses version 3 for
Barrier → Service. Old projects without that graph continue to open without
creating a synthetic defect or modifying their original graph. These graphs are
retained inside the nested version 2 takeoff
snapshot. Numbered identities and their sequence are checked against retained
audit history, including tombstones, so save/reopen does not reset numbering.
Image manifests, original streams and display derivatives live in the companion
folder and are published before the JSON, including assets retained only in
history. A successful Save binds the window to the new copy of every retained asset.
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
citations retain their original evidence. Anchored rises and drops move with
their traced control points while keeping their explicit additional lengths.

Search and the document selector sit in the viewer's top-centre overlay. Page
navigation, Select, Pan, Select PDF text and zoom controls sit in its bottom-centre overlay.
The Source documents list above the viewer opens each retained original PDF.

Item Details saves validated field changes automatically and provides a
**Delete item** trash icon. Deleting a linked item also clears its linked
schedule rows. A manually changed linked row blocks the entire deletion.
**Undo last edit** restores the items and cleared rows together, including after
saving and reopening the project; unrelated calculator edits are preserved.
Calculator formulas and shared pricing are unchanged. Removed editor actions
do not remove historic source references or cited lengths from saved data.
If a connection interruption leaves a linked change awaiting a response, keep
the page open and use **Retry linked change**. Both drafts stay protected from
further edits until the result is recovered.

The Settings gear opens a panel on the left, bounded to the drawing viewer height
with its own scrollbar. Multiple selection shows the first item's values and
automatically applies only fields explicitly edited by the user. Typing is
debounced; changes are serialized and validated before selection or project save
can proceed. Each Count length group has **Length per member (m)** beside its
read-only **Count quantity**. Equal lengths regroup without losing member identities;
late edits stay pinned to the members originally shown in that field. There are
no separate Apply/Discard settings controls; committed changes use **Undo last edit**.
The Item Details action group contains only the trash button. Drawing tools and
control-point editing remain available from the viewer.
New markup stroke and fill colours default to red; explicit saved colours are
retained. Markup
colour, fill, opacity and line width are presentation settings; changing them is
audited but does not change measurement confirmation or calculator inputs. Line
width is in physical PDF points (0.25–20); opacity ranges from zero to one.

New drawing markups use Line Width 5, Fill enabled, Marker Size 25 and Display
Values off. Browser defaults can retain chosen appearance, while newly created
markups always start with Display Values off. Existing saved values stay exact.
**Visibility** in every drawing toolbar hides or shows all drawing markups and
legends without changing the register, source evidence or export selections.

Steel **Markups** applies the supplied 40-colour construction-plan palette to
Length and Count markups on every page of the selected PDF. It uses only current
receipt-linked native calculator thickness, rounds positive thickness to the
nearest whole millimetre (half values round up) for the two-millimetre bands,
and uses Pine from 79 mm. Missing or stale values stay unchanged and produce an
incomplete-markup message. Switch it off to restore the colours captured before
the first application. The exact thickness remains in the register and legend.
Colour commands are audited presentation operations; measurements, confirmation
and calculator inputs stay unchanged.

Steel and Duct **Legend** toggles a persisted box on the current drawing page.
Creation requires at least one visible eligible Length/Count markup on that page.
Hidden items and global markup hiding are excluded; free Call-outs are ineligible.
A visible legend remains removable after deleting its last eligible markup.
Drag the box or its four corner handles; double-click it for independent line,
fill and font settings. Entries group the page's items by colour and retain
their marks, steel sections or duct dimensions and total lengths, and exact
native thickness. Duct thickness is native spray DFT or native continuous-wrap
layers multiplied by the configured layer thickness, converted from metres to
millimetres. Local penetration layers do not inflate body thickness. Stale or
detached calculator links withhold the result. Marked PDF downloads include
visible persisted drawing legends as well as the existing provenance legend.

Physical callouts place the Defect first, then each Barrier immediately followed
by its Services. Service lines retain explicit quantity, category, type and
dimensions without repeating their parent Barrier ID. Marker and callout styles
are independent; callouts include Font Colour. With the drawing focused, Ctrl+C
and Ctrl+V copy a selected Defect or Barrier and its complete active hierarchy
at the pointer with fresh UUIDs and serial display IDs. Copies retain evidence
and original revision provenance and remain unapproved drafts. Right-clicking a
Defect callout and choosing **Delete** atomically retains deleted records for the
Defect and its descendants, allowing restoration through existing history.
Inspector source-association helper cards are hidden; the retained evidence,
register identities and exports remain available.

**Pan** drags the paper freely beyond every viewer edge, including at small zoom
levels and from the grey background. **Fit page** restores a visible centred page
with room for the floating controls. Pan and zoom never change source geometry,
calibration or quantities. Length traces have no filled interior or red glow.
Use Escape or right-click to cancel an unfinished trace; there is no Cancel trace
toolbar button.

Download XLSX copies the entire current Takeoffs type, including hidden and
unconfirmed items. It retains numeric precision with two-decimal length display,
labels drafts explicitly and leaves unknown values blank. Existing confirmed
CSV/XLSX register exports remain available separately.

For Defect Reports and Service Plans, **Download PDF** creates a static copy
of the source drawing with the visible callouts as shown in the viewer, including
their wording, fonts, wrapping, styles, positions and page rotations. The download
retains the source page count and sizes and has no added Takeoff legend or legend
references. Hidden markups remain hidden in this drawing download.

The separate **Download Passive Fire Matrix PDF** button creates
**Passive_Fire_Matrix.pdf**, titled **Passive_Fire_Matrix**. Its table contains
Defect ID, Barrier ID, Service ID, Location, FRL, Substrate, Orientation, Category,
Service type, Service quantity and Service Size (mm). It includes active register
records, including empty defects and barriers, with blank fields where no value
is recorded. Service Plans leaves Defect ID blank. The export requires the current
draft revision and remains an unapproved draft. Historical width, height, diameter
and insulation values remain in saved records; their inspector fields are hidden
and Service Size is the visible size input.

For Steel, Duct, Walls and Slabs, Download PDF creates a static, compressed copy
of the current source PDF with visible markups of the active Takeoffs type. Each source page has a CEASEFIRE
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
  versioned draft graphs and scoped atomic previews. Version 2 enforces Defect →
  Barrier → Service; version 3 enforces Barrier → Service without defect links.
  Both use server-assigned display IDs and validate marker source bindings.
  Version 1 validation preserves the
  original four-level graph. The workspace blocks version 1 physical mutations.
  There are at most 10,000 entities including tombstones, 32 references per
  entity and 100 commands per bulk operation.
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
`npm run test:service-plans` covers independent penetration sub-tabs, barrier FRL,
Count placement on a rotated/cropped source, marker selection and Item Details,
automatic callouts, movement and removal, scoped exports and project reopening.

The rendered tests never connect to the user's running server. CI also runs the
complete existing Python/JavaScript regression suites and distribution build.
Live activation remains a separate saved-draft/restart approval.
