# Local reference libraries

The Libraries page has three tiles: Pricing Library, Firestopping Library and
Technical Library. The existing pricing editor keeps its own state and actions.
Reference browsing does not change prices, estimates or calculator inputs.

Firestopping records display stable identifiers such as `FL-ID-001`, their
**Library price**, source table fields, and original in-cell PNG
diagrams. The internal legacy record IDs remain unchanged so existing links
still work; the former PKB identifier is not the visible item name. Blank source
cells remain blank in the data. Item inputs and original workbook pricing are
stored in the private bundle, separate from the shared Pricing Library.
Source sheet/row metadata and extraction-review fields remain in that bundle
but are not displayed in Firestopping Library entries. The library item editor
continues to distinguish original workbook rates from explicitly refreshed
Pricing Library rates; changing the displayed price label does not change them.

**Items/Services** and **System/Install Details** use the same labels in the library,
Firestopping Estimator, and its detailed exports. Workbook row/cell locations
are not shown on library result cards or diagram captions.

Every Firestopping entry includes **Service Size or Diameter**, using only its
effective calculator diameter (`AL`) and cable-tray width/depth (`AQ`/`AR`).
For example, these display as `110 mm` or `450 mm wide × 50 mm deep`.
Description text is never parsed or used as a fallback, and aperture, seal,
wrap, board and bulkhead dimensions are excluded. When none of those fields has
a valid dimension, the display is **Not specified in calculator inputs**. Saving an item refreshes this
field without changing its calculation rules or stored pricing basis.

The Firestopping Library starts with a table showing the total number of entries
and how many have no linked technical references. These are whole-library
counts, independent of the current search or page. **Technical Reference**
filters the list by **Any**, **Linked Technical References**, or **No Linked
Technical References**, together with the existing search and filters.

## Adding items to the library and schedule

**Add to Library**, beside the selected estimator item's inputs, captures that
one row and its current effective pricing, retaining historical global inputs
only for compatibility. The server
calculates its price and stores the inputs and pricing snapshot separately from
the supplier bundle. Later project or shared-price changes do not change the
saved library item. Repeated requests for the same capture return the saved
entry rather than creating duplicates. A service/installation description,
positive quantity and a calculation without errors are required.

Imported IDs remain unchanged. User-created items receive permanent IDs starting
at **FL-ID-100001**; this reserved range avoids collisions with future supplier
imports and permits creation before a supplier bundle is installed. Allocation
is transactional across concurrent requests. Imported IDs must be below that
range. New entries support the same edit/save/reopen workflow as imported items.

**Add to Schedule** copies an item's saved inputs into the current Firestopping
Estimator. It uses the current schedule's prices and effective calculation policy and
shows the recalculated item price. Existing schedule rows and unsaved edits
remain intact; a single unused starting row is replaced. The stored library
item stays unchanged. Save the project separately to retain the new schedule row.

**Access** and **Complexity** are no longer input controls, and **Substrate** is
descriptive. Global allowances and those three multipliers have no calculation
effect, including for historical items; raw saved values are retained. **Service Type**
is a dropdown containing the library's service types plus Cable Trays, Busbar
Trunking, Fire Dampers, Flexible Ducts, Linear Joints and Movement Joints.
**Manufacturer** offers Promat, Trafalgar, Boss, Firefly, Hilti, Snap and Fendix.
Historical descriptions remain visible without rewriting saved inputs. These
descriptive choices do not select products or change calculation formulas.

Technical records contain active entries from the supplied reports' main
tables, identified by report revision, source ID and exact PDF page. Reserved or
blank entries, standalone drawings, contents pages and report-level entries are
excluded from the record list. Each report keeps its own source column schema:

| Report | Record fields |
| --- | --- |
| FAS190234 | ID; Type; Product; Install Notes; Installation Concept; Max Aperture Size; Separating Element; Aperture Seal Joints; Reference figure; FRL when Blank |
| FAS190235 | ID; Service; Service Wrap; Protection; Local Protection; Refer Figure; FRL |
| FAS190236 | ID; Service Description; Installation concept; Penetration seal description; Support Construction; FRL |

The Technical Library's **Source information** links identify the pages that
contain that entry's actual table row, including continued rows. Table-wide
introduction pages and notes applying to a range of IDs must not be presented as
if they contain the individual entry. Review each citation against the exact
source ID and table geometry, including suffixes, merged cells and page breaks;
an ID occurring elsewhere in page text is not sufficient evidence.
Each citation is a single hyperlink to that PDF page; duplicate filename/page
fields and a separate open button are omitted.

The complete original PDFs open locally, including source notes, drawings and
conditions outside the indexed main tables. The entry UI omits extraction
metadata, source fingerprints, **Source table notes** and **Source option
alignment**. Those values remain in the private source evidence; table-wide
conditions remain available in the linked PDF. Main-table fields keep their
common text, numbered options and installation diagrams. Embedded tables retain
corresponding service, wrap/protection and FRL values on the same row rather
than presenting independent lists.
Structured technical fields can include the source installation diagram in the
same field, with a link to its full-size local image.

## Editing a Firestopping Library item

Choose **Edit Library Item** on a record or search result to open that item in
the Firestopping Estimator. This is a separate editing session: project rows,
unsaved project input text, project pricing and the shared pricing editor retain
their state. Its grouped controls and calculated breakdown use the existing
workbook calculation engine. The editor retains numeric precision and identifies
input or formula errors explicitly.

An unedited item uses the original workbook's captured rates. **Refresh from
Pricing Library** captures the currently saved shared catalog and rates on the
server and recalculates this item. It does not use unsaved pricing editor changes
or current-project pricing, and does not save the library item. The captured
rates remain fixed even if shared prices change again while the editor is open.

**Save Library Item** stores the individual item's inputs and chosen pricing
snapshot. The same editor accepts a PNG, JPEG or WebP screenshot as the item's
source diagram. Images up to 15 MB are decoded, orientation-corrected, reduced
to a maximum 2000 × 2000 pixels and stored as a high-quality JPEG with a separate
240 × 160 thumbnail. The full image appears in the library detail and the
thumbnail appears in each matching Firestopping Schedule row. Reopening uses
those saved values; future shared pricing changes have no automatic effect.
Successful saving refreshes its displayed price, searchable fields,
related-link title and diagram. **Cancel** returns to the library and discards
only this item session. Project **Save / Save As** remains separate.
If another window saves the item first, saving reports a conflict and retains
the current draft instead of overwriting the newer revision.

Item saves are overlays in the application's SQLite database, with deduplicated
immutable pricing snapshots. Uploaded diagrams are stored in the same database
as an item overlay; removing one reveals the immutable supplier diagram again
when it exists. Neither saving nor refreshing rewrites the source workbook,
supplier bundle, PDFs, shared prices or project files. Back up the application
database as well as the local supplier bundle to retain these edits.
Displayed library prices are recalculated from those frozen snapshots using the
effective policy, so historical cached amounts cannot restore removed allowances.
List pages batch compatible items and cache by exact inputs, pricing and policy;
original stored amounts remain available as source evidence in the editor.

## Relationships

One stored relationship generates navigation in both directions. It records its
evidence in plain language beside the link. Firestopping Library IDs identify items;
they are not technical report system IDs. Description or diagram matches must
retain their stated basis and any ambiguity. Related references are navigation
links, not a new technical selection or a claim of project suitability.

After an item is edited, its technical links and immutable supplier diagrams
still describe the original workbook entry. A saved user diagram is a separate
item overlay and replaces the supplier diagram in that item's main gallery;
editing it does not generate or reassess technical relationships.

Entries without sufficient source evidence remain searchable without invented
links. Reports from one manufacturer do not support another manufacturer's
entries. References to documents or appendices not supplied remain unresolved.

Each Firestopping entry has **Link Library Item**. Search the Technical Library,
choose a record and save the link. One saved relationship appears in both
directions; selecting an existing relationship does not duplicate it. Manual
links are identified as user-created and stored separately from imported links.
Their source fingerprints are retained internally. If a referenced source
version changes, the old manual relationship is withheld for review rather than
silently reassigned to a different report.

## Local installation and privacy

Supplier content is local data, separate from the public source repository and
distribution. A bundle contains `library.json`, registered PDFs under
`documents/<id>.pdf`, and PNG/JPEG diagrams under `images/<id>.<extension>`.
The default installed folder is `.runtime/reference-library`. No source paths
are accepted from a browser request. The server exposes only registered assets
whose bytes match their SHA-256 fingerprint.

Install an inspected bundle from a separate directory with:

```powershell
python scripts/install_reference_library.py <reviewed-bundle-directory>
```

The installer validates every record, page reference, reciprocal relationship
and asset before installation. An existing library requires `--replace`, which
retains a timestamped backup. It does not edit the original workbook or PDFs.
The application can use another local installation via `--library-directory`.
Use Refresh in a library pane after installing an updated bundle. An application
without a local bundle displays its saved user-created entries, or an empty
state if none exist; pricing and calculators remain available.

## Data contract

`schema_version` is 1. `libraries` contains `penetration` and `technical`, each
with `items`, filter definitions and an optional notice. Each item has an opaque
lowercase ID, title, fields, sources and optional image references. Firestopping
records additionally expose `library_id`, `price` and `editable`. Internal
library kinds stay `penetration` and `technical`. PDF sources
use a registered `document_id` and one-based `page`. Filter values are lists of
exact source labels. Top-level `links` stores each penetration/technical pair
once, with a human-readable `relationship` explaining its basis.
Individual fields may include registered `images: [{id, caption}]`; related
links may include a `notice` beside their relationship text.
The detail page shows system fields and diagrams before related records and
technical source links. Firestopping entries continue to omit source-information
sections. Report-family audits distinguish an independent batt substrate from
local batt infill explicitly included in a core-hole detail; a missing service
reference is left unresolved when the current report cannot support the stored
service. Related current details carry any material differences in their link
text and do not silently revise the item's calculation or price.
Fields with embedded source tables use
`table: {columns: [string], rows: [[string]]}`. Rows preserve column pairing and
source order. A nonempty `value` retains common text outside the nested table;
it does not repeat its cells. The UI renders semantic column headers and literal
text cells, with keyboard-accessible horizontal scrolling on narrow screens.

`GET /api/libraries/penetration/{id}/edit` returns one item draft, its definition
and server-calculated result, revision, source/current price and opaque
`pricing_token`, and source-diagram metadata. The corresponding POST routes
`/calculate` and `/refresh-pricing` accept exactly
`{draft, revision, pricing_token}`. `/save` also accepts an optional `diagram`
value containing `{filename, content_base64}` or `null` to remove the saved
overlay. `GET /api/libraries/penetration/{id}/image` returns the display image
and `/thumbnail` returns the schedule thumbnail. The client cannot submit
calculated prices or an arbitrary pricing configuration. Saved input
revisions and source fingerprints prevent silent replacement after concurrent
edits or an incompatible source update.

The loader rejects duplicate IDs or edges, missing linked items, invalid pages,
unsupported image formats, and paths outside the library. Search is literal,
case-insensitive and paginated; source strings are rendered as text. PDF range
requests are supported for opening larger local reports.

## Verification

`POST /api/libraries/penetration` accepts `draft`, `configuration` and a unique
`idempotency_key`. It returns the new or previously captured item's edit response.
`POST /api/libraries/penetration/{id}/links` accepts exactly `technical_id` and
returns a confirmed pair. Listing uses `technical_reference=any|linked|unlinked`;
its `counts` object is independent of its filtered `total` and pagination.

```powershell
python -m unittest tests.test_reference_library -v
node tests/test_libraries_ui.cjs
node --check static/library-editor.js
node tests/test_library_editor_ui.cjs
python -m unittest discover -s tests -p "test_library_workflow*.py" -v
```

Tests use synthetic content. Real source extraction, page coverage, image
mapping and link-review evidence stay with the local installation work, outside
the public repository. Whole-report text extraction is not a claim that every
page or technical interpretation has been visually reviewed.
