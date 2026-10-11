"use strict";

// The workspace owns session guards and selection. This bridge keeps visual
// markup behaviour outside the calibrated item/transfer model.
window.CeasefireTakeoffGraphicsUI = function (host) {
  const { state, G, X, node, svg, button, clone, snapshot, documents, pageMetadata, currentDocument, pageDisplayKey, signatureMode, signatureInWorkspace, selectedSignature, selectedAnnotation, command, safely, message, renderSelection, renderOverlay, flushSettings, requireFinishedEdits, cancelTrace, setTool, ask, drawingPoint, drawingClickOpensSettings, bindSetting, appearanceField, currentVisibilityControl, renderPhysicalDetails, renderViewportPanel } = host;
  const records = () => snapshot()?.graphics?.records || [];
  const selected = () => records().find(value => value.id === state.graphicSelected && signatureInWorkspace(value) && value.document_id === state.document && value.page === state.page);
  const key = () => JSON.stringify([pageDisplayKey(), signatureMode(), selected()?.id]);
  const isTool = () => state.tool.startsWith("graphic-");
  let activationGeneration = 0, stampGeneration = 0, stampPending = false, stampReleaseClick = null;
  const stampKey = () => JSON.stringify([state.session?.session_id,state.document,currentDocument()?.sha256,state.page,signatureMode()]);
  function hasStampTemplate() {
    if (state.stampTemplate && state.stampTemplate.key !== stampKey()) state.stampTemplate = null;
    return !!state.stampTemplate;
  }
  function cancel(forgetTemplate = true) {
    stampGeneration++;
    stampReleaseClick?.clear();
    if (state.gesture?.kind === "stamp-box") { const gesture = state.gesture; gesture.cleanup(); state.gesture = null; state.points = []; state.traceCursor = null; }
    if (forgetTemplate) state.stampTemplate = null;
  }
  function suppressStampReleaseClick(pointerId) {
    stampReleaseClick?.clear();
    const element = state.ui.viewport;
    // Consume only the click produced by this drag release. A new pointerdown
    // starts a genuine click, even when it follows the drag immediately.
    const pending = { clear() {
      element.removeEventListener("click",click,true);
      element.removeEventListener("pointerdown",clear,true);
      if(stampReleaseClick === pending) stampReleaseClick = null;
    } };
    const clear = () => pending.clear();
    const click = event => {
      if(event.button !== 0 || !(event.detail > 0) || (event.pointerId !== undefined && event.pointerId !== pointerId)) return;
      pending.clear(); event.preventDefault(); event.stopImmediatePropagation();
    };
    stampReleaseClick = pending;
    element.addEventListener("click",click,true);
    element.addEventListener("pointerdown",clear,true);
  }
  const activationKey = () => JSON.stringify([pageDisplayKey(), signatureMode(), state.session?.revision, currentDocument()?.sha256, state.active, state.tool, state.graphicSelected, state.annotationSelected, state.signatureSelected, state.legendSelected, [...state.selected], [...state.countSelection], [...state.physicalSelected], state.physicalDetailsOpen, state.settingsOpen, state.viewportsOpen, state.calibrationTarget, state.retraceId, state.exclusionItemId, state.pendingViewport, state.signatureDraft]);
  async function activate(kind) {
    const generation = ++activationGeneration;
    if (!X.kinds.includes(kind)) throw new Error("Choose a supported PDF markup tool.");
    if (state.tool === `graphic-${kind}` && !state.busy && !state.modal && !state.navigationBusy) { if(kind==="stamp")cancel(true); cancelTrace(); renderSelection(); message(`${X.labels[kind]} cancelled.`); return; }
    await flushSettings();
    if (generation !== activationGeneration) throw new Error("A newer PDF markup tool was selected.");
    requireFinishedEdits();
    if (!state.viewport || !currentDocument()) throw new Error("Open a PDF page before adding a markup.");
    const context = activationKey();
    await Promise.all([document.fonts.load("12px CeasefireDrawing"), document.fonts.load("700 12px CeasefireDrawing")]);
    if (generation !== activationGeneration || context !== activationKey() || state.busy || state.modal || state.navigationBusy || !state.viewport) throw new Error("The drawing changed while loading the markup font. Select the tool again.");
    requireFinishedEdits();
    cancelTrace(); state.settingsOpen = false; state.settingsEditor = null; state.graphicSelected = null; state.selected.clear(); state.annotationSelected = null; state.signatureSelected = null;
    setTool(`graphic-${kind}`); renderSelection();
    message(kind === "stamp" ? hasStampTemplate() ? "Stamp: click to place another copy. Right-click or select Stamp again to stop." : "Stamp: drag a box, then choose text or a PNG/JPEG image. Right-click cancels." : X.boxes.has(kind) ? `${X.labels[kind]}: click two opposite corners. Escape cancels.` : `${X.labels[kind]}: click each point, then press Enter or double-click to finish. Escape cancels.`);
  }
  function beginStampBox(event) {
    if (state.tool !== "graphic-stamp" || hasStampTemplate() || stampPending || event.button !== 0 || state.busy || state.modal || state.navigationBusy || state.gesture || state.points.length || state.formDirty || state.settingsDirty || !state.viewport) return false;
    const first = drawingPoint(event), view = pageMetadata()?.view;
    if (!view || first.some((n,axis) => n < view[axis] || n > view[axis+2])) return false;
    requireFinishedEdits();
    event.preventDefault(); event.stopImmediatePropagation();
    const element = state.ui.viewport, context = stampKey(), revision = state.session.revision, transform = JSON.stringify(state.viewport.transform);
    const gesture = {kind:"stamp-box",moved:false}; state.gesture = gesture; state.points = [first]; state.traceCursor = null;
    const valid = () => state.gesture === gesture && state.tool === "graphic-stamp" && context === stampKey() && revision === state.session?.revision && transform === JSON.stringify(state.viewport?.transform);
    const move = next => {
      if (next.pointerId !== event.pointerId || !valid()) return;
      const point = drawingPoint(next);
      if (point.some((n,axis) => n < view[axis] || n > view[axis+2])) return;
      if (Math.hypot(next.clientX-event.clientX,next.clientY-event.clientY) >= 4) gesture.moved = true;
      state.traceCursor = point; next.preventDefault(); renderOverlay(); window.CeasefireProject?.changed?.();
    };
    const cleanup = gesture.cleanup = () => { element.removeEventListener("pointermove",move); element.removeEventListener("pointerup",release); element.removeEventListener("pointercancel",abort); element.removeEventListener("lostpointercapture",abort); if(element.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId); };
    const abort = () => { const current = state.gesture === gesture; cleanup(); if(current) { state.gesture=null; state.points=[]; state.traceCursor=null; renderOverlay(); window.CeasefireProject?.changed?.(); } };
    const release = next => {
      if(next.pointerId !== event.pointerId) return;
      move(next); const current=valid(), last=state.traceCursor, owned=state.gesture===gesture;
      if(owned)state.gesture=null; cleanup();
      if(!current) { if(owned && state.points.length===1 && state.points[0]===first){state.points=[];state.traceCursor=null;renderOverlay();}return; }
      suppressStampReleaseClick(event.pointerId);
      if(gesture.moved && last) { state.points=[first,last]; state.traceCursor=null; void safely(finish); }
      else { state.points=[]; state.traceCursor=null; renderOverlay(); }
    };
    element.addEventListener("pointermove",move); element.addEventListener("pointerup",release); element.addEventListener("pointercancel",abort); element.addEventListener("lostpointercapture",abort); element.setPointerCapture?.(event.pointerId); renderOverlay(); window.CeasefireProject?.changed?.();
    return true;
  }
  async function chooseStamp() {
    let image = null, imageGeneration = 0;
    const answer = await ask("Stamp", [["stamp_type","Stamp type",[["text","Text"],["image","Image"]],"text",true],["text","Stamp text","text","",false],["stamp_file","Stamp image (PNG or JPEG)","text","",false]], "Configure this stamp once, then click to place copies. It is a PDF drawing mark only.", "Create stamp", (controls,ready) => {
      const [type,text,file]=controls, status=node("p","helper"); file.control.type="file";file.control.accept="image/png,image/jpeg"; text.control.maxLength=80; file.wrapper.append(status);
      const refresh=()=>{ const usingImage=type.control.value==="image"; text.wrapper.hidden=usingImage;file.wrapper.hidden=!usingImage;text.control.required=!usingImage;file.control.required=usingImage;ready(usingImage?!!image:!!text.control.value.trim()); };
      type.control.addEventListener("change",refresh);text.control.addEventListener("input",refresh);
      file.control.addEventListener("change",()=>{ const generation=++imageGeneration;image=null;status.textContent="";refresh();const chosen=file.control.files?.[0];if(!chosen)return;status.textContent="Checking image…";
        void X.stampImage(chosen).then(value=>{if(generation!==imageGeneration)return;image=value;status.textContent="Image ready.";refresh();}).catch(error=>{if(generation!==imageGeneration)return;image=null;status.textContent=error.message;refresh();}); });
      refresh();
    });
    if (!answer) return null;
    if (answer.stamp_type === "image") { if(!image) throw new Error("Choose a valid PNG or JPEG image.");return {text:"",stamp_image:image}; }
    if (!answer.text?.trim() || answer.text.length > 80 || /[\n\r\t]/.test(answer.text)) throw new Error("Enter nonblank Stamp text on one line, up to 80 characters.");
    return {text:answer.text};
  }
  async function placeStamp(point) {
    if (!hasStampTemplate() || stampPending) return;
    requireFinishedEdits();
    const template=state.stampTemplate, context=stampKey(), revision=state.session.revision, generation=stampGeneration;
    const geometry=X.stampAt(template.geometry,point,pageMetadata().view), graphic={mode:signatureMode(),document_id:state.document,source_sha256:currentDocument().sha256,page:state.page,kind:"stamp",geometry,text:template.text,appearance:clone(template.appearance),...(template.stamp_image?{stamp_image:clone(template.stamp_image)}:{})};
    stampPending=true;
    try {
      const reply=await command("create_graphic",{graphic},()=>generation===stampGeneration && context===stampKey() && revision===state.session?.revision && state.tool==="graphic-stamp" && state.stampTemplate===template);
      if(!reply) throw new Error("The drawing changed. Select Stamp again.");
      if(generation!==stampGeneration || context!==stampKey() || state.tool!=="graphic-stamp" || state.stampTemplate!==template) return;
      state.points=[];state.traceCursor=null;renderSelection();message("Stamp placed. Click for another copy; right-click or select Stamp again to stop.");
    } finally { stampPending=false; }
  }
  async function point(event) {
    if (!isTool() || state.busy || state.modal || state.navigationBusy || state.gesture || stampPending || state.formDirty || state.settingsDirty || !state.viewport || event.button !== 0 || Date.now() < (state.suppressSelectionClickUntil || 0)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if(state.tool === "graphic-stamp" && hasStampTemplate()) { await placeStamp(drawingPoint(event)); return; }
    if (event.detail > 1) { if (state.points.length > 1) await finish(); return; }
    const p = drawingPoint(event), view = pageMetadata()?.view;
    if (!view || p.some((value,axis) => value < view[axis] || value > view[axis+2])) return;
    if (state.points.length >= 1000) throw new Error("A PDF markup supports at most 1,000 points. Finish or cancel it.");
    if (state.points.length && Math.hypot(...p.map((value,axis)=>value-state.points.at(-1)[axis])) < 1e-8) return;
    state.points.push(p); state.traceCursor = null; renderOverlay(); window.CeasefireProject?.changed?.();
    const kind = state.tool.slice(8);
    if (state.points.length === 2 && (X.boxes.has(kind) || kind === "arrow")) await finish();
  }
  async function finish() {
    if (state.formDirty || state.settingsDirty || state.gesture || state.physicalPlacing || state.physicalUI?.hasUnfinishedChanges()) throw new Error("Apply or discard unfinished item edits before finishing the markup.");
    if (!isTool() || state.points.length < 2) throw new Error("Choose at least two distinct PDF markup points.");
    const tool = state.tool, kind = tool.slice(8), context = pageDisplayKey(), mode = signatureMode(), revision = state.session.revision, points = clone(state.points), documentId=state.document, sourceSha=currentDocument().sha256, generation=stampGeneration;
    const geometry = X.boxes.has(kind) ? X.box(points, p=>G.transform(p,state.viewport.transform), p=>G.inverse(p,state.viewport.transform)) : {points};
    if (kind === "polygon" && points.length < 3) throw new Error("Choose at least three vertices for a polygon.");
    if (geometry.quad_pdf && [1,3].some(i=>Math.hypot(...geometry.quad_pdf[i].map((n,axis)=>n-geometry.quad_pdf[0][axis])) < 10)) throw new Error("Choose a larger rectangle (at least 10 PDF points on each side).");
    let text = "", stampContent=null;
    if(kind === "stamp") { stampContent=await chooseStamp();if(!stampContent){if(generation===stampGeneration && context===pageDisplayKey() && mode===signatureMode() && tool===state.tool)cancelTrace();return;}text=stampContent.text; }
    else if (kind === "textbox") {
      const answer = await ask(X.labels[kind], [["text","Textbox text","textarea","",true]], "This text is a drawing note.", "Place markup", controls=>{ controls[0].control.maxLength=4000; });
      if (!answer) { cancelTrace(); return; } text = answer.text;
    }
    const graphic = { mode, document_id: documentId, source_sha256: sourceSha, page: state.page, kind: kind === "polyline" && points.length === 2 ? "line" : kind, geometry, text, appearance: X.defaults(), ...(stampContent?.stamp_image?{stamp_image:stampContent.stamp_image}:{}) };
    const reply = await command("create_graphic", {graphic}, ()=>context === pageDisplayKey() && mode === signatureMode() && revision === state.session.revision && tool === state.tool && JSON.stringify(points) === JSON.stringify(state.points) && (kind !== "stamp" || generation===stampGeneration));
    if (!reply) throw new Error("The drawing changed. Place the markup again.");
    if(kind === "stamp") { if(generation!==stampGeneration || context!==pageDisplayKey() || mode!==signatureMode() || tool!==state.tool) return;const stored=records().find(value=>value.id===reply.created_graphic_id) || graphic;state.stampTemplate={key:stampKey(),geometry:clone(geometry),text:stored.text,appearance:clone(stored.appearance),...(stored.stamp_image?{stamp_image:clone(stored.stamp_image)}:{})};state.points=[];state.traceCursor=null;state.graphicSelected=null;renderSelection();message("Stamp placed. Click for another copy; right-click or select Stamp again to stop.");return; }
    cancelTrace(); await select(reply.created_graphic_id, true); message(`${X.labels[graphic.kind]} placed. Drag to move, resize its handles, or edit it in Settings.`);
  }
  async function select(id, openSettings = true) {
    if (state.tool !== "select" || state.busy || state.modal || state.gesture) return;
    await flushSettings(); requireFinishedEdits();
    if (!records().some(v=>v.id===id && signatureInWorkspace(v) && v.document_id===state.document && v.page===state.page)) throw new Error("Select a PDF markup on this page.");
    state.selected.clear(); state.countSelection.clear(); state.annotationSelected = null; state.signatureSelected = null; state.legendSelected = null; state.controlPoint = null; state.markupMenu = null;
    await state.physicalUI?.clearSelection?.(); state.physicalDetailsOpen = false; state.viewportsOpen = false;
    state.graphicSelected = id; state.settingsOpen = openSettings || state.settingsOpen; state.settingsEditor = null; renderPhysicalDetails(); renderViewportPanel(); renderSelection();
    if (!openSettings) state.ui.viewport.focus();
  }
  async function remove() {
    await flushSettings(); requireFinishedEdits(); const value = selected(); if (!value) return;
    await command("delete_graphic", {graphic_id:value.id}); state.graphicSelected=null; state.settingsEditor=null; renderSelection(); message("PDF markup deleted. Undo last edit restores it.");
  }
  function settings(panel) {
    const value = selected(); if (!value) return;
    const selectionKey = key(), prior = state.settingsEditor;
    if(prior?.kind === "graphic" && prior.key === selectionKey && (state.settingsDirty || prior.applying || prior.revision === state.session.revision)) { prior.visibility.refresh(); return; }
    if(prior) clearTimeout(prior.timer);
    const editor = {kind:"graphic", key:selectionKey, sessionId:state.session.session_id, revision:state.session.revision, id:value.id, touched:new Map(), appearance:[]}; state.settingsEditor=editor;
    const heading=node("div","takeoff-viewports-heading"), controls=node("div","takeoff-settings-fields"); heading.append(button("Close settings",host.toggleSettings),node("h3","",`${X.labels[value.kind]} Settings`)); panel.replaceChildren(heading,controls);
    const textAppearance = ["textbox","stamp"].includes(value.kind) && !value.stamp_image;
    const definitions = [["stroke_color","Line Colour","color"],["stroke_width","Line Width","number"],["fill_color","Fill Colour","color"],["fill_enabled","Fill Enabled","checkbox"],...(textAppearance ? [["font_color","Font Colour","color"]] : []),["opacity","Opacity","number"],...(textAppearance ? [["font_size","Font Size","number"]] : [])];
    for(const def of definitions) { const field=def[0] === "font_size" ? host.formField(def,value.appearance[def[0]]) : appearanceField(def,value.appearance[def[0]]); if(def[0] === "font_size") {field.control.min="4";field.control.max="144";} editor.appearance.push(field); bindSetting(editor,field,`appearance:${def[0]}`); controls.append(field.wrapper); }
    if(value.kind === "textbox") {
      const A=window.CeasefireTakeoffAnnotations, wrapper=node("div","field takeoff-graphic-text"), content=value.text_content || {version:1,blocks:[{kind:"paragraph",runs:[{text:value.text}]}]};
      editor.rich=A.richEditor(content,()=>host.markSettingsEdited(editor,"text"),{label:"Textbox text",maxLength:4000});
      wrapper.append(node("span","","Textbox text"),editor.rich.wrap); controls.append(wrapper);
    } else if(value.kind === "stamp" && !value.stamp_image) { const wrapper=node("label","field takeoff-graphic-text"), control=node("input"); control.name="text";control.value=value.text;control.maxLength=80;control.required=true;control.setAttribute("aria-label","Stamp text");wrapper.append(node("span","","Stamp text"),control);editor.text={control,read:()=>{if(!control.value.trim()) throw new Error("Enter nonblank markup text.");return control.value;}};bindSetting(editor,editor.text,"text");controls.append(wrapper); }
    else if(value.stamp_image) controls.append(node("p","helper",`Stamp image: ${value.stamp_image.width} × ${value.stamp_image.height} pixels.`));
    const actions=node("div","actions takeoff-appearance-actions"), removeButton=button("Delete markup",remove); removeButton.classList.add("takeoff-markup-delete");removeButton.title="Delete markup";removeButton.setAttribute("aria-label","Delete markup");
    const trash=svg("svg",{viewBox:"0 0 24 24",width:20,height:20,fill:"none",stroke:"currentColor","stroke-width":1.8,"stroke-linecap":"round","stroke-linejoin":"round","aria-hidden":"true"});trash.append(svg("path",{d:"M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"}));removeButton.replaceChildren(trash);
    editor.visibility=currentVisibilityControl("graphic",value.id);actions.append(editor.visibility,removeButton);controls.append(actions,node("p","helper","PDF drawing mark only."));
  }
  async function apply(editor) {
    if(state.settingsEditor !== editor) return; clearTimeout(editor.timer);editor.timer=null;if(editor.applying) return editor.applying;
    const task=Promise.resolve().then(async()=>{while(state.settingsEditor===editor && editor.touched.size) {
      await state.queue; if(editor.sessionId !== state.session?.session_id || editor.key !== key()) throw new Error("The selected PDF markup changed. Select it again.");
      if(state.modal || state.gesture || state.points.length) throw new Error("Finish the drawing operation before editing the markup.");
      const captured=new Map(editor.touched), appearance={...selected().appearance}, changes={};
      for(const field of editor.appearance) if(captured.has(`appearance:${field.control.name}`)) appearance[field.control.name]=field.read();
      if([...captured.keys()].some(name=>name.startsWith("appearance:"))) changes.appearance=appearance;
      if(captured.has("text")) { if(editor.rich) { changes.text_content=editor.rich.read();changes.text=window.CeasefireTakeoffAnnotations.text(changes.text_content);if(!changes.text.trim()) throw new Error("Enter nonblank markup text."); } else changes.text=editor.text.read(); }
      const reply=await command("update_graphic",{graphic_id:editor.id,changes},()=>state.settingsEditor===editor && editor.key===key()); if(!reply) return;
      for(const[name,rev]of captured) if(editor.touched.get(name)===rev)editor.touched.delete(name);
      editor.revision=reply.revision;state.settingsDirty=editor.touched.size>0;
    }});editor.applying=task;try{await task;}finally{editor.applying=null;window.CeasefireProject?.changed?.();}
  }
  const measure=document.createElement("canvas").getContext("2d");
  function paint(overlay) {
    hasStampTemplate();
    const transform=p=>G.transform(p,state.viewport.transform), scale=Math.hypot(state.viewport.transform[0],state.viewport.transform[1])/(pageMetadata()?.user_unit || 1);
    for(const value of records().filter(v=>signatureInWorkspace(v)&&v.document_id===state.document&&v.page===state.page&&!state.graphicHidden?.has(v.id))) {
      const gesture=state.gesture?.kind==="graphic"&&state.gesture.id===value.id ? state.gesture : null, graphic=gesture?{...value,geometry:gesture.geometry}:value, points=X.coordinates(graphic).map(transform), active=state.graphicSelected===value.id;
      const group=svg("g",{class:`takeoff-graphic${active?" selected":""}`,"data-graphic-id":value.id,role:"button",tabindex:0,"aria-label":X.labels[value.kind],"aria-pressed":String(active)});
      group.append(X.paint(graphic,transform,scale,svg,measure));
      group.append(svg(graphic.geometry.quad_pdf || value.kind==="polygon" ? "polygon" : "polyline",{points:points.map(p=>p.join(",")).join(" "),fill:graphic.geometry.quad_pdf || value.kind==="polygon" ? "transparent":"none",stroke:graphic.geometry.quad_pdf || value.kind==="polygon" ? "transparent" : "transparent","stroke-width":Math.max(12,graphic.appearance.stroke_width*scale),"pointer-events":"all","data-graphic-part":"move"}));
      if(active) { const bounds=G.bounds(points);group.append(svg("rect",{x:bounds[0]-3,y:bounds[1]-3,width:bounds[2]-bounds[0]+6,height:bounds[3]-bounds[1]+6,fill:"none",stroke:"#1264c4","stroke-width":1.5,"pointer-events":"none"})); if(state.tool==="select") { const handles=graphic.geometry.quad_pdf ? [[2,points[2]]] : points.map((p,index)=>[index,p]); for(const[index,p]of handles)group.append(svg("rect",{x:p[0]-5,y:p[1]-5,width:10,height:10,fill:"white",stroke:"#1264c4","data-graphic-part":String(index),"aria-label":"Resize markup"})); } }
      group.addEventListener("click",event=>{event.stopPropagation();if(state.tool==="select"&&Date.now()>=(state.suppressSelectionClickUntil||0))void safely(()=>select(value.id,drawingClickOpensSettings(event,`graphic:${value.id}`)));});
      group.addEventListener("keydown",event=>{if(["Enter"," "].includes(event.key)){event.preventDefault();event.stopPropagation();void safely(()=>select(value.id));}});
      group.addEventListener("pointerdown",event=>void safely(()=>drag(event,value))); overlay.append(group);
    }
    if(isTool()&&state.points.length) {
      const kind=state.tool.slice(8), points=state.traceCursor ? [...state.points,state.traceCursor] : state.points;
      if(points.length>=2) { const geometry=X.boxes.has(kind) ? X.box(points,p=>G.transform(p,state.viewport.transform),p=>G.inverse(p,state.viewport.transform)) : {points}; if(!geometry.quad_pdf || [1,3].every(index=>Math.hypot(...geometry.quad_pdf[index].map((n,axis)=>n-geometry.quad_pdf[0][axis]))>0)) overlay.append(X.paint({kind,geometry,text:"",appearance:{...X.defaults(),opacity:.6}},transform,scale,svg,measure)); }
      for(const point of state.points.map(transform))overlay.append(svg("circle",{cx:point[0],cy:point[1],r:3,fill:"#1264c4","pointer-events":"none"}));
    }
  }
  function drag(event,value) {
    if(state.tool!=="select"||event.button!==0||state.busy||state.modal||state.gesture)return;
    event.stopPropagation();if(state.graphicSelected!==value.id)return; requireFinishedEdits();
    const element=state.ui.viewport,initial=drawingPoint(event),selectionKey=key(),revision=state.session.revision,transform=JSON.stringify(state.viewport.transform),original=clone(value.geometry),part=event.target.dataset.graphicPart;
    const gesture={kind:"graphic",id:value.id,initial,current:initial,geometry:original,moved:false};state.gesture=gesture;
    const valid=()=>state.gesture===gesture&&selectionKey===key()&&revision===state.session?.revision&&transform===JSON.stringify(state.viewport?.transform),view=pageMetadata().view;
    const move=next=>{if(next.pointerId!==event.pointerId||!valid())return;if(!gesture.moved&&Math.hypot(next.clientX-event.clientX,next.clientY-event.clientY)<4)return;gesture.moved=true;gesture.current=drawingPoint(next);let points,source=original.quad_pdf||original.points;
      if(part!=="move"&&part!==undefined) { if(original.quad_pdf) { const u=source[1].map((n,i)=>n-source[0][i]),v=source[3].map((n,i)=>n-source[0][i]),d=gesture.current.map((n,i)=>n-source[0][i]),ul=Math.hypot(...u),vl=Math.hypot(...v),a=Math.max(10/ul,d.reduce((sum,n,i)=>sum+n*u[i],0)/ul**2),b=Math.max(10/vl,d.reduce((sum,n,i)=>sum+n*v[i],0)/vl**2);points=[[0,0],[a,0],[a,b],[0,b]].map(([x,y])=>source[0].map((n,i)=>n+x*u[i]+y*v[i])); } else points=source.map((p,index)=>index===Number(part)?gesture.current:p); }
      else { const dx=Math.max(view[0]-Math.min(...source.map(p=>p[0])),Math.min(view[2]-Math.max(...source.map(p=>p[0])),gesture.current[0]-initial[0])),dy=Math.max(view[1]-Math.min(...source.map(p=>p[1])),Math.min(view[3]-Math.max(...source.map(p=>p[1])),gesture.current[1]-initial[1]));points=source.map(([x,y])=>[x+dx,y+dy]); }
      if(points.every(([x,y])=>x>=view[0]&&y>=view[1]&&x<=view[2]&&y<=view[3]))gesture.geometry=original.quad_pdf?{quad_pdf:points}:{points};next.preventDefault();renderOverlay();window.CeasefireProject?.changed?.();};
    const finish=next=>{if(next.pointerId!==event.pointerId)return;const current=valid();cleanup();state.gesture=null;state.suppressSelectionClickUntil=Date.now()+500;if(!gesture.moved&&current){void safely(()=>select(value.id,drawingClickOpensSettings(next,`graphic:${value.id}`)));}else if(current&&JSON.stringify(original)!==JSON.stringify(gesture.geometry)){void safely(()=>command("update_graphic",{graphic_id:value.id,changes:{geometry:gesture.geometry}},()=>selectionKey===key()&&revision===state.session?.revision));}renderOverlay();window.CeasefireProject?.changed?.();};
    const cancel=()=>{cleanup();if(state.gesture===gesture)state.gesture=null;renderOverlay();window.CeasefireProject?.changed?.();};
    const cleanup=gesture.cleanup=()=>{element.removeEventListener("pointermove",move);element.removeEventListener("pointerup",finish);element.removeEventListener("pointercancel",cancel);element.removeEventListener("lostpointercapture",cancel);if(element.hasPointerCapture?.(event.pointerId))element.releasePointerCapture(event.pointerId);};
    element.addEventListener("pointermove",move);element.addEventListener("pointerup",finish);element.addEventListener("pointercancel",cancel);element.addEventListener("lostpointercapture",cancel);element.setPointerCapture?.(event.pointerId);event.preventDefault();
  }
  return Object.freeze({records,selected,isTool,activate,point,finish,select,remove,settings,apply,paint,beginStampBox,hasStampTemplate,cancel});
};
