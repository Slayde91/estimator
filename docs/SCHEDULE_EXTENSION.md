# Application schedule capacity and location fields

The application presents the calculators in this order: **Steel (spray)**,
**Steel (board)**, **Ductwork (spray/wrap)**. Their internal calculator IDs and
source workbook identities remain unchanged.

| Calculator | Application schedule | Original source schedule | Location |
| --- | --- | --- | --- |
| Steel (spray) | SCHEDULE 10:1009 (1,000 items) | 10:1009 | New optional text in AA; source A:L inputs retain their coordinates |
| Steel (board) | CALCULATOR 9:1008 (1,000 items) | 9:208 | Existing B input |
| Ductwork (spray/wrap) | CALCULATOR 11:1010 (1,000 items) | 11:310 | Existing schedule fields retained |

The immutable source packages, hashes, original extraction specifications and
native Excel fixtures remain source evidence. `workbook_runtime.py` builds an
application model from those packages. It extends repeated schedule formulas,
their input validation, table boundaries and dependent summary ranges. This
adds capacity using the existing calculation rules; it introduces no new fire
rating, product selection, waste or purchasing rule. Forty EXTRA BOARDS entries
remain a separate allowance table.

Line is read-only and numbered 1 through 1,000. The spray schedule exposes its
existing Z line identity, with Location shown immediately after it. Board shows
a generated Line column before its existing fields. Display ordering never
shifts the stored source coordinates. Location is descriptive text and does not
enter a quantity formula. It is saved with its calculator draft and carried into
the steel schedule PDF and XLSX register.

## XLSX exchange

New templates contain 1,000 prepared rows and a generated Line column. Spray
templates put Location second; board retains Member mark followed by Location. The remaining headings map explicitly to source
input coordinates, including dependent dropdown formulas. Numbers remain typed
and retain their precision. The legacy templates with the original exact input
headings remain accepted.

Line is informational: physical worksheet row order determines the imported
schedule position, and the application regenerates its line numbers. It is not
stored as an editable input and does not make an otherwise empty row populated.
Import remains a draft replacement of the entire schedule, preserving settings
and separate extra-board allowances. Save calculator is still required to
persist imported values.

Schedule PDF and XLSX filenames remain `APPENDIX A.pdf` and `APPENDIX A.xlsx`.
Summary PDFs remain separate, and their established content exclusions remain
in force. Downloads capture the current draft without saving it.

## Evidence boundary

Original native fixtures establish calculation parity within the original
source capacity. Extended rows additionally require checks at the former
boundary, a middle row and item 1,000, including independent per-line results,
product summaries, pooled orders, incomplete rows, dropdowns and export/import
round trips. Merely displaying 1,000 blank rows is not proof that totals include
them. Runtime saved-state checks use disposable databases; the user's saved
quotes and pricing are preserved.

Validation and publication receipts for this increment are recorded in
`.runtime/thousand-row-schedules-qa`. Earlier documentation checkpoints describe
their own revisions and do not establish completion of this extension.
