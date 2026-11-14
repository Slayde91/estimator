const {expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chooseTakeoff,chooseLibrary}=require('./section_navigation.cjs');
const {chooseCalculator}=require('./calculator_actions.cjs');
const {openProjectSection}=require('./project_actions.cjs');

async function workspaceTitleMeasurements(page, output) {
  const sizes=[1915,1254,631,390,351,350,320], measurements=[], reference=new Map();
  async function record(name,selector) {
    const title=page.locator(selector);
    await expect(title).toBeVisible();
    for(const width of sizes) {
      await page.setViewportSize({width,height:884});
      await page.mouse.move(0,0);
      await page.evaluate(()=>scrollTo(0,0));
      // Registry refreshes can replace the commercial heading between layout frames.
      const sample=await page.waitForFunction(selector=>{
        const element=document.querySelector(selector);
        if(!element?.isConnected || !element.getBoundingClientRect().height) return false;
        const rect=element.getBoundingClientRect();
        const view=element.closest('.view').getBoundingClientRect(), header=document.querySelector('.app-header').getBoundingClientRect();
        const heading=element.closest('.page-heading,.calculator-workspace-heading,.takeoff-workspace-heading');
        const banner=heading.getBoundingClientRect();
        const inlineStart=rect.left-view.left,top=rect.top-header.bottom;
        return {inlineStart,top,height:rect.height,fontSize:getComputedStyle(element).fontSize,
          rowY:banner.top-header.bottom,rowHeight:banner.height,below:parseFloat(getComputedStyle(heading).marginBottom),
          ...(heading.classList.contains('scheduler-clock-heading')?{tabGap:heading.querySelector('.scheduler-tabs').getBoundingClientRect().top-rect.bottom}:{}),
          x:rect.x,viewX:view.x,headingRight:rect.right,viewport:document.documentElement.clientWidth};
      },selector);
      const geometry=await sample.jsonValue();
      await sample.dispose();
      if(name==='Takeoffs Steel')reference.set(width,geometry);
      else {
        const peer=reference.get(width),context=name+' at '+width+': '+JSON.stringify(geometry);
        assert.ok(Math.abs(geometry.top-peer.top)<1,context+' title position');
        assert.equal(geometry.height,22,context+' title height');
        assert.equal(geometry.inlineStart,peer.inlineStart,context+' left edge within workspace');
        assert.equal(geometry.rowY,peer.rowY,context+' heading row top');
        assert.equal(geometry.below,peer.below,context+' gap below heading row');
        assert.ok(geometry.headingRight<=geometry.viewport+1,context+' right edge');
        if(geometry.tabGap!==undefined)assert.ok(geometry.tabGap<=28,context+' tabs immediately follow title row');
      }
      measurements.push({name,width,...geometry});
      if(['Takeoffs Steel','Firestopping','Scheduler, clocked in'].includes(name)&&[1254,320].includes(width)){
        const banner=title.locator('xpath=ancestor::*[contains(@class,"workspace-title-row") or contains(@class,"takeoff-workspace-heading")][1]');
        await banner.screenshot({path:path.join(output,name.replace(/[^a-z0-9]+/gi,'-')+'-'+width+'.png')});
      }
    }
    await page.setViewportSize({width:1254,height:884});
    await page.evaluate(()=>scrollTo(0,0));
    await page.waitForFunction(()=>{const s=window.CeasefireDesktop?.status();return s?.ready&&!s.busy;});
  }
  await chooseTakeoff(page,'Steel');await record('Takeoffs Steel','.takeoff-workspace-title');
  for(const [kind,id] of [['pricing','pricing'],['penetration','penetration-library'],['technical','technical-library']]){
    await chooseLibrary(page,kind);await record(kind+' library','#'+id+'-heading');
  }
  for(const label of ['Firestopping','Duct','Steel (spray)','Steel (intumescent)','Steel (board)','Factor Calcs']){
    await chooseCalculator(page,label);await record(label,label==='Firestopping'?'#penetration-heading':'#calculator-title');
  }
  await page.locator('#estimate-navigation-toggle').click();await record('Estimate','#estimate-heading');
  for(const [section,id] of [['documentation','#documentation-heading'],['quotes','#quotes-heading'],['quote','#commercial-quote-root'],['work-orders','#commercial-work-order-root'],['purchase-orders','#commercial-purchase-order-root']]){
    await openProjectSection(page,section);await record(section,id+(id.endsWith('-root')?' .page-heading h1':''));
  }
  await page.locator('#contacts-navigation-toggle').click();
  for(const name of ['Companies','Contacts','Leads']){
    await page.locator('#contacts-root .contacts-tabs').getByRole('button',{name,exact:true}).click();
    await record(name,'#contacts-root .page-heading h1');
  }
  await openProjectSection(page,'scheduler');
  await record('Scheduler, clocked out','#scheduler-root .page-heading h1');
  await page.getByRole('button',{name:'Clock in',exact:true}).click();
  await page.locator('dialog[open]').getByRole('button',{name:'Clock in',exact:true}).click();
  await expect(page.locator('.scheduler-clock-heading')).toBeVisible();
  await record('Scheduler, clocked in','#scheduler-root .page-heading h1');
  // The Scheduler stores its entry start with one-second precision.
  const model=await page.evaluate(async()=> (await (await fetch('/api/scheduler/state')).json()).active_entry);
  await page.waitForFunction(start=>Date.now()-Date.parse(start)>1100,model.start);
  await page.context().setGeolocation({latitude:-33.1,longitude:151,accuracy:10});
  const clockedOut=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/scheduler/clock/out');
  await page.getByRole('button',{name:'Clock out',exact:true}).click();
  const reply=await clockedOut;
  assert.ok(reply.ok(),await reply.text());
  await expect(page.locator('.scheduler-clock-heading')).toHaveCount(0,{timeout:30000});
  fs.writeFileSync(path.join(output,'workspace-titles.json'),JSON.stringify(measurements,null,2));
  // At 200% text size the line box must grow and leave the tabs reachable.
  await chooseCalculator(page,'Steel (intumescent)');
  await expect(page.locator('#calculator-title')).toContainText(/intumescent/i);
  await page.setViewportSize({width:320,height:884});
  const ruleIndex=await page.evaluate(()=>{
    const stylesheet=[...document.styleSheets].find(sheet=>sheet.href?.endsWith('/styles.css'));
    return stylesheet.insertRule('#main #calculator-title {font-size:36px}',stylesheet.cssRules.length);
  });
  try {
    const title=page.locator('#calculator-title');
    const enlarged=await title.evaluate(el=>({height:el.offsetHeight,line:parseFloat(getComputedStyle(el).lineHeight),
      bottom:el.getBoundingClientRect().bottom,tabTop:document.querySelector('#calculator-kind-pages').getBoundingClientRect().top}));
    assert.ok(enlarged.height>=2*enlarged.line-1&&enlarged.line>=43.99&&enlarged.bottom<=enlarged.tabTop,JSON.stringify(enlarged));
    await page.locator('#calculator-kind-pages button').first().click({trial:true});
  } finally {
    await page.evaluate(index=>[...document.styleSheets].find(sheet=>sheet.href?.endsWith('/styles.css')).deleteRule(index),ruleIndex);
  }
  return measurements;
}
module.exports={workspaceTitleMeasurements};
