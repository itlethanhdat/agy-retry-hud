import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {ensureDaemon,stopDaemon,daemonStatus,nextPollMs,runDaemon,scheduleDaemonHandoffs,daemonReuseDecision,stopDaemonSync,daemonPaths,pidAlive,pidIsDaemonProcess} from '../src/daemon.js';
import {PKG_VERSION} from '../src/version.js';
import {DEFAULT_CONTROL_CONFIG,saveControlConfig} from '../src/control.js';
import {saveNative,loadNative,mergeStatusline} from '../src/native.js';

function temp(){return fs.mkdtempSync(path.join(os.tmpdir(),'agy-daemon-'));}
async function waitFor(fn,timeout=3000){const end=Date.now()+timeout;while(Date.now()<end){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,50));}return null;}

test('embedded daemon is singleton per state root and publishes heartbeat',async()=>{
 const base=temp(),root=path.join(base,'native'),config=JSON.parse(JSON.stringify(DEFAULT_CONTROL_CONFIG));config.daemon.heartbeatMs=100;config.daemon.idlePollMs=250;
 const first=ensureDaemon({root,config}),second=ensureDaemon({root,config});assert.equal(first.started,true);assert.equal(second.reused,true);assert.equal(second.status.pid,first.pid);
 const live=await waitFor(()=>{const s=daemonStatus({root});return s.running?s:null;});assert.ok(live);assert.equal(live.processAlive,true);assert.equal(live.runtime.status,'RUNNING');
 const stopped=await stopDaemon({root});assert.equal(stopped.stopped,true);assert.equal(daemonStatus({root}).processAlive,false);
});

test('daemon polling is adaptive and remains conservative for many sessions',()=>{
 const c=JSON.parse(JSON.stringify(DEFAULT_CONTROL_CONFIG)),now=100000;
 assert.equal(nextPollMs([],c,now),10000);
 assert.equal(nextPollMs([{status:'WAIT_QUOTA',nextRetryAt:now+3600000}],c,now),30000);
 assert.equal(nextPollMs([{status:'WAIT_BACKOFF',nextRetryAt:now+600000}],c,now),5000);
 assert.equal(nextPollMs([{status:'WAIT_QUOTA',nextRetryAt:now+30000}],c,now),1000);
 assert.equal(nextPollMs(Array.from({length:20},()=>({status:'IDLE'})),c,now),10000);
});

test('daemon reuse decision rejects stale heartbeats, version drift and dead pids',()=>{
 const now=Date.now(),healthy={processAlive:true,running:true,startedAt:now-1000,heartbeatAgeMs:1000,version:PKG_VERSION};
 assert.deepEqual(daemonReuseDecision(healthy,{now}),{reuse:true});
 assert.deepEqual(daemonReuseDecision({...healthy,running:false,heartbeatAgeMs:120000,startedAt:now-120000},{now}),{reuse:false,reason:'stale_heartbeat'});
 assert.deepEqual(daemonReuseDecision({...healthy,running:false,heartbeatAgeMs:null,startedAt:now-1000},{now}),{reuse:true},'startup grace covers a just-spawned daemon before its first heartbeat');
 assert.deepEqual(daemonReuseDecision({...healthy,version:'0.5.0'},{now}),{reuse:false,reason:'version_mismatch'});
 assert.deepEqual(daemonReuseDecision({...healthy,version:undefined},{now}),{reuse:false,reason:'version_mismatch'});
 assert.deepEqual(daemonReuseDecision({processAlive:false},{now}),{reuse:false,reason:'not_running'});
});

test('stopDaemonSync terminates a stuck daemon process without async plumbing',()=>{
 const base=temp(),root=path.join(base,'native'),p=daemonPaths({root});
 fs.mkdirSync(p.dir,{recursive:true});
 const impostor=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});impostor.unref();
 fs.writeFileSync(p.pid,JSON.stringify({pid:impostor.pid,startedAt:Date.now(),version:PKG_VERSION}));
 const out=stopDaemonSync({root});
 assert.equal(out.stopped,true);
 assert.equal(pidAlive(impostor.pid),false);
 assert.equal(fs.existsSync(p.pid),false,'pid file is cleared after the process dies');
});

test('ensureDaemon replaces a live daemon running stale code',async()=>{
 const base=temp(),root=path.join(base,'native'),config=JSON.parse(JSON.stringify(DEFAULT_CONTROL_CONFIG));
 const p=daemonPaths({root});fs.mkdirSync(p.dir,{recursive:true});
 const fakeDaemon=path.join(base,'fake-daemon.js');fs.writeFileSync(fakeDaemon,'setInterval(()=>{},1000);');
 const impostor=spawn(process.execPath,[fakeDaemon],{detached:true,stdio:'ignore'});impostor.unref();
 fs.writeFileSync(p.pid,JSON.stringify({pid:impostor.pid,startedAt:Date.now()-120000,version:'0.0.0-stale'}));
 fs.writeFileSync(p.runtime,JSON.stringify({heartbeatAt:Date.now()}));
 const out=ensureDaemon({root,config});
 assert.equal(out.started,true);
 assert.equal(out.replaced,'version_mismatch');
 assert.equal(pidAlive(impostor.pid),false,'stale daemon process is terminated before the replacement starts');
 const live=await waitFor(()=>{const s=daemonStatus({root});return s.running&&s.version===PKG_VERSION?s:null;});
 assert.ok(live,'replacement daemon heartbeats with the current code version');
 const stopped=await stopDaemon({root});assert.equal(stopped.stopped,true);
});

test('pidIsDaemonProcess only matches processes launched from a daemon.js entry',()=>{
 const fakeDaemon=path.join(temp(),'probe-daemon.js');fs.writeFileSync(fakeDaemon,'setInterval(()=>{},10000);');
 const daemonLike=spawn(process.execPath,[fakeDaemon],{detached:true,stdio:'ignore'});daemonLike.unref();
 const foreign=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{detached:true,stdio:'ignore'});foreign.unref();
 try{
  assert.equal(pidIsDaemonProcess(daemonLike.pid),true);
  assert.equal(pidIsDaemonProcess(foreign.pid),false);
  assert.equal(pidIsDaemonProcess(0),false);
  assert.equal(pidIsDaemonProcess(2147483647),null,'unknown pid is unverifiable, never assumed foreign-or-ours');
 }finally{
  try{process.kill(daemonLike.pid,'SIGKILL');}catch{}
  try{process.kill(foreign.pid,'SIGKILL');}catch{}
 }
});

test('ensureDaemon never signals a foreign process holding a recycled pid',async()=>{
 const base=temp(),root=path.join(base,'native'),config=JSON.parse(JSON.stringify(DEFAULT_CONTROL_CONFIG));
 const p=daemonPaths({root});fs.mkdirSync(p.dir,{recursive:true});
 const foreign=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});foreign.unref();
 fs.writeFileSync(p.pid,JSON.stringify({pid:foreign.pid,startedAt:Date.now()-120000,version:'0.0.0-stale'}));
 fs.writeFileSync(p.runtime,JSON.stringify({heartbeatAt:Date.now()}));
 const out=ensureDaemon({root,config});
 assert.equal(out.started,true);
 assert.equal(out.replaced,'version_mismatch');
 assert.equal(pidAlive(foreign.pid),true,'foreign process must survive the self-healing path untouched');
 const live=await waitFor(()=>{const s=daemonStatus({root});return s.running?s:null;});
 assert.ok(live,'a fresh daemon still starts after the stale pid file is dropped');
 try{process.kill(foreign.pid,'SIGKILL');}catch{}
 const stopped=await stopDaemon({root});assert.equal(stopped.stopped,true);
});


test('singleton daemon adopts a persisted waiting incident and schedules it without a HUD redraw',async()=>{
 const base=temp(),root=path.join(base,'native'),configFile=path.join(base,'config.json'),config=JSON.parse(JSON.stringify(DEFAULT_CONTROL_CONFIG)),id='12345678-abcd-ef01-2345-6789abcdef01';config.daemon.idlePollMs=20;config.daemon.waitBackoffPollMs=20;config.daemon.heartbeatMs=20;saveControlConfig(config,{file:configFile});
 saveNative(root,{schemaVersion:1,conversationId:id,status:'WAIT_BACKOFF',daemonManaged:true,nextRetryAt:Date.now()+60_000,retryKind:'transient',retryIncident:{id:'ri-test',status:'WAITING'},scheduler:{incidentId:'ri-test',status:'STARTING',nextRetryAt:Date.now()+60_000},snapshot:{quota:[]}});
 const abort=new AbortController();let calls=0;await runDaemon({root,configFile,signal:abort.signal,retryRunner:async(r,conversation,{expectedIncidentId})=>{calls++;assert.equal(conversation,id);assert.equal(expectedIncidentId,'ri-test');const st=loadNative(r,id);st.status='IDLE';st.nextRetryAt=null;saveNative(r,st);abort.abort();return st;},handoffRunner:async()=>{throw Error('handoff not expected');}});
 assert.equal(calls,1);assert.equal(loadNative(root,id).status,'IDLE');assert.equal(daemonStatus({root}).processAlive,false);
});


test('daemon migration rebinds a v0.4 waiting incident so an old detached worker becomes stale',async()=>{
 const base=temp(),root=path.join(base,'native'),configFile=path.join(base,'config.json'),config=JSON.parse(JSON.stringify(DEFAULT_CONTROL_CONFIG)),id='abcdef12-3456-7890-abcd-ef1234567890';config.daemon.waitBackoffPollMs=20;config.daemon.heartbeatMs=20;saveControlConfig(config,{file:configFile});
 saveNative(root,{schemaVersion:1,conversationId:id,status:'WAIT_BACKOFF',nextRetryAt:Date.now()+60_000,retryKind:'transient',retryIncident:{id:'ri-old',status:'WAITING'},scheduler:{incidentId:'ri-old',status:'WAITING',nextRetryAt:Date.now()+60_000,workerPid:999999},snapshot:{quota:[]}});
 const abort=new AbortController();let adopted='';await runDaemon({root,configFile,signal:abort.signal,retryRunner:async(r,conversation,{expectedIncidentId})=>{adopted=expectedIncidentId;const st=loadNative(r,id);st.status='IDLE';st.nextRetryAt=null;saveNative(r,st);abort.abort();return st;}});const state=loadNative(root,id);assert.notEqual(adopted,'ri-old');assert.match(adopted,/^ri-old-v5-/);assert.equal(state.daemonManaged,true);
});


test('daemon owns automatic handoff scheduling from fast statusline telemetry',()=>{
 const base=temp(),root=path.join(base,'native'),id='fedcba98-7654-3210-fedc-ba9876543210',config=JSON.parse(JSON.stringify(DEFAULT_CONTROL_CONFIG));config.handoff.semanticSummary=false;config.handoff.autoCreateNewSession=false;
 const payload={conversation_id:id,cwd:base,workspace:{current_dir:base},model:{id:'gemini-test'},context_window:{used_percentage:88},quota:{},agent_state:'idle',pending_input_count:0,task_count:0,tool_confirmation_pending:false,terminal_width:100};
 mergeStatusline(root,payload,1000,{persist:'fast',env:{}});assert.equal(loadNative(root,id),null,'statusline telemetry alone must not schedule handoff work');
 const scheduled=scheduleDaemonHandoffs(root,config,{now:1100});assert.equal(scheduled,1);const state=loadNative(root,id);assert.equal(state.handoff.status,'PREPARING');assert.equal(state.handoff.contextPercent,88);
});
