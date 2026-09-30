import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {Supervisor,newJob} from '../src/supervisor.js';import {DEFAULT_RESUME_MESSAGE} from '../src/session.js';import {Store,acquire} from '../src/state.js';import {startSession} from '../src/adapter.js';
const fake=fileURLToPath(new URL('./fixtures/scenario-agy.js',import.meta.url));
function setup(t,turns,extra={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agy-supervisor-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const fixture=path.join(dir,'scenario.json');fs.writeFileSync(fixture,JSON.stringify({turns,sends:[]}));let now=Date.parse('2026-09-29T00:00:00Z');const waits=[];
 const clock={now:()=>now,async waitUntil(at,signal){signal?.throwIfAborted();waits.push(at);now=at;}};
 const store=new Store(path.join(dir,'jobs'));const deps={store,lockDir:path.join(dir,'locks'),clock,rng:()=>0,adapter:cfg=>startSession({...cfg,executable:process.execPath,prefixArgs:[fake,fixture],initTimeoutMs:15000}),...extra};
 const sup=new Supervisor(deps),job=newJob({cwd:dir,conversation:'session-1',model:'gemini-test',config:{message:DEFAULT_RESUME_MESSAGE}});
 return {sup,job,store,fixture,waits,read:()=>JSON.parse(fs.readFileSync(fixture,'utf8'))};
}
test('quota waits once then resumes exact session; no original prompt replay',async t=>{
 const h=setup(t,[{status:'ERROR',error:'Individual quota reached. Resets in 2h'},{status:'SUCCESS',response:'done'}]);
 await h.sup.run(h.job,{prompt:'Original work'});
 assert.equal(h.job.status,'SUCCEEDED');assert.equal(h.waits.length,1);assert.equal(h.waits[0],Date.parse('2026-09-29T02:01:30Z'));
 const sends=h.read().sends;assert.equal(sends.length,2);assert.equal(sends[0].message,'Original work');assert.equal(sends[1].message,DEFAULT_RESUME_MESSAGE);
 assert.equal(sends[1].conversation,'session-1');assert.equal(h.job.quotaRetries,1);
});
test('partial response does not imply success; terminal retry remains bounded',async t=>{
 const h=setup(t,Array.from({length:8},()=>({status:'ERROR',error:'503 unavailable',response:'partial',nativeWarnings:true})));
 await h.sup.run(h.job,{prompt:'work'});assert.equal(h.read().sends.length,7);assert.equal(h.job.status,'EXHAUSTED');assert.equal(h.job.transientRetries,6);
});
test('ID mismatch and uncertain persisted dispatch never send a prompt',async t=>{
 const h=setup(t,[{initID:'wrong',status:'SUCCESS'}]);await h.sup.run(h.job);assert.equal(h.read().sends.length,0);assert.equal(h.job.status,'NEEDS_USER');
 const u=setup(t,[{status:'SUCCESS'}]);u.job.phase='dispatching';await u.sup.run(u.job);assert.equal(u.read().sends.length,0);assert.equal(u.job.status,'PAUSED_UNCERTAIN');
});
test('pending tool, permission wait and user cancellation never auto retry',async t=>{
 for(const scenario of [{status:'ERROR',error:'503 unavailable',steps:[{step_index:1,step_type:'tool',state:'ACTIVE',tool_name:'run_command'}]},{status:'WAITING'},{status:'INTERRUPTED'}]){
  const h=setup(t,[scenario]);await h.sup.run(h.job,{prompt:'work'});assert.equal(h.read().sends.length,1);assert.equal(h.waits.length,0);assert.notEqual(h.job.status,'SUCCEEDED');
 }
});
test('saved wait retains original deadline and counters after restart',async t=>{
 const h=setup(t,[{status:'SUCCESS'}]);h.job.status='WAIT_BACKOFF';h.job.nextRetryAt=Date.parse('2026-09-29T00:05:00Z');h.job.transientRetries=2;h.job.retryKind='transient';h.store.save(h.job);
 const restored=h.store.load(h.job.id);await h.sup.run(restored);assert.equal(h.waits[0],Date.parse('2026-09-29T00:05:00Z'));assert.equal(restored.transientRetries,3);assert.equal(h.read().sends.length,1);
});
test('deadline quota refresh cannot spin when reset has passed',async t=>{
 let count=0;const quota={snapshot(){throw Error('missing');},async refresh(){count++;return {observedAt:0,buckets:[{window:'5h',remainingFraction:0,resetAt:count===1?Date.parse('2026-09-29T01:00:00Z'):1}]};}};
 const h=setup(t,[{status:'ERROR',error:'Individual quota reached'}],{quota});h.job.config.quotaGroup='gemini';
 await h.sup.run(h.job,{prompt:'work'});assert.equal(h.read().sends.length,1);assert.equal(h.job.status,'NEEDS_USER');assert.equal(count,2);
});
test('locked job cannot be overwritten by a second supervisor',async t=>{
 const h=setup(t,[{status:'SUCCESS'}]);h.store.save(h.job);const before=JSON.stringify(h.store.load(h.job.id));
 const lease=acquire(h.sup.lockDir,'job:'+h.job.id);
 try{await assert.rejects(h.sup.run(h.job),/locked/);assert.equal(JSON.stringify(h.store.load(h.job.id)),before);}finally{lease.release();}
 assert.equal(h.read().sends.length,0);
});
test('cancel at scheduled boundary suppresses next send',async t=>{
 const h=setup(t,[{status:'ERROR',error:'503 unavailable'},{status:'SUCCESS'}]);
 h.sup.onChange=j=>{if(j.status==='WAIT_BACKOFF'&&!j.canceled)h.sup.control('cancel');};
 await h.sup.run(h.job,{prompt:'work'});assert.equal(h.read().sends.length,1);assert.equal(h.job.status,'CANCELED');
});
test('external cancellation file blocks dispatch and persists canceled status',async t=>{
 const h=setup(t,[{status:'SUCCESS'}]);fs.writeFileSync(path.join(h.store.dir,h.job.id+'.cancel'),'cancel');
 await h.sup.run(h.job,{prompt:'work'});assert.equal(h.read().sends.length,0);assert.equal(h.job.status,'CANCELED');
});
test('waking after job budget expired never dispatches',async t=>{
 const h=setup(t,[{status:'SUCCESS'}]);h.job.status='WAIT_BACKOFF';h.job.retryKind='transient';h.job.nextRetryAt=Date.parse('2026-10-01T00:00:00Z');
 await h.sup.run(h.job);assert.equal(h.read().sends.length,0);assert.equal(h.job.status,'EXHAUSTED');
});
test('crash snapshot during quota resolution cannot immediately dispatch on restart',async t=>{
 const h=setup(t,[{status:'ERROR',error:'Individual quota reached. Resets in 2h'},{status:'SUCCESS'}]);h.job.config.quotaGroup='gemini';let crashState;
 h.sup.quota={snapshot(){throw Error('missing');},async refresh(){crashState=h.store.load(h.job.id);throw Error('simulate refresh unavailable');}};
 h.sup.onChange=j=>{if(j.status==='WAIT_QUOTA'&&!j.canceled)h.sup.control('cancel');};
 await h.sup.run(h.job,{prompt:'work'});assert.ok(crashState);h.sup.onChange=()=>{};
 const sendsBefore=h.read().sends.length;await h.sup.run(crashState);
 assert.equal(h.read().sends.length,sendsBefore);assert.equal(crashState.status,'PAUSED_UNCERTAIN');
});
test('terminal success before verified init and dispatch is not accepted',async t=>{
 const h=setup(t,[]);h.sup.adapter=()=>({async *events(){yield {event:'result',result:{status:'SUCCESS',response:'unsolicited'}};},async close(){return {clean:true};},async abort(){}});
 await h.sup.run(h.job,{prompt:'work'});assert.equal(h.job.status,'PAUSED_UNCERTAIN');
});
test('observed model and agent are pinned before any subsequent process',async t=>{
 const h=setup(t,[]);h.job.model='';h.job.agent='';let launches=[],sent=0;
 h.sup.adapter=cfg=>{launches.push(cfg);return {async *events(){yield {event:'init',conversation_id:'session-1',init:{cwd:h.job.cwd,model:launches.length===1?'model-A':'model-B',agent:'agent-A'}};yield {event:'result',result:{status:'ERROR',error:'503 unavailable'}};},async send(){sent++;},async close(){return {clean:true};},async abort(){}};};
 await h.sup.run(h.job,{prompt:'work'});assert.equal(sent,1);assert.equal(launches[1].model,'model-A');assert.equal(launches[1].agent,'agent-A');assert.equal(h.job.status,'NEEDS_USER');
});
test('late cancel after completion cannot corrupt durable successful outcome',async t=>{
 const h=setup(t,[{status:'SUCCESS'}]);await h.sup.run(h.job,{prompt:'work'});h.sup.control('cancel');
 assert.equal(Boolean(h.job.canceled),false);await h.sup.run(h.store.load(h.job.id));assert.equal(h.store.load(h.job.id).status,'SUCCEEDED');
});
