# Local reference libraries

The Libraries page has three tiles: Pricing Library, Firestopping Library and
Technical Library. The existing pricing editor keeps its own state and actions.
Reference browsing does not change prices, estimates or calculator inputs.

Firestopping records display stable identifiers such as `FL-ID-001`, their item
price, source sheet and row, source table fields, and original in-cell PNG
diagrams. The internal legacy record IDs remain unchanged so existing links
still work; the former PKB identifier is not the visible item name. Blank source
cells remain blank in the data. Item inputs and original workbook pricing are
stored in the private bundle, separate from the shared Pricing Library.

Technical records contain active entries from the supplied reports' main
tables, identified by report revision, source ID and exact PDF page. Reserved or
blank entries, standalone drawings, contents pages and report-level entries are
excluded from the record list. Each report keeps its own source column schema:

| Report | Record fields |
| --- | --- |
| FAS190234 | ID; Type; Product; Install Notes; Installation Concept; Max Aperture Size; Separating Element; Aperture Seal Joints; Reference figure; FRL when Blank |
| FAS190235 | ID; Service; Service Wrap; Protection; Local Protection; Refer Figure; FRL |
| FAS190236 | ID; Service Description; Installation concept; Penetration seal description; Support Construction; FRL |

The complete original PDFs open locally, including source notes, drawings and
conditions outside the indexed main tables. Common source context remains with
its entry. Embedded tables retain corresponding service, wrap/protection and
FRL values on the same row rather than presenting independent lists.
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
snapshot. Reopening it uses those saved values; future shared pricing changes
have no automatic effect. Successful saving refreshes its displayed price,
searchable fields and related-link title. **Cancel** returns to the library and
discards only this item session. Project **Save / Save As** remains separate.
If another window saves the item first, saving reports a conflict and retains
the current draft instead of overwriting the newer revision.

Item saves are overlays in the application's SQLite database, with deduplicated
immutable pricing snapshots. Neither saving nor refreshing rewrites the source
workbook, supplier bundle, PDFs, shared prices or project files. Back up the
application database as well as the local supplier bundle to retain these edits.

## Relationships

One stored relationship generates navigation in both directions. It records its
evidence in plain language beside the link. Firestopping Library IDs identify items;
they are not technical report system IDs. Description or diagram matches must
retain their stated basis and any ambiguity. Related references are navigation
links, not a new technical selection or a claim of project suitability.

After an item is edited, its technical links and source diagrams still describe
the original workbook entry. The item and links from the Technical Library show
this distinction; editing does not generate or reassess technical relationships.

Entries without sufficient source evidence remain searchable without invented
links. Reports from one manufacturer do not support another manufacturer's
entries. References to documents or appendices not supplied remain unresolved.

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
without a local bundle displays an empty state; pricing and calculators remain
available.

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
Fields with embedded source tables use
`table: {columns: [string], rows: [[string]]}`. Rows preserve column pairing and
source order. A nonempty `value` retains common text outside the nested table;
it does not repeat its cells. The UI renders semantic column headers and literal
text cells, with keyboard-accessible horizontal scrolling on narrow screens.

`GET /api/libraries/penetration/{id}/edit` returns one item draft, its definition
and server-calculated result, revision, source/current price and opaque
`pricing_token`. The corresponding POST routes `/calculate`, `/refresh-pricing`
and `/save` accept exactly `{draft, revision, pricing_token}`. The client cannot
submit calculated prices or an arbitrary pricing configuration. Saved input
revisions and source fingerprints prevent silent replacement after concurrent
edits or an incompatible source update.

The loader rejects duplicate IDs or edges, missing linked items, invalid pages,
unsupported image formats, and paths outside the library. Search is literal,
case-insensitive and paginated; source strings are rendered as text. PDF range
requests are supported for opening larger local reports.

## Verification

```powershell
python -m unittest tests.test_reference_library -v
node tests/test_libraries_ui.cjs
node --check static/library-editor.js
node tests/test_library_editor_ui.cjs
```

Tests use synthetic content. Real source extraction, page coverage, image
mapping and link-review evidence stay with the local installation work, outside
the public repository. Whole-report text extraction is not a claim that every
page or technical interpretation has been visually reviewed.
