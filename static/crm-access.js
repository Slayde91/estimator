(() => {
  'use strict';
  let session={enabled:false,user:null,version:1}, resolveReady;
  const ready=new Promise(resolve=>resolveReady=resolve);
  const nativeFetch=window.fetch.bind(window);
  window.fetch=async (input,options={})=>{
    const url=new URL(typeof input==='string' || input instanceof URL ? input : input.url,location.href);
    const method=(options.method || (typeof input==='object' && input.method) || 'GET').toUpperCase();
    const accessChange=['/api/access/roles','/api/access/settings'].includes(url.pathname);
    const identityRead=['GET','HEAD'].includes(method) && ['/api/certifications/defaults','/api/certifications/defaults/legacy','/api/scheduler/bootstrap'].includes(url.pathname);
    const mutation=(!['GET','HEAD'].includes(method) || url.pathname==='/api/libraries/technical/new') && (!url.pathname.startsWith('/api/access/') || accessChange) && !url.pathname.startsWith('/api/scheduler/');
    if(url.origin===location.origin && url.pathname.startsWith('/api/') && (identityRead || mutation)){
      await ready;
      const headers=new Headers(options.headers || (typeof input==='object' && input.headers) || {});headers.set('X-CRM-Member',session.user?.id || 'anonymous');options={...options,headers};
    }
    return nativeFetch(input,options);
  };
  const can=permission=>!session.enabled || !!session.user && (session.user.role==='admin' ||
    permission==='view' && ['viewer','editor'].includes(session.user.role) ||
    permission==='edit' && session.user.role==='editor');
  window.ClassifireAccess={ready,can,get user(){return session.user;},get enabled(){return session.enabled;}};
  function el(tag,value,className){const node=document.createElement(tag);if(value!==undefined){node.textContent=value;if(window.CeasefireMessages?.[value])window.CeasefireI18n?.text(node,value);}if(className)node.className=className;return node;}
  function text(node,value){node.textContent=value;window.CeasefireI18n?.text(node,value);}
  async function request(action,body){
    const response=await fetch('/api/access/'+action,{cache:'no-store',...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'Staff access could not be updated.');return data;
  }
  async function logout(){await request('logout',{});location.assign('/');}
  const login=document.getElementById('staff-login');
  if(login){
    login.addEventListener('submit',async event=>{
      event.preventDefault();const button=login.querySelector('[type=submit]'),message=document.getElementById('staff-login-message');
      button.disabled=true;text(message,'Signing in…');
      try{session=await request('login',{email:login.elements.email.value,password:login.elements.password.value});login.elements.password.value='';
        location.assign('/');
      }catch(error){text(message,error.message);}finally{button.disabled=false;}
    });
    document.getElementById('staff-login-signout').addEventListener('click',()=>void logout());
    request('session').then(value=>{session=value;if(value.user)location.assign('/');resolveReady(value);}).catch(()=>resolveReady(session));
    return;
  }
  async function render(){
    const host=document.getElementById('view-settings');if(!host)return;
    let card=document.getElementById('staff-access-settings');
    if(!card){card=el('section',undefined,'card staff-access-card');card.id='staff-access-settings';const play=host.querySelector('.play-settings-card');if(play)play.before(card);else host.append(card);}
    card.replaceChildren(el('h2','Staff access'));
    const message=el('p','', 'helper');message.setAttribute('role','status');
    const actions=el('div',undefined,'actions');
    if(!session.user){
      card.append(el('p','Sign in with a Scheduler staff account to manage access on this computer.'));
      const form=el('form'),email=el('input'),password=el('input'),button=el('button','Sign in','button primary');
      email.type='email';email.autocomplete='username';email.required=true;email.setAttribute('aria-label','Staff email');
      password.type='password';password.autocomplete='current-password';password.required=true;password.setAttribute('aria-label','Staff password');button.type='submit';
      const emailField=el('label',undefined,'field'),passwordField=el('label',undefined,'field');
      emailField.append(el('span','Email'),email);passwordField.append(el('span','Password'),password);form.append(emailField,passwordField,button);
      form.addEventListener('submit',async event=>{event.preventDefault();button.disabled=true;try{session=await request('login',{email:email.value,password:password.value});password.value='';location.assign('/');}catch(error){text(message,error.message);button.disabled=false;}});
      card.append(form,message);return;
    }
    card.append(el('p',session.user.name+' · '+({admin:'Administrator',editor:'Editor',viewer:'View only',none:'Scheduler only'}[session.user.role]||session.user.role)));
    const out=el('button','Sign out','button secondary');out.type='button';out.addEventListener('click',()=>void logout());actions.append(out);card.append(actions,message);
    if(session.user.role!=='admin')return;
    const setting=el('label',undefined,'field'),input=el('input'),save=el('button','Save','button primary');input.type='checkbox';input.checked=session.enabled;
    setting.append(el('span','Require staff sign-in'),input);save.type='button';card.append(setting,save);
    save.addEventListener('click',async()=>{save.disabled=true;try{const value=await request('settings',{enabled:input.checked,version:session.version});session={...session,...value};text(message,'Staff access saved.');await render();}catch(error){text(message,error.message);}finally{save.disabled=false;}});
    card.append(el('p','Manage staff names, passwords and team administrator roles in Scheduler. Editors can update CRM records; viewers can read records; Scheduler-only staff have no CRM access.','helper'));
    try{
      const result=await request('members'),scroll=el('div',undefined,'table-scroll'),table=el('table',undefined,'staff-access-table'),thead=el('thead'),tr=el('tr'),tbody=el('tbody');
      for(const label of ['Staff member','CRM access','Actions'])tr.append(el('th',label));thead.append(tr);table.append(thead,tbody);scroll.append(table);card.append(scroll);
      for(const member of result.members){
        const row=el('tr'),name=el('td'),role=el('td'),buttons=el('td');name.textContent=member.name+(member.active?'':' (Inactive)');
        if(member.role==='admin')role.append(el('span','Administrator'));
        else{
          const select=el('select'),button=el('button','Save','button secondary');select.setAttribute('aria-label',member.name+' CRM access');button.type='button';
          for(const [value,label]of [['none','Scheduler only'],['viewer','View only'],['editor','Editor']]){const option=el('option',label);option.value=value;select.append(option);}select.value=member.role;
          button.addEventListener('click',async()=>{button.disabled=true;try{await request('roles',{member_id:member.id,role:select.value,version:member.version});await render();}catch(error){text(message,error.message);button.disabled=false;}});
          role.append(select);buttons.append(button);
        }row.append(name,role,buttons);tbody.append(row);
      }
      const history=await request('audit'),details=el('details'),summary=el('summary','Access history');details.append(summary);
      const auditScroll=el('div',undefined,'table-scroll'),auditTable=el('table',undefined,'staff-access-table'),auditHead=el('thead'),auditTitles=el('tr'),auditBody=el('tbody');
      for(const label of ['Time','Staff member','Action','Result'])auditTitles.append(el('th',label));auditHead.append(auditTitles);auditTable.append(auditHead,auditBody);auditScroll.append(auditTable);details.append(auditScroll);
      for(const entry of history.requests){const row=el('tr');
        for(const value of [new Date(entry.at).toLocaleString(),entry.actor_name,entry.method+' '+entry.route,entry.status===null?'Outcome unknown':'HTTP '+entry.status]){const cell=el('td');cell.textContent=value;row.append(cell);}auditBody.append(row);}
      if(!history.requests.length)details.append(el('p','No activity recorded.','helper'));
      card.append(details);
    }catch(error){text(message,error.message);}
  }
  request('session').then(value=>{session=value;resolveReady(value);void render();
    if(value.enabled&&value.user?.role==='viewer'){const main=document.querySelector('main');if(main){const banner=el('p','View-only access. An editor is required to save changes.','staff-access-banner');banner.setAttribute('role','status');main.prepend(banner);}}
  }).catch(()=>resolveReady(session));
})();
