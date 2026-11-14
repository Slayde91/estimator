(() => {
  'use strict';
  const labels = {logo:'Company logo', workspace:'Company name', text:'Custom text', image:'Attachment image',
    template_id:'Template ID',template_version:'Template version',form_version:'Form version',author:'Created by',
    record_id:'Record ID',generated_at:'Print date and time',disclaimer:'Print disclaimer'};
  const el=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};
  function button(text,action) {const b=el('button',text);b.type='button';b.className='button secondary';b.addEventListener('click',action);return b;}
  function select(items,value,change,label) {
    const s=el('select');s.setAttribute('aria-label',label);
    for(const [id,name] of items) s.append(new Option(name,id,false,value===id));
    s.addEventListener('change',()=>change(s.value));return s;
  }
  function edit(host,settings,changed) {
    const validImages=(settings.attachments || []).filter(x=>['image/png','image/jpeg','image/webp'].includes(x.type));
    let dragging=null;
    function render() {
      host.replaceChildren();
      for (const [key,title] of [['header_layout','Header elements'],['footer_layout','Footer elements']]) {
        const list=settings[key] || [], section=el('fieldset');section.className='forms-layout-controls';
        section.append(el('legend',title));
        function update(mutator) { settings[key]=list;mutator();changed();render(); }
        function move(from,to) { if(to<0 || to>=list.length || from===to)return;update(()=>list.splice(to,0,list.splice(from,1)[0])); }
        list.forEach((item,i)=>{
          const row=el('div');row.className='forms-layout-row';row.draggable=true;row.append(el('strong',labels[item.kind]));
          row.addEventListener('dragstart',e=>{dragging={key,i};e.dataTransfer.setData('text/plain',title);e.dataTransfer.effectAllowed='move';});
          row.addEventListener('dragend',()=>dragging=null);
          row.addEventListener('dragover',e=>{if(dragging?.key===key)e.preventDefault();});
          row.addEventListener('drop',e=>{if(dragging?.key!==key)return;e.preventDefault();move(dragging.i,i);dragging=null;});
          row.append(select([['left','Left'],['center','Centre'],['right','Right']],item.align,v=>{item.align=v;changed();},'Alignment'));
          for(const [name,kind,offset] of [['Move up','up',-1],['Move down','down',1]]) {
            const b=window.ClassifireFormControls.iconButton(name,kind,()=>move(i,i+offset));
            b.disabled=i+offset<0 || i+offset>=list.length;row.append(b);
          }
          row.append(window.ClassifireFormControls.iconButton('Remove','remove',()=>update(()=>list.splice(i,1))));
          if(item.kind==='text') {
            const field=el('input');field.maxLength=250;field.value=item.text || '';field.setAttribute('aria-label','Custom text');
            field.addEventListener('input',()=>{item.text=field.value;});field.addEventListener('change',changed);row.append(field);
          }
          if(item.kind==='image') row.append(select([['','Choose image'],...validImages.map(f=>[f.name,f.name])],item.image || '',v=>{item.image=v;changed();},'Attachment image'));
          section.append(row);
        });
        const add=el('div');add.className='actions';
        const pick=select(Object.entries(labels),'logo',()=>{},title+' to add');
        const insert=button('Add element',()=>update(()=>list.push({kind:pick.value,align:'left'})));insert.disabled=list.length>=20;
        add.append(pick,insert);section.append(add);host.append(section);
      }
    }
    render();
  }
  function render(host,key,t,entry,printedAt) {
    const items=t.settings?.[key];if(!items?.length)return;
    const box=el('div');box.className='forms-layout-output';
    const values={workspace:document.getElementById('company-name')?.value || 'CLASSIFIRE',template_id:t.settings?.display_id || t.id,
      template_version:t.version || 'Draft',form_version:entry?.version || 'Draft',author:entry?.created_by_name || '—',record_id:entry?.id || '—',
      generated_at:printedAt ? window.ClassifireDates.dateTime(printedAt) : '—',disclaimer:'Printed version is uncontrolled'};
    for(const item of items) {
      const row=el('div');row.className='forms-align-'+(['left','right','center'].includes(item.align)?item.align:'left');
      if(item.kind==='logo' || item.kind==='image') {
        const file=(t.settings.attachments || []).find(f=>f.name===item.image && ['image/png','image/jpeg','image/webp'].includes(f.type));
        const url=item.kind==='logo' ? (document.getElementById('company-logo-preview')?.getAttribute('src') || '/classifire-logo.png')
          : file && 'data:'+file.type+';base64,'+file.data.slice(file.data.indexOf(',')+1);
        if(!url)continue;
        const image=el('img');image.alt=item.kind==='logo'?'Company logo':file.name;image.src=url;row.append(image);
      } else if(item.kind==='text') row.textContent=item.text || '';
      else if(Object.hasOwn(values,item.kind)) row.textContent=['workspace','disclaimer'].includes(item.kind)?values[item.kind]:labels[item.kind]+' · '+values[item.kind];
      box.append(row);
    }
    host.append(box);
  }
  window.ClassifireFormsLayout={edit,render};
})();
