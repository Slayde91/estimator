"use strict";
const assert=require('node:assert/strict'),{test}=require('node:test');
const S=require('../static/takeoff-search.js'),L=require('../static/takeoff-ocr-layer.js');
function result(overrides={}){return{version:1,source:'local-ocr',engine:S.OCR_VERSION,sha256:'a'.repeat(64),page:1,width:200,height:120,transform:[2,0,0,-2,0,120],scale:2,options:{...S.OCR_DEFAULTS},partial:false,partialReasons:[],words:[{text:'AIR',confidence:90,quad:[[10,20],[40,20],[40,10],[10,10]],box:[20,80,80,100],readingBox:[20,80,80,100],line:1,rotation:0}],...overrides};}
test('OCR profiles reject unknown paths, prototype language names and invalid flags',()=>{
  assert.equal(S.ocrOptions({language:'fra',documentType:'text',quality:'speed'}).language,'fra');
  for(const settings of [{language:'../outside'},{language:'toString'},{quality:'fastest'},{correctSkew:'yes'},{url:'https://external.invalid'},JSON.parse('{"__proto__":{}}')])assert.throws(()=>S.ocrOptions(settings),/supported OCR/);
});
test('Cached recognition is a sanitized copy bound to exact source/page/options',()=>{
  const original=result(),saved=L.validateResult(original);assert.deepEqual(saved.words,original.words);assert.notEqual(saved.words[0],original.words[0]);
  assert.notEqual(L.recordKey(saved),L.recordKey(result({options:{...S.OCR_DEFAULTS,language:'deu'}})));
  assert.throws(()=>L.validateResult(original,{sha256:'b'.repeat(64),pageNumber:1}),/does not match/);
  assert.throws(()=>L.validateResult(original,{sha256:original.sha256,pageNumber:2}),/does not match/);
  const broken=structuredClone(original);broken.words[0].quad[0][1]=NaN;assert.throws(()=>L.validateResult(broken),/invalid text or geometry/);
  broken.words[0].quad[0][1]=1;broken.words[0].text='bad\u0000text';assert.throws(()=>L.validateResult(broken),/invalid text or geometry/);
});
test('Local storage unavailability keeps a bounded session layer and never invents persistence',async()=>{
  const store=L.createStore({indexedDB:null});assert.equal(store.persistent,false);
  assert.equal((await store.put(result())).persistent,false);assert.equal((await store.get({sha256:'a'.repeat(64),pageNumber:1})).words[0].text,'AIR');
  assert.equal(await store.get({sha256:'b'.repeat(64),pageNumber:1}),null);
  assert.equal(await store.get({sha256:'a'.repeat(64),pageNumber:1,options:{language:'fra'}}),null);
});

test('Restored OCR rejects singular transforms, off-page boxes and inconsistent quads',()=>{
  assert.throws(()=>L.validateResult(result({transform:[0,0,0,0,0,0]})),/singular/);
  for(const change of[
    value=>{value.words[0].box=[20,80,5000,100];},
    value=>{value.words[0].quad[0][0]=500000;},
    value=>{value.words[0].quad[2]=[20,15];},
    value=>{value.words[0].quad=value.words[0].quad.map(([x,y])=>[x+500,y]);value.words[0].box=[1020,80,1080,100];}
  ]){const value=result();change(value);assert.throws(()=>L.validateResult(value),/inconsistent/);}
});
test('Blocked browser database opening and hung transactions have bounded fallbacks',async()=>{
  const blocked=L.createStore({indexedDB:{open:()=>({})},timeoutMs:15});
  const started=Date.now();assert.equal((await blocked.put(result())).persistent,false);assert.ok(Date.now()-started<500);assert.equal(blocked.persistent,false);
  let aborted=0;const database={transaction(){return{objectStore(){return{index(){return{openCursor(){return{};}};},put(){},openCursor(){return{};}};},abort(){aborted++;}};}};
  const hung=L.createStore({indexedDB:{open(){const request={};queueMicrotask(()=>{request.result=database;request.onsuccess();});return request;}},timeoutMs:15});
  assert.equal(await hung.get({sha256:'a'.repeat(64),pageNumber:1}),null);assert.equal((await hung.put(result())).persistent,false);assert.equal(aborted,2);
});
test('An OCR label over native PDF text is excluded without altering either source',()=>{
  const word=result().words[0],native=[{str:'AIR',transform:[10,0,0,10,5,8],width:40,height:20}];
  assert.equal(L.nativeOverlap(word,native),true);assert.equal(L.nativeOverlap(word,[{...native[0],transform:[10,0,0,10,200,200]}]),false);
});
test('Embedded picture footprints use original PDF graphics transforms and save/restore',()=>{
  const ops={save:1,restore:2,transform:3,paintImageXObject:4,paintInlineImageXObject:5,paintImageMaskXObject:6};
  const quads=S.imageQuads({fnArray:[1,3,4,2,5],argsArray:[[],[100,0,0,50,20,40],['photo'],[],[]]},ops);
  assert.deepEqual(quads,[[[20,40],[120,40],[120,90],[20,90]],[[0,0],[1,0],[1,1],[0,1]]]);
});
test('Deskew estimate detects a small tilted label and its transform is invertible',()=>{
  const width=320,height=180,data=new Uint8ClampedArray(width*height*4).fill(255),angle=3*Math.PI/180;
  for(let line=0;line<4;line++)for(let x=40;x<270;x++)for(let dy=0;dy<3;dy++){
    const y=Math.round(30+line*32+Math.tan(angle)*(x-width/2))+dy,i=(y*width+x)*4;data[i]=data[i+1]=data[i+2]=0;
  }
  const correction=S.skewAngle(data,width,height);assert.ok(Math.abs(correction+3)<=1,`Expected correction near-3, got${correction}`);
  const matrix=S.skewTransform(correction,width,height),quad=S.rectangleQuad([10,20,30,40],matrix);
  for(let i=0;i<4;i++){const p=quad[i],actual=[p[0]*matrix[0]+p[1]*matrix[2]+matrix[4],p[0]*matrix[1]+p[1]*matrix[3]+matrix[5]];assert.ok(Math.hypot(actual[0]-[10,30,30,10][i],actual[1]-[20,20,40,40][i])<1e-8);}
});
