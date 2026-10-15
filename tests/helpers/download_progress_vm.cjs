// Older snapshot/race tests stub only the artifact request. Keep those assertions
// focused while the native progress unit/browser journeys test real receipts.
function installProgressReceipts(context) {
  let send;
  Object.defineProperty(context, 'fetch', {
    configurable:true,
    set(value){send=value;},
    get(){return (path,options)=>{
      if(path==='/api/download-progress')return Promise.resolve({ok:true,json:async()=>({token:'fixture-progress'})});
      if(path.startsWith('/api/download-progress/'))return Promise.resolve({ok:true,json:async()=>({percent:10,state:'preparing'})});
      return send(path,options);
    };},
  });
}
module.exports={installProgressReceipts};
