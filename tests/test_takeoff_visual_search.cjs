"use strict";
const assert = require("node:assert/strict");
const visual = require("../static/takeoff-visual-search.js");
function gray(width, height) { return { width, height, data: new Uint8Array(width * height).fill(255) }; }
function symbol() {
  const value = gray(28, 24);
  for (let y = 4; y < 20; y++) for (let x = 5; x < 23; x++) if (x < 8 || y < 7 || (y > 14 && x > 15)) value.data[y * value.width + x] = 0;
  return value;
}
function stamp(page, sample, left, top, noise = 0) {
  for (let y = 0; y < sample.height; y++) for (let x = 0; x < sample.width; x++) {
    const original = sample.data[y * sample.width + x], shift = noise ? ((x * 7 + y * 13) % 13 - 6) * noise : 0;
    page.data[(top + y) * page.width + left + x] = Math.max(0, Math.min(255, original + shift));
  }
}
let count = 0;
async function check(name, action) { await action(); count++; console.log(`ok - ${name}`); }
(async () => {
  await check("real pixel matches retain exact positions and suppress nearby duplicate windows", async () => {
    const sample = symbol(), page = gray(180, 130); stamp(page, sample, 14, 18); stamp(page, sample, 96, 72, 2);
    // A different shape and blank background must not acquire a match.
    for (let y = 25; y < 43; y++) for (let x = 105; x < 123; x++) page.data[y * page.width + x] = 0;
    const matches = await visual.find(page, sample, { sensitivity: .9 });
    assert.equal(matches.length, 2); assert.deepEqual(matches.map(m => [m.x, m.y]), [[14, 18], [96, 72]]);
    assert.ok(matches.every(m => m.score >= .9 && m.rotation === 0));
  });
  await check("multiple rotations find the independently rotated asymmetric symbol", async () => {
    const sample = symbol(), page = gray(180, 130); stamp(page, sample, 15, 20); stamp(page, visual.rotate(sample, 90), 112, 70);
    const normal = await visual.find(page, sample, { sensitivity: .97 }); assert.equal(normal.length, 1);
    const rotated = await visual.find(page, sample, { sensitivity: .97, rotations: true });
    assert.equal(rotated.length, 2); assert.deepEqual(rotated.map(m => [m.x, m.y, m.rotation]), [[15, 20, 0], [112, 70, 90]]);
  });
  await check("blank, invalid and excessive samples fail explicitly without partial matches", async () => {
    await assert.rejects(visual.find(gray(100, 100), gray(20, 20)), /foreground/);
    await assert.rejects(visual.find(gray(100, 100), gray(7, 20)), /between 8 and 512/);
    await assert.rejects(visual.find(gray(100, 100), symbol(), { sensitivity: 1 }), /sensitivity/);
    const sample = symbol(), page = gray(150, 100); stamp(page, sample, 10, 10); stamp(page, sample, 90, 50);
    await assert.rejects(visual.find(page, sample, { maximum: 1 }), /More than 1 matches/);
  });
  await check("cancellation and deadlines stop matching", async () => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(visual.find(gray(200, 200), symbol(), { signal: controller.signal }), error => error.name === "AbortError");
    await assert.rejects(visual.find(gray(200, 200), symbol(), { deadline: 1 }), /three-minute/);
  });
  await check("result rectangles map to original cropped/rotated PDF coordinates", async () => {
    const box = { x: 20, y: 30, width: 40, height: 50 };
    assert.deepEqual(visual.sourceRegion(box, [2, 0, 0, -2, -20, 300]), [[20,135],[40,135],[40,110],[20,110]]);
    assert.deepEqual(visual.inverse([40,60], [0,2,2,0,-20,-40]), [50,30]);
    assert.throws(() => visual.inverse([1,2], [0,0,0,0,0,0]), /invalid/);
  });
  await check("alpha compositing treats transparent pixels as page white", async () => {
    assert.deepEqual([...visual.image({width:2,height:1,data:new Uint8Array([0,0,0,0,0,0,0,255])}).data], [255,0]);
  });
  await check("different page render scales use an explicitly resized example", async () => {
    const original=symbol(), doubled=visual.resize(original,2);assert.equal(doubled.width,56);assert.equal(doubled.height,48);
    const page=gray(180,130);stamp(page,doubled,50,40);const matches=await visual.find(page,doubled,{sensitivity:.98});assert.equal(matches.length,1);assert.deepEqual([matches[0].x,matches[0].y],[50,40]);
    assert.throws(()=>visual.resize(original,0),/invalid/);assert.throws(()=>visual.resize(original,.01),/too small/);
  });
  console.log(`${count} visual-search engine checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
