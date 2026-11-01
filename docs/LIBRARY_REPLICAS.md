# Library illustrations

Original images, source PDFs and `library.json` remain unchanged. Optional AI
replicas are illustrations, labelled in the library with a link to the original.
They do not establish installation suitability or technical approval, and do not
enter calculator inputs, prices, technical fingerprints or project evidence.

Inventory all image fields before generating. Reuse one replica for byte-identical
or decoded-pixel-identical sources. Perceptual matches require visual comparison
of orientation, layers, ties, fixings, installation fit and mastic detail before
sharing an output. Similar appearance alone is insufficient. Keep the grouping,
prompt, generated candidate, visual review and rejected variants in the private
batch record. Do not commit supplier images or private library records to Git.

New generations must use OpenArt. Record the model, history ID, completed output
URL, generation time, original source hash, downloaded output hash and approval.
Provider names or file modification dates alone do not establish provenance.
Preserve explicit user approvals; do not regenerate or reject those exact versions
again. A later explicit user revocation overrides the earlier approval; keep the
revoked version out of publication and retain its audit history. When retiring
older or unverified derivatives, remove their registry entries
and restore fingerprinted originals for display; quarantine derivatives outside
the active `replicas` folder. Keep the source index and project data unchanged.

Generated replicas contain construction imagery only: no branding, logos, text,
dimensions, labels, watermarks or printed wrapper graphics. Omit every bottom
reference code or caption, including codes such as `BMH-120-V38 a`. Record names,
technical conditions and links to original evidence remain outside image pixels.

`scripts/install_library_replicas.py` installs a reviewed batch manifest into a
library's separate `replicas` folder. Each reviewed job records `source_sha256`,
source `aliases`, an `output` path and SHA-256, plus `review.result` equal to
`visual_review_passed`, `review.technical_approval` equal to `false`, and explicit
`review.no_text` and `review.no_branding` booleans equal to `true`. Job status
is `generated_visual_review_passed` or `reused_visual_review_passed`.

The installer verifies all source and output bytes before writing. Outputs use
content-addressed filenames; repeated batches reuse them. The registry updates
atomically. Requests validate both the current original and reviewed replica
bytes. Missing or invalid optional metadata leaves original retrieval available.
An image load failure falls back to the original. Reopening a library detail
reads the latest registered batch without restarting the application.

Installation also archives the exact original in `images_old` and synchronizes
the approved presentation into `images`. A generated PNG keeps its `.png`
extension even when its source was JPEG. Previous presentation bytes are retained
in `replicas/previous` if a replacement differs. The source index and fingerprinted
original bytes do not change. To repair older registry-only publications, run
`python scripts/install_library_replicas.py --sync-published --library-directory PATH`.
This validates the complete selected batch before moving originals, publishes
only already reviewed registry entries, and can be safely repeated.

Use Nano Banana Pro for every new illustration containing a collar. Plastic-pipe
collars must not acquire zip ties. Their mounting backs and existing tabs sit
flush outside the opposing substrate faces, with the collar bodies projecting
outward. Preserve the source collar construction and visible fixings; add no
retaining band, tab, screw or flange. Wrap ties remain smooth, unperforated,
self-locking stainless steel zip ties on the wrap only. Never replace a zip tie
with a hose clamp or add a worm-drive housing or perforated band.

For images without collars, start with GPT Image 2 at low quality and 1K.
Record any user-authorised alternate-model retry and its reason, including
provider failures and rejected visual details, without replacing source evidence.

Flexible insulation on structural steel follows the actual flanges, recessed
webs, return lips and inside corners. Do not bridge an open I/H/C/Z profile with
a rectangular enclosure or change the steel section. Preserve the original bare
ends, wrap extent, floor packing and seals. Cable-tray insulation also remains
flexible wrap, with the source side fixing angles visible; do not substitute rigid
board. These illustration corrections do not alter the assessed construction.

Publish each visually accepted image through the installer, then verify that
the live replica route returns its reviewed bytes and the original route returns
the fingerprinted source. Keep failed or rejected candidates outside the registry;
generation completion alone is not approval. Preserve the source viewing geometry,
visible quantities and uniform final horizontal flip during review.

Manual Takeoff Services transfer as separate editable Firestopping rows only
after their owning physical record is confirmed and quantity is explicit.
Known category, service type, FRL, substrate, orientation and typed dimensions are
copied literally. Generic Service Size is retained as text, never guessed to be
a diameter. No system, materials or prices are inferred. Stable source identities
prevent repeat transfers and later library associations from counting the same
Service twice. The entire batch is rejected if schedule capacity would be exceeded.
