# BOSS matrix import

The developer tool prepares a separate private Technical Library index. It never
edits the source workbook, installs data, downloads reports, changes calculator
choices, or runs workbook formulas. Supplier workbooks and prepared records stay
outside Git.

Run from the repository root:

    python scripts/import_boss_matrix.py <matrix.xlsx> --base <installed-library-directory> --report-links <captured-report-links.json> --output <new-private-directory>

Use the cached values in the reviewed December 2025 layout, with headers on row 8.
The importer rejects changed field headers, unexpected substrate marks, duplicate
identities, unknown services, unsupported orientations and oversized workbooks.
Each system keeps its workbook hash, sheet, row, source-row hash and stable
boss-bf-... identity. Shared import metadata records the column mapping, report
catalogue and held records. Re-importing into an index that already contains this
import requires a separately reviewed update.

The approved mapping uses existing service choices. PPR, PP, PE, CPVC, ABS,
composite and concentric pipes use **Plastic Pipes**. Iron uses **Unlagged Pipes**
or **Lagged Pipes**. Existing specific choices remain available where applicable.
Categories follow the existing service-to-category rules. Valve/tap sets and
electrical floorboxes are held, as requested by the user; no new category or
service type is created.

Only substrate columns K–AQ marked 1 become Barrier Construction bullets and
substrate search choices. Each bullet includes AR minimum thickness. J (the
originally tested substrate) and local build-up materials never create approved
alternatives. A system without marked substrates retains a visible source issue.
Wall maps to Vertical; Floor and Ceiling map to Horizontal.

FRLs, size limits (including zeroes and text), products, side-specific conditions,
seal depth, fillet, aperture and wrap length retain their source meaning. Pure
service-description sentences from BJ go into Service Size / Configuration;
mixed clauses remain intact in Installation Details with build-up requirements.
The field review fingerprints protect that allocation from later automatic
reclassification.

Report references retain the exact BK text. The report capture must contain
source_url "https://bossfire.com/resources/" and a pdf_links array of
{label, url} objects from section 6. Links must use the bounded official BOSS
test-report path. Only a unique matching report family/number receives a link.
Missing reports stay plain text with a source issue. A revision qualification
that cannot be matched to the catalogue label receives a visible equivalence
note; linking does not establish that revisions are equivalent.

Before activation, verify the prepared import audit, all source rows, held IDs,
original records, asset registrations and source/project recovery checkpoints.
Stop the verified local server and atomically replace **only** the installed
library.json. Preserve the existing documents, images and replica folders.
The generic bundle installer must not replace that live directory with this
index-only output. Restart the app and verify its library counts, sample records,
links, saved projects and protected-file hashes.

The index limit is 96 MiB: this import brings the previous 64 MiB limit to within
3 KiB of capacity. Existing record, field and asset limits remain in force.
The source matrix contains no embedded diagrams; report hyperlinks do not attach
or independently review the report contents.
