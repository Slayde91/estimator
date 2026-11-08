'use strict';
const assert=require('node:assert/strict');

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
module.exports={generateCertificate};
