# How CLASSIFIRE links customer records

CLASSIFIRE is a project-based CRM. A company is an organisation, a contact is a person, and a lead is one potential job. The numbered Project continues the job when a lead converts. Quotes, work orders and purchase orders have their own identities and revisions within that job. A purchase order can involve both a customer and a different supplier.

## Design review and fixes, in priority order

1. **Identify the person before creating another record.** Creating a contact or typing a person into a lead checks the company, full name and nonempty email together. A person can reuse the suggested record or deliberately create a separate contact. Two people with the same name or a shared inbox remain possible. An import skips exact repeats and reports conflicting details for review without partially importing the workbook. Existing records are never merged automatically.
2. **Separate the job from the person.** The same person can bring in several jobs, even at the same site. A possible repeat prompts for a decision. Choosing an existing person on a lead does not make edits to that person's directory profile. Company and contact panes show the active leads linked to their IDs.
3. **Keep the handover.** Converting a lead records its final details, stage, follow-up, conversion time and project number. It leaves the open board but remains visible under the original company and contact. A retry reuses the same project. For conversions made before the archive existed, only the recorded project reference is shown. CLASSIFIRE does not infer an old stage or conversion date from the current project.
4. **Separate document roles from printed names.** Choosing a supplier, supplier contact or site contact on a PO saves the directory ID as well as the text to print. A supplier can find that PO without being made the customer or being linked to every document on the project. Typed or historic names alone do not identify a party. Saved snapshots and issued PDFs retain their original wording.
5. **Make the next step visible.** A lead can have a next action and calendar date. The existing board shows both, sorts scheduled leads first in each column, and can show only follow-ups due by a chosen date. An empty cutoff shows all leads, including unscheduled ones. Neither field is required to save a lead or convert it.

## Boundaries

- The board retains the existing business labels. In particular, “Interstate” should not be treated as a probability or a later sales stage when calculating forecasts.
- A follow-up is the next planned action, not a sent email, a calendar booking or evidence that a call took place.
- Historical names, email addresses and file names are not safe keys for automatic repairs. Existing manual links and external file availability stay distinct from verified directory relationships.
- Directory writes use a revision check. A stale editor must reload; confirming a possible duplicate is not permission to overwrite a newer edit. Document edits keep their separate project and version checks.
