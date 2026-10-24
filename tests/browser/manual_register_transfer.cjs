// The user's manual Service -> editable Firestopping -> Save/Open workflow.
const {chromium,expect}=require('@playwright/test');
const {spawn}=require('node:child_process');
const {chooseTakeoff}=require('./section_navigation.cjs');
const {chooseCalculator}=require('./calculator_actions.cjs');
const {chooseNewPhysicalItem}=require('./physical_dialogs.cjs');
const {clickInspectorAdd}=require('./parent_controls_helpers.cjs');
const {clickProjectControl}=require('./project_actions.cjs');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`manual-transfer-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'project_library_fixture.py'),'--directory',output],{cwd:root,windowsHide:true});
let page,browser,logs='',info;const errors=[];
server.stderr.on('data',data=>logs+=data);
const ready=new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error(logs)),120000);server.stdout.on('data',chunk=>{text+=chunk;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.split('\n')[0]));}});server.once('error',reject);});
const inspector=()=>page.getByRole('complementary',{name:'Item Details',exact:true});
async function idle(){await page.waitForFunction(()=>window.CeasefireDesktop?.status().ready&&!window.CeasefireDesktop.status().busy);}
async function modal(title,fields,action){const dialog=page.getByRole('dialog');await expect(dialog.getByRole('heading',{name:title,exact:true})).toBeVisible();for(const [name,value]of Object.entries(fields)){const field=dialog.getByLabel(name,{exact:true});if(await field.evaluate(el=>el.tagName)==='SELECT')await field.selectOption(String(value));else await field.fill(String(value));}await dialog.getByRole('button',{name:action,exact:true}).click();}
async function response(action,suffix){const waiting=page.waitForResponse(reply=>new URL(reply.url()).pathname.endsWith(suffix));waiting.catch(()=>{});await action();const reply=await waiting;assert.equal(reply.status(),200,await reply.text());if(!suffix.endsWith('/preview'))await idle();return reply.json();}
async function create(kind,fields){if(kind==='barrier'){await page.getByRole('button',{name:'Add substrate',exact:true}).click();await chooseNewPhysicalItem(page,kind);}else await clickInspectorAdd(inspector(),'Add service in Item Details');const preview=await response(()=>modal(`Create draft ${kind}`,fields,'Preview new draft'),'/physical/preview');await response(()=>modal(`Create one draft ${kind}?`,{},'Apply draft change'),'/physical/apply');return preview.changed_ids[0];}
async function snapshot(){return page.evaluate(()=>window.CeasefirePenetrations.projectSnapshot());}
(async()=>{
 info=await ready;assert.notEqual(info.port,8765);browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1384,height:900}});page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));await page.goto(`http://127.0.0.1:${info.port}/`);await idle();
 await page.evaluate(()=>window.CeasefirePenetrations.completeProjectSnapshot());
 await page.getByRole('button',{name:'Takeoffs',exact:true}).click();await chooseTakeoff(page,'Service Plans');await idle();
 const barrier=await create('barrier',{'Barrier type':'Oversized core hole','Substrate':'Concrete/masonry wall','Substrate orientation':'Vertical','FRL':'-/120/120','Location':'MANUAL-L02'});
 const service=await create('service',{'Category':'Plumbing & Hydraulic','Service type':'Copper Pipes','Explicit service quantity':2,'Service Size (mm)':'600'});
 await page.locator(`tr[data-physical-id="${barrier}"] .takeoff-row-link`).click();await response(()=>inspector().getByLabel('Confirmation',{exact:true}).selectOption('confirmed'),'/physical/apply');
 const transferred=await response(()=>page.getByRole('button',{name:'Transfer to Firestopping Schedule',exact:true}).click(),'/library/transfer-confirmed');assert.equal(transferred.library_link.manual_transferred,1);assert.equal(transferred.library_link.transferred,1);
 const before=await snapshot(),row=before.draft.rows[0];assert.equal(row.takeoff_source.service_id,service);assert.equal(row.takeoff_source.service_size,'600');assert.equal(row.inputs.O,2);assert.equal(row.library_item_id,undefined);assert.equal(row.inputs.AL,undefined);
 await chooseCalculator(page,'Firestopping');await idle();const schedule=page.locator('details[aria-labelledby="penetration-estimator-schedule-heading"]');if(!await schedule.evaluate(el=>el.open))await schedule.locator(':scope > summary').click();await page.getByRole('button',{name:'Edit firestopping item 1',exact:true}).click();
 if(await page.getByRole('dialog').isVisible())await page.getByRole('dialog').getByRole('button',{name:'Edit item',exact:true}).click();
 for(const [column,value]of Object.entries({J:'Plumbing & Hydraulic',K:'Copper Pipes',L:'Oversized core hole',M:'Vertical',N:'-/120/120',P:'Concrete/masonry wall'}))await expect(page.locator(`#penetration-row-fields [data-penetration-field="${column}"]`)).toHaveValue(value);
 const qty=page.locator('#penetration-item-quantity [data-penetration-field="O"]');await expect(qty).toHaveValue('2.00');await qty.fill('7.123456789');await qty.press('Tab');await page.locator('#penetration-update-schedule').click();await expect(page.locator('#penetration-update-schedule')).toBeHidden();await idle();
 const edited=await snapshot();assert.equal(edited.draft.rows[0].inputs.O,7.123456789);assert.deepEqual(edited.draft.rows[0].takeoff_source,row.takeoff_source);
 await response(()=>clickProjectControl(page,'Save'),'/api/project/save-as');const project=JSON.parse(fs.readFileSync(info.project,'utf8'));assert.deepEqual(project.penetration.draft,edited.draft);
 await clickProjectControl(page,'Load');await modal('Load this project?',{},'Load Project');await idle();assert.deepEqual((await snapshot()).draft,edited.draft);
 await chooseTakeoff(page,'Service Plans');const retry=page.waitForResponse(reply=>reply.url().endsWith('/library/transfer-confirmed'));await page.getByRole('button',{name:'Transfer to Firestopping Schedule',exact:true}).click();assert.equal((await retry).status(),400);assert.deepEqual((await snapshot()).draft,edited.draft);
 assert.deepEqual(errors,[]);await page.screenshot({path:path.join(output,'manual-transfer.png')});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,barrier,service,row:edited.draft.rows[0],errors},null,2));console.log(`PASS manual register transfer, known-value editor, precision, duplicate guard and project round trip: ${output}`);
})().catch(async error=>{console.error(error.stack);console.error(logs.slice(-3000));await page?.screenshot({path:path.join(output,'failure.png')});process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill();});
