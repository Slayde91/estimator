# Library filter presentation

Services choices are organised under Electrical & communications, Mechanical,
HVAC, Plastic pipes, Lagged metal pipes and Unlagged metal pipes. Pair Coils is
shown under Mechanical. N/A and Mixed Services remain standalone first choices;
unknown historical/custom choices remain available without an inferred group.
The independent calculator retains its existing Services choice order.

FRL groups use the centre (integrity) criterion. Existing 30, 60, 90, 120, 180,
240 and 300 minute choices are retained, together with any other existing
numeric centre criterion. No rating is rewritten by grouping.

Report groups come from the manufacturer metadata of records carrying that
exact Report value. Both `document` and `report` filter keys are supported.
Shared, partly unattributed or unknown ownership stays standalone rather than
being assigned to an invented manufacturer. Source report labels and option
values remain literal. Group captions for Services and FRL are translated.

The main library filters, technical-reference chooser and Firestopping search
chooser use native optgroups. Selecting a grouped choice sends its original
filter key and value. Existing selected values absent from current choices keep
their standalone fallback. Pagination, Back and reference selections retain
their existing query state.

Only the visible `ID` field on Promat and Trafalgar Technical Library details is
omitted. Record titles, internal IDs, raw fields, API responses, source evidence,
exports and durable manual links retain their existing identities. Other brands
and Firestopping Library ID fields remain visible.

Grouping is added only to filter response metadata after duplicate review.
It does not alter records, source bundles, review fingerprints, source facets,
calculations, prices, saved drafts, report approval or technical applicability.
