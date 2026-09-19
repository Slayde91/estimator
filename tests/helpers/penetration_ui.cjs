const fs = require('node:fs');
const vm = require('node:vm');
const copy = value => JSON.parse(JSON.stringify(value));
function definition() {
  const field = (column,label,type,group,format='number',options=[]) => ({column,label,type,group,format,options,units:'',default:null});
  return {id:'penetration',title:'Firestopping Estimator',source_sha256:'penetration-source',capacity:1000,
    defaults:{globals:{J:'No',K:null,L:0,M:0},rows:[{id:'line-1',inputs:{}}]},schedule_defaults:{globals:{J:'No',K:null,L:0,M:0},rows:[]},groups:['Penetration','Products and labour','Additional Allowances','Substrate'],
    // Legacy metadata may still describe globals; current views must not render them.
    global_fields:[field('J','LAFHA','select','Global settings','text',['No','Yes']),field('L','Global Labour','number','Global settings','percent')],
    row_fields:[field('T','Item(s)','text','Penetration','text'),field('U','System','text','Penetration','text'),field('O','Item QTY','number','Penetration'),field('J','Type','select','Penetration','text',['HVAC','Electrical']),field('W','Workers','select','Products and labour','text',['Installer']),field('AG','Material Wastage %','number','Additional Allowances','percent'),field('AW','Length','number','Substrate')],
    output_fields:[field('H','Item total','number','Summary','currency'),field('BQ','Wrap SQM Required','number','Material quantities'),field('DI','Labour days','number','Labour')]};
}
function result(draft,metadata=definition()) {
  return {source_sha256:metadata.source_sha256,draft:copy(draft),definition:copy(metadata),summary:{grand_total:123.456789,materials:65.4321,labour:58.024689,total_days:0.123456},errors:[],
    rows:draft.rows.map(row=>({id:row.id,inputs:copy(row.inputs),outputs:{H:123.456789,BQ:0,DI:'#VALUE!'},errors:[],breakdown:{rows:[{label:'Wrap',unit_prices:[],material_quantities:[{label:'Pipes',value:0,units:'m²'}],material_costs:null,labour_costs:null,task_hours:'#VALUE!'}],totals:{material_costs:65.4321,labour_costs:58.024689,task_hours:'#VALUE!'}}}))};
}
function allowanceDefinition() {
  const metadata=definition();metadata.groups.push('Pipes');
  for(const [column,label,group] of [['register_allowance_hours','Register Allowance','Products and labour'],['pipe_labour_hours','Pipe Labour','Pipes']]) metadata.row_fields.push({column,label,group,type:'number',format:'number',units:'hrs',options:[],default:null,automatic_default:true,source:'application',address:null,min:0});
  metadata.row_fields.push({column:'AL',label:'Diameter',group:'Pipes',type:'number',format:'number',units:'mm',options:[],default:null});
  return metadata;
}
function allowanceResult(draft,metadata=allowanceDefinition(),defaults={register_allowance_hours:.25,pipe_labour_hours:.3}) {
  const response=result(draft,metadata);for(const row of response.rows)row.input_defaults=copy(defaults);return response;
}
function install(context) {
  vm.runInContext(fs.readFileSync('static/penetration-breakdown.js','utf8'),context);
  const source=fs.readFileSync('static/penetration.js','utf8').replace(/\}\)\(\);\s*$/,`globalThis.penAudit={state,calculate,calculateSchedule,addToLibrary,addToSchedule,updateSchedule,cancelEdit,addRow,removeRow,undoRemove,selectRow,makeControl,renderFields,renderSchedule,renderBreakdown,render,download,changed,definitionFor,setRequest(fn){request=fn;}};})();`);
  vm.runInContext(source,context);
  const audit=context.penAudit,calls=[];
  audit.setRequest(async(path,payload)=>{calls.push({path,payload:copy(payload)});return path.endsWith('/definition')?definition():result(payload.draft);});
  return {audit,api:context.window.CeasefirePenetrations,calls};
}
function harness() {
  const elements=new Map(),timers=new Map();let timerId=0;
  const matches=(node,selector)=>selector==='[data-penetration-field]'?node.dataset.penetrationField!==undefined:selector==='[data-library-editor-field]'?node.dataset.libraryEditorField!==undefined:selector==='[data-penetration-remove]'?node.dataset.penetrationRemove!==undefined:false;
  const document={activeElement:null};
  function element(tagName='div') {
    const attrs=new Map();
    return {tagName,dataset:{},children:[],listeners:{},style:{},value:'',textContent:'',hidden:false,
      setAttribute(key,value){attrs.set(key,String(value));},getAttribute(key){return attrs.get(key);},
      append(...nodes){for(const child of nodes){child.parentNode=this;this.children.push(child);}},replaceChildren(...nodes){this.children=[];this.append(...nodes);},
      querySelectorAll(selector){return this.children.flatMap(child=>[...(matches(child,selector)?[child]:[]),...child.querySelectorAll(selector)]);},
      addEventListener(name,fn){(this.listeners[name]||=[]).push(fn);},async emit(name){for(const fn of this.listeners[name]||[])await fn({target:this});},
      focus(){document.activeElement=this;return this.emit('focus');},blur(){document.activeElement=null;return this.emit('blur');},select(){this.selectionStart=0;this.selectionEnd=this.value.length;},
    };
  }
  const byId=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
  Object.assign(document,{getElementById:byId,createElement:element});
  const pricing={inventory:{},rates:{original:{price:1}}},details={client:'Original client'},target={project_token:'original-token'};
  const context={document,window:{CeasefireProject:{configuration:()=>copy(pricing),details:()=>copy(details),downloadTarget:()=>copy(target),changed(){}},CeasefirePenetrationNavigation:{confirm:async()=>true,show(){},showSchedule(){}}},Intl,Number,String,JSON,Object,Set,Map,Array,Promise,Error,console,
    setTimeout(fn){timers.set(++timerId,fn);return timerId;},clearTimeout(id){timers.delete(id);}};
  vm.createContext(context);vm.runInContext(fs.readFileSync('static/downloads.js','utf8'),context);
  const pen=install(context);
  const control=(column,row='line-1')=>byId('penetration-row-fields').querySelectorAll('[data-penetration-field]').find(el=>el.dataset.penetrationField===column&&el.dataset.penetrationRow===(row||''));
  return {context,byId,element,control,pricing,details,target,timers,...pen};
}
module.exports={copy,definition,result,allowanceDefinition,allowanceResult,install,harness};
