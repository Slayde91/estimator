# Session handoff

## Duct clearance column display — 2026-09-14

Started from clean merged main `f60ef4f` (PR #6), with the same tree as the
previous tested feature head. Created `fix/duct-clearance-column` without
discarding local changes. The user requested removal of the Ductwork CALCULATOR
**Penetration clearance guide** column if safe.

Only browser omission metadata changes: AK (37) disappears in normal and advanced
views. The 300 AK formulas, settings, full worksheet response and PDF projection
are retained. No dependencies on AK were found across the 24,059 source formulas.
MONOKOTE and FyreWrap clearance tables and CAFCO approved-detail guidance remain
in Product Settings. Adjacent AL fixing and AM support guidance stay visible.

Verified: the existing metadata regression and both duct native Excel regression
tests passed (3 tests, 18.770 seconds). All 53 calculator UI checks, JS syntax and
the build passed. A before/after comparison found all 27,900 complete-page cell
values, edit flags and formula flags identical. Browser checks confirmed all
300 rows and the final input remain, AK is absent in both views, and all AL/AM
guide cells remain; browser error logs were empty.

The local server was refreshed and its complete-page comparison also passed.
A backup/check confirmed the two saved quotes and all pricing/calculator records
are unchanged. The user's open tab was retained. Local QA, backup and comparison
artifacts are ignored under `.runtime/duct-clearance-qa`; `dist/` remains ignored.
Publication and merge evidence is retained in the associated GitHub PR and its
local receipt. No architecture, schema, pricing or technical rule changes.

## Historical: calculator display cleanup and locked references — 2026-09-14

Starting state: clean `feat/workbook-calculators` at `7cf8ca0`, matching its
fetched upstream (0/0 divergence); fetched main remains `615997c`. This increment
implements the user's display removals and latest explicit requirement that
Material basis/reference be read-only. It does not revise the yield profile.

Removed the reviewed-default button/evidence panel and the five products'
date, source-ID and document-name rows from Settings. All three Settings banners
read **Product Settings and Rules**. Vermiculite SCHEDULE hides the requested
top instructions and V/W/X columns, retaining all 1,000 inputs, the three summary
cards and pooled product quantities. Section 03 retains the period comparison
and removes its adjacent and trailing notes. BAGS uses nine real table columns
and proportional form widths; no desktop horizontal overflow remains at 1280px.

The five references are readonly in both worksheet projections and user-facing
HTTP/save validation. Existing saved reference text, including valid historical
multiline/blank values, remains recoverable. Known source/reviewed defaults are
accepted for Reset. Numeric settings remain editable at full precision. There
is no saved-state migration, schema change or alteration to source workbooks,
packaged formulas, native fixtures, default quantities or PDF projection.

Every data output uses the same populated fill (`#fff0ce`) or empty fill
(`#f2f3f5`), including zero, text, errors and non-formula blank table cells.
Structural headings and navigation remain distinct. Browser review caught an
inferred heading on the calculated source label and unclassified blank summary
cells; both were corrected and covered by regression tests.

Verified in this increment:
- All **198 Python tests passed in 478.142 seconds**, with no skips. This includes
  source reconstruction from the actual supplied workbooks, 419,905 original
  native calculator comparisons, 32,616 original Quote comparisons, and the
  reviewed-yield native scenarios/profile checks.
- Nine new cleanup tests cover 50 rejected reference-edit requests without
  database writes, saved-reference recovery/import/report/save, numeric precision,
  known resets, version guards and retained W/Y incomplete-order dependencies.
- JavaScript syntax, **53 calculator UI checks and 17 existing UI checks** pass.
- Browser review covered all twelve pages. Every observed populated data output
  uses `rgb(255, 240, 206)` and every empty data output `rgb(242, 243, 245)`.
  All Settings banners and five locked references were checked. The schedules
  retain 1,000/300/200 rows and 40 extra-board rows. Editing direct yield to zero
  switched Yield Used to the empty fill; restoring and saving 0.0651 retained the
  populated fill and full input precision in the isolated QA state. All eight
  period columns were 132px wide. At 390px, BAGS forms fit the page and only the
  wide order table scrolls internally; the viewport override was reset. Browser
  error logs were empty.
- The 34-file source build is **5,338,995 bytes**, SHA-256
  `827b4a2d8d8e53407b9aed80d3a8fe7251cbd66adfa6f1b2590ace2c4c4d9fe5`.
  An extracted copy served all twelve complete worksheets and the three PDFs
  (3 vermiculite, 4 duct and 8 board pages) with source-workbook access blocked;
  there were no attempted workbook reads. PDF layout code is unchanged.
- The local server was refreshed using `Start-Estimator.ps1 -NoBrowser` after
  a database backup. The two saved quotes, zero pricing rows and zero calculator
  states remain identical. The quote/settings SHA-256 is still
  `c541e453134d10e4a014ac26b330745fa0113988d140c3274c57d61102902ce4`.
  The user's browser tab/draft is left open; refresh after retaining unsaved work.
- Main server PID **24820** serves the exact tested JS/CSS/HTML. Its metadata
  confirms readonly references and presentation exclusions; live default totals
  remain 172.02548458861258 net / 173 whole CAFCO bags.

The publication checkpoint is recorded below when verified.
At the starting head, PR #6 was open, unmerged, without reviews; both Checks jobs
had failed before steps with the already documented billing/spending blocker.
This is not a passing-CI claim for the current increment.

Local-change classification: intended runtime, UI, regression-test and
documentation changes only. Database backups, isolated QA state, logs and package
checks are ignored under `.runtime/calculator-cleanup-qa`; `dist/` and caches are
also ignored. No user workbook, secret or unrelated file is included.

## Historical: Australian yield review and calculator refinements — 2026-09-14

Starting state: clean `feat/workbook-calculators` at `e39f28d`, matching fetched
`origin/feat/workbook-calculators`; main remains `615997c`. This increment follows
the user's specific yield, settings, navigation, schedule-summary and PDF requests.
No unrelated local changes or user work were discarded.

The reviewed profile in `data/vermiculite_yield_defaults.json` supplies twenty
explicit SETTINGS inputs: bag mass, direct yield, equivalent dry-material
consumption and editable material reference for each of five products. CAFCO
uses Australian published coverage (65.10 L/bag); MONOKOTE uses the current
Australian 21.80 kg pack with the retained uninjected yield. MANDOLITE's conflicting
coverage, PERLIFOC's batch/continuous distinction and theoretical/site-loss limits
are documented in `docs/VERMICULITE_YIELD_REVIEW.md`. Consumption density is inferred,
not installed coating density. This authorized estimating-default exception does
not alter thickness rules, source graphs or original native fixtures.

Absent saved states receive the reviewed inputs without a database write. Existing
saves remain exact. Use reviewed yield defaults merges only those twenty fields
into the draft; Reset calculator defaults also restores source example rows. Both
require Save calculator to persist. Explicit empty calculation inputs still use
original workbook defaults. All five material references accept multiline text.

Vermiculite SCHEDULE has three top metrics and a live per-product net/whole-bag
table sourced from BAGS, preserving pooled rounding and incomplete status.
SETTINGS has eleven coloured section anchors and linked contents instead of the
old product banner. The single-member comparison uses equal independent period
columns, including 120 minutes. All source input rows remain available.

PDFs retain overview, full schedule, EXTRA BOARDS, product/ancillary summaries and
closing totals. The four requested detail/helper/settings sections are removed.
Default reports are 4 duct pages, 3 vermiculite pages and 8 board pages. All fifteen
pages were rendered and visually inspected with no text-boundary violations.

Current verification:
- Independent native Excel 16.0/build 20326 captured 6,565 selected outputs across
  five scenarios; all match. A further 863 numeric/status checks use the actual
  installed profile against those independently captured expectations.
- All 38 defaults/native/worksheet/API boundary tests passed after updating two
  original-default expectations to distinguish source inputs from app defaults.
  Both original Quote/inventory reconstruction tests passed with the actual files.
- JavaScript syntax and 48 calculator plus 17 existing UI checks passed. Independent
  review found a disabled-button state after reset; the fix is covered by reset,
  invalid-input and corrected-input regressions.
- Browser review covered all twelve pages, equal 120-minute widths, all five
  editable references, precision-preserving save/reopen, live bag totals, linked
  sections and phone containment. A real schedule PDF download confirmed the
  captured draft and retained unsaved status. No browser errors were recorded.
- The final 34-file source distribution is 5,338,548 bytes, SHA-256
  `957a64737a94fab6bda4b821b614d21e0c95b761d9af661247ae0e6116c08ef7`.
  An extracted copy served all twelve complete pages and three PDFs with original
  workbook filesystem access blocked; there were zero attempted source reads.
- The final complete suite passed all 189 tests in 508.802 seconds, with no skips.
  It includes original workbook reconstruction, all 419,905 original native
  calculator comparisons and 216 × 151 Quote comparisons, plus the new yield cases.

The main server was refreshed through Start-Estimator.ps1 and verified at
`http://127.0.0.1:8765/`, PID 11852. Served JS/CSS match the tested files. Its new
vermiculite state returns the reviewed profile and the original schedule gives
172.03 net bags / 173.00 pooled whole bags. A recovery backup preceded refresh;
the two saved quotes, zero pricing-setting rows and zero calculator-state rows
are identical afterward. Quote/settings content SHA-256 remains
`c541e453134d10e4a014ac26b330745fa0113988d140c3274c57d61102902ce4`.
The user's browser tab was preserved; refresh after retaining any unsaved draft.

All current scratch logs, source-download receipts, disposable Excel copies,
test databases, rendered PDFs and package checks are under ignored
`.runtime/yield-review`. `dist/` and caches are also ignored. New committed fixtures
are intentional native regression evidence; no source XLSX/XLSM or external PDF
is added to the runtime or repository.

Publication checkpoint: implementation `678ee3f295e8972f001e126fceaad59a6f8e8c0f`
(`Verify Australian spray yields and refine calculator reports`) was committed
and pushed to `origin/feat/workbook-calculators`; divergence was verified as 0/0.
[PR #6](https://github.com/Slayde91/estimator/pull/6) is updated, open and unmerged,
with no reviews. Its implementation-head Checks runs 34843699621 and 34843694841
both failed before any job step (`steps: []`). Both annotations explicitly cite
failed account payments or the spending limit. This is a verified account blocker,
not passing CI or a demonstrated code-test failure. No merge was attempted past
the failed checks. Resolve billing, rerun current-head CI, inspect review state
and merge only when supported. This follow-up documentation checkpoint makes no
runtime change; its own head must also be checked after push.

Local change classification: all intended source, documentation and native-fixture
changes belong to this increment and its follow-up checkpoint. Runtime databases,
backups, logs, downloaded source PDFs, disposable workbooks, QA renders, extracted
packages, caches and the built distribution remain ignored local artifacts.

## Historical: calculator presentation and full schedule PDFs — 2026-09-14

Starting state: clean feat/workbook-calculators at 4f60526, matching its fetched
upstream. PR #6 remains the existing feature PR; no user work or branches were
discarded. This increment removes row pagination, improves all twelve page
layouts, and adds a full schedule PDF for each calculator.

The complete worksheet endpoint shares typed dropdown lists and source-derived
presentation metadata. The old bounded calculate endpoint remains compatible.
The report module uses the existing workbook evaluator, fonts/logo and PDF
library. Every populated item, including incomplete/zero-input rows, is retained.
Reports distinguish published/usable thickness, board stack/total thickness,
spray area, board reference area, actual material area and pooled order quantities.
Board extras and all editable settings are included; independent vermiculite
helpers remain separate. No source formulas/packages, pricing, schema or saved
state semantics change.

Current source mapping: docs/CALCULATOR_PRESENTATION_MAPPING.md. New independent
HTTP/report regressions are in tests/test_calculator_presentation_api.py and
tests/test_calculator_report.py. Runtime screenshots, rendered PDFs, native
projection checks and test logs are ignored under
.runtime/calculator-presentation-qa.

Validation: all 176 Python tests passed in 442.513 seconds, including original
source reconstruction, all 419,905 native calculator comparisons and the old
216 × 151 Quote comparisons. After the last report layout changes, all 21
report/HTTP checks passed again in 132.865 seconds. JavaScript syntax, 39
calculator UI checks and 17 existing UI checks passed. Independent review found
and verified the fix for blank-to-populated source notes being omitted during
refresh; a separate regression protects formula-backed editable Settings values.

Desktop browser review covered every page; all prepared input rows and advanced
board fields were counted. Phone review at 390 × 844 confirmed page containment
for all three calculators and stacked single-member/bag forms with one copy of
each control. A real browser download captured an unsaved last-row duct entry;
the UI confirmed download and retained Unsaved calculator changes. No browser
errors were recorded. The temporary viewport override was reset.

The 32-file distribution built (5,332,788 bytes), and an isolated extracted copy
served all twelve complete pages and all three PDF downloads with original
workbook filesystem reads explicitly blocked. Default reports had 7 duct,
10 vermiculite and 23 board pages. A full 1,000-valid-item spray PDF retained all
1,000 detailed items across 370 pages. All 523 pages across seven representative
PDFs were rendered and checked for text bounds, layout and the official logo.

The main app was refreshed using Start-Estimator.ps1 and is running on port
8765 as process 30120. Served calculator JS/CSS match the tested files. The live
whole-sheet endpoint and source section styling were checked. A new SQLite
recovery backup preceded refresh; both quotes, the empty pricing settings and
empty calculator states remained identical. Quote/settings content SHA-256 is
c541e453134d10e4a014ac26b330745fa0113988d140c3274c57d61102902ce4.
The user's existing browser page was preserved; refresh it to load the new UI.

All changed tracked/new source files belong to this increment. Synthetic
databases, rendered reports, captures, backups and logs remain ignored in
.runtime; the distribution stays ignored in dist. Original workbooks, pricing
baseline, formula packages and the official logo bytes are unchanged.

Implementation commit 946f2c11c9670e5e107306b6ffadec1b470646e5,
“Polish calculator pages and add complete schedule PDF reports”, is pushed to
origin/feat/workbook-calculators. PR #6 was updated to “Add workbook calculators
with full schedules and PDF reports” and remains open and unmerged, with no
reviews. Both new implementation-head Checks runs failed before any job steps:
push 34833934393 / job 103943339708 and PR 34833938884 / job 103943353325.
Both annotations explicitly report failed recent account payments or a spending
limit requiring an increase. This is an external GitHub account blocker, not
passing CI or a failed application test. Resolve Billing & plans, rerun Checks
on the current PR head, then merge only when CI/review state permits. This
publication record changes documentation only; runtime validation remains valid.

## Current work — 2026-09-14

Repository: C:\ESTIMATOR\app. Branch feat/workbook-calculators starts at 01e3494120c324ccb491d92debf85359b0d06c43. Fetched origin/main: 615997c0f5dba856244421178a902e39af27a089. Starting tree was clean; previous estimate-details, pricing-library and launcher work is preserved. PR #5 is the prior publication and its Actions were blocked by account billing before job steps. Check the new PR's exact head independently before merging.

User scope: three exact workbook calculators, all visible tabs, adjustable settings, schedule XLSX templates/import, complete technical databases and Australian links. User approved correcting accidentally incremented duct fixing text from the first row; quantity formulas remain unchanged.

## Implementation

Source packages data/calculators/*.json.gz retain every literal, formula, validation, table/name, style, hidden worksheet and hash. workbook_catalog.py supplies independent catalog copies and editable allowlists. excel_engine.py parses/evaluates only the source Excel subset; cached answers and uploaded expressions never execute. workbook_calculators.py validates overlays, dependent dropdowns, pages, private sessions and the approved text exception.

schedule_workbook.py exports exact input templates and imports complete replacement schedules as drafts, preserving settings/other inputs. Store adds version-2 calculator_states, independent by calculator, with source-hash guards. Existing quote/pricing rows are unchanged. Existing loopback HTTP checks and bounded upload validation protect new definition/calculate/template/import/state routes. Only Save persists.

static/calculators.js/.css provide all 12 pages, direct row navigation, advanced columns, separate race-safe drafts, save/reset/import/export and document links. Controls display two decimals at rest and reveal exact values on focus; edits keep full precision. Numeric choices distinguish 0.005 from 0.01 when selecting. Explicit display-only source-note replacements remove redundant addresses without changing formulas, identifiers or calculated text.

No original source workbook, old Quote engine, original pricing baseline or old native fixture changed. New originals remain in the supplied OneDrive directory; runtime never requires them. New calculator quantities remain separate from priced Quote/PDF calculations because the files do not define automatic integration.

## Evidence and repeatable checks

See docs/WORKBOOK_CALCULATORS.md for mapping and coverage. Six immutable native fixtures retain actual Microsoft Excel capture bytes: all 161,566 source formulas, 300 approved text outputs and 258,039 varied outputs in 21 scenarios/3,471 schedule cases. All 419,905 comparisons passed, with zero mismatches/exceptions. Coverage includes all 1,342 board steel IDs, all 553 active vermiculite sections, 84 series and every editable setting. Strings/errors/bools compare exactly; numeric tolerance is relative 1e-12/absolute 1e-10.

Native checks resolved Excel blank-reference semantics, structured table references and nonformula OOXML whitespace. Normalized literals retain original text in source_value and honor inherited xml:space. Shared/inline/formula text is unchanged. The approved duct exception has separate original/corrected native evidence; docs/CALCULATOR_EXCEPTIONS.md records authorization and the supporting Australian M6 manual reference.

Run:

    python -m pip install -r requirements-dev.txt
    python -m unittest discover -s tests -v
    node --check static/app.js
    node --check static/calculators.js
    node tests/test_ui.cjs
    node tests/test_calculators_ui.cjs
    python scripts/build.py

Set ESTIMATOR_WORKBOOK_DIR=C:\ESTIMATOR for the old original-source checks. New source checks use ESTIMATOR_CALCULATOR_SOURCE_DIR, defaulting to the supplied OneDrive folder. Optional source reconstruction skips when originals are absent; native fixtures always run. Regeneration requires Microsoft Excel, PowerShell 7 and disposable copies. Never regenerate expected values with the application engine.

## Final verification and publication record

All 155 Python tests passed in 329.737 seconds, with original-source reconstruction enabled and all 419,905 new native Excel comparisons. The original 216 × 151 Quote comparisons also pass. JavaScript syntax checks, 17 existing UI checks, 29 calculator UI checks and diff whitespace checks pass. Review found and fixed a wildcard lookup performance defect: hostile input previously exceeded eight seconds; the bounded matcher returned the same result in 0.032 seconds. Focused engine and real HTTP regressions protect it.

The 31-file distribution built successfully and passed an isolated extracted-package smoke test with source-workbook filesystem access denied. All 12 page definitions/calculations, native default samples, three template/import/save/reopen paths and exact raw decimal preservation passed. Original quote/PDF/pricing checks passed, including a six-page branded material/labour report and exact-cell pricing roundtrip. No source workbook access occurred. Current/extracted engine and calculator UI hashes match.

Desktop browser checks confirmed numeric replacement, exact focus values, save/reload, small decimal dropdown choices and proportional worksheet widths. The 390 × 844 Chrome browser check passed all three sections without page overflow or JavaScript errors. It downloaded a template, uploaded a schedule, verified draft-only import, saved it and verified the exact imported decimal. Template input columns and Instructions were independently rendered and visually checked for all three formats.

The main app was refreshed through the Windows PowerShell launcher and is running on port 8765 (verified process 31908). A recovery backup was created before the additive version-2 migration. Both saved quote rows and the empty pricing settings table stayed identical; their before/after content SHA-256 is c541e453134d10e4a014ac26b330745fa0113988d140c3274c57d61102902ce4. New calculator_states is empty in the main database; synthetic test saves were confined to isolated databases.

Implementation commit 1bd8f9019ae2821111222b4b76bd173d812c16bb (Add native-validated ductwork and structural steel calculators) was committed and pushed to origin/feat/workbook-calculators. PR #6 targets main: https://github.com/Slayde91/estimator/pull/6. It includes the prior unmerged work from #3, #4 and #5. Those branches/PRs were preserved.

Both implementation-head Checks runs failed before executing any job step: push run 34762251562 and pull-request run 34762265325. GitHub's annotation says recent account payments failed or the spending limit needs to be increased. This is an external CI account blocker, not a failed application test, and is not CI success. PR #6 is open with no reviews and has not merged. Resolve GitHub Billing & plans, rerun Checks on the current PR head, then merge only after successful checks. The documentation-only publication record does not change the validated runtime files.

## Operation and local classification

Double-click Start-Estimator.cmd or run python -m estimator. The normal server uses port 8765 and .runtime/estimator.sqlite3. Stop it before file backups. No Windows login task or public deployment is installed. Existing quote PDFs retain the unchanged official logo and saved results.

All current implementation/documentation changes belong to this feature. Synthetic databases, native capture copies/results, template renders, logs, process snapshots and caches remain ignored under .runtime; distribution ZIPs remain ignored under dist. Original workbooks and external logo remain outside the repository. Do not stage runtime data, delete branches or discard unknown changes appearing after this baseline.
