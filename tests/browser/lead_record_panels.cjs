'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const {expect} = require('@playwright/test');
const {openProjectSection} = require('./project_actions.cjs');

// Extend the disposable Contact conversion fixture with a second enquiry and
// three real Drafts. Open each destination through its rendered sidebar link.
async function checkLeadRecordPanels(page, api, person, output) {
  const directory = await api('/api/contacts/directory');
  const current = directory.contacts.find(row => row.id === person.id);
  await api('/api/contacts/leads', {version:directory.version, contact_id:current.id,
    fields:{name:current.name, company:current.company, phone:current.phone, email:current.email,
      title:current.title, site_address:'Second sidebar enquiry'}});
  const project = (await api('/api/projects')).files.find(file => file.contact_id === person.id);
  assert.ok(project, 'Converted fixture Project belongs to the selected Contact');
  const kinds = {quotes:'quote',work_orders:'work_order',purchase_orders:'purchase_order'};
  const ids = {};
  const host = page.locator('#contacts-root');
  const pane = page.getByRole('complementary', {name:'Edit Lead',exact:true});
  const right = pane.locator('.contacts-record-right');
  const openLead = async () => {
    if (!await host.isVisible()) await page.locator('#contacts-navigation-toggle').click();
    await host.locator('.contacts-tabs').getByRole('button',{name:'Leads',exact:true}).click();
    await host.locator('.contacts-results').getByRole('button',{name:current.name,exact:true}).click();
    await expect(right.locator('[data-link-group=projects] > summary')).toHaveText('Linked Projects (1)');
  };
  await openLead();
  await expect(right.locator('details > summary:visible')).toHaveText([
    'Notes (0)','Files (0)','Linked Quotes (0)','Linked Work Orders (0)','Linked Purchase Orders (0)','Linked Projects (1)']);
  const loaded = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/projects/load');
  await right.locator('[data-link-group=projects]').getByRole('button').click();
  const projectReply = await loaded;
  assert.ok(projectReply.ok(), await projectReply.text());
  assert.equal((await projectReply.json()).file.id, project.id);
  await expect(page.locator('#project-details-pane')).toBeVisible();
  // The converted Project initially contains only its estimate. Its first
  // normal Quote save initializes the commercial workspace in that file.
  await openProjectSection(page,'quote');
  const quote = page.locator('#commercial-quote-root');
  await quote.getByRole('button',{name:'New Quote',exact:true}).click();
  await quote.getByLabel('Introduction',{exact:true}).fill('First linked Quote');
  await quote.locator('.commercial-editor-actions').getByRole('button',{name:'Save',exact:true}).click();
  await expect(quote.locator('.commercial-message')).toContainText('Document saved.');
  await expect.poll(async () => (await api('/api/commercial/register?refresh=1')).documents.length).toBe(1);
  const quoteCard = (await api('/api/commercial/register')).documents[0];
  ids.quote = quoteCard.id;
  const source = {file_id:quoteCard.source_file, revision:quoteCard.source_revision};
  for (const kind of ['work_order','purchase_order']) {
    const defaults = await api('/api/commercial/saved-defaults', {kind,source});
    const saved = await api('/api/commercial/saved-save', {kind,status:'Draft',source,fields:defaults.result.fields});
    ids[kind] = saved.result.id;
    source.revision = saved.revision;
  }
  await openLead();
  await expect(right.locator('details > summary:visible')).toHaveText([
    'Notes (0)','Files (0)','Linked Quotes (1)','Linked Work Orders (1)','Linked Purchase Orders (1)','Linked Projects (1)']);
  await expect(right.getByRole('button',{name:/Refresh/})).toHaveCount(0);
  await expect(pane.locator('.contacts-record-left [data-link-group=converted_leads] > summary')).toHaveText('Converted leads (1)');
  await expect(pane.locator('.contacts-record-left .crm-timeline > summary')).toHaveText('Activity history');
  await page.screenshot({path:path.join(output,'lead-linked-records.png'),fullPage:true});
  for (const [group,kind] of Object.entries(kinds)) {
    const opened = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/commercial/saved-open');
    await right.locator('[data-link-group='+group+']').getByRole('button').click();
    const response = await opened;
    assert.ok(response.ok(), await response.text());
    const request = response.request().postDataJSON();
    assert.equal(request.id, ids[kind]); assert.equal(request.source.file_id, source.file_id);
    await expect(page.locator('#commercial-'+kind.replaceAll('_','-')+'-root .commercial-editor-actions')).toBeVisible();
    await openLead();
  }
  for (const [tab, label, form] of [['Contacts',current.name,'Contact'],['Companies',current.company,'Company']]) {
    if (!await host.isVisible()) await page.locator('#contacts-navigation-toggle').click();
    await host.locator('.contacts-tabs').getByRole('button',{name:tab,exact:true}).click();
    await host.locator('.contacts-results').getByRole('button',{name:label,exact:true}).click();
    const sidebar=page.getByRole('complementary',{name:'Edit '+form,exact:true}).locator('.contacts-record-right');
    await expect(sidebar.locator('details > summary')).toHaveText([
      'Notes (0)','Files (0)','Linked Quotes (1)','Linked Work Orders (1)','Linked Purchase Orders (1)','Linked Projects (1)']);
    for (const group of ['quotes','work_orders','purchase_orders','projects']) await expect(sidebar.locator('[data-link-group='+group+']').getByRole('button')).toBeVisible();
    const opened=page.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/commercial/saved-open');
    await sidebar.locator('[data-link-group=quotes]').getByRole('button').click();
    const response=await opened;assert.ok(response.ok(),await response.text());
    const request=response.request().postDataJSON();
    assert.equal(request.id,ids.quote);assert.equal(request.source.file_id,source.file_id);
  }
}
module.exports = {checkLeadRecordPanels};
