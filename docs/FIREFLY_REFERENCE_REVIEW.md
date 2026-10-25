# Firefly source-reference reviews

Firefly's original workbook rows, frozen prices, diagrams and registered PDFs
remain unchanged. A private, source-bound review can correct the supplier's
Technical Library navigation without replacing the library index or image
registry. This review is a reference selection aid, not compliance approval.

The optional local file is
`<reference-library>/reviews/firefly-reference-plan-v1.json`. It is excluded from
Git and the source distribution. Without it, the original supplier references
remain available. A present but invalid or stale review fails closed; it does
not silently reuse a previously cached correction.

The review binds the exact original index SHA-256, every Firefly item, its full
original item fingerprint and registered diagram identities, and the three
registered report revisions and hashes. Every selected Technical target binds
its canonical ID, complete source record fingerprint, report, system ID and
PDF page. All current Firefly supplier items must be covered exactly once. Other
manufacturers and Technical source records are outside this projection.

Physical installation context controls report selection:

| Installation | Required report references |
| --- | --- |
| Batt without a service | FAS190234 |
| Service through Batt | FAS190234 and FAS190235 |
| Service without a Batt installation | FAS190236 |

A selected/default material or an optional gap-filler instruction alone does
not establish a Batt installation. Review the original source diagram,
description and installation instructions together. Resolve unknown source
tokens to one best canonical active ID per relevant report; never apply a
general suffix-stripping rule. A configuration candidate is explicitly labelled
as requiring review, even when the canonical reference identity is established.
Differences or missing source evidence remain visible. No dimensional, material,
FRL or compliance equivalence is inferred by the loader.

Review statuses distinguish an exact source match, retained supplier reference,
best candidate and an unresolved limitation. Candidate relationships and their
condition differences remain visible under **Reference qualification**. Selecting
an active canonical identity resolves the old missing-ID notice; it does not
establish configuration equivalence. **References not established** is reserved
for genuinely unresolved IDs or missing references. The original caption, workbook revision notice and
all other row fields remain unchanged; only supplier reference relationships
and the reference-review/unresolved-reference notice fields are projected.

Saved item edits and source-bound manual links/unlinks are applied afterward by
the existing Firestopping overlay. They retain their original database records,
source-version checks and saved-edit notices. A supplier review cannot remove
an explicit user-origin relationship from the source index.

Before activation, independently validate the private review against the
checkpointed index and original assets, preserve its exact bytes, and compare
the complete protected state. Install only the reviewed new private file; do
not replace the library directory or its replicas. The cache observes review
creation, replacement and removal on the next library read.

Private factory seed preparation validates and copies an optional review
byte-for-byte beside the unchanged original index, and includes it in the seed
manifest. A stale review rejects seed preparation. Rebuilding/replacing the
source library requires a fresh review bound to that new source; the full
library installer deliberately does not carry an old review into a new bundle.
