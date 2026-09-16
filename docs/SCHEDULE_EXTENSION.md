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

New **Export XLSX Template** files contain 1,000 prepared rows and no Line
column. Spray has 13 input columns with Location first, followed by Item / mark;
board retains its 24 inputs starting with Member mark then Location, and duct
retains its eight inputs. Headings map explicitly to source input coordinates,
including dependent dropdown formulas. Numbers remain typed and retain their
precision. Table headings and cells are centred.

Previous application templates with a generated Line column and legacy
templates with the original exact input headings remain accepted. Line in an
older template is informational: physical worksheet row order determines the
imported schedule position, and the application regenerates its line numbers.
It is not stored as an editable input and does not make an otherwise empty row
populated. New templates omit it entirely; the UI and full schedule reports
continue to display line numbers.
Import remains a draft replacement of the entire schedule, preserving settings
and separate extra-board allowances. **Save Project** persists the estimate,
its pricing and all three calculator drafts together; no separate Save
calculator action is required.

Schedule PDF and XLSX filenames remain `APPENDIX A.pdf` and `APPENDIX A.xlsx`.
Summary PDFs remain separate, and their established content exclusions remain
in force. All PDF/XLSX table headings and data are centred. Downloads capture the
current draft without saving it.

## Evidence boundary

Original native fixtures establish calculation parity within the original
source capacity. Extended rows additionally require checks at the former
boundary, a middle row and item 1,000, including independent per-line results,
product summaries, pooled orders, incomplete rows, dropdowns and export/import
round trips. Merely displaying 1,000 blank rows is not proof that totals include
them. Runtime saved-state checks use disposable databases; the user's saved
quotes and pricing are preserved.

The original capacity-extension evidence is recorded in
`.runtime/thousand-row-schedules-qa`. Current template/export checks and rendered
PDF/XLSX evidence are in `.runtime/project-library-qa`, including first/final
physical-row identity when importing previous numbered templates. Earlier
documentation checkpoints describe their own revisions and do not establish
current publication status.
