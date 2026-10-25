# Visual Search in Service Plans

Visual Search looks for repeated graphical symbols in original PDF pages. It
works with rendered vector drawings and scanned images. It is available beside
the text search controls in Service Plans, after a source PDF is opened.

1. Open **Visual Search**, then choose **Select example**. Drag a rectangle around
   one clear symbol and a small background margin. Press Escape to cancel the
   selection. Existing callouts and other application overlays are excluded.
2. Choose the current page, current document or all retained documents. Increase
   sensitivity to require a closer visual match. Enable multiple rotations to
   compare the example at 45-degree increments.
3. Choose **Search**. Review the thumbnail and original page for each proposed
   match. The displayed similarity is an image correlation score, not a
   probability or proof that the symbols mean the same thing. Click a result to
   visit its exact original source location.
4. Check the results that represent the physical objects you intend to record.
   **Select All** checks the complete displayed result set. At most 100 checked
   results can be created in one atomic batch.
5. Choose **Add selected as barriers** or **Add selected as services**. Enter the
   shared fields once. For services, explicitly choose an existing parent barrier
   and enter the quantity for each matched location. No barrier is invented for
   a service. Review the native preview and confirm the batch, or cancel it.

New records remain unconfirmed draft assertions. Each retains the exact document
ID, SHA-256, original page, source region and its own source callout position.
Service callouts stay attached to their chosen barrier. The original PDF bytes,
calculator data and unrelated physical records are unchanged. Source annotations
survive project save/reopen and appear in marked drawing exports.

## Search limits and review

Search is local and cancellable. One search covers at most 32 pages, 500 matches
and three minutes. Each original page render is limited to 2.4 million pixels;
the sample must be between 8 and 512 rendered pixels on each side. An excessive
or interrupted search exposes no incomplete match set for batch creation.
For a larger document, search its current page. Close or Stop cancels the work.

Matching compares sampled foreground and background contrast, normalizes page
render scale, refines positions to individual rendered pixels and suppresses
overlapping duplicate windows. This is a bounded local implementation of the
select-example/search/review workflow. It does not reproduce a proprietary
matching engine. Distorted scans, changed scale, nearby drawing lines, low
contrast and small details can produce missed or false matches. Inspect the
original source before recording physical objects. A graphical match does not
identify a product, approved fire configuration or service quantity.

The interaction follows the documented rectangle selection, sensitivity,
rotation and checkable-result workflow in [Bluebeam's Visual Search guide](https://support.bluebeam.com/online-help/revu20/Content/RevuHelp/Menus/Window/Panels/Search/Searching-PDFs--TV.htm).
The application retains its own explicit Barrier/Service draft model and
revision-checked preview/apply process.
