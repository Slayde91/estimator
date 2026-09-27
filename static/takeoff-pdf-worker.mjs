// Keep the upstream distribution unmodified. A warning can mean omitted PDF
// content, so forward bounded diagnostics before importing its worker entry.
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);
let reported = 0;
function report(args) {
  if (reported++ >= 20) return;
  const message = args.map(value => String(value)).join(" ").slice(0, 500);
  self.postMessage({ ceasefire_pdf_warning: message || "PDF worker reported a rendering warning." });
}
console.warn = (...args) => { report(args); originalWarn(...args); };
console.error = (...args) => { report(args); originalError(...args); };
await import("/vendor/pdfjs/build/pdf.worker.mjs");
self.postMessage({ ceasefire_pdf_ready: true });
