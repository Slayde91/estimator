# Register references

Physical Defect Reports and Service Plans show Report and System immediately
before Source evidence. These are reference candidates, not approval, quantities,
installation selection or a dimensional/table match.

An explicit Firestopping Library assignment takes priority, including an item
without Technical links. Otherwise each actual Service/Barrier context intersects
all recorded canonical facets. At least a non-N/A Service type or Substrate is needed;
category, orientation, opening type or FRL alone cannot trigger a broad listing.
Parents union real child contexts rather than combining fields across siblings.
Full FRL triples keep every criterion; stored scalar minutes constrain only the
centre criterion. No source records, assignments or calculator inputs are changed.

Canonical Technical IDs and existing verified aliases deduplicate systems. They
are sorted by manufacturer and ID, numbered from 1 within each manufacturer and
presented as `Manufacturer-1, 2 | Manufacturer-1`. More systems and More reports
load their respective next 100 with an exact library-epoch guard; they do not
silently omit the remaining IDs or captions.
Only Report Number fields supply physical reports. Case/whitespace-equivalent
captions deduplicate; revision labels remain distinct. Conflicting public URLs
for one caption produce one plain caption rather than a guessed link.

Steel/Duct Takeoff Report cells project the currently linked calculator row's
assessment references after the existing confirmation, binding, source, draft
and usable-result checks. Manual/PDS links never substitute for an assessment.
Private or unavailable editions remain plain captions. Calculator SCHEDULE uses
the same shared renderer. Public links use HTTPS; Technical system links use
the existing guarded Library navigation by canonical ID.

`POST /api/takeoffs/sessions/{id}/register-references` is read-only. It requires
the exact revision, physical scope and up to 100 unique native row IDs. Pagination
is independently bounded to 100 systems and 100 reports per page, with an optional
exact library revision and a separate `report_offset`. Full context facts are
represented only by a digest/count in the response. Cache keys are canonical
SHA-256 digests. Cache creation/retention and each expanded JSON response have
8 MiB budgets, checked incrementally; an excessive projection fails explicitly.
The server derives facts from the existing snapshot; caller-supplied criteria
are rejected. The backend caches its inverted index per effective library stamp
and repeated context matches. XLSX contains literal captions, URLs and system IDs
without formulas; oversized Excel cells fail as they are built rather than
truncate or accumulate the remaining rows. XLSX requests every reference inside
these explicit cell/response bounds; it never exports only the first page.

Coverage: `test_register_references.py`, `test_takeoff_register_xlsx.py`,
`test_takeoff_linked_results.py`, `test_takeoff_physical_ui.cjs`,
`test_takeoff_thickness_ui.cjs` and the disposable native browser fixture
`tests/browser/register_references.cjs`.
