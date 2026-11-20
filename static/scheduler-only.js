(() => {
  'use strict';
  window.CeasefireDialogs ??= {
    confirm: (title, detail) => Promise.resolve(window.confirm(detail ? title+'\n'+detail : title)),
    message: text => window.alert(text),
  };
  const signOut=document.getElementById('staff-portal-sign-out');
  signOut.addEventListener('click',()=>window.CeasefireScheduler.openSignOut(signOut).catch(error=>window.alert(error.message)));
  window.CeasefireScheduler.init({root:document.getElementById('scheduler-root')});
  void window.CeasefireScheduler.activate().finally(()=>window.ClassifireBoot?.ready());
  const navigation=document.getElementById('technician-navigation');
  const buttons=[...navigation.querySelectorAll('[data-technician-view]')];
  let current='scheduler';
  window.ClassifireAccess.ready.then(({user})=>{
    navigation.hidden=!['technician','technician_plus'].includes(user?.account_type);
  });
  for(const button of buttons)button.addEventListener('click',async()=>{
    const target=button.dataset.technicianView;
    if(target===current)return;
    if(current==='forms' && !await window.ClassifireForms.leave())return;
    if(current==='technical')window.CeasefireLibraries.leave();
    if(current==='scheduler' && !await window.CeasefireScheduler.leave())return;
    current=target;
    for(const control of buttons){
      const active=control===button;
      control.setAttribute('aria-pressed',String(active));
      document.getElementById('view-'+control.dataset.technicianView).hidden=!active;
    }
    if(target==='forms')await window.ClassifireForms.activate();
    if(target==='technical')await window.CeasefireLibraries.open('technical');
    if(target==='scheduler')await window.CeasefireScheduler.activate();
  });
})();
