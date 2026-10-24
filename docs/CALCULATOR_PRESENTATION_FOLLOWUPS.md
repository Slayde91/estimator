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
