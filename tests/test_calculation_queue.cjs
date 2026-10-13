const {test}=require('node:test'),assert=require('node:assert/strict');
const {create}=require('../static/calculation-queue.js');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};

test('burst keeps one active and only the newest pending snapshot',async()=>{
  const queue=create(),first=deferred(),calls=[];
  const active=queue.run(()=>{calls.push(1);return first.promise;});
  const obsolete=queue.run(()=>{calls.push(2);return 2;});
  const latest=queue.run(()=>{calls.push(3);return 3;});
  assert.equal(await obsolete,undefined);assert.deepEqual(calls,[1]);
  first.resolve(1);assert.equal(await active,1);assert.equal(await latest,3);assert.deepEqual(calls,[1,3]);
});
test('project, input, or pricing invalidation drops a pending job before sending',async()=>{
  const queue=create(),first=deferred();let valid=true,sent=0;
  const active=queue.run(()=>first.promise),pending=queue.run(()=>{sent++;},()=>valid);
  valid=false;first.resolve('old context');await active;assert.equal(await pending,undefined);assert.equal(sent,0);
  assert.equal(await queue.run(()=>42),42);
});
test('active failure releases admission and pending failure does not poison the queue',async()=>{
  const queue=create(),first=deferred();const active=queue.run(()=>first.promise);
  const failed=assert.rejects(active,/old failure/);
  const pending=queue.run(()=>{throw Error('latest failure');});const latestFailed=assert.rejects(pending,/latest failure/);
  first.reject(Error('old failure'));await Promise.all([failed,latestFailed]);assert.equal(await queue.run(()=>99),99);
});
test('contexts are independent and synchronous throws release the queue',async()=>{
  const first=create(),second=create(),held=deferred();const run=first.run(()=>held.promise);
  assert.equal(await second.run(()=>7),7);held.resolve(8);assert.equal(await run,8);
  await assert.rejects(first.run(()=>{throw Error('sync');}),/sync/);assert.equal(await first.run(()=>9),9);
});
