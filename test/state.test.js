import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Store, acquire, releaseDeadLock} from '../src/state.js';
import {Clock} from '../src/clock.js';
const temp=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'agy-state-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};
test('atomic state retains deadlines and counters; invalid writes cannot destroy previous state',t=>{
 const s=new Store(temp(t));s.save({schemaVersion:1,id:'job1',nextRetryAt:12345,quotaRetries:2});
 assert.equal(s.load('job1').nextRetryAt,12345); assert.equal(s.load('job1').quotaRetries,2);
 const bad={schemaVersion:1,id:'job1'};bad.circular=bad;assert.throws(()=>s.save(bad));assert.equal(s.load('job1').quotaRetries,2);
 assert.throws(()=>s.load('../escape'));assert.throws(()=>s.save({schemaVersion:99,id:'bad'}));
});
test('independent processes cannot acquire an owned lease or steal it by age',t=>{
 const dir=temp(t),l=acquire(dir,'session-key');
 const code=`import {acquire} from ${JSON.stringify(new URL('../src/state.js',import.meta.url).href)};try{acquire(process.argv[1],'session-key');process.exit(10)}catch{process.exit(0)}`;
 assert.equal(spawnSync(process.execPath,['--input-type=module','-e',code,dir]).status,0);
 assert.throws(()=>releaseDeadLock(dir,'session-key'),/alive/);l.release();const next=acquire(dir,'session-key');next.release();
});
test('clock honors cancel at deadline, wake and wall-clock rollback without long sleeps',async()=>{
 let wall=0,mono=0;const clock=new Clock({now:()=>wall,mono:()=>mono,sleep:async ms=>{wall+=ms;mono+=ms;}});
 await clock.waitUntil(5000);assert.equal(wall,5000);
 wall=10000;await clock.waitUntil(5000);assert.equal(wall,10000);
 const ac=new AbortController();ac.abort();await assert.rejects(clock.waitUntil(10000,ac.signal),/abort/i);
 wall=0;mono=0;const backwards=new Clock({now:()=>wall,mono:()=>mono,sleep:async()=>{wall-=301000;mono+=1000;}});
 await assert.rejects(backwards.waitUntil(5000),/clock moved backwards/);
});
