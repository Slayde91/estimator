# Approved calculator exceptions

## FyreWrap application FRLs and closed schedule choices

On 17 September 2026 the user authorized reconciling the ductwork dropdowns,
reviewing FyreWrap layer quantities against the manual, and updating outputs.
The user then explicitly selected the highest application FRL while preserving
each fire direction's actual requirement. This is a calculation-policy change,
separate from the earlier presentation and fixing-text changes.

The source workbook, compressed catalogs, native Excel captures and generic
Excel evaluator remain unchanged. `ductwork_policy.py` supplies canonical input
aliases and runtime-only validation metadata; `ductwork_rules.py` supplies named
formula overrides through the existing application boundary. Their source hash
continues to identify the original workbook, not equivalence to its old rules.

- Numeric FRLs become full FRLs. The two removed 120-minute partial FRLs become
  the displayed `120/120/120` application rating. Higher/unknown ratings are not
  reduced or silently discarded.
- Kitchen inside/outside, diesel and other exhaust map to Internal. Combined
  kitchen/smoke, smoke and stair pressure relief map to Both. Mixed maps to Both
  for exposure and orientation. Stair/Other pressurisation remain separate.
- FyreWrap Internal/External/Both denote the manual's exhaust applications. Known lower
  ratings are raised to 120/120/120, including the old kitchen -/30/30 case.
  The retained pressurisation applications use the same displayed maximum;
  their actual external requirements remain 120/120/60 and 120/120/120.
  External means the external exposure of an exhaust system, with actual
  external 120/120/-; its displayed application maximum does not request full
  external insulation. On 18 September 2026 the user rejected the previous
  generic-full-FRL interpretation of External and confirmed that continuous
  layers two and three belong only to the named pressurisation applications.
- Internal/External/Both exhaust uses one continuous layer plus eligible local layers.
  Stair/Other pressurisation retains two/three continuous layers. The existing
  layer and local-length arithmetic remains. Product Settings now exposes
  blanket thickness B96, roll length B98, required overlap B99 and added waste
  fraction B111 as editable estimates. The quantity guard accepts positive
  thickness/length, nonnegative waste and overlap shorter than both roll
  dimensions. Waste multiplies total wrap area once, so rolls follow from that
  area divided by B97×B98; zero reproduces the source workbook. Board and angle
  arithmetic is unchanged. A modified blanket or overlap is flagged in the
  estimate note for matching-detail review.
- The current manual and assessment do not establish one universal multilayer
  pressurisation penetration rule. Those complete wrap totals remain withheld.
  The one-layer External exhaust application uses the p8 local-layer footnote,
  with the same eligible wall/floor tables as Internal/Both. The final wall
  band above 2400mm in both dimensions is now also withheld because the manual
  and detailed assessment disagree at its upper end.
- The four duct schedule dropdowns have closed lists. Unknown historic values
  remain visible for correction, with no custom editor and no complete wrap
  quantity. Other calculators retain their original dropdown behavior.

Normalization applies consistently to calculation, imports, project load/save
and output generation. It does not rewrite an original project file or database
record merely by reading it. Saving reconciles the draft explicitly. Notes in
the application and exports retain the directional ratings and limitations.
Historical projects are recalculated under this approved application policy;
this is not a claim that changed FyreWrap cases reproduce the old workbook.

The detailed evidence and independent takeoffs are recorded in
[FYREWRAP_RULE_REVIEW.md](FYREWRAP_RULE_REVIEW.md). Original native parity remains
tested separately, and new hand-derived cases test the intentional exceptions.

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

## Steel-spray commercial starting inputs

On 25 September 2026 the user selected a new startup profile for unsaved
steel-spray estimates. Direct yield is blank for every product; the existing
formula therefore uses bag mass divided by estimating consumption density.
The values below are commercial estimating inputs, not published installed
coating densities or confirmed site yields. The historical 14 September yield
review and native Excel captures remain in
[VERMICULITE_YIELD_REVIEW.md](VERMICULITE_YIELD_REVIEW.md); they are not a
numeric oracle for this new profile.

| Product | Bag mass (kg) | Estimating density (kg/m³) | SETTINGS inputs |
| --- | ---: | ---: | --- |
| CAFCO 300 | 20 | 308 | D36–D38 |
| MANDOLITE CP2 | 20 | 388 | D69–D71 |
| FENDOLITE MII | 20 | 645 | D101–D103 |
| PERLIFOC HP ECO+ | 17 | 410 | D178–D180 |
| MONOKOTE MK-6 HY | 21.8 | 344 | D234–D236 |
| MONOKOTE Z106 | 22.2 | 325 | D561–D563 |

Z106 is an application-only extension: it uses the MK-6 HY technical lookup
and case limits, with separate yield and waste inputs for bag quantities.
The [open-section FAR4853](https://docadmin.tfire.com.au/exfiles/FAR4853%20ISSUE%203%20MONOKOTE%20MK6%20Z106%20REPORT%20FINAL%20-%20Jan%202021.pdf)
and [hollow-section FAR4856](https://tfire.com.au/documents/Internal-Fire-Hollow-Steel-Sections-FAR4856)
name both products for their respective tables. Z106's 22.2 kg bag mass is
corroborated by [GCP product data](https://gcpat.com.au/en-gb/solutions/products/monokote-fireproofing/monokote-z-106hy);
325 kg/m³ is the user's estimating consumption assumption, not GCP's installed
dry-density specification. Actual yield must be checked for each job.

The packaged source workbook, its formulas and source hash
`1ea62906d13f2f5d34bae9c6f2391e084f26da5d597c9d69b154ad99579028ad`
remain unchanged. Older saved projects keep their exact five-product settings.
Missing Z106 settings fall back to its new runtime defaults without rewriting
the saved file. Reset Calc applies the startup profile and a blank schedule to
the draft; Save or Save As is required to persist that draft.

## Later presentation and read-only basis instruction

The later 14 September 2026 instruction supersedes the earlier editable-basis
UI. D42, D75, D107, D184 and D240 are displayed read-only. HTTP and storage-save
validation rejects arbitrary new basis edits while retaining exact existing
saved overrides and accepting original-source or current-default text for
Reset. Historical evidence remains supported by the low-level evaluator; no
stored record is rewritten simply because it predates this restriction.

The separate reviewed-yield action/panel and requested Settings date/source-ID/
document-name metadata are omitted from the browser. Source evidence, URLs,
hashes and review dates remain in developer documentation and retained data.
Vermiculite SCHEDULE V/W/X and top labels at rows 1/2/3/8, and the CALCULATOR third
notes section at rows 33–41 and comparison narrative J28:N30, are presentation
omissions only. W still gates incomplete bag
orders. BAGS width and the two populated/blank output highlight states change
layout only; numeric zero is populated. Source graphs, saved calculation values,
pooled ordering rules and existing PDF contents are unchanged by this request.

The original native Excel fixtures remain unchanged. Validate the new profile
through its explicit values, the unchanged formula precedence, saved-state
isolation, draft actions and resulting quantities. This exception record does
not claim current complete-suite, CI or publication success.
