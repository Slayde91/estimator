# Library and calculator follow-ups

Library filter presentation is described in `LIBRARY_FILTER_GROUPS.md`; board
assessment selection and its limits are in `PROMAT_BOARD_ASSESSMENT.md`.

## Quantity and required inputs

Board Quantity repeats the entered lineal metres. Duct Quantity repeats one
complete duct run: its entered length, wall penetration count and floor
penetration count. Each repeated run retains its own wrap overlaps. The displayed
length and penetration inputs remain per run; neither saved inputs nor immutable
workbook coordinates are rewritten to contain multiplied values.

The new inputs are application coordinates `CALCULATOR!CJ` for board and `CM`
for ductwork, displayed immediately after length. Positive whole numbers are
accepted. Explicit blanks remain incomplete. Historical saved rows with no
Quantity input retain one through a private evaluation default. This default
does not enter saved maps or turn blank padding into entered schedule rows.
New rows and material edits explicitly retain a blank Quantity until entered.
The schedule exchange template and PDF/Excel registers include Quantity.

Takeoff transfers keep their existing physical aggregation: a board row's lineal
metres already include all measured members, while ducts retain their separate-run
transfer policy. Generated calculator rows therefore use Quantity 1. The physical
member count and identities remain in Takeoffs; they are not multiplied twice.
Unchanged older links retain their original hashes when Quantity is absent.
An explicitly blank or edited Quantity remains part of the linked-row comparison.

Spray and intumescent required inputs are Input method, Exposure/member case,
Critical temperature, Product, Fire period, Quantity and Length/member. A valid
existing area override replaces the member Quantity and Length requirement.
Board required inputs are Product, Lineal metres, Quantity, Sides, FRL,
Beam/Column and Critical temperature. Required controls are marked and missing
fields are identified in the row review. Existing source calculations and raw
saved legacy inputs remain traceable.

## Presentation changes

Board Row status and the duct Body fixing/support guide use short clickable
review labels with the full explanation available in a dialog. Board ESA/M
input is displayed beside Family (ESA input), using its original cell identity.

The CAFCO duct settings panel displays only Yield basis, calibration reference
area, calibration reference thickness, calibration target net bags, estimating
bag mass, estimating density and Working net yield. Other settings and formulas
remain available to the calculation and saved data underneath this projection.

## Change classification

Filter groups, visible ID omission, column order, review dialogs and settings
row visibility are presentation changes. Quantity is an explicitly requested
calculation change. PROMATECT 100/250 assessment and stock selection are source
rule changes. Other product rules, prices, original compressed workbooks,
immutable Excel captures, manual library links and persistent identities remain
outside the change. Report/export data is derived through the same application
engine as the calculator.
