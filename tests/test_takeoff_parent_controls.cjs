const assert = require('node:assert/strict');
const path = require('node:path');
const physical = require(process.argv[2] || path.join(__dirname, '../static/takeoff-physical.js'));
const entity = (id, fields = {}, more = {}) => ({ id, fields, deleted: false, confirmation: 'unconfirmed', ...more });
const graph = {
  version: 2,
  defects: [entity('d', { location: 'Defect floor' }, { confirmation: 'confirmed' })],
  barriers: [entity('b', { location: 'Retained old barrier location' }, { defect_id: 'd' })],
  services: [entity('s', {}, { barrier_id: 'b' })],
};
let index = physical.indexGraph(graph);
for (const id of ['d', 'b', 's']) {
  assert.equal(physical.effectiveConfirmation(index.get(id), index), 'confirmed');
  assert.equal(physical.columnValue(index.get(id), 'state', index), 'Confirmed');
  assert.equal(physical.columnValue(index.get(id), 'location', index), 'Defect floor');
}
graph.defects[0].confirmation = 'unconfirmed';
graph.barriers[0].confirmation = graph.services[0].confirmation = 'confirmed';
for (const id of ['b', 's']) assert.equal(physical.effectiveConfirmation(index.get(id), index), 'unconfirmed');
const retained = { location: 'Historical bytes', notes: 'Before' };
assert.deepEqual(physical.fieldsFromValues('barrier', { notes: 'After' }, retained), { location: 'Historical bytes', notes: 'After' });
assert.deepEqual(retained, { location: 'Historical bytes', notes: 'Before' });
assert.throws(() => physical.fieldValue('barrier', 'location', 'Override'), /belonging/);
assert.equal(physical.fieldValue('barrier', 'location', 'Plan floor', 'service_plans'), 'Plan floor');
for (const corruption of ['missing', 'deleted', 'wrong-kind', 'cycle']) {
  const value = JSON.parse(JSON.stringify(graph));
  value.defects[0].confirmation = value.services[0].confirmation = 'confirmed';
  if (corruption === 'missing') value.barriers[0].defect_id = 'absent';
  if (corruption === 'deleted') value.defects[0].deleted = true;
  if (corruption === 'wrong-kind') value.services[0].barrier_id = 'd';
  if (corruption === 'cycle') value.barriers[0].defect_id = 's';
  const entries = physical.indexGraph(value);
  assert.equal(physical.effectiveConfirmation(entries.get('s'), entries), 'unconfirmed');
}
const plan = { version: 3, barriers: [entity('b', { location: 'Plan floor' }, { confirmation: 'confirmed' })], services: [entity('s', {}, { barrier_id: 'b' })] };
index = physical.indexGraph(plan);
assert.equal(physical.confirmationOwner(index.get('s'), index).entity.id, 'b');
assert.equal(physical.effectiveConfirmation(index.get('s'), index), 'confirmed');
assert.equal(physical.columnValue(index.get('s'), 'location', index), 'Plan floor');
plan.barriers[0].deleted = true;
assert.equal(physical.effectiveConfirmation(index.get('s'), index), 'unconfirmed');
const legacy = { version: 1, barriers: [entity('b')], defects: [entity('d', {}, { barrier_id: 'b', confirmation: 'confirmed' })], openings: [], services: [] };
index = physical.indexGraph(legacy);
assert.equal(physical.effectiveConfirmation(index.get('d'), index), 'confirmed');
assert.equal(physical.effectiveConfirmation(index.get('b'), index), 'unconfirmed');
process.stdout.write('Parent confirmation and location pure UI regressions passed.\n');
