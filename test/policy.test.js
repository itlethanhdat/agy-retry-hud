import test from 'node:test';
import assert from 'node:assert/strict';
import {classify,decide} from '../src/policy.js';
const now=Date.parse('2026-09-29T00:00:00Z');
const error=text=>({status:'ERROR',error:text});
test('classifier separates quota from transient, permanent, unknown and tool prose',()=>{
 for(const [text,kind] of [
  ['503 [429]: RESOURCE_EXHAUSTED: Individual quota reached. Resets in 2h','quota'],
  ['503 Service unavailable','transient'],['502 Bad Gateway','transient'],
  ['429 per-minute rate limit','transient'],['429 something unknown','unknown'],
  ['500 unrelated application error','unknown'],['401 unauthorized','permanent'],
  ['403 access denied','permanent'],['billing cap reached','permanent'],
  ['weekly quota exhausted','long-quota']]) assert.equal(classify(error(text),now).kind,kind,text);
 assert.equal(classify({status:'SUCCESS',response:'503 error; quota reached'},now).kind,'success');
 assert.equal(classify({status:'WAITING'},now).kind,'needs_user');
 assert.equal(classify({status:'INTERRUPTED'},now).kind,'canceled');
});
test('reset deadline, fallback, margin, jitter and budget are deterministic',()=>{
 const b={startedAt:now,transientRetries:0,quotaRetries:0};
 let d=decide(classify(error('Individual quota reached. Resets in 2h'),now),b,now,0);
 assert.equal(d.at,now+7290000);
 d=decide(classify(error('Individual quota reached'),now),b,now,30000);
 assert.equal(d.at,now+18120000);
 assert.equal(decide(classify(error('weekly quota exhausted'),now),b,now,0).action,'needs_user');
 assert.equal(decide({kind:'quota',resetAt:now+2*86400000},b,now,0).action,'needs_user');
 assert.equal(decide({kind:'quota'}, {...b,quotaRetries:2},now,0).action,'exhausted');
});
test('transient delay doubles, never undercuts server delay and stops after six sends',()=>{
 for(const [n,seconds] of [[0,60],[1,120],[2,240],[3,480],[4,900],[5,900]]) {
  const d=decide({kind:'transient'},{startedAt:now,transientRetries:n,quotaRetries:0},now,0);
  assert.equal(d.at,now+seconds*1000);
 }
 assert.equal(decide({kind:'transient',retryAfterMs:1200000},{startedAt:now,transientRetries:0},now,0).at,now+1200000);
 assert.equal(decide({kind:'transient'},{startedAt:now,transientRetries:6},now,0).action,'exhausted');
});
test('reset formats are conservative and server nonretryable is not overridden',()=>{
 assert.equal(classify(error('Individual quota reached. Resets at 2026-09-29T02:00:00Z'),now).resetAt,now+7200000);
 assert.equal(classify(error('Individual quota reached. Resets at 09/10/2026 02:00'),now).kind,'unknown');
 assert.equal(classify({status:'ERROR',error:{message:'503 unavailable',retryable:false}},now).kind,'permanent');
 assert.equal(classify(error('API error (429): reset after 4m 52s'),now).retryAfterMs,292000);
});
test('absolute server reset is a lower bound even for transient errors',()=>{
 const c=classify(error('503 unavailable. Resets at 2026-09-29T02:00:00Z'),now);
 assert.ok(decide(c,{startedAt:now},now,0).at>=now+7200000);
});
test('unsupported nested error cannot hide permanent inner failure',()=>{
 const c=classify({status:'ERROR',error:{message:'503 upstream',cause:{message:'401 unauthorized',retryable:false}}},now);
 assert.equal(c.kind,'unknown');
});
