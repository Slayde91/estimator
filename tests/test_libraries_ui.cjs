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
    assert.equal(pane.refresh.children[0].textContent,'↻');assert.equal(pane.refresh.getAttribute('aria-label'),'Refresh');assert.equal(pane.refresh.title,'Refresh');
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
    const sourceCard=nodes.find(node=>node.className==='library-source');assert.deepEqual(sourceCard.children,[pdf]);assert.equal(pdf.textContent,'Synthetic source reference');assert.ok(pdf.getAttribute('aria-label').includes(pdf.textContent));assert.equal(walk(sourceCard).filter(node=>['dl','dt','dd','button'].includes(node.tagName)).length,0);assert.doesNotMatch(text(sourceCard),/Open PDF|synthetic\.pdf|Synthetic sheet/);
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
    await h.api.open('penetration');const pane=h.pane('penetration');const add=walk(pane.results).find(node=>node.dataset.libraryAdd),link=walk(pane.results).find(node=>node.dataset.libraryLink);assert.ok(link);assert.equal(link.getAttribute('aria-label'),'Link Library Item');assert.equal(link.textContent,'');assert.match(add.className,/penetration-add-action/);assert.equal(add.getAttribute('aria-label'),'Add to Schedule');assert.equal(add.children[0].textContent,'+');assert.equal(add.children[0].getAttribute('aria-hidden'),'true');assert.match(add.children[1].className,/sr-only/);const work=add.emit('click');await flush();assert.equal(add.disabled,true);await add.emit('click');assert.deepEqual(ids,['penetration-1']);pending.reject(new Error('Keep the invalid schedule value until corrected.'));await work;
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
    await h.api.open('penetration');const pane=h.pane('penetration'),remove=walk(pane.results).find(node=>node.dataset.libraryDelete==='penetration-1');assert.ok(remove);assert.match(remove.title,/Remove FL-ID-001/);assert.equal(remove.getAttribute('aria-label'),remove.title);assert.equal(walk(remove).find(node=>node.className==='library-trash-icon').textContent,'🗑');
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
    await h.api.open('penetration');const pane=h.pane('penetration');await walk(pane.results).find(node=>node.dataset.libraryLink).emit('click');await flush();const session=pane.linkSession,choice=walk(session.results).find(node=>node.dataset.libraryLinkChoice);choice.checked=true;await choice.emit('change');await session.save.emit('click');assert.equal(pane.linkSession,session);assert.deepEqual([...session.selected],['technical-1']);assert.equal(session.save.disabled,false);assert.match(session.message.textContent,/not confirmed.*Target is unavailable.*Retry to check the same links/);
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
  console.log(`${passed} library UI regression checks passed.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
