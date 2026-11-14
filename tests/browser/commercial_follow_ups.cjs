const {checkRecordTrim}=require('./record_sidebar_trim.cjs');
'use strict';

// Exercise portable document actions and the due-marker dialog in a disposable Project.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { chromium, expect: playwrightExpect } = require('@playwright/test');
const { createNewProject, openProjectSection } = require('./project_actions.cjs');

const expect = playwrightExpect.configure({ timeout: 20000 });
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', 'commercial-follow-ups-' + Date.now());
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], {
  cwd: root, windowsHide: true
});
let logs = '', browser, page, info;
server.stderr.on('data', chunk => { logs += chunk; });

const button = (pane, name) => pane.getByRole('button', { name, exact: true });
const field = (pane, label) => pane.getByLabel(label, { exact: true });
async function test() {
  const lines=createInterface({input:server.stdout});
  const [line]=await once(lines,'line',{signal:AbortSignal.timeout(90000)});
  info=JSON.parse(line);assert.notEqual(info.port,8765);
  browser=await chromium.launch({headless:true});
  page=await browser.newPage({viewport:{width:1440,height:980}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+info.port);
  const ready=()=>page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready && !window.CeasefireProject.hasPendingOperation());
  await ready(); await createNewProject(page);
  const results=[];
  for(const [kind,section,id,name] of [['quote','quote','quote','Quote'],['work_order','work-orders','work-order','Work Order'],['purchase_order','purchase-orders','purchase-order','Purchase Order']]) {
    await openProjectSection(page,section); const pane=page.locator('#commercial-'+id+'-root');
    await button(pane,'New '+name).click();
    if(kind==='quote'){
      await button(pane,'Add custom row').click();
      const line=pane.locator('.commercial-lines tbody tr').last();
      await line.getByRole('combobox').fill('On-site check');await line.locator('input').last().fill('100');
    }
    if(kind==='work_order'){
      const choice=field(pane,'Linked Quote');
      await choice.selectOption(await choice.locator('option:not([value=""])').first().getAttribute('value'));
    }
    await checkRecordTrim(page,pane.locator('.commercial-work-layout'),kind,output);
    const form=pane.locator('.commercial-details .commercial-follow-ups'),rows=form.locator('.follow-up-action-row');
    async function fillRow(row,note,date){
      await field(row,'Next action').fill(note);await field(row,'Follow-up date').fill(date);
    }
    await fillRow(rows.first(),name+' earlier reminder','2020-01-03');
    await button(form,'Add follow-up').click();
    await fillRow(rows.last(),name+' next visit','2099-01-04');
    await button(pane.locator('.commercial-editor-actions'),kind==='quote'?'Download PDF':'Save').click();
    await expect(pane.locator('.commercial-message')).toContainText(kind==='quote'?'PDF saved':'Document saved.');
    await button(pane,'Back to '+name+'s').click();
    const card=pane.locator('article.commercial-card').first();
    await expect(card.locator('dl')).toContainText(name+' next visit'); await expect(card.locator('dl')).toContainText('2099-01-04');
    const warning=card.getByRole('button',{name:'Follow-up due',exact:true});
    await expect(warning).toBeVisible();
    const marker=await warning.boundingBox(),menu=await card.locator('.commercial-card-menu summary').boundingBox();
    assert.ok(marker.x+marker.width<=menu.x+1);
    await warning.focus();await warning.press('Enter');
    const dialog=page.locator('dialog[open]').filter({has:page.locator('.follow-up-action-list')});
    const actions=dialog.locator('.follow-up-action-row');
    await expect(actions).toHaveCount(2);await expect(field(actions.first(),'Next action')).toHaveValue(name+' earlier reminder');
    await field(actions.last(),'Follow-up status').selectOption('Completed');
    await expect(actions).toHaveCount(1);
    await button(dialog,'Save').click();await expect(dialog).toHaveCount(0);
    await expect(warning).toBeVisible();await expect(warning).toBeFocused();await warning.click();
    await expect(actions).toHaveCount(1);await expect(field(actions.first(),'Next action')).toHaveValue(name+' earlier reminder');
    await field(actions.first(),'Follow-up status').selectOption('Canceled');
    await expect(actions).toHaveCount(0);
    await button(dialog,'Save').click();await expect(dialog).toHaveCount(0);
    await expect(warning).toHaveCount(0);
    await expect(card.locator('.project-title-button')).toBeFocused();
    await card.locator('.project-title-button').click();await expect(rows).toHaveCount(2);
    await expect(field(rows.first(),'Follow-up status')).toHaveValue('Canceled');await expect(field(rows.last(),'Follow-up status')).toHaveValue('Completed');
    await expect(field(rows.last(),'Next action')).not.toBeEditable();
    const history=pane.locator('.record-activity-history');await history.locator('summary').click();
    await expect(history.locator('ol')).toContainText('Follow-up canceled');await expect(history.locator('ol')).toContainText(name+' next visit');
    const saved=JSON.parse(fs.readFileSync(info.project,'utf8')).commercial_documents.documents.find(doc=>doc.kind===kind);
    assert.deepEqual(saved.follow_up.actions.map(row=>row.status),['Canceled','Completed']);assert.equal(saved.follow_up.history.length,2);
    results.push({kind,actions:saved.follow_up.actions.length,history:saved.follow_up.history.length});
    await button(pane,'Back to '+name+'s').click();
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,results},null,2));
  console.log('PASS commercial document follow-ups: '+output);
}
test().catch(async error=>{console.error(error.stack);if(logs)console.error(logs);if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1;})
  .finally(async()=>{await browser?.close();server.kill();});
