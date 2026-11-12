# Commercial documents, Scheduler location history and SWMS

## Scope and classification

CLASSIFIRE manages commercial documents across saved projects, records shifts in the organisation’s time zone and issues project-owned SWMS revisions.

Risk classification: **high** for location privacy, account/session handling, portable document ownership and commercial numbering; **medium** for authored PDF output and SWMS editing; **low** for layout, colours and wording. High-risk paths require negative tests for permissions, stale state, replay, concurrent creation and project identity.

## Commercial references and saved projects

Work Orders can be saved and downloaded as PDFs while fields and signatures are incomplete. The first save assigns an organisation-wide Work Order number. An issued Quote can be linked then or later. Linking supplies the Quote's GST-inclusive grand total when the estimated cost is blank. Purchase Orders have their own numbers and retain their Work Order links. The default series start at **WO-01** and **PO-01**. Retries keep their original numbers. New Quote downloads advance the Quote series.

**Settings → Project Details** sets the prefix and starting number for each series. Existing orders can be renumbered in their source files. The migration checks the source revision before writing and keeps historical issued PDFs available under their original numbers. SWMS and Certification references remain attached to the same document across revisions.

Choose **Create WO** on a Quote card. In the Work Order editor, Notes saves an individual note, Files holds the Work Order attachments, and the related document panels open the linked Quote and Purchase Orders. PDF and image attachments appear as appendix pages. Other file types, including videos, are embedded as original files in the downloaded PDF. Each Work Order supports up to 16 files, 12 MiB per file and 32 MiB altogether.

SWMS drafts are project-owned, bounded snapshots under `swms`. They require the same explicit project identity as certifications and document history. An older client cannot overwrite a project while omitting its SWMS. Downloads retain immutable receipts and are included in the existing Documentation history and post-download project save flow.

## PDF presentation

The Quote has QUOTATION centred in its first-page header, bold project labels without a Field/Details row, black gridlines, red/white table headers and totals immediately after the summary. The assembled PDF owns one Page X of Y sequence. Embedded schedules omit their standalone title, repeated project details and quantity-status introduction.

Quote schedules use A4 portrait with all columns in the same table. Text wraps at a fixed minimum 6.8 pt size; rows and long cells continue vertically. Diagrams and report links remain available. Standalone schedule exports retain their existing presentation.

## Scheduler location collection

Clock-in requires a fresh browser location fix. Tracking is visible while clocked in, resumes after reload and requests a fresh fix at least every 30 minutes while the browser is running. Permission or network failures are visible. No location is invented for time when the application was closed, the device slept or the browser suspended execution. Clock-out stops collection.

Clock actions retain the account and sign-in generation that initiated them. Changing accounts cancels a pending clock action; its later location or HTTP response cannot update the new account's tracking, close its dialog or clear its in-progress save state.

Members access their own history; administrators can review team entries. An authenticated location heartbeat renews only the existing session during an active shift. An inactive session still expires. Location history records timestamped pins, accuracy and gaps, with a map and timeline.

The street map requests only visible viewport tiles from OpenStreetMap via a fixed-host authenticated local adapter. Tile coordinates reveal the displayed map area to the provider; worker identities, timestamps and account credentials are not sent. The adapter has bounded coordinates, timeouts, response size, cache size and request rate, rejects redirects, retains attribution and caches tiles for seven days. Offline maps retain the coordinate history. Tests use mocked imagery and synthetic positions, never live staff coordinates.

## SWMS template provenance

The editor follows the supplied Dashpivot template CF-RAS-009 (visible template history v96) and `SAFE-WORK-METHOD-STATEMENT.pdf`. The live preview was inspected without saving changes to Dashpivot. It supplies two Activity choices and three independently selectable work types: Protective Coatings, Passive Firestopping and Installation of Passive Fire Protection Works, plus additional steps, high-risk work selections, signoffs, reviews and attachments.

The supplied PDF determines the landscape page layout, risk matrix, tables and emergency sections. Template wording and risk values are editable. Reviewer and consultation defaults carry forward to new forms. **Settings → Personal Details** stores the current user’s signature for insertion in SWMS, Certification, Takeoffs and Work Orders. Selecting an existing SWMS signature opens the chooser for replacement.

## Validation

Focused suites cover company persistence, project round trips and omitted-data protection, commercial reference concurrency/replay, PDF layout and page numbering, Scheduler permission/heartbeat/map boundaries and SWMS validation/export. Disposable browser tests exercise document editing, linking, menu layout, estimate shortcuts, Scheduler locations and SWMS lifecycle. A 1,000-row Quote export is checked for retained rows, portrait column fit and one page-number sequence. CI additionally runs the full Python, browser and Windows packaging checks.

The running local application has separate, pre-existing custom changes. Activation must integrate the release commits onto the existing runtime branch, preserve project files and databases, and verify the resulting live build rather than reset it to main.
