'use strict';
const test=require('node:test'); const assert=require('node:assert/strict');
const {createQuitGuard}=require('../../src/progress/app-lifecycle');
test('quit drains queued writes once; failed drain keeps app open and permits successful retry',async()=>{
  let resolve; let quitCalls=0;let errorShown=0;let cleanup=0;let attempts=0;let prevented=0;
  const guard=createQuitGuard({shutdown:async()=>{attempts++;if(attempts===1){await new Promise(r=>{resolve=r;});throw Error('disk');}},onError:()=>errorShown++,onReady:()=>cleanup++,quit:()=>quitCalls++});
  const event={preventDefault:()=>prevented++}; const first=guard.beforeQuit(event);guard.beforeQuit(event);
  assert.equal(attempts,1);assert.equal(cleanup,0);resolve();await first;
  assert.equal(quitCalls,0);assert.equal(errorShown,1);assert.equal(cleanup,0);
  await guard.beforeQuit(event);assert.equal(quitCalls,1);assert.equal(cleanup,1);assert.equal(guard.ready(),true);
  guard.beforeQuit(event);assert.equal(quitCalls,1);assert.equal(prevented,3);
});

// Execute the production main composition with native-only substitutes. No app,
// capture, personal userData, or timers are started by this harness.
async function mainHarness(t, { deferRuntime = false } = {}) {
  const vm=require('node:vm');const fs=require('node:fs');const fsp=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const {EventEmitter}=require('node:events');
  const directory=await fsp.mkdtemp(path.join(os.tmpdir(),'progress-main-'));t.after(()=>fsp.rm(directory,{recursive:true,force:true}));
  const nativeIpc=new EventEmitter();const handlers=new Map();nativeIpc.handle=(name,handler)=>handlers.set(name,handler);nativeIpc.removeHandler=name=>handlers.delete(name);let holdPrepare=false;const heldPrepare=[];let selections=0;
  const callbacks=new Map();const windows=[];const timeouts=[];let cleared=0;let writes=0;let phase='initializing';let quitCalls=0;let errorShown=0;let failDrain=true;const loads=[];const published=[];const payloads=[];
  const app={on:(name,fn)=>callbacks.set(name,fn),requestSingleInstanceLock:()=>true,whenReady:()=>({then:()=>{}}),getPath:()=>directory,getLocale:()=> 'de',getVersion:()=> 'test',dock:{hide(){}},quit(){let prevented=false;callbacks.get('before-quit')({preventDefault(){prevented=true;}});if(!prevented)quitCalls++;}};
  class FakeWindow extends EventEmitter {constructor(options){super();this.options=options;windows.push(this);this.webContents=new EventEmitter();this.webContents.send=(...args)=>{payloads.push(args);if(args[0]==='progress:prepare-quit'){const acknowledge=()=>nativeIpc.emit('progress:quit-ready',{sender:this.webContents,senderFrame:this.webContents.mainFrame},{requestId:args[1].requestId,ok:true});if(holdPrepare)heldPrepare.push(acknowledge);else queueMicrotask(acknowledge);}};this.webContents.isDestroyed=()=>false;this.webContents.mainFrame={};this.webContents.isLoading=()=>false;this.webContents.getURL=()=>this.url;this.webContents.setWindowOpenHandler=handler=>{this.webContents.openHandler=handler;};}isDestroyed(){return false;}setAlwaysOnTop(){}setVisibleOnAllWorkspaces(){}setIgnoreMouseEvents(){}setContentProtection(){}loadFile(file){this.url=require('node:url').pathToFileURL(file).href;this.guardedBeforeLoad=this.webContents.listenerCount('will-navigate')>0&&this.webContents.listenerCount('will-redirect')>0&&!!this.webContents.openHandler;}show(){}focus(){}setBounds(){}showInactive(){}isVisible(){return true;}}
  const screen={getAllDisplays:()=>[{id:1,size:{width:1920,height:1080},bounds:{x:0,y:0,width:1920,height:1080},scaleFactor:1}],getPrimaryDisplay:()=>screen.getAllDisplays()[0],on(){}};
  const electron={app,BrowserWindow:FakeWindow,ipcMain:nativeIpc,Menu:{setApplicationMenu(){},buildFromTemplate:items=>items},Tray:class{setToolTip(){}setContextMenu(){}on(){}},nativeImage:{createFromPath:()=>({resize:()=>({})})},screen,session:{defaultSession:{setDisplayMediaRequestHandler(){}}},globalShortcut:{unregisterAll(){},register:()=>true},systemPreferences:{getMediaAccessStatus:()=> 'granted'},dialog:{showErrorBox:()=>errorShown++}};
  const service={readTransferState:async()=>{throw Error('unexpected-transfer-state-read');},selectProfile:async()=>{selections++;return {ok:true,value:service.snapshot()};},snapshot:()=>({sessionGeneration:'A',viewVersion:1,activeProfile:null,profiles:[],sync:{phase,code:phase==='recovery'?'local-read-failed':null}})};
  const config={load:options=>{loads.push(options);return {active:false,language:'de',hotkeys:{},hotkeysEnabled:false,showInCaptures:false,opacity:1,markerSize:26};},save:()=>writes++};
  let releaseRuntime;const initializationGate=deferRuntime?new Promise(resolve=>{releaseRuntime=resolve;}):Promise.resolve();
  const runtime={service,shutdown:async()=>{if(failDrain)throw Error('disk');},retryLocal:async()=>service.snapshot()};
  const filename=path.resolve(__dirname,'../../src/main.js');const nativeRequire=require('node:module').createRequire(filename);
  const mocks={electron,'./config':config,'./hotkey-helper':{isHelperProcess:()=>false,HotkeyBridge:class {setHotkeys(){}}},'./data/store':{DataStore:class{async loadMarkers(){return null;}}},'./progress/runtime':{createProgressRuntime:async options=>{published.push(options.onSnapshot);await initializationGate;return runtime;}}};
  const context={require:name=>Object.hasOwn(mocks,name)?mocks[name]:nativeRequire(name),module:{exports:{}},__dirname:path.dirname(filename),process:{platform:'linux',versions:{electron:'test'},execPath:'/tmp/test-electron'},setTimeout:fn=>{timeouts.push(fn);return timeouts.length;},clearTimeout:()=>cleared++,setInterval:()=>123,clearInterval:()=>cleared++,console};
  vm.runInNewContext(fs.readFileSync(filename,'utf8')+'\nmodule.exports={start,updateSettings,reloadSettings,toggleFoundVisibility,setLanguage,openProfileSettings};',context,{filename});
  const startup=context.module.exports.start();
  if(!deferRuntime)await startup;
  return {main:context.module.exports,handlers,holdPreparation:()=>{holdPrepare=true;},releasePreparation:()=>{holdPrepare=false;heldPrepare.splice(0).forEach(ack=>ack());},get selections(){return selections;},callbacks,timeouts,loads,payloads,app,windows,startup,releaseRuntime,setPhase:value=>{phase=value;},setFail:value=>{failDrain=value;},stats:()=>({cleared,writes,quitCalls,errorShown}),publish:()=>published[0](service.snapshot())};
}
test('main preservation reads and settings timers never write during migration or recovery; F9 is a profile intent',async t=>{
  const f=await mainHarness(t);assert.deepEqual(JSON.parse(JSON.stringify(f.loads)),[{preserveMalformed:true}]);
  f.main.updateSettings({opacity:.5});f.timeouts.at(-1)();assert.equal(f.stats().writes,0);
  f.setPhase('recovery');f.main.updateSettings({opacity:.7});f.timeouts.at(-1)();assert.equal(f.stats().writes,0);
  f.setPhase('local');f.main.updateSettings({opacity:.8});f.timeouts.at(-1)();assert.equal(f.stats().writes,1);
  f.main.toggleFoundVisibility();assert.equal(f.payloads.at(-1)[0],'progress:toggle-hide-found');
  f.main.reloadSettings();assert.deepEqual(JSON.parse(JSON.stringify(f.loads.at(-1))),{preserveMalformed:true});
  const settings=f.payloads.filter(args=>args[0]==='settings').at(-1)[1];assert.equal('enabledTypes' in settings,false);assert.equal('hideFound' in settings,false);
});
test('main shows a visible native error with overlay hidden/settings closed, keeps timers, and retries quit once',async t=>{
  const f=await mainHarness(t);assert.equal(f.windows.length,2);assert.equal(f.windows[0].options.show,false);const cleared=f.stats().cleared;let prevented=0;
  await f.callbacks.get('before-quit')({preventDefault:()=>prevented++});await new Promise(r=>setImmediate(r));
  assert.equal(prevented,1);assert.equal(f.stats().quitCalls,0);assert.equal(f.stats().errorShown,1);assert.equal(f.stats().cleared,cleared);
  f.setFail(false);f.callbacks.get('before-quit')({preventDefault:()=>prevented++});await new Promise(r=>setImmediate(r));
  assert.equal(f.stats().quitCalls,1);assert.ok(f.stats().cleared>cleared);
});

test('quit waits for in-flight runtime initialization before draining and closing',async t=>{
  const f=await mainHarness(t,{deferRuntime:true});f.setFail(false);
  f.callbacks.get('before-quit')({preventDefault(){}});await new Promise(r=>setImmediate(r));
  assert.equal(f.stats().quitCalls,0);f.releaseRuntime();await f.startup;await new Promise(r=>setImmediate(r));assert.equal(f.stats().quitCalls,1);
  assert.equal(f.payloads.filter(([channel])=>channel==='progress:prepare-quit').length,1);
});
test('quit guard drains an actual queued write, stays open on directory uncertainty and succeeds after storage recovers',async t=>{
  const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
  const {ProgressRepository}=require('../../src/progress/repository');const {ProgressService}=require('../../src/progress/service');
  const userData=await fs.mkdtemp(path.join(os.tmpdir(),'progress-quit-'));t.after(()=>fs.rm(userData,{recursive:true,force:true}));
  let armed=false;let renamed=false;let enter;let release;
  const entered=new Promise(resolve=>{enter=resolve;});const held=new Promise(resolve=>{release=resolve;});
  const repository=new ProgressRepository({root:path.join(userData,'progress'),fs:{...fs,
    rename:async(source,target)=>{
      if(armed&&target.endsWith('/local/state.json')){enter();await held;}
      await fs.rename(source,target);if(armed&&target.endsWith('/local/state.json'))renamed=true;
    },
    open:async(file,...args)=>{
      const handle=await fs.open(file,...args);
      if(armed&&renamed&&file.endsWith('/local'))return new Proxy(handle,{get(target,key){if(key==='sync')return async()=>{throw Object.assign(Error('disk'),{code:'EIO'});};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
      return handle;
    },
  }});
  const service=new ProgressService({repository});await service.initialize({userData});const snapshot=service.snapshot();armed=true;
  const edit=service.setFound({sessionGeneration:snapshot.sessionGeneration,profileId:snapshot.activeProfile.id},{id:42,found:true});await entered;
  let quitCalls=0;let errorShown=0;let cleaned=0;
  const guard=createQuitGuard({shutdown:()=>service.shutdown(),quit:()=>quitCalls++,onError:()=>errorShown++,onReady:()=>cleaned++});
  const closing=guard.beforeQuit({preventDefault(){}});assert.equal(quitCalls,0);release();await closing;assert.equal((await edit).ok,false);
  assert.equal(quitCalls,0);assert.equal(errorShown,1);assert.equal(cleaned,0);assert.equal(service.snapshot().sync.phase,'recovery');
  armed=false;await guard.beforeQuit({preventDefault(){}});assert.equal(quitCalls,1);assert.equal(cleaned,1);assert.deepEqual(service.snapshot().activeProfile.foundIds,[42]);
});

// Review regression: join the production renderer intention queue to the actual
// durable service queue, rather than queuing both edits directly into the service.
test('coordinated quit freezes the actual view and persists a queued undo before closing the actual service',async t=>{
  const {createRendererQuitDrain}=require('../../src/progress/app-lifecycle');const {createProgressView}=require('../../src/overlay/progress-view');
  const {EventEmitter}=require('node:events');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
  const {ProgressRepository}=require('../../src/progress/repository');const {ProgressService}=require('../../src/progress/service');
  const userData=await fs.mkdtemp(path.join(os.tmpdir(),'renderer-quit-race-'));t.after(()=>fs.rm(userData,{recursive:true,force:true}));
  let held=false;let entered;let release;const entering=new Promise(resolve=>{entered=resolve;});const waiting=new Promise(resolve=>{release=resolve;});
  const repository=new ProgressRepository({root:path.join(userData,'progress'),fs:{...fs,rename:async(source,target)=>{if(held&&target.endsWith('/local/state.json')){held=false;entered();await waiting;}return fs.rename(source,target);}}});
  let view;const service=new ProgressService({repository,onSnapshot:snapshot=>view?.applySnapshot(snapshot)});await service.initialize({userData});
  view=createProgressView({sendSetFound:({sessionGeneration,profileId,...patch})=>service.setFound({sessionGeneration,profileId},patch)});view.applySnapshot(service.snapshot());
  const ipcMain=new EventEmitter();const wc=new EventEmitter();const frame={};wc.mainFrame=frame;wc.isDestroyed=()=>false;wc.isLoadingMainFrame=()=>false;wc.getURL=()=> 'file:///overlay.html';
  const window=new EventEmitter();window.webContents=wc;window.isDestroyed=()=>false;
  const sent=[];wc.send=(channel,payload)=>{sent.push(channel);if(channel==='progress:prepare-quit'){view.prepareQuit(payload.requestId).then(ok=>ipcMain.emit('progress:quit-ready',{sender:wc,senderFrame:frame},{requestId:payload.requestId,ok}));}if(channel==='progress:resume-after-quit')view.resumeAfterQuit(payload.requestId);};
  const drain=createRendererQuitDrain({ipcMain,getClients:()=>[{window,url:'file:///overlay.html'}]});t.after(()=>drain.dispose());
  let quits=0;let errors=0;const guard=createQuitGuard({shutdown:async()=>{await drain.prepare();await service.shutdown();},quit:()=>quits++,onError:()=>{errors++;drain.resume();}});
  held=true;const mark=view.setFound(42,true);await entering;const undo=view.setFound(42,false);assert.deepEqual(view.current().foundIds,[]);
  const closing=guard.beforeQuit({preventDefault(){}});await Promise.resolve();await view.setFound(43,true);assert.deepEqual(view.current().foundIds,[]);assert.equal(quits,0);
  release();await Promise.all([mark,undo,closing]);assert.equal(quits,1);assert.equal(errors,0);assert.equal((await repository.load({kind:'local'})).state.profiles[view.current().context.profileId].markers['42'].value,false);assert.equal((await repository.load({kind:'local'})).state.profiles[view.current().context.profileId].markers['43'],undefined);assert.deepEqual(sent,['progress:prepare-quit']);
});
test('renderer drain waits initial load, ignores forged or stale frame acks, and resumes matching preparation on timeout/retry',async()=>{
  const {createRendererQuitDrain}=require('../../src/progress/app-lifecycle');const {EventEmitter}=require('node:events');const ipcMain=new EventEmitter();const wc=new EventEmitter();let loading=true;const frame={};wc.mainFrame=frame;wc.getURL=()=> 'file:///overlay.html';wc.isDestroyed=()=>false;wc.isLoadingMainFrame=()=>loading;
  const window=new EventEmitter();window.webContents=wc;window.isDestroyed=()=>false;const sends=[];wc.send=(...args)=>sends.push(args);let timeout;let id=0;
  const drain=createRendererQuitDrain({ipcMain,getClients:()=>[{window,url:'file:///overlay.html'}],uuid:()=>String(++id),setTimer:(fn,ms)=>{assert.equal(ms,10000);timeout=fn;return 1;},clearTimer:()=>{}});
  const first=drain.prepare();assert.equal(sends.length,0);loading=false;wc.emit('did-finish-load');assert.equal(sends[0][0],'progress:prepare-quit');
  ipcMain.emit('progress:quit-ready',{sender:{},senderFrame:frame},{requestId:'1',ok:true});ipcMain.emit('progress:quit-ready',{sender:wc,senderFrame:{}},{requestId:'1',ok:true});ipcMain.emit('progress:quit-ready',{sender:wc,senderFrame:frame},{requestId:'old',ok:true});
  timeout();await assert.rejects(first);drain.resume();assert.deepEqual(sends.at(-1),['progress:resume-after-quit',{requestId:'1'}]);
  const second=drain.prepare();ipcMain.emit('progress:quit-ready',{sender:wc,senderFrame:frame},{requestId:'1',ok:true});ipcMain.emit('progress:quit-ready',{sender:wc,senderFrame:frame},{requestId:'2',ok:true});await second;drain.dispose();assert.equal(ipcMain.listenerCount('progress:quit-ready'),0);
});
test('main installs exact-local overlay navigation, redirect and new-window guards before load',async t=>{
  const f=await mainHarness(t);assert.equal(f.windows[0].guardedBeforeLoad,true);const wc=f.windows[0].webContents;let denied=0;
  wc.emit('will-navigate',{preventDefault:()=>denied++},'https://example.com');wc.emit('will-redirect',{preventDefault:()=>denied++},'file:///tmp/other.html');wc.emit('will-navigate',{preventDefault:()=>denied++},f.windows[0].url);assert.equal(denied,2);assert.equal(wc.openHandler({url:'https://example.com'}).action,'deny');const count=f.payloads.length;f.windows[0].url='https://example.com';f.publish();wc.emit('did-finish-load');assert.equal(f.payloads.length,count);
});
test('failed renderer drain prevents main shutdown, visibly errors, resumes both clients and retries once',async()=>{
  const {createRendererQuitDrain}=require('../../src/progress/app-lifecycle');const {EventEmitter}=require('node:events');const ipcMain=new EventEmitter();let attempt=0;const messages=[];
  const clients=['overlay','settings'].map(name=>{const contents=new EventEmitter();contents.mainFrame={};contents.isDestroyed=()=>false;contents.getURL=()=> 'file:///'+name+'.html';contents.isLoadingMainFrame=()=>false;const window=new EventEmitter();window.webContents=contents;window.isDestroyed=()=>false;contents.send=(channel,payload)=>{messages.push([name,channel,payload.requestId]);if(channel==='progress:prepare-quit')queueMicrotask(()=>ipcMain.emit('progress:quit-ready',{sender:contents,senderFrame:contents.mainFrame},{requestId:payload.requestId,ok:attempt>0||name==='overlay'}));};return {window,url:contents.getURL()};});
  const drain=createRendererQuitDrain({ipcMain,getClients:()=>clients,uuid:()=>String(attempt)});let shutdowns=0;let quits=0;let errors=0;
  const guard=createQuitGuard({shutdown:async()=>{await drain.prepare();shutdowns++;},onError:()=>{errors++;drain.resume();},quit:()=>quits++});
  await guard.beforeQuit({preventDefault(){}});assert.equal(shutdowns,0);assert.equal(quits,0);assert.equal(errors,1);assert.equal(messages.filter(value=>value[1]==='progress:resume-after-quit').length,2);
  attempt++;await guard.beforeQuit({preventDefault(){}});assert.equal(shutdowns,1);assert.equal(quits,1);drain.dispose();
});
test('ack validation rejects changed live owner/frame, accessors, extra fields/args and nonlocal documents',async()=>{
  const {createRendererQuitDrain}=require('../../src/progress/app-lifecycle');const {EventEmitter}=require('node:events');const ipcMain=new EventEmitter();const contents=new EventEmitter();const frame={};contents.mainFrame=frame;contents.isDestroyed=()=>false;contents.getURL=()=> 'file:///overlay.html';contents.isLoadingMainFrame=()=>false;contents.send=()=>{};const window=new EventEmitter();window.webContents=contents;window.isDestroyed=()=>false;let owner=window;let timeout;let id=0;
  const drain=createRendererQuitDrain({ipcMain,getClients:()=>[{window:owner,url:'file:///overlay.html'}],uuid:()=>String(++id),setTimer:fn=>{timeout=fn;},clearTimer:()=>{}});
  const first=drain.prepare();const event={sender:contents,senderFrame:frame};ipcMain.emit('progress:quit-ready',event,{requestId:'1',get ok(){throw Error('accessor read');}});ipcMain.emit('progress:quit-ready',event,{requestId:'1',ok:true,other:true});ipcMain.emit('progress:quit-ready',event,{requestId:'1',ok:true},'extra');
  contents.mainFrame={};ipcMain.emit('progress:quit-ready',event,{requestId:'1',ok:true});contents.mainFrame=frame;owner={...window};ipcMain.emit('progress:quit-ready',event,{requestId:'1',ok:true});timeout();await assert.rejects(first);drain.resume();
  owner=window;contents.getURL=()=> 'https://example.com';await assert.rejects(drain.prepare());drain.resume();drain.dispose();
});
test('initial about:blank waits for the fixed local document even before native loading starts',async()=>{
  const {createRendererQuitDrain}=require('../../src/progress/app-lifecycle');const {EventEmitter}=require('node:events');const ipcMain=new EventEmitter();const contents=new EventEmitter();contents.mainFrame={};contents.isDestroyed=()=>false;let url='about:blank';contents.getURL=()=>url;contents.isLoadingMainFrame=()=>false;let sent=0;contents.send=(_channel,payload)=>{sent++;ipcMain.emit('progress:quit-ready',{sender:contents,senderFrame:contents.mainFrame},{requestId:payload.requestId,ok:true});};const window=new EventEmitter();window.webContents=contents;window.isDestroyed=()=>false;
  const drain=createRendererQuitDrain({ipcMain,getClients:()=>[{window,url:'file:///overlay.html'}]});const pending=drain.prepare();assert.equal(sent,0);url='file:///overlay.html';contents.emit('did-finish-load');await pending;assert.equal(sent,1);drain.dispose();
});

test('production main drains overlay for profile IPC, blocks settings opening, and queues quit behind that command', { timeout: 3000 }, async t => {
  const f = await mainHarness(t); f.setFail(false); f.holdPreparation();
  t.after(() => f.releasePreparation());
  const overlay = f.windows[0]; const event = { sender: overlay.webContents, senderFrame: overlay.webContents.mainFrame };
  const select = f.handlers.get('progress:select-profile');
  const pending = select(event, { sessionGeneration: 'A', profileId: '10000000-0000-4000-8000-000000000001' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.selections, 0);
  assert.equal(f.payloads.filter(([channel]) => channel === 'progress:prepare-quit').length, 1);
  f.main.openProfileSettings(); assert.equal(f.windows.length, 2);
  f.callbacks.get('before-quit')({ preventDefault() {} });
  assert.equal((await select(event, { sessionGeneration: 'A', profileId: '10000000-0000-4000-8000-000000000002' })).ok, false);
  assert.equal(f.stats().quitCalls, 0); assert.equal(f.handlers.has('progress:select-profile'), true);
  f.releasePreparation(); assert.equal((await pending).ok, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.selections, 1); assert.equal(f.stats().quitCalls, 1); assert.equal(f.handlers.has('progress:select-profile'), false);
});
