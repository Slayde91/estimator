"use strict";

// Literal, explicitly selected library associations. This module never ranks
// candidates, infers shared openings, or creates a schedule quantity by drawing.
((root) => {
  const copy = value => JSON.parse(JSON.stringify(value));
  const literal = value => typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").trim() : "";
  const displayFields = record => record?.display_fields && typeof record.display_fields === "object" && !Array.isArray(record.display_fields) ? record.display_fields : {};
  function libraryLabel(item) {
    const fields = displayFields(item);
    return [item.library_id || item.id, fields.penetration_type, fields.substrate, fields.orientation, fields.service_type, fields.frl]
      .map(value => literal(value) || "Unknown").join("; ");
  }
  function itemQuantity(value) {
    const scalar = typeof value === "number" || typeof value === "string" && /^\d+(?:\.0+)?$/.test(value.trim());
    const quantity = scalar ? Number(value) : NaN;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1e12) throw new Error("Enter a positive integer Item QTY of at most 1000000000000.");
    return quantity;
  }
  async function request(url) {
    const reply = await root.fetch(url, { cache: "no-store" });
    const value = await reply.json();
    if (!reply.ok) throw new Error(value.error || "The Firestopping Library is unavailable.");
    return value;
  }
  async function record(id) {
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,119}$/.test(id)) throw new Error("Select a valid library item.");
    const value = await request(`/api/libraries/penetration/${encodeURIComponent(id)}/takeoff`);
    if (value.id !== id || !value.import_fields || !/^[a-f0-9]{64}$/.test(value.metadata_sha256)) throw new Error("The selected library metadata is incomplete.");
    return value;
  }
  async function choose(bridge, onlySearch = false, context = {}) {
    const mode = onlySearch ? {action:"search"} : await bridge.ask(context.title || "Add Defect", [["action", "Choose item", [["search", "Search Item"], ["new", "New Item"]], "new", true]],
      "Search Item imports the fields of one explicitly selected Firestopping Library item into an unapproved draft. New Item creates your own physical draft. Neither action changes the Firestopping Schedule.", "Continue");
    if (!mode) return null;
    if (mode.action === "new") return { kind: "new" };
    if (mode.action !== "search") throw new Error("Choose Search Item or New Item.");
    let generation=0,timer=null,controller=null,closed=false;
    try {
      const selected=await bridge.ask("Search Firestopping Library",[["search","Search library items","text",""],["library_id","Library item",[["","Type to search, then select an item"]],"",true]],
        "Choose an item yourself. Selection imports its editable physical draft fields immediately. Search does not establish technical applicability or approval; the schedule stays unchanged until Confirm link and quantity.","Use selected item",async (controls,ready)=>{
          const input=controls.find(field=>field.control.name==="search").control,select=controls.find(field=>field.control.name==="library_id").control,doc=input.ownerDocument;
          input.maxLength=200;const info=doc.createElement("p");info.className="helper";info.setAttribute("role","status");select.after(info);
          const previous=doc.createElement("button"),next=doc.createElement("button");for(const button of [previous,next]){button.type="button";button.className="button secondary";info.after(button);}previous.textContent="Previous results";next.textContent="Next results";
          const facets=doc.createElement("div");facets.className="library-filters";input.closest("label")?.after(facets);
          let offset=0,total=0;const filters={},facetControls=new Map();
          const renderFacets=data=>{
            const definitions=(Array.isArray(data.filters)?data.filters:[]).filter(value=>typeof value.key==="string"&&!['search','offset','limit','technical_reference'].includes(value.key));
            if(definitions.length>20)throw new Error("Library returned too many filter facets.");
            for(const definition of definitions){
              if(!/^[a-z][a-z0-9_]{0,79}$/.test(definition.key)||!Array.isArray(definition.options)||definition.options.length>10000)throw new Error("Library returned an invalid filter facet.");
              let field=facetControls.get(definition.key);
              if(!field){const label=doc.createElement("label"),caption=doc.createElement("span"),control=doc.createElement("select");label.className="field";caption.textContent=definition.label||definition.key;control.name=`library_filter_${definition.key}`;control.setAttribute("aria-label",definition.label||definition.key);control.dataset.libraryFilter=definition.key;label.append(caption,control);facets.append(label);field={control,stamp:null};facetControls.set(definition.key,field);control.addEventListener("change",()=>{filters[definition.key]=control.value;offset=0;void load();});}
              const options=[{value:"",label:`All ${definition.label||definition.key}`},...definition.options.map(option=>typeof option==="object"?option:{value:option,label:option})];
              const selectedValue=filters[definition.key]||"";if(selectedValue&&!options.some(option=>String(option.value)===selectedValue))options.push({value:selectedValue,label:selectedValue});
              const stamp=JSON.stringify([options,selectedValue]);if(field.stamp!==stamp){field.stamp=stamp;field.control.replaceChildren(...options.map(option=>{const value=doc.createElement("option");value.value=String(option.value);value.textContent=String(option.label??option.value);return value;}));field.control.value=selectedValue;}
            }
          };
          const load=async()=>{
            const token=++generation;controller?.abort();controller=new root.AbortController();select.disabled=true;select.replaceChildren();ready(false);info.textContent="Searching library…";
            try {
              const query={search:input.value.slice(0,200),offset:String(offset),limit:"100"};for(const [key,value]of Object.entries(filters))if(value)query[key]=value;
              const url=`/api/libraries/penetration?${new URLSearchParams(query)}`;
              const response=await root.fetch(url,{cache:"no-store",signal:controller.signal}),data=await response.json();
              if(!response.ok)throw new Error(data.error||"Library search failed.");if(closed||token!==generation)return;
              if(!Array.isArray(data.items)||!Number.isInteger(data.total)||data.total<0)throw new Error("Library search returned invalid results.");total=data.total;renderFacets(data);
              const placeholder=doc.createElement("option");placeholder.value="";placeholder.textContent=data.items.length?"Select a library item":"No matching items";select.append(placeholder);
              for(const item of data.items){const option=doc.createElement("option");option.value=item.id;option.textContent=libraryLabel(item);select.append(option);}
              select.disabled=!data.items.length;info.textContent=data.items.length?`Showing ${offset+1}–${offset+data.items.length} of ${total} items.`:"No matching items. Refine the search or Cancel and choose New Item.";previous.disabled=offset===0;next.disabled=offset+data.items.length>=total;
            }catch(error){if(closed||token!==generation||error.name==="AbortError")return;info.textContent=error.message;select.disabled=true;ready(false);}
          };
          input.addEventListener("input",()=>{++generation;controller?.abort();offset=0;select.disabled=true;select.replaceChildren();ready(false);root.clearTimeout(timer);timer=root.setTimeout(()=>void load(),250);});
          select.addEventListener("change",()=>{const valid=!closed&&!select.disabled&&!!select.value&&[...select.options].some(option=>option.value===select.value);ready(valid);if(valid){const submit=select.form?.querySelector('button[type="submit"]');if(submit&&!submit.disabled)select.form.requestSubmit(submit);}});previous.addEventListener("click",()=>{offset=Math.max(0,offset-100);void load();});next.addEventListener("click",()=>{offset+=100;void load();});
          await load();
        });
      if(!selected)return null;
      const library=await record(selected.library_id),knownLocation=[context.location,library.import_fields.defect?.location,library.import_fields.barrier?.location].find(value=>typeof value==="string"&&value.trim()) || "";
      const fields=[...(!knownLocation.trim() ? [["location","Location","text","",true]] : []),["quantity","Item QTY","number","",true]];
      const details=await bridge.ask("Complete selected item details",fields,
        `${libraryLabel(library)}\n${knownLocation ? `Location: ${knownLocation}\n` : ""}Enter the missing item details. Item QTY is the explicit positive integer ${library.import_fields.service ? "physical service count" : "blank seal count"}. Separate repeated installations use the recorded counts; one explicitly combined installation contributes 1. The Firestopping Schedule changes only after you review and confirm the transfer.`,"Use item details",controls=>{
          for(const field of controls){if(field.control.name==="location")field.control.maxLength=2000;if(field.control.name==="quantity"){field.control.min="1";field.control.max="1000000000000";field.control.step="1";}}
        });
      if(!details)return null;
      const quantity=itemQuantity(details.quantity),location=knownLocation || String(details.location || "").trim();
      if(!location.trim()||location.length>2000)throw new Error("Enter a Location of at most 2000 characters.");
      return {kind:"library",record:library,details:{item_quantity:quantity,draft_quantity:quantity,draft_location:location}};
    }finally{closed=true;++generation;controller?.abort();root.clearTimeout(timer);}
  }
  const barrierFields=["barrier_type","substrate","orientation"];
  const barrierNames={barrier_type:"Barrier type (library Penetration type)",substrate:"Substrate",orientation:"Orientation"};
  function barrierDifferences(fields,selected){return barrierFields.filter(key=>selected[key]&&selected[key]!==fields[key]).map(key=>({field:key,selected:selected[key],retained:fields[key]||""}));}
  function barrierLabel(barrier){return `${barrier.display_id||barrier.id} · ${barrier.fields.barrier_type||"Unknown type"} · ${barrier.fields.substrate||"Unknown substrate"} · ${barrier.fields.orientation||"Unknown orientation"}`;}
  async function addUnderPhysical(bridge,context,guard=()=>{}){
    const servicePlans=context.scope==="service_plans",owner=servicePlans?context.barrier:context.defect;
    if(!owner||!Array.isArray(context.barriers)||!Array.isArray(context.selectedIds)||!context.selectedIds.length)throw new Error("Select records belonging to one current physical owner.");
    if(servicePlans&&(context.barriers.length!==1||context.barriers[0].id!==owner.id))throw new Error("Select records belonging to one current Service Plans Barrier.");
    guard();
    const first=await bridge.ask("Choose barrier for library item",[["choice","Barrier choice",[["new","New Barrier"],["existing","Existing Barrier"]],"new",true]],
      servicePlans?`Append one explicitly selected library item in the context of ${owner.display_id||owner.id}. New Barrier creates a new unplaced root, adopts the selected literal library Penetration type, substrate, orientation, FRL and location, and copies no marker or source. Existing Barrier retains all its current properties and source location. The new service attaches to the chosen Barrier. Neither action changes the schedule or approves technical applicability.`:
      `Append one explicitly selected library item under ${owner.display_id||owner.id}. New Barrier adopts the selected literal library Penetration type, substrate and orientation. Existing Barrier retains all its current properties and source location. Neither action changes the schedule or approves technical applicability.`,"Continue");
    if(!first)return null;guard();
    let barrier=null;
    if(first.choice==="existing"){
      if(!context.barriers.length)throw new Error("This physical owner has no active existing barrier. Choose New Barrier.");
      let offset=0;
      while(!barrier){
        const options=context.barriers.slice(offset,offset+100).map(value=>[value.id,barrierLabel(value)]);if(offset)options.unshift(["previous","Previous 100 barriers"]);if(offset+100<context.barriers.length)options.push(["next","Next 100 barriers"]);
        const chosen=await bridge.ask("Choose Existing Barrier",[["barrier_id","Existing Barrier",options,"",true]],`Choose an explicit Barrier ${servicePlans?"in the selected context":"under"} ${owner.display_id||owner.id}. Showing ${offset+1}–${Math.min(offset+100,context.barriers.length)} of ${context.barriers.length} barriers.`,"Use Existing Barrier");
        if(!chosen)return null;guard();if(chosen.barrier_id==="previous")offset-=100;else if(chosen.barrier_id==="next")offset+=100;else{barrier=context.barriers.find(value=>value.id===chosen.barrier_id);if(!barrier)throw new Error("Choose one current barrier in the selected physical context.");}
      }
    }else if(first.choice!=="new")throw new Error("Choose New Barrier or Existing Barrier.");
    for(;;){
      const selected=await choose(bridge,true,{location:barrier?.fields.location || (!servicePlans?owner.fields.location:"") || ""});if(!selected)return null;guard();
      const differences=barrier?barrierDifferences(barrier.fields,selected.record.import_fields.barrier):[];
      if(differences.length){
        const proceed=await bridge.confirm("Library barrier mismatch",`${barrierLabel(barrier)}\n\n${differences.map(value=>`${barrierNames[value.field]}: Existing Barrier = ${value.retained||"Unknown"}; selected library = ${value.selected}`).join("\n")}\n\nContinue keeps the Existing Barrier, its ID and source location unchanged. Only the selected new service/item is added as an unapproved draft, with this explicit mismatch retained for review. No physical approval or schedule quantity is created. Cancel returns to library search without changing the project.`,"Continue");
        guard();if(!proceed)continue;
      }
      const library=selected.record,ids={barrier:barrier?null:root.crypto.randomUUID(),service:library.import_fields.service?root.crypto.randomUUID():null,assignment:root.crypto.randomUUID(),installation:root.crypto.randomUUID()};
      const ownership=servicePlans?{context_barrier_id:owner.id,context_barrier_revision:owner.revision}:{defect_id:owner.id,defect_revision:owner.revision};
      const proposal={version:1,scope:context.scope,...ownership,selected_ids:[...context.selectedIds],barrier_id:barrier?.id||null,barrier_revision:barrier?.revision??null,library_id:library.id,library_fingerprint:library.metadata_sha256,accept_mismatch:!!differences.length,ids,...selected.details};
      guard();const reply=await bridge.libraryCommand("import_library_item",{import:proposal});
      return {reply,selected_id:ids.service||barrier?.id||ids.barrier,assignment_id:ids.assignment};
    }
  }
  function addUnderDefect(bridge,context,guard){
    if(context.scope!=="defect_reports")throw new Error("Select records belonging to one current Defect.");
    return addUnderPhysical(bridge,context,guard);
  }
  function addUnderServicePlans(bridge,context,guard){
    if(context.scope!=="service_plans")throw new Error("Select records belonging to one current Service Plans Barrier.");
    return addUnderPhysical(bridge,context,guard);
  }
  function assignment(scope, library, memberIds, installation = null, details = {}) {
    const {item_quantity, ...retained} = details;
    const supplied = Object.prototype.hasOwnProperty.call(details, "item_quantity"), quantity = supplied ? itemQuantity(item_quantity) : null;
    const source = supplied ? {
      quantity_source: library.import_fields.service ? {version:1,kind:"services"} : {version:1,kind:"blank_seals",quantity}
    } : {};
    return {id:root.crypto.randomUUID(),scope,library_id:library.id,library_fingerprint:library.metadata_sha256,
      member_ids:[...memberIds],installation:installation || {id:root.crypto.randomUUID(),mode:"repeated_installations",note:""},...retained,...source};
  }
  function status(snapshot, value, library = null) {
    const graph = value.scope === "service_plans" ? snapshot.service_plans || snapshot.physical : snapshot.physical;
    const entries = new Map([...(graph?.defects||[]),...(graph?.barriers||[]),...(graph?.services||[])].map(entity=>[entity.id,entity]));
    if (value.members.some(member=>!entries.has(member.id) || entries.get(member.id).deleted || entries.get(member.id).revision!==member.revision)) return "needs_recheck";
    if (library && library.metadata_sha256!==value.library.metadata_sha256) return "needs_recheck";
    return value.state;
  }
  function matchingRecord(value, record) {
    return !!record && record.id === value.library.id && record.metadata_sha256 === value.library.metadata_sha256;
  }
  function description(value, record = null) {
    const fields = matchingRecord(value, record) ? displayFields(record) : {};
    return [literal(value.library.library_id) || "Unknown", ...[["service_type","Service Type"],["penetration_type","Penetration Type"],["substrate","Substrate"],["orientation","Orientation"],["service_size","Service size"]]
      .map(([key,label]) => `${label}: ${literal(fields[key]) || "Unknown"}`)].join("\n");
  }
  const api={choose,record,assignment,status,description,matchingRecord,libraryLabel,copy,barrierDifferences,barrierLabel,addUnderDefect,addUnderServicePlans};
  if (typeof module!=="undefined" && module.exports) module.exports=api;
  else root.CeasefireTakeoffLibraryLinks=api;
})(globalThis);
