# Roadmap

## Implemented

- Reconcile the empty remote repository and preserve original local workbooks.
- Extract 417 inventory records, 166 dropdown values, all 64 Calculator inputs and 151 formulas with source traceability.
- Translate all Calculator numeric and notes formulas, including blank/error behavior and unrounded pricing.
- Expose the Calculator controls, pricing configuration, calculated breakdown and print view.
- Use the supplied Ceasefire logo and provide downloadable PDF quote reports with saved-result/source-lineage preservation.
- Save/reopen quotes with input, lookup-price/yield and result snapshots.
- Protect calculations with independently captured Excel scenarios and test import, persistence and HTTP behavior.
- Build a distribution without Excel or source workbooks, with declared PDF dependencies and the original logo included.

## Outside the rules supplied by these workbooks

Automatic dimension-to-coverage conversion, steel section-factor/thickness lookup, FRL-based product eligibility and technical system selection have no executable specification in the supplied files. Steel/Duct are blank collection templates with examples. The current workflow labels and manually entered quantities reflect that limit. Additional technical source tables or an approved business specification are needed before implementing these functions.

## Future operational work

An installer, authenticated shared deployment, concurrent multi-user editing and managed backups are not part of the current local application. They require an operating-environment decision; no public deployment has been performed. Existing SQLite quotes can be backed up locally while the application is stopped.
