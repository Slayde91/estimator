// Real document actions use a disposable server and a synthetic saved project.
const { chromium, expect } = require('@playwright/test');
const { chooseCalculator } = require('./calculator_actions.cjs');
const { clickProjectControl } = require('./project_actions.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.runtime/browser-qa', `document-menus-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.env.CEASEFIRE_PYTHON || 'python', [path.join(__dirname, 'fixtures.py'), '--directory', output], { cwd: root, windowsHide: true });
let logs = '', browser, page;
server.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  let data = ''; const timer = setTimeout(() => reject(new Error(`Fixture timeout: ${logs}`)), 120000);
  server.stdout.on('data', value => { data += value; if (data.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(data.split('\n')[0])); } });
  server.once('error', reject); server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}`)); });
});
const errors = [], calculatorRequests = [], evidence = { calculators: [], viewports: [1440, 825, 390] };
const actionIds = ['calculator-import', 'calculator-excel', 'calculator-pdf', 'calculator-summary-pdf', 'calculator-template'];
const actionNames = ['Import XLSX Schedule', 'Download XLSX Schedule', 'Download PDF Schedule', 'Download PDF Summary', 'Export Template'];
async function idle() { await page.waitForFunction(() => { const status = window.CeasefireDesktop?.status(); return status?.ready && !status.busy; }); }
async function snapshot() { await idle(); return page.evaluate(() => ({ calculators: window.CeasefireCalculators.projectSnapshot(), penetration: window.CeasefirePenetrations.projectSnapshot(), pricing: window.CeasefireProject.configuration(), details: window.CeasefireProject.details() })); }
async function responseTo(action, suffix) {
  const response = page.waitForResponse(value => value.request().method() === 'POST' && new URL(value.url()).pathname.endsWith(suffix));
  await action(); const reply = await response; assert.equal(reply.status(), 200); return reply.json();
}
(async () => {
  const info = await ready; assert.notEqual(info.port, 8765);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/calculators/')) calculatorRequests.push(request.url()); });
  await page.addInitScript(() => { window.qaCsp = []; document.addEventListener('securitypolicyviolation', event => window.qaCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI })); });
  await page.goto(`http://127.0.0.1:${info.port}/`); await idle();
  await page.evaluate(() => window.CeasefireCalculators.completeProjectSnapshot()); await idle();
  await responseTo(() => clickProjectControl(page, 'Save'), '/api/project/save-as');
  await expect(page.locator('#project-save-state')).toHaveText('Saved project');
  // Open a values-only saved project with a precise per-row waste override.
  const importedProject=JSON.parse(fs.readFileSync(info.project,'utf8'));importedProject.calculators.steel_board.inputs.CALCULATOR.L9=0.123456789012345;
  fs.writeFileSync(info.project,JSON.stringify(importedProject));await clickProjectControl(page,'Load');
  const review=page.getByRole('dialog');await expect(review.getByRole('heading')).toHaveText('Load this project?');await review.getByRole('button',{name:'Load Project',exact:true}).click();await expect(review).toBeHidden();await idle();
  const before = await snapshot(), savedProject = fs.readFileSync(info.project);assert.equal(before.calculators.steel_board.inputs.CALCULATOR.L9,0.123456789012345);
  evidence.importedWasteRetained=0.123456789012345;
  for (const [id, title] of [['steel_vermiculite', 'Steel (spray)'], ['steel_board', 'Steel (board)'], ['ductwork', 'Ductwork (spray/wrap)']]) {
    await chooseCalculator(page, title); await idle();
    await expect(page.locator('#calculator-title')).toHaveText(title); await expect(page.locator('#calculator-grid')).toHaveAttribute('aria-busy', 'false');
    if(id==='steel_board'){await page.locator('#calculator-pages').getByRole('button',{name:'SCHEDULE',exact:true}).click();await expect(page.locator('#calculator-grid')).toHaveAttribute('aria-busy','false');await expect(page.locator('[data-calculator-cell="L9"]')).toHaveCount(0);assert.ok(!(await page.locator('.calculator-schedule-table').getByRole('columnheader').allTextContents()).includes('Waste (%)'));}
    const requestsBeforeMenu = calculatorRequests.length;
    const toggle = page.locator('#calculator-document-toggle'), menu = page.locator('#calculator-document-menu');
    await expect(toggle).toHaveText('Document'); await expect(toggle.locator('svg')).toBeVisible(); await expect(menu).toBeHidden();
    const icon=toggle.locator('.calculator-document-icon');await expect(icon).toBeVisible();assert.deepEqual(await icon.evaluate(image=>[image.getAttribute('src'),image.naturalWidth,image.naturalHeight]),['/icons/document.png',512,512]);
    assert.equal(await menu.locator('#calculator-template .download-format-icon').innerHTML(),await menu.locator('#calculator-excel .download-format-icon').innerHTML(),'Template shares the XLSX Schedule icon');
    await expect(page.locator('#calculator-reset')).toBeVisible(); await expect(page.locator('#calculator-recalculate')).toBeVisible();
    await toggle.focus(); await toggle.press('ArrowDown'); await expect(menu.locator('button').first()).toBeFocused();
    await page.keyboard.press('End'); await expect(menu.locator('button').last()).toBeFocused();
    await page.keyboard.press('ArrowDown'); await expect(menu.locator('button').first()).toBeFocused();
    await page.keyboard.press('ArrowUp'); await expect(menu.locator('button').last()).toBeFocused();
    await page.keyboard.press('Home'); await expect(menu.locator('button').first()).toBeFocused();
    await page.keyboard.press('Escape'); await expect(toggle).toBeFocused(); await expect(menu).toBeHidden();
    for (const width of evidence.viewports) {
      await page.setViewportSize({ width, height: 1000 }); await toggle.click();
      await expect(menu.getByRole('button')).toHaveCount(5);
      for (const [index, actionId] of actionIds.entries()) {
        const action = menu.locator(`#${actionId}`); await expect(action).toBeVisible(); await expect(action).toHaveAccessibleName(actionNames[index]);
        await expect(action.locator('span').last()).toHaveText(actionNames[index]);
        const metrics = await action.evaluate(button => { const icon = button.querySelector('.download-format-icon').getBoundingClientRect(), text = button.lastElementChild.getBoundingClientRect(), box = button.getBoundingClientRect(); return { iconRight: icon.right, textLeft: text.left, iconY: icon.y + icon.height / 2, textY: text.y + text.height / 2, left: box.left, right: box.right }; });
        assert.ok(metrics.iconRight < metrics.textLeft, `${title}/${width}: icon precedes the visible action name`);
        assert.ok(Math.abs(metrics.iconY - metrics.textY) < 1, `${title}/${width}: icon and text share their vertical centre`);
      }
      const bounds = await menu.boundingBox(); assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= width + 1, `${title}/${width}: Document list stays within viewport`);
      await page.screenshot({ path: path.join(output, `${id}-${width}.png`) });
      await page.locator('#calculator-title').click(); await expect(menu).toBeHidden(); await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    }
    assert.equal(calculatorRequests.length, requestsBeforeMenu, `${title}: opening, navigating and dismissing Document never requests a calculation`);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const downloads = [];
    for (const [actionId, suffix, magic] of [['calculator-excel', 'register.xlsx', 'PK'], ['calculator-pdf', 'report.pdf', '%PDF-'], ['calculator-summary-pdf', 'summary.pdf', '%PDF-'], ['calculator-template', 'template', 'PK']]) {
      await toggle.click();
      const file = await responseTo(() => page.locator(`#${actionId}`).click(), `/api/calculators/${id}/${suffix}`);
      assert.equal(file.saved, true); assert.equal(file.destination, 'project');
      const relative = path.relative(output, file.path); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Generated file stays within the disposable fixture');
      assert.equal(fs.readFileSync(file.path).subarray(0, magic.length).toString(), magic);
      await expect(menu).toBeHidden(); await idle(); downloads.push({ action: suffix, file: path.basename(file.path) });
      if (actionId === 'calculator-template') {
        await toggle.click();
        const chooser = page.waitForEvent('filechooser'); await page.locator('#calculator-import').click(); const selected = await chooser;
        const imported = page.waitForResponse(reply => new URL(reply.url()).pathname === `/api/calculators/${id}/import`, { timeout: 60000 });
        await selected.setFiles(file.path); assert.equal((await imported).status(), 200);
        const dialog = page.locator('#calculator-confirm-dialog'); await expect(dialog).toBeVisible(); await expect(dialog.locator('h2')).toHaveText('Replace the schedule draft?');
        await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click(); await idle(); await expect(menu).toBeHidden();
      }
    }
    assert.deepEqual(await snapshot(), before, `${title}: document access, generated files and cancelled import preserve all calculator drafts and prices`);
    evidence.calculators.push({ id, title, keyboard: true, outsideDismissal: true, menuRequestedCalculation: false, downloads, importTemplateCancelled: true });
  }
  assert.deepEqual(fs.readFileSync(info.project), savedProject, 'Document actions do not rewrite the saved project');
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.qaCsp), []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ completed: true, ...evidence, errors, csp: [], draftsUnchanged: true, savedProjectUnchanged: true }, null, 2));
  console.log(`PASS Document menus in all three workbook calculators: keyboard, dismissal, responsive rows, 12 real files and three cancelled template imports preserve drafts, saved project and prices. Evidence: ${output}`);
})().catch(async error => { console.error(error); console.error(logs.slice(-5000)); if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); process.exitCode = 1;
}).finally(async () => { fs.writeFileSync(path.join(output, 'server.log'), logs); if (browser) await browser.close(); server.kill(); });
