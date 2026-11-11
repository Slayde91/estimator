# How CLASSIFIRE links customer records

CLASSIFIRE is a project-based CRM. A company is an organisation, a contact is a person, and a lead is one potential job. The numbered Project continues the job when a lead converts. Quotes, work orders and purchase orders have their own identities and revisions within that job. A purchase order can involve both a customer and a different supplier.

## Record identity and historical documents

1. **Identify the person before creating another record.** Creating a contact or typing a person into a lead checks the company, full name and nonempty email together. A person can reuse the suggested record or deliberately create a separate contact. Two people with the same name or a shared inbox remain possible. An import skips exact repeats and reports conflicting details for review without partially importing the workbook. Existing records are never merged automatically.
2. **Separate the job from the person.** The same person can bring in several jobs, even at the same site. A possible repeat prompts for a decision. Choosing an existing person on a lead does not make edits to that person's directory profile. Company and contact panes show the active leads linked to their IDs.
3. **Keep the handover.** Converting a lead records its final details, stage, follow-up, conversion time and project number. The lead appears in the Converted column and under its original company and contact. A retry reuses the same project. For conversions made before the archive existed, only the recorded project reference is shown.
4. **Separate document roles from printed names.** Choosing a supplier, supplier contact or site contact on a PO saves the directory ID as well as the text to print. A supplier can find that PO without being made the customer or being linked to every document on the project. Typed or historic names alone do not identify a party. Saved snapshots and issued PDFs retain their original wording.
5. **Make the next step visible.** A lead can have a next action and calendar date. The existing board shows both, sorts scheduled leads first in each column, and can show only follow-ups due by a chosen date. An empty cutoff shows all leads, including unscheduled ones. Neither field is required to save a lead or convert it.

## Staff, activities and sales progress

New companies, contacts, leads and activities default to the signed-in staff member as Owner.
Staff can reassign ownership from the active staff roster. Next actions, due dates and regions
belong to the existing record. Staff can log calls, emails, meetings, notes and
tasks, and complete tasks without erasing the original entry. Recorded time and
actual interaction time are distinct. Creation, updates, stage changes and lead
handover are recorded prospectively with the authenticated staff identity.
Unrecorded historical dates and actors stay unknown.

Leads start in New. Selecting a directory contact or adding a phone number or email
moves a new lead to Qualified. Staff can mark a lead Disqualified. A successful
Project conversion moves it to Converted. Older Contacted, Quoting, Negotiating and Won
cards appear under Qualified. Lost and Not Applicable cards appear under Disqualified.
Assisting and Interstate cards use their saved contact details to determine their column.

Company, contact and lead history follows the IDs recorded at the time, including
an enquiry whose client differs from its contact's employer. A completed task
retains its original relationships even if the person later changes employer.

## Project parties, sites and scheduling

Project participants have explicit roles and verified directory IDs. Adding a site
contact or consultant does not change that person's employer. These relationships
are held in the local CRM sidecar; existing Project files and issued documents are
not rewritten. The exact saved file and owning Project identity distinguish copied
bids. An unavailable source retains its last-recorded relationships and is labelled
unavailable. A moved file must be deliberately relinked rather than guessed from a
matching name, address or copied UUID.

In Project Details, use **Companies** to choose the main client and **Contacts** to
choose the primary contact. The + beside each search creates the corresponding
directory record. New Quotes use the project's main client and primary contact.
A Work Order starts with the recipient on its selected Quote. Changing a document's
recipient keeps that selection on the document and links the selected directory
records to the project. On a Purchase Order, choose the supplier company and
contact under **Purchase order information**. The panels on the left show those selections.

**Linked Sites** shows one **Linked Projects** list. Saving a project address
automatically links projects at the same address. Matching ignores differences
in case, Unicode presentation and repeated spaces. Unit numbers, punctuation and
street abbreviations still matter. Previously recorded site relationships also
appear in the list, with each project's own address. Each project keeps its own
client, documents and access permissions.

Scheduler selects saved Work Orders and displays their Project/client/site context.
New bookings do not depend on the old Project Accepted status and do not require
an issued or Accepted Quote. Draft Work Orders can be scheduled deliberately.
Existing Project-only bookings retain their original references. Scheduler's team,
time, break, location and publication permissions continue to apply. Workers see
only their own bookings, while their job picker exposes bounded reference/site
context without commercial prices, documents or notes.

Shift publication is deliberate: Publish shift and Create draft save the same
shift identity with the chosen visibility. Typing Enter in a field does not publish
a draft. Colour tiles retain an older custom colour until another is selected.

Work Order Claim has its own billing address, business identifier and accounts
person snapshot. A new accounts person is linked to the Project's existing Company
only after an explicit successful document Save. Completion verifies the exact
saved source and revision; retries reuse the same creation receipt. A directory
conflict leaves a visible pending link for review rather than pretending creation
succeeded. Choosing an existing person does not change their employer or directory
details. Billing overrides do not update the Company's master data or earlier PDFs.

## Reviewed duplicates and current details

Duplicate suggestions distinguish strong identity matches from advisory name,
email and phone similarities. They apply when relevant identity fields change;
they do not silently merge people sharing a mailbox or legal/trading-name variant.
Batch imports remain all-or-nothing and identify conflicting rows.

An administrator can review two originals, choose a survivor and record a reason.
Merge and undo store versioned, retry-safe alias decisions. Original rows, IDs,
memberships, snapshots, file bytes and PDFs remain intact. Current directory views
combine the aliases while retaining the exact original source and document role.
Undo restores the separate view; it does not roll back other edits. An older client
that cannot express direct versus inherited links must reopen the updated editor.

The enquiry editor compares This enquiry with Current Contact. Refresh copies only
the selected name, title, phone or email into the unsaved form. It does not change
the enquiry client, site, notes, historical snapshots or issued documents. Save is
the version-checked write.

## Local staff access and signer recovery

Named staff authentication reuses existing Scheduler credentials. Team
administrators administer CRM access; editors can update records; viewers can read
records; Scheduler-only accounts receive a separate Scheduler page. Roles and
requests are audited. Mutations require the tab's expected staff identity, and
signer/profile reads also detect identity changes in another tab.

Loading saved inputs may derive calculator definitions and Project-local library
previews for a reader. Those read operations do not save pricing, library items or
Project files. Actual saves, deletes and administrator settings retain their
existing role and staff-identity checks.

Personal signer details and artwork are isolated by authenticated staff ID. Existing
global details and anonymous browser ink are retained. The personal-details page
uses the current named profile and its normal versioned Save; the previous-details
Review button has been removed. Earlier artwork and historical signer data remain
stored. Changes to a current profile do not rewrite issued signatures or revisions.

The request audit records a safe endpoint template and the staff identity before an
authorised mutation. A separate response receipt records the HTTP result. A missing
response means outcome unknown; it is not proof the business operation failed.
Detailed CRM event and document histories retain their own transaction/version
checks. Passwords, raw request bodies, file paths and capability tokens are not
stored in the access ledger.

## Boundaries

- Legacy business labels must not be treated as numerical win probabilities or inferred sales outcomes.
- A follow-up is the next planned action, not a sent email, a calendar booking or evidence that a call took place.
- Historical names, email addresses and file names are not safe keys for automatic repairs. Existing manual links and external file availability stay distinct from verified directory relationships.
- Directory writes use a revision check. A stale editor must reload; confirming a possible duplicate is not permission to overwrite a newer edit. Document edits keep their separate project and version checks.
- This release remains a single-computer application. Application permissions do not replace operating-system access controls. Remote shared hosting, backups and deployment design remain separate work; exposing or synchronising the local database is not a team deployment.
