# Compact project references

New projects use at least two digits: `PN-01`, `PN-02`, through `PN-99`, then
`PN-100`. The compact series starts independently from the earlier five-digit
series. Existing project files, assigned references, automatic owner identities,
and saved or interrupted first-save receipts retain their original values.

The additive `short_sequences` table stores compact high-water marks. Existing
`sequences` rows remain the legacy high-water marks. The first schema upgrade seeds
compact history already present in stored references; it does not reset either
series. `saves.number_series` distinguishes new compact allocations from old
journal receipts, including where the formats become identical. The normal
conditional save journal still handles chooser cancellation, reservations,
concurrent allocation, successful retries and crash recovery.

Observed references with fewer than five serial digits advance compact history.
References with five or more digits are conservatively treated as legacy history
because their printed format is ambiguous. At `10000`, the formats overlap;
allocation then skips the retained legacy high-water range even when an original
file is no longer present. Exact occupied and pending labels are also checked.
Completing a new compact allocation advances its compact counter at every width.

Numbering Settings uses the same server allocator for its next-reference preview
and first Save. Exhausting a prefix leaves Settings editable so the user can
choose another prefix. Updating the starting number never reuses an existing
assignment. Project and document numbering preferences still save in one attached
SQLite transaction.

Risk classification: high for numbering and journal compatibility. Validation
covers old database upgrade, unchanged historical owners/receipts, compact import
history, parallel reservations, cancellation, interrupted writes, high-water
overlap, exhaustion, settings rollback and real project file saves.
