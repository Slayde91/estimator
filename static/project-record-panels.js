(() => {
  "use strict";
  const host = document.getElementById("project-workspace-links");
  if (!host) return;
  const resourcesHost = document.createElement("div"), documentsHost = document.createElement("div");
  resourcesHost.className = documentsHost.className = "project-record-panels";
  resourcesHost.id = "project-record-resources"; documentsHost.id = "project-linked-documents";
  const anchor = document.getElementById("project-participants-panel") || document.getElementById("project-pricing-notice");
  anchor.before(resourcesHost,documentsHost);
  let selected = null, generation = 0, resources = null, controller = null, retry = null;
  const kinds = [["quote","Linked Quotes"],["work_order","Linked Work Orders"],["purchase_order","Linked Purchase Orders"]];
  const panels = new Map();
  function ui(tag, source) {
    const node = document.createElement(tag); node.textContent = source;
    window.CeasefireI18n?.text(node,source); return node;
  }
  const status = ui("p",""); status.className = "helper project-link-status"; status.setAttribute("role","status");
  for (const [kind,label] of kinds) {
    const panel = document.createElement("details"); panel.className = "card commercial-side-panel"; panel.open = true;
    panel.dataset.documentKind = kind; panels.set(kind,{panel,label}); documentsHost.append(panel);
  }
  const refresh = ui("button","Refresh linked records"); refresh.type = "button"; refresh.className = "button secondary";
  refresh.hidden = true; refresh.onclick = () => void loadDocuments(0);
  documentsHost.append(status,refresh);
  const selector = file => file?.id || (file?.save_token ? "native:" + file.save_token : null);
  const canEdit = () => !window.ClassifireAccess || window.ClassifireAccess.can("edit");
  function message(value) {if(window.CeasefireI18n)window.CeasefireI18n.text(status,value);else status.textContent = value;}
  function resetPanels(cards, known) {
    for (const [kind,{panel,label}] of panels) {
      const rows = cards.filter(card => card.kind === kind), summary = ui("summary",label);
      if (known) summary.append(document.createTextNode(` (${rows.length})`));
      const expanded = panel.open; panel.replaceChildren(summary); panel.open = expanded;
      for (const card of rows) {
        const label = [card.reference || card.last_number,card.fields?.title].filter(Boolean).join(" · ") || card.kind;
        const open = document.createElement("button"); open.type = "button"; open.className = "text-button project-title-button"; open.textContent = label;
        const opened = generation;
        open.onclick = async () => {
          if (opened !== generation || !selected || host.inert || resources?.pending() || !await (resources?.leave() ?? true)) return;
          if (opened !== generation || !selected) return;
          open.disabled = true;
          try {await window.CeasefireCommercial.openLinkedCard(card);}
          catch(error) {if(opened === generation)message(error.message);}
          finally {if(open.isConnected)open.disabled = false;}
        };
        panel.append(open);
      }
    }
  }
  async function loadDocuments(attempt = 0) {
    clearTimeout(retry); controller?.abort();
    const opened = generation, file = selected;
    if (!file || !selector(file) || !file.path) {resetPanels([],true);message("");refresh.hidden = true;return;}
    const pending = new AbortController(); controller = pending;
    const timeout = setTimeout(()=>pending.abort(),8000);
    message("Loading…"); refresh.hidden = true;
    try {
      const response = await fetch("/api/commercial/register",{cache:"no-store",signal:pending.signal});
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "The request could not be completed.");
      if (opened !== generation || selected !== file) return;
      if (!Array.isArray(data.documents)) throw Error("Some saved sources are unavailable.");
      const own = data.documents.filter(card => card.source_path === file.path);
      if (file.revision && own.some(card => card.source_revision !== file.revision))
        throw Error("The project changed. Reopen its details before changing participants.");
      resetPanels(own,!data.scan_pending);
      const incomplete = data.scan_pending || data.error_count;
      message(incomplete ? (data.scan_pending && attempt < 3 ? "Loading…" : "Some saved sources are unavailable.") : "");
      refresh.hidden = !incomplete;
      if (data.scan_pending && attempt < 3) retry = setTimeout(()=>{
        if(opened === generation && selected === file)void loadDocuments(attempt + 1);
      },600);
    } catch(error) {
      if(opened !== generation || selected !== file || controller !== pending)return;
      resetPanels([],false); message(error.name === "AbortError" ? "Some saved sources are unavailable." : error.message);refresh.hidden = false;
    } finally {clearTimeout(timeout);if(controller === pending)controller = null;}
  }
  function close() {
    generation++; controller?.abort(); controller = null; clearTimeout(retry);
    resources?.close(); resources = null; selected = null; resourcesHost.replaceChildren();
    resetPanels([],true); message(""); refresh.hidden = true;
  }
  window.ClassifireProjectRecordPanels = {
    show(file) {
      if(selector(file) && selector(file) === selector(selected) && file.source_project_id === selected.source_project_id) {
        if(file.path === selected.path && file.revision === selected.revision)return;
        selected = file; void loadDocuments(); return;
      }
      close(); selected = file || null;
      const opened = generation;
      resources = window.ClassifireRecordResources.attach(resourcesHost,{
        owner:selector(file) ? {kind:"projects",id:selector(file),project_id:file.source_project_id} : null,
        isCurrent:()=>opened === generation && !host.hidden && host.isConnected,
        canEdit, showRefresh:false, message:value=>message(value)
      });
      resetPanels([],!selector(file)); void loadDocuments();
    },
    close, pending:()=>resources?.pending() || false,
    dirty:()=>resources?.dirty() || false,
    fingerprint:()=>resources?.fingerprint() || "",
    leave:async()=>await (resources?.leave() ?? true)
  };
})();
