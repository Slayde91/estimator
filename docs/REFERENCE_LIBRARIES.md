# Local reference libraries

The Libraries page has three tiles: Pricing Library, Penetration Library and
Technical Library. The existing pricing editor keeps its own state and actions.
Reference browsing does not change prices, estimates or calculator inputs.

Penetration records retain the supplied workbook's stable PKB Entry ID, source
sheet and row, every field in its library table, and the original in-cell PNG
diagrams. Blank cells remain blank in the data. Calculator results and cached
prices elsewhere in that workbook are not imported as new pricing.

Technical records identify the supplied report revision and exact PDF page. The
index includes reports, tables, systems and drawing references. The complete
original PDFs open locally, including notes and conditions outside the indexed
excerpt. Reserved or blank system entries retain their source status.

## Relationships

One stored relationship generates navigation in both directions. It records its
evidence in plain language beside the link. Workbook IDs identify library items;
they are not technical report system IDs. Description or diagram matches must
retain their stated basis and any ambiguity. Related references are navigation
links, not a new technical selection or a claim of project suitability.

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
lowercase ID, title, fields, sources and optional image references. PDF sources
use a registered `document_id` and one-based `page`. Filter values are lists of
exact source labels. Top-level `links` stores each penetration/technical pair
once, with a human-readable `relationship` explaining its basis.

The loader rejects duplicate IDs or edges, missing linked items, invalid pages,
unsupported image formats, and paths outside the library. Search is literal,
case-insensitive and paginated; source strings are rendered as text. PDF range
requests are supported for opening larger local reports.

## Verification

```powershell
python -m unittest tests.test_reference_library -v
node tests/test_libraries_ui.cjs
```

Tests use synthetic content. Real source extraction, page coverage, image
mapping and link-review evidence stay with the local installation work, outside
the public repository. Whole-report text extraction is not a claim that every
page or technical interpretation has been visually reviewed.
