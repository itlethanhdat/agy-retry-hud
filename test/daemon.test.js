import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ensureDaemon,stopDaemon,daemonStatus,nextPollMs,runDaemon,scheduleDaemonHandoffs} from '../src/daemon.js';
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
