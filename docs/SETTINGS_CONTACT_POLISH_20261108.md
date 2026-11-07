# Settings and contact review, 8 November 2026

Presentation changes reorder Contacts to Name, Company, Title, Phone, Email;
hide relative project-file paths in project rows; size the saved-certificate
selector to its options within the viewport; and give library transfer actions
the existing Takeoffs yellow/red treatment in every theme.

Personal Details reuses the existing signer-default API and version checks.
Saving text omits signature keys and retains current certificate snapshots.
Browser and native-close guards protect unsaved entries. Single-row textareas
preserve previously stored multiline qualifications and accreditation text.

Project prefix/start controls join the Document numbering table. One save
validates every row before writing project and document settings in an attached
SQLite transaction. Existing independent endpoints remain compatible.

The owner explicitly selected “Start future quotes at Q-01”, retaining existing
documents. A separate short-quote high watermark avoids resetting or deleting
the legacy counter. Imported historical counters remain in the old sequence.
Exact observed references prevent collisions, and optional short_quote_counters
in the commercial snapshot preserve the new sequence through portable restore
and deletion. Older strict readers may require an application update before
opening projects carrying the new optional counter metadata.

Calculator formulas, prices, assessment rules, existing references and issued
PDF bytes are unchanged. Validation includes atomic settings rollback, numeric
validation, concurrent allocation/replay, old/new portable counter restoration,
signer conflicts and late replies, certificate preservation, and responsive
browser journeys.
