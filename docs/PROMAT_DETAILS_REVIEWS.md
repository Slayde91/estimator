# Promat installation details and report links

Promat uses the existing Installation Details, Service Size / Configuration
and Report Number fields. No additional visible fields are introduced.
Report Number accepts `report_links` metadata containing matching `label` and
`url` values. Only HTTPS PDF links on the exact Promat media and Etex CDN hosts
are accepted. The browser opens them in a new tab without an opener. Source
information remains plain text.

The importer retains an unambiguous report link already associated with the
source entry. It also removes a repeated trailing `Up to N` cable quantity
when the immediately following selector detail repeats that same quantity.
Different quantities and intervening requirements are preserved.

Existing private bundles can be enriched using:

```powershell
python scripts/review_promat_details.py --bundle PATH/library.json --reviews PATH/reviews.json --output PATH/candidate.json
```

Each decision identifies the entry, every source variant in order, exact
diagram SHA-256 values, a fingerprint of original fields/current reviewed
fields/source pages, and an installation summary. An optional `report` has
`label` and `url`. A report number may be recovered when absent, but an existing
number cannot be silently replaced. Review diagrams visually; OCR is only an
extraction aid. Summarise common requirements in prose and retain conditional
requirements with their configuration rows. Preserve earlier reviewed wrap
decisions. Do not extrapolate installation dimensions from product photographs.

The tool writes a separate validated candidate, preserves original evidence
and all configuration tables/ratings, and records the decision privately. Its
only automatic text cleanup concerns repeated service quantities. Review data,
supplier diagrams and reports must remain outside Git and the distribution.
Validate before atomic installation and keep the prior private index backup.

Use the original captured report URL, or an explicitly reviewed exact report
identity, never a guessed URL or a different report that merely cites it.
If no report URL is published or can be verified, retain its number as text and
record the missing link in the private audit. A functioning PDF endpoint alone
does not establish that its report applies to a system.
