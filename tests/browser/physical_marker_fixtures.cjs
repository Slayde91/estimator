const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { expect } = require('@playwright/test');
const { chooseTakeoff } = require('./section_navigation.cjs');

// Defect Reports now creates sourced Defects from its drawing toolbar. Retained
// Barrier markers remain editable, so seed that historical shape explicitly in
// a disposable fixture rather than invoking its removed creation shortcut.
async function retainBarrierMarker(page, id, point, scope = 'defect_reports') {
  const before = await page.evaluate(() => window.CeasefireTakeoffs.projectSnapshot());
  const key = scope === 'service_plans' ? 'service_plans' : 'physical';
  const barrier = before[key].barriers.find(value => value.id === id);
  assert.ok(barrier && !barrier.marker && !barrier.deleted, 'Fixture marker needs an active unplaced Barrier');
  const documentId = await page.getByLabel('Drawing document', { exact: true }).inputValue();
  const source = before.documents.find(value => value.id === documentId);
  assert.ok(source, 'Retained marker has an explicit original source');
  const pageNumber = Number(await page.getByLabel('Page number', { exact: true }).inputValue());
  const marker = { document_id: source.id, document_sha256: source.sha256, page: pageNumber, point: [...point], appearance: { marker_size: 10 } };
  const session = await page.evaluate(() => window.CeasefireTakeoffs.sessionId());
  const origin = new URL(page.url()).origin;
  const prefix = `${origin}/api/takeoffs/sessions/${session}/physical`;
  const previewReply = await page.request.post(`${prefix}/preview`, { data: { scope, expected_revision: before.revision, commands: [{ op: 'update', entity_id: id, changes: { marker } }] } });
  assert.equal(previewReply.status(), 200, await previewReply.text());
  const preview = await previewReply.json();
  const applyReply = await page.request.post(`${prefix}/apply`, { data: { scope, expected_revision: preview.revision, request_id: randomUUID(), preview_id: preview.preview_id } });
  assert.equal(applyReply.status(), 200, await applyReply.text());
  const applied = await applyReply.json(), retained = applied.snapshot[key].barriers.find(value => value.id === id);
  assert.deepEqual(retained.marker, marker);
  const withoutMarker = value => { const result = structuredClone(value); delete result.marker; delete result.revision; return result; };
  assert.deepEqual(withoutMarker(retained), withoutMarker(barrier), 'Fixture setup changes only the explicit source marker');
  assert.equal(retained.revision, barrier.revision + 1, 'The reviewed fixture update advances the Barrier revision exactly once');
  assert.deepEqual(applied.snapshot[key].services, before[key].services, 'Fixture setup cannot change service identities or quantities');
  await page.evaluate(async value => { const t = window.CeasefireTakeoffs; t.applyProject(await t.prepareProject(value, t.sessionId())); await t.open(); }, applied.snapshot);
  await chooseTakeoff(page, scope === 'service_plans' ? 'Service Plans' : 'Defect Reports');
  await expect(page.locator('#takeoffs-workspace')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.takeoff-physical-register')).not.toHaveAttribute('aria-busy', 'true');
  return marker;
}

module.exports = { retainBarrierMarker };
