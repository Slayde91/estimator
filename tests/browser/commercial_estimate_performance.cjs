// A real 1,000-row schedule: adding an estimate must not recalculate unchanged
// scopes, while changed captured inputs must invalidate the editor-local cache.
const {chromium, expect: baseExpect} = require('@playwright/test');
const {spawn, execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {clickProjectControl, openProjectSection} = require('./project_actions.cjs');
const expect = baseExpect.configure({timeout:60000});
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', `commercial-estimate-performance-${Date.now()}`);
fs.mkdirSync(output, {recursive:true});
const python = process.env.CEASEFIRE_PYTHON || 'python';
const server = spawn(python, [path.join(__dirname, 'fixtures.py'), '--directory', output], {cwd:root, windowsHide:true});
let logs = '', browser, page;
server.stderr.on('data', value => logs += value);
const ready = new Promise((resolve, reject) => {
  let text = '';
  const timer = setTimeout(() => reject(Error(logs || 'Fixture timeout')), 120000);
  server.stdout.on('data', value => {text += value; if (text.includes('\n')) {clearTimeout(timer); resolve(JSON.parse(text.split('\n')[0]));}});
  server.once('error', reject);
  server.once('exit', code => {clearTimeout(timer); reject(Error(`Fixture exited ${code}`));});
});
async function idle() {
  await page.waitForFunction(() => {const state=window.CeasefireDesktop?.status(); return state?.ready && !state.busy;});
}
const calls = [], errors = [], timings = {};
(async () => {
  const info = await ready;
  assert.notEqual(info.port, 8765);
  execFileSync(python, ['-c', `import json, sys
from pathlib import Path
from estimator.storage import Store
from estimator.project_file import export_project
target=Path(sys.argv[1])
store=Store(target.parent/'large-quote-seed.sqlite3')
cells={}
for index in range(1000):
 row=10+index
 cells.update({f'A{row}':f'PerformanceMember{index}',f'AA{row}':'Level 1',f'B{row}':'CAFCO 300',f'C{row}':'Re-entrant - 3 sides',f'D{row}':620,f'E{row}':'Section',f'F{row}':'410UB54',f'H{row}':120,f'I{row}':2,f'J{row}':3})
def workspace(calculators):
 data=json.loads(export_project(store,{'estimate':{'title':'Performance fixture'},'calculators':calculators}))
 return {'estimate':data['estimate'],'calculators':{key:{'inputs':value['inputs'],'schedule_rows':value['schedule_rows']} for key,value in data['calculators'].items()}}
large=workspace({'steel_vermiculite':{'inputs':{'SCHEDULE':cells}}})
small=workspace({})
target.write_bytes(export_project(store,{**large,'estimates':[{'id':'estimate-1','name':'Large estimate','workspace':large},{'id':'estimate-22222222222222222222222222222222','name':'Additional estimate','workspace':small}],'active_estimate_id':'estimate-1'}))`, info.project], {cwd:root, windowsHide:true, timeout:120000});
  browser = await chromium.launch({headless:true});
  page = await browser.newPage({viewport:{width:1440,height:1000}});
  page.setDefaultTimeout(60000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {if (request.url().endsWith('/api/commercial/derive')) calls.push(request.postDataJSON().selected_ids);});
  await page.goto(`http://127.0.0.1:${info.port}/`);
  await idle();
  await clickProjectControl(page, 'Load');
  await page.locator('#discard-dialog').getByRole('button', {name:'Load Project', exact:true}).click();
  await idle();
  await openProjectSection(page, 'quote');
  const quote = page.locator('#commercial-quote-root');
  let started=Date.now();
  await quote.getByRole('button', {name:'New Quote', exact:true}).click();
  await expect(quote.locator('.commercial-lines tbody tr')).toHaveCount(1);
  await expect(quote.getByRole('button',{name:'Save',exact:true})).toBeEnabled();
  timings.initialLargeEstimateMs=Date.now()-started;
  assert.deepEqual(calls, [['estimate-1']]);
  await expect(quote.locator('.commercial-scope tbody tr')).toHaveCount(0);
  await quote.locator('.commercial-estimate-picker summary').click();
  started=Date.now();
  await quote.getByRole('checkbox',{name:'Additional estimate',exact:true}).check();
  await expect(quote.locator('.commercial-lines tbody tr')).toHaveCount(2);
  await expect(quote.getByRole('button',{name:'Save',exact:true})).toBeEnabled();
  timings.addSmallEstimateMs=Date.now()-started;
  assert.deepEqual(calls, [['estimate-1'], ['estimate-22222222222222222222222222222222']]);
  for (const checked of [false, true]) {
    await quote.getByRole('checkbox',{name:'Additional estimate',exact:true}).setChecked(checked);
    await expect(quote.locator('.commercial-lines tbody tr')).toHaveCount(checked ? 2 : 1);
    await expect(quote.getByRole('button',{name:'Save',exact:true})).toBeEnabled();
  }
  assert.equal(calls.length, 2, 'Unchanged deselect/reselect reuses exact captured inputs');
  await quote.locator('.commercial-scope details summary').first().click();
  await expect(quote.locator('.commercial-scope tbody tr')).toHaveCount(1000);
  await expect(quote.locator('.commercial-scope tbody')).toContainText('PerformanceMember999');
  // Simulate edited captured inputs in the same open editor. The real server
  // still validates/recalculates; only the unchanged second estimate is reused.
  await page.evaluate(() => {
    const original=window.CeasefireEstimates.capture;
    window.CeasefireEstimates.capture=async (...args) => {
      const captured=await original(...args);
      captured.estimates.find(item=>item.id==='estimate-1').workspace.estimate.inputs.B28=123;
      return captured;
    };
  });
  await quote.getByRole('checkbox',{name:'Additional estimate',exact:true}).uncheck();
  await expect(quote.locator('.commercial-lines tbody tr')).toHaveCount(1);
  await expect(quote.getByRole('button',{name:'Save',exact:true})).toBeEnabled();
  assert.deepEqual(calls.at(-1), ['estimate-1'], 'Changed captured inputs recalculate the large estimate');
  assert.equal(calls.length, 3);
  await quote.getByLabel('Ordinary time',{exact:true}).fill('145.5');
  await quote.getByLabel('Accepted by',{exact:true}).fill('Performance reviewer');
  await quote.getByRole('button',{name:'Save',exact:true}).click();
  await expect(quote.locator('.commercial-message')).toContainText('Document saved.');
  await quote.getByLabel('Ordinary time',{exact:true}).fill('146.75');
  await quote.getByRole('button',{name:'Save',exact:true}).click();
  await expect(quote.locator('.commercial-message')).toContainText('Document saved.');
  await quote.getByRole('button',{name:'Back to Quotes',exact:true}).click();
  await quote.locator('.commercial-card-menu summary').click();
  await quote.getByRole('button',{name:'Open',exact:true}).click();
  await expect(quote.getByLabel('Ordinary time',{exact:true})).toHaveValue('146.75');
  await expect(quote.getByLabel('Accepted by',{exact:true})).toHaveValue('Performance reviewer');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,timings,calls,errors},null,2));
  console.log(`PASS commercial estimate performance: ${output} ${JSON.stringify(timings)}`);
})().catch(async error => {
  console.error(error);
  if(page) await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});
  process.exitCode=1;
}).finally(async()=>{await browser?.close();server.kill();fs.writeFileSync(path.join(output,'server.log'),logs);});
