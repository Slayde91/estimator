# Approved calculator source exception

## Ductwork penetration fixing text

On 13 September 2026 the user approved correcting copied technical text in the
ductwork calculator from the first schedule row, while preserving all quantity
formulas. The original workbook remains unchanged.

Source: `Ceasefire_Duct_Estimator_NEW.xlsx`, SHA-256
`9b2e5388a0118c4b3f66ea57f582d487d156585b45d9f34ebc8178f270ff7462`.

The formula in `CALCULATOR!AL11` contains the intended first-row fixing guide.
The subsequent 299 formulas, `AL12:AL310`, contain accidentally incremented
numbers inside quoted text. These are actual formula literals, not stale Excel
caches. Native Excel recalculation reproduces the defect.

| Schedule row | Source formula text examples |
| --- | --- |
| 11 | M6 × 120 fixing designation |
| 12 | M7 fixing designation; AS4255 |
| 13 | M8 fixing designation; AS4256 |
| 310 | M305 fixing designation; AS4553 |

The settings fixing table retains M6. The corresponding FyreWrap Australian
ductwork manual is published by Trafalgar:
[FyreWrap Ductwork Technical Manual](https://tfire.com.au/documents/FyreWrap_Technical_Manual).
The independently verified 111024 edition, printed page 23 Table 2, specifies
M6 × 120 for the masonry Maxilite fixing and M6 × 30 for the angle fixing:
[official dated manual](https://docadmin.tfire.com.au/exfiles/FyreWrap%20/TFire_FyreWrap_ductwork_technical_manual_111024.pdf).
The manual is supporting context; this exception does not introduce new design
requirements or replace the source workbook's fixing table.

The runtime uses `AL11` as the master formula and translates its cell references
to each target row. Quoted technical numbers remain fixed. The packaged source
keeps its original formulas and source hash for traceability. Regression evidence
distinguishes original Excel output from the approved corrected text.

Scope is limited to this fixing-guide text. No bag, wrap, board, angle, coverage,
thickness, yield, dimension, quantity, or pricing formula is changed by this
exception. The other 79 schedule formula columns already have consistent relative
references and are reproduced from the source.
