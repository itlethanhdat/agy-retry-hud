import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {QuotaProvider,parseUsage,blockingReset} from '../src/quota.js';
import {fileURLToPath} from 'node:url';
import {decide} from '../src/policy.js';
const now=Date.parse('2026-09-29T00:00:00Z'),scope={profile:'work',group:'gemini'};
const payload=(weekly=0)=>({quota:{'gemini-5h':{remaining_fraction:0,reset_time:'2026-09-29T01:00:00Z'},'gemini-weekly':{remaining_fraction:weekly,reset_time:'2026-10-01T00:00:00Z'}}});
test('both exhausted windows block until latest reset; nonempty week does not block',()=>{
 const s=parseUsage(payload(),scope,now);assert.equal(blockingReset(s,now),now+172800000);
 assert.equal(decide({kind:'quota',resetAt:blockingReset(s,now)},{startedAt:now},now).action,'needs_user');
 assert.equal(blockingReset(parseUsage(payload(.5),scope,now),now),now+3600000);
 assert.throws(()=>parseUsage({response:'Usage: 80%'},scope,now),/unsupported/);
 assert.throws(()=>blockingReset(s,now+172800001),/passed/);
});
test('cache scope, age and corruption cannot produce a ready decision',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agy-quota-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let at=now;
 const p=new QuotaProvider({dir,now:()=>at,run:async()=>payload(.5)});
 await p.refresh(scope);at+=61000;assert.throws(()=>p.snapshot(scope,60000),/stale/);assert.ok(p.snapshot(scope,300000));
 assert.throws(()=>p.snapshot({...scope,profile:'other'},300000));at=now-10000;assert.throws(()=>p.snapshot(scope,300000),/future/);
 fs.writeFileSync(p.cachePath(scope),'{oops');assert.throws(()=>p.snapshot(scope,300000));
});
test('concurrent refreshes share one real external-boundary call; nested refresh never spawns',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agy-quota-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let calls=0;
 const p=new QuotaProvider({dir,now:()=>now,run:async()=>{calls++;await new Promise(r=>setTimeout(r,10));return payload();}});
 const values=await Promise.all(Array.from({length:10},()=>p.refresh(scope)));
 assert.equal(calls,1);assert.ok(values.every(x=>x.buckets.length===2));
 const nested=new QuotaProvider({dir,nested:true,run:async()=>{throw Error('must not run');}});
 await assert.rejects(nested.refresh(scope),/nested/);
});
test('timed out usage refresh terminates its descendant process',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agy-usage-child-'));const pidfile=path.join(dir,'pid');let pid;
 t.after(()=>{if(pid){try{process.kill(pid,'SIGKILL');}catch{}}fs.rmSync(dir,{recursive:true,force:true});});
 const p=new QuotaProvider({dir,executable:process.execPath,prefixArgs:[fileURLToPath(new URL('./fixtures/usage-child.js',import.meta.url)),pidfile],timeoutMs:1000});
 await assert.rejects(p.refresh(scope));pid=Number(fs.readFileSync(pidfile,'utf8'));
 const alive=()=>{try{process.kill(pid,0);if(process.platform==='linux'){try{const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');if(/\) Z /.test(stat))return false;}catch{}}return true;}catch{return false;}};
 for(let i=0;i<20&&alive();i++)await new Promise(r=>setTimeout(r,25));
 assert.equal(alive(),false,'usage grandchild must not be left running');
});

test('canceling usage refresh terminates descendants before releasing its lease',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agy-usage-abort-')),pidfile=path.join(dir,'pid');let pid;
 t.after(()=>{if(pid){try{process.kill(pid,'SIGKILL');}catch{}}fs.rmSync(dir,{recursive:true,force:true});});
 const controller=new AbortController();
 const p=new QuotaProvider({dir,executable:process.execPath,prefixArgs:[fileURLToPath(new URL('./fixtures/usage-child.js',import.meta.url)),pidfile],timeoutMs:10000});
 const pending=p.refresh(scope,controller.signal);const rejected=assert.rejects(pending,/canceled/);
 for(let i=0;i<200&&!fs.existsSync(pidfile);i++)await new Promise(r=>setTimeout(r,10));
 assert.ok(fs.existsSync(pidfile),'fixture started');pid=Number(fs.readFileSync(pidfile,'utf8'));controller.abort();await rejected;
 let alive=true;for(let i=0;i<40;i++){try{process.kill(pid,0);if(process.platform==='linux'){try{if(/\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`,'utf8')))alive=false;}catch{}}}catch{alive=false;}if(!alive)break;await new Promise(r=>setTimeout(r,25));}
 assert.equal(alive,false);assert.equal(fs.readdirSync(path.join(dir,'locks')).length,0);
});
