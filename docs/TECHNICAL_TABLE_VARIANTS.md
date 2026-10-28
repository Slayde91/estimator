# Reviewed Technical Library table variants

The private `reviews/technical-variants-plan-v1.json` sidecar names reviewed
configurations. It does not modify `library.json`, supplier files, calculator
inputs, prices, or saved projects. The loader validates existing field,
duplicate, Firefly and Services reviews before applying these public views.
Without this optional sidecar, the original library remains unchanged.

The top-level object has `schema_version: 1`, `review_id`,
`reviewed_index_sha256`, `families`, `aliases`, and optional `existing_bindings`.
The index hash records lineage; every referenced raw item, public projection,
discovery assignment and referenced asset remains individually fingerprinted.
Unrelated added records do not invalidate an unchanged family.

Each family contains:

- `source_id`, `item_sha256`, `projection_sha256`, `discovery_sha256`,
  `assets_sha256`.
- `tables`: `{field, table_index, sha256}` bindings, using zero-based positions.
- `reviewed_tables`: explicit source-backed corrections/additions, otherwise `[]`.
- `variants`: explicit applicable combinations, never a Cartesian product.

Helpers in `estimator.technical_variants` produce the bindings:
`source_fingerprint(raw)`, `projection_fingerprint(public)`,
`discovery_fingerprint(discovery)`, and `assets_fingerprint(raw, assets)`.
`projection_fingerprint` applies `present_technical`, matching the captured
public display stage. `registered_assets(raw_library)` supplies the complete
registered metadata expected by `assets_fingerprint`.

Each variant contains `key`, `existing_id`, `selections`, `fields`, and `facets`.
Exactly one variant per family retains `existing_id == source_id`. A null ID
uses `variant_id(source_id, key)`, independent of review/variant order. Reusing
another existing ID requires its full binding in `existing_bindings` (same
fingerprint fields as a family, with `id` instead of `source_id`) and exact
substantive equality. Prefer explicit aliases for genuine duplicate views.

A selection is `{field, table_index, columns, row_index}` or the same object
with `row_indices` instead. Null `columns` keeps all columns. Multiple FRL
columns require an explicit single FRL column choice while retaining all other
technical columns. Rating-bearing selections keep one row. Non-rating ancillary
tables may retain several cumulative rows. `row_indices: []` removes an
inapplicable alternative table from the public view. Table captions, row IDs and
local links are remapped together; source tables remain in retained evidence.

`fields` maps public field labels to reviewed scalar strings. Unspecified
details and every source/image reference are inherited. Manufacturer, report,
diagram and private-evidence fields cannot be replaced. `facets` contains
exactly `frl`, `substrate`, `orientation`, `category`, and `services`; the FRL
list contains one canonical source-supported rating. Type, report and
manufacturer assignments inherit. Services use approved choices or unchanged
historic parent values; the six non-service categories require `N/A`.

A corrected/appended table has `field`, `table_index`,
`source_table_sha256`, `table: {columns, rows}`, `row_ids`, and `evidence`.
An appended table uses the next table position and `source_fingerprint(None)`
for both its original binding and `source_table_sha256`. Its field may have no
existing table. Evidence entries are
`{asset_id, sha256, page, quote, source_reference}` and must identify a registered
PDF/image belonging to the exact source record. These are private reviewed
transcriptions; the loader does not invent missing cells or parse diagrams.

Aliases have `{alias_id, canonical_id}`. Both endpoints must be bound originals
or projected variants. `technical_signature(record, discovery, assets)` compares
all substantive fields, selected tables, image content and all discovery facets.
IDs, source provenance and table captions do not establish technical difference.
Different Substrate, FRL, Category, Services, orientation, type or substantive
instructions cannot be merged. Alias chains and cycles are rejected.

Original raw records remain available for existing durable references.
`ReferenceLibrary.technical_source_record` returns the original raw record for
old IDs and a source-bound descriptor for new IDs. New manual references bind
the parent source and reviewed variant identity. New siblings inherit source
images and parent lineage, including future reviewed replicas registered against
the same original image IDs; they do not inherit asserted Firestopping links.

Changed source/projection/asset/discovery evidence fails closed. Publishing a
manifest requires source review of actual row applicability, especially separate
wall/service tables, cumulative fixings, wrapped/unwrapped ratings and footnotes.
An ambiguous configuration remains held for review instead of receiving an
invented combination or minimum rating.
