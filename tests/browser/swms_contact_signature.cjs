const {chromium,expect:baseExpect}=require('@playwright/test');
const expect=baseExpect.configure({timeout:30000});
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {openProjectSection,clickProjectControl,prepareProjectForSave}=require('./project_actions.cjs');

// Real app and signature pad, backed by a private temporary project. No live
// project, shared Personal Details profile or signature template is modified.
async function contactSignature(root,output){
  const directory=path.join(output,'contact-signature');
  const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'swms_fixture.py'),'--directory',directory,'--edition','full'],{cwd:root,windowsHide:true});
  let logs='',browser;
  server.stderr.on('data',value=>logs+=value);
  try{
    const info=await new Promise((resolve,reject)=>{
      let data='';const timer=setTimeout(()=>reject(Error(logs||'Fixture timeout')),120000);
      server.stdout.on('data',value=>{data+=value;if(data.includes('\n')){clearTimeout(timer);resolve(JSON.parse(data.split('\n')[0]));}});
      server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}`));});
    });
    assert.notEqual(info.port,8765);
    browser=await chromium.launch({headless:true});
    const page=await browser.newPage({viewport:{width:1915,height:884}}),errors=[],writes=[],reads=[];
    const base=`http://127.0.0.1:${info.port}`;
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{
      const route=new URL(request.url()).pathname;
      if(['/api/certifications/defaults','/api/company-settings','/api/swms/people-defaults'].includes(route)&&request.method()==='POST')writes.push(route);
      if(['/api/certifications/defaults','/api/company-settings','/api/scheduler/bootstrap'].includes(route)&&request.method()==='GET')reads.push(route);
    });
    await page.goto(base);await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready);
    await prepareProjectForSave(page);
    const firstSave=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/project/save-as');
    await clickProjectControl(page,'Save');assert.equal((await firstSave).status(),200);
    await page.waitForFunction(()=>{const status=window.CeasefireDesktop?.status();return status?.ready&&!status.busy;});
    const profile=await (await page.request.get(base+'/api/certifications/defaults')).json();
    const settings={name:'Contact signer',position:'Site supervisor',qualification:'Personal qualification',accreditation:'Personal accreditation'};
    const saveProfile=await page.request.post(base+'/api/certifications/defaults',{data:{fields:settings,expected_version:profile.version}});
    assert.equal(saveProfile.status(),200,await saveProfile.text());
    const company=await (await page.request.get(base+'/api/company-settings')).json();
    const saveCompany=await page.request.post(base+'/api/company-settings',{data:{...company,phone:'0400 123 456'}});
    assert.equal(saveCompany.status(),200,await saveCompany.text());
    writes.length=0;
    await openProjectSection(page,'swms');const host=page.locator('#swms-root');
    await host.getByRole('button',{name:'New SWMS',exact:true}).click();
    const contact=host.locator('.swms-contact-field');
    const name=host.getByLabel('Contact Person',{exact:true}),position=host.getByLabel('Position',{exact:true}).first(),phone=host.getByLabel('Phone',{exact:true});
    const snapshot=()=>page.evaluate(()=>JSON.parse(window.CeasefireSWMS.projectFingerprint()).editor.fields);
    const idle=()=>expect(host.getByRole('button',{name:'Save',exact:true}).first()).toBeEnabled();
    async function sign(){
      await contact.getByRole('button',{name:/^(Draw|Replace) signature$/}).click();
      const dialog=page.getByRole('dialog',{name:'Signatures',exact:true}),pad=await dialog.getByLabel('Signature drawing pad').boundingBox();
      await page.mouse.move(pad.x+30,pad.y+60);await page.mouse.down();
      await page.mouse.move(pad.x+130,pad.y+20,{steps:5});await page.mouse.move(pad.x+160,pad.y+70,{steps:5});await page.mouse.up();
      await dialog.getByRole('button',{name:'Insert signature',exact:true}).click();
    }
    async function unchangedAfterSign(expected,message){await idle();assert.deepEqual(await snapshot(),expected,message);}
    await expect(name).toHaveValue('');await expect(position).toHaveValue('');await expect(phone).toHaveValue('');
    assert.equal((await snapshot()).contact_signature,null);
    await name.fill('Manual contact');await position.fill('Manual position');await phone.fill('Manual phone');
    await host.getByLabel('Contact',{exact:true}).fill('Unrelated manager contact');
    const manual=await snapshot(),beforeCancel=reads.filter(route=>route==='/api/certifications/defaults').length;
    await contact.getByRole('button',{name:'Draw signature',exact:true}).click();
    await page.getByRole('dialog',{name:'Signatures',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();
    await unchangedAfterSign(manual,'Cancel keeps manual contact fields and ink unchanged.');
    assert.equal(reads.filter(route=>route==='/api/certifications/defaults').length,beforeCancel);

    await page.route('**/api/company-settings',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"Unavailable"}'}),{times:1});
    await sign();await expect(host.locator('.swms-message')).toContainText('Company details could not be loaded');
    await unchangedAfterSign(manual,'Failed Settings read cannot partly fill Contact Person.');

    let changedProfile=false;
    await page.route('**/api/scheduler/bootstrap',async route=>{
      if(!changedProfile)return route.continue();
      const response=await route.fetch(),body=await response.json();body.user={...(body.user||{}),id:'different-signature-profile'};
      await route.fulfill({response,json:body});
    });
    await page.route('**/api/certifications/defaults',async route=>{
      const response=await route.fetch();changedProfile=true;await route.fulfill({response});
    },{times:1});
    await sign();await expect(host.locator('.swms-message')).toContainText('Your signature profile changed');
    await unchangedAfterSign(manual,'A profile switch after drawing cannot mix ink with another signer.');
    await page.unroute('**/api/scheduler/bootstrap');
    changedProfile=false;

    await sign();await expect(contact.getByRole('img',{name:'Contact person drawn signature',exact:true})).toBeVisible();
    await expect(name).toHaveValue(settings.name);await expect(position).toHaveValue(settings.position);await expect(phone).toHaveValue('0400 123 456');
    await expect(host.getByLabel('Contact',{exact:true})).toHaveValue('Unrelated manager contact');
    assert.deepEqual(reads.slice(-2),['/api/company-settings','/api/scheduler/bootstrap'],'Settings reads finish before the final profile guard.');
    const signed=await snapshot();assert.ok(signed.contact_signature.strokes.length);
    const back=host.getByRole('button',{name:'Back to Documents',exact:true}).first();
    const geometry=await back.evaluate(button=>{
      const box=button.getBoundingClientRect(),icon=button.querySelector('.button-symbol'),glyph=icon.getBoundingClientRect();
      return {width:box.width,height:box.height,text:icon.textContent,fontSize:getComputedStyle(icon).fontSize,centerX:glyph.x+glyph.width/2-box.x-box.width/2,centerY:glyph.y+glyph.height/2-box.y-box.height/2};
    });
    assert.equal(geometry.width,42);assert.equal(geometry.height,42);assert.equal(geometry.text,'←');assert.equal(geometry.fontSize,'18px');
    assert.ok(Math.abs(geometry.centerX)<1&&Math.abs(geometry.centerY)<1,'The retained commercial arrow glyph is centered in its42px Back control');
    for(const width of [1915,850,600,390]){
      await page.setViewportSize({width,height:884});await name.scrollIntoViewIfNeeded();
      const layout=await contact.evaluate(field=>{
        const input=field.querySelector('input').getBoundingClientRect(),button=field.querySelector('button').getBoundingClientRect(),box=field.getBoundingClientRect();
        return {right:input.right,left:button.left,inputY:input.y+input.height/2,buttonY:button.y+button.height/2,buttonRight:button.right,fieldRight:box.right,overflow:field.scrollWidth>field.clientWidth};
      });
      assert.ok(layout.left>=layout.right&&Math.abs(layout.inputY-layout.buttonY)<1,`Signature button stays right of Contact Person at ${width}px.`);
      assert.ok(layout.buttonRight<=layout.fieldRight+1&&!layout.overflow,`Contact signature does not overflow at ${width}px.`);
      if(width===390||width===1915)await page.screenshot({path:path.join(directory,`contact-${width}.png`)});
    }
    await page.setViewportSize({width:1915,height:884});
    await host.getByRole('button',{name:'Save',exact:true}).first().click();await expect(host.locator('.swms-message')).toContainText('Saved.');
    const save=page.waitForResponse(response=>/\/api\/project\/save(?:-as)?$/.test(new URL(response.url()).pathname));
    await clickProjectControl(page,'Save');assert.equal((await save).status(),200);
    const portable=JSON.parse(fs.readFileSync(info.project,'utf8'));
    assert.deepEqual(portable.swms.documents[0].fields.contact_signature,signed.contact_signature);
    await require('./swms_actions.cjs').prepareSwmsForIssue(page);
    const issue=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/swms/issue');
    await host.getByRole('button',{name:'Download PDF',exact:true}).first().click();
    const issued=await issue,result=await issued.json();assert.equal(issued.status(),200,JSON.stringify(result));assert.equal(result.saved,true);
    assert.ok(result.path.startsWith(directory));fs.copyFileSync(result.path,path.join(directory,'signed-contact.pdf'));
    await idle();await expect(host.locator('.swms-revisions a')).toHaveCount(1);
    const retainedPdf=await page.request.get(new URL(await host.locator('.swms-revisions a').getAttribute('href'),page.url()).href);assert.equal(retainedPdf.status(),200);assert.ok((await retainedPdf.body()).subarray(0,5).equals(Buffer.from('%PDF-')));
    await back.click();await expect(page.locator('#view-documentation')).toBeVisible();await page.waitForFunction(()=>!window.CeasefireDesktop.status().busy);await openProjectSection(page,'swms');
    await expect(contact.getByRole('img')).toBeVisible();assert.deepEqual((await snapshot()).contact_signature,signed.contact_signature);
    await contact.getByRole('button',{name:'Clear signature',exact:true}).click();
    await expect(contact.getByRole('img')).toHaveCount(0);await expect(name).toHaveValue('');await expect(position).toHaveValue('');await expect(phone).toHaveValue('');
    await expect(host.getByLabel('Contact',{exact:true})).toHaveValue('Unrelated manager contact');
    assert.equal((await snapshot()).contact_signature,null);
    await host.getByRole('button',{name:'Save',exact:true}).first().click();await expect(host.locator('.swms-message')).toContainText('Saved.');
    await back.click();await expect(page.locator('#view-documentation')).toBeVisible();await page.waitForFunction(()=>!window.CeasefireDesktop.status().busy);await openProjectSection(page,'swms');
    await expect(name).toHaveValue('');await expect(phone).toHaveValue('');assert.equal((await snapshot()).contact_signature,null);
    assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
    return 'SWMS Contact Person: real pad cancel, company Settings failure and profile switch preserve the whole group; successful signing fills saved personal name/title and company phone with persisted vector ink; portable project and PDF retain ink; Clear resets only contact name/title/phone and ink across reopen; button stays beside field at 390–1915px, commercial arrow glyph is centered inside a42px Back button, no Settings writes';
  }catch(error){fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'server.log'),logs);throw error;}
  finally{await browser?.close();server.kill();}
}
module.exports=contactSignature;
if(require.main===module){
  const root=path.resolve(__dirname,'../..'),output=path.join(root,'.runtime/browser-qa',`swms-contact-${Date.now()}`);
  contactSignature(root,output).then(check=>{fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,check,output},null,2));console.log(JSON.stringify({passed:true,check,output}));}).catch(error=>{console.error(error);process.exitCode=1;});
}
