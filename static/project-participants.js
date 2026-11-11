(() => {
  'use strict';
  const pane=document.getElementById('project-details-pane');
  if(!pane)return;
  const el=(tag,text)=>{const item=document.createElement(tag);if(text!==undefined)item.textContent=text;return item;};
  const ui=(tag,text)=>{const item=el(tag,text);window.CeasefireI18n?.text(item,text);return item;};
  const field=(name,input)=>{
    const label=el('label');label.className='field';
    input.setAttribute('aria-label',name);window.CeasefireI18n?.attr(input,'aria-label',name);
    label.append(ui('span',name),input);return label;
  };
  const input=(length,type='text')=>{const node=el('input');node.type=type;node.maxLength=length;return node;};
  const button=(name,run)=>{const node=ui('button',name);node.type='button';node.className='button secondary';node.addEventListener('click',run);return node;};
  const box=el('details');box.id='project-participants-panel';box.hidden=true;
  const head=ui('summary','Participants and linked sites'),body=el('div'),notice=el('p');
  notice.setAttribute('role','status');notice.className='helper';box.append(head,notice,body);pane.append(box);
  let selection=null,fileRevision=null,record=null,directory=null,generation=0,busy=false,loading=false;
  const announce=msg=>{notice.textContent=msg;window.CeasefireI18n?.text(notice,msg);};
  async function api(path, data){
    const response=await fetch('/api/'+path,data===undefined?{cache:'no-store'}:{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    const value=await response.json();
    if(!response.ok)throw Error(value.error || 'The request could not be completed.');
    return value;
  }
  function option(select,value,label,translate=false){
    const item=translate?ui('option',label):el('option',label);item.value=value;select.append(item);
  }
  function roleText(role){return record.roles[role] || role;}
  function bidList(entries){
    const list=el('ul');
    for(const item of entries){
      const row=el('li',[item.project_no,item.client,item.site_address].filter(Boolean).join(' · '));
      if(item.availability==='unavailable')row.append(' · ',ui('small','Saved project unavailable'));
      if(item.availability==='unverified')row.append(' · ',ui('small','Availability not yet verified'));
      list.append(row);
    }
    return list;
  }
  function canEdit(){return !window.ClassifireAccess || window.ClassifireAccess.can('edit');}
  function compactRows(){return record.participants.map(({role,kind,id})=>({role,kind,id}));}
  async function mutate(operation){
    if(!selection || !record || busy || !canEdit())return;
    const ticket=generation;busy=true;render();
    try{await operation(ticket);if(ticket===generation)announce('Saved');}
    catch(error){if(ticket===generation)announce(error.message);}
    finally{if(ticket===generation){busy=false;render();}}
  }
  async function save(rows,site,ticket){
    const updated=await api('crm/project-participants',{project:selection,project_revision:record.project_revision,
      version:record.version,participants:rows,site_id:site});
    if(ticket===generation)record=updated;
  }
  async function load(){
    if(!selection || loading || busy)return;
    const ticket=generation;loading=true;announce('Loading…');
    try{
      await window.ClassifireAccess?.ready;
      const editable=canEdit();
      const [data,people]=await Promise.all([api('crm/project-participants?project='+encodeURIComponent(selection)),
        editable?api('contacts/directory'):Promise.resolve(null)]);
      if(ticket!==generation)return;
      if(fileRevision && data.project_revision!==fileRevision)throw Error('The project changed. Reopen its details before changing participants.');
      record=data;directory=people;announce('');render();
    }catch(error){if(ticket===generation){announce(error.message);body.replaceChildren(button('Refresh',load));}}
    finally{if(ticket===generation)loading=false;}
  }
  function render(){
    body.replaceChildren();
    if(!record)return;
    const editable=canEdit() && directory;
    const parties=el('ul');
    record.participants.forEach((item,index)=>{
      const row=el('li');row.append(ui('strong',roleText(item.role)),document.createTextNode(' · '+item.label));
      if(editable){
        const remove=button('Remove',()=>mutate(ticket=>save(compactRows().filter((_,i)=>i!==index),record.site_id,ticket)));
        remove.disabled=busy;row.append(' ',remove);
      }
      parties.append(row);
    });
    body.append(ui('h3','Project participants'),parties);
    if(!record.participants.length)body.append(ui('p','No additional participants.'));
    if(editable){
      const role=el('select'),kind=el('select'),find=input(240,'search'),results=el('select');
      for(const [key,label] of Object.entries(record.roles))option(role,key,label,true);
      option(kind,'accounts','Company',true);option(kind,'contacts','Contact',true);
      function matches(){
        const needle=find.value.trim().toLocaleLowerCase();results.replaceChildren();option(results,'','Choose a directory record',true);
        const candidates=directory[kind.value].map(item=>({id:item.id,label:kind.value==='accounts'?item.company:[item.name,item.company,item.email,item.phone].filter(Boolean).join(' · ')}));
        for(const item of candidates.filter(item=>item.label.toLocaleLowerCase().includes(needle)).slice(0,100))option(results,item.id,item.label);
      }
      kind.onchange=matches;find.oninput=matches;matches();
      const controls=el('fieldset');controls.disabled=busy;
      controls.append(field('Role',role),field('Record type',kind),field('Search directory',find),field('Participant',results),
        button('Add participant',()=>{if(!results.value){announce('Choose a directory record');return;}
          const rows=[...compactRows(),{role:role.value,kind:kind.value,id:results.value}];
          void mutate(ticket=>save(rows,record.site_id,ticket));}));
      body.append(controls);
    }
    body.append(ui('h3','Linked Sites'));
    const linkedSites=record.linked_sites || [record.site].filter(Boolean);
    for(const site of linkedSites){
      const row=el('p',[...new Set([site.name,site.address].filter(Boolean))].join(' · '));
      row.dataset.linkedSiteId=site.id;body.append(row);
    }
    if(!linkedSites.length)body.append(ui('p','No linked sites.'));
    if(record.site_mode==='automatic')body.append(ui('p','Bids with the same site address are linked automatically.'));
    if(record.linked_bids.length){
      body.append(ui('h4','Other bids linked to this site'),bidList(record.linked_bids));
    }
    {
      const controls=el('fieldset'),find=input(1200,'search'),results=el('div'),scan=el('p');controls.disabled=busy;
      results.className='project-site-results';scan.className='helper';scan.setAttribute('role','status');
      find.value=document.getElementById('project-pane-address')?.value || record.site_address || '';
      let ticket=0,offset=0,timer;
      const more=button('Show more',()=>void loadSites(true));more.hidden=true;
      async function loadSites(append=false){
        const request=++ticket;
        if(!append){offset=0;results.replaceChildren();}
        window.CeasefireI18n?.text(scan,'Loading…');scan.textContent ||= 'Loading…';
        const search=find.value;
        try{
          const data=await api('crm/sites?search='+encodeURIComponent(search)+'&offset='+offset);
          if(request!==ticket || !controls.isConnected || search!==find.value)return;
          for(const site of data.sites){
            const card=el('article');card.className='project-site-result';card.dataset.siteId=site.id;
            card.append(el('strong',site.name));
            if(site.address!==site.name)card.append(el('p',site.address));
            results.append(card);
          }
          offset+=data.sites.length;more.hidden=!data.more;
          scan.textContent='';
          if(data.scan_pending || data.error_count)window.CeasefireI18n?.text(scan,'Some saved projects are still being checked. Refresh to include more addresses.');
          if(!offset && !data.scan_pending && !data.error_count)window.CeasefireI18n?.text(scan,'No matching site addresses.');
        }catch(error){if(request===ticket && controls.isConnected){scan.textContent='';announce(error.message);}}
      }
      find.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(()=>void loadSites(),180);});
      controls.append(field('Search site addresses',find),results,scan,more);
      if(editable && record.site_id)controls.append(button('Use site address',()=>void mutate(ticket=>save(compactRows(),null,ticket))));
      body.append(controls);
      if(!busy)void loadSites();
    }
    const refresh=button('Refresh',load);refresh.disabled=busy;body.append(refresh);
  }
  function close(){
    ++generation;selection=null;fileRevision=null;record=null;directory=null;busy=false;loading=false;
    box.open=false;box.hidden=true;body.replaceChildren();announce('');
  }
  box.addEventListener('toggle',()=>{if(box.open && !record)void load();});
  window.ClassifireProjectParticipants={close,pending:()=>busy,show:file=>{
    close();if(!file)return;
    selection=file.id || (file.save_token?'native:'+file.save_token:null);fileRevision=file.revision;box.hidden=!selection;
  }};
})();
