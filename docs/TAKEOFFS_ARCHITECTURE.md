# Takeoffs, projects and presentation architecture

Updated 5 October 2026. This describes implemented source behaviour through
PR #154 and separately identifies the next eight requested changes. See
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

## Planned extension: eight new comments

The following is a proposed implementation design, not an implemented schema or
tested feature. It is bounded by the user's eight latest comments.

### Shared shortcuts and legend guard

Create one deterministic action/shortcut registry for the shared left rail,
including physical modes. Generate tooltips and `aria-keyshortcuts` from that
registry and dispatch through the existing enabled action. Upload PDF has no new
shortcut. Verify the actual Viewport binding first. Choose unique Ctrl+keys that
preserve Ctrl+C/V/X/Z/A/S and browser navigation/printing; avoid triggering inside
inputs, rich text, selects, IME composition or modal editors. Disabled controls
must not be bypassed by keyboard. Document final mappings in the user guide.

Legend availability should derive from supported active markup types in the
current document/workspace, with explicit handling of hidden items and a legend
already displayed when the last eligible markup is deleted. Reuse the existing
layout/visibility command; disabling creation must still allow removing a visible
legend. Test document changes, undo and last-item deletion. No quantities change.

### Search state and text geometry

Keep bounded client search state: query, document/scope, run generation,
ordered hit identities, active hit, dropdown state and coverage/errors. Debounce
typing, invalidate a run on query/scope/document/project changes, and require
query/run/session agreement before publishing results. Clear and Stop share one
cancellation/cleanup path that clears input, list and overlays immediately.
Retain the current 500-hit limit, pages-inspected/empty/failed reporting and PDF
timeouts; scanned image pages do not become searchable without an existing layer.

Anchor a keyboard-accessible dropdown to the search field. Search activation
chooses a deterministic nearest current-page hit from the viewer's current centre,
then advances through a stable page reading order and wraps. Define ties and
the case with no current-page matches explicitly; do not silently claim a
cross-document jump satisfies the requested page cycle. Dropdown selection may
explicitly navigate to another document/page as it does today.

The current implementation matches a PDF text item and highlights its bounding
box. Sentence/word highlighting needs reliable mapping between normalized text,
PDF text runs and original coordinates. Retain separate context and exact-match
rectangles, transform both with the page, and use yellow context plus a contrasting
match colour. Test phrase matches spanning runs, repeated words, rotation/crop,
zoom and damaged/textless pages. Do not invent exact word geometry when the PDF
lacks enough information; record the fallback and coverage limit.

### Call-out naming and free annotations

Rename the physical **Count** UI action to **Call-out** using the supplied icon and
a shortcut distinct from Count. This changes the label, not the existing physical
creation graph, marker/member semantics, display IDs or explicit service quantity.
Legacy saved projects retain their physical hierarchy and generated descriptions.

For Steel/Duct/Walls/Slabs, introduce a separately validated, versioned annotation
collection rather than fabricating measurement/register items. A free call-out
needs an annotation ID, document/hash/page binding, source point/geometry,
appearance, position and constrained rich-text content. It has no physical member
quantity, confirmation receipt, calculator row or transfer eligibility. Item Details
contains only a rich-text box plus shared appearance controls. This schema requires
an explicit backward-compatible upgrade; projects with no free call-outs should
not change merely by opening them.

Represent formatting as bounded structured text with an allow-list of supported
marks/paragraphs/lists, not arbitrary imported HTML or scripts. Use one validated
content projection for browser rendering and static PDF output. Define supported
formatting, limits and legacy/malformed-input behaviour before coding. Shared
appearance defaults/edit controls should match physical call-outs without sharing
their record ownership. Preserve annotation identity, coordinates and rich text
through preview/apply, undo/history, project save/reopen and marked-PDF export.
No register/XLSX quantity or calculator transfer should change when a free call-out
is created, moved, hidden, edited, deleted or restored.

## Verification and release evidence

Tests must demonstrate preserved formula/source bytes, native editing, legacy
project compatibility, explicit quantity/identity contracts, protected private
evidence and exact-head CI. Synthetic browser fixtures use isolated random ports,
never the live port 8765. HTTP asset checks establish served identity; rendered
live-browser acceptance establishes activation separately. Standard desktop CI
does not certify Takeoffs availability in that product edition. Source/publication
claims require current Git/PR/CI/process and dated protected-state receipts.
