// Observe the public temporary PDF viewer / native XLSX download contract.
// Artifact copies below belong to the disposable test fixture, not the project.
const assert = require('node:assert/strict'), fs = require('node:fs');
const path = require('node:path');
const { expect } = require('@playwright/test');

async function referenceExport(page, { extension, endpoint, action, target }) {
  // Capture the one real exporter response before it is handed to the client.
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
  const result = extension === 'pdf' ? page.waitForEvent('popup').then(value => {
    const nativeDownload = new Promise(resolve => value.once('download', resolve));
    return { viewer: value, nativeDownload };
  }) : null;
  response.catch(() => {}); result?.catch(() => {});
  await action();
  const reply = await response;
  assert.equal(reply.status(), 200);
  const capture = reply.request().postDataJSON(), headers = reply.request().headers();
  if (extension === 'pdf') assert.equal(capture.download, undefined, 'Temporary reference PDF viewing has no Project destination or save prerequisite');
  else {
    assert.deepEqual(Object.keys(capture.download), ['project_token'], 'Excel binds only its captured native destination capability');
    assert.ok(capture.download.project_token === null || typeof capture.download.project_token === 'string' && capture.download.project_token.length > 0,
      'Reference Excel accepts a captured Project token or its no-Project Downloads exception');
  }
  for (const key of ['x-estimator-documentation-workspace', 'x-estimator-documentation-request'])
    assert.equal(headers[key], undefined, 'Reference viewing/export does not create a project document revision');
  const media = extension === 'pdf' ? 'application/pdf' : 'application/json';
  assert.equal(reply.headers()['content-type'].split(';')[0], media);
  const deliveredBytes = await captured;
  let bytes;
  if (extension === 'pdf') {
    bytes = deliveredBytes;
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
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
    const receipt = JSON.parse(deliveredBytes.toString('utf8'));
    assert.equal(receipt.saved, true, 'Excel completion is confirmed by an actual native saved-file receipt');
    assert.equal(receipt.destination, capture.download.project_token === null ? 'downloads' : 'project');
    assert.equal(typeof receipt.filename, 'string'); assert.match(receipt.filename, /\.xlsx$/i);
    assert.equal(typeof receipt.path, 'string'); assert.equal(fs.statSync(receipt.path).isFile(), true);
    const relative = path.relative(path.resolve(path.dirname(target)), fs.realpathSync(receipt.path));
    assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep),
      'Native reference exports remain inside this disposable fixture');
    assert.equal(path.basename(receipt.path), receipt.filename);
    assert.match(receipt.download_url, /^\/api\/download-files\/[A-Za-z0-9_-]{32}$/);
    assert.equal(receipt.open_url, receipt.download_url + '/open');
    bytes = fs.readFileSync(receipt.path);
    assert.equal(bytes.subarray(0, 2).toString(), 'PK');
    fs.writeFileSync(target, bytes);
    assert.deepEqual(fs.readFileSync(target), bytes, 'The artifact copy retains the exact native workbook bytes');
  }
  return { reply, capture, bytes, target };
  } finally { await page.unroute(pattern, intercept); }
}
module.exports = { referenceExport };
