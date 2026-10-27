'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');
const {createSettingsWindow,createSettingsWindowOwner}=require('../../src/settings/window');
const {mountSettings,validateProfileText}=require('../../src/settings/settings');const I18n=require('../../src/shared/i18n');
class Window extends EventEmitter {constructor(options){super();this.options=options;this.destroyed=false;this.webContents=new EventEmitter();this.sent=[];this.webContents.send=(...a)=>this.sent.push(a);this.webContents.setWindowOpenHandler=fn=>{this.openHandler=fn;};}loadFile(file){this.file=file;}isDestroyed(){return this.destroyed;}show(){this.shown=true;}focus(){this.focused=true;}isMinimized(){return false;}}
class Element {constructor(){this.children=[];this.dataset={};this.value='';this.hidden=false;this.disabled=false;this.handlers={};this.textContent='';}append(...els){this.children.push(...els);}replaceChildren(...els){this.children=els;}addEventListener(name,fn){this.handlers[name]=fn;}removeEventListener(name,fn){if(this.handlers[name]===fn)delete this.handlers[name];}}
function dom(){const elements=new Map();return {elements,getElementById:id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},createElement:()=>new Element(),querySelectorAll:()=>[] ,documentElement:{lang:'en'}};}
const snapshot=(version=1)=>({sessionGeneration:'A',viewVersion:version,profiles:[{id:'P',name:'<img src=x onerror=alert(1)>',region:'🌍'}],activeProfile:{id:'P',name:'<img src=x onerror=alert(1)>',region:'🌍'},sync:{phase:'local',code:null}});
test('normal settings window stays sandboxed, fixed-navigation, localized and reusable',()=>{
  let language='de'; const owner=createSettingsWindowOwner({createWindow:onClosed=>createSettingsWindow({BrowserWindow:Window,onClosed,getLanguage:()=>language})});const first=owner.open();assert.equal(owner.open(),first);
  assert.equal(first.options.focusable,true);assert.deepEqual({...first.options.webPreferences,preload:undefined},{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:undefined});assert.equal(first.focused,true);
  first.webContents.emit('did-finish-load');assert.deepEqual(first.sent.at(-1),['profiles:language','de']);language='en';owner.sendLanguage(language);assert.deepEqual(first.sent.at(-1),['profiles:language','en']);
  let prevented=0; first.webContents.emit('will-navigate',{preventDefault:()=>prevented++},'https://example.com');assert.equal(prevented,1);assert.deepEqual(first.openHandler({url:'https://example.com'}),{action:'deny'});
  first.emit('closed');assert.notEqual(owner.open(),first);
});
test('names use text nodes, locale subscribes before state, live errors translate and cleanup survives reopen',async()=>{
  const document=dom();let stateListener;let languageListener;let unsub=0;const order=[];let commandResult={ok:true,value:{canceled:true}};
  const api={onSnapshot:fn=>{stateListener=fn;return()=>unsub++;},onLanguage:fn=>{languageListener=fn;fn('de');return()=>unsub++;},getState:async()=>{order.push(document.documentElement.lang);return {ok:true,value:snapshot()};},command:async()=>commandResult};
  const mounted=mountSettings({document,api,I18n});await mounted.ready;assert.deepEqual(order,['de']);const option=document.getElementById('profiles').children[0];assert.equal(option.textContent,'<img src=x onerror=alert(1)> · 🌍');assert.equal(option.children.length,0);
  const status=document.getElementById('status');const before=status.textContent;await mounted.command('import-backup',{});assert.equal(status.textContent,before);
  commandResult={ok:false,error:{code:'local-write-failed',messageKey:'progress.error.local-write-failed'},snapshot:snapshot(2)};await mounted.command('rename',{profileId:'P',name:'N'});const german=status.textContent;languageListener('en');assert.notEqual(status.textContent,german);
  stateListener({...snapshot(3),sync:{phase:'recovery',code:'local-read-failed'}});assert.equal(document.getElementById('retry-local').hidden,false);assert.equal(document.getElementById('create').disabled,true);
  mounted.dispose();mounted.dispose();assert.equal(unsub,2);const reopened=mountSettings({document:dom(),api,I18n});await reopened.ready;reopened.dispose();assert.equal(unsub,4);
});
test('Unicode name limits count code points without silent HTML truncation and EN/DE key parity',()=>{
  assert.equal(validateProfileText('😀'.repeat(80),'').ok,true);assert.equal(validateProfileText('😀'.repeat(81),'').ok,false);assert.equal(validateProfileText('  ','').ok,false);assert.equal(validateProfileText('A','🌍'.repeat(81)).ok,false);
  const fs=require('node:fs');const source=fs.readFileSync(require.resolve('../../src/settings/index.html'),'utf8');assert.doesNotMatch(source,/maxlength/i);assert.match(source,/Content-Security-Policy/);
  for(const key of I18n.keys('en')){assert.ok(I18n.keys('de').includes(key),key);assert.notEqual(I18n.t('de',key),key);}assert.deepEqual(I18n.keys('en').sort(),I18n.keys('de').sort());
});
test('retry that remains in recovery never reports saved and authoritative recovery replaces old status',async()=>{
  const document=dom();let onSnapshot;const recovery={...snapshot(3),sync:{phase:'recovery',code:'local-read-failed'}};
  const api={onSnapshot:fn=>{onSnapshot=fn;return()=>{};},onLanguage:()=>()=>{},getState:async()=>({ok:true,value:snapshot()}),command:async operation=>({ok:true,value:operation==='retry-local'?recovery:snapshot(2)})};
  const mounted=mountSettings({document,api,I18n});await mounted.ready;await mounted.command('rename',{profileId:'P',name:'N'});assert.equal(document.getElementById('status').textContent,I18n.t('en','profiles.saved'));
  onSnapshot(recovery);assert.equal(document.getElementById('status').textContent,I18n.t('en','progress.error.local-read-failed'));
  await mounted.command('retry-local',{});assert.equal(document.getElementById('status').textContent,I18n.t('en','progress.error.local-read-failed'));mounted.dispose();
});
test('a delayed initial read cannot replace a newer activation, and disposal ignores replies',async()=>{
  const document=dom();let onSnapshot;let resolve;const api={onSnapshot:fn=>{onSnapshot=fn;return()=>{};},onLanguage:()=>()=>{},getState:()=>new Promise(r=>{resolve=r;}),command:async()=>({ok:true,value:snapshot()})};
  const mounted=mountSettings({document,api,I18n});onSnapshot({...snapshot(5),sessionGeneration:'B',activeProfile:{id:'B',name:'New',region:''}});resolve({ok:true,value:snapshot(1)});await mounted.ready;
  assert.equal(document.getElementById('active-profile').textContent,'New');mounted.dispose();onSnapshot(snapshot(6));assert.equal(document.getElementById('active-profile').textContent,'New');
});
test('settings preload exposes exact command envelope and allowlisted removable subscriptions',async()=>{
  const fs=require('node:fs');const Module=require('node:module');const filename=require.resolve('../../src/settings/preload');const loaded=new Module(filename,module);let exposed;const invoked=[];const sent=[];const renderer=new EventEmitter();renderer.send=(...args)=>sent.push(args);renderer.invoke=async(...args)=>{invoked.push(args);return {ok:true,value:{canceled:true}};};loaded.require=name=>{assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld:(name,value)=>{assert.ok(['profileApi','transferApi'].includes(name));if(name==='profileApi')exposed=value;}},ipcRenderer:renderer};};loaded._compile(fs.readFileSync(filename,'utf8'),filename);
  await exposed.getState();await exposed.command('retry-local',{sessionGeneration:'A'});assert.deepEqual(invoked,[['progress:get'],['profiles:command',{command:'retry-local',payload:{sessionGeneration:'A'}}]]);await assert.rejects(exposed.command('arbitrary',{}));assert.equal(invoked.length,2);
  let language;const off=exposed.onLanguage(value=>{language=value;});renderer.emit('profiles:language',{},'de');assert.equal(language,'de');off();off();assert.equal(renderer.listenerCount('profiles:language'),0);
  const offSnapshot=exposed.onSnapshot(()=>{});assert.equal(renderer.listenerCount('progress:snapshot'),1);offSnapshot();assert.equal(renderer.listenerCount('progress:snapshot'),0);const offPrepare=exposed.onPrepareQuit(()=>{});const offResume=exposed.onResumeAfterQuit(()=>{});exposed.quitReady({requestId:'Q',ok:true});assert.deepEqual(sent,[['progress:quit-ready',{requestId:'Q',ok:true}]]);offPrepare();offResume();assert.equal(renderer.listenerCount('progress:prepare-quit'),0);assert.equal(renderer.listenerCount('progress:resume-after-quit'),0);
});

test('an older command reply cannot change status after a newer authoritative activation',async()=>{
  const document=dom();let onSnapshot;let resolve;const api={onSnapshot:fn=>{onSnapshot=fn;return()=>{};},onLanguage:()=>()=>{},getState:async()=>({ok:true,value:snapshot()}),command:()=>new Promise(r=>{resolve=r;})};
  const mounted=mountSettings({document,api,I18n});await mounted.ready;const pending=mounted.command('rename',{profileId:'P',name:'N'});
  onSnapshot({...snapshot(4),sessionGeneration:'B',activeProfile:{id:'B',name:'New',region:''}});const status=document.getElementById('status').textContent;
  resolve({ok:false,error:{messageKey:'progress.error.local-write-failed'},snapshot:snapshot(2)});await pending;
  assert.equal(document.getElementById('active-profile').textContent,'New');assert.equal(document.getElementById('status').textContent,status);mounted.dispose();
});
test('overlay preload sends exact flat progress payloads and only subscribes to its event allowlist',async()=>{
  const fs=require('node:fs');const Module=require('node:module');const filename=require.resolve('../../src/overlay/preload');const loaded=new Module(filename,module);let exposed;const invoked=[];const sent=[];const renderer=new EventEmitter();renderer.invoke=async(...args)=>{invoked.push(args);return {ok:true,value:{}};};renderer.send=(...args)=>sent.push(args);loaded.require=name=>{assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld:(name,value)=>{assert.equal(name,'overlayApi');exposed=value;}},ipcRenderer:renderer};};loaded._compile(fs.readFileSync(filename,'utf8'),filename);
  const context={sessionGeneration:'A',profileId:'P'};await exposed.getProgress();await exposed.setFound({...context,id:42,found:false});await exposed.setProfilePreferences({...context,hideFound:true});await exposed.selectProfile(context);await exposed.openProfileSettings();
  assert.deepEqual(invoked,[['progress:get'],['progress:set-found',{...context,id:42,found:false}],['progress:set-preferences',{...context,hideFound:true}],['progress:select-profile',context],['profiles:open-settings']]);
  exposed.on('arbitrary',()=>{});assert.equal(renderer.listenerCount('arbitrary'),0);const off=exposed.on('progress:snapshot',()=>{});assert.equal(renderer.listenerCount('progress:snapshot'),1);off();assert.equal(renderer.listenerCount('progress:snapshot'),0);const offPrepare=exposed.onPrepareQuit(()=>{});const offResume=exposed.onResumeAfterQuit(()=>{});exposed.quitReady({requestId:'Q',ok:false});assert.deepEqual(sent,[['progress:quit-ready',{requestId:'Q',ok:false}]]);offPrepare();offResume();assert.equal(renderer.listenerCount('progress:prepare-quit'),0);assert.equal(renderer.listenerCount('progress:resume-after-quit'),0);
});
test('settings freezes acceptance during prepare, waits pending dialog command, and acknowledges failure before matching resume/retry',async()=>{
  const document=dom();let prepare;let resume;let release;let calls=0;const acks=[];
  const api={onSnapshot:()=>()=>{},onLanguage:()=>()=>{},getState:async()=>({ok:true,value:snapshot()}),command:()=>{calls++;return new Promise(resolve=>{release=resolve;});},onPrepareQuit:fn=>{prepare=fn;return()=>{};},onResumeAfterQuit:fn=>{resume=fn;return()=>{};},quitReady:value=>acks.push(value)};
  const mounted=mountSettings({document,api,I18n});await mounted.ready;const command=mounted.command('import-backup',{});const preparing=prepare({requestId:'Q'});await mounted.command('rename',{profileId:'P',name:'bad'});assert.equal(calls,1);assert.equal(document.getElementById('create').disabled,true);assert.deepEqual(acks,[]);
  release({ok:false,error:{messageKey:'progress.error.local-write-failed'},snapshot:snapshot(2)});await command;await preparing;assert.deepEqual(acks,[{requestId:'Q',ok:false}]);resume({requestId:'old'});assert.equal(document.getElementById('create').disabled,true);resume({requestId:'Q'});assert.equal(document.getElementById('create').disabled,false);
  const second=mounted.command('rename',{profileId:'P',name:'Good'});release({ok:true,value:snapshot(3)});await second;await prepare({requestId:'Q2'});assert.deepEqual(acks.at(-1),{requestId:'Q2',ok:true});mounted.dispose();
});
