# Register references

Physical Defect Reports and Service Plans show Report and System. Source evidence
is hidden in the register while the underlying evidence remains retained. Reports
are explicit reference choices, not approval, quantities or a dimensional/table match.

Manual physical rows have no suggested Report or System. Choose reports / Change
reports opens the same Technical Library picker as the Firestopping Schedule;
recorded facts only prefilter that picker. Applying a choice saves bounded optional
technical_reference_ids through physical preview/apply, history and portable Save.
An explicit empty list blocks inheritance; removing that optional field restores
the existing Firestopping Library links. An assigned library item without Technical
links never receives an inferred substitute. Parents union real child contexts
rather than combining facts across siblings. Reference-only edits retain physical
facts, quantities and confirmation; stale or unavailable newly chosen IDs are rejected.

Canonical Technical IDs and existing verified aliases deduplicate systems. They
retain explicit choice order. Physical registers display sequential `1 | 2` System
links, while generic discovery callers retain their manufacturer grouping. More systems and More reports
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
