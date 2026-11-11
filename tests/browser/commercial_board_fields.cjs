'use strict';

// Exercise the board against a real disposable Project, including its issued Quote rows.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { chromium, expect: playwrightExpect } = require('@playwright/test');
const { createNewProject, openProjectSection } = require('./project_actions.cjs');

const expect = playwrightExpect.configure({ timeout: 20000 });
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.runtime/browser-qa', 'commercial-board-fields-' + Date.now());
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], {
  cwd: root, windowsHide: true
});
let logs = '', browser, page, info;
server.stderr.on('data', chunk => { logs += chunk; });

const button = (pane, name) => pane.getByRole('button', { name, exact: true });
const field = (pane, label) => pane.getByLabel(label, { exact: true });
const column = (pane, status) => pane.getByRole('region', { name: status, exact: true });
const dialog = () => page.getByRole('dialog', { name: 'Sign and move', exact: true });
const order = kind => JSON.parse(fs.readFileSync(info.project, 'utf8')).commercial_documents?.documents.find(row => row.kind === kind);
async function ready() {
  await page.waitForFunction(() => window.CeasefireDesktop?.status()?.ready &&
    !window.CeasefireProject.hasPendingOperation() && !document.querySelector('[aria-busy="true"]'));
}
async function saveDraft(pane, boardName) {
  await ready();
  await button(pane.locator('.commercial-editor-actions'), 'Save').click();
  await expect(pane.locator('.commercial-message')).toContainText('Document saved.');
  await button(pane, 'Back to ' + boardName).click();
}
async function move(pane, from, to) {
  const card = column(pane, from).locator('.commercial-card');
  // Use the card menu for destinations beyond the initial horizontal viewport.
  if (['Cancelled', 'On Hold', 'Certify'].includes(to)) {
    await card.locator('summary').click();
    await field(card, 'Move to').selectOption(to);
  } else {
    await card.dragTo(column(pane, to));
  }
  await expect(dialog()).toBeVisible();
}
async function submit(pane, kind, status) {
  await button(dialog(), 'Sign and move').click();
  await expect(column(pane, status).locator('.commercial-card')).toHaveCount(1);
  await expect.poll(() => order(kind)?.status).toBe(status);
  return order(kind);
}
async function assertBlocked(kind, original, signCount) {
  const confirm = button(dialog(), 'Sign and move');
  if (await confirm.isEnabled()) await confirm.click();
  await expect(dialog()).toBeVisible();
  assert.deepEqual(order(kind), original);
  assert.equal(await page.evaluate(() => window.fixtureSignatureRequests), signCount);
}
async function test() {
  const lines = createInterface({ input: server.stdout });
  const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(90000) });
  info = JSON.parse(line);
  assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1580, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + info.port);
  await ready();
  await createNewProject(page);
  const defaultsUrl = new URL('/api/certifications/defaults', page.url()).href;
  const defaults = await (await page.request.get(defaultsUrl)).json();
  const result = await page.request.post(defaultsUrl, { data: {
    expected_version: defaults.version, fields: { ...defaults.fields, name: 'Board fixture signer' }
  }});
  assert.equal(result.status(), 200, await result.text());
  await page.evaluate(() => {
    localStorage.setItem('ceasefire.takeoff-signature.v1', JSON.stringify({
      version: 1, ratio: 3, strokes: [[[0, 0], [.5, 1], [1, 0]]]
    }));
    const personal = window.ClassifirePersonalSignature;
    window.fixtureSignatureRequests = 0;
    window.ClassifirePersonalSignature = { ...personal, choose: (...args) => {
      window.fixtureSignatureRequests++;
      return personal.choose(...args);
    }};
  });
  const signatureCount = () => page.evaluate(() => window.fixtureSignatureRequests);
  await openProjectSection(page, 'quote');
  const quote = page.locator('#commercial-quote-root');
  await button(quote, 'New Quote').click();
  await button(quote, 'Add custom row').click();
  const quoteRow = quote.locator('.commercial-lines tbody tr').last();
  await quoteRow.getByRole('combobox').fill('Board inspection');
  await quoteRow.locator('input').last().fill('200');
  const issuing = page.waitForResponse(response => new URL(response.url()).pathname === '/api/commercial/issue');
  await button(quote, 'Download PDF').click();
  const issued = await issuing;
  assert.equal(issued.status(), 200, await issued.text());
  await expect(quote.locator('.commercial-message')).toContainText('PDF saved');
  await button(quote, 'Back to Quotes').click();

  await openProjectSection(page, 'work-orders');
  const work = page.locator('#commercial-work-order-root');
  await button(work, 'New Work Order').click();
  const availableQuotes = field(work, 'Linked Quote');
  const issuedChoices = availableQuotes.locator('option:not([value=""])');
  await expect(issuedChoices).toHaveCount(1);
  await availableQuotes.selectOption(await issuedChoices.getAttribute('value'));
  await saveDraft(work, 'Work Orders');
  const draft = order('work_order');
  const initialCount = await signatureCount();
  await move(work, 'Draft', 'Review');
  await field(dialog(), 'Category / urgency').selectOption('High Priority');
  await field(dialog(), 'Description of works').fill('Cancelled description');
  await assertBlocked('work_order', draft, initialCount);
  await button(dialog(), 'Cancel').click();
  await expect(dialog()).toHaveCount(0);
  assert.deepEqual(order('work_order'), draft);
  await move(work, 'Draft', 'Review');
  await field(dialog(), 'Proposed start date').fill('2026-12-01');
  await field(dialog(), 'Category / urgency').selectOption('Medium Priority');
  await field(dialog(), 'Description of works').fill('Inspect scheduled work');
  const reviewed = await submit(work, 'work_order', 'Review');
  assert.equal(reviewed.fields.order.description, 'Inspect scheduled work');
  assert.equal(reviewed.fields.order.urgency, 'Medium Priority');
  assert.equal(reviewed.fields.order.start_date, '2026-12-01');
  assert.ok(reviewed.fields.signatures.details_by);

  // The user's decision can choose another valid destination from the same step.
  await move(work, 'Review', 'Cancelled');
  const approval = field(dialog(), 'Approval');
  assert.deepEqual(await approval.locator('option').evaluateAll(options => options.map(option => option.value)),
    ['', 'Approved', 'Denied']);
  await expect(approval).toHaveValue('');
  await assertBlocked('work_order', reviewed, await signatureCount());
  await approval.selectOption('Denied');
  await expect(field(dialog(), 'Justification')).toBeVisible();
  await approval.selectOption('Approved');
  await expect(field(dialog(), 'Justification')).toBeHidden();
  await expect(dialog().getByText('OHS Docs', { exact: true })).toBeVisible();
  assert.equal((await submit(work, 'work_order', 'OHS Docs')).fields.order.approval, 'Approved');
  await move(work, 'OHS Docs', 'Client Approval');
  await submit(work, 'work_order', 'Client Approval');
  await move(work, 'Client Approval', 'In progress');
  const inProgress = await submit(work, 'work_order', 'In progress');
  await move(work, 'In progress', 'Claim');
  await expect(dialog()).toContainText('Board inspection');
  const progressTable = dialog().locator('.commercial-work-tracking');
  assert.ok(await progressTable.evaluate(el => el.scrollWidth <= el.clientWidth + 1),
    'Desktop progress rows should show descriptions and percentages together');
  const progress = field(dialog(), '% completed 1');
  await assertBlocked('work_order', inProgress, await signatureCount());
  await progress.fill('101');
  await assertBlocked('work_order', inProgress, await signatureCount());
  await progress.fill('50');
  await dialog().screenshot({ path: path.join(output, 'work-progress.png') });
  const claim = await submit(work, 'work_order', 'Claim');
  const lineId = claim.fields.work_tracking.rows[0].line_id;
  assert.equal(claim.fields.work_tracking.rows[0].completed_percent, '50');
  await move(work, 'Claim', 'Certify');
  await assertBlocked('work_order', claim, await signatureCount());
  await field(dialog(), '% claimed 1').fill('25');
  const certify = await submit(work, 'work_order', 'Certify');
  assert.equal(certify.fields.work_tracking.rows[0].line_id, lineId);
  assert.equal(certify.fields.work_tracking.rows[0].claimed_percent, '25');

  await move(work, 'Certify', 'On Hold');
  const completion = field(dialog(), 'Completion');
  for (const choice of ['Completed', 'Ongoing', 'On hold', 'Not completed']) {
    await expect(completion.locator('option', { hasText: new RegExp('^' + choice + '$') })).toHaveCount(1);
  }
  await expect(completion).toHaveValue('');
  await assertBlocked('work_order', certify, await signatureCount());
  await completion.selectOption('Completed');
  await field(dialog(), 'Certification details').selectOption('');
  await assertBlocked('work_order', certify, await signatureCount());
  await field(dialog(), 'Certification details').selectOption('Certification issued');
  const closed = await submit(work, 'work_order', 'Completed');
  assert.deepEqual(closed.fields.work_tracking, certify.fields.work_tracking);
  assert.equal(closed.fields.order.certification, 'Certification issued');
  assert.ok(closed.fields.signatures.closed_by);

  await openProjectSection(page, 'purchase-orders');
  const purchase = page.locator('#commercial-purchase-order-root');
  await button(purchase, 'New Purchase Order').click();
  await saveDraft(purchase, 'Purchase Orders');
  await move(purchase, 'Draft', 'Requested');
  const requested = await submit(purchase, 'purchase_order', 'Requested');
  await move(purchase, 'Requested', 'Reviewed');
  assert.deepEqual(await approval.locator('option').evaluateAll(options => options.map(option => option.value)),
    ['', 'Approved', 'Rejected']);
  await expect(approval).toHaveValue('');
  await assertBlocked('purchase_order', requested, await signatureCount());
  await approval.selectOption('Rejected');
  await expect(dialog().getByText('Cancelled', { exact: true })).toBeVisible();
  await field(dialog(), 'Rejection reason').fill('Different materials required');
  await dialog().screenshot({ path: path.join(output, 'purchase-review.png') });
  const cancelled = await submit(purchase, 'purchase_order', 'Cancelled');
  assert.equal(cancelled.fields.order.rejection_reason, 'Different materials required');
  assert.equal(cancelled.fields.order.approval, 'Rejected');
  assert.ok(cancelled.fields.signatures.reviewed_by);
  assert.deepEqual(errors, []);
  console.log('PASS board signing fields, outcomes, issued rows and cancellation: ' + output);
}

test().catch(async error => {
  console.error(error);
  fs.writeFileSync(path.join(output, 'server.log'), logs);
  if (page) {
    console.error(await page.locator('dialog[open], .commercial-message:visible').allTextContents());
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  }
  process.exitCode = 1;
}).finally(async () => { await browser?.close(); server.kill(); });
