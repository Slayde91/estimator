// Contact information is rendered in an owned disposable browser/fixture only.
const {chromium,expect}=require('@playwright/test');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),output=fs.mkdtempSync(path.join(os.tmpdir(),'classifire-help-contact-'));
const locales=['en','zh-Hans','hi','es','ar','th','ko','tl','vi'];
const sources=['Contact Us','We’d love to hear from you. If you spot an error in our technical information, have an idea for improving CLASSIFIRE, need help or want to share any feedback, please get in touch.','Email CLASSIFIRE'];
const base=JSON.parse(fs.readFileSync(path.join(root,'static/locales/help-contact.json'),'utf8'));
const additions=JSON.parse(fs.readFileSync(path.join(root,'static/locales/additions/help-contact.json'),'utf8'));
const translation=(source,locale)=>locale==='en'?source:[...base[source],...additions[source]][locales.indexOf(locale)-1];
const server=spawn(process.env.CEASEFIRE_PYTHON||'python',[path.join(__dirname,'monokote_fixture.py'),'--directory',output],{cwd:root,windowsHide:true});
let logs='',browser,page;
server.stderr.on('data',data=>logs+=data);
const ready=new Promise((resolve,reject)=>{
 let raw='';const timer=setTimeout(()=>reject(Error(`Fixture startup timeout: ${logs}`)),120000);
 server.stdout.on('data',data=>{raw+=data;if(raw.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(raw.split('\n')[0]));}catch(error){reject(error);}}});
 server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited ${code}: ${logs}`));});
});
const evidence={synthetic:true,layouts:[],page_errors:[],blocked_requests:[],mutation_requests:[],mail_client_opened:false,original_tabs_accessed:false};
async function idle(){await page.waitForFunction(()=>{const state=window.CeasefireDesktop?.status();return state?.ready&&!state.busy;});}
async function snapshot(){await idle();return page.evaluate(()=>({
 calculators:window.CeasefireCalculators.projectSnapshot(),penetration:window.CeasefirePenetrations.projectSnapshot(),
 pricing:window.CeasefireProject.configuration(),details:window.CeasefireProject.details(),
 takeoffs:window.CeasefireTakeoffs?.projectSnapshot()||null,dirty:window.CeasefireDesktop.status().dirty,
}));}
(async()=>{
 const info=await ready;assert.notEqual(info.port,8765);evidence.port=info.port;
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1146,height:900},reducedMotion:'reduce'});page.setDefaultTimeout(60000);
 const origin=`http://127.0.0.1:${info.port}`;
 await page.route('**/*',route=>{
  const request=route.request(),url=new URL(request.url()),method=request.method();
  const purePost=method==='POST'&&(['/api/calculate','/api/penetration/calculate','/api/penetration/definition','/api/penetration/references'].includes(url.pathname)||/^\/api\/calculators\/(?:steel_vermiculite|steel_board|steel_intumescent|ductwork)\/(?:worksheet|calculate)$/.test(url.pathname));
  if(url.origin===origin&&(['GET','HEAD'].includes(method)||purePost))return route.continue();
  evidence.blocked_requests.push({method,path:url.pathname});return route.abort('blockedbyclient');
 });
 page.on('pageerror',error=>evidence.page_errors.push(error.message));
 page.on('request',request=>{if(!['GET','HEAD'].includes(request.method()))evidence.mutation_requests.push(new URL(request.url()).pathname);});
 await page.goto(origin);await expect(page.locator('#view-home')).toBeVisible();await idle();
 await page.evaluate(async()=>{await window.CeasefireCalculators.completeProjectSnapshot();await window.CeasefirePenetrations.completeProjectSnapshot();});await idle();
 const baseline=await snapshot(),requestCount=evidence.mutation_requests.length;
 await page.locator('nav [data-view="help"]').click();
 const card=page.locator('.help-contact'),heading=page.locator('#help-contact-heading'),copy=card.locator('p').first(),email=card.getByRole('link');
 await expect(card).toBeVisible();await expect(card).toHaveAttribute('aria-labelledby','help-contact-heading');
 assert.equal(await card.evaluate(el=>!!(el.compareDocumentPosition(document.querySelector('.help-glossary'))&Node.DOCUMENT_POSITION_FOLLOWING)),true,'Contact information precedes the glossary');
 for(const locale of locales){
  await page.evaluate(locale=>window.CeasefireI18n.setLanguage(locale,false),locale);
  await expect(heading).toHaveText(translation(sources[0],locale));await expect(copy).toHaveText(translation(sources[1],locale));
  await expect(email).toHaveAccessibleName(translation(sources[2],locale));await expect(email).toHaveAttribute('href','mailto:sales@classifire.com.au');
  await expect(email).toHaveText('sales@classifire.com.au');await expect(email).toHaveAttribute('dir','ltr');await expect(email).toHaveCSS('direction','ltr');
  await expect(page.locator('html')).toHaveAttribute('dir',locale==='ar'?'rtl':'ltr');
  for(const width of [1146,390]){
   await page.setViewportSize({width,height:900});await card.scrollIntoViewIfNeeded();
   const layout=await card.evaluate(el=>{const box=el.getBoundingClientRect(),link=el.querySelector('a').getBoundingClientRect();return{left:box.left,right:box.right,width:innerWidth,documentWidth:document.documentElement.scrollWidth,linkLeft:link.left,linkRight:link.right};});
   assert.ok(layout.left>=0&&layout.right<=width+.5&&layout.linkLeft>=layout.left&&layout.linkRight<=layout.right,`${locale}/${width}: card and email stay in the viewport`);
   assert.ok(layout.documentWidth<=width,`${locale}/${width}: no page overflow`);
   evidence.layouts.push({locale,width,...layout});
  }
  if(['en','ar'].includes(locale))await card.screenshot({path:path.join(output,`contact-${locale}-390.png`)});
  assert.deepEqual(await snapshot(),baseline,`${locale}: Help and localization preserve every project/pricing/calculator draft`);
 }
 await page.evaluate(()=>window.CeasefireI18n.setLanguage('en',false));
 await email.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');await expect(email).toBeFocused();
 assert.equal(await email.evaluate(el=>getComputedStyle(el).outlineStyle),'solid','Keyboard focus is visibly outlined');
 await page.setViewportSize({width:1146,height:900});await card.screenshot({path:path.join(output,'contact-en-1146.png')});
 assert.deepEqual(await snapshot(),baseline);assert.equal(evidence.mutation_requests.length,requestCount,'Contact card and locale switching make no mutation requests');
 assert.deepEqual(evidence.page_errors,[]);assert.deepEqual(evidence.blocked_requests,[]);
 evidence.result='PASS';evidence.drafts_unchanged=true;evidence.new_mutation_requests=0;evidence.exact_email_target=true;evidence.keyboard_focus=true;
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({result:'PASS',output,locales:locales.length,layouts:evidence.layouts.length,draftsUnchanged:true,newMutationRequests:0}));
})().catch(error=>{fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({...evidence,error:String(error),logs},null,2));console.error(error);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.kill();});
