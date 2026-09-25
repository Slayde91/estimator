# Trafalgar Technical Library import

The import adds one Technical Library entry per captured Trafalgar selector
product ID. Identical-looking rows remain separate because their source IDs and
search contexts may differ. Existing Firefly records, source registrations,
Firestopping data and relationships are preserved.

Supplier captures, PDFs, images and generated bundles are private local data.
Do not commit or include them in a distributable build. The scripts below do not
change calculator rules, prices, saved projects or the original source files.

## Prepare the sources

Use the browser capture together with the matching diagram manifest and archive.
The manifest's capture SHA-256 must match the supplied capture. Earlier partial
capture audits are not evidence for a later capture.

The optional preparation tool requires PyMuPDF and Pillow in its Python
environment; these are import-time tools, not additional application runtime
dependencies. Render every page of every available PDF:

```powershell
python scripts/prepare_trafalgar_documents.py documents.zip diagram_manifest.json C:\private-import\prepared
```

The tool retains original PDFs, renders page images at a 2,600-pixel long edge,
preserves all page text, checks source hashes and accounts for missing documents.
Assets with identical source bytes share rendered filenames. JPEG originals are
resized only when larger than the chosen web-image size. Render warnings require
inspection against the original PDF, using a second renderer when necessary.

For image-only pages, install `tesseract.js` in a separate tools environment or
use the bundled runtime and expose it through `NODE_PATH`. OCR runs locally;
the engine may download its public English language model on first use:

```powershell
node scripts/ocr_trafalgar_documents.cjs C:\private-import\prepared C:\private-import\prepared\ocr-index.json
```

OCR is a searchable transcription aid. Verify dimensions, FRLs and instructions
against the images. It must not silently supply a missing rating or override the
selector's source wording. Preserve observed contradictions and illegible or
clipped source information as review notes.

## Build and verify a candidate

```powershell
python scripts/import_trafalgar_library.py --capture selector-capture.json --manifest diagram_manifest.json --prepared-documents C:\private-import\prepared --base-bundle .runtime\reference-library --output-bundle C:\private-import\candidate
```

The builder verifies every registered asset, source identities, query links and
page sequence. It preserves the exact selector field values and query context
tuples. Conditional service/wrap/FRL combinations must not become independent
lists or a product-wide maximum rating. All linked source pages remain available
as reference images and original PDF links.

Review the generated coverage receipt. Reconcile the source record count,
available/missing/unlinked diagrams and all page counts. A finished selector
search plan establishes coverage of the captured options; it does not establish
coverage of undocumented or hidden supplier database records.

An identical rerun verifies and reuses its output. For changed source or review
data, choose a new candidate directory. Reimport ownership is explicit; foreign
record or asset ID collisions fail rather than overwrite existing content.

## Install locally

After source review and isolated API/browser checks, install using the existing
staging and backup workflow:

```powershell
python scripts/install_reference_library.py C:\private-import\candidate --replace
```

The installer validates the staged copy, retains the previous reference-library
directory as a timestamped backup and then switches directories. Do not edit
SQLite to import technical records. The reference reader notices a changed index;
refresh the library pane without replacing an unsaved calculator or quote draft.

Keep local audit receipts, source hashes, image/text review coverage and the
installation backup path with the import. They document what was actually
available and reviewed; they do not constitute supplier technical approval.
