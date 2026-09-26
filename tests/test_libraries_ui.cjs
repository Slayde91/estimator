// Synthetic reference data only. No source workbook or report contents belong in this suite.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const copy=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const walk=node=>[node,...node.children.flatMap(walk)];
const text=node=>walk(node).map(el=>el.textContent).join(' ');
const meta=()=>({notice:'Synthetic local reference library.',libraries:['penetration','technical'].map(id=>({id,title:id,available:true,count:2}))});
const filters=[{key:'category',label:'Category',options:[{value:'sample & test',label:'Sample & test'}]}];
const records=kind=>({items:[{id:kind+'-1',title:'Synthetic '+kind+' record',subtitle:'Source row 10',summary:'Synthetic summary',source_label:'Synthetic source',related_count:1}],offset:0,limit:50,total:1,filters});
const detail=(kind,id)=>({id,title:'Synthetic '+id,subtitle:'Literal reference',notice:'Record-specific source qualification.',fields:[{label:'Recorded condition',value:'<img src=x onerror=alert(1)>\nLiteral second line'},{label:'Blank',value:null},{label:'Zero',value:0}],
  sources:[{label:'Synthetic source reference',filename:'synthetic.pdf',document_id:'synthetic-document',page:12,sheet:'Synthetic sheet',row:10,sha256:'synthetic-hash'}],
  links:[{kind:kind==='penetration'?'technical':'penetration',id:kind==='penetration'?'technical-1':'penetration-1',title:'Related synthetic record',relationship:'Recorded reference only'}],images:[{id:'synthetic_image-1',caption:'Synthetic diagram'}]});
function harness(){
  const elements=new Map(),timers=new Map(),calls=[];let timerId=0;
  function element(tagName='div'){
    const attributes=new Map();
    return{tagName,children:[],dataset:{},style:{},listeners:{},textContent:'',value:'',hidden:false,disabled:false,
      append(...children){this.children.push(...children);},replaceChildren(...children){this.children=[];this.append(...children);},
      addEventListener(name,fn){(this.listeners[name]||=[]).push(fn);},async emit(name,options={}){const event={target:this,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...options};for(const fn of this.listeners[name]||[])await fn(event);return event;},
      setAttribute(name,value){attributes.set(name,String(value));},getAttribute(name){return attributes.get(name);},focus(options){this.focused=true;this.focusOptions=options;context.document.activeElement=this;},scrollIntoView(options){this.scrolled=true;this.scrollOptions=options;},getBoundingClientRect(){return this.rect||{bottom:96};}};
  }
  const byId=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
  let route=path=>{if(path==='/api/libraries')return meta();const [, , ,kind,id]=path.split('/');return id?detail(kind,decodeURIComponent(id)):records(kind.split('?')[0]);};
  const context={document:{getElementById:byId,createElement:element,querySelector:selector=>selector==='.app-header'?byId('synthetic-header'):null},window:{},URLSearchParams,AbortController,Map,Set,JSON,Number,String,Object,Array,Promise,Error,console,
    setTimeout(fn){timers.set(++timerId,fn);return timerId;},clearTimeout(id){timers.delete(id);},fetch:async(path,options)=>{calls.push({path,options});const data=await route(path,options);return{ok:!data?.error,status:data?.error?400:200,json:async()=>data};}};
  vm.createContext(context);vm.runInContext(fs.readFileSync('static/library-detail-text.js','utf8'),context);
  vm.runInContext(fs.readFileSync('static/libraries.js','utf8').replace(/\}\)\(\);\s*$/,`globalThis.audit={state,paneFor,loadList,loadDetail,navigate,back,refresh,showList,renderDetail};})();`),context);
  const api=context.window.CeasefireLibraries;
  context.window.CeasefireLibraryNavigation={open:(kind,selection)=>api.open(kind,selection)};
  const pane=kind=>context.audit.paneFor(kind);
  const runTimers=async()=>{const pending=[...timers.values()];timers.clear();for(const fn of pending)await fn();await flush();};
  return{context,api,pane,calls,byId,runTimers,setRoute(fn){route=fn;}};
}
let passed=0;
async function check(name,fn){await fn(harness());passed++;console.log('ok - '+name);}
(async()=>{
  await check('Opening is lazy and a revisited list retains its controls, query and fetched data',async h=>{
    assert.equal(h.calls.length,0);await h.api.open('penetration');const pane=h.pane('penetration'),search=pane.searchInput;
    assert.deepEqual(h.calls.map(call=>call.path),['/api/libraries','/api/libraries/penetration?offset=0&limit=50']);assert.equal(pane.results.children.length,1);assert.equal(search.maxLength,400);
    assert.equal(pane.refresh.children[0].textContent,'↻');assert.equal(pane.refresh.getAttribute('aria-label'),'Refresh');assert.equal(pane.refresh.title,'Refresh');assert.match(pane.refresh.className,/refresh-button/);
    await h.api.open('technical');await h.api.open('penetration');assert.equal(pane.searchInput,search);assert.equal(h.calls.length,3);assert.equal(pane.results.getAttribute('aria-busy'),'false');
  });
  await check('Search and filters use encoded server queries; page controls retain all active filters',async h=>{
    h.setRoute(path=>path==='/api/libraries'?meta():({...records('penetration'),total:105,offset:Number(new URL('http://local'+path).searchParams.get('offset')),items:Array.from({length:50},(_,i)=>({id:'record-'+i,title:'Synthetic item '+i}))}));
    await h.api.open('penetration');const pane=h.pane('penetration');pane.searchInput.value='  cable & wall / test  ';await pane.searchInput.emit('input');await h.runTimers();
    assert.match(h.calls.at(-1).path,/search=cable\+%26\+wall\+%2F\+test/);
    const control=walk(pane.filterControls).find(node=>node.tagName==='select');control.value='sample & test';await control.emit('change');await flush();assert.match(h.calls.at(-1).path,/category=sample\+%26\+test/);
    await pane.next.emit('click');await flush();assert.match(h.calls.at(-1).path,/offset=50/);assert.match(h.calls.at(-1).path,/category=/);assert.equal(pane.previous.disabled,false);
    await pane.previous.emit('click');await flush();assert.match(h.calls.at(-1).path,/offset=0/);assert.equal(pane.previous.disabled,true);
  });
  await check('A late search response cannot replace the newer search result',async h=>{
    await h.api.open('penetration');const pane=h.pane('penetration'),old=deferred();
    h.setRoute(path=>path.includes('search=old')?old.promise:{...records('penetration'),items:[{id:'new',title:'Newest result'}]});
    pane.searchInput.value='old';await pane.searchInput.emit('input');const first=h.runTimers();await flush();
    pane.searchInput.value='new';await pane.searchInput.emit('input');await h.runTimers();old.resolve({...records('penetration'),items:[{id:'old',title:'Stale result'}]});await first;
    assert.match(text(pane.results),/Newest result/);assert.doesNotMatch(text(pane.results),/Stale result/);
  });
  await check('Substrate filter replaces Table and carries its selection through search and paging',async h=>{
    const options=['Plasterboard wall','Concrete/masonry wall','CLT floor'].map(value=>({value,label:value}));
    h.setRoute(path=>path==='/api/libraries'?meta():({...records('technical'),total:105,offset:Number(new URL('http://local'+path).searchParams.get('offset')),filters:[{key:'substrate',label:'Substrate',options}]}));
    await h.api.open('technical');const pane=h.pane('technical');
    assert.match(text(pane.filterControls),/Substrate/);assert.doesNotMatch(text(pane.filterControls),/\bTable\b/);
    const control=walk(pane.filterControls).find(node=>node.dataset.libraryFilter==='substrate');
    control.value='Concrete/masonry wall';await control.emit('change');await flush();
    assert.equal(new URL('http://local'+h.calls.at(-1).path).searchParams.get('substrate'),'Concrete/masonry wall');
    pane.searchInput.value='synthetic';await pane.searchInput.emit('input');await h.runTimers();
    await pane.next.emit('click');await flush();
    const query=new URL('http://local'+h.calls.at(-1).path).searchParams;
    assert.equal(query.get('substrate'),'Concrete/masonry wall');assert.equal(query.get('search'),'synthetic');assert.equal(query.get('offset'),'50');
  });
  await check('Full detail retains plain source information and accessible diagram links',async h=>{
    await h.api.open('technical','technical-1');const pane=h.pane('technical'),nodes=walk(pane.detailPanel);
    assert.match(text(pane.detailPanel),/<img src=x onerror=alert\(1\)>/);assert.match(text(pane.detailPanel),/Literal second line/);assert.doesNotMatch(text(pane.detailPanel),/Not recorded/);assert.match(text(pane.detailPanel),/Zero 0/);
    assert.equal(nodes.filter(node=>node.tagName==='a'&&node.href.includes('documents/')).length,0);
    const sourceCard=nodes.find(node=>node.className==='library-source');assert.equal(sourceCard.children.length,1);assert.equal(sourceCard.children[0].textContent,'Synthetic source reference');assert.equal(sourceCard.children[0].tagName,'span');assert.equal(walk(sourceCard).filter(node=>['a','dl','dt','dd','button'].includes(node.tagName)).length,0);assert.doesNotMatch(text(sourceCard),/Open PDF|synthetic\.pdf|Synthetic sheet/);
    const image=nodes.find(node=>node.tagName==='img');assert.equal(image.loading,'lazy');assert.equal(image.src,'/api/libraries/images/synthetic_image-1');assert.equal(image.alt,'Synthetic diagram');
    const children=pane.detailPanel.children,fields=children.find(node=>node.tagName==='dl'),gallery=children.find(node=>node.getAttribute('aria-label')==='Source diagrams');
    const sections=children.filter(node=>node.className==='library-detail-section');
    assert.ok(children.indexOf(fields)<children.indexOf(gallery));assert.ok(children.indexOf(gallery)<children.indexOf(sections[0]));
    assert.match(text(sections[0]),/Related firestopping records/);assert.match(text(sections[1]),/Source information/);
    assert.ok(nodes.every(node=>node.innerHTML===undefined));assert.doesNotMatch(text(pane.detailPanel),/Source fingerprint|synthetic-hash/);assert.match(text(pane.detailPanel),/Related firestopping records/);
    const heading=nodes.find(node=>node.tagName==='h3');assert.equal(heading.focusOptions.preventScroll,true);assert.equal(pane.detailPanel.scrolled,true);assert.equal(heading.scrolled,undefined,'Keep Back navigation above the heading inside the scrolled view.');
    assert.equal(pane.detailPanel.children.filter(node=>node.textContent==='Record-specific source qualification.').length,1);assert.doesNotMatch(pane.notice.textContent,/Record-specific/);assert.match(pane.notice.textContent,/Synthetic local reference library/);
  });
  await check('Firestopping labels and diagrams omit workbook locations while retaining technical captions and source data',async h=>{
    const source={...detail('penetration','source'),fields:[{label:'Item(s)',value:'Two insulated pipes'},{label:'System',value:'Install both face seals'},{label:'Service Size or Diameter',value:'Not stated'}],images:[
      {id:'diagram-1',caption:'Source diagram · CALC!S6'},
      {id:'diagram-2',caption:'Pair coil seal — CALC!$S$53'},
      {id:'diagram-3',caption:'Alternative view · CALC row 53'},
      {id:'diagram-4',caption:'Rated assembly H2 — 120 minutes'}
    ]},before=copy(source);
    h.setRoute(path=>path==='/api/libraries'?meta():path.includes('?')?({...records('penetration'),items:[{id:'source',title:'FL-ID-001',source_label:'CALC row 53'}]}):source);
    await h.api.open('penetration');assert.doesNotMatch(text(h.pane('penetration').results),/CALC row 53/);
    await h.api.open('penetration','source');const panel=h.pane('penetration').detailPanel,nodes=walk(panel);
    assert.ok(panel.children.findIndex(node=>node.tagName==='dl')<panel.children.findIndex(node=>node.className==='library-detail-section'));
    assert.deepEqual(nodes.filter(node=>node.tagName==='dt').map(node=>node.textContent),['Description','System/Install Details','Service Size or Diameter']);
    assert.match(text(panel),/Two insulated pipes.*Install both face seals.*Not stated/);assert.doesNotMatch(text(panel),/CALC|Item\(s\)/);
    const captions=['Source diagram','Pair coil seal','Alternative view','Rated assembly H2 — 120 minutes'];assert.deepEqual(nodes.filter(node=>node.tagName==='figcaption').map(node=>node.textContent),captions);assert.deepEqual(nodes.filter(node=>node.tagName==='img').map(node=>node.alt),captions);
    assert.ok(nodes.filter(node=>node.tagName==='a'&&node.href.includes('/images/')).every((link,index)=>link.getAttribute('aria-label')===`Open ${captions[index]} at full size (new tab)`));
    await h.api.open('technical','source');assert.deepEqual(walk(h.pane('technical').detailPanel).filter(node=>node.tagName==='figcaption').map(node=>node.textContent),source.images.map(image=>image.caption));assert.deepEqual(source,before);
  });
  await check('A saved Firestopping source diagram replaces the immutable gallery in the library detail',async h=>{
    const source={...detail('penetration','penetration-1'),diagram:{available:true,custom:true,url:'/api/libraries/penetration/penetration-1/image'},images:[{id:'original-source',caption:'Original source diagram'}]};
    h.setRoute(path=>path==='/api/libraries'?meta():source);await h.api.open('penetration','penetration-1');
    const nodes=walk(h.pane('penetration').detailPanel),images=nodes.filter(node=>node.tagName==='img'),links=nodes.filter(node=>node.tagName==='a'&&node.href?.includes('/image'));
    assert.equal(images.length,1);assert.equal(images[0].src,'/api/libraries/penetration/penetration-1/image');assert.equal(images[0].alt,'Source diagram');
    assert.equal(links.length,1);assert.equal(links[0].target,'_blank');assert.equal(links[0].rel,'noopener noreferrer');assert.doesNotMatch(images[0].src,/original-source/);
  });
  await check('Untrusted asset IDs never become fetchable links; unavailable relationship text remains visible',async h=>{
    h.setRoute(path=>path==='/api/libraries'?meta():({...detail('technical','technical-1'),diagram:{custom:true,url:'https://remote/image'},sources:[{filename:'Unavailable report',document_id:'../../private',page:-1}],images:[{id:'https://remote/image'},{id:'../private'}],links:[{title:'Unresolved original reference',relationship:'Ambiguous source association'}]}));
    await h.api.open('technical','technical-1');const nodes=walk(h.pane('technical').detailPanel);assert.equal(nodes.filter(node=>node.tagName==='img'||node.tagName==='a').length,0);assert.match(text(h.pane('technical').detailPanel),/Unresolved original reference.*Ambiguous source association/);
  });
  await check('Structured source fields keep exact text and validated diagrams inside their field',async h=>{
    h.setRoute(path=>path==='/api/libraries'?meta():({...detail('technical','technical-1'),images:[],fields:[
      {label:'Installation concept',value:'Exact source cell text',images:[{id:'source_cell-12',caption:'Source installation diagram'},{id:'../unregistered',caption:'Invalid'}]},
      {label:'Image-only source cell',value:'',images:[{id:'source_cell-13',caption:'Image-only diagram'}]},
    ]}));
    await h.api.open('technical','technical-1');const nodes=walk(h.pane('technical').detailPanel),fields=nodes.filter(node=>node.className==='library-record-field');
    assert.equal(fields.length,2);assert.match(text(fields[0]),/Installation concept Exact source cell text/);
    const images=nodes.filter(node=>node.tagName==='img');assert.equal(images.length,2);assert.equal(images[0].src,'/api/libraries/images/source_cell-12');assert.equal(images[0].loading,'lazy');assert.equal(images[0].alt,'Source installation diagram');
    assert.ok(walk(fields[0].children[1]).includes(images[0]));assert.ok(walk(fields[1].children[1]).includes(images[1]));assert.doesNotMatch(text(fields[1]),/Not recorded/);
    const full=walk(fields[0]).find(node=>node.tagName==='a');assert.equal(full.target,'_blank');assert.equal(full.rel,'noopener noreferrer');
  });
  await check('Library prices and edit controls use server metadata while reference notices remain beside their links',async h=>{
    const opened=[];h.context.window.CeasefireLibraryEditor={open:async id=>opened.push(id)};
    h.setRoute(path=>path==='/api/libraries'?meta():path.includes('?')?({...records('penetration'),items:[{id:'legacy-row-4',title:'FL-ID-001',price:{amount:123.456789,label:'Workbook price'},editable:true}]}):({...detail('technical','technical-1'),links:[{kind:'penetration',id:'legacy-row-4',title:'FL-ID-001',relationship:'Original source entry',notice:'This item has saved edits; the technical reference describes its original workbook entry.'}]}));
    await h.api.open('penetration');const pane=h.pane('penetration');assert.match(text(pane.results),/FL-ID-001.*Library price: \$123\.46/);assert.doesNotMatch(text(pane.results),/Workbook price/);const edit=walk(pane.results).find(node=>node.dataset.libraryEdit);assert.equal(edit.textContent,'Edit');await edit.emit('click');assert.deepEqual(opened,['legacy-row-4']);
    await h.api.open('technical','technical-1');const related=walk(h.pane('technical').detailPanel).find(node=>node.className==='library-related-record');assert.match(text(related),/FL-ID-001.*Original source entry.*saved edits/);assert.equal(walk(h.pane('technical').detailPanel).filter(node=>node.dataset.libraryEdit).length,0);
  });
  await check('Presentation cleanup hides requested metadata without changing source evidence or main-table conditions',async h=>{
    const source={...detail('technical','source'),price:{amount:25.123456,label:'Workbook price'},fields:[
      {label:'Diagram captions (visually checked)',value:'Internal caption review'},
      {label:' workbook report revision ',value:'Internal workbook revision'},
      {label:'REFERENCE REVIEW',value:'Internal link review'},
      {label:'Source table notes',value:'Underlying shared table condition'},
      {label:'Source option alignment',value:'Internal option mapping'},
      {label:'Service',value:'Ordinary main-table condition',table:{columns:['Service','FRL'],rows:[['A','-/60/60'],['B','-/120/120']]}}
    ]},before=copy(source);
    h.setRoute(path=>path==='/api/libraries'?meta():source);
    for(const kind of ['penetration','technical']){
      await h.api.open(kind,'source');const pane=h.pane(kind),nodes=walk(pane.detailPanel),content=text(pane.detailPanel);
      assert.doesNotMatch(content,/Internal caption review|Internal workbook revision|Internal link review|Source fingerprint|synthetic-hash|Workbook price/);assert.match(content,/Library price: \$25\.12/);assert.match(content,/Ordinary main-table condition/);
      assert.deepEqual(copy(nodes.find(node=>node.tagName==='tbody').children.map(row=>row.children.map(cell=>cell.textContent))),[['A','-/60/60'],['B','-/120/120']]);
      if(kind==='technical'){assert.doesNotMatch(content,/Source table notes|Underlying shared table condition|Source option alignment|Internal option mapping/);assert.match(content,/Source information/);assert.match(content,/Synthetic source reference/);assert.equal(nodes.filter(node=>node.tagName==='a'&&node.href.includes('documents/')).length,0);}
      else{assert.doesNotMatch(content,/Source information|Synthetic source reference|synthetic.pdf/);assert.equal(nodes.filter(node=>node.tagName==='a'&&node.href.includes('documents/')).length,0);assert.match(content,/Underlying shared table condition/);}
      assert.deepEqual(source,before);assert.equal(pane.detail.sources[0].sha256,'synthetic-hash');
    }
  });
  await check('Source subtables preserve service wrap and FRL row pairing as literal accessible cells',async h=>{
    const paired=[['Service A','100 mm','-/60/60'],['Service B <script>','200 mm','-/120/120']];
    h.setRoute(path=>path==='/api/libraries'?meta():({...detail('technical','technical-1'),images:[],fields:[{label:'Service options',value:'Common source condition',table:{columns:['Service','Wrap length','FRL'],rows:paired}},{label:'Sizes only',value:'',table:{columns:['Size'],rows:[['0']]}}]}));
    await h.api.open('technical','technical-1');const nodes=walk(h.pane('technical').detailPanel),tables=nodes.filter(node=>node.tagName==='table');assert.equal(tables.length,2);
    const headings=walk(tables[0]).filter(node=>node.tagName==='th');assert.deepEqual(headings.map(node=>node.textContent),['Service','Wrap length','FRL']);assert.ok(headings.every(node=>node.getAttribute('scope')==='col'));
    const body=tables[0].children.find(node=>node.tagName==='tbody');assert.deepEqual(copy(body.children.map(row=>row.children.map(cell=>cell.textContent))),paired);
    assert.equal(nodes.filter(node=>node.textContent==='Common source condition').length,1);assert.equal(nodes.filter(node=>node.textContent==='Service B <script>').length,1);assert.ok(nodes.every(node=>node.innerHTML===undefined));
    const scroll=nodes.filter(node=>node.className==='library-field-table-scroll');assert.equal(scroll[0].tabIndex,0);assert.equal(scroll[0].getAttribute('role'),'region');assert.equal(scroll[0].getAttribute('aria-label'),'Service options table');assert.doesNotMatch(text(scroll[1]),/Not recorded/);
  });
  await check('Configuration links preserve target indices with concise table names and retained source metadata',async h=>{
    const source={...detail('technical','a/#<script>'),images:[],fields:[
      {label:'FRL',value:'See the rating for the matching configuration.',table_links:[{field:'Service Size / Configuration',table_index:1},{field:'Service Size / Configuration',table_index:0}]},
      {label:'Service Size / Configuration',value:'',table:{columns:['Service','FRL'],rows:[['Service A','-/60/60']]},tables:[{columns:['Service','FRL'],rows:[['Service B','-/120/120']]}],table_captions:['Source A — page 1','Source B <img src=x onerror=alert(1)> — page 2']},
      {label:'Service Wrap',value:'',table_links:[{field:'Service Size / Configuration',table_index:1}]}
    ]},before=copy(source);
    h.setRoute(path=>path==='/api/libraries'?meta():source);await h.api.open('technical',source.id);
    const nodes=walk(h.pane('technical').detailPanel),tables=nodes.filter(n=>n.className==='library-field-table-scroll'),links=nodes.filter(n=>n.className==='library-configuration-link');
    assert.equal(tables.length,2);assert.equal(links.length,3);assert.deepEqual(links.map(n=>n.textContent),['View configuration table 2','View configuration table 1','View configuration table 2']);
    assert.deepEqual(links.map(n=>n.href),['#'+tables[1].id,'#'+tables[0].id,'#'+tables[1].id]);
    assert.equal(tables[0].getAttribute('aria-label'),'Service Size / Configuration table 1');assert.equal(tables[1].getAttribute('aria-label'),'Service Size / Configuration table 2');
    assert.ok(tables.every(n=>/^library-table-technical-[a-z0-9-]+$/.test(n.id)));assert.notEqual(tables[0].id,tables[1].id);
    assert.equal(nodes.filter(n=>n.tagName==='caption').length,0);assert.doesNotMatch(text(h.pane('technical').detailPanel),/Source A|Source B/);assert.ok(nodes.every(n=>n.innerHTML===undefined));
    const wrap=nodes.find(n=>n.className==='library-record-field'&&n.children[0].textContent==='Service Wrap');assert.doesNotMatch(text(wrap),/Not recorded|Service B|120/);
    assert.match(text(h.pane('technical').detailPanel),/See the rating for the matching configuration/);assert.deepEqual(source,before);
  });
  await check('Firefly blank-seal summaries link to one complete barrier variation table without generated labels',async h=>{
    const rows=[['600 × 600 mm','Minimum 100 mm concrete or masonry wall.','-/60/60'],['800 × 600 mm','Two layers of 13 mm fire-rated plasterboard to each wall face.','-/90/90'],['1000 × 600 mm','Minimum 130 mm CLT wall.','-/120/120']];
    const source={...detail('technical','fas190234-system-synthetic-blank'),images:[],fields:[
      {label:'Barrier Construction',value:'',table:{columns:['Max Aperture Size','Separating Element','FRL'],rows},table_row_ids:[['private-option-1','private-option-2','private-option-3']],table_captions:['Source option metadata retained for audit.']},
      {label:'Blank Seal FRL',value:'-/60/60 to -/120/120',table_links:[{field:'Barrier Construction',table_index:0}]},
      {label:'Maximum Opening Size',value:'1000 × 600 mm',table_links:[{field:'Barrier Construction',table_index:0}]}
    ]},before=copy(source);
    h.setRoute(path=>path==='/api/libraries'?meta():source);await h.api.open('technical',source.id);
    const panel=h.pane('technical').detailPanel,nodes=walk(panel),tables=nodes.filter(n=>n.className==='library-field-table-scroll');
    assert.equal(tables.length,1);assert.equal(tables[0].getAttribute('aria-label'),'Barrier Construction table');
    assert.deepEqual(nodes.filter(n=>n.tagName==='th').map(n=>n.textContent),['Max Aperture Size','Separating Element','FRL']);
    assert.deepEqual(nodes.filter(n=>n.tagName==='td').map(n=>n.textContent),rows.flat());
    for(const [label,summary] of [['Blank Seal FRL','-/60/60 to -/120/120'],['Maximum Opening Size','1000 × 600 mm']]) {
      const pair=nodes.find(n=>n.className==='library-record-field'&&n.children[0].textContent===label),value=pair.children[1],links=walk(value).filter(n=>n.className==='library-configuration-link');
      assert.equal(value.textContent,summary);assert.equal(links.length,1);assert.equal(links[0].textContent,'View barrier construction table');assert.equal(links[0].href,'#'+tables[0].id);
      await links[0].emit('click',{detail:0});assert.equal(h.context.document.activeElement,tables[0]);
    }
    assert.doesNotMatch(text(panel),/Source option|Source Configuration|private-option|retained for audit/);
    assert.ok(nodes.every(n=>n.innerHTML===undefined));assert.deepEqual(source,before);
  });
  await check('Configuration links use native keyboard activation, focus the table and clear the sticky header',async h=>{
    h.setRoute(path=>path==='/api/libraries'?meta():({...detail('technical','focus'),images:[],fields:[
      {label:'Service Wrap',value:'',table_links:[{field:'Service Size / Configuration',table_index:0}]},
      {label:'Service Size / Configuration',value:'',tables:[{columns:['Service'],rows:[['A']]}]}
    ]}));
    await h.api.open('technical','focus');const nodes=walk(h.pane('technical').detailPanel),link=nodes.find(n=>n.className==='library-configuration-link'),target=nodes.find(n=>n.className==='library-field-table-scroll');
    assert.equal(link.tagName,'a');assert.equal(link.textContent,'View configuration table');assert.equal(link.href,'#'+target.id);assert.equal(link.target,undefined);
    assert.equal(link.listeners.keydown,undefined,'Native anchor Enter activation should generate click, without duplicate custom keyboard handling.');
    h.byId('synthetic-header').rect={bottom:176};link.focus();const calls=h.calls.length,event=await link.emit('click',{detail:0});
    assert.equal(event.defaultPrevented,true);assert.equal(h.context.document.activeElement,target);assert.equal(target.tabIndex,0);assert.equal(target.getAttribute('role'),'region');
    assert.equal(target.focusOptions.preventScroll,true);assert.equal(target.style.scrollMarginTop,'192px');assert.deepEqual(copy(target.scrollOptions),{block:'start',inline:'nearest'});assert.equal(h.calls.length,calls);
    h.byId('synthetic-header').rect={bottom:302};await link.emit('click');assert.equal(target.style.scrollMarginTop,'318px','Recompute clearance after a narrow-screen header reflows.');
  });
  await check('Technical tables omit source preambles without losing construction conditions, printed rows or source metadata',async h=>{
    const field={label:'Barrier Construction',value:'Fixing alternatives do not establish approved wall or floor types.',tables:[
      {columns:['#','Substrate','Fixing'],rows:[['1','Concrete','M6 at 200 mm centres']]},
      {columns:['Substrate','FRL'],rows:[['Masonry','-/120/120']]}
    ],table_captions:['Complete source fixing alternatives by substrate. Source: D-synthetic.pdf, page 1. Substrate fixing alternatives.','Source: D-synthetic.pdf, page 2. Approved substrates.']};
    const source={...detail('technical','caption-review'),fields:[field],images:[]},before=copy(source);
    h.setRoute(path=>path==='/api/libraries'?meta():source);await h.api.open('technical',source.id);
    let nodes=walk(h.pane('technical').detailPanel);
    assert.equal(nodes.filter(n=>n.tagName==='caption').length,0);assert.doesNotMatch(text(h.pane('technical').detailPanel),/Complete source|D-synthetic|Approved substrates/);
    assert.match(text(h.pane('technical').detailPanel),/Fixing alternatives do not establish approved wall or floor types/);
    assert.deepEqual(nodes.filter(n=>n.tagName==='th').map(n=>n.textContent),['#','Substrate','Fixing','Substrate','FRL']);
    assert.deepEqual(nodes.filter(n=>n.tagName==='td').map(n=>n.textContent),['1','Concrete','M6 at 200 mm centres','Masonry','-/120/120']);
    for(const tag of ['table','div']){const named=nodes.filter(n=>n.tagName===tag&&(tag==='table'||n.getAttribute('role')==='region'));assert.deepEqual(named.map(n=>n.getAttribute('aria-label')),['Barrier Construction table 1','Barrier Construction table 2']);}
    assert.deepEqual(source,before,'Hiding presentation text must not modify the original source metadata.');
    await h.api.open('penetration',source.id);nodes=walk(h.pane('penetration').detailPanel);
    assert.deepEqual(nodes.filter(n=>n.tagName==='caption').map(n=>n.textContent),field.table_captions,'Firestopping table caption behavior is unchanged.');assert.deepEqual(source,before);
  });
  await check('Malformed, unavailable, duplicate and out-of-range configuration references are ignored',async h=>{
    const configuration={label:'Service Size / Configuration',value:'',tables:[{columns:['A'],rows:[['first']]},null,{columns:['B'],rows:[['third']]}],table_captions:['First','Invalid','Third'],table_links:[{field:'Service Size / Configuration',table_index:0}]};
    const refs=[null,{}, {field:'javascript:alert(1)',table_index:0},{field:'Service Wrap',table_index:0},{field:'Service Size / Configuration',table_index:0,url:'javascript:alert(1)'},...[-1,1,3,0.5,'0',null].map(table_index=>({field:'Service Size / Configuration',table_index})),{field:'Service Size / Configuration',table_index:2},{field:'Service Size / Configuration',table_index:2}];
    let source={...detail('technical','invalid'),images:[],fields:[configuration,{label:'FRL',value:'Summary',table_links:refs},{label:'Absent links',value:'',table_links:[{field:'Service Size / Configuration',table_index:999}]}]};
    h.setRoute(path=>path==='/api/libraries'?meta():source);await h.api.open('technical','invalid');let nodes=walk(h.pane('technical').detailPanel),links=nodes.filter(n=>n.className==='library-configuration-link'),tables=nodes.filter(n=>n.className==='library-field-table-scroll');
    assert.equal(links.length,1);assert.equal(links[0].textContent,'View configuration table 3');assert.equal(links[0].href,'#'+tables[1].id);assert.deepEqual(tables.map(n=>n.getAttribute('aria-label')),['Service Size / Configuration table 1','Service Size / Configuration table 3']);assert.equal(nodes.filter(n=>n.tagName==='caption').length,0);assert.doesNotMatch(text(h.pane('technical').detailPanel),/Absent links/);
    source={...source,fields:[source.fields[1]]};h.pane('technical').detail=source;h.context.audit.renderDetail(h.pane('technical'));assert.equal(walk(h.pane('technical').detailPanel).filter(n=>n.className==='library-configuration-link').length,0);
    source={...source,fields:[configuration,copy(configuration),source.fields[0]]};h.pane('technical').detail=source;h.context.audit.renderDetail(h.pane('technical'));assert.equal(walk(h.pane('technical').detailPanel).filter(n=>n.className==='library-configuration-link').length,0,'Duplicate target labels are ambiguous.');
  });
  await check('Configuration anchors remain stable on rerender and cannot target another record',async h=>{
    const fields=[{label:'Service Size / Configuration',value:'',table:{columns:['A'],rows:[['value']]}},{label:'Service Wrap',value:'',table_links:[{field:'Service Size / Configuration',table_index:0}]}];
    h.setRoute(path=>path==='/api/libraries'?meta():({...detail('technical',decodeURIComponent(path.split('/').at(-1))),fields,images:[]}));
    await h.api.open('technical','first');const pane=h.pane('technical'),old=walk(pane.detailPanel).find(n=>n.className==='library-field-table-scroll');h.context.audit.renderDetail(pane);
    let nodes=walk(pane.detailPanel),next=nodes.find(n=>n.className==='library-field-table-scroll');assert.notEqual(next,old);assert.equal(next.id,old.id);await nodes.find(n=>n.className==='library-configuration-link').emit('click');assert.equal(h.context.document.activeElement,next);assert.equal(old.scrolled,undefined);
    await h.api.open('technical','second');nodes=walk(pane.detailPanel);const second=nodes.find(n=>n.className==='library-field-table-scroll');assert.notEqual(second.id,next.id);assert.equal(nodes.find(n=>n.className==='library-configuration-link').href,'#'+second.id);assert.ok(!nodes.some(n=>n.id===old.id));
    assert.equal(nodes.filter(n=>n.tagName==='caption').length,0,'Legacy tables without captions render as before.');
  });
  await check('Barrier and service links with equal table indices navigate to their distinct owners',async h=>{
    const fields=[
      {label:'FRL',value:'Use the matching service and substrate.',table_links:[{field:'Service Size / Configuration',table_index:0},{field:'Barrier Construction',table_index:0},{field:'Barrier Construction',table_index:1}]},
      {label:'Service Size / Configuration',value:'',table:{columns:['Service','Wrap'],rows:[['Pipe','300 mm']]},table_row_ids:[['private-service-row']],table_links:[{field:'Barrier Construction',table_index:0}]},
      {label:'Barrier Construction',value:'All source alternatives.',table:{columns:['Substrate','FRL'],rows:[['Masonry','-/120/120'],['Panel','-/90/90'],['Framed wall','-/60/60']]},tables:[{columns:['Substrate','FRL'],rows:[['Floor','-/120/90']]}],table_row_ids:[['private-wall-1','private-wall-2','private-wall-3'],['private-floor-1']],table_links:[{field:'Service Size / Configuration',table_index:0},{field:'Barrier Construction',table_index:0}]}
    ],before=copy(fields);
    h.setRoute(path=>path==='/api/libraries'?meta():({...detail('technical','owners'),fields,images:[]}));await h.api.open('technical','owners');
    const nodes=walk(h.pane('technical').detailPanel),links=nodes.filter(n=>n.className==='library-configuration-link'),tables=nodes.filter(n=>n.className==='library-field-table-scroll');
    assert.deepEqual(links.map(n=>n.textContent),['View configuration table','View barrier construction table 1','View barrier construction table 2','View barrier construction table 1','View configuration table']);
    assert.deepEqual(links.slice(0,3).map(n=>n.href),tables.map(n=>'#'+n.id));assert.equal(new Set(tables.map(n=>n.id)).size,3);
    for(let i=0;i<3;i++){await links[i].emit('click',{detail:0});assert.equal(h.context.document.activeElement,tables[i]);}
    assert.deepEqual(walk(tables[1]).filter(n=>n.tagName==='td').map(n=>n.textContent),['Masonry','-/120/120','Panel','-/90/90','Framed wall','-/60/60']);
    assert.doesNotMatch(text(h.pane('technical').detailPanel),/private-wall|private-service|private-floor/);assert.deepEqual(fields,before);
  });
  await check('Generated Source Configuration columns stay hidden in legacy tables without shifting source cells',async h=>{
    const field={label:'Barrier Construction',value:'',table:{columns:['Substrate',' Source Configuration ','FRL'],rows:[['Masonry','private-proof-1','-/120/120'],['Panel','private-proof-2','-/90/90']]},table_row_ids:[['private-proof-1','private-proof-2']]},before=copy(field);
    h.setRoute(path=>path==='/api/libraries'?meta():({...detail('technical','legacy-column'),fields:[field],images:[]}));await h.api.open('technical','legacy-column');const nodes=walk(h.pane('technical').detailPanel);
    assert.deepEqual(nodes.filter(n=>n.tagName==='th').map(n=>n.textContent),['Substrate','FRL']);assert.deepEqual(nodes.filter(n=>n.tagName==='td').map(n=>n.textContent),['Masonry','-/120/120','Panel','-/90/90']);
    assert.doesNotMatch(text(h.pane('technical').detailPanel),/Source Configuration|private-proof/);assert.deepEqual(field,before);
  });
  await check('Configuration columns are omitted for either library without changing table rows or link targets',async h=>{
    for(const kind of ['technical','penetration']) {
      const fields=[{label:'Service Size / Configuration',value:'',table:{columns:[' Configuration ','Service size / condition','Wrap requirement','Source Configuration'],rows:[['Wrap configuration 1','up to 50 mm','300 mm','proof-1'],['Wrap configuration 2','up to 100 mm','600 mm','proof-2']]},tables:[{columns:['Substrate configuration','FRL'],rows:[['Wall','-/60/60']]}]},{label:'Service Wrap',value:'',table_links:[{field:'Service Size / Configuration',table_index:0}]}],before=copy(fields);
      h.setRoute(path=>path==='/api/libraries'?meta():({...detail(kind,'columns'),fields,images:[]}));await h.api.open(kind,'columns');
      const nodes=walk(h.pane(kind).detailPanel);
      assert.deepEqual(nodes.filter(n=>n.tagName==='th').map(n=>n.textContent),['Service size / condition','Wrap requirement','Substrate configuration','FRL']);
      assert.deepEqual(nodes.filter(n=>n.tagName==='td').map(n=>n.textContent),['up to 50 mm','300 mm','up to 100 mm','600 mm','Wall','-/60/60']);
      assert.deepEqual(fields,before);
      if(kind==='technical'){const link=nodes.find(n=>n.className==='library-configuration-link');await link.emit('click');assert.equal(h.context.document.activeElement,nodes.find(n=>n.className==='library-field-table-scroll'));}
    }
  });
  await check('Installation Details and Local Protection use paragraphs and real lists in both libraries without exposing page headings',async h=>{
    for(const kind of ['technical','penetration']) for(const label of ['Installation Details','Local Protection']) {
      const fields=[{label,value:'Source page 1, 2\nFit around the\nservice.\n\n1. Cut the board.\n2. Fill the gap.\nSource page 3\nProtect both faces.'}],before=copy(fields);
      h.setRoute(path=>path==='/api/libraries'?meta():({...detail(kind,'instructions'),fields,images:[]}));await h.api.open(kind,'instructions');
      const nodes=walk(h.pane(kind).detailPanel),prose=nodes.find(n=>n.className==='library-detail-text');
      assert.ok(prose);assert.doesNotMatch(text(prose),/Source page/);assert.match(text(prose),/Fit around the service\./);
      assert.equal(walk(prose).filter(n=>n.tagName==='ol').length,1);assert.equal(walk(prose).filter(n=>n.tagName==='li').length,2);assert.match(text(prose),/Protect both faces/);assert.deepEqual(fields,before);
    }
  });
  await check('FRL summaries show existing extrema once with working table links and all source cells retained',async h=>{
    const fields=[{label:'FRL',value:'-/60/60\n\n-/60/60 to -/120/120 — source substrate alternatives (Barrier Construction table 1; FRL). The entry selection remains separate.',table_links:[{field:'Barrier Construction',table_index:0}]},{label:'Barrier Construction',value:'',table:{columns:['Substrate','FRL'],rows:[['Wall A','-/60/60'],['Wall B','-/90/90'],['Wall C','-/120/120']]}}],before=copy(fields);
    h.setRoute(path=>path==='/api/libraries'?meta():({...detail('technical','range'),fields,images:[]}));await h.api.open('technical','range');
    const nodes=walk(h.pane('technical').detailPanel),frl=nodes.find(n=>n.tagName==='dd'),link=walk(frl).find(n=>n.className==='library-configuration-link'),target=nodes.find(n=>n.className==='library-field-table-scroll');
    assert.equal(frl.textContent,'-/60/60 to -/120/120');assert.equal(link.href,'#'+target.id);await link.emit('click');assert.equal(h.context.document.activeElement,target);
    assert.deepEqual(nodes.filter(n=>n.tagName==='td').map(n=>n.textContent),fields[1].table.rows.flat());assert.deepEqual(fields,before);
  });
  await check('FRL generated qualifiers disappear only when the exact referenced column or row retains the condition',async h=>{
    const cases=[
      {suffix:'source substrate alternatives (Barrier Construction table 1; FRL Without Wrap). The entry selection remains separate.',columns:['Substrate','FRL Without Wrap','FRL With Wrap'],rows:[['Wall','-/90/60','-/120/120']],rating:'-/90/60'},
      {suffix:'observed source service ratings (Barrier Construction table 1 (FRL With Wrap)).',columns:['FRL With Wrap','FRL Without Wrap'],rows:[['-/120/120','-/90/60']],rating:'-/120/120'},
      {suffix:'matched source barrier row (Barrier Construction table 1; Wall Thickness: 2 x 15mm board).',columns:['Wall Thickness','FRL'],rows:[['2 x 15mm board','-/120/120'],['2 x 10mm board','-/60/60']],rating:'-/120/120'},
      {suffix:'observed source service ratings (Barrier Construction table 1).',columns:['Service','Source FRL'],rows:[['Pipe','-/120/120']],rating:'-/120/120'}
    ];
    for(const [index,item] of cases.entries()) {
      const fields=[{label:'FRL',value:`${item.rating} — ${item.suffix}`,table_links:[{field:'Barrier Construction',table_index:0}]},{label:'Barrier Construction',value:'',table:{columns:item.columns,rows:item.rows}}],before=copy(fields);
      h.setRoute(path=>path==='/api/libraries'?meta():({...detail('technical','qualified-'+index),fields,images:[]}));await h.api.open('technical','qualified-'+index);const nodes=walk(h.pane('technical').detailPanel);
      assert.equal(nodes.find(n=>n.tagName==='dd').textContent,item.rating);assert.equal(nodes.filter(n=>n.className==='library-configuration-link').length,1);assert.deepEqual(nodes.filter(n=>n.tagName==='th').map(n=>n.textContent),item.columns);assert.deepEqual(nodes.filter(n=>n.tagName==='td').map(n=>n.textContent),item.rows.flat());assert.deepEqual(fields,before);
    }
  });
  await check('FRL never invents extrema for incomparable components or different dash masks',async h=>{
    for(const ratings of [['-/120/60','-/90/90'],['120/120/120','-/180/180']]) {
      const fields=[{label:'FRL',value:ratings.map(rating=>`${rating} — observed source service ratings (Service Size / Configuration table 1).`).join('\n\n'),table_links:[{field:'Service Size / Configuration',table_index:0}]},{label:'Service Size / Configuration',value:'',table:{columns:['FRL'],rows:ratings.map(rating=>[rating])}}],before=copy(fields);
      h.setRoute(path=>path==='/api/libraries'?meta():({...detail('technical','incomparable'),fields,images:[]}));await h.api.open('technical','incomparable');assert.equal(walk(h.pane('technical').detailPanel).find(n=>n.tagName==='dd').textContent,ratings.join('; '));assert.deepEqual(fields,before);
    }
  });
  await check('FRL keeps unsupported, missing, malformed and mismatched source scopes verbatim',async h=>{
    const base={label:'FRL',value:'-/120/120 — observed source service ratings (Barrier Construction table 1).',table_links:[{field:'Barrier Construction',table_index:0}]},table={columns:['Substrate','FRL'],rows:[['Wall','-/120/120']]};
    const cases=[{links:{}},{links:[null,{field:'Barrier Construction',table_index:0,extra:true}]},{links:[{field:'Barrier Construction',table_index:2}]},{table:{columns:['FRL'],rows:[null]}},{table:{columns:['FRL'],rows:[['-/60/60']]}},{value:'-/120/120 — source substrate alternatives (Barrier Construction table 1; FRL Without Wrap). The entry selection remains separate.'},{value:'-/120/120 — matched source barrier row (Barrier Construction table 1; Substrate: Floor).'}, {value:'-/120/120 — observed source service ratings (Barrier Construction table 1; unknown scope).'}];
    for(const [index,item] of cases.entries()) {
      const fields=[{...base,value:item.value||base.value,table_links:item.links??base.table_links},{label:'Barrier Construction',value:'',table:item.table||table}],before=copy(fields);
      h.setRoute(path=>path==='/api/libraries'?meta():({...detail('technical','invalid-frl-'+index),fields,images:[]}));await h.api.open('technical','invalid-frl-'+index);assert.equal(walk(h.pane('technical').detailPanel).find(n=>n.tagName==='dd').textContent,fields[0].value);assert.deepEqual(fields,before);
    }
  });
  await check('FRL authored qualifications and non-applicability survive concise linked-table summaries',async h=>{
    const authored='-/120/120 RISF 81; use the lower rating of the supporting construction.\n\nUp to -/180/120 (-/180/90 without wrap).\n\nBoard thickness must be at least 40 mm.\n\n-/120/120 — observed concrete-slab service ratings (Service Size / Configuration table 1; applicability to the CLT entry is not established).';
    const fields=[{label:'FRL',value:authored+'\n\n-/60/60 to -/120/120 — observed source service ratings (Service Size / Configuration table 1).\n\nSource configuration ratings remain subject to the stated barrier construction and installation conditions.',table_links:[{field:'Service Size / Configuration',table_index:0}]},{label:'Service Size / Configuration',value:'',table:{columns:['FRL'],rows:[['-/60/60'],['-/120/120']]}}],before=copy(fields);
    h.setRoute(path=>path==='/api/libraries'?meta():({...detail('technical','authored'),fields,images:[]}));await h.api.open('technical','authored');assert.equal(walk(h.pane('technical').detailPanel).find(n=>n.tagName==='dd').textContent,authored+'\n\n-/60/60 to -/120/120');assert.deepEqual(fields,before);
  });
  await check('FRL qualified source references are concise only when the linked table retains the qualified rating',async h=>{
    const qualification='Up to -/120/120, subject to the supporting barrier.',reference='Source substrate alternatives (Barrier Construction table 1; FRL): retain the qualified source ratings as shown; no range is inferred.';
    const fields=[{label:'FRL',value:qualification+'\n\n'+reference,table_links:[{field:'Barrier Construction',table_index:0}]},{label:'Barrier Construction',value:'',table:{columns:['Substrate','FRL'],rows:[['Wall',qualification]]}}],before=copy(fields);
    h.setRoute(path=>path==='/api/libraries'?meta():({...detail('technical','unresolved'),fields,images:[]}));await h.api.open('technical','unresolved');let nodes=walk(h.pane('technical').detailPanel);
    assert.equal(nodes.find(n=>n.tagName==='dd').textContent,qualification);assert.equal(nodes.filter(n=>n.className==='library-configuration-link').length,1);assert.deepEqual(nodes.filter(n=>n.tagName==='td').map(n=>n.textContent),['Wall',qualification]);assert.deepEqual(fields,before);
    fields[1].table.rows=[['Wall','']];h.context.audit.renderDetail(h.pane('technical'));nodes=walk(h.pane('technical').detailPanel);assert.equal(nodes.find(n=>n.tagName==='dd').textContent,qualification+'\n\n'+reference);
  });
  await check('Firefly service fields are formatted and Diagrams & Figures displays images without reference copy',async h=>{
    const fields=[{label:'Manufacturer',value:'TBA FIREFLY'},{label:'Service Wrap',value:'1. Wrap the service.\n2. Secure both ends.'},{label:'Service Size / Configuration',value:'First line of\na service description.'},{label:'Diagrams & Figures',value:'Reference figures: 1, 2, 3',images:[{id:'figure-1',role:'Reference figure',caption:'Refer Figure - PDF page 12'}]}],before=copy(fields);
    h.setRoute(path=>path==='/api/libraries'?meta():({...detail('technical','firefly'),fields,images:[]}));await h.api.open('technical','firefly');let nodes=walk(h.pane('technical').detailPanel);
    assert.equal(nodes.filter(n=>n.className==='library-detail-text').length,2);assert.equal(nodes.filter(n=>n.tagName==='li').length,2);assert.equal(nodes.filter(n=>n.tagName==='figcaption').length,0);
    assert.doesNotMatch(text(h.pane('technical').detailPanel),/Reference figures:|Refer Figure/);assert.equal(nodes.find(n=>n.tagName==='img').src,'/api/libraries/images/figure-1');assert.match(nodes.find(n=>n.tagName==='img').alt,/Reference figure/);assert.deepEqual(fields,before);
    fields[0].value='';h.pane('technical').detail.id='fas190235-system-synthetic';h.context.audit.renderDetail(h.pane('technical'));nodes=walk(h.pane('technical').detailPanel);assert.equal(nodes.filter(n=>n.className==='library-detail-text').length,2);assert.equal(nodes.filter(n=>n.tagName==='figcaption').length,0);
    h.pane('technical').detail.id='other-system';fields[0].value='Other manufacturer';h.context.audit.renderDetail(h.pane('technical'));nodes=walk(h.pane('technical').detailPanel);assert.equal(nodes.filter(n=>n.className==='library-detail-text').length,0);assert.equal(nodes.filter(n=>n.tagName==='figcaption').length,1);assert.match(text(h.pane('technical').detailPanel),/Reference figures: 1, 2, 3/);
  });
  await check('Image-only Firefly figures and provenance-only instructions leave no empty sections',async h=>{
    const fields=[{label:'Manufacturer',value:'Firefly'},{label:'Diagrams & Figures',value:'Reference figures: 12'},{label:'Installation Details',value:'Source page 1\n\nSource pages 2, 3'},{label:'Barrier Construction',value:'Wall',table:{columns:['Configuration'],rows:[['one']]}}];
    h.setRoute(path=>path==='/api/libraries'?meta():({...detail('technical','empty'),fields,images:[]}));await h.api.open('technical','empty');const nodes=walk(h.pane('technical').detailPanel);
    assert.doesNotMatch(text(h.pane('technical').detailPanel),/Reference figures: 12|Diagrams & Figures|Installation Details|Source page/);assert.equal(nodes.filter(n=>n.tagName==='table').length,0);
  });
  await check('A saved item invalidates prices and details without losing list search and filters',async h=>{
    await h.api.open('penetration');const pane=h.pane('penetration');pane.searchInput.value='retained search';await pane.searchInput.emit('input');await h.runTimers();const filter=walk(pane.filterControls).find(node=>node.tagName==='select');filter.value='sample & test';await filter.emit('change');await flush();
    await h.api.open('penetration','penetration-1');h.api.invalidate();
    h.setRoute(path=>path==='/api/libraries'?meta():path.includes('?')?({...records('penetration'),items:[{id:'penetration-1',title:'FL-ID-001',price:{amount:987.654321,label:'Saved library price'},editable:true}]}):({...detail('penetration','penetration-1'),title:'FL-ID-001',price:{amount:987.654321,label:'Saved library price'},editable:true}));
    await h.api.open('penetration','penetration-1');assert.match(text(pane.detailPanel),/Saved library price: \$987\.65/);assert.ok(walk(pane.detailPanel).find(node=>node.dataset.libraryEdit==='penetration-1'));
    await walk(pane.detailPanel).find(node=>node.dataset.libraryBackToResults).emit('click');await flush();assert.equal(pane.searchInput.value,'retained search');assert.match(h.calls.at(-1).path,/search=retained\+search.*category=sample\+%26\+test/);assert.match(text(pane.results),/\$987\.65/);
  });
  await check('Bidirectional links return to the original record and preserve filtered results',async h=>{
    await h.api.open('penetration');const pane=h.pane('penetration');pane.searchInput.value='original filter';await pane.searchInput.emit('input');await h.runTimers();
    const result=walk(pane.results).find(node=>node.dataset.libraryRecord);await result.emit('click');await flush();
    const related=walk(pane.detailPanel).find(node=>node.dataset.libraryRelated);await related.emit('click');await flush();const other=h.pane('technical');assert.equal(other.selected,'technical-1');
    await walk(other.detailPanel).find(node=>node.dataset.libraryBack).emit('click');await flush();assert.equal(h.context.audit.state.current,'penetration');assert.equal(pane.selected,'penetration-1');
    await walk(pane.detailPanel).find(node=>node.dataset.libraryBackToResults).emit('click');await flush();assert.equal(pane.list.hidden,false);assert.equal(pane.detailPanel.hidden,true);assert.equal(pane.searchInput.value,'original filter');assert.equal(pane.searchInput.focused,true);
  });
  await check('Both detail directions use accessible back and unlink symbols, and unlink reloads the same record',async h=>{
    let unlinked=false;const confirmations=[];h.context.window.CeasefirePenetrationNavigation={confirm:async(...args)=>{confirmations.push(args);return true;}};
    h.setRoute((path,options)=>{
      if(path==='/api/libraries')return meta();
      if(path.endsWith('/links/remove')){assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{technical_id:'technical-1'});unlinked=true;return{unlinked:true,penetration_id:'penetration-1',technical_id:'technical-1'};}
      if(path.includes('?'))return records(path.includes('/technical')?'technical':'penetration');
      const kind=path.includes('/technical/')?'technical':'penetration',id=decodeURIComponent(path.split('/').at(-1));return{...detail(kind,id),links:unlinked?[]:detail(kind,id).links};
    });
    for(const kind of ['penetration','technical']){
      await h.api.open(kind,kind+'-1');const pane=h.pane(kind),back=walk(pane.detailPanel).find(node=>node.dataset.libraryBackToResults),remove=walk(pane.detailPanel).find(node=>node.dataset.libraryUnlink);
      assert.equal(back.textContent,'');assert.equal(back.getAttribute('aria-label'),'Back to results');assert.equal(back.title,'Back to results');assert.match(text(back),/←/);
      assert.ok(remove);assert.match(remove.getAttribute('aria-label'),kind==='penetration'?/Unlink technical reference/:/Unlink firestopping record/);
      if(kind==='penetration'){await remove.emit('click');await flush();assert.equal(pane.selected,'penetration-1');assert.equal(walk(pane.detailPanel).filter(node=>node.dataset.libraryUnlink).length,0);assert.match(pane.message.textContent,/Technical reference unlinked/);}
      unlinked=false;
    }
    assert.deepEqual(confirmations[0],['Unlink technical reference?','Related synthetic record will be unlinked from this library record.','Unlink']);
  });
  await check('A pending record cannot reopen itself after Back to results',async h=>{
    await h.api.open('penetration');const pane=h.pane('penetration'),pending=deferred();h.setRoute(()=>pending.promise);
    const opening=h.api.open('penetration','slow');await flush();await walk(pane.detailPanel).find(node=>node.dataset.libraryBackToResults).emit('click');pending.resolve(detail('penetration','slow'));await opening;
    assert.equal(pane.selected,null);assert.equal(pane.detailPanel.hidden,true);assert.equal(pane.list.hidden,false);
  });
  await check('Late older record responses cannot replace a newer selection',async h=>{
    await h.api.open('technical');const pending=deferred();h.setRoute(path=>path.endsWith('/old')?pending.promise:detail('technical','new'));
    const opening=h.api.open('technical','old');await flush();await h.api.open('technical','new');pending.resolve(detail('technical','old'));await opening;
    assert.equal(h.pane('technical').selected,'new');assert.match(text(h.pane('technical').detailPanel),/Synthetic new/);assert.doesNotMatch(text(h.pane('technical').detailPanel),/Synthetic old/);
  });
  await check('Unavailable local libraries show their reason without requesting nonexistent lists',async h=>{
    h.setRoute(()=>({libraries:[{id:'penetration',available:false,notice:'Local workbook is missing.'}]}));await h.api.open('penetration');
    assert.equal(h.calls.length,1);assert.match(text(h.pane('penetration').results),/Local workbook is missing/);assert.equal(h.pane('penetration').next.disabled,true);
  });
  await check('List errors can be retried without losing the query or enabling stale pages',async h=>{
    await h.api.open('technical');const pane=h.pane('technical');h.setRoute(()=>{throw new Error('Read failed');});pane.searchInput.value='keep query';await pane.searchInput.emit('input');await h.runTimers();
    assert.match(pane.message.textContent,/Read failed.*Refresh/);assert.equal(pane.next.disabled,true);
    h.setRoute(path=>path==='/api/libraries'?meta():records('technical'));await pane.refresh.emit('click');await flush();assert.equal(pane.searchInput.value,'keep query');assert.match(h.calls.at(-1).path,/search=keep\+query/);assert.equal(pane.message.hidden,true);
  });
  await check('Concurrent opens share bootstrap and failures remain retryable',async h=>{
    const pending=deferred();h.setRoute(path=>path==='/api/libraries'?pending.promise:records(path.includes('technical')?'technical':'penetration'));
    const first=h.api.open('penetration'),second=h.api.open('technical');await flush();assert.equal(h.calls.length,1);pending.reject(new Error('Library index unavailable'));await Promise.all([first,second]);
    assert.match(h.pane('penetration').message.textContent,/index unavailable/);assert.match(h.pane('technical').message.textContent,/index unavailable/);
    h.setRoute(path=>path==='/api/libraries'?meta():records('technical'));await h.pane('technical').refresh.emit('click');await flush();assert.equal(h.pane('technical').results.children.length,1);
  });
  await check('Returning from a record reloads an interrupted search instead of displaying stale cached results',async h=>{
    await h.api.open('penetration');const pane=h.pane('penetration');pane.searchInput.value='new search';await pane.searchInput.emit('input');
    await h.api.open('penetration','penetration-1');h.setRoute(()=>({...records('penetration'),items:[{id:'new',title:'New search results'}]}));
    await walk(pane.detailPanel).find(node=>node.dataset.libraryBackToResults).emit('click');await flush();assert.match(h.calls.at(-1).path,/search=new\+search/);assert.match(text(pane.results),/New search results/);
  });
  await check('Refreshing a removed final results page moves to a valid page while retaining filters',async h=>{
    await h.api.open('technical');const pane=h.pane('technical');pane.offset=100;pane.search='kept';pane.searchInput.value='kept';
    h.setRoute(path=>path==='/api/libraries'?meta():({...records('technical'),items:path.includes('offset=100')?[]:[{id:'remaining',title:'Remaining record'}],total:20,offset:path.includes('offset=100')?100:0}));
    await pane.refresh.emit('click');await flush();assert.equal(pane.offset,0);assert.match(text(pane.results),/Remaining record/);assert.match(h.calls.at(-1).path,/search=kept/);assert.equal(pane.previous.disabled,true);
  });
  await check('Firestopping summary stays catalog-wide while the exact reference filter combines with search and other filters',async h=>{
    h.setRoute(path=>path==='/api/libraries'?{libraries:[{id:'penetration',available:true,count:100,unlinked_count:24}]}:({...records('penetration'),counts:{total:100,linked:76,unlinked:24,manufacturers:[{name:'Boss',count:40},{name:'Promat',count:60}]},filters:[...filters,{key:'technical_reference',label:'Server label',options:['any','linked','unlinked']}]}));
    await h.api.open('penetration');const pane=h.pane('penetration');assert.deepEqual(walk(pane.summary).filter(node=>node.tagName==='td').map(node=>node.textContent),['100','40','60','24']);assert.match(text(pane.summary),/Total records.*Boss.*Promat.*No related technical references/);assert.match(pane.count.textContent,/of 1 records/);
    const ref=walk(pane.filterControls).find(node=>node.dataset.libraryFilter==='technical_reference');assert.deepEqual(ref.children.map(node=>[node.value,node.textContent]),[['any','Any'],['linked','Linked Technical References'],['unlinked','No Linked Technical References']]);assert.equal(ref.value,'any');
    pane.searchInput.value='kept search';await pane.searchInput.emit('input');await h.runTimers();const category=walk(pane.filterControls).find(node=>node.dataset.libraryFilter==='category');category.value='sample & test';await category.emit('change');await flush();
    for(const value of ['linked','unlinked','any']){const control=walk(pane.filterControls).find(node=>node.dataset.libraryFilter==='technical_reference');control.value=value;await control.emit('change');await flush();assert.match(h.calls.at(-1).path,new RegExp('technical_reference='+value));assert.match(h.calls.at(-1).path,/search=kept\+search.*category=sample\+%26\+test/);assert.deepEqual(walk(pane.summary).filter(node=>node.tagName==='td').map(node=>node.textContent),['100','40','60','24']);}
  });
  await check('Every Firestopping card and detail has link and schedule actions; Add guards duplicates and reports errors next to the action',async h=>{
    const pending=deferred(),ids=[];h.context.window.CeasefirePenetrations={addLibraryItem:id=>{ids.push(id);return pending.promise}};
    h.setRoute(path=>path==='/api/libraries'?meta():path.includes('?')?({...records('penetration'),items:[{...records('penetration').items[0],editable:true}]}):({...detail('penetration','penetration-1'),editable:true}));
    await h.api.open('penetration');const pane=h.pane('penetration');const add=walk(pane.results).find(node=>node.dataset.libraryAdd),link=walk(pane.results).find(node=>node.dataset.libraryLink),edit=walk(pane.results).find(node=>node.dataset.libraryEdit),remove=walk(pane.results).find(node=>node.dataset.libraryDelete);assert.ok(link);assert.equal(link.getAttribute('aria-label'),'Link Library Item');assert.equal(link.textContent,'');assert.match(link.className,/link-action-button/);assert.match(edit.className,/library-edit-button/);assert.match(remove.className,/library-delete-button/);assert.match(add.className,/penetration-add-action/);assert.equal(add.getAttribute('aria-label'),'Add to Schedule');assert.equal(add.children[0].textContent,'+');assert.equal(add.children[0].getAttribute('aria-hidden'),'true');assert.match(add.children[1].className,/sr-only/);const work=add.emit('click');await flush();assert.equal(add.disabled,true);await add.emit('click');assert.deepEqual(ids,['penetration-1']);pending.reject(new Error('Keep the invalid schedule value until corrected.'));await work;
    assert.equal(add.disabled,false);assert.match(text(pane.results),/could not be added.*invalid schedule value/);assert.equal(pane.selected,null);assert.equal(pane.list.hidden,false);
    await h.api.open('penetration','penetration-1');assert.ok(walk(pane.detailPanel).find(node=>node.dataset.libraryLink));assert.ok(walk(pane.detailPanel).find(node=>node.dataset.libraryAdd));
    await h.api.open('technical','technical-1');assert.equal(walk(h.pane('technical').detailPanel).filter(node=>node.dataset.libraryLink||node.dataset.libraryAdd).length,0);
  });
  await check('Every Firestopping item has an accessible trash icon and deletion requires confirmation',async h=>{
    const answers=[false,true],confirmations=[];h.context.window.CeasefirePenetrationNavigation={confirm:async(...args)=>{confirmations.push(args);return answers.shift();}};
    let deleted=false;h.setRoute((path,options)=>{
      if(path==='/api/libraries')return meta();
      if(path.endsWith('/delete')){assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{});deleted=true;return{deleted:true,id:'penetration-1'};}
      return deleted?{...records('penetration'),items:[],total:0}:{...records('penetration'),items:[{...records('penetration').items[0],title:'FL-ID-001 — Synthetic item'}]};
    });
    await h.api.open('penetration');const pane=h.pane('penetration'),remove=walk(pane.results).find(node=>node.dataset.libraryDelete==='penetration-1');assert.ok(remove);assert.match(remove.title,/Remove FL-ID-001/);assert.equal(remove.getAttribute('aria-label'),remove.title);const trash=walk(remove).find(node=>node.className==='library-trash-icon');assert.match(trash.innerHTML,/<svg viewBox="0 0 24 24"/);assert.equal(trash.getAttribute('aria-hidden'),'true');
    await remove.emit('click');assert.equal(deleted,false);assert.equal(confirmations.length,1);assert.deepEqual(confirmations[0],['Remove Firestopping Library item?','FL-ID-001 — Synthetic item will be removed from the Firestopping Library.','Remove item']);
    await remove.emit('click');await flush();assert.equal(deleted,true);assert.equal(pane.selected,null);assert.equal(pane.results.children[0].className,'empty-state');assert.match(pane.message.textContent,/was removed from the Firestopping Library/);
    await h.api.open('technical','technical-1');assert.equal(walk(h.pane('technical').detailPanel).filter(node=>node.dataset.libraryDelete).length,0);
  });
  await check('A late Add failure cannot replace a newer record or leak its error into that record',async h=>{
    const pending=deferred();h.context.window.CeasefirePenetrations={addLibraryItem:()=>pending.promise};await h.api.open('penetration','first');const pane=h.pane('penetration'),work=walk(pane.detailPanel).find(node=>node.dataset.libraryAdd).emit('click');await flush();await h.api.open('penetration','second');pending.reject(new Error('Stale failure'));await work;
    assert.equal(pane.selected,'second');assert.doesNotMatch(text(pane.detailPanel),/Stale failure/);assert.equal(pane.addPending.size,0);assert.equal(walk(pane.detailPanel).find(node=>node.dataset.libraryAdd).disabled,false);
  });
  await check('Add confirms the recalculated price on the same library detail without navigating',async h=>{
    h.context.window.CeasefirePenetrations={addLibraryItem:async()=>({added:true,id:'line-7',message:'FL-ID-007 added. Recalculated item price: $131.26.'})};
    await h.api.open('penetration','penetration-1');const pane=h.pane('penetration');await walk(pane.detailPanel).find(node=>node.dataset.libraryAdd).emit('click');
    assert.equal(pane.selected,'penetration-1');assert.equal(pane.detailPanel.hidden,false);assert.match(text(pane.detailPanel),/Recalculated item price: \$131\.26/);
    const status=walk(pane.detailPanel).find(node=>node.className==='message library-action-message');assert.ok(status);assert.equal(status.hidden,false);
  });
  await check('A late successful Add does not announce its price on a newer library record',async h=>{
    const pending=deferred();h.context.window.CeasefirePenetrations={addLibraryItem:()=>pending.promise};await h.api.open('penetration','first');const pane=h.pane('penetration'),work=walk(pane.detailPanel).find(node=>node.dataset.libraryAdd).emit('click');await flush();await h.api.open('penetration','second');pending.resolve({added:true,message:'Old item added at $1.23'});await work;
    assert.equal(pane.selected,'second');assert.doesNotMatch(text(pane.detailPanel),/Old item added/);
  });
  await check('Manual multi-link selection saves only IDs, refreshes reciprocal caches and full totals, and preserves list controls',async h=>{
    let saved=false;h.setRoute((path,options)=>{
      if(path==='/api/libraries')return{libraries:[{id:'penetration',available:true,count:2,unlinked_count:saved?0:1},{id:'technical',available:true,count:2}]};
      if(path.endsWith('/links')){assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{technical_ids:['technical-1','technical-2']});saved=true;return{linked:true,penetration_id:'penetration-1',technical_ids:['technical-1','technical-2'],created_ids:['technical-1','technical-2'],existing_ids:[]}};
      if(path.includes('/technical?'))return{...records('technical'),items:[{id:'technical-1',title:'First choice'},{id:'technical-2',title:'Second choice'}],total:2};if(path.includes('?'))return{...records('penetration'),counts:{total:2,linked:saved?2:1,unlinked:saved?0:1}};
      return{...detail('technical','technical-1'),links:saved?[{kind:'penetration',id:'penetration-1',title:'New reciprocal link'}]:[]};
    });
    await h.api.open('technical','technical-1');await h.api.open('penetration');const pane=h.pane('penetration');pane.searchInput.value='keep';await pane.searchInput.emit('input');await h.runTimers();const ref=walk(pane.filterControls).find(node=>node.dataset.libraryFilter==='technical_reference');ref.value='any';await ref.emit('change');await flush();
    await walk(pane.results).find(node=>node.dataset.libraryLink).emit('click');await flush();const session=pane.linkSession,choices=walk(session.results).filter(node=>node.dataset.libraryLinkChoice);assert.equal(pane.list.hidden,true);assert.equal(session.save.disabled,true);for(const choice of choices){choice.checked=true;await choice.emit('change');}assert.equal(session.save.disabled,false);assert.equal(session.save.textContent,'Save links (2)');await session.save.emit('click');await flush();
    assert.equal(pane.linkSession,null);assert.equal(pane.list.hidden,false);assert.equal(pane.searchInput.value,'keep');assert.equal(pane.filters.technical_reference,'any');assert.match(pane.message.textContent,/2 technical references linked/);assert.deepEqual(walk(pane.summary).filter(node=>node.tagName==='td').map(node=>node.textContent),['2','0']);
    await h.api.open('technical','technical-1');assert.match(text(h.pane('technical').detailPanel),/New reciprocal link/);
  });
  await check('Link search is encoded and paginated; stale results cannot replace a later query or cancelled picker',async h=>{
    const old=deferred();h.setRoute(path=>path==='/api/libraries'?meta():path.includes('/technical?')?(path.includes('search=old')?old.promise:{...records('technical'),total:45,offset:Number(new URL('http://local'+path).searchParams.get('offset')),items:[{id:path.includes('search=new')?'new':'technical-1',title:path.includes('search=new')?'New choice':'Technical choice'}]}):records('penetration'));
    await h.api.open('penetration');const pane=h.pane('penetration');await walk(pane.results).find(node=>node.dataset.libraryLink).emit('click');await flush();const session=pane.linkSession;await session.next.emit('click');await flush();assert.match(h.calls.at(-1).path,/offset=20/);
    session.searchInput.value='old';await session.searchInput.emit('input');const first=h.runTimers();await flush();session.searchInput.value='new & /';await session.searchInput.emit('input');await h.runTimers();assert.match(h.calls.at(-1).path,/search=new\+%26\+%2F.*offset=0/);old.resolve({...records('technical'),items:[{id:'stale',title:'Stale choice'}]});await first;assert.match(text(session.results),/New choice/);assert.doesNotMatch(text(session.results),/Stale choice/);
    const late=deferred();h.setRoute(()=>late.promise);session.searchInput.value='late';await session.searchInput.emit('input');const loading=h.runTimers();await flush();const cancel=session.cancel.emit('click');await flush();late.resolve(records('technical'));await loading;await cancel;assert.equal(pane.linkSession,null);assert.equal(pane.linkPanel.hidden,true);assert.equal(pane.list.hidden,false);
  });
  await check('Link failures retain selection for retry, reject unconfirmed receipts, and duplicate receipts are successful',async h=>{
    let outcome='error';h.setRoute((path,options)=>{if(path==='/api/libraries')return meta();if(path.endsWith('/links'))return outcome==='error'?{error:'Target is unavailable'}:outcome==='unconfirmed'?{}:{linked:true,penetration_id:'penetration-1',technical_ids:['technical-1'],created_ids:[],existing_ids:['technical-1']};return records(path.includes('/technical')?'technical':'penetration')});
    await h.api.open('penetration');const pane=h.pane('penetration');await walk(pane.results).find(node=>node.dataset.libraryLink).emit('click');await flush();const session=pane.linkSession,choice=walk(session.results).find(node=>node.dataset.libraryLinkChoice);assert.match(session.save.className,/link-action-button/);choice.checked=true;await choice.emit('change');await session.save.emit('click');assert.equal(pane.linkSession,session);assert.deepEqual([...session.selected],['technical-1']);assert.equal(session.save.disabled,false);assert.match(session.message.textContent,/not confirmed.*Target is unavailable.*Retry to check the same links/);
    outcome='unconfirmed';await session.save.emit('click');assert.match(session.message.textContent,/did not confirm/);assert.equal(pane.linkSession,session);outcome='duplicate';await session.save.emit('click');assert.equal(pane.linkSession,null);assert.match(pane.message.textContent,/already linked/);
  });
  await check('A link save completing after navigation updates caches without reopening its abandoned picker',async h=>{
    const pending=deferred();h.setRoute(path=>path==='/api/libraries'?meta():path.endsWith('/links')?pending.promise:path.includes('?')?records(path.includes('/technical')?'technical':'penetration'):detail('technical','other'));
    await h.api.open('penetration');const pane=h.pane('penetration');await walk(pane.results).find(node=>node.dataset.libraryLink).emit('click');await flush();const session=pane.linkSession,choice=walk(session.results).find(node=>node.dataset.libraryLinkChoice);choice.checked=true;await choice.emit('change');const saving=session.save.emit('click');await flush();assert.equal(session.cancel.disabled,true);assert(session.choices.every(choice=>choice.disabled));await h.api.open('technical','other');pending.resolve({linked:true,penetration_id:'penetration-1',technical_ids:['technical-1'],created_ids:['technical-1'],existing_ids:[]});await saving;
    assert.equal(pane.linkSession,null);assert.equal(pane.linkPanel.hidden,true);assert.equal(h.context.audit.state.current,'technical');assert.equal(h.pane('technical').selected,'other');assert.match(text(h.pane('technical').detailPanel),/Synthetic other/);assert.equal(h.pane('technical').data,null);
  });
  await check('Schedule quantities update card and detail badges without replacing results, controls, pagination or scroll',async h=>{
    const quantities=new Map();h.context.window.CeasefirePenetrations={libraryQuantity:id=>quantities.get(id)};await h.api.open('penetration');const pane=h.pane('penetration'),card=pane.results.children[0],search=pane.searchInput,listBadge=walk(card).find(node=>node.dataset.libraryQuantity==='penetration-1'),calls=h.calls.length;
    assert.equal(listBadge.hidden,true);pane.offset=50;pane.filters.category='sample & test';pane.search='preserved search';search.value='preserved search';pane.results.scrollTop=412;
    quantities.set('penetration-1',3);h.api.scheduleChanged();assert.equal(listBadge.textContent,'Quantity: 3');assert.equal(listBadge.getAttribute('aria-label'),'Current schedule quantity: 3');assert.equal(listBadge.hidden,false);assert.equal(pane.results.children[0],card);assert.equal(pane.searchInput,search);assert.equal(pane.offset,50);assert.equal(pane.filters.category,'sample & test');assert.equal(pane.results.scrollTop,412);assert.equal(h.calls.length,calls);
    await h.api.open('penetration','penetration-1');const heading=walk(pane.detailPanel).find(node=>node.tagName==='h3'),detailBadge=walk(pane.detailPanel).find(node=>node.dataset.libraryQuantity==='penetration-1');assert.equal(detailBadge.textContent,'Quantity: 3');const panelNodes=[...pane.detailPanel.children];pane.detailPanel.scrollTop=640;
    quantities.set('penetration-1',4.1234567890123);h.api.scheduleChanged();assert.equal(detailBadge.textContent,'Quantity: 4.1234567890123');assert.equal(listBadge.textContent,detailBadge.textContent);assert.deepEqual(pane.detailPanel.children,panelNodes);assert.ok(walk(pane.detailPanel).includes(heading));assert.equal(pane.detailPanel.scrollTop,640);
    quantities.clear();h.api.scheduleChanged();assert.equal(detailBadge.hidden,true);assert.equal(listBadge.hidden,true);quantities.set('penetration-1',2);h.api.scheduleChanged();assert.equal(detailBadge.textContent,'Quantity: 2');await h.api.open('technical');assert.equal(walk(h.pane('technical').results).filter(node=>node.dataset.libraryQuantity).length,0);
  });
  await check('Unavailable and negative schedule quantities remain distinct from a removed or empty item',async h=>{
    let quantity=null;h.context.window.CeasefirePenetrations={libraryQuantity:()=>quantity};await h.api.open('penetration');const badge=walk(h.pane('penetration').results).find(node=>node.dataset.libraryQuantity);assert.equal(badge.hidden,false);assert.equal(badge.textContent,'Quantity unavailable');
    quantity=-1.25;h.api.scheduleChanged();assert.equal(badge.textContent,'Quantity: -1.25');assert.equal(badge.hidden,false);quantity=0;h.api.scheduleChanged();assert.equal(badge.hidden,false);assert.equal(badge.textContent,'Quantity: 0');quantity=undefined;h.api.scheduleChanged();assert.equal(badge.hidden,true);quantity=Infinity;h.api.scheduleChanged();assert.equal(badge.textContent,'Quantity unavailable');assert.equal(badge.hidden,false);
  });
  await check('Add completion refreshes from the current schedule, never a stale receipt quantity',async h=>{
    let quantity;const pending=deferred();h.context.window.CeasefirePenetrations={libraryQuantity:()=>quantity,addLibraryItem:()=>pending.promise};await h.api.open('penetration');const pane=h.pane('penetration'),card=pane.results.children[0],add=walk(card).find(node=>node.dataset.libraryAdd),badge=walk(card).find(node=>node.dataset.libraryQuantity);
    const adding=add.emit('click');await flush();quantity=1;h.api.scheduleChanged();assert.equal(badge.textContent,'Quantity: 1');quantity=undefined;h.api.scheduleChanged();pending.resolve({added:true,quantity:1,message:'Added to previous schedule'});await adding;assert.equal(badge.hidden,true);assert.equal(pane.results.children[0],card);
  });
  await check('Technical fields hide provenance and lead time, retain explicit None, paired tables and diagram status',async h=>{
    h.setRoute(path=>path==='/api/libraries'?meta():({...detail('technical','technical-1'),technical_basis:{source_fields:[{label:'Private original',value:'Hidden original text'}]},diagram_status:'One source page is available.',fields:[
      {label:'Lead Time',value:'Hidden delivery text'}, {label:'Technical Basis',value:'Hidden metadata text'}, {label:'Empty',value:' '},
      {label:'Service Wrap',value:'None'},
      {label:'Service Size / Configuration',value:'',tables:[{columns:['Configuration','Service condition'],rows:[['A','up to NB50']]},{columns:['Configuration','Service condition'],rows:[['B','up to NB100']]}]},
      {label:'Diagrams & Figures',value:'',images:[{id:'synthetic_image-1',caption:'Figure A',role:'Installation concept',url:'/api/libraries/penetration/unrelated/image'}]}
    ]}));
    await h.api.open('technical','technical-1');const panel=h.pane('technical').detailPanel,nodes=walk(panel),display=text(panel);
    assert.doesNotMatch(display,/Hidden|Private original|Lead Time|Technical Basis|Empty/);assert.match(display,/Service Wrap None/);
    assert.equal(nodes.filter(node=>node.tagName==='table').length,2);assert.match(display,/up to NB50/);assert.match(display,/up to NB100/);
    assert.equal(nodes.filter(node=>node.textContent==='One source page is available.').length,1);
    assert(nodes.some(node=>node.tagName==='img'&&node.alt==='Installation concept — Figure A'));
    assert(nodes.filter(node=>node.tagName==='img').every(node=>node.src==='/api/libraries/images/synthetic_image-1'));
  });
  console.log(`${passed} library UI regression checks passed.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
