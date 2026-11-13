'use strict';
// Real UI against fixture-owned storage; no live projects or preferences touched.
const {chromium,expect}=require('@playwright/test');
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {openProjectSection,createNewProject}=require('./project_actions.cjs');
const {openCertificateEditor}=require('./certification_generation.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`settings-polish-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});
const python=process.env.CEASEFIRE_PYTHON||'python';
const server=spawn(python,[path.join(__dirname,'fixtures.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;server.stderr.on('data',chunk=>logs+=chunk);
const ready=new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);
  server.stdout.on('data',chunk=>{data+=chunk;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});
  server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}`));});});
const errors=[],checks=[];
async function idle(){await page.waitForFunction(()=>{const status=window.CeasefireDesktop?.status();return status?.ready&&!status.busy;});}
(async()=>{
  const info=await ready;assert.notEqual(info.port,8765);
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1254,height:831}});
  page.setDefaultTimeout(45000);page.on('pageerror',error=>errors.push(error.message));
  // Reproduce a slow language catalog. If the form started fetching during HTML
  // parsing, let that response update the status before localization runs.
  await page.route('**/language-catalog.js',async route=>{
    await page.waitForFunction(()=>document.readyState==='interactive' && !document.getElementById('company-name').disabled);
    await route.continue();
  });
  await page.goto(`http://127.0.0.1:${info.port}/`);await idle();await page.getByRole('button',{name:'Settings',exact:true}).click();
  await expect(page.locator('#company-settings-status')).toHaveText('Saved');
  await expect(page.locator('#view-settings #cover-sheets-settings')).toHaveCount(0);
  await expect(page.locator('#view-documentation #cover-sheets-settings')).toHaveCount(1);
  await expect(page.locator('#view-settings > section').last()).toHaveClass(/play-settings-card/);
  for(const width of [1254,390]){
    await page.setViewportSize({width,height:831});
    const geometry=await page.evaluate(()=>{
      const box=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,width:r.width,height:r.height};};
      return {logo:box('company-logo'),cover:box('company-cover-pdf'),trash:box('company-logo-delete'),preview:box('company-logo-preview'),coverTrash:box('company-cover-delete'),overflow:document.documentElement.scrollWidth-innerWidth};
    });
    assert.ok(Math.abs(geometry.logo.x-geometry.cover.x)<1);assert.ok(Math.abs(geometry.logo.width-geometry.cover.width)<1);
    assert.ok(geometry.cover.y>geometry.logo.y);assert.ok(geometry.coverTrash.x>=geometry.cover.right);
    assert.ok(geometry.preview.y>=geometry.logo.y+geometry.logo.height,'logo preview is below its upload');
    assert.ok(Math.abs(geometry.preview.x-geometry.logo.x)<1,'logo preview aligns with its upload');
    assert.ok(geometry.overflow<=1);await expect(page.locator('#company-cover-delete svg')).toHaveCount(1);
    await page.locator('#company-settings-form').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,`company-${width}.png`)});
  }
  checks.push('Play last; aligned uploads, adjacent trash and below-upload preview at desktop/mobile');
  await page.setViewportSize({width:1254,height:831});await page.locator('#theme-toggle').click();await expect(page.locator('html')).toHaveAttribute('data-theme','midnight');
  const logo=path.join(output,'midnight-logo.png');await page.locator('.app-header .brand').screenshot({path:logo});
  const pixels=spawnSync(python,['-c',"from PIL import Image; import sys; im=Image.open(sys.argv[1]).convert('RGB'); w,h=im.size; white=im.getpixel((round(w*205/2172),round(h*225/724))); red=im.getpixel((round(w*340/2172),round(h*225/724))); assert min(white)>230,white; assert red[0]>150 and red[1]<100 and red[2]<100,red; print('White mark and retained red square verified')",logo],{encoding:'utf8',windowsHide:true});
  assert.equal(pixels.status,0,pixels.stderr);checks.push(pixels.stdout.trim());
  for(const theme of ['midnight','ocean','forest','slate','ceasefire']){
    await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
    await expect(page.locator('#save-current-project')).toHaveCSS('background-color','rgb(208, 0, 27)');
    await expect(page.locator('#save-current-project')).toHaveCSS('color','rgb(255, 255, 255)');
    await page.locator('#theme-toggle').click();
  }
  checks.push('Red Save button in all five themes');
  await createNewProject(page,{client:'SYNTHETIC SETTINGS REVIEW'});
  assert.equal(await page.evaluate(()=>window.CeasefireProject.hasCreatedProject()),true);
  await openProjectSection(page,'documentation');
  const covered=page.locator('#documentation-pdf-rows tr[data-cover-kind]');
  const catalogResponse=await page.request.get(`http://127.0.0.1:${info.port}/api/pdf-covers`);
  await expect(catalogResponse).toBeOK();
  const catalog=await catalogResponse.json();
  const expectedKinds=catalog.items.map(item=>item.kind).sort();
  assert.ok(expectedKinds.length>0,'The PDF cover catalog contains document kinds');
  await expect.poll(()=>covered.evaluateAll(rows=>rows.map(row=>row.dataset.coverKind).sort())).toEqual(expectedKinds);
  for(const label of ['Schedules','Product summaries','Other documents'])await page.locator('#documentation-pdf-rows').getByRole('button',{name:label,exact:true}).click();
  for(const row of await covered.all()){
    await expect(row.locator('td').nth(2).getByRole('button')).toBeVisible();
    await expect(row.locator('td').nth(3).locator('input[type=file]')).toHaveCount(1);
    await expect(row.locator('td').nth(4).getByRole('button')).toHaveCount(1);
  }
  checks.push(`All ${expectedKinds.length} PDF cover rows match the catalog and contain the document controls`);
  await page.locator('#cover-sheets-heading').scrollIntoViewIfNeeded();
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.locator('#settings-play-button').scrollIntoViewIfNeeded();
  await page.locator('#company-logo').setInputFiles({name:'invalid.txt',mimeType:'text/plain',buffer:Buffer.from('invalid logo')});
  const alert=page.locator('#company-settings-status');await expect(alert).toContainText('Choose a PNG or JPEG');
  await expect.poll(()=>alert.evaluate(el=>{const box=el.getBoundingClientRect(),header=document.querySelector('.app-header').getBoundingClientRect();return box.top>=header.bottom+10&&box.bottom<=innerHeight;})).toBe(true);
  await page.screenshot({path:path.join(output,'error-revealed.png')});checks.push('Real upload validation error brought into view below sticky header');
  await page.locator('#settings-play-button').click();await expect(page.locator('#play-hub')).toBeVisible();
  await expect(page.locator('.play-hero-mark,.play-feed')).toHaveCount(0);await page.screenshot({path:path.join(output,'play-lobby.png')});
  await page.getByRole('button',{name:'Play FIRELINE',exact:false}).click();await expect(page.locator('#play-session')).toBeVisible();await expect(page.locator('#play-messages')).toHaveCount(0);
  await page.locator('#play-back').click();await page.getByRole('button',{name:'Back to Settings',exact:false}).click();
  await openProjectSection(page,'certification');
  await expect(page.locator('#certification-board')).toHaveCount(0);await expect(page.locator('#certification-editor')).toBeVisible();
  await openCertificateEditor(page);
  const signature=page.getByRole('button',{name:'Insert signature',exact:true});
  await expect(signature).toBeVisible();
  checks.push('FIRELINE opens and exits without badge or radio; compact signature canvas');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,errors},null,2));console.log('PASS Settings and Play polish: '+output);
})().catch(async error=>{console.error(error);console.error(logs);await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1;})
  .finally(async()=>{await browser?.close();server.kill();});
