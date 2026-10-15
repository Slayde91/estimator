const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

// Observe the real saved-file receipt. No browser download event, fake response,
// native dialog or altered exporter is needed for project-bound document saves.
function waitForTakeoffDownload(page) {
  const pending = page.waitForResponse(response => {
    const request = response.request();
    return request.method() === 'POST' && /\/api\/takeoffs\/sessions\/[^/]+\/(?:physical\/)?export\//.test(new URL(response.url()).pathname)
      && request.postDataJSON()?.download;
  }).then(async response => {
    const receipt = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(receipt));
    assert.match(response.headers()['content-type'], /^application\/json/);
    assert.ok(response.request().headers()['x-estimator-download-progress'], 'Actual native save tracks server progress');
    assert.equal(receipt.saved, true); assert.ok(['downloads', 'project'].includes(receipt.destination));
    assert.equal(typeof receipt.path, 'string'); assert.equal(typeof receipt.filename, 'string');
    const source = path.resolve(receipt.path), stat = fs.statSync(source);
    assert.ok(stat.isFile() && stat.size > 0, 'Receipt identifies an actually saved regular file');
    return { receipt, response,
      failure: async () => null,
      suggestedFilename: () => receipt.filename,
      saveAs: async target => { if (path.resolve(target) !== source) fs.copyFileSync(source, target); },
    };
  });
  pending.catch(() => {});
  return pending;
}

module.exports = { waitForTakeoffDownload };
