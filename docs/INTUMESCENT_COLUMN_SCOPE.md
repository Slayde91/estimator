# Three-sided I/H columns

The schedule includes **I/H column - 3 sides** as the distinct case `R3C`.
Following the user's explicit estimating instruction, this case uses each
product's **four-sided I/H column table for DFT**, while **three-sided exposed
perimeter and area determine coating quantities**. Its status is
**ESTIMATE - FOUR-SIDED COLUMN TABLE**. The source continues to identify the
actual report, four-sided column table, selected factor, temperature and period.
Its temperature choices match the four-sided column case. Existing case labels
and their mappings remain unchanged.

This is an explicit estimating policy, not a statement that the reports assess
the three-sided column configuration. The supplied evidence does not establish
one unambiguous report rule for that configuration. The application does not
use three-sided beam/slab-contact identity, a four-sided beam transfer or beam
caps for this case. Every underlying column-table hold still applies, including
missing evidence, unpublished periods/temperatures/cells and section-factor
limits. A usable table result can produce material quantities under the existing
independent product settings and quantity checks.

## Source findings

### Nullifire SC902

BRANZ **FC18580-01-01**, issued **20 March 2024**:

- Page 8, condition (b), permits applying four-sided regression to a member with
  three-sided exposure when three-sided stickability is demonstrated; the report
  cites the full-scale beam results.
- Page 8, section 3.3, describes Tables 3–10 as applying to three-sided protection,
  including beams under concrete slabs and other re-entrant structural sections.
  Tables 11–18 cover four-sided protection, including universal columns and
  four-sided beams.
- The conclusions on pages 2 and 8 specifically identify I/H beams with
  three-sided protection and I/H columns with four-sided protection. They also
  extend results to other re-entrant sections according to protected sides.

Those provisions are broader than a simple prohibition, but they do not expressly
identify a three-sided I/H column and its shielding detail. The user-selected
estimate uses Tables 11–18 and retains that distinction in its result status.

Source file: `FC18580-01-01-Nullifire-SC902-2020-REPORT-Final.pdf` (53 pages).
SHA-256: `3bf3499358d6f2e4b75a8ed1402995cba8f9f72142ee81e79ed22fc73e4a4344`.

### FIRETEX FX5090

BRANZ **FC20571/01/C1**, issued **8 April 2025**:

- The cover, page 1, broadly describes three- and four-sided exposure of I/H
  beams and columns and refers to the loading tables.
- Tables 1–11, pages 2–12, expressly apply to I/H beams with concrete slabs and
  three-sided fire exposure.
- Tables 12–22, pages 13–23, expressly apply to I/H columns with four-sided fire
  exposure. They separately permit four-sided I/H beams subject to a 5.282 mm
  protection-thickness limit.

The supplied certificate contains no loading-table transfer rule for a three-sided
I/H column. The cover's general wording does not supply that missing rule.

Source file: `FC20571-01-C1 FINAL.pdf` (41 pages).
SHA-256: `3e26ff0c292717614fa8a6b5a691913b9f6ddfd0b8f44158d174ec74219fe07a`.

### FIRETEX FX6010

BRANZ **FC21221-01-1-C1**, issued **31 October 2025**:

- The cover, page 1, broadly describes three- and four-sided exposure of I/H
  beams and columns and refers to the loading tables.
- Tables 1–9, pages 2–10, expressly apply to I/H beams with concrete slabs and
  three-sided fire exposure.
- Tables 10–19, pages 11–20, expressly apply to I/H columns with four-sided fire
  exposure. They separately permit four-sided I/H beams subject to a 5.770 mm
  protection-thickness limit.

The supplied certificate contains no loading-table transfer rule for a three-sided
I/H column. The cover's general wording does not supply that missing rule.

Source file: `FC21221-01-1-C1 - 31-10-2025.pdf` (47 pages).
SHA-256: `3b3703934511e1e30c86474fb023aee343f66a172537e9adcbcc1588cad6c5c3`.

## Geometry and persistence

For a named section, `R3C` uses the complete four-sided column section factor
for DFT. It independently uses the three-sided exposed perimeter for coating
area and quantities. Both the three-sided and four-sided geometry review flags
must be clear. Only recognised I/H families are accepted for this named case.

The schedule retains the actual three-sided section factor in input A/V (`M`),
the selected four-sided published table factor in table A/V (`N`), and the exact
R4 source in `X`. The basis note (`Y`) states the full-precision four-sided
lookup factor and three-sided coating basis. For example, retained 310UB40.4
geometry has three-sided A/V 211.95 m⁻¹ and girth 1.0908 m, but the DFT lookup
uses its four-sided A/V 244.01064356435646 m⁻¹. The next higher published row is
selected by the existing product policy. Its DFT matches the complete four-sided
column calculation; its coating area remains quantity × length × 1.0908 m.

With direct A/V or Hp/A input, the entered number is the four-sided-column DFT
lookup factor. ESA/M is converted to A/V using the selected product's steel
density, then used as that DFT factor. The application cannot infer a different
four-sided factor from a manually entered three-sided factor. Explicit girth or
area overrides affect quantities independently and do not change DFT selection.

No assessment matrix, source PDF or existing saved-project input is rewritten.
Saved `R3C` rows recalculate under this explicitly requested estimating policy.
