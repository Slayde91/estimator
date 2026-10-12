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

test("Text resize scales physical ink locally and leaves shared rich appearance unchanged",()=>{
  for(const kind of ["textbox","stamp"]){
    const value={kind,geometry:{quad_pdf:[[10,20],[110,20],[110,80],[10,80]]},text:"NOTE",appearance:{...X.defaults(),font_size:11.54321}},prior=structuredClone(value);
    const expanded={quad_pdf:[[10,20],[210,20],[210,140],[10,140]]},geometry=X.resizedTextBox(value,expanded,2);
    assert.ok(geometry.text_scale>2);assert.equal(X.fontSize({...value,geometry}),value.appearance.font_size*geometry.text_scale);assert.deepEqual(value,prior);
    const translated=X.stampAt(geometry,[300,400],[0,0,600,800]);assert.equal(translated.text_scale,geometry.text_scale);
    const make=(tag,attributes)=>({tag,attributes,children:[],append(...nodes){this.children.push(...nodes);}});
    const tree=X.paint({...value,geometry},p=>p,.5,make,{measureText:()=>({width:4})}),text=tree.children[0].children.find(n=>n.tag==="text");assert.equal(text.attributes["font-size"],X.fontSize({...value,geometry})*.5);
  }
  const image={kind:"stamp",geometry:{quad_pdf:[[0,0],[100,0],[100,60],[0,60]]},stamp_image:{},appearance:X.defaults()},next={quad_pdf:[[0,0],[200,0],[200,120],[0,120]]};assert.equal(X.resizedTextBox(image,next),next);assert.equal(next.text_scale,undefined);
});

test("Reusable stamps translate the same affine PDF box to the exact clicked centre",()=>{
  for(const matrix of [[1,0,0,-1,0,800],[0,2,2,0,-40,-20],[-.7,0,0,.7,420,-30],[0,-.5,-.5,0,400,300]]){
    const geometry=X.box([[100,200],[220,260]],p=>G.transform(p,matrix),p=>G.inverse(p,matrix)), prior=structuredClone(geometry);
    const placed=X.stampAt(geometry,[300.25,400.75],[0,0,600,800]);
    assert.deepEqual(geometry,prior);
    for(const axis of [0,1])assert.ok(Math.abs(placed.quad_pdf.reduce((sum,p)=>sum+p[axis],0)/4-[300.25,400.75][axis])<1e-10);
    for(const i of [1,2,3])for(const axis of [0,1])assert.ok(Math.abs((placed.quad_pdf[i][axis]-placed.quad_pdf[0][axis])-(geometry.quad_pdf[i][axis]-geometry.quad_pdf[0][axis]))<1e-10);
    assert.throws(()=>X.stampAt(geometry,[1,1],[0,0,600,800]),/whole stamp/);
  }
  assert.throws(()=>X.stampAt({quad_pdf:[[0,0],null,[2,2],[0,2]]},[1,1],[0,0,2,2]),/valid stamp/);
});

const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK3cAAAAASUVORK5CYII=","base64");
const storedImage={version:1,mime_type:"image/png",content_base64:png.toString("base64"),width:1,height:1,sha256:require("node:crypto").createHash("sha256").update(png).digest("hex")};
test("Bounded PNG/JPEG headers reject spoofed, animated and oversized image content",()=>{
  assert.deepEqual(X.stampImageHeader(png),{mime_type:"image/png",width:1,height:1});
  const jpeg=Uint8Array.from([255,216,255,192,0,8,8,0,2,0,3,1,255,217]);
  assert.deepEqual(X.stampImageHeader(jpeg),{mime_type:"image/jpeg",width:3,height:2});
  assert.throws(()=>X.stampImageHeader(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),/PNG or JPEG/);
  const huge=Buffer.from(png);huge.writeUInt32BE(4097,16);assert.throws(()=>X.stampImageHeader(huge),/4,096/);
  const bomb=Buffer.from(png);bomb.writeUInt32BE(3000,16);bomb.writeUInt32BE(3000,20);assert.throws(()=>X.stampImageHeader(bomb),/4 million/);
  const animated=Buffer.from(png);animated.write("acTL",37);assert.throws(()=>X.stampImageHeader(animated),/single-frame/);
  assert.throws(()=>X.stampImageHeader(new Uint8Array(X.imageByteLimit+1)),/2 MiB/);
});
test("Stamp file checking binds actual bytes, checks decode and releases the bitmap",async()=>{
  let closed=0;const file={size:png.length,type:"image/png",arrayBuffer:async()=>png.buffer.slice(png.byteOffset,png.byteOffset+png.length)};
  assert.deepEqual(await X.stampImage(file,async()=>({width:1,height:1,close(){closed++;}})),{mime_type:"image/png",content_base64:png.toString("base64")});assert.equal(closed,1);
  await assert.rejects(X.stampImage({...file,type:"image/jpeg"},async()=>{throw new Error("should not decode spoof");}),/does not match/);
  await assert.rejects(X.stampImage(file,async()=>{throw new Error("invalid image decode");}),/invalid image decode/);
  await assert.rejects(X.stampImage(file,async()=>({width:4097,height:1,close(){closed++;}})),/4,096/);assert.equal(closed,2);
});
test("Image Stamp uses only validated embedded PNG inside its padded affine box",()=>{
  const make=(tag,attributes)=>({tag,attributes,children:[],append(...nodes){this.children.push(...nodes);}});
  const value={kind:"stamp",geometry:{quad_pdf:[[10,10],[110,10],[110,70],[10,70]]},text:"",stamp_image:storedImage,appearance:X.defaults()}, before=structuredClone(value);
  const tree=X.paint(value,p=>p,1,make,{}), image=tree.children[0].children.find(x=>x.tag==="image");
  assert.equal(image.attributes.href,`data:image/png;base64,${storedImage.content_base64}`);assert.equal(image.attributes.preserveAspectRatio,"xMidYMid meet");assert.deepEqual([image.attributes.x,image.attributes.y,image.attributes.width,image.attributes.height],[6,6,88,48]);assert.ok(!tree.children[0].children.some(x=>x.tag==="text"));assert.deepEqual(value,before);
  for(const change of [{mime_type:"image/svg+xml"},{content_base64:"https://example.test/image.png"},{content_base64:"abc"},{width:5000},{sha256:"not-a-hash"}])assert.throws(()=>X.stampDataUrl({...storedImage,...change}),/invalid|4,096/);
  const atLimit={...storedImage,content_base64:Buffer.alloc(X.imageByteLimit).toString("base64")};assert.ok(X.stampDataUrl(atLimit).startsWith("data:image/png;base64,"));
  assert.throws(()=>X.stampDataUrl({...storedImage,content_base64:Buffer.alloc(X.imageByteLimit+1).toString("base64")}),/exceeds 2 MiB|invalid/);
});

test("PDF Area paints all explicit rings with even-odd holes and an exact-version interior m² label",()=>{
  const make=(tag,attributes)=>({tag,attributes,children:[],append(...nodes){this.children.push(...nodes);}});
  const value={kind:"area",version:4,geometry:{points:[[10,20],[110,20],[110,80],[10,80]],exclusions:[{id:"hole",note:"Opening",points:[[30,30],[50,30],[50,40],[30,40]]}]},appearance:{...X.defaults(),fill_enabled:true}},before=structuredClone(value);
  const result={version:4,status:"current",net_area_m2:12.3456789,label_point_pdf:[75,50]},tree=X.paint(value,p=>p.map(n=>n*2),2,make,{},result);
  assert.equal(tree.children[0].tag,"path");assert.equal(tree.children[0].attributes["fill-rule"],"evenodd");
  assert.equal(tree.children[0].attributes.d,"M 20 40 L 220 40 L 220 160 L 20 160 Z M 60 60 L 100 60 L 100 80 L 60 80 Z");
  assert.equal(tree.children[1].textContent,"12.35 m²");assert.equal(tree.children[1].attributes.x,150);assert.equal(tree.children[1].attributes.y,100);
  for(const change of [{version:3},{status:"needs_review"},{net_area_m2:null},{label_point_pdf:null}])assert.equal(X.paint(value,p=>p,1,make,{}, {...result,...change}).children.length,1);
  assert.deepEqual(value,before,"Neither stored geometry nor full precision is rounded by rendering");
});
