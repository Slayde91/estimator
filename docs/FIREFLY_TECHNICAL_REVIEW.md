# Private Firefly Technical review

`reviews/firefly-technical-plan-v1.json` is an optional sidecar in the local reference-library folder. It is never part of the public repository. With no sidecar, the existing classification and navigation remain unchanged. A present but stale, malformed or incomplete sidecar prevents that library revision from loading; it is not silently ignored.

The review covers all 321 current FAS190235 source records and exactly 15 explicitly selected FAS190236 records. Each record receives only the reviewed additional Substrate categories. Existing categories, including FIREFLYBatt, remain present. Original source fields, assessed FRL, services, installation conditions, source diagrams, raw record IDs, duplicate-review identities and saved Firestopping links remain unchanged.

For reviewed FAS190235 records, the public Report field has separate canonical `FAS190234` and `FAS190235` captions and links. The UI presents those links with ` | ` between them. Their stored values remain newline separated, so existing report filters, schedule references and exports continue to treat them as two reports. Report revisions stay in the private evidence and retained source basis; the projection does not add duplicate RIR facet options. A separate `related_technical_records` detail property provides one-way navigation to explicitly reviewed FAS190234 records. It does not use the reciprocal Firestopping relationship table and has no Unlink action. The UI renders 50 targets per page with a read-only Show more action; it never truncates the reviewed list.

Related Technical navigation and private review citations are excluded from item downloads. The two report captions and their validated hyperlinks remain included. The review is discovery and navigation evidence; it does not change calculation rules or establish configuration equivalence from unrelated report sections.

## Manifest contract

The file must be at most 8 MiB and use exactly these keys. This abbreviated example illustrates the shape; the actual `items` inventory must contain all 336 entries, and the selected FAS190236 ID list must contain exactly 15 unique IDs.

```json
{
  "schema_version": 1,
  "review_id": "a-private-reviewed-revision",
  "index_sha256": "<SHA-256 of the exact original library.json bytes>",
  "reports": [
    {"id": "fas190234", "revision": "FAS190234 RIR1.14", "sha256": "<registered PDF SHA-256>"},
    {"id": "fas190235", "revision": "FAS190235 RIR1.29G", "sha256": "<registered PDF SHA-256>"},
    {"id": "fas190236", "revision": "FAS190236 RIR1.25A", "sha256": "<registered PDF SHA-256>"}
  ],
  "scope": {
    "fas190235_count": 321,
    "fas190236_ids": ["<15 exact selected source IDs>"]
  },
  "targets": [
    {
      "id": "<FAS190234 source record ID>",
      "item_sha256": "<fingerprint of the complete raw target record>",
      "system_id": "<exact original ID field>",
      "pages": [1]
    }
  ],
  "items": [
    {
      "id": "<reviewed source record ID>",
      "item_sha256": "<fingerprint of the complete raw source record>",
      "projection_sha256": "<projection_fingerprint of the validated base record>",
      "report_id": "fas190235",
      "system_id": "<exact original ID field>",
      "pages": [1],
      "substrates": [
        {
          "value": "Plasterboard wall",
          "evidence": [{"report_id": "fas190234", "page": 1, "reference": "<private reviewed table/row citation>"}]
        }
      ],
      "related_technical": ["<target ID from the shared targets table>"],
      "evidence": [{"report_id": "fas190235", "page": 1, "reference": "<private source-page citation>"}]
    }
  ]
}
```

`reports` must exactly match the sorted entries in `estimator.firefly_reference_review.REPORTS`, including their registered source hashes. All fingerprints are 64 lowercase hexadecimal characters. Use that module's `fingerprint(raw_item)` for full source records and `estimator.firefly_technical_review.projection_fingerprint(base_record)` for the unchanged validated `_records['technical'][id]` record. That projection proof covers all base fields and existing Substrate categories.

`pages` is the exact sorted unique inventory of every source reference page for that record and report, including attached figure pages. It is not a subset or a manually shortened range. Every item needs its own source-page citation. FAS190235 evidence may cite only FAS190234 or FAS190235; FAS190236 evidence may cite only FAS190236. Each additional category needs its own nonempty citation list and must be one of the canonical `SITE_SUBSTRATES` values.

Every FAS190235 item needs at least one reviewed target; FAS190236 items must have no targets. Shared target bindings contain only FAS190234 records, occur once and must all be used. There may be up to 5,000 unique target bindings or target IDs per item, subject to the total 8 MiB bound. Fingerprints and target source identities are validated once per unique binding. Aliases are resolved for navigation only. A duplicate group whose reviewed site applicability differs is rejected rather than silently merging different decisions.

## Loading, installation and recovery

The runtime validates the complete sidecar before publishing any augmented record. Its file stamp participates in the library revision, effective Firestopping-overlay cache and reference-index cache. Runtime review capabilities cannot be imported through `library.json`.

Private factory seeds accept only the fixed sidecar filename alongside the existing Firefly reference plan. Seed preparation validates and copies both files byte for byte, keeps the original index bytes and includes their exact hashes in the seed manifest. Initialization revalidates the copied source and leaves existing per-user libraries and projects untouched.

Do not use the generic `install_reference_library.py` rewrite path to activate this sidecar against an existing index. That installer serializes its validated index and does not retain optional review files; an index-bound plan cannot be carried over to rewritten bytes unchanged. Review activation must preserve the exact index and install only the fully validated sidecar through the separately authorized guarded operation. Retain the prior sidecar and preservation receipts for recovery. No migration, runtime restart or private review activation is performed by these code changes.

## Validation

The synthetic suite covers complete inventory, report hashes and revisions, source and projection fingerprints, exact system/page identities, citation scope, missing targets, stale/replaced plans, cache invalidation, immutable returned data, manual links and overlays, separate report references, item-download privacy and byte-exact factory seed transfer. A 321-record/200-target case covers 64,200 relationships without repeating binding proofs. The UI suite checks safe native links, literal pipe presentation, one-way navigation, no Unlink controls and access to every target through 50-record pages.

The licensed source mapping and its activation need independent source review and protected-state checks. Native browser acceptance is coordinated separately from the synthetic unit suites.
