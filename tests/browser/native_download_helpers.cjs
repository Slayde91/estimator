const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

// Use the real header Save and fixture-owned native dialog before editing a
// downloadable draft. The production app no longer has an unsaved fallback.
async function ensureSavedProject(page) {
  await page.waitForFunction(()=>{const state=window.CeasefireDesktop?.status();return state?.ready&&!state.busy;},null,{timeout:180000});
  if(await page.evaluate(()=>{try{return !!window.CeasefireProject.downloadTarget().project_token;}catch{return false;}}))return;
  const pending=page.waitForResponse(response=>response.request().method()==='POST'&&/\/api\/project\/save(?:-as)?$/.test(new URL(response.url()).pathname),{timeout:180000});
  pending.catch(()=>{});await page.locator('#save-current-project').click();const response=await pending;
  assert.equal(response.status(),200,await response.text());const saved=await response.json();assert.equal(saved.cancelled,false);assert.ok(saved.file?.save_token);
  await page.waitForFunction(()=>{const state=window.CeasefireDesktop.status();return state.ready&&!state.busy;},null,{timeout:180000});
}

// Observe the real saved-file receipt. No browser download event, fake response,
// native dialog or altered exporter is needed for project-bound document saves.
function waitForTakeoffDownload(page) {
  const pending = page.waitForResponse(response => {
    const request = response.request();
    return request.method() === 'POST' && /\/api\/takeoffs\/sessions\/[^/]+\/(?:physical\/)?export\//.test(new URL(response.url()).pathname)
      && request.postDataJSON()?.download;
  }, {timeout:180000}).then(async response => {
    const receipt = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(receipt));
    assert.match(response.headers()['content-type'], /^application\/json/);
    assert.ok(response.request().headers()['x-estimator-download-progress'], 'Actual native save tracks server progress');
    assert.equal(receipt.saved, true); assert.equal(receipt.destination, 'project');
    assert.equal(typeof receipt.path, 'string'); assert.equal(typeof receipt.filename, 'string');
    const source = path.resolve(receipt.path), stat = fs.statSync(source);
    assert.ok(stat.isFile() && stat.size > 0, 'Receipt identifies an actually saved regular file');
    await page.waitForFunction(()=>{const state=window.CeasefireDesktop?.status();return state?.ready&&!state.busy;},null,{timeout:180000});
    return { receipt, response,
      failure: async () => null,
      suggestedFilename: () => receipt.filename,
      saveAs: async target => { if (path.resolve(target) !== source) fs.copyFileSync(source, target); },
    };
  });
  pending.catch(() => {});
  return pending;
}

module.exports = { waitForTakeoffDownload, ensureSavedProject };
