"use strict";
const assert = require("node:assert/strict");
const { parse, render } = require("../static/library-detail-text.js");

const item = (text, number) => ({ text, children: [], ...(number === undefined ? {} : { number }) });
const paragraph = text => ({ type: "paragraph", text });
const list = (ordered, ...items) => ({ type: "list", ordered, items });

// The marked source-page headings disappear, but installation references to a
// drawing page within an instruction are retained.
assert.deepEqual(parse("Source page 1, 2\nFit the frame.\nSource page 1\nSecure at 150mm centres."), [paragraph("Fit the frame."), paragraph("Secure at 150mm centres.")]);
assert.deepEqual(parse("Source pages 1–3\n1. See source page 2 for approved services.\n2. Fit the wrap (as per Page 2)."), [list(true, item("See source page 2 for approved services.", 1), item("Fit the wrap (as per Page 2).", 2))]);
assert.deepEqual(parse("Source page 1 contains the installation instructions.\nSource page 2: confirm the wall type."), [paragraph("Source page 1 contains the installation instructions. Source page 2: confirm the wall type.")]);
assert.deepEqual(parse("1. Cut hole to an approved Max size.Cut ryanbatt 502 board to size."), [list(true, item("Cut hole to an approved Max size. Cut ryanbatt 502 board to size.", 1))]);
assert.deepEqual(parse("Keep size.Cut, object.Cut and https://example.com/size.Cut unchanged."), [paragraph("Keep size.Cut, object.Cut and https://example.com/size.Cut unchanged.")]);

// PDF hard wraps, including a page gap inside a sentence, reflow without
// changing dimensions, FRLs, report references or significant punctuation.
assert.deepEqual(parse("  Install 2 layers of FIREFLYBatt friction fitted\r\ntogether, glued and sealed into the aperture\n\nusing FIREFLYMastic.\n\nAny ratio of D2 copper communication cables may\nbe included with D1 cable sets.  "), [paragraph("Install 2 layers of FIREFLYBatt friction fitted together, glued and sealed into the aperture using FIREFLYMastic."), paragraph("Any ratio of D2 copper communication cables may be included with D1 cable sets.")]);
assert.deepEqual(parse("Use self-\ndrilling screws at 300 mm centres."), [paragraph("Use self-drilling screws at 300 mm centres.")]);
assert.deepEqual(parse("Use a 4-\nsided wrap.\nOR\nUse a 3-sided wrap."), [paragraph("Use a 4-sided wrap."), paragraph("OR"), paragraph("Use a 3-sided wrap.")]);
assert.deepEqual(parse("Seal all gaps.\n\n.\n\nSecure the wrap\n."), [paragraph("Seal all gaps."), paragraph("Secure the wrap.")]);
assert.deepEqual(parse("1.5 mm steel, 3.2 report clause and -/60/60.\n2024. Report FAS190236 applies.\n- 5 mm clearance is not a list marker."), [paragraph("1.5 mm steel, 3.2 report clause and -/60/60. 2024. Report FAS190236 applies. - 5 mm clearance is not a list marker.")]);
assert.deepEqual(parse("- /60/60 is the required FRL."), [paragraph("- /60/60 is the required FRL.")]);
assert.deepEqual(parse("- 8 × RG6 cables\n- 13 × 1.5 mm2 2C Fire alarm cables\n- 1 empty conduit"), [list(false, item("8 × RG6 cables"), item("13 × 1.5 mm2 2C Fire alarm cables"), item("1 empty conduit"))]);

// Numbering is structural and preserves starting/skipped/restarted steps.
assert.deepEqual(parse("3. Fix the board\nusing M6 anchors.\n5) Seal the gap.\n(6) Fit wrap.\n1. New alternative."), [list(true, item("Fix the board using M6 anchors.", 3), item("Seal the gap.", 5), item("Fit wrap.", 6)), list(true, item("New alternative.", 1))]);
assert.deepEqual(parse("1. Apply sealant.\n\n2. Fit collar.\n\nEnsure all gaps are sealed."), [list(true, item("Apply sealant.", 1), item("Fit collar.", 2)), paragraph("Ensure all gaps are sealed.")]);
assert.deepEqual(parse("1. Cut opening.\n2. 2. Fill annular gap."), [list(true, item("Cut opening.", 1), item("Fill annular gap.", 2))]);
assert.deepEqual(parse("2. 2.2 remains a clause.\n3. 4. remains a distinct reference."), [list(true, item("2.2 remains a clause.", 2), item("4. remains a distinct reference.", 3))]);

// Existing sub-bullets remain inside their numbered installation step.
assert.deepEqual(parse("1. Install the board using:\n− Min. 4.2 mm screws at\n300 mm centres.\n− 90 mm pigtail screws.\n2. Seal all edges.\nNOTE:\n• Follow the selected detail."), [list(true, { text: "Install the board using:", number: 1, children: [list(false, item("Min. 4.2 mm screws at 300 mm centres."), item("90 mm pigtail screws."))] }, item("Seal all edges.", 2)), paragraph("NOTE:"), list(false, item("Follow the selected detail."))]);
assert.deepEqual(parse("2. Apply mastic and install the 1st layer of\nFIREFLYBatt using:\n− Min. 4.2 mm screws.\n3. Fix the 2nd layer to the 1st\nlayer using:\n− 90 mm pigtail screws."), [list(true, { text: "Apply mastic and install the 1st layer of FIREFLYBatt using:", number: 2, children: [list(false, item("Min. 4.2 mm screws."))] }, { text: "Fix the 2nd layer to the 1st layer using:", number: 3, children: [list(false, item("90 mm pigtail screws."))] })]);
assert.deepEqual(parse("3. Fix along the internal\nperimeter of the bulkhead using:\n• Min. 4.2 mm screws."), [list(true, { text: "Fix along the internal perimeter of the bulkhead using:", number: 3, children: [list(false, item("Min. 4.2 mm screws."))] })]);
assert.deepEqual(parse("- 21 × CAT5 cables\n- 1 empty conduit\nAircon bundles:\n- 2 × paircoils"), [list(false, item("21 × CAT5 cables"), item("1 empty conduit")), paragraph("Aircon bundles:"), list(false, item("2 × paircoils"))]);
// Local Protection uses the same PDF hard wraps, measured values and nested
// alternatives. Reflowing must preserve the owning step and every dimension.
assert.deepEqual(parse("1. Max. annular gap of 5 mm.\n2. Annular gap in the FIREFLYBatt\ncore hole:\n• Fill with FIREFLY HP to a\nmin. depth of 50 mm, or,\n• With 2 × layers of 40 mm × 2\nmm FIREFLYStrap.\n3. Secure with 3 x 90 mm\npigtail screws."), [list(true, item("Max. annular gap of 5 mm.", 1), { text: "Annular gap in the FIREFLYBatt core hole:", number: 2, children: [list(false, item("Fill with FIREFLY HP to a min. depth of 50 mm, or,"), item("With 2 × layers of 40 mm × 2 mm FIREFLYStrap."))] }, item("Secure with 3 x 90 mm pigtail screws.", 3))]);
assert.deepEqual(parse("FIREFLYMastic HP sealant (Item 74) is\ninstalled in the annular gap (nom. 10\nmm, in an up to Ø110 mm core hole),\nfinished flush each side."), [paragraph("FIREFLYMastic HP sealant (Item 74) is installed in the annular gap (nom. 10 mm, in an up to Ø110 mm core hole), finished flush each side.")]);
// H45 has alternative installation headings between numbered procedures. They
// must not be absorbed into the preceding step, even without a blank line.
assert.deepEqual(parse("Wrap only\n1. Fit the wrap.\n2. Hold the wrap to the profile\nof the purlin\n.\nWith FIREFLYBatt or FIREFLY Penowrap packing\nInstallation through the body of FIREFLYBatt aperture –\n1. Pack the web.\n2. Wrap all four sides.\n3. Seal the packing to ensure there are no visible gaps\nInstallation against a roof with insulation or a concrete slab achieving the\nrequired FRL with 3-sided protection –\n4. Pack the web.\n5. Wrap three sides.\n6. Seal all gaps.\nNote: The purlins must be independently supported such that they do not\napply any loads that compromise the system.\nFIREFLY Penowrap distance on either side of the FIREFLYBatt seal:\n\nSize-specific lengths are in the table."), [paragraph("Wrap only"), list(true, item("Fit the wrap.", 1), item("Hold the wrap to the profile of the purlin.", 2)), paragraph("With FIREFLYBatt or FIREFLY Penowrap packing"), paragraph("Installation through the body of FIREFLYBatt aperture –"), list(true, item("Pack the web.", 1), item("Wrap all four sides.", 2), item("Seal the packing to ensure there are no visible gaps", 3)), paragraph("Installation against a roof with insulation or a concrete slab achieving the required FRL with 3-sided protection –"), list(true, item("Pack the web.", 4), item("Wrap three sides.", 5), item("Seal all gaps.", 6)), paragraph("Note: The purlins must be independently supported such that they do not apply any loads that compromise the system."), paragraph("FIREFLY Penowrap distance on either side of the FIREFLYBatt seal:"), paragraph("Size-specific lengths are in the table.")]);
assert.deepEqual(parse("1. Apply coating for\nInstallation through the body of the aperture before closing the gap.\n2. Seal edges."), [list(true, item("Apply coating for Installation through the body of the aperture before closing the gap.", 1), item("Seal edges.", 2))]);
assert.deepEqual(parse("•\n\nCoat the aperture walls.\n• Fix the board."), [list(false, item("Coat the aperture walls."), item("Fix the board."))]);
assert.deepEqual(parse("Use the selected detail.\n•"), [paragraph("Use the selected detail."), paragraph("•")]);
assert.deepEqual(parse("\n\t\nSource page 1\n\n"), []);
assert.deepEqual(parse(null), []);

// Render as semantic safe DOM elements. Untrusted source markup stays text.
const document = { createElement(tagName) { return { tagName, attributes: {}, children: [], textContent: "", setAttribute(name, value) { this.attributes[name] = value; }, append(...children) { this.children.push(...children); } }; } };
const rendered = render(document, "3. <script>alert(1)</script>\n5. Use 1.5 mm steel.\nNOTE:\n• Keep the gap.");
assert.equal(rendered[0].tagName, "ol");
assert.equal(rendered[0].attributes.start, "3");
assert.equal(rendered[0].children[0].attributes.value, "3");
assert.equal(rendered[0].children[1].attributes.value, "5");
assert.equal(rendered[0].children[0].textContent, "<script>alert(1)</script>");
assert.equal(rendered[1].tagName, "p");
assert.equal(rendered[2].tagName, "ul");
assert.equal(rendered[2].children[0].tagName, "li");
assert.equal(rendered[2].children[0].textContent, "Keep the gap.");
console.log("Library detail text formatting tests passed");
