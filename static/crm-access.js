(() => {
  'use strict';
  let session={enabled:true,user:null,version:1}, resolveReady;
  const ready=new Promise(resolve=>resolveReady=resolve);
  const nativeFetch=window.fetch.bind(window);
  window.fetch=async (input,options={})=>{
    const url=new URL(typeof input==='string' || input instanceof URL ? input : input.url,location.href);
    const method=(options.method || (typeof input==='object' && input.method) || 'GET').toUpperCase();
    const accessChange=['/api/access/roles','/api/access/settings','/api/access/account-types'].includes(url.pathname);
    const identityRead=['GET','HEAD'].includes(method) && (url.pathname.startsWith('/api/forms/') || ['/api/certifications/defaults','/api/certifications/defaults/legacy','/api/scheduler/bootstrap','/api/numbering-settings','/api/document-numbering','/api/project-details'].includes(url.pathname));
    const mutation=(!['GET','HEAD'].includes(method) || url.pathname==='/api/libraries/technical/new') && (!url.pathname.startsWith('/api/access/') || accessChange) && !url.pathname.startsWith('/api/scheduler/');
    if(url.origin===location.origin && url.pathname.startsWith('/api/') && (identityRead || mutation)){
      await ready;
      const headers=new Headers(options.headers || (typeof input==='object' && input.headers) || {});headers.set('X-CRM-Member',session.user?.id || 'anonymous');options={...options,headers};
    }
    return nativeFetch(input,options);
  };
  const can=permission=>!!session.user && (session.user.role==='admin' ||
    permission==='view' && ['viewer','editor'].includes(session.user.role) ||
    permission==='edit' && session.user.role==='editor');
  let signedOut=false;
  function reloadSession(afterSignOut=false){
    signedOut=afterSignOut;
    if(window.chrome?.webview)window.chrome.webview.postMessage({type:'classifire.staff-session'});
    else location.replace('/');
  }
  function requestClose(nonce){
    const host=window.chrome?.webview;
    if(!host || !/^[a-f0-9]{64}$/.test(nonce))return;
    const auxiliaryPage=document.getElementById('staff-login') || document.getElementById('staff-scheduler-page');
    const allowed=!!auxiliaryPage && !window.CeasefireScheduler?.hasPendingOperation();
    host.postMessage({type:'ceasefire.close',action:'resolve',nonce,allowed});
  }
  window.ClassifireAccess={ready,can,reloadSession,requestClose,get signedOut(){return signedOut;},get user(){return session.user;},get enabled(){return session.enabled;}};
  function el(tag,value,className){const node=document.createElement(tag);if(value!==undefined){node.textContent=value;if(window.CeasefireMessages?.[value])window.CeasefireI18n?.text(node,value);}if(className)node.className=className;return node;}
  function text(node,value){node.textContent=value;window.CeasefireI18n?.text(node,value);}
  function reportError(node,error){
    text(node,error.message);
    node.setAttribute('role','alert');
    window.CeasefireNotifications.presentInline(node,{block:'nearest'});
  }
  async function request(action,body){
    const response=await fetch('/api/access/'+action,{cache:'no-store',...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'Staff access could not be updated.');return data;
  }
  const login=document.getElementById('staff-login');
  if(login){
    const submit=login.querySelector('[type=submit]'),message=document.getElementById('staff-login-message');
    let setup=false;
    async function load(){
      session=await request('session');resolveReady(session);
      if(session.user){reloadSession();return;}
      const bootstrap=await fetch('/api/scheduler/bootstrap',{cache:'no-store'});
      const state=await bootstrap.json();
      if(!bootstrap.ok)throw new Error(state.error || 'Staff access could not be updated.');
      setup=state.setup_required;
      const name=login.elements.namedItem('name');
      name.closest('label').hidden=!setup;name.disabled=!setup;name.required=setup;
      login.elements.password.autocomplete=setup?'new-password':'current-password';
      login.elements.password.minLength=setup?12:0;
      document.getElementById('staff-login-help').hidden=setup;
      text(document.getElementById('staff-login-heading'),setup?'Create administrator account':'Staff sign in');
      text(submit,setup?'Create administrator account':'Sign in');
      submit.disabled=false;
    }
    login.addEventListener('submit',async event=>{
      event.preventDefault();if(submit.disabled)return;submit.disabled=true;
      message.setAttribute('role','status');text(message,'Signing in…');
      window.CeasefireNotifications.presentInline(message,{announce:false});
      try{await request(setup?'setup':'login',{...(setup?{name:login.elements.namedItem('name').value}:{}),
        email:login.elements.email.value,password:login.elements.password.value});login.elements.password.value='';
        reloadSession();
      }catch(error){reportError(message,error);await load().catch(()=>{});}
    });
    load().catch(error=>reportError(message,error)).finally(()=>{resolveReady(session);void window.ClassifireBoot?.ready();});
    return;
  }
  const choices=[['admin','Administrator'],['estimator','Estimator'],['coordinator','Coordinator'],
    ['technician','Technician'],['technician_plus','Technician+']];
  const legacyTypes={editor:'Editor',viewer:'View only',none:'Scheduler only'};
  const typeLabel=member=>choices.find(([key])=>key===member.account_type)?.[1] || legacyTypes[member.role];
  const changes=new Map();
  let renderRevision=0, saving=false;
  async function render(savedMessage=''){
    const card=document.getElementById('settings-team-members');
    if(!card || saving)return;
    const revision=++renderRevision;
    card.hidden=false;
    card.classList.add('staff-access-card');
    const heading=el('div',undefined,'section-heading'),title=el('h2','Team members');
    title.id='team-members-heading';heading.append(title);
    card.replaceChildren(heading);
    const message=el('p','', 'helper');message.setAttribute('role','status');
    if(savedMessage)text(message,savedMessage);
    const actions=el('div',undefined,'actions');
    if(!session.user){
      card.append(el('p','Sign in with a Scheduler staff account to manage access on this computer.'));
      const form=el('form'),email=el('input'),password=el('input'),button=el('button','Sign in','button primary');
      email.type='email';email.autocomplete='username';email.required=true;email.setAttribute('aria-label','Staff email');
      password.type='password';password.autocomplete='current-password';password.required=true;password.setAttribute('aria-label','Staff password');button.type='submit';
      const emailField=el('label',undefined,'field'),passwordField=el('label',undefined,'field');
      emailField.append(el('span','Email'),email);passwordField.append(el('span','Password'),password);form.append(emailField,passwordField,button);
      form.addEventListener('submit',async event=>{event.preventDefault();button.disabled=true;try{session=await request('login',{email:email.value,password:password.value});password.value='';reloadSession();}catch(error){reportError(message,error);button.disabled=false;}});
      card.append(form,message);return;
    }
    card.append(el('p',session.user.name+' · '+typeLabel(session.user)));
    const out=el('button','Sign out','button secondary');out.type='button';
    out.addEventListener('click',()=>window.CeasefireScheduler.openSignOut(out).catch(error=>reportError(message,error)));
    actions.append(out);card.append(actions,message);
    if(session.user.role!=='admin')return;
    const add=el('button','+','button primary icon-only penetration-new-item-action scheduler-primary-action scheduler-toolbar-add');add.type='button';
    add.title='Add team member';add.setAttribute('aria-label',add.title);
    window.CeasefireI18n?.attr(add,'title','Add team member');
    window.CeasefireI18n?.attr(add,'aria-label','Add team member');
    const edit=id=>window.CeasefireScheduler.openTeamMember(id).catch(error=>reportError(message,error));
    add.addEventListener('click',()=>edit(null));heading.append(add);
    try{
      const result=await request('members');
      if(revision!==renderRevision)return;
      const list=el('div',undefined,'scheduler-team'), footer=el('div',undefined,'actions');
      const save=el('button','Save','button primary');save.type='button';
      const controls=[];
      const editable=new Set(result.members.map(member=>member.id));
      for(const id of changes.keys())if(!editable.has(id))changes.delete(id);
      const sync=()=>{
        save.disabled=saving || !changes.size;
        controls.forEach(control=>{control.disabled=saving;});
      };
      for(const member of result.members){
        const memberCard=el('section',undefined,'card'), select=el('select'), label=el('label',undefined,'field team-member-account-type');
        const name=el('h3',member.name), accountType=el('span','Account Type');
        name.id='team-member-name-'+member.id;
        accountType.id='team-member-account-type-'+member.id;
        const editButton=el('button','Edit member','button secondary');editButton.type='button';
        editButton.addEventListener('click',()=>edit(member.id));
        memberCard.append(name,el('p',member.email,'helper'),el('p',member.active?'Active':'Inactive','helper'));
        select.setAttribute('aria-labelledby',name.id+' '+accountType.id);
        if(!member.account_type){
          const current=el('option',typeLabel(member));current.value='';current.disabled=true;current.hidden=true;select.append(current);
        }
        for(const [value,name] of choices){
          const option=el('option',name);option.value=value;select.append(option);
        }
        select.value=changes.get(member.id)?.account_type ?? member.account_type ?? '';
        controls.push(select);
        select.addEventListener('change',()=>{
          if(select.value===member.account_type)changes.delete(member.id);
          else if(changes.has(member.id))changes.get(member.id).account_type=select.value;
          else changes.set(member.id,{member_id:member.id,account_type:select.value,version:member.member_version});
          sync();
        });
        label.append(accountType,select);memberCard.append(label,editButton);list.append(memberCard);
      }
      footer.append(save,message);card.append(list,footer);sync();
      save.addEventListener('click',async()=>{
        if(saving || !changes.size)return;
        saving=true;sync();
        try{
          const result=await request('account-types',{changes:[...changes.values()]});
          changes.clear();saving=false;
          if(result.changed_member_ids.includes(session.user.id)){reloadSession();return;}
          await render('Staff access saved.');
        }catch(error){reportError(message,error);}finally{saving=false;sync();}
      });
      const history=await request('audit');
      if(revision!==renderRevision)return;
      const details=el('details'),summary=el('summary','Access history');details.append(summary);
      const auditScroll=el('div',undefined,'table-scroll'),auditTable=el('table',undefined,'staff-access-table'),auditHead=el('thead'),auditTitles=el('tr'),auditBody=el('tbody');
      for(const label of ['Time','Staff member','Action','Result'])auditTitles.append(el('th',label));auditHead.append(auditTitles);auditTable.append(auditHead,auditBody);auditScroll.append(auditTable);details.append(auditScroll);
      for(const entry of history.requests){const row=el('tr');
        for(const value of [window.ClassifireDates.dateTime(entry.at),entry.actor_name,entry.method+' '+entry.route,entry.status===null?'Outcome unknown':'HTTP '+entry.status]){const cell=el('td');cell.textContent=value;row.append(cell);}auditBody.append(row);}
      if(!history.requests.length)details.append(el('p','No activity recorded.','helper'));
      footer.before(details);
    }catch(error){if(revision===renderRevision)reportError(message,error);}
  }
  window.addEventListener("classifire:team-members-changed", () => { if (can("admin")) void render(); });
  request('session').then(value=>{session=value;resolveReady(value);void render();
    if(value.user?.account_type)document.documentElement.dataset.accountType=value.user.account_type;
    if(value.user?.account_type && value.user.role!=='admin'){
      const settings=document.getElementById('view-settings');
      for(const selector of ['[aria-labelledby="application-settings-heading"]','#company-settings-form',
          '#settings-team-members','[aria-labelledby="google-maps-heading"]']){
        const section=settings?.querySelector(selector)?.closest('.card');
        if(section)section.hidden=true;
      }
      const heading=settings?.querySelector(':scope > .page-heading');
      if(heading){
        const button=el('button','Sign out','button secondary');button.type='button';
        button.addEventListener('click',()=>window.CeasefireScheduler.openSignOut(button));
        heading.append(button);
      }
    }
    if(value.enabled&&value.user?.role==='viewer'){const main=document.querySelector('main');if(main){const banner=el('p','View-only access. An editor is required to save changes.','staff-access-banner');banner.setAttribute('role','status');main.prepend(banner);}}
  }).catch(()=>resolveReady(session));
})();
