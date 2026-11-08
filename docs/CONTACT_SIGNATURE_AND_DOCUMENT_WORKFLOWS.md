# Contact, signer and document workflows

Project Contact search uses the existing Contacts directory and stores an optional
canonical `contact_id` alongside the project's name, phone and email snapshot.
Selecting a Contact copies its phone and email once. Manual overrides and old
project snapshots do not resync when the directory changes. Free-text names and
unchanged imported links remain supported. Changed explicit links must match an
existing Contact's ID and name. Conditional file revisions, project capabilities
and save request receipts continue to protect metadata updates.

The seven commercial Schedule of Rates amounts are application preferences in
`app_preferences.commercial_rate_defaults`. Valid edits are saved as serialized,
versioned partial patches. Conflicts require an explicit retry; failed edits stay
visible. New commercial documents use the current preference, while saved
documents, issued files and calculator pricing keep their own values. Reads do
not create preferences. No catalog or passive-fire calculation rules change.

New Certificate signer fields and SWMS people fields start blank. A successful
signature insertion reads the saved Personal Details Settings and fills only
empty applicable fields; explicit entries remain. Cancellation, failed profile
reads and stale editor responses do not apply a signature or identity. Document
edits never save Personal Details. Settings remain the explicit profile editor.
Legacy SWMS people defaults remain stored for compatibility but no longer seed
new statements. Existing statements and issued history remain unchanged.

Certificate Clear removes only the signature image. Delete signer details clears
only Name, Position, Qualification and Accreditation. Reusable signature artwork
is managed separately by the existing signature chooser.

Documentation lists `View Revisions (N)` using the number of stored documents for
that row, rather than the largest revision number. Its left pane displays the
existing immutable scoped links, supports Escape/close with focus restoration,
updates after downloads and clears when projects change. It uses a two-column
layout above 900px and stacks above the tables on smaller screens, following the
Project Details pane breakpoint. Tables scroll within their own container.

Project Files now occupies the right cell beside Project Details. Estimate and
Account add controls share the same SVG plus symbol. The Estimate Document menu
sits after Create SWMS, and the decorative Estimate artwork and current-project
metadata card are hidden from that workflow. Custom Quote lines use an inline
trash action; generated estimate lines remain protected. Displayed Updated times
use 24-hour hours and minutes without altering stored timestamps.

Risk classification: medium for portable Contact identity, versioned defaults and
signature identity application; low for layout and revision-history presentation.
Validation covers stale project responses, conditional saves, duplicate Contact
names, manual overrides, rate conflicts/retries, saved document preservation,
blank signer creation, cancellation, independent Clear/Delete, real exports,
portable revision history and desktop/mobile layout.
