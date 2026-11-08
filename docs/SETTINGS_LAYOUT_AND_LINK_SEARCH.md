# Settings layout and linked-record search

Settings uses one scoped label column and one control column. The label column is
240px; controls are capped at 720px. Below 600px, labels stack above controls. The
numbering table retains its semantic column headers and scrolls within its own
container on narrow screens. These rules do not change forms in other app pages.

Time zone lives in Company Details and retains its separate save action. Its
team-wide overtime/penalty explanation appears as a dismissible notification only
after the organization save succeeds. A failed later Scheduler refresh cannot
turn that confirmed save into a false failure. The language helper is removed;
company-logo preview appears below its file upload.

Estimate creation and inline Account creation use the same plain plus glyph and
30px hit target. The glyph remains centred at the leading edge of each control.
Project pane toggles are RGB(208, 0, 27) when closed and #ffdd53 when open. Contacts
tabs use #0c0b0e through a scoped selector that overrides the shared theme surface.

Account forms show only selected linked records. A search popup contains matching
existing records and native checkboxes. Filtering does not remove selections;
linked records remain visible independently of the query. Automatic associations,
unavailable saved links, atomic directory saves and version conflict checks remain
in force. User-entered record names are not translated.

Desktop packages explicitly include the project pane script and Settings layout
stylesheet. Browser theme checks exercise the visible Project pane rather than
the hidden active-workspace controls.

These changes affect presentation, relationship selection and future reference
formatting. They do not change passive-fire calculations or pricing rules.
