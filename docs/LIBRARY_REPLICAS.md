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

`scripts/install_library_replicas.py` installs a reviewed batch manifest into a
library's separate `replicas` folder. Each reviewed job records `source_sha256`,
source `aliases`, an `output` path and SHA-256, plus `review.result` equal to
`visual_review_passed` and `review.technical_approval` equal to `false`. Job status
is `generated_visual_review_passed` or `reused_visual_review_passed`.

The installer verifies all source and output bytes before writing. Outputs use
content-addressed filenames; repeated batches reuse them. The registry updates
atomically. Requests validate both the current original and reviewed replica
bytes. Missing or invalid optional metadata leaves original retrieval available.
An image load failure falls back to the original. Reopening a library detail
reads the latest registered batch without restarting the application.

Manual Takeoff Services transfer as separate editable Firestopping rows only
after their owning physical record is confirmed and quantity is explicit.
Known category, service type, FRL, substrate, orientation and typed dimensions are
copied literally. Generic Service Size is retained as text, never guessed to be
a diameter. No system, materials or prices are inferred. Stable source identities
prevent repeat transfers and later library associations from counting the same
Service twice. The entire batch is rejected if schedule capacity would be exceeded.
