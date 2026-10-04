# Header navigation and workspace controls

Calculators, Libraries and Takeoffs use header disclosures. Hover, focus or tap
opens a disclosure; arrow keys and Home/End move between its buttons, and Escape
returns to the section button. Opening one disclosure closes the others. The
selected calculator, library and takeoff workspace remain explicit.

Libraries contains Pricing Library, Firestopping Library and Technical Library.
Takeoffs contains Steel, Duct, Penetrations, Walls and Slabs, with Defect Reports
and Service Plans grouped beneath Penetrations. These choices use the existing
pricing confirmation and takeoff edit-flush guards. A refused or cancelled
takeoff switch leaves the current workspace and its records intact.

The outer Calculators, Libraries and Takeoffs headings and their old chooser
cards/tabs are removed. Each actual calculator, library and register retains its
own title. Workbook schedule import/export controls share the calculator header
with template export, reset and recalculate. Each takeoff marked-drawing PDF
control follows the XLSX control in the applicable register, including both
unapproved physical-draft workspaces.

The draft XLSX download also moves into the regular register and still includes
all current records of its takeoff type, independently of confirmed-item exports.

Save, Save As and Project files are global header actions. New and Load appear
beside Link Project Folder and Refresh on Projects, with matching control height.
Project metadata remains on Projects. The same unique element IDs and event
handlers retain capability-bound saves, attachment validation, drop handling,
busy states, failure messages and exact project snapshots.

This is a presentation and navigation change. It does not alter workbook data,
calculator formulas, report generation, pricing scopes, persisted schemas,
physical identities or fire-system authority. Existing browser journeys select
workspaces through the real disclosures. `npm run test:header-controls` covers
five viewport widths, global actions, calculator toolbar placement, register PDF
placement, keyboard/touch navigation, draft retention and pricing cancellation.
