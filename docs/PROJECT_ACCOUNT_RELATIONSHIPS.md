# Project and Account relationships

Accounts hold company details, optional ABN/ACN text and their linked Contacts.
ABN/ACN entered for a Lead belongs to its Account. A Lead cannot silently replace
an existing company's different ABN/ACN; edit that Account explicitly instead.
Older directory databases and the original two-column Accounts workbook remain
supported.

Saving an Account updates its fields, selected Contact ownership and supplementary
Project, Quote, Work Order and Purchase Order links in one directory transaction.
The directory version must still match. Unknown IDs are rejected before any
changes; a missing record already linked to the Account remains visible and is
retained unless explicitly removed. Contacts attached to Leads must retain a
company. Moving a Contact to another Account is shown explicitly in the editor.

Related-record choices use the existing bounded, authorized project and commercial
register scans. Search finds records beyond the bounded response. Pending scans
and unavailable sources are reported; explicitly ignored sources are excluded.
The API accepts record IDs, never caller-selected filesystem paths.

A saved Project's Account-link ID is deterministically derived from its authorized
file identity. It works before that Project has a certificate or commercial
workspace and stays unchanged when its details or certificate metadata change.
Renaming or moving the file gives it a different Account-link ID: an older manual
link is displayed as unavailable until the user relinks it. Document links use
the commercial workspace ID together with the document ID.

A Project's explicit primary Account ID establishes its automatic relationships;
older Projects can fall back to matching the Client company name for display.
Supplementary links do not rewrite saved Project fields, document contents or
issued PDF history.

Risk classification: high for directory migration and Contact ownership changes;
medium for relationship discovery and saved-file identity; low for presentation.
Validation covers migration preservation, old workbook import, atomic rollback,
competing directory versions, missing targets, composite document identities,
plain Projects, certificate metadata changes and ignored commercial sources.
