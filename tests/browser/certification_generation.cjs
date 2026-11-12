'use strict';
const assert=require('node:assert/strict');
const {expect}=require('@playwright/test');

async function openCertificateEditor(page,{fresh=false}={}){
  await expect(page.locator('#certification-editor')).toBeVisible();
  await expect(page.locator('#certification-client')).toBeEnabled();
  if(fresh){
    await page.locator('#certification-new').click();
    const discard=page.getByRole('button',{name:'Continue without saving',exact:true});
    if(await discard.isVisible())await discard.click();
    await expect(page.locator('#certification-document')).toHaveValue('');
  }
}

async function generateCertificate(page, revision){
  // The committed revision response is stable across browser and native-save
  // builds. Notices can legitimately change again after automatic Project Save.
  if(!await page.locator('#certification-signature-preview').isVisible()){
    await page.locator('#certification-signature-use').click();
    const dialog=page.getByRole('dialog',{name:'Signatures',exact:true});
    const pad=await dialog.getByLabel('Signature drawing pad').boundingBox();
    await page.mouse.move(pad.x+15,pad.y+30);await page.mouse.down();
    await page.mouse.move(pad.x+95,pad.y+10,{steps:5});await page.mouse.up();
    await dialog.getByRole('button',{name:'Insert signature',exact:true}).click();
    await expect(page.locator('#certification-signature-preview')).toBeVisible();
  }
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
