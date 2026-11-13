// Geometry acceptance against disposable data; use the real responsive workspaces.
const {chromium,expect}=require('@playwright/test');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chooseCalculator}=require('./calculator_actions.cjs');
const {chooseTakeoff}=require('./section_navigation.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`workspace-layout-followups-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;
server.stderr.on('data',value=>logs+=value);
const ready=new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);server.stdout.on('data',value=>{text+=value;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.split('\n')[0]));}});server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}`));});});
const errors=[],evidence={firestopping:[],takeoffs:[],scheduler:[]};
async function idle(){await page.waitForFunction(()=>{const status=window.CeasefireDesktop?.status();return status?.ready&&!status.busy;});}
async function box(selector){return page.locator(selector).evaluate(element=>{const bounds=element.getBoundingClientRect();return{x:bounds.x,y:bounds.y,right:bounds.right,bottom:bounds.bottom,width:bounds.width,height:bounds.height};});}
async function noOverflow(context){const layout=await page.evaluate(()=>({document:document.documentElement.scrollWidth,viewport:document.documentElement.clientWidth}));assert.ok(layout.document<=layout.viewport+1,`${context}: ${JSON.stringify(layout)}`);}
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1915,height:884}});page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));
  const base=`http://127.0.0.1:${info.port}`;
  await page.goto(base+'/');await idle();
  await chooseCalculator(page,'Firestopping');await idle();
  const inputTabs=page.locator('#penetration-input-groups'),settings=inputTabs.getByRole('tab',{name:'Settings',exact:true}),details=inputTabs.getByRole('tab',{name:'DETAILS',exact:true});
  const fields=page.locator('#penetration-row-fields'),add=page.locator('#penetration-add-to-schedule');
  await expect(inputTabs.getByRole('tab').last()).toHaveId('penetration-settings');
  const gearArt=await settings.locator('svg').innerHTML();
  await expect(add).toHaveCSS('border-top-color','rgb(255, 255, 255)');
  for(const width of [1915,1011,631,390,320]){
    await page.setViewportSize({width,height:884});
    await details.focus();await details.press('End');await expect(settings).toBeFocused();
    await settings.press('Enter');await expect(settings).toHaveAttribute('aria-selected','true');
    await expect(fields).toHaveAccessibleName('Settings');
    const gear=await box('#penetration-settings'),tabs=await box('#penetration-input-groups');
    assert.ok(Math.abs(gear.bottom-tabs.bottom)<2,`Settings aligns with the input tabs at ${width}: ${JSON.stringify({gear,tabs})}`);
    assert.equal(gear.width,42);assert.equal(gear.height,42);assert.ok(gear.x>=tabs.x-1 && gear.right<=tabs.right+1,'Focused Settings stays visible inside the tab scroller');
    await expect(settings).toBeFocused();
    if([1915,390].includes(width))await inputTabs.screenshot({path:path.join(output,'firestopping-settings-tab-'+width+'.png')});
    await settings.press('Home');await expect(details).toBeFocused();await details.press('Space');
    await expect(fields).toHaveAccessibleName('DETAILS');await expect(settings).toHaveAttribute('aria-selected','false');
    await noOverflow('Firestopping/'+width);evidence.firestopping.push({width,gear,tabs});
  }
  await page.locator('#penetration-schedule-tab-breakdown').click();
  const breakdown=page.locator('#penetration-schedule-breakdown-card');
  await expect(breakdown).toHaveAccessibleName('Firestopping Breakdown');
  await expect(breakdown.getByRole('heading',{name:'Firestopping Breakdown'})).toHaveCount(0);
  await page.setViewportSize({width:1915,height:884});
  for(const mode of ['Steel','Duct','Walls/Floors','Defect Reports','Service Plans']){
    await chooseTakeoff(page,mode);await idle();
    for(const width of [1915,631,390,320]){
      await page.setViewportSize({width,height:884});await page.evaluate(()=>scrollTo(0,0));
      const heading=await box('.takeoff-workspace-heading'),view=await box('#view-takeoffs'),tabs=await box('#takeoff-pages'),header=await box('.app-header');
      assert.ok(heading.y-header.bottom>=0&&heading.y-header.bottom<=10,`Compact gap above ${mode} heading at ${width}: ${JSON.stringify({heading,header})}`);
      assert.ok(tabs.y-heading.bottom>=0&&tabs.y-heading.bottom<=10,`Compact gap below ${mode} heading at ${width}: ${JSON.stringify({heading,tabs})}`);
      assert.ok(Math.abs(heading.y-view.y)<1,'Heading starts at the Takeoffs workspace top');
      const actions=await box('.takeoff-document-tools');assert.ok(actions.right<=view.right+1&&actions.x>=view.x-1,'Heading actions remain within the workspace when wrapped');
      await noOverflow(mode+'/'+width);evidence.takeoffs.push({mode,width,heading,tabs,header,actions});
    }
    await page.setViewportSize({width:1915,height:884});
  }
  await page.locator('#scheduler-navigation').click();await page.locator('.scheduler-tabs').getByRole('button',{name:'Settings',exact:true}).click();
  assert.equal(await page.locator('.scheduler-settings-tab svg').innerHTML(),gearArt);
  await expect(page.locator('.scheduler-settings')).toBeVisible();
  for(const width of [1915,1011,631,390,320]){
    await page.setViewportSize({width,height:884});
    const settings=await box('.scheduler-settings'),rootBox=await box('#scheduler-root');
    assert.ok(Math.abs(settings.x-rootBox.x)<1&&Math.abs(settings.right-rootBox.right)<1,`Settings fills the page at ${width}: ${JSON.stringify({settings,rootBox})}`);
    await noOverflow('Scheduler/'+width);evidence.scheduler.push({width,settings,root:rootBox});
  }
  await page.setViewportSize({width:1915,height:884});await page.screenshot({path:path.join(output,'scheduler-full-width.png')});
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,evidence,errors},null,2));
  console.log(`PASS Workspace follow-up geometry. ${output}`);
})().catch(async error=>{console.error(error);if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.txt'),error.stack+'\n'+logs);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.kill();});
