# CRM and document workflow changes — 10 November 2026

## Browser annotations

The estimate header orders Estimate, Sqm/Items, then Document. Settings saves use
the same Save wording; Personal Details places Save below the signature. The
language and theme controls share their responsive dimensions. The numbering
update action reads Update existing records.

Commercial cards derive their headings from the document reference and client,
or from the PO reference and supplier. Editable custom-title controls are removed
without clearing stored title values. Historical PDFs retain their original bytes.
Status follows Download PDF. PO date/link/project/reference controls share a
desktop row. Work Order links and references sit below date/project controls.

SWMS headings use the statement reference, saved client and saved site address.
All saved statements and certificates are available from their respective lists,
including records that previously carried a review or archive status.
Certificates can be saved before issuing a PDF. Issued revisions retain their
original content.

## Confirmed CRM decisions

- Continue using a single computer for this release; use named staff and permissions.
- Shared remote access needs a separate deployment design.
- New Scheduler bookings identify saved Work Orders. The Project supplies context
  such as client and site. Keep existing Project-based bookings as legacy records.
- Project sales status must no longer be the hidden gate for scheduling. Quote
  acceptance remains a distinct decision rather than automatically accepting every
  alternative or partially accepted job.

Release verification and the frozen backups are recorded under the local audit
directory rather than storing user data or screenshots in Git.
