# UI data-access review — 24 September 2026

## Incident findings

The saved-project and reference-library failures had two independent local
causes:

1. Two Python processes were listening on `127.0.0.1:8765`. Python's threaded
   HTTP server enabled address reuse, which permits this on Windows. Browser
   requests could therefore reach different server processes with different
   in-memory state; the older process also had stalled project scans.
2. The installed `.runtime/reference-library` directory had owner-only access
   rules. The installation script created its staging directory with
   `tempfile.mkdtemp` and renamed that directory into place, preserving those
   restrictive Windows rules. The desktop server account could not read the
   library index, so both reference-library APIs failed closed.

The linked project folder itself is valid. A fresh scan found four valid project
files, and the first page completed while the background scanner continued
through the folder. A saved project was retrieved, reviewed and loaded with its
quote, firestopping schedule, pricing snapshot and three calculator drafts.

## Corrections

The HTTP server now refuses to share its port with a second Estimator process.
The reference-library installer now creates its random staging directory with a
normal child-directory operation, so it inherits the destination parent's
access rules before the verified bundle is atomically renamed into place.

These changes do not alter saved projects, pricing, calculator models,
firestopping records or technical references.

## Rendered verification

An isolated server with the same project database and the verified reference
bundle showed:

- four saved projects, including a successful confirm-and-load journey;
- 897 Firestopping Library records, 817 linked to technical references; and
- 1,827 Technical Library records.

The rebuilt library was also verified end to end against all 2,036 referenced
documents and images before live replacement.
