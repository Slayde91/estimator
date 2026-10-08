"use strict";
const assert = require("node:assert/strict");
const links = require("../static/takeoff-library-links.js");
const copy = value => JSON.parse(JSON.stringify(value));
let passed = 0;
async function test(name, fn) { await fn(); ++passed; console.log(`ok - ${name}`); }

const record = {
  id: "selected", library_id: "FL-ID-001", metadata_sha256: "a".repeat(64),
  title: "A title with tempting diameter 900 mm and irrelevant location",
  display_fields: {
    service_type: "Copper pipe", penetration_type: "Core Hole", substrate: "Concrete",
    orientation: "Vertical", frl: "-/120/120", service_size: "25.123456789012 mm"
  }, import_fields: {defect: {}, barrier: {}, service: {diameter_mm: 25.123456789012}}
};
const association = {
  library: {id: record.id, library_id: record.library_id, metadata_sha256: record.metadata_sha256, title: record.title},
  members: [{id: "service-one", revision: 42}], installation: {mode: "combined_installation"},
  state: "confirmed", draft_quantity: 700, draft_location: "Long irrelevant location"
};

(async () => {
  await test("picker label uses only the six requested literal fields in order", () => {
    const before = copy(record);
    assert.equal(links.libraryLabel(record), "FL-ID-001; Core Hole; Concrete; Vertical; Copper pipe; -/120/120");
    assert.deepEqual(record, before);
  });
  await test("missing display values are explicit and cannot be inferred from the title", () => {
    assert.equal(links.libraryLabel({id: "selected", title: record.title}), "selected; Unknown; Unknown; Unknown; Unknown; Unknown");
    assert.equal(links.libraryLabel({...record, display_fields: []}), "FL-ID-001; Unknown; Unknown; Unknown; Unknown; Unknown");
  });
  await test("association summary excludes description, review, members, FRL, Location and quantity", () => {
    const before = copy({record, association});
    assert.equal(links.description(association, record), "FL-ID-001\nService Type: Copper pipe\nPenetration Type: Core Hole\nSubstrate: Concrete\nOrientation: Vertical\nService size: 25.123456789012 mm");
    assert.deepEqual({record, association}, before);
  });
  await test("association display refuses current metadata after an ID or fingerprint mismatch", () => {
    const unknown = "FL-ID-001\nService Type: Unknown\nPenetration Type: Unknown\nSubstrate: Unknown\nOrientation: Unknown\nService size: Unknown";
    for (const candidate of [null, {...record, id: "other"}, {...record, metadata_sha256: "b".repeat(64)}]) {
      assert.equal(links.matchingRecord(association, candidate), false);
      assert.equal(links.description(association, candidate), unknown);
    }
    assert.equal(links.matchingRecord(association, record), true);
  });
  await test("literal display folds whitespace without parsing markup or rounding dimensions", () => {
    const candidate = {...record, display_fields: {...record.display_fields, substrate: " <script>literal</script>\n concrete\t ", service_size: "25.123456789012 mm\n100.234567890123 mm wide"}};
    assert.match(links.libraryLabel(candidate), /; <script>literal<\/script>  concrete;/);
    assert.match(links.description(association, candidate), /Service size: 25\.123456789012 mm 100\.234567890123 mm wide$/);
  });
  await test("the actual search setup writes six-field labels with textContent only", async () => {
    const originalFetch = global.fetch, captured = [];
    class Element {
      constructor(tag = "input") { this.tagName = tag; this.children = []; this.events = {}; this.value = ""; this.disabled = false; this.ownerDocument = doc; }
      set innerHTML(value) { throw new Error("Picker must never render HTML from library evidence"); }
      setAttribute() {}
      after() {}
      closest() { return new Element("label"); }
      append(...children) { this.children.push(...children); }
      replaceChildren(...children) { this.children = [...children]; }
      addEventListener(name, fn) { this.events[name] = fn; }
      get options() { return this.children; }
    }
    const doc = {createElement: tag => new Element(tag)};
    global.fetch = async url => ({ok: true, json: async () => url.includes("/takeoff") ? copy(record) : {items: [{...copy(record), display_fields: {...record.display_fields, substrate: "<img src=x onerror=boom>"}}], total: 1, filters: []}});
    try {
      const chosen = await links.choose({ask: async (title, fields, message, submit, setup) => {
        const controls = fields.map(field => ({control: Object.assign(new Element(), {name: field[0]})}));
        await setup(controls, () => {});
        if (title === "Search Firestopping Library") {
          captured.push(...controls.find(field => field.control.name === "library_id").control.options);
          return {library_id: "selected"};
        }
        return {location: "L02", quantity: "700"};
      }}, true);
      assert.equal(captured.length, 2);
      assert.equal(captured[1].textContent, "FL-ID-001; Core Hole; <img src=x onerror=boom>; Vertical; Copper pipe; -/120/120");
      assert.deepEqual(captured[1].children, []);
      assert.equal(chosen.details.item_quantity, 700);
    } finally { global.fetch = originalFetch; }
  });
  console.log(`${passed} literal library display contracts passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
