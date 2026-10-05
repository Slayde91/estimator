"use strict";

// Literal, explicitly selected library associations. This module never ranks
// candidates, infers shared openings, or creates a schedule quantity by drawing.
((root) => {
  const copy = value => JSON.parse(JSON.stringify(value));
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
  async function choose(bridge, onlySearch = false) {
    const mode = onlySearch ? {action:"search"} : await bridge.ask("Add Defect", [["action", "Choose item", [["search", "Search Item"], ["new", "New Item"]], "new", true]],
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
          let offset=0,total=0;
          const load=async()=>{
            const token=++generation;controller?.abort();controller=new root.AbortController();select.disabled=true;select.replaceChildren();ready(false);info.textContent="Searching library…";
            try {
              const url=`/api/libraries/penetration?${new URLSearchParams({search:input.value.slice(0,200),offset:String(offset),limit:"100"})}`;
              const response=await root.fetch(url,{cache:"no-store",signal:controller.signal}),data=await response.json();
              if(!response.ok)throw new Error(data.error||"Library search failed.");if(closed||token!==generation)return;
              if(!Array.isArray(data.items))throw new Error("Library search returned invalid results.");total=data.total;
              const placeholder=doc.createElement("option");placeholder.value="";placeholder.textContent=data.items.length?"Select a library item":"No matching items";select.append(placeholder);
              for(const item of data.items){const option=doc.createElement("option");option.value=item.id;option.textContent=`${item.library_id||item.id} · ${item.title||"Firestopping item"}`;select.append(option);}
              select.disabled=!data.items.length;info.textContent=data.items.length?`Showing ${offset+1}–${offset+data.items.length} of ${total} items.`:"No matching items. Refine the search or Cancel and choose New Item.";previous.disabled=offset===0;next.disabled=offset+data.items.length>=total;
            }catch(error){if(closed||token!==generation||error.name==="AbortError")return;info.textContent=error.message;select.disabled=true;ready(false);}
          };
          input.addEventListener("input",()=>{++generation;controller?.abort();offset=0;select.disabled=true;select.replaceChildren();ready(false);root.clearTimeout(timer);timer=root.setTimeout(()=>void load(),250);});
          select.addEventListener("change",()=>{const valid=!closed&&!select.disabled&&!!select.value&&[...select.options].some(option=>option.value===select.value);ready(valid);if(valid){const submit=select.form?.querySelector('button[type="submit"]');if(submit&&!submit.disabled)select.form.requestSubmit(submit);}});previous.addEventListener("click",()=>{offset=Math.max(0,offset-100);void load();});next.addEventListener("click",()=>{offset+=100;void load();});
          await load();
        });
      if(!selected)return null;return {kind:"library",record:await record(selected.library_id)};
    }finally{closed=true;++generation;controller?.abort();root.clearTimeout(timer);}
  }
  function assignment(scope, library, memberIds, installation = null) {
    return {id:root.crypto.randomUUID(),scope,library_id:library.id,library_fingerprint:library.metadata_sha256,
      member_ids:[...memberIds],installation:installation || {id:root.crypto.randomUUID(),mode:"repeated_installations",note:""}};
  }
  function status(snapshot, value, library = null) {
    const graph = value.scope === "service_plans" ? snapshot.service_plans || snapshot.physical : snapshot.physical;
    const entries = new Map([...(graph?.defects||[]),...(graph?.barriers||[]),...(graph?.services||[])].map(entity=>[entity.id,entity]));
    if (value.members.some(member=>!entries.has(member.id) || entries.get(member.id).deleted || entries.get(member.id).revision!==member.revision)) return "needs_recheck";
    if (library && library.metadata_sha256!==value.library.metadata_sha256) return "needs_recheck";
    return value.state;
  }
  function description(value) {
    return `${value.library.library_id} · ${value.library.title}\n${value.members.length} explicit physical members · ${value.installation.mode === "combined_installation" ? "one explicitly combined installation" : "explicit repeated installations"}\nCaptured library revision ${value.library.revision} · ${value.state === "confirmed" ? "Retained commercial confirmation" : "Needs commercial review"}. Current library metadata is checked before the next commercial change. Physical draft remains unapproved.`;
  }
  const api={choose,record,assignment,status,description,copy};
  if (typeof module!=="undefined" && module.exports) module.exports=api;
  else root.CeasefireTakeoffLibraryLinks=api;
})(globalThis);
