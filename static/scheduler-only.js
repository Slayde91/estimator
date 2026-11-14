(() => {
  'use strict';
  const signOut=document.getElementById('staff-portal-sign-out');
  signOut.addEventListener('click',()=>window.CeasefireScheduler.openSignOut(signOut).catch(error=>window.alert(error.message)));
  window.CeasefireScheduler.init({root:document.getElementById('scheduler-root')});
  void window.CeasefireScheduler.activate().finally(()=>window.ClassifireBoot?.ready());
})();
