"use strict";

// OCR layers are bounded local presentation caches, never source-PDF edits or
// takeoff quantities. Every restored word is validated against its source key.
(function(root) {
  const LIMITS=Object.freeze({pages:512,bytes:32*1024*1024,recordBytes:2*1024*1024,words:20000});
  const DB_NAME="ceasefire-pdf-ocr-layers-v1", STORE="pages";
  const S=()=>typeof module==="object"&&module.exports?require("./takeoff-search.js"):root.CeasefireTakeoffSearch;
  function uiText(element,source){if(root?.CeasefireI18n)root.CeasefireI18n.text(element,source);else element.textContent=source;return element;}
  function uiAttr(element,name,source){if(root?.CeasefireI18n)root.CeasefireI18n.attr(element,name,source);else element.setAttribute(name,source);}
  const validSha=value=>typeof value==="string"&&/^[a-f0-9]{64}$/u.test(value);
  const finite=value=>typeof value==="number"&&Number.isFinite(value)&&Math.abs(value)<=10000000;
  function validPage(value){return Number.isSafeInteger(value)&&value>0&&value<=100000;}
  function validateResult(value,{sha256=value?.sha256,pageNumber=value?.page}={}) {
    if(!value||!validSha(sha256)||!validPage(pageNumber)||value.sha256!==sha256||value.page!==pageNumber||value.version!==1||value.source!=="local-ocr"||value.engine!==S().OCR_VERSION)throw new Error("The saved OCR layer does not match this original PDF page.");
    const options=S().ocrOptions(value.options),words=value.words;
    if(!Array.isArray(words)||words.length>LIMITS.words||!Number.isInteger(value.width)||!Number.isInteger(value.height)||value.width<=0||value.height<=0||value.width>6000||value.height>6000||value.width*value.height>18000000||!Array.isArray(value.transform)||value.transform.length!==6||!value.transform.every(finite)||!finite(value.scale)||value.scale<=0||value.scale>2)throw new Error("The saved OCR layer exceeds its supported geometry limits.");
    if(Math.abs(value.transform[0]*value.transform[3]-value.transform[1]*value.transform[2])<1e-12)throw new Error("The saved OCR layer has a singular source transform.");
    if(value.skewCorrectionDegrees!==undefined&&(!finite(value.skewCorrectionDegrees)||Math.abs(value.skewCorrectionDegrees)>5)||value.embeddedImagesSkipped!==undefined&&(!Number.isInteger(value.embeddedImagesSkipped)||value.embeddedImagesSkipped<0||value.embeddedImagesSkipped>4096))throw new Error("The saved OCR preprocessing metadata is invalid.");
    const result={version:1,source:"local-ocr",engine:S().OCR_VERSION,sha256,page:pageNumber,width:value.width,height:value.height,transform:[...value.transform],scale:value.scale,options:{...options},skewCorrectionDegrees:value.skewCorrectionDegrees||0,embeddedImagesSkipped:value.embeddedImagesSkipped||0,partial:value.partial===true,partialReasons:[],limitedResolution:value.limitedResolution===true,words:[]};
    let characters=0;
    for(const word of words){
      if(!word||typeof word.text!=="string"||!word.text.trim()||word.text.length>200||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(word.text)||!finite(word.confidence)||word.confidence<35||word.confidence>100||!Array.isArray(word.quad)||word.quad.length!==4||word.quad.some(point=>!Array.isArray(point)||point.length!==2||!point.every(finite))||!Array.isArray(word.box)||word.box.length!==4||!word.box.every(finite)||word.box[2]<=word.box[0]||word.box[3]<=word.box[1]||!Number.isSafeInteger(word.line)||word.line<1||![0,90,180,270].includes(word.rotation||0))throw new Error("A saved OCR word has invalid text or geometry.");
      const rendered=word.quad.map(point=>transform(point,value.transform)),bounds=[Math.min(...rendered.map(p=>p[0])),Math.min(...rendered.map(p=>p[1])),Math.max(...rendered.map(p=>p[0])),Math.max(...rendered.map(p=>p[1]))];
      // Deskew may move a tile corner slightly beyond its unrotated page.
      // Restored geometry must still describe that bounded original raster.
      const margin=2+S().OCR_LIMITS.tile*Math.abs(Math.sin((value.skewCorrectionDegrees||0)*Math.PI/180)),u=[rendered[1][0]-rendered[0][0],rendered[1][1]-rendered[0][1]],v=[rendered[3][0]-rendered[0][0],rendered[3][1]-rendered[0][1]];
      if(bounds.some((n,i)=>Math.abs(n-word.box[i])>.01)||bounds[0]<-margin||bounds[1]<-margin||bounds[2]>value.width+margin||bounds[3]>value.height+margin||Math.abs(u[0]*v[1]-u[1]*v[0])<1e-5||Math.abs(u[0]*v[0]+u[1]*v[1])>Math.max(.01,Math.hypot(...u)*Math.hypot(...v)*1e-5)||Math.hypot(rendered[0][0]+rendered[2][0]-rendered[1][0]-rendered[3][0],rendered[0][1]+rendered[2][1]-rendered[1][1]-rendered[3][1])>.01)throw new Error("A saved OCR word is inconsistent with its original rendered page.");
      characters+=word.text.length;if(characters>400000)throw new Error("The saved OCR text exceeds its supported limit.");
      const item={text:word.text,confidence:word.confidence,quad:word.quad.map(point=>[...point]),box:[...word.box],line:word.line,rotation:word.rotation||0};
      if(Array.isArray(word.readingBox)&&word.readingBox.length===4&&word.readingBox.every(finite))item.readingBox=[...word.readingBox];
      result.words.push(item);
    }
    if(Array.isArray(value.partialReasons))result.partialReasons=value.partialReasons.filter(text=>typeof text==="string").slice(0,8).map(text=>text.slice(0,500));
    if(new TextEncoder().encode(JSON.stringify(result)).length>LIMITS.recordBytes)throw new Error("This OCR page is too large to retain locally. Narrow the page range.");
    return result;
  }
  function sourceKey(sha256,pageNumber){if(!validSha(sha256)||!validPage(pageNumber))throw new Error("Choose a retained original PDF page.");return sha256+":"+pageNumber;}
  function recordKey(result){return S().OCR_VERSION+":"+sourceKey(result.sha256,result.page)+":"+JSON.stringify(S().ocrOptions(result.options));}
  function createStore(dependencies={}) {
    const indexedDB=dependencies.indexedDB===undefined?root?.indexedDB:dependencies.indexedDB;
    const timeoutMs=Number.isInteger(dependencies.timeoutMs)&&dependencies.timeoutMs>0?Math.min(5000,dependencies.timeoutMs):5000;
    const memory=new Map();let database=null,unavailable=!indexedDB;
    function remember(record){memory.delete(record.id);memory.set(record.id,record);let bytes=[...memory.values()].reduce((total,value)=>total+value.bytes,0);while(memory.size>LIMITS.pages||bytes>LIMITS.bytes){const first=memory.keys().next().value;bytes-=memory.get(first).bytes;memory.delete(first);}}
    function open(){
      if(unavailable)return Promise.resolve(null);
      if(database)return database;
      database=new Promise(resolve=>{let settled=false;const finish=value=>{if(settled){value?.close?.();return;}settled=true;clearTimeout(timer);resolve(value);};const timer=setTimeout(()=>{unavailable=true;finish(null);},timeoutMs);let request;
        try{request=indexedDB.open(DB_NAME,1);}catch{unavailable=true;finish(null);return;}
        request.onupgradeneeded=()=>{const db=request.result,store=db.createObjectStore(STORE,{keyPath:"id"});store.createIndex("sourcePage","sourcePage");};
        request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();database=null;};finish(db);};
        request.onerror=request.onblocked=()=>{unavailable=true;finish(null);};
      });return database;
    }
    async function read(sourcePage){
      const db=await open();if(!db)return[];
      return new Promise(resolve=>{let rows=[],settled=false;let transaction;const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};const timer=setTimeout(()=>{try{transaction?.abort();}catch{}finish([]);},timeoutMs);try{transaction=db.transaction(STORE,"readonly");const cursor=transaction.objectStore(STORE).index("sourcePage").openCursor(sourcePage);cursor.onsuccess=()=>{const value=cursor.result;if(value&&rows.length<64){rows.push(value.value);value.continue();}};transaction.oncomplete=()=>finish(rows);transaction.onerror=transaction.onabort=()=>finish([]);}catch{finish([]);}});
    }
    async function get({sha256,pageNumber,options}={}){
      const sourcePage=sourceKey(sha256,pageNumber),wanted=options?JSON.stringify(S().ocrOptions(options)):null;
      const rows=[...memory.values()].filter(record=>record.sourcePage===sourcePage),persisted=await read(sourcePage);
      for(const record of persisted){try{const result=validateResult(record.result,{sha256,pageNumber});if(record.id!==recordKey(result)||record.sourcePage!==sourcePage||!Number.isSafeInteger(record.updated)||record.updated<0||!Number.isSafeInteger(record.bytes)||record.bytes<=0||record.bytes>LIMITS.recordBytes)continue;const safe={...record,result};remember(safe);rows.push(safe);}catch{/* Invalid or obsolete cache records are not displayed. */}}
      const matches=rows.filter(record=>!wanted||JSON.stringify(record.result.options)===wanted).sort((a,b)=>b.updated-a.updated);
      if(!matches.length)return null;try{return validateResult(matches[0].result,{sha256,pageNumber});}catch{return null;}
    }
    async function put(value){
      const result=validateResult(value),record={id:recordKey(result),sourcePage:sourceKey(result.sha256,result.page),updated:Date.now(),bytes:new TextEncoder().encode(JSON.stringify(result)).length,result};remember(record);
      const db=await open();if(!db)return{result,persistent:false};
      const persistent=await new Promise(resolve=>{let transaction,settled=false;const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};const timer=setTimeout(()=>{try{transaction?.abort();}catch{}finish(null);},timeoutMs);try{transaction=db.transaction(STORE,"readwrite");const store=transaction.objectStore(STORE);store.put(record);const rows=[];let count=0;const cursor=store.openCursor();cursor.onsuccess=()=>{const item=cursor.result;if(!item)return;count++;if(count>1024){item.delete();item.continue();return;}const candidate=item.value;rows.push({id:item.key,updated:Number(candidate.updated)||0,bytes:Number(candidate.bytes)||LIMITS.recordBytes});item.continue();};transaction.oncomplete=()=>finish(rows);transaction.onabort=transaction.onerror=()=>finish(null);}catch{finish(null);}});
      if(!persistent)return{result,persistent:false};
      // Prune only this rebuildable cache, newest first, with a bounded metadata
      // list. The active result remains in memory if browser storage is full.
      const rows=persistent.sort((a,b)=>b.updated-a.updated);let bytes=0,kept=0;const remove=[];
      for(const row of rows){bytes+=row.bytes;kept++;if(kept>LIMITS.pages||bytes>LIMITS.bytes)remove.push(row.id);}
      if(remove.length)await new Promise(resolve=>{let tx,settled=false;const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);resolve();};const timer=setTimeout(()=>{try{tx?.abort();}catch{}finish();},timeoutMs);try{tx=db.transaction(STORE,"readwrite");for(const id of remove)tx.objectStore(STORE).delete(id);tx.oncomplete=tx.onabort=tx.onerror=finish;}catch{finish();}});
      return{result,persistent:true};
    }
    return Object.freeze({get,put,get persistent(){return !unavailable;}});
  }
  function transform(point,t){return[point[0]*t[0]+point[1]*t[2]+t[4],point[0]*t[1]+point[1]*t[3]+t[5]];}
  function nativeOverlap(word,items){const centre=[word.quad.reduce((sum,p)=>sum+p[0],0)/4,word.quad.reduce((sum,p)=>sum+p[1],0)/4];return items.some(item=>{const q=S().runQuad(item);if(!q)return false;const xs=q.map(p=>p[0]),ys=q.map(p=>p[1]);return centre[0]>=Math.min(...xs)&&centre[0]<=Math.max(...xs)&&centre[1]>=Math.min(...ys)&&centre[1]<=Math.max(...ys);});}
  function positionLayer(layer,result,context){
    layer.style.width=context.viewport.width+"px";layer.style.height=context.viewport.height+"px";
    for(const span of layer.children){const word=result.words[Number(span.dataset.ocrWordIndex)];if(!word)continue;const q=word.quad.map(p=>transform(p,context.viewport.transform)),width=Number(span.dataset.ocrMeasure);span.style.transform=`matrix(${(q[1][0]-q[0][0])/width},${(q[1][1]-q[0][1])/width},${q[3][0]-q[0][0]},${q[3][1]-q[0][1]},${q[0][0]},${q[0][1]})`;}
  }
  function renderLayer(result,context,nativeItems=[]){
    if(!root?.document||!context?.host||!context.viewport)return null;
    const layer=root.document.createElement("div");layer.className="takeoff-ocr-text-layer";uiAttr(layer,"aria-label","Recognized PDF text (OCR)");layer.dataset.ocrSource=result.sha256;layer.dataset.ocrPage=String(result.page);layer.dataset.ocrPartial=String(result.partial);layer.style.width=context.viewport.width+"px";layer.style.height=context.viewport.height+"px";
    const measure=root.document.createElement("canvas").getContext("2d");measure.font="1px Arial";
    for(let index=0;index<result.words.length;index++){const word=result.words[index];if(nativeOverlap(word,nativeItems))continue;const span=root.document.createElement("span"),width=Math.max(.01,measure.measureText(word.text).width);span.textContent=word.text+" ";span.dataset.ocrMeasure=String(width);span.dataset.ocrWordIndex=String(index);span.dataset.ocrConfidence=String(Math.round(word.confidence));layer.append(span);}
    positionLayer(layer,result,context);context.host.append(layer);return layer;
  }
  function create(dependencies={}){
    const getContext=dependencies.getContext||(()=>null),getPages=dependencies.getPages||(()=>[]),progress=dependencies.setProgress||(()=>{}),store=dependencies.store||createStore();
    let options=S().ocrOptions(),dialog=null,controls={},manager=null,active=null,generation=0,renderGeneration=0,layer=null,layerContent="",layerResult=null;
    try{const saved=root.localStorage?.getItem("ceasefire-ocr-options-v1");if(saved)options=S().ocrOptions(JSON.parse(saved));}catch{/* Optional local preferences never prevent OCR. */}
    const current=()=>getContext();
    function clearLayer(){renderGeneration++;layer?.remove();layer=null;layerContent="";layerResult=null;}
    function reposition(context=current()){
      if(!layer||!layerResult)return;
      if(!context?.viewport||layer.parentElement!==context.host||layerResult.sha256!==context.sha256||layerResult.page!==context.pageNumber||!Array.isArray(context.viewport.transform)||!context.viewport.transform.every(finite)){clearLayer();return;}
      positionLayer(layer,layerResult,context);
    }
    function cancel(){generation++;active?.abort();active=null;manager?.cancel();if(controls.run)controls.run.disabled=false;if(controls.stop)controls.stop.disabled=true;}
    async function render(){
      const id=++renderGeneration,context=current();if(!context?.host||!context.viewport||!validSha(context.sha256)||!validPage(context.pageNumber)){clearLayer();return;}
      if(layer&&(layer.parentElement!==context.host||layer.dataset.ocrSource!==context.sha256||layer.dataset.ocrPage!==String(context.pageNumber))){layer.remove();layer=null;layerContent="";layerResult=null;}
      const retained=await store.get({sha256:context.sha256,pageNumber:context.pageNumber});
      if(!retained||id!==renderGeneration||current()?.sessionId!==context.sessionId||current()?.documentId!==context.documentId||current()?.pageNumber!==context.pageNumber||current()?.viewport!==context.viewport)return;
      let native=[];try{native=(await context.sourcePage?.getTextContent())?.items||[];}catch{/* An independently recognized raster layer can still be selected. */}
      if(id!==renderGeneration||current()?.host!==context.host||current()?.viewport!==context.viewport)return;
      const content=JSON.stringify(retained.words);
      layerResult=retained;
      if(layer&&layerContent===content){positionLayer(layer,retained,context);return;}
      layer?.remove();layer=renderLayer(retained,context,native);layerContent=content;
    }
    async function retain(result){const retained=await store.put(result);const context=current();if(context?.sha256===result.sha256&&context?.pageNumber===result.page)await render();return retained;}
    function node(tag,text){const value=root.document.createElement(tag);if(text)uiText(value,text);return value;}
    function choice(label,items,value){const wrapper=node("label"),title=node("span",label),select=node("select");uiAttr(select,"aria-label",label);for(const[key,text]of items){const option=node("option",text);option.value=key;select.append(option);}select.value=value;wrapper.append(title,select);controls[label]=select;return wrapper;}
    function check(label,key){const wrapper=node("label"),input=node("input");input.type="checkbox";input.checked=options[key];controls[key]=input;wrapper.className="takeoff-ocr-check";wrapper.append(input,node("span",label));return wrapper;}
    function announce(text){if(controls.status)uiText(controls.status,text);progress(text);}
    async function run(){
      cancel();const start=current();if(!start?.sha256)throw new Error("Open an original PDF before recognizing text.");
      options=S().ocrOptions({language:controls.Language.value,documentType:controls["Document type"].value,quality:controls["Optimize for"].value,correctSkew:controls.correctSkew.checked,detectOrientation:controls.detectOrientation.checked,detectVertical:controls.detectVertical.checked,detectGraphics:controls.detectGraphics.checked});
      try{root.localStorage?.setItem("ceasefire-ocr-options-v1",JSON.stringify(options));}catch{/* Persistence is optional. */}
      const id=generation,controller=active=new AbortController();controls.run.disabled=true;controls.stop.disabled=false;let complete=0,partial=0,failed=0,persistent=true;
      try{
        const available=await getPages(controls.Pages.value);if(!Array.isArray(available)||!available.length||available.length>10000)throw new Error("Choose a supported page range to recognize.");
        const first=Number(controls.first.value),last=controls.last.value.trim()?Number(controls.last.value):100000;
        if(!validPage(first)||!validPage(last)||first>last)throw new Error("Enter a valid first and last page.");
        const all=available.filter(job=>controls.Pages.value==="page"||job.pageNumber>=first&&job.pageNumber<=last),jobs=[];
        let skipped=0,more=false;
        for(const job of all){
          if(id!==generation||controller.signal.aborted)throw new Error("OCR stopped.");
          const cached=controls.reprocess.checked?null:await store.get({sha256:job.sha256,pageNumber:job.pageNumber,options});
          if(cached&&!cached.partial){skipped++;continue;}
          if(jobs.length>=S().OCR_LIMITS.pages){more=true;break;}jobs.push(job);
        }
        if(!jobs.length){await render();announce(all.length?`This range already has retained text (${skipped} pages). Choose Reprocess to recognize it again.`:"No pages are in that range.");return;}
        const budget=S().createOcrBudget();manager||=S().createOcrSearch();
        for(const job of jobs){
          if(id!==generation||controller.signal.aborted||current()?.sessionId!==start.sessionId)throw new Error("OCR stopped.");
          if(!validSha(job.sha256)||!validPage(job.pageNumber))throw new Error("The original PDF page identity changed.");
          announce(`Recognizing text: page ${job.pageNumber} · ${complete+partial+failed}/${jobs.length} finished…`);
          try{const page=job.sourcePage||await job.load();if(page.pageNumber!==job.pageNumber)throw new Error("The original PDF page changed.");const content=await page.getTextContent();
            const result=await manager.recognizePage(page,{sha256:job.sha256,items:content.items,options,refresh:controls.reprocess.checked,signal:controller.signal,budget,onProgress:value=>{if(id===generation&&value?.status)announce(`Recognizing page ${job.pageNumber}: ${value.status}${Number.isFinite(value.progress)?" "+Math.round(value.progress*100)+"%":""}`);}});
            if(id!==generation||controller.signal.aborted||current()?.sessionId!==start.sessionId)throw new Error("OCR stopped.");
            const saved=await retain(result);if(id!==generation||controller.signal.aborted)throw new Error("OCR stopped.");persistent&&=saved.persistent;result.partial?partial++:complete++;await dependencies.onResult?.(result,job);
          }catch(error){if(controller.signal.aborted||id!==generation)throw error;failed++;announce(`Page ${job.pageNumber}: ${error.message||"Recognition failed."}`);if(["OcrLimitError","OcrTimeoutError"].includes(error.name))break;}
        }
        if(id===generation){
          const unfinished=more||partial>0||failed>0||complete+partial+failed<jobs.length;
          if(controls.Pages.value==="document"&&complete===jobs.length&&more)controls.first.value=String(jobs.at(-1).pageNumber+1);
          announce(`OCR finished: ${complete} complete, ${partial} partial, ${failed} failed; ${skipped} already recognized. ${unfinished?"More pages remain. Recognize text again to continue the next bounded batch, or choose a page range. ":""}${persistent?"Text retained locally in this browser.":"Browser storage unavailable; text remains available for this session."} Use Select text to copy or Ctrl+F to search. Original PDF unchanged.`);
        }
      }catch(error){if(id===generation)announce(error.message||"OCR could not finish.");}
      finally{if(id===generation){active=null;controls.run.disabled=false;controls.stop.disabled=true;}}
    }
    function open(){
      if(!root?.document)return;if(dialog?.open){dialog.focus();return;}
      dialog?.remove();dialog=node("dialog");dialog.className="takeoff-ocr-dialog";dialog.setAttribute("aria-labelledby","takeoff-ocr-title");const title=node("h2","Recognize PDF text");title.id="takeoff-ocr-title";dialog.append(title,node("p","Create a searchable, selectable text layer in this browser. Recognition stays on this computer; the original PDF is unchanged."));
      const form=node("div");form.className="takeoff-ocr-options";
      form.append(choice("Pages",[["page","Current page"],["document","Current document (up to 8 pages per batch)"]],"page"),choice("Language",Object.entries(S().OCR_LANGUAGES),options.language),choice("Document type",[["cad","CAD drawing"],["text","Text document"]],options.documentType),choice("Optimize for",[["accuracy","Accuracy"],["speed","Speed"]],options.quality));
      for(const[key,label,value]of[["first","First page (document range)","1"],["last","Last page (blank = end)",""]]){const wrapper=node("label");const input=controls[key]=node("input");input.type="number";input.min="1";input.max="100000";input.step="1";input.value=value;wrapper.append(node("span",label),input);form.append(wrapper);}
      form.append(check("Correct small scan skew", "correctSkew"),check("Detect page orientation", "detectOrientation"),check("Detect vertical text", "detectVertical"),check("Detect text in pictures and drawings", "detectGraphics"));
      const reprocess=node("label"),reprocessInput=controls.reprocess=node("input");reprocessInput.type="checkbox";reprocess.className="takeoff-ocr-check";reprocess.append(reprocessInput,node("span","Reprocess already recognized pages"));form.append(reprocess);
      dialog.append(form);const note=node("p","Accuracy uses a higher resolution. Turn off picture detection to skip smaller embedded images; full-page scans are still processed. OCR readings can contain mistakes—check the drawing.");note.className="helper";dialog.append(note);
      const status=controls.status=node("p","Ready." );status.setAttribute("role","status");dialog.append(status);const actions=node("div");actions.className="actions";
      const button=(label,callback)=>{const item=node("button",label);item.type="button";item.className="button secondary";item.addEventListener("click",callback);return item;};controls.run=button("Recognize text",()=>void run().catch(error=>announce(error.message)));controls.stop=button("Stop",()=>{cancel();announce("OCR stopped. Previously retained text is still available.");});controls.stop.disabled=true;actions.append(controls.run,controls.stop,button("Close",()=>{cancel();dialog.close();}));dialog.append(actions);dialog.addEventListener("cancel",()=>{cancel();});root.document.body.append(dialog);dialog.showModal();
    }
    function close(){cancel();clearLayer();dialog?.close();dialog?.remove();dialog=null;manager?.dispose();manager=null;}
    root?.addEventListener?.("pagehide",close);
    return Object.freeze({open,cancel,render,reposition,retain,getCached:args=>store.get(args),clearLayer,close,get options(){return options;}});
  }
  const api=Object.freeze({create,createStore,validateResult,recordKey,sourceKey,renderLayer,nativeOverlap,LIMITS});
  if(typeof module==="object"&&module.exports)module.exports=api;else root.CeasefireTakeoffOcrLayer=api;
})(typeof window==="object"?window:null);
