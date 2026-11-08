const { expect } = require('@playwright/test');

// New and Load live on Projects; saves are available in the application header.
// Choose an explicit menu destination: the main Projects button now remembers
// whichever subsection was last opened during this app session.
async function openProjectSection(page, section) {
  if (!['quotes', 'quote', 'work-orders', 'purchase-orders', 'scheduler', 'certification', 'documentation', 'swms', 'documents'].includes(section)) throw new Error('Unknown workspace section: ' + section);
  const destination = page.locator('#view-' + section);
  if (await destination.isVisible()) return;
  if (section === 'documents') await page.locator('#documents-navigation-toggle').click();
  else if (section === 'scheduler') await page.locator('#scheduler-navigation').click();
  else {
    const documents = ['certification', 'documentation', 'swms', 'documents'].includes(section);
    const owner = documents ? 'documents' : 'projects', attribute = documents ? 'document' : 'project';
    await page.locator(`#${owner}-navigation-toggle`).hover();
    await expect(page.locator(`#${owner}-navigation-menu`)).toBeVisible();
    await page.locator(`#${owner}-navigation-menu [data-${attribute}-section="${section}"]`).click();
  }
  const confirmation = page.getByRole('dialog', { name: 'Unsaved Pricing Library', exact: true });
  const target = await Promise.race([
    destination.waitFor({ state: 'visible' }).then(() => 'section'),
    confirmation.waitFor({ state: 'visible' }).then(() => 'confirmation'),
  ]);
  if (target === 'confirmation') await confirmation.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(destination).toBeVisible();
}

async function openProjectTools(page) {
  const previous = await page.locator('#view-quotes').isVisible() ? 'quotes' : await page.locator('#view-certification').isVisible() ? 'certification' : await page.locator('#view-documentation').isVisible() ? 'documentation' : await page.locator('.nav-button[aria-current="page"]').getAttribute('data-view');
  if (previous !== 'quotes') await openProjectSection(page, 'quotes');
  await expect(page.locator('#quotes-heading')).toBeVisible();
  return previous;
}

async function clickProjectControl(page, name) {
  if (name === 'Save') {
    await page.locator('#header-project-actions').getByRole('button', { name, exact: true }).click();
    return;
  }
  const previous = await openProjectTools(page);
  await page.locator('.project-workspace-actions').getByRole('button', { name, exact: true }).click();
  // Do not wait for a save response here: failure/held-response tests deliberately
  // test the UI before a response exists. Load keeps its review dialog in place.
  if (!['Load','New'].includes(name) && previous && previous !== 'quotes') {
    if (['certification', 'documentation'].includes(previous)) {
      await openProjectSection(page, previous);
    } else if (previous === 'projects') {
      await page.locator('.nav-button[data-view="home"]').click();
      await page.locator('[data-home-view="projects"]').click();
      await expect(page.locator('#view-projects')).toBeVisible();
    } else await page.locator('.nav-button[data-view="' + previous + '"]').click();
  }
}

// This helper explicitly creates a real numbered Project. Callers testing
// cancellation use clickProjectControl('New') and operate its modal directly.
async function createNewProject(page, values = {}) {
  await clickProjectControl(page,'New');
  const modal=page.locator('#project-new-dialog');await expect(modal).toBeVisible();
  if(values.client){
    const input=page.locator('#project-pane-client');await input.fill(values.client);
    const directory=await(await page.request.get(new URL('/api/contacts/directory',page.url()).href)).json();
    if(directory.accounts.some(account=>account.company===values.client)){
      await input.blur();await input.focus();await page.locator('#project-account-options').getByRole('option',{name:values.client,exact:true}).click();
    }else{
      await page.locator('#project-account-new').click();const account=page.getByRole('dialog',{name:'New Account',exact:true});
      await account.getByLabel('Company',{exact:true}).fill(values.client);await account.getByRole('button',{name:'Save',exact:true}).click();await expect(account).toBeHidden();
    }
  }
  if(values['site-address'])await page.locator('#project-pane-address').fill(values['site-address']);
  const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/project/save-as');
  await page.locator('#project-details-save').click();
  const review=page.locator('#discard-dialog');
  await Promise.race([review.waitFor({state:'visible'}),response]);
  if(await review.isVisible())await review.getByRole('button',{name:'New project',exact:true}).click();
  const reply=await response;if(reply.status()!==200)throw Error(await reply.text());
  const result=await reply.json();if(result.cancelled)throw Error('Fixture Project creation was cancelled');
  await expect(modal).toBeHidden();await page.waitForFunction(()=>window.CeasefireDesktop?.status()?.ready&&!window.CeasefireDesktop.status().busy);
  return result;
}

async function fillProjectDetails(page, values, {waitForIdle = true} = {}) {
  const previous = await page.locator('.view').evaluateAll(nodes => nodes.find(node => !node.hidden)?.id.replace(/^view-/, ''));
  await openProjectSection(page, 'quotes');
  await page.locator('#project-current-details').click();
  await expect(page.locator('#project-details-pane')).toBeVisible();
  for (const [id, value] of Object.entries(values)) {
    if (!['client', 'site-address'].includes(id)) throw new Error('Unknown editable project detail: ' + id);
    const input = page.locator(id === 'client' ? '#project-pane-client' : '#project-pane-address');
    const original = await input.inputValue();
    await input.fill(value);
    if (id === 'client' && original !== value && value) {
      // Project identity now links canonical Accounts. Test fixtures create
      // their own synthetic Account through the same popup used by the app.
      const response = await page.request.get(new URL('/api/contacts/directory',page.url()).href);
      const directory = await response.json();
      if (directory.accounts.some(account => account.company === value)) {
        await input.blur(); await input.focus();
        await page.locator('#project-account-options').getByRole('option', {name:value,exact:true}).click();
      } else {
        await page.locator('#project-account-new').click();
        const account = page.getByRole('dialog', {name:'New Account',exact:true});
        await account.getByLabel('Company',{exact:true}).fill(value);
        await account.getByRole('button',{name:'Save',exact:true}).click();
        await expect(account).not.toBeVisible();
      }
    }
    await input.blur();
  }
  if (previous && previous !== 'quotes') {
    if (['quote', 'work-orders', 'purchase-orders', 'scheduler', 'certification', 'documentation', 'swms', 'documents'].includes(previous)) await openProjectSection(page, previous);
    else await page.locator('.nav-button[data-view="' + previous + '"]').click();
  }
  if (waitForIdle) await page.waitForFunction(() => { const state = window.CeasefireDesktop?.status(); return state?.ready && !state.busy; });
}

module.exports = { clickProjectControl, openProjectTools, openProjectSection, fillProjectDetails,createNewProject };
