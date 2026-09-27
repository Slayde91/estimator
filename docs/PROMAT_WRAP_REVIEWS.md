# Reviewed Promat wrap corrections

The importer puts an identical wrap requirement shared by every variant in the
existing **Service Wrap** field. Different requirements stay beside their own
configuration rows. An empty supplier value is not evidence that another row's
wrap applies to it, or that no wrap is required.

Use `scripts/review_promat_wraps.py` for an explicitly reviewed correction that
applies to **every variant** of an installed group:

```powershell
python scripts/review_promat_wraps.py --bundle PATH/library.json --reviews PATH/reviews.json --output PATH/library-candidate.json
```

The private review JSON is a list of decisions with:

- `id`: the existing library entry ID.
- `variant_ids`: every original selector variant, in source order.
- `expected_sha256`: `review_fingerprint` of a dictionary containing
  `source_fields` (the original entry fields), `reviewed_fields` (the current
  field review), and `promat_source` (the original source-page metadata).
- `value`: the reviewed common Service Wrap value, such as `N/A`.
- `reason`: the basis for applying this decision to the whole group.

Additional evidence references, report fingerprints and review dates can be
recorded in the decision. Decisions stay in the private bundle's field review.
Supplier records and review manifests must not be committed to Git.

The tool validates both complete indexes, refuses stale evidence, and writes a
new candidate file. It changes reviewed Service Wrap fields and columns only;
original supplier fields, variant identities, source pages, FRLs, other table
columns and row order remain intact. It does not interpret report diagrams or
infer engineering requirements. A second application needs a new review bound
to the resulting fields.

Before installing a candidate, compare every library entry and preserve a copy
of the installed index. Replace only the validated index, then check the live
API and rendered entries. Re-imports must carry forward or reapply reviewed
corrections after checking their source fingerprints; do not overwrite an
installed reviewed bundle with a fresh unreviewed export.
