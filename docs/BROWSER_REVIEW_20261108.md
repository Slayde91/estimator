# Browser review, 8 November 2026

## Classification

Presentation and workflow changes. Calculator formulas, assessment selection,
commercial arithmetic and XLSX evidence are not changed. The new persistent
ignore control changes which previously registered project sources are read;
issued document history is retained and the ignore can be undone.

## Requested behavior

- Comments 1–3, 6–8: portrait schedules/product summaries, scope introduction
  sharing its first schedule, and omission of calculation-note/status-basis
  columns and coverage-count prose from newly generated PDFs. Historical
  immutable PDF revisions retain their original bytes.
- Comments 4, 25–27: paired work-order dates and quote identity/contact fields.
- Comments 5, 11, 24: board menus below the header, label/value card columns,
  and red rate-grid lines.
- Comment 9: registered deleted project sources can be ignored using metadata
  only, before source-file reads or pending publication recovery. Unrelated
  unavailable-source warnings remain visible.
- Comments 10, 21–23: remove the scope-preamble editor; retain legacy stored
  values; new Allowances default to N / A; Allowances and Terms start collapsed.
- Comments 12–15: project identity fields on Projects, area/notes on Estimates,
  smaller centred plus, removal of redundant Status menu, Quote PDF icon.
- Comment 16: deterministic smoke intervals of 7, 8, 9 and 10 eligible pointer
  clicks; main-section controls silent; header and Takeoffs feedback retained.
- Comment 17: main Save persists cover-sheet drafts after the project write.
  Partial success is reported explicitly; lost replies retry identical payloads
  and versions. Leaving with cover drafts offers Cancel/Yes discard review.
- Comments 18–20: responsive 350px-wide, 40px-tall Contacts tabs and header
  subpages; converted leads open their saved estimate, with existing dirty
  project replacement review preserved.

## Verification

Targeted PDF, API, persistence and UI regressions cover the requested changes,
including long-row portrait pagination, partial saves, conflicts and retries.
PDF QA rendered 11 representative reports across 18 pages and checked margins,
table legibility, omissions and orientation. Browser checks exercise real
cover-sheet main Save/discard, exact smoke intervals, contact conversion,
project controls, commercial ownership and exports, and responsive layouts.

The runtime candidate is based on the existing local application revision so
its report-link and incomplete-quantity improvements are retained. Activation
evidence and SQLite backups are kept outside the repository under
`C:/ESTIMATOR/audits/browser-review-20261108/`.
