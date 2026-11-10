'use strict';
const assert=require('node:assert/strict');
const {expect}=require('@playwright/test');

async function openCertificateEditor(page,{fresh=false}={}){
  const editor=page.locator('#certification-editor');
  if(await editor.isVisible()){
    if(!fresh)return;
    await page.locator('#certification-back').click();
  }
  const resume=page.locator('#certification-resume');
  const current=await page.locator('#certification-document').inputValue();
  const card=current?page.locator('#certification-board [data-document-id='+JSON.stringify(current)+'] .project-title-button'):null;
  if(!fresh && await resume.isVisible())await resume.click();
  else if(!fresh && card && await card.isVisible())await card.click();
  else{
    await expect(page.locator('#certification-new')).toBeEnabled();await page.locator('#certification-new').click();
    const discard=page.getByRole('button',{name:'Continue without saving',exact:true});
    await expect.poll(async()=>await editor.isVisible() || await discard.isVisible()).toBe(true);
    if(await discard.isVisible())await discard.click();
  }
  await expect(editor).toBeVisible();await expect(page.locator('#certification-client')).toBeEnabled();
}

async function generateCertificate(page, revision){
  // The committed revision response is stable across browser and native-save
  // builds. Notices can legitimately change again after automatic Project Save.
  const receipt=page.waitForResponse(response=>response.request().method()==='POST'&&
    /^\/api\/certifications\/[^/]+\/revisions$/.test(new URL(response.url()).pathname));
  await page.locator('#certification-generate').click();
  const response=await receipt;assert.equal(response.ok(),true,await response.text());
  const generated=await response.json();assert.equal(generated.revision.revision,revision);
  await page.waitForFunction(()=>{
    const status=window.CeasefireDesktop?.status();
    return status?.ready&&!status.busy&&!window.CeasefireCertification?.hasPendingOperation?.()&&
      !window.CeasefireDownloads?.hasPendingOperation?.();
  },null,{timeout:120000});
  return generated;
}
module.exports={generateCertificate,openCertificateEditor};
