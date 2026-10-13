const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const glossary = require('../static/help-glossary.js');
const registry = require('../static/takeoff-shortcuts.js');

test('documented tool shortcuts come from the actual dispatch registry', () => {
  const rows = glossary.catalogue(registry);
  for (const [action, value] of Object.entries(registry.actions)) {
    const row = rows.find(row => row.action === action);
    assert.ok(row, `Help covers ${action}`);
    assert.deepEqual(row.keys, [registry.shortcut(value)]);
  }
  const signature = rows.find(row => row.name === 'Signatures');
  assert.deepEqual(signature.keys, ['Ctrl+Shift+S']);
  assert.ok(rows.find(row => row.name === 'Estimate Summary'));
});

test('Standard Help omits unsupported tools and icons', () => {
  const rows = glossary.catalogue(undefined, false);
  assert.ok(rows.length > 25);
  assert.ok(!rows.some(row => ['Drawing tools', 'Drawing view', 'Register and selection'].includes(row.group)));
  assert.ok(!rows.some(row => row.icon.asset?.startsWith('takeoff') || row.icon.mask));
  assert.ok(!rows.some(row => row.icon.graphic || ['Tools','Merge PDF Files','Organise Pages','Extract Pages'].includes(row.name)));
  assert.ok(rows.some(row => row.name === 'Save'));
});

test('PDF graphics and page tools are documented without invented shortcuts', () => {
  const rows = glossary.catalogue(registry), graphics = require('../static/takeoff-graphics.js');
  for (const kind of ['cloud','textbox','stamp','polyline','arrow','rectangle','circle','polygon']) {
    const row = rows.find(row => row.icon.graphic === kind);
    assert.equal(row.name, graphics.labels[kind]);
    assert.deepEqual(row.keys, kind === 'textbox' ? [] : [registry.shortcut(registry.actions[`graphic-${kind}`])]);
    assert.match(row.description, /Click/);
  }
  for (const name of ['Tools','Merge PDF Files','Organise Pages','Extract Pages']) {
    const row = rows.find(row => row.name === name);
    assert.equal(row.group, 'Drawing view');
    assert.deepEqual(row.keys, []);
    assert.match(row.description, /PDF/);
  }
});

test('search finds functions and shortcuts, combines words and honors section', () => {
  const rows = glossary.catalogue(registry);
  const find = (query, category = '') => rows.filter(row => glossary.matches(row, query, category));
  assert.ok(find('  NET   sqm ').some(row => row.name === 'Trace surface'));
  assert.deepEqual(find('shift+a').map(row => row.name), ['Trace surface']);
  assert.ok(find('Ctrl+C').some(row => row.id === 'drawing-copy'));
  assert.ok(find('Cmd+V').some(row => row.id === 'drawing-copy'));
  assert.ok(find('download', 'Documents').length >= 4);
  assert.deepEqual(find('shift+a', 'Projects and files'), []);
  assert.deepEqual(find('<script>'), [], 'search text never becomes HTML');
});

test('Takeoff glyphs in Help retain their actual button paths', () => {
  const source = fs.readFileSync(path.join(__dirname, '../static/takeoffs.js'), 'utf8');
  const help = fs.readFileSync(path.join(__dirname, '../static/help-glossary.js'), 'utf8');
  const paths = [...help.matchAll(/^    (?:\w+): "(M[^"\n]+)"/gm)].map(match => match[1]);
  assert.ok(paths.length > 15);
  for (const glyph of paths) assert.ok(source.includes(glyph), `Help uses the existing glyph ${glyph}`);
});
