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
  assert.ok(rows.find(row => row.name === 'Breakdown'));
});

test('Standard Help omits unsupported tools and icons', () => {
  const rows = glossary.catalogue(undefined, false);
  assert.ok(rows.length > 25);
  assert.ok(!rows.some(row => ['Drawing tools', 'Drawing view', 'Register and selection'].includes(row.group)));
  assert.ok(!rows.some(row => row.icon.asset?.startsWith('takeoff') || row.icon.mask));
  assert.ok(!rows.some(row => row.icon.graphic || ['Tools','Merge PDF Files','Organise Pages','Extract Pages'].includes(row.name)));
  assert.ok(rows.some(row => row.name === 'Save'));
});

test('navigation glossary artwork points to an actual header control with a glyph', () => {
  const html = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
  const header = html.match(/<header\b[^>]*>[\s\S]*?<\/header>/)?.[0];
  assert.ok(header, 'The real application header is present');
  for (const row of glossary.catalogue(registry).filter(row => row.group === 'Navigation')) {
    const view = row.icon.selector?.match(/^\.app-header \[data-view="([a-z]+)"\]$/)?.[1];
    if (!view) continue; // Theme uses its own persistent control ID.
    const buttons = [...header.matchAll(new RegExp(`<button\\b[^>]*data-view="${view}"[^>]*>([\\s\\S]*?)<\\/button>`, 'g'))];
    assert.equal(buttons.length, 1, `${row.name} resolves to one actual header control`);
    assert.match(buttons[0][1], /<svg\b|<img\b|class="[^"]*button-symbol/, `${row.name} can clone the real control glyph`);
  }
});

test('PDF graphics and the icon-bearing Tools menu keep their actual artwork and shortcuts', () => {
  const rows = glossary.catalogue(registry), graphics = require('../static/takeoff-graphics.js');
  for (const kind of ['cloud','textbox','stamp','polyline','arrow','rectangle','circle','polygon']) {
    const row = rows.find(row => row.icon.graphic === kind);
    assert.equal(row.name, graphics.labels[kind]);
    assert.deepEqual(row.keys, kind === 'textbox' ? [] : [registry.shortcut(registry.actions[`graphic-${kind}`])]);
    assert.match(row.description, /Click/);
  }
  const tools = rows.find(row => row.name === 'Tools');
  assert.equal(tools.group, 'Drawing view');
  assert.equal(tools.icon.selector, '.takeoff-pdf-tools-menu > button');
  assert.equal(tools.icon.path, 'chevron');
  assert.deepEqual(tools.keys, []);
  assert.match(tools.description, /PDF/);
  for (const name of ['Merge PDF Files','Organise Pages','Extract Pages']) assert.ok(!rows.some(row => row.name === name), `${name} is a text-only control`);
});

test('search finds functions and shortcuts, combines words and honors section', () => {
  const rows = glossary.catalogue(registry);
  const find = (query, category = '') => rows.filter(row => glossary.matches(row, query, category));
  assert.ok(find('  NET   sqm ').some(row => row.name === 'Trace surface'));
  assert.deepEqual(find('shift+a').map(row => row.name), ['Trace surface']);
  assert.ok(find('Ctrl+Z').some(row => row.name === 'Undo drawing point'));
  assert.ok(find('Cmd+Z').some(row => row.name === 'Undo drawing point'));
  assert.ok(find('download', 'Documents').length >= 4);
  assert.deepEqual(find('shift+a', 'Projects and files'), []);
  assert.deepEqual(find('<script>'), [], 'search text never becomes HTML');
});

test('the glossary describes real symbols rather than inventing icons for text-only controls', () => {
  const rows = glossary.catalogue(registry);
  const removed = ['New', 'Load / Open project', 'Edit / Back to previous item', 'Project search and sort', 'Use current pricing', 'Source diagram / Open image', 'View / Edit item', 'Apply to selected', 'Confirm / Unconfirm', 'Split / Merge', 'Display Values', 'Show deleted records', 'Continue count / Delete count marker', 'Finish / Cancel drawing', 'Copy / Paste drawing selection', 'Move focus / Activate', 'Navigate a menu'];
  for (const name of removed) assert.ok(!rows.some(row => row.name === name), `${name} has no icon button`);
  const actualTextSymbols = new Set(['+', '⧉', '↶', '− / +', '⊗', 'B I U']);
  for (const row of rows) {
    assert.ok(row.icon.selector || row.icon.graphic || row.icon.path || row.icon.asset || row.icon.format || actualTextSymbols.has(row.icon.text), `${row.name} has real artwork or a button symbol`);
    assert.ok(!row.icon.fallback, `${row.name} cannot substitute a word for artwork`);
  }
  assert.equal(rows.find(row => row.name === 'Column filters').icon.path, 'filter');
  assert.match(rows.find(row => row.name === 'Theme').description, /CLASSIFIRE/);
  assert.doesNotMatch(rows.find(row => row.name === 'Theme').description, /Ceasefire/);
});

test('Takeoff glyphs in Help retain their actual button paths', () => {
  const source = fs.readFileSync(path.join(__dirname, '../static/takeoffs.js'), 'utf8');
  const help = fs.readFileSync(path.join(__dirname, '../static/help-glossary.js'), 'utf8');
  const paths = [...help.matchAll(/^    (?:\w+): "(M[^"\n]+)"/gm)].map(match => match[1]);
  assert.ok(paths.length > 15);
  for (const glyph of paths) assert.ok(source.includes(glyph), `Help uses the existing glyph ${glyph}`);
});
