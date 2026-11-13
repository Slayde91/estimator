(() => {
  'use strict';
  window.CeasefireScheduler.init({root:document.getElementById('scheduler-root')});
  void window.CeasefireScheduler.activate().finally(()=>window.ClassifireBoot?.ready());
})();
