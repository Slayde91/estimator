"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const detail = require("../static/library-detail-text.js");
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
console.log("PASS Technical display text, exact numbers/conditions, protected links and original list parsing");

// Numbering is removed before each text node is formatted in the browser.
// Preserve source capitalisation when shortening removes the opening word.
const steps = detail.render(document, "1. The aperture remains sealed.\n2. The wrap must remain secured.", {compact:true});
assert.equal(steps[0].children[0].textContent, "Aperture remains sealed.");
assert.equal(steps[0].children[1].textContent, "Wrap must remain secured.");
