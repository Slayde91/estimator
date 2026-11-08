# Project document creation and linking

A saved or natively loaded Project is required before creating a Quote, Work
Order, Purchase Order, SWMS or Certificate. A fresh workspace, a typed Project
number and a browser import do not grant that permission. Successful native
Load/Save/Save As grants a server-only capability to the exact document workspace
after the verified Project file has an assigned number. The permission is not
portable JSON and is not inferred from editable document fields. The interface
notifies the user; it does not save or create a Project automatically.
A document opened from a verified native Project file can draft a PO for that
same owner without replacing the globally active Project. Unfiled legacy records
do not acquire this permission merely by being opened.

The server protects new record creation before allocating document references.
Existing documents, immutable revisions and legacy imported history remain
readable/editable. Users save an imported Project before adding new documents.
An exact replay of an already completed creation remains recoverable.

Create PO on a clean saved Work Order prepares an unsaved linked Purchase Order.
The server checks the Work Order identity, version and workspace. Project/contact
and delivery information are copied; relevant line descriptions and quantities
remain editable, while supplier prices start at zero. Customer prices and Work
Order estimated cost are not procurement prices. Supplier/payment/requestor
fields remain blank. No source save, issue, PO number or PO record occurs until
the user explicitly saves. A new or edited Work Order prompts for Save first.

Purchase Order Request summary appears immediately after Purchase order
information. Type of expense offers Labour, Materials, Services and Other.
Untouched legacy custom values remain available on existing records; new or
changed values use the supported choices.

Estimate linking separates trusted price/source derivation from optional schedule
presentation. The read-only derive action accepts `include_scope_tables:false`
and returns pending preview descriptors without evaluating full calculator
reports. Its prices, validation and canonical source hashes are unchanged.
Opening a schedule evaluates the original full projection for that exact captured
estimate. Preview/full results and in-flight work are confined to the editor and
exact input fingerprint, with failure retry and stale-context guards. Only missing
workspaces are sent for derivation. Save and PDF generation always revalidate
complete schedules; the preview switch is not accepted for either action.

The commercial capture path avoids a separate duplicate estimate-prepare request
before server derivation, while retaining pending-work completion, pricing review
and capture race checks. No calculator formulas, assessment tables or passive-fire
rules change. On a synthetic 1,000-row schedule, warm server linking fell from
6.99 to 1.07 seconds; validated prices and source hashes matched exactly. These
measurements describe this fixture and machine, not a universal timing guarantee.
The real browser test linked that 1,000-row estimate in 2.09 seconds and added a
second estimate in 1.56 seconds; the full schedule projection ran only on expand.

SWMS Add job step and Quote Add custom row reuse the existing Add person icon
control. The canonical opening Terms paragraph is bold in the editor and PDF,
including older plain-text drafts, without changing legal wording or stored
content merely by opening it. Issued PDFs remain immutable.

Risk classification: medium for the Project creation policy, linked procurement
drafting and asynchronous estimate previews; low for icon, order and bold text
presentation. Tests cover direct server rejection, spoofing, cancellation,
workspace isolation, imports/replays/history, source version conflicts, deferred
numbering, legacy expense text, exact price/hash equivalence, lazy schedule retry,
real exports and responsive UI behavior.
