# Local PDF text recognition

The drawing toolbar's **OCR** button (also **Ctrl+Shift+O**) recognizes raster
text locally and retains an invisible, selectable text layer in this browser.
Use **Select PDF text** to select and copy recognized words. Ordinary **Ctrl+F**
search includes previously retained OCR text, even when **Include drawing
labels** is off. Native PDF text is preferred over overlapping OCR readings.

The original PDF remains byte-for-byte unchanged. OCR does not create a barrier,
service, quantity, measurement, approval or calculator input.

## Recognition settings

- **Pages:** recognize the current page or a document range. Each batch admits
  at most eight pages and 150 seconds; an individual page admits 60 seconds.
  Complete pages with the same settings are skipped. After a successful batch,
  the first-page control advances, so another run continues through the document.
  Partial or failed pages can be retried or selected explicitly by page range.
- **Language:** English, French, German or Spanish. All four models are bundled;
  no drawing or recognized text is uploaded and no model is fetched at runtime.
- **Document type:** CAD drawing uses sparse text segmentation without language
  dictionary bias; text document uses automatic page segmentation and dictionaries.
- **Optimize for:** Accuracy renders up to two pixels per PDF point; Speed uses
  up to 1.25. Large pages are bounded to 18 million pixels and a 6,000-pixel edge.
- **Correct small scan skew:** a bounded projection-profile pass estimates up to
  five degrees of tilt. Its raster correction is inverted when constructing the
  original-PDF word coordinates. Word bounds remain approximate.
- **Detect page orientation / vertical text:** enable quarter-turn recognition
  passes at 0, 90, 180 and 270 degrees. Turn both off to use only the upright pass.
- **Detect text in pictures and drawings:** recognizes the original page raster.
  Turning it off masks smaller embedded PDF image footprints in the disposable
  recognition raster. Full-page image scans remain eligible. The first 4,096
  standard image-paint footprints are bounded; this is not a proprietary CAD
  object classifier.

The engine drops malformed and low-confidence words, merges overlapping tile
readings, and reports partial coverage when a time or size limit intervenes.
Always compare a reading with the original drawing.

## Persistence and boundaries

Layers are keyed by the original PDF SHA-256, page number, engine version and
recognition settings. Restored text and coordinates are validated before use.
The rebuildable IndexedDB cache retains up to 512 page/settings records and
32 MiB, with a 2 MiB limit for each record. Oldest entries are evicted first.
Opening, reading and writing browser storage each have a five-second bound.
If browser storage is unavailable, a bounded session cache remains usable and
the completion message states that it was not persisted.

This cache belongs to the current browser profile and app origin. It is not
embedded in the original PDF, the saved `.cf.json` project, or marked-PDF exports.
Moving a project to another browser/computer therefore requires recognition
again. This implementation does not claim to export a searchable derivative PDF
or duplicate Bluebeam's proprietary OCR engine.

Worker, core and language assets are pinned by the local manifest and delivered
through the existing integrity-checked, same-origin allowlist. The main page's
security policy is unchanged; WebAssembly permission stays limited to the
dedicated recognition worker. Package identities, licenses and integrity values
are reproduced by `scripts/vendor_takeoff_ocr.py`.

Upstream references: [Tesseract.js v7 API](https://github.com/naptha/tesseract.js/blob/v7.0.0/docs/api.md),
[local installation](https://github.com/naptha/tesseract.js/blob/v7.0.0/docs/local-installation.md),
and [Bluebeam OCR workflow](https://support.bluebeam.com/online-help/revu20/Content/RevuHelp/Menus/Document/OCR/OCR.htm).
