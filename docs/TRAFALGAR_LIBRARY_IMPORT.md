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

Pages with some embedded text are excluded automatically. If visual review finds
that a page still needs OCR, explicitly include its `image_sha256` from the
prepared index; repeat the option for additional images:

```powershell
node scripts/ocr_trafalgar_documents.cjs C:\private-import\prepared C:\private-import\prepared\ocr-index.json --include-image IMAGE_SHA256
```

Each supplied hash must identify an available prepared page whose bytes match.
Repeat the same inclusion and rotation options when resuming. Completed image
records and review metadata are retained; the saved output records the requested
supplemental hashes and recalculates coverage counts.

OCR is an audit transcription aid. Verify dimensions, FRLs and instructions
against the images. It must not silently supply a missing rating or override the
selector's source wording. Preserve observed contradictions and illegible or
clipped source information as review notes.

## Prepare installation details

Each Trafalgar entry displays a single **Report Number** field. Equivalent
spacing/case variants are deduplicated; distinct report identifiers and integral
revision suffixes remain separate in that field. Table/page/clause references
remain in source evidence. An unfamiliar report format stops the import for
review instead of silently dropping it.

The single **Installation Details** field uses the linked diagram's explicit
installation instructions whenever available. In that case application text and
other diagram callouts are not appended. Repeated instructions are shown once;
spacing around punctuation and numbered step markers does not create duplicates.
Partly repeated numbered lists are combined only when every shared step number
has the same text; a changed dimension, material, condition or action retains the
whole variant. Each retained passage lists all its source pages. Words, numeric
values, units and punctuation tokens are never removed by fuzzy matching. For a
diagram without an
instruction section, prepare a coherent summary of installation-relevant
callouts, retaining dimensions, conditions and variant pairing. Exclude contact
details, dates, title-block metadata and repeated text.

Put reviewed summaries or newly extracted instructions in the prepared folder's
`installation-details.json`, using this shape (supplier values stay local):

```json
{
  "source_capture_sha256": "<capture SHA-256>",
  "documents": [{
    "document_id": "<source document ID>",
    "source_sha256": "<original file SHA-256>",
    "pages": [{
      "page": 1,
      "image_sha256": "<prepared page image SHA-256>",
      "kind": "summary",
      "text": "<reviewed installation details>"
    }]
  }]
}
```

`kind` may be `instructions`, `summary`, or `not_provided`. The last requires
empty `text` and a nonempty `reason` explaining why the source contains no
installation information. Existing reviewed `Installation instructions` fields
in `document-enrichment.json` are also used. If any instructions are present in
a linked document, only those passages are displayed. Otherwise every page must
have a reviewed summary or explicit no-information decision; missing reviews
stop the import. Source, page and image fingerprints must match.

When visually reviewed source pages repeat the same instructions with wording
differences, an optional `display_review` on the document review can consolidate
common steps and retain distinct instructions as passages with separate source
page labels. It must contain `source_sha256`, `input_sha256`, `pages` (each with
`page` and `image_sha256`), a nonempty `reason`, and `passages` (each with nonempty
`text` and a sorted, unique `pages` list). Use
`installation_input_sha256(document, product_id)` to bind the review to the exact
applicable instruction/summary inputs. Every applicable source page must be
bound and represented in the output passages. Changed source bytes, page images,
inputs or product scope stop the import until reviewed again. The raw source
instructions and prior summaries remain unchanged in the private audit.

T-card numbers, Document Revision, Selector Search Context, raw PDF/OCR transcripts and application
extracts are omitted from entry fields. Exact selector records, paired search
options, source transcripts, original enrichment and summary reviews remain in
the private import audit. All source images and PDFs remain available.

## Build and verify a candidate

```powershell
python scripts/import_trafalgar_library.py --capture selector-capture.json --manifest diagram_manifest.json --prepared-documents C:\private-import\prepared --base-bundle .runtime\reference-library --output-bundle C:\private-import\candidate
```

The builder verifies every registered asset, source identities, query links and
page sequence. It preserves exact selector values and query context tuples in
the audit. Conditional service/wrap/FRL combinations must not become independent
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
