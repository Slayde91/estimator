# Takeoff viewing controls

Line Colour and Line Width edit only markup appearance. New width edits accept
1–100 PDF points; Opacity accepts 1–100 percent and is stored as a fraction.
Untouched historical fractional widths and opacity values retain their exact
stored values. Set as default is a browser preference for newly created markups.

Display Values enables calibrated segment lengths in millimetres, including the
closing edges and exclusions of a surface, plus its total area in square metres.
Steel count markers display their explicitly entered per-member length. These
labels do not create calibration, alter quantities or infer missing lengths.

Rotate page turns the displayed original PDF 90 degrees clockwise per click.
Rotation is scoped to each page in the current workspace and composed with the
PDF's original rotation. Rendering, markups, hit targets and selectable text share
the resulting transform. Source coordinates, calibration and retained PDFs are
unchanged. Rotation is a viewing preference and is cleared when changing project.

Steel Thickness (mm) is a read-only projection of the currently selected linked
schedule: the spray estimating thickness or board total thickness. It retains
the calculator's numeric precision. Values require current confirmation, local
transfer provenance, original workbook identity and matching row inputs.
Unlinked rows stay blank; stale or unavailable results show Unavailable. Changing
the destination clears its thickness filter. No thickness is guessed from steel
fields or another schedule, and no calculator formula is changed.

The four calculator destinations are in the header's Calculators menu, opened by
hover, keyboard focus or click/touch. Opening the menu does not initialize or
change a calculator. Explicit selection retains the existing draft guards.
