"use strict";

// The workspace owns session guards and selection. This bridge keeps visual
// markup behaviour outside the calibrated item/transfer model.
window.CeasefireTakeoffGraphicsUI = function (host) {
  const { state, G, X, node, svg, button, clone, snapshot, documents, pageMetadata, currentDocument, pageDisplayKey, signatureMode, signatureInWorkspace, selectedSignature, selectedAnnotation, command, safely, message, renderSelection, renderOverlay, flushSettings, requireFinishedEdits, cancelTrace, setTool, ask, drawingPoint, drawingClickOpensSettings, bindSetting, appearanceField, currentVisibilityControl, renderPhysicalDetails, renderViewportPanel } = host;
  const records = () => snapshot()?.graphics?.records || [];
  const selected = () => records().find(value => value.id === state.graphicSelected && signatureInWorkspace(value) && value.document_id === state.document && value.page === state.page);
  const key = () => JSON.stringify([pageDisplayKey(), signatureMode(), selected()?.id]);
  const isTool = () => state.tool.startsWith("graphic-");
  const measureResult = value => host.pdfMeasureResult?.(value.id) || state.session?.pdf_measure_results?.find(result => result.id === value.id);
  const currentCalibrations = () => host.activePageCalibrations?.() || [];
  function measureCalibration(kind = "measure") {
    if (!state.calibration || !currentCalibrations().some(value => value.id === state.calibration)) throw new Error("Choose a current drawing calibration before using Measure.");
    if(kind === "area" && currentCalibrations().find(value=>value.id===state.calibration)?.uniform_scale !== true) throw new Error("Choose a uniform drawing calibration before using Area.");
    return state.calibration;
  }
  let activationGeneration = 0, stampGeneration = 0, stampPending = false, measureControl = null, exclusionTarget = null;
  const stampKey = () => JSON.stringify([state.session?.session_id,state.document,currentDocument()?.sha256,state.page,signatureMode()]);
  function hasStampTemplate() {
    if (state.stampTemplate && state.stampTemplate.key !== stampKey()) state.stampTemplate = null;
    return !!state.stampTemplate;
  }
  function cancel(forgetTemplate = true) {
    stampGeneration++;
    measureControl = null;
    exclusionTarget = null;
    if (forgetTemplate) state.stampTemplate = null;
  }
  const activationKey = () => JSON.stringify([pageDisplayKey(), signatureMode(), state.session?.revision, currentDocument()?.sha256, state.active, state.tool, state.graphicSelected, state.annotationSelected, state.signatureSelected, state.legendSelected, [...state.selected], [...state.countSelection], [...state.physicalSelected], state.physicalDetailsOpen, state.settingsOpen, state.viewportsOpen, state.calibrationTarget, state.retraceId, state.exclusionItemId, state.pendingViewport, state.signatureDraft]);
  async function activate(kind) {
    const generation = ++activationGeneration;
    if (!X.tools.includes(kind)) throw new Error("Choose a supported PDF markup tool.");
    if (state.tool === `graphic-${kind}` && !state.busy && !state.modal && !state.navigationBusy) { if(kind==="stamp")cancel(true); cancelTrace(); renderSelection(); message(`${X.labels[kind]} cancelled.`); return; }
    const priorSelectionClickUntil = state.suppressSelectionClickUntil;
    await flushSettings();
    if (generation !== activationGeneration) throw new Error("A newer PDF markup tool was selected.");
    requireFinishedEdits();
    if (!state.viewport || !currentDocument()) throw new Error("Open a PDF page before adding a markup.");
    const area = kind === "area-exclusion" ? selected() : null;
    if(kind === "area-exclusion" && (!area || area.kind !== "area" || !currentCalibrations().some(value=>value.id===area.calibration_id && value.uniform_scale === true) || measureResult(area)?.status !== "current" || measureResult(area)?.version !== area.version)) throw new Error("Select a current calibrated PDF Area before adding an exclusion.");
    if(kind === "area-exclusion" && (area.geometry.exclusions.length >= 64 || areaVertexCount(area.geometry) >= 998)) throw new Error("An Area supports at most 64 exclusions and 1,000 total vertices.");
    if (["measure","area"].includes(kind)) measureCalibration(kind);
    const context = activationKey(), calibration = state.calibration, areaVersion=area?.version;
    await Promise.all([document.fonts.load("12px CeasefireDrawing"), document.fonts.load("700 12px CeasefireDrawing")]);
    if (generation !== activationGeneration || context !== activationKey() || state.busy || state.modal || state.navigationBusy || !state.viewport) throw new Error("The drawing changed while loading the markup font. Select the tool again.");
    if (["measure","area"].includes(kind) && calibration !== measureCalibration(kind)) throw new Error(`The drawing calibration changed. Select ${X.labels[kind]} again.`);
    if(area && (selected() !== area || area.version !== areaVersion || !currentCalibrations().some(value=>value.id===area.calibration_id && value.uniform_scale === true))) throw new Error("The Area changed. Select it again.");
    requireFinishedEdits();
    cancelTrace(); state.settingsOpen = false; state.settingsEditor = null; state.graphicSelected = null; state.selected.clear(); state.annotationSelected = null; state.signatureSelected = null;
    setTool(`graphic-${kind}`);
    if(area) { exclusionTarget={id:area.id,version:areaVersion,source:stampKey(),calibration:area.calibration_id};state.graphicSelected=area.id; }
    // A successful explicit tool choice retires its prior Select release guard.
    // Preserve a changed deadline while settings or fonts were pending.
    if (priorSelectionClickUntil > 0 && state.suppressSelectionClickUntil === priorSelectionClickUntil) state.suppressSelectionClickUntil = 0;
    renderSelection();
    message(kind === "stamp" ? hasStampTemplate() ? "Stamp: click to place another copy. Right-click or select Stamp again to stop." : "Stamp: click its position, then choose text or a PNG/JPEG image. Right-click cancels." : kind === "textbox" ? "Textbox: click its position, then enter formatted text. Escape cancels." : X.boxes.has(kind) ? `${X.labels[kind]}: click two opposite corners. Escape cancels.` : `${X.labels[kind]}: click each vertex${kind === "area-exclusion" ? " strictly inside the selected Area" : ""}, then press Enter or double-click to finish. Escape cancels.`);
  }
  const activateExclusion = () => activate("area-exclusion");
  const areaVertexCount = geometry => geometry.points.length + (geometry.exclusions || []).reduce((sum,hole)=>sum+hole.points.length,0);
  function exclusionArea() {
    const area=selected();
    return exclusionTarget && area?.kind==="area" && area.id===exclusionTarget.id && area.version===exclusionTarget.version && stampKey()===exclusionTarget.source && area.calibration_id===exclusionTarget.calibration && currentCalibrations().some(value=>value.id===area.calibration_id && value.uniform_scale===true) ? area : null;
  }
  function beginStampBox() {
    // Stamp creation begins on the normal single click, like Textbox. Retain
    // this host hook so existing pointer routing does not start a box gesture.
    return false;
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
    if(state.tool === "graphic-area-exclusion") { const area=exclusionArea();if(!area) throw new Error("The Area or calibration changed. Select it again.");if(areaVertexCount(area.geometry)+state.points.length >= 1000)throw new Error("An Area supports at most 1,000 vertices including its exclusions."); }
    if (state.points.length && Math.hypot(...p.map((value,axis)=>value-state.points.at(-1)[axis])) < 1e-8) return;
    state.points.push(p); state.traceCursor = null; renderOverlay(); window.CeasefireProject?.changed?.();
    const kind = state.tool.slice(8);
    if (["textbox","stamp"].includes(kind) || state.points.length === 2 && (X.boxes.has(kind) || kind === "arrow")) await finish();
  }
  async function finish() {
    if (state.formDirty || state.settingsDirty || state.gesture || state.physicalPlacing || state.physicalUI?.hasUnfinishedChanges()) throw new Error("Apply or discard unfinished item edits before finishing the markup.");
    const tool = state.tool, kind = tool.slice(8);
    if (!isTool() || state.points.length < (["textbox","stamp"].includes(kind) ? 1 : 2)) throw new Error("Choose at least two distinct PDF markup points.");
    const context = pageDisplayKey(), mode = signatureMode(), revision = state.session.revision, points = clone(state.points), documentId=state.document, sourceSha=currentDocument().sha256, generation=stampGeneration, displayRotation=host.displayRotation?.() ?? state.viewport.rotation ?? pageMetadata()?.rotation ?? 0, calibration=["measure","area"].includes(kind) ? measureCalibration(kind) : null;
    const geometry = ["textbox","stamp"].includes(kind) ? null : X.boxes.has(kind) ? X.box(points, p=>G.transform(p,state.viewport.transform), p=>G.inverse(p,state.viewport.transform)) : {points,...(kind === "area" ? {exclusions:[]} : {})};
    if (["polygon","area","area-exclusion"].includes(kind) && points.length < 3) throw new Error("Choose at least three vertices for a polygon.");
    if(kind === "area-exclusion") {
      const area=exclusionArea(), target=exclusionTarget;
      if(!area)throw new Error("The Area or calibration changed. Select it again.");
      const next=clone(area.geometry);next.exclusions.push({id:window.crypto.randomUUID(),points,note:""});
      const reply=await command("update_graphic",{graphic_id:area.id,changes:{geometry:next}},()=>target===exclusionTarget && exclusionArea()===area && context===pageDisplayKey() && mode===signatureMode() && tool===state.tool && revision===state.session.revision && JSON.stringify(points)===JSON.stringify(state.points));
      if(!reply)throw new Error("The drawing changed. Trace the exclusion again.");
      if(target!==exclusionTarget || context!==pageDisplayKey() || mode!==signatureMode() || tool!==state.tool || JSON.stringify(points)!==JSON.stringify(state.points))return;
      cancelTrace();await select(area.id,true);message("Area exclusion added. Its area is subtracted once from this PDF Area.");return;
    }
    if (geometry?.quad_pdf && [1,3].some(i=>Math.hypot(...geometry.quad_pdf[i].map((n,axis)=>n-geometry.quad_pdf[0][axis])) < 10)) throw new Error("Choose a larger rectangle (at least 10 PDF points on each side).");
    let text = "", textContent=null, stampContent=null;
    if(kind === "stamp") { stampContent=await chooseStamp();if(!stampContent){if(generation===stampGeneration && context===pageDisplayKey() && mode===signatureMode() && tool===state.tool)cancelTrace();return;}text=stampContent.text; }
    else if (kind === "textbox") {
      const A=window.CeasefireTakeoffAnnotations;
      const answer = await ask(X.labels[kind], [["text","Textbox text","textarea","",true]], "This text is a drawing note.", "Place markup", (controls,ready)=>{
        const field=controls[0], wrapper=node("div","field takeoff-graphic-text"), status=node("p","helper"); status.setAttribute("role","status");
        const refresh=()=>{try {ready(!!A.text(rich.read()).trim());status.textContent="";}catch(error){ready(false);status.textContent=error.message;}};
        const rich=A.richEditor({version:1,blocks:[{kind:"paragraph",runs:[{text:""}]}]},refresh,{label:"Textbox text",maxLength:4000});
        field.read=()=>{textContent=rich.read();const value=A.text(textContent);if(!value.trim())throw new Error("Enter nonblank markup text.");return value;};
        wrapper.append(node("span","","Textbox text"),rich.wrap,status);field.wrapper.replaceWith(wrapper);refresh();rich.editor.focus();
      });
      if (!answer) { if(generation===stampGeneration && context===pageDisplayKey() && mode===signatureMode() && tool===state.tool)cancelTrace(); return; } text = answer.text;
    }
    const graphic = { mode, document_id: documentId, source_sha256: sourceSha, page: state.page, kind: kind === "polyline" && points.length === 2 ? "line" : kind, geometry, text, ...(textContent?{text_content:textContent}:{}), appearance: X.defaults(), ...(stampContent?.stamp_image?{stamp_image:stampContent.stamp_image}:{}), ...(calibration?{calibration_id:calibration}:{}) };
    const sameIntent = () => context === pageDisplayKey() && mode === signatureMode() && tool === state.tool && JSON.stringify(points) === JSON.stringify(state.points) && (!["stamp","textbox"].includes(kind) || generation === stampGeneration) && (!["measure","area"].includes(kind) || calibration === state.calibration && currentCalibrations().some(value=>value.id===calibration && (kind !== "area" || value.uniform_scale===true)));
    const reply = kind === "textbox"
      ? await command("create_textbox", {textbox:{mode,document_id:documentId,source_sha256:sourceSha,page:state.page,anchor_pdf:points[0],display_rotation:displayRotation,text,text_content:textContent,appearance:graphic.appearance}}, () => sameIntent() && revision === state.session.revision)
      : kind === "stamp"
      ? await command("create_stamp", {stamp:{mode,document_id:documentId,source_sha256:sourceSha,page:state.page,anchor_pdf:points[0],display_rotation:displayRotation,text,appearance:graphic.appearance,...(stampContent.stamp_image?{stamp_image:stampContent.stamp_image}:{})}}, () => sameIntent() && revision === state.session.revision)
      : await command("create_graphic", {graphic}, () => sameIntent() && revision === state.session.revision);
    if (!reply) throw new Error("The drawing changed. Place the markup again.");
    if (["textbox","area"].includes(kind) && !sameIntent()) return;
    if(kind === "stamp") { if(generation!==stampGeneration || context!==pageDisplayKey() || mode!==signatureMode() || tool!==state.tool) return;const stored=records().find(value=>value.id===reply.created_graphic_id);if(!stored)throw new Error("The created Stamp is unavailable. Select Stamp again.");state.stampTemplate={key:stampKey(),geometry:clone(stored.geometry),text:stored.text,appearance:clone(stored.appearance),...(stored.stamp_image?{stamp_image:clone(stored.stamp_image)}:{})};state.points=[];state.traceCursor=null;state.graphicSelected=null;renderSelection();message("Stamp placed. Click for another copy; right-click or select Stamp again to stop.");return; }
    cancelTrace(); await select(reply.created_graphic_id, true); message(`${X.labels[graphic.kind]} placed. Drag to move, resize its handles, or edit it in Settings.`);
  }
  async function select(id, openSettings = true) {
    if (state.tool !== "select" || state.busy || state.modal || state.gesture) return;
    await flushSettings(); requireFinishedEdits();
    if (!records().some(v=>v.id===id && signatureInWorkspace(v) && v.document_id===state.document && v.page===state.page)) throw new Error("Select a PDF markup on this page.");
    state.selected.clear(); state.countSelection.clear(); state.annotationSelected = null; state.signatureSelected = null; state.legendSelected = null; state.controlPoint = null; state.markupMenu = null;
    await state.physicalUI?.clearSelection?.(); state.physicalDetailsOpen = false; state.viewportsOpen = false;
    measureControl = null; state.graphicSelected = id; state.settingsOpen = openSettings || state.settingsOpen; state.settingsEditor = null; renderPhysicalDetails(); renderViewportPanel(); renderSelection();
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
    const definitions = [["stroke_enabled","Line Enabled","checkbox"],["stroke_color","Line Colour","color"],["stroke_width","Line Width","number"],["fill_color","Fill Colour","color"],["fill_enabled","Fill Enabled","checkbox"],...(textAppearance ? [["font_color","Font Colour","color"],["font_size","Font Size","number"]] : []),["opacity","Opacity","number"]];
    for(const def of definitions) { const field=def[0] === "font_size" ? host.formField(def,value.appearance[def[0]]) : appearanceField(def,value.appearance[def[0]]); if(def[0] === "font_size") {field.control.min="4";field.control.max="144";} editor.appearance.push(field); bindSetting(editor,field,`appearance:${def[0]}`); }
    host.appendAppearanceFields(controls, editor.appearance);
    if(value.kind === "textbox") {
      const A=window.CeasefireTakeoffAnnotations, wrapper=node("div","field takeoff-graphic-text"), content=value.text_content || {version:1,blocks:[{kind:"paragraph",runs:[{text:value.text}]}]};
      editor.rich=A.richEditor(content,()=>host.markSettingsEdited(editor,"text"),{label:"Textbox text",maxLength:4000});
      wrapper.append(node("span","","Textbox text"),editor.rich.wrap); controls.append(wrapper);
    } else if(value.kind === "stamp" && !value.stamp_image) { const wrapper=node("label","field takeoff-graphic-text"), control=node("input"); control.name="text";control.value=value.text;control.maxLength=80;control.required=true;control.setAttribute("aria-label","Stamp text");wrapper.append(node("span","","Stamp text"),control);editor.text={control,read:()=>{if(!control.value.trim()) throw new Error("Enter nonblank markup text.");return control.value;}};bindSetting(editor,editor.text,"text");controls.append(wrapper); }
    else if(value.stamp_image) controls.append(node("p","helper",`Stamp image: ${value.stamp_image.width} × ${value.stamp_image.height} pixels.`));
    if(value.kind === "count") {
      const actions=node("div","actions takeoff-appearance-actions"), count=value.geometry.points.length;
      actions.append(button("Edit marker length", () => editCount(false)), button("Remove marker", () => editCount(true)));
      controls.append(node("p", "helper", `${count} ${count===1 ? "marker" : "markers"} · ${host.formatLength(value.geometry.lengths_m.reduce((sum, length) => sum + length, 0))} m total manual length`),actions);
    }
    if(["measure","area"].includes(value.kind)) {
      const result=measureResult(value), definitions=value.kind === "area" ? [["gross_area_m2","Gross area (m²)"],["excluded_area_m2","Excluded area (m²)"],["net_area_m2","Area (m²)"]] : [["length_m","Length (m)"]];
      for(const [name,label] of definitions) { const field=host.formField([name,label,"number"],result?.status==="current" && result.version===value.version && Number.isFinite(result[name]) ? result[name].toFixed(2) : "");field.control.readOnly=true;controls.append(field.wrapper); }
      const options=currentCalibrations().filter(entry=>value.kind!=="area" || entry.uniform_scale===true).map(entry=>[entry.id,entry.name]);
      if(!options.some(([id])=>id===value.calibration_id))options.push([value.calibration_id,"Retained calibration — choose a current scale"]);
      editor.calibration=host.formField(["calibration_id","Drawing calibration",options],value.calibration_id); bindSetting(editor,editor.calibration,"calibration_id");controls.append(editor.calibration.wrapper);
      if(result?.status!=="current")controls.append(node("p","takeoff-warning",`Choose a current drawing calibration to review this ${X.labels[value.kind]}.`));
      if(value.kind==="area") {
        const section=node("section","takeoff-settings-tools"), add=button("Area exclusion",activateExclusion);
        add.disabled=result?.status!=="current" || result.version!==value.version || value.geometry.exclusions.length>=64 || areaVertexCount(value.geometry)>=998;section.append(add);
        value.geometry.exclusions.forEach((hole,index)=>{const row=node("section","takeoff-area-exclusion");row.append(node("h4","",`Exclusion ${index+1}`),node("p","helper",hole.note),button("Edit exclusion note",()=>editExclusion(hole.id)),button("Remove exclusion",()=>editExclusion(hole.id,true)));section.append(row);});controls.append(section);
      }
    }
    const actions=node("div","actions takeoff-appearance-actions"), removeButton=button("Delete markup",remove); removeButton.classList.add("takeoff-markup-delete");removeButton.title="Delete markup";removeButton.setAttribute("aria-label","Delete markup");
    const trash=svg("svg",{viewBox:"0 0 24 24",width:20,height:20,fill:"none",stroke:"currentColor","stroke-width":1.8,"stroke-linecap":"round","stroke-linejoin":"round","aria-hidden":"true"});trash.append(svg("path",{d:"M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"}));removeButton.replaceChildren(trash);
    editor.visibility=currentVisibilityControl("graphic",value.id);actions.append(editor.visibility,removeButton);controls.append(actions,node("p","helper","PDF drawing mark only."));
  }
  async function editExclusion(id, removeHole=false) {
    const area=selected(), selectionKey=key(), revision=state.session?.revision, version=area?.version;
    if(area?.kind!=="area" || state.tool!=="select")throw new Error("Select a PDF Area to edit its exclusions.");
    const hole=area.geometry.exclusions.find(value=>value.id===id);
    if(!hole)throw new Error("The selected Area exclusion no longer exists.");
    await flushSettings();requireFinishedEdits();
    const current=()=>selected()===area && area.version===version && selectionKey===key() && revision===state.session?.revision && state.tool==="select";
    if(!current())throw new Error("The Area changed. Select its exclusion again.");
    const answer=removeHole ? null : await ask("Area exclusion",[["note","Exclusion note","textarea",hole.note,false]],"","Apply note");
    if(!removeHole && !answer)return;
    if(!current())throw new Error("The Area changed. Select its exclusion again.");
    const geometry=clone(area.geometry);
    if(removeHole)geometry.exclusions=geometry.exclusions.filter(value=>value.id!==id);
    else geometry.exclusions.find(value=>value.id===id).note=answer.note;
    const reply=await command("update_graphic",{graphic_id:area.id,changes:{geometry}},current);
    if(reply && selectionKey===key()){measureControl=null;state.settingsEditor=null;renderSelection();message(removeHole ? "Area exclusion removed. Undo last edit restores it." : "Area exclusion note updated.");}
  }
  async function editCount(removeMarker) {
    await flushSettings(); requireFinishedEdits();
    const value=selected(), selectionKey=key(), revision=state.session?.revision;
    if(value?.kind!=="count" || state.tool!=="select")throw new Error("Select a PDF Count first.");
    const fields=[["marker","Marker number","number",1,true], ...(!removeMarker ? [["length_mm","Manual Length (mm)","number",value.geometry.lengths_m[0]*1000,true]] : [])];
    const answer=await ask(removeMarker ? "Remove marker" : "Edit marker length", fields, "Marker positions and drawing scale do not change manual lengths.", removeMarker ? "Remove marker" : "Apply length", controls=>{
      const marker=controls[0].control;marker.min="1";marker.max=String(value.geometry.points.length);marker.step="1";
      if(controls[1]) {const length=controls[1].control;length.min="0.000001";length.max="1000000000000000";marker.addEventListener("change",()=>{const index=Number(marker.value)-1;if(Number.isInteger(index)&&index>=0&&index<value.geometry.points.length)length.value=String(value.geometry.lengths_m[index]*1000);});}
    });
    if(!answer)return;
    const index=answer.marker-1;
    if(!Number.isInteger(index)||index<0||index>=value.geometry.points.length)throw new Error("Choose an existing marker number.");
    if(!removeMarker && (!(answer.length_mm>0)||!Number.isFinite(answer.length_mm)||answer.length_mm>1e15))throw new Error("Enter a positive finite manual length.");
    const geometry=clone(value.geometry);
    if(removeMarker){geometry.points.splice(index,1);geometry.lengths_m.splice(index,1);}else geometry.lengths_m[index]=answer.length_mm/1000;
    const guard=()=>selected()===value && key()===selectionKey && state.session?.revision===revision && state.tool==="select";
    const reply=await command(geometry.points.length ? "update_graphic" : "delete_graphic", {graphic_id:value.id,...(geometry.points.length?{changes:{geometry}}:{})},guard);
    if(reply){if(!geometry.points.length)state.graphicSelected=null;state.settingsEditor=null;renderSelection();}
  }
  async function apply(editor) {
    if(state.settingsEditor !== editor) return; clearTimeout(editor.timer);editor.timer=null;if(editor.applying) return editor.applying;
    const task=Promise.resolve().then(async()=>{while(state.settingsEditor===editor && editor.touched.size) {
      await state.queue; if(editor.sessionId !== state.session?.session_id || editor.key !== key()) throw new Error("The selected PDF markup changed. Select it again.");
      if(state.modal || state.gesture || state.points.length) throw new Error("Finish the drawing operation before editing the markup.");
      const captured=new Map(editor.touched), appearance={}, changes={};
      for(const field of editor.appearance) if(captured.has(`appearance:${field.control.name}`)) appearance[field.control.name]=field.read();
      if([...captured.keys()].some(name=>name.startsWith("appearance:"))) changes.appearance=appearance;
      if(captured.has("text")) { if(editor.rich) { changes.text_content=editor.rich.read();changes.text=window.CeasefireTakeoffAnnotations.text(changes.text_content);if(!changes.text.trim()) throw new Error("Enter nonblank markup text."); } else changes.text=editor.text.read(); }
      if(captured.has("calibration_id")) { changes.calibration_id=editor.calibration.read();if(!currentCalibrations().some(value=>value.id===changes.calibration_id && (selected()?.kind!=="area" || value.uniform_scale===true)))throw new Error("Choose a current calibration for this PDF page."); }
      const reply=await command("update_graphic",{graphic_id:editor.id,changes},()=>state.settingsEditor===editor && editor.key===key()); if(!reply) return;
      for(const[name,rev]of captured) if(editor.touched.get(name)===rev)editor.touched.delete(name);
      editor.revision=reply.revision;state.settingsDirty=editor.touched.size>0;
    }});editor.applying=task;try{await task;}finally{editor.applying=null;window.CeasefireProject?.changed?.();}
  }
  const measure=document.createElement("canvas").getContext("2d");
  const controlRing = (value, control = measureControl) => control?.exclusionId ? value.geometry.exclusions?.find(hole=>hole.id===control.exclusionId)?.points : value.geometry.points;
  function measurePointTarget() {
    const value=selected();
    return measureControl && ["measure","area"].includes(value?.kind) && value.id===measureControl.id && value.version===measureControl.version && key()===measureControl.key && controlRing(value)?.[measureControl.index] ? value : null;
  }
  function selectMeasurePoint(id,index,menu=false,exclusionId=null) {
    const value=selected();
    if(state.tool!=="select" || state.busy || state.modal || state.navigationBusy || state.gesture || value?.id!==id || !["measure","area"].includes(value.kind) || !Number.isInteger(index) || !controlRing(value,{exclusionId})?.[index])return;
    requireFinishedEdits(); measureControl={id,index,version:value.version,key:key(),menu,exclusionId}; renderOverlay();
    if(menu)state.ui.overlay?.querySelector?.(`[aria-label="${X.labels[value.kind]} control point actions"] button:not(:disabled)`)?.focus({preventScroll:true});
    else state.ui.viewport.focus?.({preventScroll:true});
  }
  async function editMeasurePoint(insert=false) {
    const target=measurePointTarget(), captured=measureControl;
    if(!target)throw new Error("Select a current Measure or Area control point.");
    await flushSettings();requireFinishedEdits();
    if(captured!==measureControl || measurePointTarget()!==target)throw new Error(`The ${X.labels[target.kind]} changed. Select its control point again.`);
    const geometry=clone(target.geometry), points=captured.exclusionId ? geometry.exclusions.find(hole=>hole.id===captured.exclusionId).points : geometry.points, index=captured.index, area=target.kind==="area";
    if(insert) {
      if((area ? areaVertexCount(geometry) : points.length)>=1000 || !area && index>=points.length-1)throw new Error("Choose a Measure point before its final point, or an Area vertex within the 1,000 total vertex limit.");
      points.splice(index+1,0,points[index].map((n,axis)=>(n+points[(index+1)%points.length][axis])/2));
    } else {
      if(points.length<=(area ? 3 : 2))throw new Error(area ? "An Area boundary or exclusion must retain at least three control points." : "A Measure must retain at least two control points.");
      points.splice(index,1);
    }
    const reply=await command("update_graphic",{graphic_id:target.id,changes:{geometry}},()=>captured===measureControl && measurePointTarget()===target);
    if(reply && measureControl===captured) { measureControl=null;renderSelection(); }
  }
  function handleKeydown(event) {
    if(!measurePointTarget() || state.tool!=="select" || state.busy || state.modal || state.gesture || state.navigationBusy || event.isComposing || event.repeat || event.altKey || event.target?.closest?.("input,textarea,select,[contenteditable=true],dialog"))return false;
    if(event.key==="Escape") { measureControl=null;renderOverlay(); }
    else if((event.ctrlKey || event.metaKey) && event.key.toLowerCase()==="z" && !event.shiftKey)void safely(()=>editMeasurePoint());
    else return false;
    event.preventDefault();event.stopPropagation();return true;
  }
  function paint(overlay) {
    hasStampTemplate();
    const transform=p=>G.transform(p,state.viewport.transform), scale=Math.hypot(state.viewport.transform[0],state.viewport.transform[1])/(pageMetadata()?.user_unit || 1);
    for(const value of records().filter(v=>signatureInWorkspace(v)&&v.document_id===state.document&&v.page===state.page&&!state.graphicHidden?.has(v.id))) {
      const gesture=state.gesture?.kind==="graphic"&&state.gesture.id===value.id ? state.gesture : null, graphic=gesture?{...value,geometry:gesture.geometry}:value, points=X.coordinates(graphic).map(transform), active=state.graphicSelected===value.id;
      const group=svg("g",{class:`takeoff-graphic${active?" selected":""}`,"data-graphic-id":value.id,role:"button",tabindex:0,"aria-label":X.labels[value.kind],"aria-pressed":String(active)});
      group.append(X.paint(graphic,transform,scale,svg,measure,gesture ? null : measureResult(value),host.formatLength));
      const closed=graphic.geometry.quad_pdf || ["polygon","area"].includes(value.kind);
      if(value.kind === "count") points.forEach(([cx,cy])=>group.append(svg("circle",{cx,cy,r:Math.max(8,7*scale),fill:"transparent","pointer-events":"all","data-graphic-part":"move"})));
      else group.append(svg(closed ? "polygon" : "polyline",{points:points.map(p=>p.join(",")).join(" "),fill:closed ? "transparent":"none",stroke:"transparent","stroke-width":Math.max(12,graphic.appearance.stroke_width*scale),"pointer-events":"all","data-graphic-part":"move"}));
      if(active) { const bounds=G.bounds(points);group.append(svg("rect",{x:bounds[0]-3,y:bounds[1]-3,width:bounds[2]-bounds[0]+6,height:bounds[3]-bounds[1]+6,fill:"none",stroke:"#1264c4","stroke-width":1.5,"pointer-events":"none"})); if(state.tool==="select") { const handles=graphic.geometry.quad_pdf ? [[2,points[2],null]] : [...points.map((p,index)=>[index,p,null]),...(graphic.geometry.exclusions || []).flatMap(hole=>hole.points.map((p,index)=>[index,transform(p),hole.id]))]; for(const[index,p,exclusionId]of handles) {
        const measured=["measure","area"].includes(value.kind), label=`${exclusionId ? "Area exclusion" : X.labels[value.kind]} control point ${index+1}`;
        const handle=svg("rect",{x:p[0]-5,y:p[1]-5,width:10,height:10,fill:"white",stroke:"#1264c4","data-graphic-part":exclusionId ? `hole:${exclusionId}:${index}` : String(index),"aria-label":measured ? label : "Resize markup"});
        if(measured) {
          handle.setAttribute("tabindex","0");handle.setAttribute("role","button");
          handle.addEventListener("click",event=>{event.stopPropagation();void safely(()=>selectMeasurePoint(value.id,index,false,exclusionId));});
          handle.addEventListener("contextmenu",event=>{event.preventDefault();event.stopPropagation();void safely(()=>selectMeasurePoint(value.id,index,true,exclusionId));});
          handle.addEventListener("keydown",event=>{if(event.key==="ContextMenu" || event.shiftKey&&event.key==="F10"){event.preventDefault();event.stopPropagation();void safely(()=>selectMeasurePoint(value.id,index,true,exclusionId));}else if(["Enter"," "].includes(event.key)){event.preventDefault();event.stopPropagation();void safely(()=>selectMeasurePoint(value.id,index,false,exclusionId));}});
        }
        group.append(handle);
      } } }
      group.addEventListener("click",event=>{event.stopPropagation();if(state.tool==="select"&&Date.now()>=(state.suppressSelectionClickUntil||0))void safely(()=>select(value.id,drawingClickOpensSettings(event,`graphic:${value.id}`)));});
      group.addEventListener("keydown",event=>{if(["Enter"," "].includes(event.key)){event.preventDefault();event.stopPropagation();void safely(()=>select(value.id));}});
      if(value.kind==="stamp") group.addEventListener("contextmenu",event=>{if(state.tool!=="select"||state.busy||state.modal)return;event.preventDefault();event.stopPropagation();void safely(()=>host.openStampMenu(value.id,drawingPoint(event)));});
      group.addEventListener("pointerdown",event=>void safely(()=>drag(event,value))); overlay.append(group);
    }
    const target=measurePointTarget();
    if(target && measureControl.menu) {
      const ring=controlRing(target),point=transform(ring[measureControl.index]), box=svg("foreignObject",{x:Math.max(0,Math.min(point[0]+8,(state.viewport.width||600)-220)),y:Math.max(0,Math.min(point[1]+8,(state.viewport.height||800)-105)),width:210,height:100});
      const menu=node("div","takeoff-control-menu");menu.setAttribute("role","menu");menu.setAttribute("aria-label",`${X.labels[target.kind]} control point actions`);
      const removePoint=button("Delete control point",()=>editMeasurePoint()),insertPoint=button("Insert midpoint",()=>editMeasurePoint(true));
      removePoint.disabled=ring.length<=(target.kind==="area" ? 3 : 2);insertPoint.disabled=(target.kind==="area" ? areaVertexCount(target.geometry)>=1000 : ring.length>=1000 || measureControl.index>=ring.length-1);
      for(const control of [removePoint,insertPoint])control.setAttribute("role","menuitem");
      menu.append(removePoint,insertPoint);box.append(menu);overlay.append(box);
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
    const holeParts=typeof part==="string" && part.startsWith("hole:") ? part.split(":") : null, exclusionId=holeParts?.[1] || null, pointIndex=Number(holeParts ? holeParts[2] : part);
    if(part!=="move" && part!==undefined && (!Number.isInteger(pointIndex) || !(exclusionId ? original.exclusions?.find(hole=>hole.id===exclusionId)?.points : original.quad_pdf || original.points)?.[pointIndex]))return;
    const gesture={kind:"graphic",id:value.id,initial,current:initial,geometry:original,moved:false};state.gesture=gesture;
    const valid=()=>state.gesture===gesture&&selectionKey===key()&&revision===state.session?.revision&&transform===JSON.stringify(state.viewport?.transform),view=pageMetadata().view;
    const move=next=>{if(next.pointerId!==event.pointerId||!valid())return;if(!gesture.moved&&Math.hypot(next.clientX-event.clientX,next.clientY-event.clientY)<4)return;gesture.moved=true;gesture.current=drawingPoint(next);let points,source=exclusionId ? original.exclusions.find(hole=>hole.id===exclusionId).points : original.quad_pdf||original.points,geometry=clone(original);
      if(part!=="move"&&part!==undefined) { if(original.quad_pdf) { const u=source[1].map((n,i)=>n-source[0][i]),v=source[3].map((n,i)=>n-source[0][i]),d=gesture.current.map((n,i)=>n-source[0][i]),ul=Math.hypot(...u),vl=Math.hypot(...v),a=Math.max(10/ul,d.reduce((sum,n,i)=>sum+n*u[i],0)/ul**2),b=Math.max(10/vl,d.reduce((sum,n,i)=>sum+n*v[i],0)/vl**2);points=[[0,0],[a,0],[a,b],[0,b]].map(([x,y])=>source[0].map((n,i)=>n+x*u[i]+y*v[i])); } else points=source.map((p,index)=>index===pointIndex?gesture.current:p); }
      else { const dx=Math.max(view[0]-Math.min(...source.map(p=>p[0])),Math.min(view[2]-Math.max(...source.map(p=>p[0])),gesture.current[0]-initial[0])),dy=Math.max(view[1]-Math.min(...source.map(p=>p[1])),Math.min(view[3]-Math.max(...source.map(p=>p[1])),gesture.current[1]-initial[1]));points=source.map(([x,y])=>[x+dx,y+dy]);if(geometry.exclusions)geometry.exclusions=geometry.exclusions.map(hole=>({...hole,points:hole.points.map(([x,y])=>[x+dx,y+dy])})); }
      if(points.every(([x,y])=>x>=view[0]&&y>=view[1]&&x<=view[2]&&y<=view[3])) { if(original.quad_pdf)geometry.quad_pdf=points;else if(exclusionId)geometry.exclusions.find(hole=>hole.id===exclusionId).points=points;else geometry.points=points;gesture.geometry=original.quad_pdf && part!=="move" && part!==undefined ? X.resizedTextBox(value,geometry,pageMetadata().user_unit) : geometry; } next.preventDefault();renderOverlay();window.CeasefireProject?.changed?.();};
    const finish=next=>{if(next.pointerId!==event.pointerId)return;const current=valid();cleanup();state.gesture=null;state.suppressSelectionClickUntil=Date.now()+500;if(!gesture.moved&&current){if(["measure","area"].includes(value.kind)&&part!==undefined&&part!=="move")void safely(()=>selectMeasurePoint(value.id,pointIndex,false,exclusionId));else void safely(()=>select(value.id,drawingClickOpensSettings(next,`graphic:${value.id}`)));}else if(current&&JSON.stringify(original)!==JSON.stringify(gesture.geometry)){void safely(()=>command("update_graphic",{graphic_id:value.id,changes:{geometry:gesture.geometry}},()=>selectionKey===key()&&revision===state.session?.revision));}renderOverlay();window.CeasefireProject?.changed?.();};
    const cancel=()=>{cleanup();if(state.gesture===gesture)state.gesture=null;renderOverlay();window.CeasefireProject?.changed?.();};
    const cleanup=gesture.cleanup=()=>{element.removeEventListener("pointermove",move);element.removeEventListener("pointerup",finish);element.removeEventListener("pointercancel",cancel);element.removeEventListener("lostpointercapture",cancel);if(element.hasPointerCapture?.(event.pointerId))element.releasePointerCapture(event.pointerId);};
    element.addEventListener("pointermove",move);element.addEventListener("pointerup",finish);element.addEventListener("pointercancel",cancel);element.addEventListener("lostpointercapture",cancel);element.setPointerCapture?.(event.pointerId);event.preventDefault();
  }
  async function continueStamp(id) {
    const intent=()=>JSON.stringify([stampKey(),state.tool,state.graphicSelected,state.signatureSelected,state.annotationSelected,[...state.selected],[...state.physicalSelected],state.settingsOpen,state.settingsEditor?.key]), before=intent();
    await flushSettings();requireFinishedEdits();
    if(before!==intent()) throw new Error("The drawing or selection changed. Select the Stamp again.");
    const value=records().find(v=>v.id===id && v.kind==="stamp" && signatureInWorkspace(v) && v.document_id===state.document && v.page===state.page);
    if(!value || state.tool!=="select") throw new Error("Select a current Stamp to continue.");
    const context=stampKey(), version=value.version;
    await activate("stamp");
    const current=records().find(v=>v.id===id);
    if(context!==stampKey() || state.tool!=="graphic-stamp" || current?.version!==version) throw new Error("The Stamp changed. Select it again.");
    state.stampTemplate={key:context,geometry:clone(current.geometry),text:current.text,appearance:clone(current.appearance),...(current.stamp_image?{stamp_image:clone(current.stamp_image)}:{})};
    renderSelection();message("Continue Stamp: click to place copies using its latest settings. Right-click stops.");
  }
  return Object.freeze({records,selected,isTool,activate,activateExclusion,point,finish,select,remove,settings,apply,paint,beginStampBox,hasStampTemplate,cancel,continueStamp,handleKeydown,selectMeasurePoint,editMeasurePoint,editExclusion});
};
