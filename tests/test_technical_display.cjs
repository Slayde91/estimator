"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const detail = require("../static/library-detail-text.js");
for (const entry of require("./fixtures/technical-reading-display.json")) {
  assert.equal(detail.readable(entry.source), entry.display, entry.source);
  assert.equal(detail.readable(entry.display), entry.display);
  assert.deepEqual(entry.source.match(/\d+/g), entry.display.match(/\d+/g));
}
const sourceReference = "With FyreFLEX per Table 15 (see Figure 6).";
for (const label of ["Installation Details", "Seal Depth / Fillet Size"]) {
  assert.equal(detail.fieldText(label, sourceReference), sourceReference);
}
assert.equal(detail.fieldText("Service Wrap", sourceReference), detail.compact(sourceReference));
assert.equal(detail.fieldText("Service Wrap", "No wrap;one Unicorn collar layer"), "No wrap; one Unicorn collar layer");
for (const entry of require('./fixtures/technical-page-display.json')) {
  assert.equal(detail.compact(entry.source), entry.display, entry.source);
  assert.equal(detail.compact(entry.display), entry.display, 'Page locator cleanup is stable');
}
for (const entry of require('./fixtures/technical-diameter-display.json')) {
  assert.equal(detail.compact(entry.source), entry.display, entry.source);
  assert.equal(detail.compact(entry.display), entry.display, 'Repeated diameter cleanup is stable');
}
for (const entry of require('./fixtures/technical-reference-display.json')) {
  assert.equal(detail.compact(entry.source), entry.display, entry.source);
  assert.equal(detail.compact(entry.display), entry.display, 'Repeated locator cleanup is stable');
}
for (const [id, title, expected] of [
  ['promat-123', 'Promat: 123 — Cables — -/120/120 — Vertical', 'Promat — Cables — -/120/120 — Vertical'],
  ['trafalgar-selector-456', 'Trafalgar 456 — 50 mm pipe', 'Trafalgar — 50 mm pipe'],
  ['trafalgar-selector-456', 'Trafalgar:456 – 50 mm pipe', 'Trafalgar — 50 mm pipe'],
  ['promat-123', 'Promat: V11A — 2 layers', 'Promat: V11A — 2 layers'],
  ['boss-123', 'BOSS: 123 — Pipe', 'BOSS: 123 — Pipe'],
  ['firefly-123', 'Promat: 123 — Pipe', 'Promat: 123 — Pipe'],
  ['promat-123', 'PROMASEAL 123 mm — Pipe', 'PROMASEAL 123 mm — Pipe'],
]) {
  const record = {id, title}, before = JSON.stringify(record);
  assert.equal(detail.displayTitle(record), expected);
  assert.equal(detail.displayTitle({...record, title: expected}), expected);
  assert.equal(JSON.stringify(record), before);
}
assert.equal(detail.displaySubtitle({id:'promat-123',subtitle:'FC12345 — 120 minutes · Wall · 12 selector variants'}), 'FC12345 — 120 minutes · Wall');
assert.equal(detail.displaySubtitle({id:'trafalgar-selector-456',subtitle:'1 selector variant'}), '');
assert.equal(detail.displaySubtitle({id:'trafalgar-selector-456',subtitle:'1 selector variant'}, () => 'Not recorded'), '');
assert.equal(detail.displaySubtitle({id:'boss-123',subtitle:'3 selector variants · 50 mm'}), '3 selector variants · 50 mm');
assert.equal(detail.displaySubtitle({id:'promat-123',subtitle:'3 selector variants require 50 mm wrap'}), '3 selector variants require 50 mm wrap');
assert.equal(detail.visibleField({id:'promat-123'}, {label:'ID',value:'123'}), false);
assert.equal(detail.visibleField({id:'trafalgar-selector-456'}, {label:'ID',value:'V11A'}), true);
assert.equal(detail.visibleField({id:'boss-123'}, {label:'ID',value:'123'}), true);
assert.equal(detail.visibleField({id:'promat-123'}, {label:'Pipe size',value:'123 mm'}), true);
assert.equal(detail.visibleField({id:'promat-123'}, {label:'Source Information',value:'Internal source'}), false);
assert.equal(detail.visibleField({id:'source'}, {label:'Source Information',value:'Internal source'}, 'penetration'), false);
assert.equal(detail.visibleField({id:'source'}, {label:'Service',value:'',table:{columns:['Size'],rows:[['50 mm']]}}), true);
const generatedId = 'tv-' + 'a'.repeat(40);
for (const [manufacturer, source_code] of [['Promat', 'sys_var_1138717_au'], ['Trafalgar', '1165']]) {
  const configuration = 'Pipe with minimum 25 mm wrap (see Table 7)';
  const title = `${manufacturer}: ${source_code} — ${configuration}`;
  const record = {id:generatedId, source_code, configuration, title, fields:[{label:'Manufacturer', value:manufacturer}]};
  assert.equal(detail.visibleField(record, {label:'ID', value:source_code}), true);
  assert.equal(detail.displayTitle(record, detail.compact), title);
  assert.equal(detail.displayTitle({...record, title:''}), `${source_code} — ${configuration}`);
  const subtitle = source_code + ' — ' + configuration;
  assert.equal(detail.displaySubtitle({...record, title:'Site-specific reference', subtitle}, detail.compact), subtitle);
}
for (const title of ['', generatedId, 'Promat: ' + generatedId + ' — Pipe']) {
  assert.equal(detail.displayTitle({id:generatedId, title}), 'Technical Library item');
}
assert.equal(detail.displayTitle({id:'tv-owner-code'}), 'tv-owner-code');
const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/technical-compact-display.json"), "utf8"));
for (const entry of vectors) {
  assert.equal(detail.compact(entry.source), entry.display);
  assert.deepEqual(entry.display.match(/-?\d+(?:\.\d+)?/g), entry.source.match(/-?\d+(?:\.\d+)?/g));
  assert.equal(detail.compact(entry.display), entry.display);
}
// Parsing source markers and wrapped headings still consumes original evidence;
// compacting is confined to the rendered text nodes.
const source = "With FIREFLYBatt\nInstallation through concrete —\n1. Apply minimum 50 mm with 2 fixings per 300 mm.";
const before = detail.parse(source);
const document = { createElement(tag) { return { tag, children: [], setAttribute() {}, append(...children) { this.children.push(...children); } }; } };
const rendered = detail.render(document, source, { compact: true });
assert.deepEqual(detail.parse(source), before);
assert.equal(rendered.at(-1).children[0].textContent, "Apply min. 50 mm w/ 2 fixings p/ 300 mm.");
const diameterSource = 'Diameter range (mm): 20\nMinimum diameter (mm): 20\nMaximum diameter (mm): 20';
const diameterParsed = detail.parse(diameterSource);
assert.equal(detail.render(document, diameterSource, {compact:true})[0].textContent, 'Diameter (mm): 20');
assert.deepEqual(detail.parse(diameterSource), diameterParsed, 'Display cleanup does not mutate original parsing');
assert.match(detail.render(document, diameterSource, {compact:false})[0].textContent, /Minimum diameter/);
const measuredSource = 'Diameter range (mm): 20\nMinimum diameter (mm): 20\nMaximum diameter (mm): 20\nWall thickness (mm): 2.2';
assert.equal(detail.render(document, measuredSource, {compact:true})[0].textContent, 'Diameter (mm): 20 Wall thickness (mm): 2.2');
console.log("PASS Technical display text, exact numbers/conditions, protected links and original list parsing");

// Numbering is removed before each text node is formatted in the browser.
// Preserve source capitalisation when shortening removes the opening word.
const steps = detail.render(document, "1. The aperture remains sealed.\n2. The wrap must remain secured.", {compact:true});
assert.equal(steps[0].children[0].textContent, "Aperture remains sealed.");
assert.equal(steps[0].children[1].textContent, "Wrap must remain secured.");
const lowercaseSteps = detail.render(document, "1. the aperture remains sealed.\n2. install Penowrap for 300 mm.", {compact:true});
assert.equal(lowercaseSteps[0].children[0].textContent, "Aperture remains sealed.");
assert.equal(lowercaseSteps[0].children[1].textContent, "Install wrap for 300 mm.");
