import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {mergeStatusline,loadNative,renderNativeStatusline,scheduleFromStop,scheduleFromPreInvocation,runNativeWorker,saveNative,visibleWidth,selectDisplayQuotas,schedulerHealth,retrySchedulerDiagnostics,fmtCountdown} from '../src/native.js';

const conv='12345678-abcd-ef01-2345-6789abcdef01';
function temp(prefix='agy-native-'){return fs.mkdtempSync(path.join(os.tmpdir(),prefix));}
function payload(extra={},cwd='/tmp/project'){return {email:'secret@example.com',plan_tier:'Pro',conversation_id:conv,cwd,workspace:{current_dir:cwd},model:{id:'gemini-test',display_name:'Gemini Test'},context_window:{used_percentage:42},quota:{'gemini-5h':{remaining_fraction:0,reset_time:'2030-01-01T01:00:00Z'},'gemini-weekly':{remaining_fraction:.8,reset_time:'2030-01-07T00:00:00Z'}},agent_state:'idle',pending_input_count:0,tool_confirmation_pending:false,terminal_width:120,...extra};}

test('native statusline stores sanitized active-session telemetry and renders retry state',()=>{
 const root=temp(),now=Date.parse('2030-01-01T00:00:00Z');const state=mergeStatusline(root,payload(),now);
 assert.equal(state.snapshot.contextPercent,42);assert.equal(state.snapshot.quota.length,2);assert.equal(state.status,'IDLE');
 state.status='WAIT_QUOTA';state.retryKind='quota';state.retryLabel='QUOTA';state.nextRetryAt=now+3600000;state.waitStartedAt=now;state.config={maxQuotaRetries:2,maxTransientRetries:6};state.retryIncident={id:'ri-demo',status:'WAITING',kind:'quota'};state.scheduler={status:'WAITING',incidentId:'ri-demo',workerPid:process.pid,workerStartedAt:now,lastHeartbeatAt:now,nextRetryAt:state.nextRetryAt,deadlineSource:'server',retryLabel:'QUOTA',attempt:1,maxAttempts:2};saveNative(root,state);
 const text=renderNativeStatusline(payload(),loadNative(root,conv),now,{color:false});assert.match(text,/Gemini Test/);assert.match(text,/ctx .*42%/);assert.match(text,/5h .*0%/);assert.match(text,/week .*80%/);assert.match(text,/retry:WAIT 01:00:00/);assert.match(text,/QUOTA/);assert.match(text,/1\/2/);assert.match(text,/sched:OK/);
 assert.doesNotMatch(text,/secret@example\.com/);
 const telemetryText=fs.readdirSync(path.join(root,'telemetry')).map(f=>fs.readFileSync(path.join(root,'telemetry',f),'utf8')).join('');assert.doesNotMatch(telemetryText,/secret@example\.com/);
});

test('Stop hook schedules one conservative native worker and deduplicates repeated stop events',()=>{
 const root=temp(),now=Date.parse('2030-01-01T00:00:00Z');mergeStatusline(root,payload(),now);let spawned=0;
 const stop={terminationReason:'error',error:'RESOURCE_EXHAUSTED (code 429): Individual quota reached',fullyIdle:true,conversationId:conv,workspacePaths:['/tmp/project'],modelName:'gemini-test'};
 const first=scheduleFromStop(root,stop,{now,config:{resetMarginMs:90000,jitterMs:0},spawnWorker:()=>spawned++});
 assert.equal(first.scheduled,true);assert.equal(spawned,1);const s=loadNative(root,conv);assert.equal(s.status,'WAIT_QUOTA');assert.equal(s.nextRetryAt,Date.parse('2030-01-01T01:01:30Z'));
 const second=scheduleFromStop(root,stop,{now:now+1000,spawnWorker:()=>spawned++});assert.equal(second.scheduled,false);assert.equal(spawned,1);
});


test('exact AGY individual quota message schedules retry at advertised reset even when Stop is not fully idle',()=>{
 const root=temp(),now=Date.parse('2030-01-01T00:00:00Z');mergeStatusline(root,payload({agent_state:'working'}),now);let spawned=0;
 const error=`Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h23m10s.
Error ID: 9fad01c9-ba6c-45c1-807f-2d38afbc53fb-749`;
 const out=scheduleFromStop(root,{executionNum:7,terminationReason:'error',error,fullyIdle:false,conversationId:conv,workspacePaths:['/tmp/project']},{now,config:{resetMarginMs:90000,jitterMs:0},spawnWorker:()=>spawned++});
 assert.equal(out.scheduled,true);assert.equal(spawned,1);const state=loadNative(root,conv);assert.equal(state.status,'WAIT_QUOTA');assert.equal(state.retryIncident.kind,'quota');assert.equal(state.nextRetryAt,now+(2*3600+23*60+10)*1000+90000);assert.equal(state.lastStop.classification,'quota');assert.equal(state.lastStop.classificationSource,'payload');
});

test('Stop error with missing error string can fall back to exhausted 5h telemetry',()=>{
 const root=temp(),now=Date.parse('2030-01-01T00:00:00Z');
 const p=payload({quota:{'gemini-5h':{remaining_fraction:0,reset_in_seconds:8590},'gemini-weekly':{remaining_fraction:.8,reset_in_seconds:6*86400}}});mergeStatusline(root,p,now);let spawned=0;
 const out=scheduleFromStop(root,{executionNum:8,terminationReason:'error',error:'',fullyIdle:true,conversationId:conv,workspacePaths:['/tmp/project']},{now,config:{resetMarginMs:90000,jitterMs:0},spawnWorker:()=>spawned++});
 assert.equal(out.scheduled,true);assert.equal(spawned,1);const state=loadNative(root,conv);assert.equal(state.status,'WAIT_QUOTA');assert.equal(state.lastStop.classification,'quota');assert.equal(state.lastStop.classificationSource,'telemetry-5h');assert.equal(state.nextRetryAt,now+8590*1000+90000);
});

test('missing Stop error never becomes quota when the 5h bucket is still healthy',()=>{
 const root=temp(),now=Date.parse('2030-01-01T00:00:00Z');
 const p=payload({quota:{'gemini-5h':{remaining_fraction:.25,reset_in_seconds:8590},'gemini-weekly':{remaining_fraction:.8,reset_in_seconds:6*86400}}});mergeStatusline(root,p,now);let spawned=0;
 const out=scheduleFromStop(root,{executionNum:9,terminationReason:'error',error:'',fullyIdle:true,conversationId:conv,workspacePaths:['/tmp/project']},{now,spawnWorker:()=>spawned++});
 assert.equal(out.scheduled,false);assert.equal(spawned,0);const state=loadNative(root,conv);assert.equal(state.status,'NEEDS_USER');assert.equal(state.lastStop.classification,'unknown');
});

test('normal native Stop cancels a pending retry to avoid duplicate dispatch after manual continuation',()=>{
 const root=temp(),now=1000000;mergeStatusline(root,payload({quota:{}}),now);let n=0;
 scheduleFromStop(root,{terminationReason:'error',error:'503 service unavailable',fullyIdle:true,conversationId:conv,workspacePaths:['/tmp/project']},{now,config:{transientBaseMs:1000,transientCapMs:1000,jitterMs:0},spawnWorker:()=>n++});
 assert.equal(loadNative(root,conv).status,'WAIT_BACKOFF');
 const r=scheduleFromStop(root,{terminationReason:'success',fullyIdle:true,conversationId:conv,workspacePaths:['/tmp/project']},{now:now+100,spawnWorker:()=>n++});
 assert.equal(r.scheduled,false);const state=loadNative(root,conv);assert.equal(state.status,'IDLE');assert.equal(state.nextRetryAt,null);assert.equal(state.retryIncident.status,'RESOLVED');assert.equal(n,1);
});

test('Stop hook never schedules auth, but confirmed retryable errors may arm while background work is still active',()=>{
 const root=temp(),now=1000000;mergeStatusline(root,payload({quota:{}}),now);
 let n=0;let r=scheduleFromStop(root,{terminationReason:'error',error:'401 unauthenticated',fullyIdle:true,conversationId:conv},{now,spawnWorker:()=>n++});assert.equal(r.scheduled,false);assert.equal(loadNative(root,conv).status,'NEEDS_USER');
 // A retryable transient error remains eligible even when AGY reports fullyIdle=false.
 // The detached worker will re-check native activity again before dispatch.
 r=scheduleFromStop(root,{terminationReason:'error',error:'503 service unavailable',fullyIdle:false,conversationId:conv},{now:now+100,config:{transientBaseMs:1000,transientCapMs:1000,jitterMs:0},spawnWorker:()=>n++});assert.equal(r.scheduled,true);assert.equal(loadNative(root,conv).status,'WAIT_BACKOFF');assert.equal(n,1);
});

test('native worker waits then resumes exact conversation once and records success',async()=>{
 const root=temp(),workspace=temp('agy-project-'),now=1000000;mergeStatusline(root,payload({quota:{}},workspace),now);
 scheduleFromStop(root,{terminationReason:'error',error:'503 service unavailable',fullyIdle:true,conversationId:conv,workspacePaths:[workspace]},{now,config:{transientBaseMs:1000,transientCapMs:1000,jitterMs:0,maxJobElapsedMs:60000}});
 let sent=[],started=0;const adapter=cfg=>{started++;assert.equal(cfg.conversation,conv);assert.equal(fs.realpathSync(cfg.cwd),fs.realpathSync(workspace));return {async *events(){yield {event:'init',conversation_id:conv,init:{cwd:workspace}};yield {event:'result',result:{conversation_id:conv,status:'SUCCESS',response:'ok'}};},async send(m){sent.push(m);},async close(){return {clean:true};},async abort(){return {clean:false};}}};
 let t=now;const out=await runNativeWorker(root,conv,{now:()=>t,sleep:async ms=>{t+=ms;},adapter});
 assert.equal(out.status,'SUCCEEDED');assert.equal(started,1);assert.equal(sent.length,1);assert.match(sent[0],/same conversation/);
});

test('native worker applies bounded retry budget after background transient failure',async()=>{
 const root=temp(),workspace=temp('agy-project-'),now=2000000;mergeStatusline(root,payload({quota:{}},workspace),now);
 scheduleFromStop(root,{terminationReason:'error',error:'503 service unavailable',fullyIdle:true,conversationId:conv,workspacePaths:[workspace]},{now,config:{transientBaseMs:1,transientCapMs:1,jitterMs:0,maxTransientRetries:1,maxJobElapsedMs:60000}});
 let t=now,calls=0;const adapter=()=>({async *events(){calls++;yield {event:'init',conversation_id:conv,init:{cwd:workspace}};yield {event:'result',result:{conversation_id:conv,status:'ERROR',error:'503 service unavailable'}};},async send(){},async close(){return {clean:true};},async abort(){return {clean:false};}});
 const out=await runNativeWorker(root,conv,{now:()=>t,sleep:async ms=>{t+=ms;},adapter});assert.equal(out.status,'EXHAUSTED');assert.equal(out.transientRetries,1);assert.equal(calls,1);
});

test('native worker cancels before dispatch when native TUI becomes active again',async()=>{
 const root=temp(),workspace=temp('agy-project-'),now=3000000;mergeStatusline(root,payload({quota:{}},workspace),now);
 scheduleFromStop(root,{terminationReason:'error',error:'503 service unavailable',fullyIdle:true,conversationId:conv,workspacePaths:[workspace]},{now,config:{transientBaseMs:1000,transientCapMs:1000,jitterMs:0,maxJobElapsedMs:60000}});
 mergeStatusline(root,payload({quota:{},agent_state:'running'},workspace),now+500);
 let t=now,calls=0;const out=await runNativeWorker(root,conv,{now:()=>t,sleep:async ms=>{t+=ms;},adapter:()=>{calls++;throw Error('must not start')}});
 assert.equal(out.status,'IDLE');assert.match(out.reason,/native AGY activity.*superseded/i);assert.equal(out.retryIncident.status,'SUPERSEDED');assert.equal(calls,0);
});



test('PreInvocation supersedes a pending retry incident before a manual/new turn',()=>{
 const root=temp(),now=4_000_000;mergeStatusline(root,payload({quota:{}}),now);let spawned=0,incidentId='';
 const scheduled=scheduleFromStop(root,{executionNum:3,terminationReason:'error',error:'503 service unavailable',fullyIdle:true,conversationId:conv,workspacePaths:['/tmp/project']},{now,config:{transientBaseMs:1000,transientCapMs:1000,jitterMs:0},spawnWorker:(id,incident)=>{spawned++;incidentId=incident;}});
 assert.equal(scheduled.scheduled,true);assert.equal(spawned,1);assert.ok(incidentId);assert.equal(loadNative(root,conv).retryIncident.status,'WAITING');
 const pre=scheduleFromPreInvocation(root,{conversationId:conv,invocationNum:9},{now:now+100});assert.equal(pre.superseded,true);const state=loadNative(root,conv);assert.equal(state.status,'IDLE');assert.equal(state.retryIncident.id,incidentId);assert.equal(state.retryIncident.status,'SUPERSEDED');assert.equal(state.nextRetryAt,null);
});

test('stale worker for an older incident cannot dispatch a newer retry incident',async()=>{
 const root=temp(),workspace=temp('agy-project-'),now=5_000_000;mergeStatusline(root,payload({quota:{}},workspace),now);let firstIncident='';
 scheduleFromStop(root,{executionNum:1,terminationReason:'error',error:'503 service unavailable',fullyIdle:true,conversationId:conv,workspacePaths:[workspace]},{now,config:{transientBaseMs:1000,transientCapMs:1000,jitterMs:0,maxJobElapsedMs:60000},spawnWorker:(id,incident)=>{firstIncident=incident;}});
 scheduleFromPreInvocation(root,{conversationId:conv,invocationNum:2},{now:now+100});
 let secondIncident='';scheduleFromStop(root,{executionNum:2,terminationReason:'error',error:'503 service unavailable',fullyIdle:true,conversationId:conv,workspacePaths:[workspace]},{now:now+200,config:{transientBaseMs:1000,transientCapMs:1000,jitterMs:0,maxJobElapsedMs:60000},spawnWorker:(id,incident)=>{secondIncident=incident;}});
 assert.notEqual(firstIncident,secondIncident);let calls=0,t=now+200;const out=await runNativeWorker(root,conv,{expectedIncidentId:firstIncident,now:()=>t,sleep:async ms=>{t+=ms;},adapter:()=>{calls++;throw Error('stale worker must never dispatch');}});assert.equal(out.status,'STALE_RETRY');assert.equal(calls,0);const current=loadNative(root,conv);assert.equal(current.retryIncident.id,secondIncident);assert.equal(current.retryIncident.status,'WAITING');assert.equal(current.status,'WAIT_BACKOFF');
});

test('retry incidents are conversation-local: completion in A never arms or dispatches because B exhausted quota',async()=>{
 const root=temp(),workspace=temp('agy-project-'),now=6_000_000,convB='abcdef12-3456-7890-abcd-ef1234567890';
 mergeStatusline(root,payload({quota:{}},workspace),now);
 // A has completed normally and has no retry incident.
 scheduleFromStop(root,{executionNum:1,terminationReason:'model_stop',error:'',fullyIdle:true,conversationId:conv,workspacePaths:[workspace]},{now});
 // B independently encounters a transient quota/API incident.
 const pB={...payload({quota:{}},workspace),conversation_id:convB};mergeStatusline(root,pB,now);let incidentB='';scheduleFromStop(root,{executionNum:1,terminationReason:'error',error:'503 service unavailable',fullyIdle:true,conversationId:convB,workspacePaths:[workspace]},{now,config:{transientBaseMs:1000,transientCapMs:1000,jitterMs:0,maxJobElapsedMs:60000},spawnWorker:(id,incident)=>{incidentB=incident;}});
 assert.equal(loadNative(root,conv).retryIncident,null);assert.equal(loadNative(root,conv).status,'IDLE');assert.ok(incidentB);assert.equal(loadNative(root,convB).retryIncident.status,'WAITING');
 let aCalls=0,t=now;const aOut=await runNativeWorker(root,conv,{now:()=>t,sleep:async ms=>{t+=ms;},adapter:()=>{aCalls++;throw Error('A must not dispatch');}});assert.equal(aOut.status,'IDLE');assert.equal(aCalls,0);
});


test('worker refuses a WAIT state that has no current retry incident',async()=>{
 const root=temp(),workspace=temp('agy-project-'),now=7_000_000;let state=mergeStatusline(root,payload({quota:{}},workspace),now);state.status='WAIT_BACKOFF';state.retryKind='transient';state.nextRetryAt=now+1000;state.waitStartedAt=now;state.startedAt=now;state.config={...state.config,transientBaseMs:1000,transientCapMs:1000,jitterMs:0,maxJobElapsedMs:60000};state.retryIncident=null;saveNative(root,state);
 let calls=0,t=now;const out=await runNativeWorker(root,conv,{now:()=>t,sleep:async ms=>{t+=ms;},adapter:()=>{calls++;throw Error('missing incident must never dispatch');}});assert.equal(out.status,'STALE_RETRY');assert.equal(calls,0);
});

test('HUD is adaptive, colored, provider-aware and never exceeds reported terminal width',()=>{
 const now=Date.parse('2030-01-01T00:00:00Z');
 const p=payload({terminal_width:96,model:{id:'gemini-3.8-flash',display_name:'Gemini 3.8 Flash (Medium)'},vcs:{branch:'main',dirty:true},context_window:{used_percentage:37,context_window_size:1048576,current_usage:{input_tokens:63382,output_tokens:346,cache_read_input_tokens:20857}},task_count:1,artifact_count:2,quota:{
  'gemini-5h':{remaining_fraction:.52,reset_time:'2030-01-01T02:47:00Z'},
  'gemini-weekly':{remaining_fraction:.84,reset_time:'2030-01-07T21:00:00Z'},
  'claude-5h':{remaining_fraction:.48,reset_time:'2030-01-01T03:11:00Z'},
  'claude-weekly':{remaining_fraction:.48,reset_time:'2030-01-07T22:00:00Z'}
 }});
 const selected=selectDisplayQuotas(p,now);assert.deepEqual(selected.map(x=>x.provider),['gemini','gemini']);
 const plain=renderNativeStatusline(p,null,now,{color:false,bar_width:10});assert.match(plain,/Gemini 3\.8 Flash/);assert.match(plain,/Pro/);assert.match(plain,/5h .*52%/);assert.match(plain,/week .*84%/);assert.doesNotMatch(plain,/48%/);assert.match(plain,/█/);assert.match(plain,/↻ 6d21h/);
 for(const line of plain.split('\n'))assert.ok(visibleWidth(line)<=92,`line overflow ${visibleWidth(line)}: ${line}`);
 const colored=renderNativeStatusline(p,null,now,{color:true,bar_width:10});assert.match(colored,/\x1b\[/);
});

test('HUD metric grid keeps labels, bars, percentages and detail columns visually aligned',()=>{
 const now=Date.parse('2030-01-01T00:00:00Z');
 const p=payload({terminal_width:100,plan_tier:'Google AI Pro',workspace:{current_dir:'/home/user/.local'},model:{id:'gemini-3.7-flash',display_name:'Gemini 3.7 Flash (Medium)'},context_window:{used_percentage:0,context_window_size:1048576},quota:{
  'gemini-5h':{remaining_fraction:.28,reset_in_seconds:7800},
  'gemini-weekly':{remaining_fraction:.45,reset_in_seconds:158400}
 }});
 const text=renderNativeStatusline(p,null,now,{color:false,compact:false,bar_width:10});const rows=text.split('\n').slice(1);
 assert.equal(rows.length,2);assert.match(rows[1],/5h .*28% left .*↻ 2h10m/);assert.match(rows[1],/week .*45% left .*↻ 1d20h/);
 assert.ok(rows[1].indexOf('5h')<rows[1].indexOf('week'),'5h and week remain on the same ordered quota row');
 assert.doesNotMatch(rows[1],/↻\S/,'refresh icon is separated from duration');
 for(const row of rows)assert.ok(visibleWidth(row)<=96,`row overflow ${visibleWidth(row)}: ${row}`);
});

test('HUD shows retry countdown, transient reason, attempt budget and scheduler health',()=>{
 const now=10_000,state={status:'WAIT_BACKOFF',retryKind:'transient',retryLabel:'503',waitStartedAt:0,startedAt:0,nextRetryAt:20_000,transientRetries:1,quotaRetries:0,config:{maxTransientRetries:6,maxQuotaRetries:2},retryIncident:{id:'ri-503',status:'WAITING'},scheduler:{status:'WAITING',incidentId:'ri-503',workerPid:process.pid,workerStartedAt:0,lastHeartbeatAt:now,nextRetryAt:20_000,deadlineSource:'backoff',retryLabel:'503',attempt:2,maxAttempts:6},snapshot:{agentState:'idle'}};
 const text=renderNativeStatusline(payload({quota:{},terminal_width:120}),state,now,{color:false});assert.match(text,/retry:WAIT 00:10/);assert.match(text,/503/);assert.match(text,/2\/6/);assert.match(text,/sched:OK/);assert.doesNotMatch(text,/50%/);
});


test('mergeStatusline returns ephemeral null before AGY assigns a conversation id',()=>{
 const root=temp(),now=Date.parse('2030-01-01T00:00:00Z');const p=payload();delete p.conversation_id;
 const state=mergeStatusline(root,p,now);assert.equal(state,null);assert.equal(fs.existsSync(path.join(root,'telemetry')),false);
 const text=renderNativeStatusline(p,state,now,{color:false});assert.match(text,/Gemini Test/);assert.match(text,/ctx .*42%/);
});


test('non-idle normal Stop is deferred without creating PAUSED_UNCERTAIN',()=>{
 const root=temp(),now=8_000_000;mergeStatusline(root,payload({quota:{},agent_state:'working'}),now);let n=0;
 const r=scheduleFromStop(root,{terminationReason:'model_stop',error:'',fullyIdle:false,conversationId:conv},{now,spawnWorker:()=>n++});
 assert.equal(r.scheduled,false);assert.equal(r.deferred,true);const state=loadNative(root,conv);assert.equal(state?.status,'IDLE');assert.equal(state?.retryIncident,null);assert.equal(n,0);
});

test('statusline resume self-heals the legacy v0.4.5 non-idle PAUSED_UNCERTAIN marker',()=>{
 const root=temp(),now=9_000_000;let state=mergeStatusline(root,payload({quota:{}}),now);
 state.status='PAUSED_UNCERTAIN';state.reason='stop hook fired while background work is still active';state.nextRetryAt=null;state.retryIncident=null;saveNative(root,state);
 const merged=mergeStatusline(root,payload({quota:{},agent_state:'idle'}),now+100);
 assert.equal(merged.status,'IDLE');assert.match(merged.reason,/stale non-idle Stop marker cleared/i);assert.equal(loadNative(root,conv).status,'IDLE');
 const hud=renderNativeStatusline(payload({quota:{}}),loadNative(root,conv),now+100,{color:false});assert.match(hud,/retry:ON/);assert.doesNotMatch(hud,/NEEDS USER|UNCERTAIN/);
});

test('PreInvocation self-heals the legacy non-idle PAUSED_UNCERTAIN marker even without an active incident',()=>{
 const root=temp(),now=10_000_000;let state=mergeStatusline(root,payload({quota:{}}),now);
 state.status='PAUSED_UNCERTAIN';state.reason='stop hook fired while background work is still active';state.nextRetryAt=null;state.retryIncident=null;saveNative(root,state);
 const pre=scheduleFromPreInvocation(root,{conversationId:conv,invocationNum:11},{now:now+100});assert.equal(pre.recovered,true);state=loadNative(root,conv);assert.equal(state.status,'IDLE');assert.equal(state.nextRetryAt,null);assert.equal(state.retryIncident,null);
});

test('HUD distinguishes genuine PAUSED_UNCERTAIN from NEEDS_USER',()=>{
 const root=temp(),now=11_000_000;let state=mergeStatusline(root,payload({quota:{}}),now);
 state.status='PAUSED_UNCERTAIN';state.reason='background AGY retry/rollover outcome uncertain';state.retryIncident={id:'ri-test',conversationId:conv,status:'PAUSED_UNCERTAIN',kind:'transient',fingerprint:'x',createdAt:now,updatedAt:now};saveNative(root,state);
 const uncertain=renderNativeStatusline(payload({quota:{}}),loadNative(root,conv),now,{color:false});assert.match(uncertain,/retry:UNCERTAIN/);assert.doesNotMatch(uncertain,/retry:NEEDS USER/);
 state.status='NEEDS_USER';state.reason='weekly quota unavailable before quota retry';saveNative(root,state);const needs=renderNativeStatusline(payload({quota:{}}),loadNative(root,conv),now,{color:false});assert.match(needs,/retry:NEEDS USER/);
});

test('manual PreInvocation supersedes NEEDS_USER and PAUSED_UNCERTAIN retry states',()=>{
 const root=temp(),now=12_000_000;mergeStatusline(root,payload({quota:{}}),now);
 scheduleFromStop(root,{executionNum:4,terminationReason:'error',error:'401 unauthenticated',fullyIdle:true,conversationId:conv},{now});
 let state=loadNative(root,conv);assert.equal(state.status,'NEEDS_USER');assert.equal(state.retryIncident.status,'NEEDS_USER');
 let pre=scheduleFromPreInvocation(root,{conversationId:conv,invocationNum:5},{now:now+100});assert.equal(pre.superseded,true);state=loadNative(root,conv);assert.equal(state.status,'IDLE');assert.equal(state.retryIncident.status,'SUPERSEDED');assert.equal(state.nextRetryAt,null);
 state.status='PAUSED_UNCERTAIN';state.reason='background AGY retry/rollover outcome uncertain';state.retryIncident={id:'ri-uncertain',conversationId:conv,status:'PAUSED_UNCERTAIN',kind:'transient',fingerprint:'x',createdAt:now,updatedAt:now};saveNative(root,state);
 pre=scheduleFromPreInvocation(root,{conversationId:conv,invocationNum:6},{now:now+200});assert.equal(pre.superseded,true);state=loadNative(root,conv);assert.equal(state.status,'IDLE');assert.equal(state.retryIncident.status,'SUPERSEDED');assert.equal(state.nextRetryAt,null);
});

test('same conversation in two live terminal instances blocks automatic retry',()=>{
 const root=temp(),now=13_000_000,p=payload({quota:{}});mergeStatusline(root,p,now,{env:{TMUX_PANE:'%1'}});mergeStatusline(root,p,now+100,{env:{TMUX_PANE:'%2'}});let spawned=0;
 const out=scheduleFromStop(root,{executionNum:1,terminationReason:'error',error:'503 service unavailable',fullyIdle:true,conversationId:conv},{now:now+200,spawnWorker:()=>spawned++});
 assert.equal(out.scheduled,false);assert.equal(out.multiCli,true);assert.equal(spawned,0);const state=loadNative(root,conv);assert.equal(state.status,'MULTI_CLI');assert.equal(state.retryIncident.status,'BLOCKED');assert.match(state.reason,/multiple AGY CLI/i);
 const hud=renderNativeStatusline(p,state,now+200,{color:false});assert.match(hud,/retry:MULTI-CLI/);
});

test('worker aborts a pending retry if a second CLI instance opens the same conversation before deadline',async()=>{
 const root=temp(),workspace=temp('agy-project-'),now=14_000_000,p=payload({quota:{}},workspace);mergeStatusline(root,p,now,{env:{TMUX_PANE:'%1'}});let incident='';
 scheduleFromStop(root,{executionNum:1,terminationReason:'error',error:'503 service unavailable',fullyIdle:true,conversationId:conv,workspacePaths:[workspace]},{now,config:{transientBaseMs:1000,transientCapMs:1000,jitterMs:0,maxJobElapsedMs:60000},spawnWorker:(id,x)=>{incident=x;}});
 mergeStatusline(root,p,now+500,{env:{TMUX_PANE:'%2'}});let t=now,calls=0;const out=await runNativeWorker(root,conv,{expectedIncidentId:incident,now:()=>t,sleep:async ms=>{t+=ms;},adapter:()=>{calls++;throw Error('multi CLI must never dispatch');}});
 assert.equal(out.status,'MULTI_CLI');assert.equal(calls,0);assert.equal(out.retryIncident.status,'BLOCKED');
});


test('scheduler diagnostics distinguish OK, STALE and LOST without model or quota polling',()=>{
 const now=20_000,state={status:'WAIT_BACKOFF',retryKind:'transient',retryLabel:'503',nextRetryAt:80_000,transientRetries:0,config:{maxTransientRetries:6,maxQuotaRetries:2},retryIncident:{id:'ri-health',status:'WAITING'},scheduler:{status:'WAITING',incidentId:'ri-health',workerPid:321,workerStartedAt:1_000,lastHeartbeatAt:19_000,nextRetryAt:80_000,deadlineSource:'backoff',retryLabel:'503',attempt:1,maxAttempts:6}};
 assert.equal(schedulerHealth(state,{now,pidAlive:()=>true}).status,'OK');
 state.scheduler.lastHeartbeatAt=now-80_000;assert.equal(schedulerHealth(state,{now,pidAlive:()=>true}).status,'STALE');
 assert.equal(schedulerHealth(state,{now,pidAlive:()=>false}).status,'LOST');
 const d=retrySchedulerDiagnostics(state,{now,pidAlive:()=>true});assert.equal(d.status,'STALE');assert.equal(d.retryIn,'01:00');assert.equal(d.deadlineSource,'backoff');assert.equal(d.retryLabel,'503');assert.equal(d.attempt,1);assert.equal(d.maxAttempts,6);
});

test('countdown formatting stays compact from seconds through multi-day waits',()=>{
 assert.equal(fmtCountdown(59_000),'00:59');assert.equal(fmtCountdown((2*3600+23*60+10)*1000),'02:23:10');assert.equal(fmtCountdown((2*86400+3*3600+4*60)*1000),'2d 03:04');
});

test('schedule metadata records worker pid, deadline source, retry reason and budget',()=>{
 const root=temp(),now=Date.parse('2030-01-01T00:00:00Z');mergeStatusline(root,payload({quota:{}}),now);const fakePid=424242;
 const out=scheduleFromStop(root,{executionNum:1,terminationReason:'error',error:'503 service unavailable',fullyIdle:true,conversationId:conv,workspacePaths:['/tmp/project']},{now,config:{transientBaseMs:60_000,transientCapMs:900_000,jitterMs:0,maxTransientRetries:6},spawnWorker:()=>fakePid});assert.equal(out.scheduled,true);assert.equal(out.workerPid,fakePid);
 const state=loadNative(root,conv);assert.equal(state.status,'WAIT_BACKOFF');assert.equal(state.retryLabel,'503');assert.equal(state.scheduler.workerPid,fakePid);assert.equal(state.scheduler.deadlineSource,'backoff');assert.equal(state.scheduler.attempt,1);assert.equal(state.scheduler.maxAttempts,6);assert.equal(state.scheduler.nextRetryAt,now+60_000);
});

test('quota scheduler metadata records server reset source and quota budget',()=>{
 const root=temp(),now=Date.parse('2030-01-01T00:00:00Z');mergeStatusline(root,payload({quota:{}}),now);const error='Individual quota reached. Resets in 2h23m10s';
 scheduleFromStop(root,{executionNum:2,terminationReason:'error',error,fullyIdle:true,conversationId:conv,workspacePaths:['/tmp/project']},{now,config:{resetMarginMs:90_000,jitterMs:0,maxQuotaRetries:2},spawnWorker:()=>process.pid});const state=loadNative(root,conv);assert.equal(state.retryLabel,'QUOTA');assert.equal(state.scheduler.deadlineSource,'server');assert.equal(state.scheduler.attempt,1);assert.equal(state.scheduler.maxAttempts,2);assert.equal(state.scheduler.retryLabel,'QUOTA');
});
