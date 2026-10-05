"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), { createHash } = require("node:crypto");
const { create } = require("../static/header-tagline-media.js");
function harness(reduced = false) {
  let preference, pagehide, error;
  const element = { dataset: {}, src: "/header-tagline-character-still.png", getAttribute() { return this.src; }, setAttribute(name, value) { assert.equal(name, "src"); this.src = value; }, addEventListener(name, callback) { assert.equal(name, "error"); error = callback; } };
  const motion = { matches: reduced, addEventListener(name, callback) { assert.equal(name, "change"); preference = callback; } };
  const host = { addEventListener(name, callback, options) { assert.equal(name, "pagehide"); assert.deepEqual(options, { once: true }); pagehide = callback; }, CeasefireProject: { changed() { throw Error("Decorative playback cannot dirty a project"); } } };
  return { element, controller: create(element, motion, host), preference(matches) { motion.matches = matches; preference({ matches }); }, pagehide() { pagehide(); }, error() { error(); } };
}
{
  const h = harness(); assert.equal(h.element.dataset.taglineMotion, "stopped"); h.controller.start(); assert.equal(h.element.src, "/header-tagline-character.gif?play=1"); assert.equal(h.element.dataset.taglineMotion, "playing");
  h.controller.stop(); assert.equal(h.element.src, "/header-tagline-character-still.png"); assert.equal(h.element.dataset.taglineMotion, "stopped"); h.controller.start(); assert.equal(h.element.src, "/header-tagline-character.gif?play=2");
  h.preference(true); assert.equal(h.element.src, "/header-tagline-character-still.png"); assert.equal(h.element.dataset.taglineMotion, "reduced"); h.preference(false); assert.equal(h.element.src, "/header-tagline-character-still.png");
  h.controller.start(); assert.equal(h.element.src, "/header-tagline-character.gif?play=3"); h.pagehide(); assert.equal(h.element.dataset.taglineMotion, "closed"); h.controller.start(); assert.equal(h.element.src, "/header-tagline-character-still.png");
}
{
  const h = harness(true); h.controller.start(); assert.equal(h.element.src, "/header-tagline-character-still.png"); assert.equal(h.element.dataset.taglineMotion, "reduced");
  h.preference(false); assert.equal(h.element.src, "/header-tagline-character-still.png"); h.controller.start(); h.error(); assert.equal(h.element.src, "/header-tagline-character-still.png"); h.controller.start(); assert.equal(h.element.src, "/header-tagline-character-still.png");
}
{
  const controller = create(null, null, null); controller.start(); controller.stop(); controller.close();
}
const supplied = {
  "static/header-tagline-character.gif": "f5f03c31d3b023fec8c43ea2518edd11f58e60d6011914ccdf969aabd59ff946",
  "static/icons/takeoff-bullet-list.png": "1f1795391d86075178ef00643f1f542a5b3d7e265e2d9b5936e14383be74aeb1",
  "static/icons/takeoff-numbered-list.png": "cf460d4d3abdea95108723792e2fdf50485cf50a6ff0984c81024542a1656b44",
  "static/icons/takeoff-visibility.png": "7f9d93735ade126cdb8c5f1e9d5403346e3bfd4c7a95ba73349205bd9a4687fb",
};
for (const [file, expected] of Object.entries(supplied)) assert.equal(createHash("sha256").update(fs.readFileSync(file)).digest("hex"), expected, `Exact original attached bytes retained: ${file}`);
console.log("Header character lifecycle/reduced-motion and four exact supplied-asset checks passed");
