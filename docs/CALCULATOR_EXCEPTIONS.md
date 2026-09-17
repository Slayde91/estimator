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
- FyreWrap Internal/Both denote the manual's exhaust applications. Known lower
  ratings are raised to 120/120/120, including the old kitchen -/30/30 case.
  The retained pressurisation applications use the same displayed maximum;
  their actual external requirements remain 120/120/60 and 120/120/120.
  Generic External continues to require its selected full external FRL.
- Internal/Both exhaust uses one continuous layer plus eligible local layers.
  Stair/Other pressurisation retains two/three continuous layers. The existing
  area, overlap, local-length cap, board and angle arithmetic is unchanged.
- The current manual and assessment do not establish one universal external
  penetration rule. Those complete wrap totals remain withheld. The final wall
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

## Vermiculite commercial starting inputs

On 14 September 2026 the user authorized applying the reviewed manufacturer
evidence to the structural-steel vermiculite material defaults. This is a
commercial estimating-input exception, not a passive-fire thickness, exposure,
scope or suitability-rule change. The original workbook and compressed source
package remain unchanged, including source hash
`1ea62906d13f2f5d34bae9c6f2391e084f26da5d597c9d69b154ad99579028ad`.

The profile in `data/vermiculite_yield_defaults.json` supplies four existing
SETTINGS inputs for each of five products: bag mass, direct yield, inferred
dry-material consumption and retained basis/reference. Numeric settings remain
editable; the later user instruction makes basis text read-only. Evidence, expression
derivations and source conflicts are recorded in
[VERMICULITE_YIELD_REVIEW.md](VERMICULITE_YIELD_REVIEW.md).

| Product | Bag mass (kg) | Selected direct yield (m³/bag) | Existing SETTINGS inputs |
| --- | ---: | --- | --- |
| CAFCO 300 | 20 | `20 / 1000 × 217 × 0.015` | D36, D37, D38, D42 |
| MANDOLITE CP2 | 20 | `20 × 172 × 0.015 / 1000` | D69, D70, D71, D75 |
| FENDOLITE MII | 20 | `20 × 62 × 0.025 / 1000` | D101, D102, D103, D107 |
| PERLIFOC HP ECO+ | 17 | `17 / 350` | D178, D179, D180, D184 |
| MONOKOTE MK-6 HY | 21.8 | `27 × 0.002359737216` | D234, D235, D236, D240 |

CAFCO replaces the inherited 20/390 assumption with published Australian
theoretical coverage. MANDOLITE retains the qualified lower PDS basis despite
conflicting application-guide coverage. FENDOLITE retains theoretical metric
coverage; PERLIFOC retains the qualified batch/discontinuous theoretical basis.
MONOKOTE uses the current Australian bag mass while retaining the 27 board-foot
uninjected nozzle-yield basis. Its direct yield is not rescaled automatically
with the changed nominal bag mass. All five remain user-adjustable. No default
waste percentage is changed or inferred.

The density values are inferred bag mass divided by selected yield. They mean
dry-material consumption per cubic metre of coating, not installed/cured density
or loose-powder SDS density. Existing formulas continue to prioritize a positive
numeric direct yield. Their blank, invalid and zero handling and separate waste
application are preserved. An explicit fixed direct-yield override replaces any
source formula in that input and does not change when bag mass alone is edited.

Application boundary:

- An absent saved calculator row receives the twenty-field profile as returned
  starting inputs. Reading it does not write a database row.
- Existing saves retain exact stored inputs, including deliberately empty
  overlays. No migration, eager rewrite or silent adoption occurs.
- Reset calculator defaults copies the profile into the draft and restores
  source example rows. Save calculator is required to persist that action.
  The later presentation request removes the separate reviewed-yield action and
  review panel; it does not remove the profile or silently change saved inputs.
- The source model, normalizer, engine factory and report projection do not
  inject reviewed values. Explicit empty calculation inputs still reproduce
  the original workbook defaults. Numeric precision is retained throughout.

## Later presentation and read-only basis instruction

The later 14 September 2026 instruction supersedes the earlier editable-basis
UI. D42, D75, D107, D184 and D240 are displayed read-only. HTTP and storage-save
validation rejects arbitrary new basis edits while retaining exact existing
saved overrides and accepting original-source or reviewed-default text for
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

The original native Excel fixtures remain unchanged. Validate this profile
through its explicit expressions, the unchanged formula precedence, saved-state
isolation, draft actions and resulting quantities. This exception record does
not claim current complete-suite, CI or publication success.
