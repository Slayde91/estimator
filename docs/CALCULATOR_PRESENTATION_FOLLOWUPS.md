# Calculator navigation and schedule presentation

Factor Calcs is available under Calculators → Steel, including the Steel landing
page. Its transient route, `steel_factors`, uses the existing
`steel_vermiculite` calculator entry and `SETTINGS` sheet. It creates no new
calculator API, project key or input sheet. The previous spray page, helper
selection, cached scroll position and precise draft values survive navigation.
An unfinished invalid helper number must be corrected before changing between
the helper and normal spray pages.

The browser omits START for spray and board only. Spray SETTINGS hides displayed
rows 10, 11, 12, 15 and 27, while all retained settings values, source formulas,
API fields and exports remain available. The Factor page shows the factor helper
and HOLLOW SECTIONS; the separate Fendolite castellated helper panel is omitted.
The main Fendolite calculator and its lower-web input remain unchanged.

Schedule columns use compact widths by field role, wrapped headings and text,
44-pixel input targets, and horizontal scrolling rather than clipping controls.
Virtual schedules retain their 96-pixel row model. Firestopping schedules use a
fixed compact layout with wrapped labels and usable quantity controls.

The four workbook schedules add a virtual Report column from each response
row's `report_references`. It precedes the first basis/status/source/note output,
or the Actions column when none exists. It has no workbook address or editable
value. The shared reference renderer links approved public report URLs and shows
private captions as text. Recalculation refreshes references without editing
source cells; blank references produce a blank cell. Header, body, column widths
and virtual spacer spans include this display column.

The Columns control at the right of each register toolbar lists the supported
native schedule columns plus its existing Line, Report and Actions projections.
Every choice starts checked. This supersedes earlier schedule-only omissions,
including board waste and the four board calculation outputs; other worksheet
presentation rules remain in place. Internal lookup/validation/quantity helpers
and a second copy of the Line identity are excluded by the server's explicit
`register_columns` list. Detailed source-provenance fields remain distinct from
the virtual Report document caption.

Visibility is a local browser preference under
`ceasefire.scheduleColumns.v1.<calculator>:<sheet>`. Only hidden stable column
IDs are stored, so new columns start visible. Invalid or unavailable storage
leaves all columns visible. Both Firestopping schedule views share one preference.
The control changes existing table cells, widths and virtual spacer spans without
changing calculation inputs, project state, source cells, exports or making a
calculation request. Select all restores the complete register. Report cells and
basis buttons use red backgrounds with white text on hover and keyboard focus.
