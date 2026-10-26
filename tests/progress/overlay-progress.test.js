'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProgressView, createProgressRefreshAdapter, mergeVisibleTypes } = require('../../src/overlay/progress-view');
const { PROFILE_A, PROFILE_B } = require('./helpers');
const snapshot = (version, ids = [], profileId = PROFILE_A, session = 'A') => ({sessionGeneration: session, viewVersion: version, activeProfile: {id:profileId, foundIds:ids, enabledTypes:['o5','o999'], hideFound:false}, sync:{phase:'local'}});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve=r; }); return {promise,resolve}; };
test('same-profile authoritative replacement refreshes every progress view through production adapter', () => {
  const effects = {recount:0,refreshSpot:0,filters:0,close:0}; let rendered;
  const adapter = createProgressRefreshAdapter({replaceFound:ids=>{rendered=ids;},replacePreferences:()=>{},recount:()=>effects.recount++,refreshFilters:()=>effects.filters++,refreshSpot:()=>effects.refreshSpot++,closeSpot:()=>effects.close++,closeLightbox:()=>{},renderControls:()=>{},redraw:()=>{}});
  const view = createProgressView({sendSetFound:async()=>{},onChange:adapter});
  view.applySnapshot(snapshot(1)); effects.recount=0; effects.refreshSpot=0; effects.filters=0; effects.close=0;
  view.applySnapshot(snapshot(2,[42,43]));
  assert.deepEqual(view.current().foundIds,[42,43]); assert.deepEqual(rendered,[42,43]);
  assert.deepEqual(effects,{recount:1,refreshSpot:1,filters:1,close:0});
});
test('pending explicit intentions are serialized and late failed mark cannot roll back newer undo', async () => {
  const first=deferred(); const calls=[]; const errors=[];
  const view=createProgressView({sendSetFound:p=>{calls.push(p);return calls.length===1?first.promise:Promise.resolve({ok:true,value:snapshot(3,[])});},onError:e=>errors.push(e)});
  view.applySnapshot(snapshot(1)); const mark=view.setFound(42,true); const undo=view.setFound(42,false);
  await Promise.resolve(); assert.equal(calls.length,1); assert.deepEqual(view.current().foundIds,[]);
  first.resolve({ok:false,error:{code:'local-write-failed'},snapshot:snapshot(2,[])}); await Promise.all([mark,undo]);
  assert.deepEqual(calls.map(p=>p.found),[true,false]); assert.deepEqual(view.current().foundIds,[]); assert.equal(errors.length,1);
});
test('A to B to A invalidates old-session success and failure replies and queued intents', async () => {
  for(const ok of [true,false]) {
    const wait=deferred(); let calls=0; const errors=[];
    const view=createProgressView({sendSetFound:()=>{calls++;return wait.promise;},onError:e=>errors.push(e)});
    view.applySnapshot(snapshot(1)); const old=view.setFound(42,true); const queued=view.setFound(43,true); await Promise.resolve();
    view.applySnapshot(snapshot(2,[],PROFILE_B,'B')); assert.equal(view.current().context.profileId,PROFILE_B);
    view.applySnapshot(snapshot(3,[],PROFILE_A,'A2'));
    wait.resolve(ok?{ok:true,value:snapshot(4,[42],PROFILE_A,'A2')}:{ok:false,error:{code:'local-write-failed'},snapshot:snapshot(4,[42],PROFILE_A,'A2')});
    await Promise.all([old,queued]); assert.deepEqual(view.current().foundIds,[]); assert.equal(view.current().context.sessionGeneration,'A2'); assert.equal(calls,1); assert.equal(errors.length,0);
  }
});
test('newer authoritative state wins over old same-session reply and preferences keep unknown keys', async () => {
  const wait=deferred(); const view=createProgressView({sendSetFound:()=>wait.promise,sendSetPreferences:async p=>({ok:true,value:{...snapshot(5),activeProfile:{...snapshot(5).activeProfile,enabledTypes:p.enabledTypes,hideFound:p.hideFound??false}}})});
  view.applySnapshot(snapshot(1)); const pending=view.setFound(42,true); await Promise.resolve(); view.applySnapshot(snapshot(4,[43]));
  wait.resolve({ok:true,value:snapshot(2,[42])}); await pending; assert.deepEqual(view.current().foundIds,[43]);
  const keys=mergeVisibleTypes(view.current().enabledTypes,['o5','o6'],['o6']); assert.deepEqual(keys,['o999','o6']);
  await view.setPreferences({enabledTypes:keys,hideFound:true}); assert.deepEqual(view.current().enabledTypes,keys); assert.equal(view.current().hideFound,true);
});
test('recovery snapshots reject optimistic mutations and close profile-dependent UI on activation',async()=>{
  let closed=0; let sent=0; const adapter=createProgressRefreshAdapter({closeSpot:()=>closed++,closeLightbox:()=>{},replaceFound:()=>{},replacePreferences:()=>{},recount:()=>{},refreshFilters:()=>{},refreshSpot:()=>{},renderControls:()=>{},redraw:()=>{}});
  const view=createProgressView({sendSetFound:()=>sent++,onChange:adapter}); view.applySnapshot(snapshot(1)); view.applySnapshot({...snapshot(2,[],PROFILE_B,'B'),sync:{phase:'recovery'}}); await view.setFound(42,true); assert.equal(sent,0);assert.deepEqual(view.current().foundIds,[]); assert.equal(closed,2);
});
module.exports={snapshot};
test('real service write failure followed by rapid undo reconciles to actual durable state', async t => {
  const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
  const {ProgressService}=require('../../src/progress/service');const {ProgressRepository}=require('../../src/progress/repository');
  const userData=await fs.mkdtemp(path.join(os.tmpdir(),'progress-view-'));t.after(()=>fs.rm(userData,{recursive:true,force:true}));
  let armed=false;const entered=deferred();const release=deferred();let view;
  const repository=new ProgressRepository({root:path.join(userData,'progress'),fs:{...fs,rename:async(source,target)=>{
    if(armed&&target.endsWith('/local/state.json')){armed=false;entered.resolve();await release.promise;throw Object.assign(Error('disk'),{code:'EIO'});}return fs.rename(source,target);
  }}});
  const service=new ProgressService({repository,onSnapshot:snapshot=>view?.applySnapshot(snapshot)});await service.initialize({userData});const errors=[];
  view=createProgressView({sendSetFound:({sessionGeneration,profileId,...patch})=>service.setFound({sessionGeneration,profileId},patch),onError:error=>errors.push(error)});view.applySnapshot(service.snapshot());armed=true;
  const mark=view.setFound(42,true);await entered.promise;const undo=view.setFound(42,false);assert.deepEqual(view.current().foundIds,[]);release.resolve();await Promise.all([mark,undo]);
  assert.deepEqual(view.current().foundIds,[]);assert.equal(errors[0].code,'local-write-failed');const envelope=await repository.load({kind:'local'});assert.equal(envelope.state.profiles[view.current().context.profileId].markers['42'].value,false);await service.shutdown();
});
test('view preparation freezes new acceptance, reports a failed accepted drain and resumes only its matching request',async()=>{
  const wait=deferred();let calls=0;const view=createProgressView({sendSetFound:()=>{calls++;return wait.promise;}});view.applySnapshot(snapshot(1));const mark=view.setFound(42,true);await Promise.resolve();const prepared=view.prepareQuit('Q1');await view.setFound(43,true);assert.deepEqual(view.current().foundIds,[42]);assert.equal(calls,1);
  view.resumeAfterQuit('wrong');await view.setFound(44,true);assert.equal(calls,1);wait.resolve({ok:false,error:{code:'local-write-failed'},snapshot:snapshot(2)});await mark;assert.equal(await prepared,false);
  view.resumeAfterQuit('Q1');const retried=view.setFound(45,true);await retried;assert.equal(calls,2);assert.equal(await view.prepareQuit('Q2'),true);
});
