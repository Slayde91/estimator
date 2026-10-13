const {test}=require("node:test"), assert=require("node:assert/strict"), fs=require("node:fs"), vm=require("node:vm");
const presentation=require("../static/penetration-presentation.js"), graphics=require("../static/takeoff-graphics.js"), shortcuts=require("../static/takeoff-shortcuts.js");
test("loading feedback survives overlap, duplicate releases, and failure cleanup",async()=>{
  const marks=[],attributes={},context={window:{document:{readyState:"complete",documentElement:{classList:{toggle:(...args)=>marks.push(args)},setAttribute:(key,value)=>attributes[key]=value}}}};
  vm.createContext(context);vm.runInContext(fs.readFileSync("static/activity.js","utf8"),context);const api=context.window.CeasefireActivity;
  const older=api.begin(),newer=api.begin();assert.equal(attributes["aria-busy"],"true");older();older();assert.ok(api.active);
  try {const release=api.begin();try {throw Error("aborted request");}finally{release();}}catch{}
  assert.ok(api.active);newer();assert.equal(api.active,false);assert.equal(attributes["aria-busy"],"false");
  api.set("render",true);api.set("render",true);api.set("command",true);api.set("render",false);assert.ok(api.active);api.set("command",false);assert.equal(api.active,false);
});
test("display aliases and grouped fields preserve source values, field objects and unknowns",()=>{
  const source={column:"K",label:"Service Type",options:["Copper Pipes","Steel Pipes","Fixture pipe"]},before=JSON.stringify(source);
  assert.deepEqual(source.options.map(value=>presentation.optionLabel(source,value)),["Unlagged Copper Pipes","Unlagged Steel Pipes","Fixture pipe"]);assert.equal(JSON.stringify(source),before);
  for(const value of ["toString","__proto__","Custom service"])assert.equal(presentation.serviceLabel(value),value);
  const fields=["J","K","L","M","N","P","T","U","X","AA","AE","AF"].map(column=>({column}));const groups=presentation.fieldGroups(fields);
  assert.deepEqual(groups.map(group=>group.map(field=>field.column)),[["J","K"],["L","N"],["P","M"],["T"],["U"],["X","AA"],["AE","AF"]]);assert.ok(groups.flat().every(field=>fields.includes(field)));
});
test("orientation comes only from a known substrate; service dimensions never invent missing values",()=>{
  for(const substrate of ["Plasterboard wall","Concrete/masonry wall","AFS wall"])assert.equal(presentation.orientation(substrate),"Vertical");
  for(const substrate of ["Plasterboard ceiling","Concrete/masonry floor","Bondek floor"])assert.equal(presentation.orientation(substrate),"Horizontal");
  for(const substrate of ["","Unknown wall","Custom ceiling"])assert.equal(presentation.orientation(substrate),null);
  assert.equal(presentation.serviceSize({}),"—");assert.equal(presentation.serviceSize({AL:25.123456789}),"Ø 25.123456789");
  assert.equal(presentation.serviceSize({AQ:300}),"300 × —");assert.equal(presentation.serviceSize({AL:25,AQ:300,AR:50}),"Ø 25; 300 × 50");
});
test("line disabled leaves graphic text and fill available; legacy lines stay enabled",()=>{
  const make=(tag,attrs)=>({tag,attrs,children:[],append(...children){this.children.push(...children);}}), context={measureText:text=>({width:text.length*6})};
  for(const disabled of [false,true]){
    const graphic={kind:"textbox",geometry:{quad_pdf:[[0,0],[180,0],[180,80],[0,80]]},text:"Retained text",appearance:{...graphics.defaults(),fill_enabled:true,...(disabled?{stroke_enabled:false}:{})}};
    const before=JSON.stringify(graphic),painted=graphics.paint(graphic,p=>p,1,make,context),rect=painted.children[0].children[0];
    assert.equal(rect.attrs.stroke,disabled?"none":"#FF0000");assert.equal(rect.attrs.fill,"#FFFFFF");assert.ok(painted.children[0].children.some(node=>node.tag==="text"&&node.textContent==="Retained text"));assert.equal(JSON.stringify(graphic),before);
  }
});
test("Q is the only Call-out shortcut and every legacy tool binding stays inactive",()=>{
  let clicks=0;const control={click(){clicks++;}},event=(key,extra={})=>({key,target:{},preventDefault(){},stopPropagation(){},...extra});
  assert.ok(shortcuts.dispatch(event("q"),{callout:control}));
  for(const key of [";","[","]","\\","F1","F2","F3","F7","F8","F9","F10",",",".","/","'"])assert.equal(shortcuts.dispatch(event(key,{ctrlKey:true}),{callout:control}),false);
  assert.equal(shortcuts.dispatch(event("c",{ctrlKey:true,shiftKey:true}),{callout:control}),false);assert.equal(clicks,1);
});
