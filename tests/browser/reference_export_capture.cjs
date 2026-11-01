// Reference exports return bytes to browser memory, without a server save receipt.
// Retain a test-owned copy for the independent PDF/XLSX content inspectors.
const fs = require('node:fs'), assert = require('node:assert/strict');
const captures = new WeakMap();
async function observeReferenceExports(page) {
  await page.route(/\/api\/(?:penetration\/item\.(?:pdf|xlsx)|technical\/item\.(?:pdf|xlsx)|pricing\/export)$/, async route => {
    const response = await route.fetch();
    captures.set(route.request(), await response.body());
    await route.fulfill({ response });
  });
}
async function captureReferenceExport(response, target) {
  assert.equal(response.status(), 200);
  const request = response.request().postDataJSON();
  assert.equal(request.download, undefined, 'Reference exports do not capture a project destination');
  const pdf = target.endsWith('.pdf');
  const mediaType = pdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  assert.equal(response.headers()['content-type'].split(';')[0], mediaType);
  // Chromium can omit attachment bytes from its network-inspection response.
  // Tee the same request before delivery, without issuing a second export.
  const bytes = captures.get(response.request());
  assert.ok(bytes?.length, 'Capture the actual reference response before browser delivery');
  assert.equal(bytes.subarray(0, pdf ? 5 : 2).toString(), pdf ? '%PDF-' : 'PK');
  fs.writeFileSync(target, bytes);
  return target;
}
module.exports = { captureReferenceExport, observeReferenceExports };
