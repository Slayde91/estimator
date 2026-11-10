# Calculator, Scheduler and document annotations

Continue the existing application and its data contracts. These changes affect
navigation, controls and presentation; they do not alter passive-fire calculations,
document numbering rules, authentication, project ownership or stored PDF bytes.

## Certification navigation

The commercial, SWMS and Documentation editors share Certification's project
workspace capability. Opening that capability is a background operation, even if
the certificate editor has never been opened. It must not trigger the message
asking the user to finish creating a certificate before changing views.

The navigation predicate permits background workspace/list/editor reads to finish
after switching views. Actual certificate writes, signature insertion, generation
and uncertain requests awaiting exact-key retry remain guarded. The broader
pending predicate still protects project replacement, capture and desktop close.

## Calculator strip and worksheet actions

All six calculators have a persistent strip using the existing Projects tab
appearance: Duct, Firestopping, Steel (spray), Steel (intumescent), Steel (board)
and Factor Calcs. The existing header menu remains available. Both routes use the
same guarded navigation and retain calculator inputs, pages and other drafts.
The older Steel landing panel does not falsely select a particular calculator.
Arrow keys move focus, Home/End reach the ends, and Enter activates the button.
The strip scrolls within its own width on phones; it does not widen the document.

Document, Reset Calc and Recalculate now appear beside the worksheet tabs,
immediately before Columns when it is available. The existing 760px calculator
breakpoint places the worksheet tabs on their own row. Actions wrap in document
order when the available width is insufficient, and the document popup stays
within the viewport. Export/import/reset handlers and column preferences are
unchanged. Factor Calcs keeps its existing applicable actions.

## Scheduler

Draft shifts use a white background, dark text, their selected colour as a thick
border, and the existing DRAFT marker. Published shifts retain their solid colour.
The modal action order is Cancel, Create draft, Publish shift. An implicit Enter
submission still cannot publish a shift.

Work Order selection is a searchable, keyboard- and touch-operable combobox using
the same existing permission-filtered results. It retains the chosen exact ID and
revision rather than deriving identity from its displayed name. At most 80 results
are shown at once; the user can narrow the search. Typing unlisted text cannot
create an assignment. Existing unavailable and legacy assignments are retained
unless deliberately changed or cleared. Server revision and permission checks
remain authoritative.

The Scheduler tab strip has the specifically requested #090B0E background, scoped
to that strip. Inactive tabs retain readable light text across the existing
themes. Other navigation backgrounds are unchanged.

## Commercial details

The action-toolbar Status caption is visually hidden; the select retains its
translated accessible name. Quotes show Linked Project and Quote No. beneath
Document date and Project number, using the existing 440px field-pair stacking.
Both new fields display authoritative read-only information. Linked Project is
the document's actual owning source, not a quote-move control. Historical unfiled
quotes do not inherit the currently open tab's project. Quote No. appears when
the existing download/issuance process assigns it; saving does not consume a new
number. No document or snapshot is rewritten by rendering these fields.

## What Participants and shared site means

Participants is a job's list of involved companies and people and their roles,
such as client, builder, supplier, consultant, site contact or accounts contact.
Staff choose an existing directory record and a role, then Add participant. The
link is saved immediately; Remove removes that job link and keeps the company or
person. An editor or administrator can change these links; viewers can read them.
The links do not change a contact's employer, appoint a printed document recipient,
change an issued PDF, grant login permissions or establish technical approval.

A shared site groups separate projects or bids at the same physical location. For
example, quotes to two builders can remain separate while showing that both concern
the same site. Staff deliberately create/select and link that site; matching
addresses never merge bids automatically. View linked bids lists the related
project references. Each project keeps its own estimates, documents, prices,
contacts and ownership. Links are held in the local CRM against the exact saved
project source and owner; this release does not claim those local sidecar links
travel with a portable project file to a different computer.
