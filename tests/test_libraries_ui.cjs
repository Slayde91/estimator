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
    return{tagName,children:[],dataset:{},listeners:{},textContent:'',value:'',hidden:false,disabled:false,
      append(...children){this.children.push(...children);},replaceChildren(...children){this.children=[];this.append(...children);},
      addEventListener(name,fn){(this.listeners[name]||=[]).push(fn);},async emit(name){for(const fn of this.listeners[name]||[])await fn({target:this});},
      setAttribute(name,value){attributes.set(name,String(value));},getAttribute(name){return attributes.get(name);},focus(options){this.focused=true;this.focusOptions=options;},scrollIntoView(){this.scrolled=true;}};
  }
  const byId=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
  let route=path=>{if(path==='/api/libraries')return meta();const [, , ,kind,id]=path.split('/');return id?detail(kind,decodeURIComponent(id)):records(kind.split('?')[0]);};
  const context={document:{getElementById:byId,createElement:element},window:{},URLSearchParams,AbortController,Map,Set,JSON,Number,String,Object,Array,Promise,Error,console,
    setTimeout(fn){timers.set(++timerId,fn);return timerId;},clearTimeout(id){timers.delete(id);},fetch:async(path,options)=>{calls.push({path,options});const data=await route(path,options);return{ok:!data?.error,status:data?.error?400:200,json:async()=>data};}};
  vm.createContext(context);vm.runInContext(fs.readFileSync('static/libraries.js','utf8').replace(/\}\)\(\);\s*$/,`globalThis.audit={state,paneFor,loadList,loadDetail,navigate,back,refresh,showList};})();`),context);
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
  await check('Full detail uses literal source text and accessible local source-page and diagram links',async h=>{
    await h.api.open('technical','technical-1');const pane=h.pane('technical'),nodes=walk(pane.detailPanel);
    assert.match(text(pane.detailPanel),/<img src=x onerror=alert\(1\)>/);assert.match(text(pane.detailPanel),/Literal second line/);assert.match(text(pane.detailPanel),/Not recorded/);assert.match(text(pane.detailPanel),/Zero 0/);
    const pdf=nodes.find(node=>node.tagName==='a'&&node.href.includes('documents/'));assert.equal(pdf.href,'/api/libraries/documents/synthetic-document.pdf#page=12');assert.match(pdf.getAttribute('aria-label'),/page 12.*new tab/);assert.equal(pdf.rel,'noopener noreferrer');
    const image=nodes.find(node=>node.tagName==='img');assert.equal(image.loading,'lazy');assert.equal(image.src,'/api/libraries/images/synthetic_image-1');assert.equal(image.alt,'Synthetic diagram');
    assert.ok(nodes.every(node=>node.innerHTML===undefined));assert.doesNotMatch(text(pane.detailPanel),/Source fingerprint|synthetic-hash/);assert.match(text(pane.detailPanel),/Related firestopping records/);
    const heading=nodes.find(node=>node.tagName==='h3');assert.equal(heading.focusOptions.preventScroll,true);assert.equal(pane.detailPanel.scrolled,true);assert.equal(heading.scrolled,undefined,'Keep Back navigation above the heading inside the scrolled view.');
    assert.equal(pane.detailPanel.children.filter(node=>node.textContent==='Record-specific source qualification.').length,1);assert.doesNotMatch(pane.notice.textContent,/Record-specific/);assert.match(pane.notice.textContent,/Synthetic local reference library/);
  });
  await check('Untrusted asset IDs never become fetchable links; unavailable relationship text remains visible',async h=>{
    h.setRoute(path=>path==='/api/libraries'?meta():({...detail('technical','technical-1'),sources:[{filename:'Unavailable report',document_id:'../../private',page:-1}],images:[{id:'https://remote/image'},{id:'../private'}],links:[{title:'Unresolved original reference',relationship:'Ambiguous source association'}]}));
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
    await h.api.open('penetration');const pane=h.pane('penetration');assert.match(text(pane.results),/FL-ID-001.*Library price: \$123\.46/);assert.doesNotMatch(text(pane.results),/Workbook price/);await walk(pane.results).find(node=>node.dataset.libraryEdit).emit('click');assert.deepEqual(opened,['legacy-row-4']);
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
      if(kind==='technical'){assert.doesNotMatch(content,/Source table notes|Underlying shared table condition|Source option alignment|Internal option mapping/);assert.match(content,/Source information/);assert.equal(nodes.find(node=>node.tagName==='a'&&node.href.includes('documents/')).href,'/api/libraries/documents/synthetic-document.pdf#page=12');}
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
  console.log(`${passed} library UI regression checks passed.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
