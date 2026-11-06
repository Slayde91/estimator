# Commercial documents, Scheduler location history and SWMS

## Scope and classification

This change implements the 6 November 2026 annotated review of CLASSIFIRE. It extends the existing project workspace and document services. It does not change passive-fire calculation or pay-rate rules.

Risk classification: **high** for location privacy, account/session handling, portable document ownership and commercial numbering; **medium** for authored PDF output and SWMS editing; **low** for layout, colours and wording. High-risk paths require negative tests for permissions, stale state, replay, concurrent creation and project identity.

## Commercial references and saved projects

New Work Orders require an issued Quote and a project number. On the first successful Save, the server assigns `[Project No.]-[issued Quote No.]-01`, increasing the final number for that project and issued Quote. Opening or cancelling a form consumes no number. The database transaction serialises concurrent creation, and exact retries return the original reference. The project number, issued Quote and generated reference are frozen after creation.

A later Quote download creates a new Quote number; existing Work Orders keep their original reference. The portable project retains reference counters, including numbers consumed by deleted Work Orders. Purchase Orders select a Work Order and display its server-derived reference. Only Purchase Orders omit the Client, Client contact, Client email and Client phone inputs, as confirmed by the user.

Create WO and Create PO use the current estimate's project details, scope description and amount. A unique matching issued Quote or Work Order is selected automatically; multiple choices remain explicit. Existing documents remain readable. The internal legacy WO export sequence is retained separately from its visible project/Quote reference.

SWMS drafts are project-owned, bounded snapshots under `swms`. They require the same explicit project identity as certifications and document history. An older client cannot overwrite a project while omitting its SWMS. Downloads retain immutable receipts and are included in the existing Documentation history and post-download project save flow.

## PDF presentation

The Quote has QUOTATION centred in its first-page header, bold project labels without a Field/Details row, black gridlines, red/white table headers and totals immediately after the summary. The assembled PDF owns one Page X of Y sequence. Embedded schedules omit their standalone title, repeated project details and quantity-status introduction.

Quote schedules use A4 portrait with all columns in the same table. Text wraps at a fixed minimum 6.8 pt size; rows and long cells continue vertically. Diagrams and report links remain available. Standalone schedule exports retain their existing presentation.

## Scheduler location collection

Clock-in requires a fresh browser location fix. Tracking is visible while clocked in, resumes after reload and requests a fresh fix at least every 30 minutes while the browser is running. Permission or network failures are visible. No location is invented for time when the application was closed, the device slept or the browser suspended execution. Clock-out stops collection.

Members access their own history; administrators can review team entries. An authenticated location heartbeat renews only the existing session during an active shift. An inactive session still expires. Location history records timestamped pins, accuracy and gaps, with a map and timeline.

The street map requests only visible viewport tiles from OpenStreetMap via a fixed-host authenticated local adapter. Tile coordinates reveal the displayed map area to the provider; worker identities, timestamps and account credentials are not sent. The adapter has bounded coordinates, timeouts, response size, cache size and request rate, rejects redirects, retains attribution and caches tiles for seven days. Offline maps retain the coordinate history. Tests use mocked imagery and synthetic positions, never live staff coordinates.

## SWMS template provenance

The editor follows the supplied Dashpivot template CF-RAS-009 (visible template history v96) and `SAFE-WORK-METHOD-STATEMENT.pdf`. The live preview was inspected without saving changes to Dashpivot. It supplies two Activity choices and three independently selectable work types: Protective Coatings, Passive Firestopping and Installation of Passive Fire Protection Works, plus additional steps, high-risk work selections, signoffs, reviews and attachments.

The supplied PDF determines the landscape page layout, risk matrix, tables and emergency sections. Template wording and risk values are editable. Historical people's names and signatures are cleared in new forms. Drawn signatures record user input; the application does not claim a Sitemate ID scanning integration or automatically approve the safety content.

## Validation

Focused suites cover company persistence, project round trips and omitted-data protection, commercial reference concurrency/replay, PDF layout and page numbering, Scheduler permission/heartbeat/map boundaries and SWMS validation/export. Disposable browser tests exercise document editing, linking, menu layout, estimate shortcuts, Scheduler locations and SWMS lifecycle. A 1,000-row Quote export is checked for retained rows, portrait column fit and one page-number sequence. CI additionally runs the full Python, browser and Windows packaging checks.

The running local application has separate, pre-existing custom changes. Activation must integrate the release commits onto the existing runtime branch, preserve project files and databases, and verify the resulting live build rather than reset it to main.
