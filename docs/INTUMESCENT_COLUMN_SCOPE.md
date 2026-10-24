# Three-sided I/H columns

The schedule includes **I/H column - 3 sides** as the distinct case `R3C`.
The application retains the selected case and can calculate its section factor,
girth and area, but displays **CONFIRM ASSESSMENT** and withholds DFT, coating
quantities and complete orders for all three current products. It supplies no
temperature choices from another member case. Existing saved case labels and
their mappings remain unchanged.

This is a deliberate assessment hold. The supplied evidence does not establish
one unambiguous table-selection rule for this column case. A three-sided column
must not silently become a three-sided beam with slab contact or a four-sided
column. Enabling DFT requires a reviewed product-specific assessment rule and
the associated protection/shielding conditions.

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
identify a three-sided I/H column and its shielding detail. The application does
not resolve that ambiguity by assigning `R3C` to either published table family.

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

`R3C` uses the retained three-sided section factor, exposed perimeter and geometry
review flag. This is geometry only and does not grant a product/table approval.
Direct A/V, Hp/A and ESA/M inputs likewise do not release DFT. No assessment
matrix, source PDF or existing saved-project input is rewritten by this change.
