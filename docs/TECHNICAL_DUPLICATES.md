# Reviewed Technical Library duplicates

Consolidation is an explicit review of equivalent source records, not a title
matching rule. Different substrates, orientations, configurations or diagrams
must remain separate unless their equivalence has been established.

The optional private bundle field `technical_duplicate_reviews` contains groups:

```json
{
  "canonical_id": "sample-reference-a",
  "members": [
    {"id": "sample-reference-a", "sha256": "<review fingerprint>"},
    {"id": "sample-reference-b", "sha256": "<review fingerprint>"}
  ]
}
```

Use `estimator.technical_duplicates.review_fingerprint` with the original record,
its normalized runtime record and runtime asset registry, before adding review
metadata. The fingerprint binds the complete original and projected record and
referenced asset metadata. A changed or missing member disables its entire group;
remaining records become individually discoverable again. Overlapping groups or
malformed reviews reject the bundle. Review metadata is local supplier data and
must not be published with the application.

Only the canonical member appears in discovery and totals. Searches include every
member's ID and text. Existing detail URLs remain valid, and Source information
lists all consolidated IDs. Original records, source URLs, documents and durable
link fingerprints remain intact. Historical details keep their original ID.

Related links are projected once per group, with distinct relationship text
retained. New links use the canonical ID. Unlinking a consolidated reference
atomically removes/suppresses every member edge; relinking creates one canonical
edge. A source conflict rolls back the whole unlink. Neither discovery nor
consolidation migrates saved projects, pricing, calculator state or database links.
