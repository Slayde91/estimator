'use strict';

const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {createInterface} = require('node:readline');
const fs = require('node:fs'), path = require('node:path');
const {chromium, expect: baseExpect} = require('@playwright/test');
const {createNewProject, openProjectSection} = require('./project_actions.cjs');
const expect = baseExpect.configure({timeout:20000});
const root = path.resolve(__dirname,'../..');
const output = path.join(root,'.runtime/browser-qa','work-order-costs-'+Date.now());
fs.mkdirSync(output,{recursive:true});
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let browser, page, logs='';
server.stderr.on('data',chunk=>{logs+=chunk;});
const button = (host,name) => host.getByRole('button',{name,exact:true});
async function test() {
  const [line] = await once(createInterface({input:server.stdout}),'line',{signal:AbortSignal.timeout(90000)});
  const {port} = JSON.parse(line), base='http://127.0.0.1:'+port;
  assert.notEqual(port,8765);
  browser=await chromium.launch();
  const context=await browser.newContext({viewport:{width:1600,height:960}});
  page=await context.newPage();
  const errors=[]; page.on('pageerror', error=>errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready);
  await createNewProject(page);
  const quote=page.locator('#commercial-quote-root'), wo=page.locator('#commercial-work-order-root');
  const po=page.locator('#commercial-purchase-order-root');
  async function save(host,pdf=false) {
    await button(host.locator('.commercial-editor-actions'),pdf?'Download PDF':'Save').click();
    await expect(host.locator('.commercial-message')).toContainText(pdf?'PDF saved':'Document saved.');
  }
  await openProjectSection(page,'quote'); await button(quote,'New Quote').click();
  await button(quote,'Add custom row').click();
  const lineItem=quote.locator('.commercial-lines tbody tr').last();
  await lineItem.getByRole('combobox').fill('Site works');
  await lineItem.locator('input').last().fill('100');
  await save(quote,true);
  await openProjectSection(page,'work-orders'); await button(wo,'New Work Order').click();
  const quoteSelect=wo.getByLabel('Linked Quote',{exact:true});
  await quoteSelect.selectOption(await quoteSelect.locator('option:not([value=""])').first().getAttribute('value'));
  await wo.getByLabel('Estimated cost (AUD)',{exact:true}).fill('200');
  await save(wo);
  await openProjectSection(page,'purchase-orders'); await button(po,'New Purchase Order').click();
  const link=po.getByLabel('Linked Work Order',{exact:true});
  await link.selectOption(await link.locator('option:not([value=""])').first().getAttribute('value'));
  await button(po,'Add line item').click();
  const row=po.locator('.commercial-lines tbody tr').last();
  await row.locator('.commercial-line-description').fill('Materials');
  await row.locator('td').nth(2).locator('input').fill('50');
  await save(po);
  async function api(action,body) {
    const response=body ? await page.request.post(base+'/api/scheduler/'+action,{data:body}) : await page.request.get(base+'/api/scheduler/'+action);
    assert.equal(response.status(),200,await response.text());
    return response.json();
  }
  const worker=await api('members/save',{name:'Worker',email:'worker@example.test',password:'test worker password',base_rate:'0'});
  const order=(await api('work-orders')).orders[0];
  await api('entries/save',{member_id:worker.id,start:'2020-11-02T13:00',end:'2020-11-02T14:00',
    work_order:{id:order.id,revision:order.revision}});
  const query = new URLSearchParams({file:order.source_id,project:order.project_id,revision:order.revision,document:order.document_id});
  const costsURL = () => base+'/api/commercial/work-order-labour?'+query;
  // Exercise the saved-file route too. The UI below uses the active workspace route.
  assert.equal((await (await page.request.get(costsURL())).json()).amount, '0.00');
  query.set('revision','0'.repeat(64)); assert.ok(!(await page.request.get(costsURL())).ok());
  query.set('revision',order.revision);
  query.set('document','00000000-0000-4000-8000-000000000000'); assert.ok(!(await page.request.get(costsURL())).ok());
  await openProjectSection(page,'work-orders');
  await wo.locator('article.commercial-card .project-title-button').first().click();
  const costs=wo.locator('.commercial-sidebar').last().locator('.work-order-costs');
  await expect(costs.locator('li')).toHaveText(['Remaining estimate$145.00','Purchase orders$55.00','Time entries$0.00']);
  await expect(costs.getByText('Some linked time entries have an hourly rate of $0.00.')).toBeVisible();
  const scheduler = await context.newPage();
  scheduler.on('pageerror', error=>errors.push(error.message));
  await scheduler.goto(base);
  await scheduler.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready);
  await scheduler.locator('#settings-navigation-toggle').hover();
  await button(scheduler.locator('#settings-navigation-menu'),'Settings').click();
  await button(scheduler.locator('.scheduler-team .card').filter({hasText:worker.email}),'Edit member').click();
  const editor = scheduler.getByRole('dialog');
  await editor.getByLabel('Base hourly rate (AUD)').fill('40');
  await button(editor,'Save member').click();
  await expect(editor).toHaveCount(0);
  query.set('document',order.document_id);
  assert.deepEqual(await (await page.request.get(costsURL())).json(), {amount:'60.00'});
  await expect(costs.getByText('Some linked time entries have an hourly rate of $0.00.')).toHaveCount(0);
  await expect(costs.locator('li')).toHaveText(['Remaining estimate$85.00','Purchase orders$55.00','Time entries$60.00']);
  await scheduler.close();
  await page.bringToFront();
  const slice=costs.locator('svg .work-cost-orders');
  await slice.scrollIntoViewIfNeeded();
  // Hit the sector interior even if a sector's bounding box includes neighbouring slices.
  const xy=await slice.evaluate(s=>{
    const svg=s.ownerSVGElement,r=svg.getBoundingClientRect(),angle=2*Math.PI*(85+27.5)/200-Math.PI/2;
    return {x:r.x+r.width/2+Math.cos(angle)*r.width*.32,y:r.y+r.height/2+Math.sin(angle)*r.height*.32};
  });
  await page.mouse.move(xy.x,xy.y);
  await expect(costs.locator('.work-cost-tooltip')).toHaveText('Purchase orders: 27.5% - $55.00');
  await expect(costs.locator('.work-cost-tooltip')).toBeVisible();
  await costs.locator('svg .work-cost-time').focus();
  await expect(costs.locator('.work-cost-tooltip')).toHaveText('Time entries: 30% - $60.00');
  await wo.getByLabel('Estimated cost (AUD)',{exact:true}).fill('100');
  await expect(costs.locator('.work-cost-loss')).toHaveText('Loss -$15.00');
  await expect(costs.locator('svg .work-cost-remaining')).toHaveCount(0);
  await costs.screenshot({path:path.join(output,'overrun.png')});
  // Refresh the workspace with the same PO in three non-chargeable states:
  // cancelled, linked to another order, and unlinked. None may change the cost.
  let refreshed=false;
  await page.route(/\/api\/commercial\/state\?/, async route=>{
    const original=await route.fetch(), state=await original.json();
    const linked=state.documents.find(row=>row.kind==='purchase_order');
    if (linked) {
      for (const [id,status,workId] of [['cancelled','Cancelled',linked.fields.order.work_order_id],
           ['other','Draft','another-work-order'],['unlinked','Draft','']]) {
        const extra=structuredClone(linked); extra.id=id; extra.status=status; extra.fields.order.work_order_id=workId;
        state.documents.push(extra);
      }
      refreshed=true;
    }
    await route.fulfill({response:original,json:state});
  });
  await button(wo,'Refresh Records').click();
  await expect.poll(()=>refreshed).toBe(true);
  await expect(costs.locator('li')).toHaveText(['Remaining estimate$0.00','Purchase orders$55.00','Time entries$60.00']);
  assert.deepEqual(errors,[]);
  console.log('PASS scoped Work Order costs, hover, keyboard and overrun: '+output);
}
test().catch(async error=>{console.error(error.stack,logs);if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1;})
  .finally(async()=>{await browser?.close();server.kill();});
