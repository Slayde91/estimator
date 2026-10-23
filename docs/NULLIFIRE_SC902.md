# Nullifire SC902 calculator

Steel (intumescent) is an application model separate from the three retained
workbooks. Its stable calculator ID is `steel_intumescent`. It has START,
SCHEDULE, SUMMARY and SETTINGS pages and 1,000 schedule rows. It initially
supports Nullifire SC902 only. Existing workbook packages, formula identities,
saved projects and frozen prices are retained.

## Thickness authority

BRANZ FC18580-01-01, issued 20 March 2024, is the DFT authority. The 2020 in the
supplied filename describes the standard, not the issue date. Report Tables
3-34 cover I/H beams protected on three sides, I/H columns protected on four
sides (including four-sided I/H beams under report page 8), RHS/SHS columns
and CHS columns. Hollow beams, cellular beams, filled
columns and tension rods are not enabled by broader product-page statements.
RHS/SHS columns require reinforcing mesh.

Fire periods are 15, 30, 45, 60, 75, 90, 105 and 120 minutes. Published table
thicknesses are millimetres; the importer converts them exactly to integer
micrometres, and the UI labels DFT in microns. The source locator retains the
printed millimetre value. Report nulls remain unavailable. Red table cells are
applicable under the express statement on report page 8.

A/V is heated surface per unit volume, numerically equal to Hp/A when both
refer to the same exposed perimeter and steel area. Neither numerical equality
nor a user-entered factor establishes member identity or installation scope.
ESA/M in m2/t converts as `A/V = ESA/M * steel_density_kg_m3 / 1000`.

The app selects the next higher published A/V row. The minimum row may be used
below the minimum A/V, expressly permitted on report page 8. Above the maximum
A/V is unavailable. Within 350-750 C, the next lower published temperature is
used, as page 8 permits a table value at any higher steel temperature. The
I/H tables do not contain 520 C; a 520 C input uses the 500 C column and is
labelled as a conservative selection. Fire periods must be listed exactly.
The app does not interpolate, extrapolate above the assessed ranges, or
calculate thickness from the report's regression coefficients.

Named sections use the retained member geometry to estimate exposure-specific
A/V and coating girth. Family mismatches, unresolved geometry and unrecognised
identities withhold DFT or quantities. Geometry does not supply an independent
SC902 named-section approval. A factor-only input requires a verified coating
area or girth/quantity/length for material quantities.

## Quantity settings

The Tremco Australia SC902 Product Data Sheet V002-070826 supplies starting
values: Part A 22.3 kg, Part B 2.7 kg; specific gravities 1.55, 0.99 and mixed
1.46; volume solids 85%; theoretical consumption 1.750 kg/m2 at 1 mm DFT.
These are editable estimating assumptions. Derived component litres, mixed
density, total kit mass, mixed kit litres and theoretical coverage are shown.

Quantity arithmetic uses the published consumption independently of volume
solids: `kg = area_m2 * DFT_microns / 1000 * consumption_kg_m2_mm`;
`mixed_litres = kg / mixed_density_kg_L`; `net_kits = kg / (PartA_kg + PartB_kg)`.
Wet-film thickness is separately `DFT / volume_solids_fraction`. This avoids
silently replacing the published consumption with the slightly different
value implied by wet density and volume solids. Nominal component volumes
and mixed volume are independent derived estimates, not forced to agree.

Waste starts at zero and can be edited. Whole kits are rounded up once after
pooling all complete rows and applying waste. Whole-kit totals are not the sum
of separately rounded schedule lines. Incomplete or unavailable rows withhold
the complete product order, while explicitly available partial quantities are
retained. Mesh, primers, topcoats and application equipment are not included.
Changing these settings cannot change assessed DFT. Actual product mixing
must follow the manufacturer's full-pack instructions.

## Evidence and preservation

The reviewed table matrix is a separate private artifact in the calculator
evidence directory, following the existing Monokote and Perlifoc contract.
Every request reads and validates a bounded snapshot before cache selection.
Dataset, source identity, table axes and source hash are checked; changed or
missing evidence withholds results. The complete report and matrix are not
included in the public source distribution. Desktop deliverables require all
three reviewed calculator evidence artifacts.

The importer independently compares text-position and coordinate extraction
for every table cell before writing an exclusive, deterministic private
dataset. It preserves source pages and table identities, split-page tables,
family-specific axes and report nulls. It never calculates replacement DFT.

Old three-calculator project files load with an empty new calculator without
writing the database or replacing saved prices. New exports include the new
calculator. Source input identities for existing calculators do not change.
An older browser cannot silently erase a saved SC902 calculator when saving
a newer project.

Spray and intumescent schedule basis notes use a single-line preview with a
keyboard-accessible Details dialog. Full provenance and review notes remain
in the API and exports. This change affects browser presentation only.
