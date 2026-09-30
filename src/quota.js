import {boundedCommand} from './process.js';
import fs from 'node:fs';import path from 'node:path';
import {atomicJSON,acquire,keyFor} from './state.js';
const flights=new Map();
export function parseUsage(raw,scope,now=Date.now()){
 if(!scope.group||!scope.profile)throw Error('quota scope unknown');
 const quota=raw?.quota||raw?.result?.quota;if(!quota||typeof quota!=='object')throw Error('unsupported /usage schema');
 const buckets=[];
 for(const window of ['5h','weekly']){const b=quota[scope.group+'-'+window];if(!b)continue;
  const f=b.remaining_fraction,resetAt=typeof b.reset_time==='string'&&/(?:Z|[+-]\d\d:\d\d)$/.test(b.reset_time)?Date.parse(b.reset_time):NaN;
  if(typeof f!=='number'||!Number.isFinite(f)||f<0||f>1||!Number.isFinite(resetAt))throw Error('invalid quota bucket');
  buckets.push({window,remainingFraction:f,resetAt});
 }
 if(!buckets.length)throw Error('unsupported quota group');
 return {observedAt:now,source:'usage',scope:{...scope},buckets};
}
export function blockingReset(snapshot,now=Date.now()){
 const blocked=snapshot.buckets.filter(b=>b.remainingFraction===0);
 if(blocked.some(b=>b.resetAt<=now))throw Error('quota reset passed but remains exhausted');
 return blocked.length?Math.max(...blocked.map(b=>b.resetAt)):null;
}
export class QuotaProvider {
 constructor({dir,executable='agy',prefixArgs=[],cwd,now=Date.now,run,nested=false,timeoutMs=20000}={}){
  Object.assign(this,{dir,now,nested});
  this.run=run|| (async(signal)=>{
   const stdout=await boundedCommand(executable,[...prefixArgs,'-p','/usage','--output-format','json'],{cwd,timeoutMs,maxBytes:1024*1024,signal,env:{...process.env,AGY_HUD_NESTED:'1',AGY_RETRY_NESTED:'1'}});
   return JSON.parse(stdout);
  });
 }
 cachePath(scope){return path.join(this.dir,keyFor(scope)+'.quota.json');}
 snapshot(scope,maxAge){
  if(scope.profile==='unknown')throw Error('unknown profile cannot reuse quota cache');
  const s=JSON.parse(fs.readFileSync(this.cachePath(scope),'utf8'));
  if(JSON.stringify(s.scope)!==JSON.stringify(scope))throw Error('quota scope mismatch');
  if(!Number.isFinite(s.observedAt)||s.observedAt>this.now()+1000)throw Error('future quota timestamp');
  if(this.now()-s.observedAt>maxAge)throw Error('stale quota cache');
  if(!Array.isArray(s.buckets)||!s.buckets.length||s.buckets.some(b=>!['5h','weekly'].includes(b.window)||!Number.isFinite(b.resetAt)||!Number.isFinite(b.remainingFraction)||b.remainingFraction<0||b.remainingFraction>1))throw Error('invalid quota cache');
  return s;
 }
 refresh(scope,signal){
  if(this.nested||process.env.AGY_RETRY_NESTED==='1'||process.env.AGY_HUD_NESTED==='1')return Promise.reject(Error('nested quota refresh refused'));
  const key=path.resolve(this.dir)+'|'+keyFor(scope);if(flights.has(key))return flights.get(key);
  const task=(async()=>{const lease=acquire(path.join(this.dir,'locks'),key);try{const s=parseUsage(await this.run(signal),scope,this.now());if(scope.profile!=='unknown')atomicJSON(this.cachePath(scope),s);return s;}finally{lease.release();}})();
  flights.set(key,task);task.finally(()=>flights.delete(key)).catch(()=>{});return task;
 }
}
