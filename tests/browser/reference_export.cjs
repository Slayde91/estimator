// Observe the public temporary PDF viewer / native XLSX download contract.
// Artifact copies below belong to the disposable test fixture, not the project.
const assert = require('node:assert/strict'), fs = require('node:fs');
const { expect } = require('@playwright/test');

async function referenceExport(page, { extension, endpoint, action, target }) {
  // Capture the one real exporter response before it is handed to fetch/blob.
  // Chromium can omit a consumed attachment body from Network.getResponseBody.
  let delivered;
  const captured = new Promise(resolve => { delivered = resolve; });
  const pattern = `**${endpoint}`;
  const intercept = async route => {
    const exported = await route.fetch();
    const bytes = await exported.body();
    delivered(bytes);
    await route.fulfill({ response: exported, body: bytes });
  };
  await page.route(pattern, intercept);
  try {
  const response = page.waitForResponse(reply => new URL(reply.url()).pathname === endpoint && reply.request().method() === 'POST');
  const result = page.waitForEvent(extension === 'pdf' ? 'popup' : 'download').then(value => {
    if (extension !== 'pdf') return value;
    const nativeDownload = new Promise(resolve => value.once('download', resolve));
    return { viewer: value, nativeDownload };
  });
  response.catch(() => {}); result.catch(() => {});
  await action();
  const reply = await response;
  assert.equal(reply.status(), 200);
  const capture = reply.request().postDataJSON(), headers = reply.request().headers();
  assert.equal(capture.download, undefined, 'Reference viewing/export has no project destination or save prerequisite');
  for (const key of ['x-estimator-documentation-workspace', 'x-estimator-documentation-request'])
    assert.equal(headers[key], undefined, 'Reference viewing/export does not create a project document revision');
  const media = extension === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  assert.equal(reply.headers()['content-type'].split(';')[0], media);
  const bytes = await captured;
  assert.equal(bytes.subarray(0, extension === 'pdf' ? 5 : 2).toString(), extension === 'pdf' ? '%PDF-' : 'PK');
  if (extension === 'pdf') {
    const { viewer, nativeDownload } = await result;
    // The full browser renders its blob URL. Headless Shell has no PDF viewer
    // and emits a download from that same reserved popup instead.
    const outcome = await Promise.race([
      expect.poll(() => viewer.url(), { timeout: 10000 }).toMatch(/^blob:/).then(() => null),
      nativeDownload,
    ]);
    if (outcome) {
      assert.match(outcome.url(), /^blob:/);
      await outcome.saveAs(target);
      assert.deepEqual(fs.readFileSync(target), bytes);
    } else fs.writeFileSync(target, bytes);
    await viewer.close();
  } else {
    const download = await result;
    await download.saveAs(target);
    assert.deepEqual(fs.readFileSync(target), bytes, 'The native download retains the exact captured response');
  }
  return { reply, capture, bytes, target };
  } finally { await page.unroute(pattern, intercept); }
}
module.exports = { referenceExport };
