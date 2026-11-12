const {expect} = require('@playwright/test');
const assert = require('node:assert/strict');

async function checkIdentity(page,port) {
  const url = 'http://127.0.0.1:'+port+'/api/contacts/';
  const directory = async () => (await page.request.get(url+'directory')).json();
  const write = async (kind,fields,extra={}) => {
    const state = await directory();
    const result = await page.request.post(url+kind,{data:{version:state.version,fields,...extra}});
    assert.equal(result.status(),200,await result.text());return result.json();
  };
  const first = await write('contacts',{name:'Former Person',company:'Agency',phone:'02 5555 2223',email:'former@example.test'});
  const keeper = await write('contacts',{name:'Current Person',company:'Agency',phone:'0255552223',email:'current@example.test'});
  const unrelated = await write('contacts',{name:'Unrelated Person',company:'Agency',phone:'0255553334',email:'other@example.test'});
  const enquiry = await write('leads',{name:'Tender contact',company:'Tender client',phone:'3334',email:'enquiry@example.test',
    site_address:'Separate tender site'},{contact_id:first.id});
  const root = page.locator('#contacts-root');
  const similar = await write('accounts',{company:'Sample Fabricators Pty Ltd',abn_acn:'123456'});
  await write('accounts',{company:'Sample Fabricators Limited',abn_acn:'123456'});
  await write('accounts',{company:'Different Business',abn_acn:'123456'});
  await page.locator('#contacts-navigation-toggle').hover();
  await page.locator('#contacts-navigation-menu [data-contacts-section="accounts"]').click();
  await root.getByRole('button',{name:'Sample Fabricators Limited',exact:true}).click();
  const companyPane = page.getByRole('complementary',{name:'Edit Company',exact:true});
  await companyPane.getByText('Merge records',{exact:true}).click();
  const source = companyPane.getByLabel('Source record');
  await source.selectOption(similar.id);
  await expect(source.locator('option')).toHaveCount(2);
  await companyPane.getByRole('button',{name:'Cancel',exact:true}).click();
  await root.getByRole('button',{name:'Different Business',exact:true}).click();
  await companyPane.getByText('Merge records',{exact:true}).click();
  await expect(companyPane.getByText('No matching companies.',{exact:true})).toBeVisible();
  await expect(source).toBeDisabled();
  await companyPane.getByRole('button',{name:'Cancel',exact:true}).click();
  await root.getByRole('button',{name:'Contacts',exact:true}).click();
  await root.getByRole('button',{name:'Current Person',exact:true}).click();
  const pane = page.getByRole('complementary',{name:'Edit Contact',exact:true});
  await pane.getByText('Merge records',{exact:true}).click();
  await pane.getByLabel('Source record').selectOption(first.id);
  await expect(pane.getByLabel('Source record').locator('option[value="'+unrelated.id+'"]')).toHaveCount(0);
  const [preview] = await Promise.all([
    page.waitForResponse(response=>response.url()===url+'identity/preview' && response.request().method()==='POST'),
    pane.getByRole('button',{name:'Review merge',exact:true}).click()
  ]);
  assert.equal(preview.status(),200);
  await expect(pane.getByText('Source Notes and Files stay on the original record. Undo the merge to access them again.',{exact:true})).toBeVisible();
  await expect(pane.getByRole('cell',{name:'former@example.test',exact:true})).toBeVisible();
  await pane.getByLabel('Reason for merge').fill('Confirmed with the tender contact');
  await pane.getByRole('button',{name:'Confirm merge',exact:true}).click();
  await expect(pane).toHaveCount(0);
  await expect(root.getByRole('button',{name:'Former Person',exact:true})).toHaveCount(0);
  await root.getByRole('button',{name:'Leads',exact:true}).click();
  const card = root.locator('.project-kanban-card').filter({hasText:'Tender contact'});
  await card.locator('summary').click();await card.getByRole('button',{name:'Edit',exact:true}).click();
  const dialog = page.getByRole('complementary',{name:'Edit Lead',exact:true});
  const compare = dialog.locator('[data-enquiry-compare]');
  await expect(compare).toContainText('Current Person');
  await expect(compare).toContainText('Tender client');
  await compare.getByRole('checkbox',{name:'Select Phone',exact:true}).check();
  await compare.getByRole('button',{name:'Refresh from contact',exact:true}).click();
  await expect(dialog.locator('input[name=phone]')).toHaveValue('0255552223');
  await expect(dialog.locator('input[name=email]')).toHaveValue('enquiry@example.test');
  await expect(dialog.locator('input[name=company]')).toHaveValue('Tender client');
  assert.equal((await directory()).leads.find(row=>row.id===enquiry.id).phone,'3334');
  await dialog.getByRole('button',{name:'Save',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  const lead = (await directory()).leads.find(row=>row.id===enquiry.id);
  assert.equal(lead.contact_id, first.id); assert.equal(lead.name,'Tender contact'); assert.equal(lead.phone,'0255552223');
  await root.getByRole('button',{name:'Contacts',exact:true}).click();
  await root.getByRole('button',{name:'Current Person',exact:true}).click();
  await pane.getByText('Merge records',{exact:true}).click();
  await pane.locator('summary').filter({hasText:'Former Person'}).click();
  await pane.getByRole('button',{name:'Undo merge'}).click();
  await expect(root.getByRole('button',{name:'Former Person',exact:true})).toBeVisible();
  assert.equal((await directory()).contacts.find(row=>row.id===keeper.id).phone,'0255552223');
}
module.exports = {checkIdentity};
