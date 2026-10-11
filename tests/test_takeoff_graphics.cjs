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
