"use strict";
const {test} = require("node:test"), assert = require("node:assert/strict");
const X = require("../static/takeoff-graphics.js"), G = require("../static/takeoff-geometry.js");
test("Box corners preserve semantic screen axes through rotation, crop, fractional zoom and UserUnit", () => {
  for (const matrix of [[.73,0,0,-.73,-14.6,416.1],[0,1.46,1.46,0,-43.8,-29.2],[-1.13,0,0,1.13,904,-33.9],[0,-.61,-.61,0,347.7,488]]) {
    const original = [[100.125,200.875],[230.625,315.5]], display = original.map(p=>G.transform(p,matrix));
    const bounds=G.bounds(display), expected=[[bounds[0],bounds[1]],[bounds[2],bounds[1]],[bounds[2],bounds[3]],[bounds[0],bounds[3]]];
    const geometry=X.box(original,p=>G.transform(p,matrix),p=>G.inverse(p,matrix));
    geometry.quad_pdf.map(p=>G.transform(p,matrix)).forEach((p,i)=>p.forEach((n,axis)=>assert.ok(Math.abs(n-expected[i][axis])<1e-10)));
    const q=geometry.quad_pdf, a=q[1].map((n,i)=>n-q[0][i]),b=q[3].map((n,i)=>n-q[0][i]);assert.ok(Math.abs(a[0]*b[0]+a[1]*b[1])<1e-9);
  }
});
test("Literal drawing text wraps at the requested font size and keeps stamps on one line", () => {
  const measure={measureText:text=>({width:[...text].length*5})};
  assert.deepEqual(X.textLines("<script>\nB & C",20,12,false,measure),["<scr","ipt>","B & ","C"]);
  assert.deepEqual(X.textLines("Approved & signed",20,12,true,measure),["Approved & signed"]);
  assert.equal(measure.font,"bold 12px CeasefireDrawing");
});
test("Paints source geometry using literal text nodes and physical PDF point sizes", () => {
  const make=(tag,attributes)=>({tag,attributes,children:[],append(...nodes){this.children.push(...nodes);}}), measure={measureText:text=>({width:text.length*5})};
  const value={kind:"textbox",geometry:{quad_pdf:[[0,0],[100,0],[100,60],[0,60]]},text:"<b>Literal</b>",appearance:X.defaults()}, before=JSON.stringify(value);
  const tree=X.paint(value,p=>p.map(n=>n*2),.5,make,measure), text=tree.children[0].children.find(child=>child.tag==="text");
  assert.equal(text.textContent,"<b>Literal</b>");assert.equal(text.attributes["font-size"],6);assert.equal(tree.children[0].children[0].attributes["stroke-width"],1);assert.equal(JSON.stringify(value),before);
});
test("Textbox rich runs keep explicit marks, list numbering and fixed physical font size", () => {
  const content={version:1,blocks:[{kind:"paragraph",runs:[{text:"Literal <b>",bold:true,italic:true,underline:true}]},{kind:"bullet",runs:[{text:"Bullet"}]},{kind:"number",runs:[{text:"First"}]},{kind:"number",runs:[{text:"Second"}]},{kind:"paragraph",runs:[{text:"Reset"}]},{kind:"number",runs:[{text:"Again"}]}]};
  const measure={measureText:()=>({width:5})}, lines=X.richTextLines(content,200,12,measure);
  assert.deepEqual(lines.map(line=>line.map(run=>run.text).join("")),["Literal <b>","• Bullet","1. First","2. Second","Reset","1. Again"]);
  assert.equal(lines[0][0].bold,true);assert.equal(lines[0][0].italic,true);assert.equal(lines[0][0].underline,true);
  const make=(tag,attributes)=>({tag,attributes,children:[],append(...nodes){this.children.push(...nodes);}});
  const value={kind:"textbox",geometry:{quad_pdf:[[0,0],[300,0],[300,200],[0,200]]},text:"Literal <b>\nBullet\nFirst\nSecond\nReset\nAgain",text_content:content,appearance:X.defaults()}, before=JSON.stringify(value);
  const tree=X.paint(value,p=>p,.5,make,measure), text=tree.children[0].children.find(child=>child.tag==="text"), first=text.children[0];
  assert.equal(text.attributes["font-size"],6);assert.equal(first.attributes["font-weight"],"bold");assert.equal(first.attributes["font-style"],"italic");assert.equal(first.attributes["text-decoration"],"underline");assert.equal(first.textContent,"L");assert.equal(JSON.stringify(value),before);
});
