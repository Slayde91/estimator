# Calculator report updates and column choices

## Classification and retained evidence

This change combines presentation controls with explicitly requested assessment
updates. Report-backed thickness and coverage corrections are calculation-rule
changes; column visibility, links and hover colours are presentation changes.
There is no saved-project or pricing migration.

The imported workbook files and gzip catalogs remain unchanged. Reviewed rules
sit above that evidence. Saved input identities, raw input values, estimating
prices and quantity precision remain separate from report authority.

## Steel spray reports

The reviewed editions are:

| Product | Report | Issue date |
| --- | --- | --- |
| CAFCO 300 | FC13107-01-05 | 8 July 2025 |
| MANDOLITE CP2 | FC21286-01-01 | 22 December 2025 |
| FENDOLITE MII | FAR3541 Issue 7 | 7 October 2025 |

Official PDF links and individual report hashes are recorded in
`data/calculator_documents.json`. Report captions come from the evaluated row's
source identity, so an old Issue 6 caption is never linked to Issue 7 by a blind
text replacement.

The complete numerical matrix stays in the external, reviewed
`promat-steel-spray-reports-v1.json` snapshot. It is not published in the source
repository. Its digest and source-report identities are enforced by
`promat_spray_assessment.py`. Missing, changed or invalid evidence withholds the
affected product's usable thickness and quantities; it cannot restore the old
manual lookup. A fresh validated snapshot participates in calculation-cache
selection. Deliverable installers require this snapshot alongside the other
five existing assessment snapshots.

To reproduce the private snapshot, install the optional requirements from
`requirements-import.txt`, then run `scripts/import_promat_spray_assessments.py`
with `--cafco`, `--cp2` and `--fendolite` pointing to the complete reviewed PDFs.
Use `--output` with a new absolute path outside the repository. The importer
checks each complete PDF hash and page count, preserves vector-grid blanks,
independently checks numeric text rows, and accepts only the pinned final
dataset digest. It writes a private receipt and never downloads reports or
writes application state. Install the validated JSON in the external evidence
directory selected by `CEASEFIRE_CALCULATOR_EVIDENCE_DIRECTORY`; keep it beside
the other reviewed snapshots. Frozen installers use the same evidence gate.

Unpublished cells and member-case limits remain explicit. CAFCO and CP2 permit
using a lower printed temperature conservatively; the result records the
requested and used temperatures. FENDOLITE requires an exact printed
temperature. Section-factor policies remain explicit, and no value above a
report's maximum factor is extrapolated. Report conversion of ESA/M to Hp/A
uses 7.85, without rewriting the retained editable density setting.

## Other report links

The public PROMATECT-XS link is **FAS230021 RIR1.4**, issued 20 February 2025.
It identifies the underlying FAS230021 R1.4 assessment. Linking it does not
expand the existing brochure-derived lookup choices.

MONOKOTE duct protection uses **FC15909-01-03**, issued 24 February 2026.
Its corrections, construction limitations and quantity boundaries are described
in [MONOKOTE_DUCT_ASSESSMENT.md](MONOKOTE_DUCT_ASSESSMENT.md).

## Column visibility

Each workbook register and both Firestopping schedule views have a Columns
button. Every supported user-facing column is initially checked. Select all
controls the full list; individual checkboxes hide or show their own column.
Internal lookup keys, validation flags, blank spacers and duplicate identities
are not user-facing columns.

The board schedule also omits the nine advanced inputs M:U (Exposure layout
through Steel mass) from the browser table and Columns menu. Select all does
not restore them. Their source cells, API data, saved inputs, calculation rules
and exports are retained; V:X and other supported columns remain available.

Choices are local browser preferences, scoped to the calculator register.
They do not change project drafts, saved calculator inputs, required-field
checks, calculations or exported schedules. New columns start visible. Invalid
or inaccessible preference storage falls back to all columns visible.

Visibility updates preserve mounted controls, input selection and scroll
position. The dropdown supports keyboard focus, Escape, outside dismissal,
translated labels and right-to-left layouts. Report cells and basis/detail
buttons use the same red background and white text on hover or keyboard focus.
