# Takeoffs, projects and presentation architecture

Updated 6 October 2026. This describes the PR #154 baseline, the search and free
Call-out extension, and the browser feedback and explicit library-link increment. Publication and activation are
established separately by the release receipts. See
[main architecture](../ARCHITECTURE.md), [user workflow](TAKEOFFS.md) and
[roadmap](../ROADMAP.md). Release receipts establish publication and activation.

## Runtime and ownership

The local Python HTTP server owns validation, measurements, typed revisions,
confirmation provenance, protected project writes and bounded PDF/image workers.
The browser owns interactive drawing presentation and captured drafts. It has no
authority to manufacture a trusted confirmation or turn arbitrary source text
into a calculator quantity. Original workbook definitions and retained PDFs are
immutable inputs. This remains a single-computer application; remote hosting is
not authorized by the current architecture.

| Component | Responsibility |
| --- | --- |
| `static/takeoffs.js` | Shared PDF viewer, tool rail, original-coordinate interactions, measurement register, local selection/hiding, styles, search and explicit transfer UI. |
| `static/takeoff-physical.js` | Defect Reports/Service Plans views, physical hierarchy selection, Item Details and scoped server operations. |
| `estimator/takeoff_http.py` | `/api/takeoffs/` session routes and typed command dispatch. |
| `estimator/takeoff_workspace.py` | Session state, atomic revisions, preview/apply guards, history and local confirmation/transfer authority. |
| `estimator/takeoff_model.py`, `takeoff_area.py` | Snapshot validation, member/marker identities, measurement/calibration and polygon topology. |
| `estimator/takeoff_library_links.py`, `static/takeoff-library-links.js` | Explicit library selection, separately versioned project-owned commercial assignments, reviewed quantities and guarded schedule bindings. |
| `estimator/takeoff_annotations.py`, `static/takeoff-annotations.js` | Independently versioned presentation notes, bounded rich text, shared new-call-out appearance defaults and safe drawing/editor projections. |
| `static/takeoff-search.js`, `static/takeoff-shortcuts.js` | Bounded searchable text/run indexing, deterministic hit selection and common enabled-action shortcut metadata. |
| `estimator/takeoff_documents.py` | Exact-byte PDF originals, chunked uploads, content-addressed evidence companions and immutable history. |
| `estimator/takeoff_physical*.py` | Versioned physical graphs, draft operations, markers and separate physical exports. |
| `estimator/takeoff_image_evidence.py`, `takeoff_image_worker.py` | Bounded extraction, source/byte bindings and verified image manifests. |
| `estimator/takeoff_transfer.py` | Supported destination mapping, previewed quantity changes, conflict checks, provenance and stale links. |
| `estimator/takeoff_markup_pdf*.py`, `takeoff_exports.py` | Visible static drawing derivatives and register exchange; no source mutation. |
| `estimator/project_file.py`, project save routes, `static/app.js` | Validated portable state, captured complete drafts, frozen pricing and capability-bound native Save. |

## Model, evidence and compatibility

The outer portable project retains version 1 without Takeoffs and version 2 with
Takeoffs. The nested measurement snapshot retains schema version 1 until a
physical edit or image extraction explicitly upgrades it to version 2. Physical
graphs have independent versions: historical version 1 is validated/read-only;
Defect Reports version 2 is Defect → Barrier → Service; Service Plans version 3
is Barrier → Service. A project can contain both current graphs without copying
or merging their entities. Numbered IDs, tombstones and sequences are checked
against retained history. Explicit service quantities are never inferred from
image occurrences or call-out markers.

PDF bytes are outside JSON in `.ceasefire-evidence/<persistent-project-id>/`.
Save verifies and publishes originals/history before replacing JSON atomically.
Missing evidence permits diagnosis, not approved transfer/export. Imported receipt
text does not recreate local confirmation authority. A new machine requires fresh
human review. Retained image streams/derivatives and manifests remain hash-bound;
an imported diagnostic manifest requires fresh local extraction before supporting
later physical approval. Upload, history, worker time/memory and output limits fail
explicitly instead of truncating evidence; exact bounds are in TAKEOFFS.md.

One visible **Save** command chooses the existing authorized `/api/project/save`
path when a save token is bound. Without one, it uses `/api/project/save-as` and
the existing native destination dialog. Route names remain compatible despite
removing the separate Save As button. Cancellation leaves the current draft open.
Late edits, attachment validation, captured snapshots and frozen project prices
retain their existing guards. Imported files cannot nominate an authorized path.

## Coordinates, measurements and appearance

Geometry is retained in original unrotated PDF coordinates. CropBox, source
rotation and UserUnit remain explicit; screen zoom, device pixel ratio and viewing
rotation affect presentation only. Printed scales use UserUnit once; a manual
calibration already converts source distance to metres. Each page/viewport retains
its own revision. Crossing incompatible scales is rejected. A changed calibration
invalidates dependent confirmation and transfer links without rewriting calculator
values. True-surface area and exclusions use validated geometry and scale squared.

Count markers retain persistent physical member IDs. Steel counted lengths have
explicit manual per-member lengths, with quantity derived from marker identities.
Standalone counts/lengths cannot transfer to calculators. Split/merge, geometry
edits and undo preserve history and demand fresh confirmation where required.

Width and Marker edits use 1–100 physical PDF points; opacity editing uses 1–100
percent and stores a fraction. Shared new call-out defaults are stroke `#FF3300`,
fill `#FFDD33`, text `#000000`, width 4, fill enabled and opacity .75. Explicit
saved appearance wins; untouched legacy fractional values/zero opacity remain
exact. Drawing/PDF display labels use two decimal places while stored measurement,
digest, exported numeric and calculator values retain their original precision.
New legend layout measures and wraps text; saved dimensions/positions are retained.

## Presentation and authority boundaries

Selection and Hide are browser presentation sets keyed by stable IDs. Filtered
header toggles operate on all matching rows, including later register pages, and
preserve outside-filter selection. Physical Hide reaches the shared overlay and
visible drawing PDF request; it does not remove graph records, quantities or
matrix rows. Selecting/hiding is not confirmation. Closing Settings focuses the
viewer so length Ctrl/Cmd+C/V works without opening the editor. Editable fields
retain native text shortcuts.

Measurement confirmation records a local user/session review of an exact revision;
it is not authenticated manufacturer or installation approval. Supported confirmed
Steel/Duct transfers require explicit destination selection and a preview, source
identity and current local provenance. Row changes can conflict or become stale;
detach retains manual calculator values. Thickness is a read-only projection of
the current supported linked schedule, never a guessed field or new formula.
Physical drafts and future presentation-only annotations do not gain transfer
authority by being drawn or exported.

PDF exports run in bounded workers, retain page geometry, draw visible current
markups and do not modify originals. Static marked-PDF output excludes source
actions/attachments and rejects source annotations/widgets needing flattening
rather than silently losing visible content. The Passive Fire Matrix is a separate
unapproved draft export of active physical records. Source data and private local
inventory are distinct from generated UI summaries; Technical Library counts
describe the whole visible inventory, independently of current filtering/paging.

## Implemented extension: eight new comments

The extension continues the shared viewer, typed operations, retained history and
portable-project architecture. It adds no calculator, physical approval or AI authority.

### Shared shortcuts and legend guard

One deterministic action/shortcut registry serves the shared left rail,
including physical modes. Generate tooltips and `aria-keyshortcuts` from that
registry and dispatch through the existing enabled button. Upload PDF has no new
shortcut. Ctrl+0 remains Fit page; Viewport is Ctrl+backslash. Unique punctuation
and function keys preserve native editing, Ctrl+C/V/X/Z/A/S and browser navigation.
Inputs, rich text, selects, IME composition and modal editors retain their native
keys. Hidden/disabled controls cannot be invoked by the dispatcher. Exact mappings
are in TAKEOFFS.md.

Legend creation requires visible supported Length/Count markups on the current
Steel/Duct drawing page. Hidden items and globally hidden markups are excluded.
The existing persisted layout command remains in use. A displayed legend can
still be removed after its last eligible item is deleted. Document changes and
loading immediately update availability; undo restores eligible markups.

### Search state and text geometry

Bounded client search state retains query, document/scope, run generation,
ordered hit identities, active hit, dropdown state and coverage/errors. Debounced
typing invalidates a run on query/scope/document/project changes and requires
query/run/session agreement before publishing results. Clear and Stop share one
cancellation/cleanup path that clears input, list and overlays immediately and
cancels PDF.js text-stream readers. The 500-hit limit, pages-inspected/empty/failed reporting and PDF
timeouts; scanned image pages do not become searchable without an existing layer.

The keyboard-accessible dropdown is anchored below the search field. Search
chooses the nearest current-page match to the viewer centre, then advances in
display reading order and wraps. Equal distances retain that stable order. If
the page has no hit, it stays on the page and reports that fact; a dropdown
selection explicitly navigates to another page/document. Page changes reset the
cycle. Queries are limited to 200 characters and indexed page text to the module's
bounded maximum; overly long sentences disclose bounded context.

Normalized text maps back to PDF text runs, including repeated and multi-run
phrases. Yellow context and contrasting matches use separate original-coordinate
quads. On the current page, exact match bounds come from PDF.js text-layer DOM
Ranges mapped through the current transform. When exact glyph bounds are absent,
the result labels its text-run context fallback; it does not invent proportional
character geometry. Native text indexing performs no OCR or source mutation.
The separate local recognition path adds approximate source-bound search results.

### Call-out naming and free annotations

The physical **Count** UI action is named **Call-out** using the supplied icon and
a shortcut distinct from Count. This changes the label, not the existing physical
creation graph, marker/member semantics, display IDs or explicit service quantity.
Legacy saved projects retain their physical hierarchy and generated descriptions.

Steel/Duct/Walls/Slabs use a separate optional `annotations` collection with
`version: 1` and `callouts`. A free call-out retains its annotation ID/revision,
mode, document/hash/page binding, original source point, original label position,
box dimensions, appearance and structured rich-text content. It has no physical member
quantity, confirmation receipt, calculator row or transfer eligibility. Item Details
contains a rich-text box plus shared appearance controls. The optional extension
leaves the nested snapshot version 1/2 and outer project version 1/2 contracts
unchanged. Legacy projects with no free call-outs gain no collection by opening.

Content version 1 allows paragraph/bullet/number blocks and text runs with explicit
bold/italic/underline booleans: at most 64 blocks, 256 runs and 8,000 characters.
There are at most 1,000 free notes. Unknown fields, unsafe control/direction
characters, HTML-shaped formatting and authority fields are rejected; literal
text containing angle brackets is safe text. The editor constructs DOM nodes,
pastes plain text and stores the validated projection; it never imports HTML.
Browser and PDF use the bundled Vera fonts, measured character wrapping and
explicit fit failure. Unsupported PDF-font characters fail export and retain text.

Shared new-note defaults are captured explicitly in new free and physical
call-outs; older explicit styles and implicit historical defaults remain intact.
Physical call-outs may store appearance alone and retain their measured automatic
layout. A moved or resized box stores the complete existing offset/width/height
geometry; partial geometry is rejected. Automatic boxes are bounded to the page.
Typed create/update/delete operations and undo/history preserve note identities
and source binding. Queued edits guard ownership; late edits remain captured.
Dragging and resizing operate in original coordinates with stale-geometry guards.
Hide and export selection are presentation only. Annotation operations cannot
alter measurements, graph records, confirmation receipts or transfers, including
when annotation undo is independent of unrelated physical review gates.

## Verification and release evidence

Tests must demonstrate preserved formula/source bytes, native editing, legacy
project compatibility, explicit quantity/identity contracts, protected private
evidence and exact-head CI. Synthetic browser fixtures use isolated random ports,
never the live port 8765. HTTP asset checks establish served identity; rendered
live-browser acceptance establishes activation separately. Standard desktop CI
does not certify Takeoffs availability in that product edition. Source/publication
claims require current Git/PR/CI/process and dated protected-state receipts.

## Browser feedback and explicit library links

The original user GIF is retained byte-for-byte. A decorative left-column image
plays while the header types and switches to a lossless still when typing ends,
on page close or under reduced motion. The supplied bullet, numbered-list and
visibility images are retained without recompression. Visibility is pressed and
light red only when markups are hidden. Item Details occupies both Settings
columns; Opacity retains numeric percent entry without a separate percent helper.

Free Call-outs retain version 1 bounded rich text and original source coordinates.
A click selects; a double click opens Settings. Four projected corner controls
resize the upright box while preserving its independent source anchor and text.
The selected anchor has a contrasting halo. Copy/paste allocates a new identity
at the current pointer's original PDF coordinate, within the same project/mode.
Oversized copies are rejected before mutation when they cannot fit the target
page. Right-click Delete uses the existing audited annotation command and undo.
None of these notes enters a register, quantity, physical approval or schedule.

New PDF uploads display the first successfully imported document from the chosen
batch after existing draft guards pass. Ctrl+Up/Down rotates left/right,
Ctrl+Left/Right changes pages, and Ctrl+-/Ctrl++ zooms within the viewer. Editing,
modal, composition and busy guards retain native input behavior. Outside pointer
clicks dismiss search results without discarding the query/highlights. Sentence
context is deduplicated in one translucent group so repeated hits do not obscure
original PDF text; matched-word geometry remains bound to the original source.

Smooth zoom retains the displayed page while a replacement canvas is refined.
That same-page refinement preserves a focused native page-number draft until its
change event commits navigation. Unfocused page controls and actual document/page
navigation still synchronize to the current page. The browser regression holds
the real refinement callback between native input and Tab to verify this ordering.

Penetrations Add Defect offers Search Item and New Item. Explicit library selection
imports literal supported fields into ordinary unapproved Defect/Barrier/Service
records and creates stable typed IDs. No candidate ranking or automatic matching
is performed. Item QTY is an explicit positive whole service count, stored on the
new service rather than inferred from its template or marker. Legacy imported
services retain their unknown version 1 `library_quantity` descriptor until an
explicit quantity edit removes it. Blank seals have an explicit seal count and
create no physical service. Selection alone never changes the schedule.
The project-owned `library_assignments={version:1,records:[...]}`
collection records explicit physical members and revisions, an installation ID
and mode, library source/revision/metadata fingerprints, context, commercial
confirmation and schedule binding. A shared barrier never establishes a combined
opening; a combined assignment requires its own explicit installation description.
New associations record a version 1 `quantity_source`: `services` sums only
distinct explicitly associated service quantities for repeated installations;
`blank_seals` retains its explicit whole count. Combined installations contribute
once. Unknown service quantities must be entered before Transfer or Update.
Saved associations without a source retain their history. The UI adopts the
explicit source only through a reviewed schedule preview/apply transaction.
Direct Service Plans association can atomically apply individually reviewed
`service_quantities` bound to selected IDs and revisions; descendants are never
inferred. Original draft item details remain historical and immutable.

Only the separate commercial link/quantity confirmation writes a Firestopping
Schedule row. Preview binds the exact Takeoffs revision, member/parent context,
library metadata and captured schedule/configuration. Apply rechecks those
bindings and updates both snapshots under a destination reservation. The exact
request identity is retained through uncertain responses for idempotent recovery;
project saving and conflicting actions remain blocked until both sides agree.
Existing schedule inputs, frozen project configuration, composer draft and manual
quantity baseline are retained. Reconfirmation replaces this assignment's prior
contribution rather than adding it again. Context/library changes require review;
this commercial confirmation grants no physical or manufacturer approval.

Removing a confirmed link uses the same reviewed transaction and subtracts only
its retained contribution, preserving other links and the schedule row's manual
inputs even when the remaining quantity is zero. Takeoff-only Undo is blocked for
commercial link transactions; coordinated reconfirmation/removal remains available
through the register Transfer, Update and Unlink controls. Ordinary physical and
free-annotation edits retain their undo. Item Details presents the relevant Defect
ID, its own Barrier/Service choices, and a concise fingerprint-matched library
summary. Long original library descriptions remain lossless: notes allow at most
128,000 Unicode characters, captured library titles 10,000, ordinary text fields
2,000, while the existing aggregate text, request and saved-project limits remain.

AI Phases 5/6, Physical Model Lock and automatic Firestopping matching remain
outside this increment. Release receipts establish publication and live activation.

## Explicit barrier selection for additional library items

In Defect Reports v2, the inspector library action resolves selected records to
one active Defect before searching. Cross-Defect selection is rejected. The first
dialog chooses New Barrier or Existing Barrier; existing choices show retained
ID, barrier type, substrate and orientation. The catalogue query uses the actual
Library facet definitions and options. The Service Plans v3 workflow keeps its
existing explicit member association because it has no Defect parent.

The atomic `import_library_item` command binds the current graph, Defect and
chosen Barrier revision to the current library metadata. New barriers adopt only
literal library fields; `L` supplies the retained penetration type, `P` substrate
and `M` orientation. It creates a service only when the explicit template supplies
one, using the explicitly entered Item QTY (legacy requests without that field
retain the unknown-quantity descriptor). Existing barriers retain
every original field, marker and evidence byte. Field conflicts require an
explicit Continue decision recorded in versioned `barrier_selection` provenance;
Cancel returns to library search without mutating graph, IDs or assignments.
Unknown values never establish suitability, quantity or technical approval.

The import creates a draft assignment. Existing commercial preview/apply leases,
context checks and idempotent schedule contributions remain separate. Source
annotations are retained in original PDF coordinates. Project save, reopen and
ordinary physical Undo preserve persistent identities and review state.

The register no longer presents redundant CSV/XLSX/marked-PDF buttons or a root
Add Defect button. Source Call-out placement creates new Defects. Delete selected
records sits beside Bulk edit. Retained export integrations use guarded module
APIs; pending edits, modal/busy state and changed source revisions block stale
downloads. Item diagnostics are omitted from the settings pane while Delete,
calibration changes, source warnings and actual editing controls remain available.

An inherited new-library Barrier marker keeps the exact parent source annotation.
Its duplicate label is omitted only when version-one New Barrier provenance
matches the parent and the complete current marker equals the parent annotation.
The parent summary already includes that Barrier and its services. A hidden or
unrequested parent, moved marker or changed style restores the separate label.
Viewer rendering and PDF export use the same conditions without changing records.

## Local recognition for drawing-label search

Native PDF text is indexed and published first. The checked Include drawing
labels option then recognises drawing outlines and scans in a dedicated local
worker. Search results identify Local OCR, approximate word bounds and confidence;
they grant no physical, quantity, approval or calculator authority. The renderer
retains the original PDF.js coordinate transform, including CropBox, intrinsic
rotation and UserUnit. OCR quads are never replaced by native text-layer bounds.

Tesseract.js and core 7.0.0, the full English best-int model, upstream licenses and
official package integrity are pinned in `static/vendor/ocr/manifest.json`. Assets
are served only from an integrity-checked local allowlist. No drawing, recognition
text or model is sent to a remote service. Only the dedicated worker response
permits WebAssembly compilation; main-page CSP remains unchanged. Standard edition
excludes these assets together with Takeoffs.

Recognition uses sequential overlapping tiles and four quarter-turn passes. Each
page is bounded to 18 million pixels, 6,000 pixels per edge and 60 seconds. A search
covers at most eight pages and 150 seconds, prioritising the captured current page.
Partial passes, reduced resolution, skipped pages and failures are disclosed.
Stop, query replacement and project replacement cancel pending work and terminate
the worker. The bounded in-memory cache keys original SHA256, page, render transform
and engine/model version; project replacement disposes it. Original PDFs, viewer
text layers and saved projects are not modified by recognition.

## Parent review and inspector controls (9 October 2026)

In Defect Reports v2, the Defect owns Location and manual Confirmation for its
Barrier and Service descendants. In Service Plans v3, the root Barrier owns both
and its Services inherit Confirmation. Register display, filters, selected
exports, callouts and schedule transfer resolve the same typed parent chain.
Missing or deleted owners cannot grant confirmation. Child Confirmation editors
and the Defect Reports Barrier Location editor are absent; historical child
fields remain lossless in saved projects and are never migrated on load.

Changing child facts, source evidence, quantity or hierarchy invalidates the
relevant owner's review; moving a child between branches invalidates both owners.
New library children also require fresh owner review. Appearance, callout layout
and view-only Visibility preserve review. Bulk Confirm and Unconfirm resolve and
deduplicate selected owners. This remains manual draft review, with no technical
or manufacturer approval implied.

Transfer to Firestopping Schedule sends all currently confirmed library
associations in the current scope through the existing atomic commercial
transaction, without link/quantity dialogs. It uses the recorded Service quantity
(or the explicit retained blank-seal/combined-installation source). Current member
revisions, library fingerprints, local confirmation authority, destination inputs
and idempotency guards still apply. Update and Unlink retain their separate
reviewed transactions.

Item Details uses an Add disclosure with the existing Document-menu keyboard and
dismissal behavior. Applicable entries appear as Add Barrier, Add Service, then
Add Library Item, with icons left of their names. Barrier and Service reuse the
supplied original PNG bytes; the existing Library book SVG uses an orange gradient.
Automatic saves retain the same item's open Add menu and keyboard focus, and keep
a pressed option connected until its click completes. Explicit dismissal or a
changed workspace, selection or parent closes it; save and action authority remain unchanged.
Per-item Visibility sits at the right of the Add row, followed by a separate Delete
and Discard row. Visibility targets the nearest active drawing owner and changes
presentation only. Marker and Callout settings show Fill colour/Fill enabled before
Line Colour/Line Width. Owning Defect and Service Plan Barrier forms show Confirmation
before Notes; descendants retain their existing inherited confirmation rules.
