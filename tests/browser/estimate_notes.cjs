const {expect}=require('@playwright/test');

// Exercise the real Additions tab when editing Estimate notes. Notes are no
// longer part of an always-visible Project Details card.
async function showEstimateNotes(page){
  const notes=page.locator('#measurements');
  if(!await notes.isVisible())await page.locator('#main-tab-additions').click();
  await expect(notes).toBeVisible();
}
module.exports={showEstimateNotes};
