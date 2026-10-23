# Perlifoc assessment policy

The 23 October 2026 instruction makes the supplied Carboline report
**FC21278-01-1, 4 November 2025** the application thickness basis for
**PERLIFOC HP ECO+**. It replaces the inherited FC15622 Issue 4 thickness route.
The original compressed workbook, source hash, formulas and Excel oracle remain
unchanged historical evidence. Saved project files, calculator inputs and
frozen prices are not migrated or rewritten. Recalculating a Perlifoc draft uses
the new assessment; saving that draft remains an explicit user action.

## Cases and limits

The policy loads all 36 tables (Tables 5-40, report pages 11-46):

| Application case | Report tables | Member scope |
| --- | --- | --- |
| Re-entrant - 3 sides | 5-13 | I/H beams below concrete slabs; report-permitted re-entrant sections |
| Re-entrant - 4 sides | 14-22 | I/H columns and four-sided beams; report-permitted re-entrant sections |
| Hollow - 3 sides | 23-31 | RHS/SHS beams below concrete slabs |
| Hollow - 4 sides | 32-40 | RHS/SHS/CHS columns; four-sided hollow beams subject to the report's member scope |

Critical temperatures are the exact published 350-750 C values in 50 C steps.
Periods are 15, 30, 45, 60, 90, 120, 180, 240 and 360 minutes. A column's presence
does not imply that every factor/temperature combination has a result. Report
blanks stay unavailable and withhold thickness-dependent quantities.

The retained application factor range is 68-476 m-1. Table 4 gives a minimum
assessed factor of 68, although the first table row is labelled <=68. The app
does not extend below that stated minimum or above the last published row of
476; Table 4's higher limit of 476.6 does not supply another table row.
`Exact only` requires a listed factor. `Next higher (estimate)` selects the next
higher published row and labels that choice as an estimate. Neither policy
interpolates, changes temperature, substitutes a longer period or extrapolates.
The hollow tables already include the report's hollow-section corrections.

Named members use retained factors for their exact exposure and remain
estimates, with factor provenance. An H3 member never reuses an H4 factor.
Named H3 members must be RHS/SHS; named H4 members must be RHS/SHS/CHS. Unsupported
or excluded identities and ambiguous/missing factors remain blocked. User-entered
Hp/A or ESA/M cannot establish member identity, slab contact, web-depth limits,
steel preparation, primer or installation compliance. The result identifies
these report conditions for project review.

## Private evidence and installation

The complete PDF and table matrix are private and must not enter the public
repository, source ZIP or synthetic test fixtures. The fixed dataset name is
`perlifoc-fc21278-01-1.json`. Its schema retains all 13,932 table positions as
integer millimetres or null. The production digest is pinned in
`estimator/perlifoc_assessment.py`, together with the source report digest.

For source installations, set `CEASEFIRE_CALCULATOR_EVIDENCE_DIRECTORY` to an
absolute directory outside the checkout containing both reviewed Perlifoc and
Monokote datasets. Full desktop installers require both artifacts and verify
their exact bytes before staging and after freezing. The source distribution
does not include either private matrix.

`scripts/import_perlifoc_assessment.py` takes an explicit report and output path
outside the checkout. Its independent coordinate and text extraction must agree
on every position before it writes the deterministic dataset. The runtime and
desktop build reject missing, changed, oversized, malformed or redirected data.
Every request verifies the evidence before reusing a calculation cache. A failed
Perlifoc check never falls back to the older workbook table.

## Calculation and preservation checks

Quick calculation, all nine comparison periods, 1,000 schedule rows, PDF and
values-only XLSX use one assessment engine. Outputs retain report page/table,
factor choice, scope and evidence receipts. The original area, volume, material
yield, waste and pooled bag formulas consume the new estimating thickness.
Other products retain their existing policies and do not gain 360-minute cover.

Public tests use invented matrices to check case/temperature/factor/period
addressing, blanks, input bounds, cache invalidation, quantities and export
agreement. Release verification separately compares every private dataset cell
to the supplied PDF and checks saved-project/database preservation against a
verified recovery checkpoint. Table consistency is not installation approval.
