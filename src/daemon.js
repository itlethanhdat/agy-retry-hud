#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {atomicJSON,releaseDeadLock} from './state.js';
import {nativeRoot,runNativeWorker,runHandoffWorker,loadNative,saveNative,retrySchedulerDiagnostics} from './native.js';
import {loadControlConfig,controlConfigPath} from './control.js';
import {startSession} from './adapter.js';

const WAITING=new Set(['WAIT_QUOTA','WAIT_BACKOFF']);
const ACTIVE_HANDOFF=new Set(['PREPARING','PENDING','ROLLOVER_ARMED']);

export function daemonDir({root=nativeRoot()}={}){return path.join(path.dirname(root),'daemon');}
export function daemonPaths({root=nativeRoot()}={}){const dir=daemonDir({root});return {dir,pid:path.join(dir,'daemon.json'),runtime:path.join(dir,'runtime.json'),log:path.join(dir,'daemon.log')};}
export function pidAlive(pid){pid=Number(pid);if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);if(process.platform==='linux'){try{const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8'),m=stat.match(/\)\s+([A-Z])\s+/);if(m?.[1]==='Z')return false;}catch{}}return true;}catch{return false;}}
function readJSON(file,fallback=null){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fallback;}}
function processMemory(pid){if(Number(pid)!==process.pid)return null;const m=process.memoryUsage();return {rss:m.rss,heapUsed:m.heapUsed};}
export function daemonStatus({root=nativeRoot(),now=Date.now()}={}){
 const p=daemonPaths({root}),owner=readJSON(p.pid),runtime=readJSON(p.runtime,{}),alive=pidAlive(owner?.pid),heartbeatAt=runtime?.heartbeatAt||0,heartbeatAgeMs=heartbeatAt?Math.max(0,now-heartbeatAt):null;
 return {running:alive&&heartbeatAgeMs!==null&&heartbeatAgeMs<=30000,processAlive:alive,pid:owner?.pid||null,startedAt:owner?.startedAt||null,version:owner?.version||null,heartbeatAt:heartbeatAt||null,heartbeatAgeMs,runtime};
}
function writeOwner(root,value){const p=daemonPaths({root});fs.mkdirSync(p.dir,{recursive:true,mode:0o700});atomicJSON(p.pid,value);}
function claimDaemon(root,{now=Date.now(),version='0.5.0'}={}){
 const p=daemonPaths({root});fs.mkdirSync(p.dir,{recursive:true,mode:0o700});const current=readJSON(p.pid);
 if(current?.pid&&current.pid!==process.pid&&pidAlive(current.pid))throw Object.assign(Error('daemon already running'),{code:'DAEMON_RUNNING',owner:current});
 writeOwner(root,{pid:process.pid,startedAt:now,version});return p;
}
export function clearDeadDaemonFiles({root=nativeRoot()}={}){const p=daemonPaths({root}),o=readJSON(p.pid);if(o?.pid&&!pidAlive(o.pid)){try{fs.unlinkSync(p.pid);}catch{}return true;}return false;}
export function ensureDaemon({root=nativeRoot(),config=loadControlConfig(),env=process.env,detached=true}={}){
 if(config.daemon?.enabled===false||config.daemon?.autoStart===false)return {started:false,reason:'daemon disabled',status:daemonStatus({root})};
 const current=daemonStatus({root});if(current.processAlive)return {started:false,reused:true,status:current};
 clearDeadDaemonFiles({root});const entry=fileURLToPath(import.meta.url),child=spawn(process.execPath,[entry,'run','--state-root',root],{detached,stdio:'ignore',windowsHide:true,env:{...env,AGY_RETRY_DAEMON:'1'}});if(detached)child.unref();
 writeOwner(root,{pid:child.pid,startedAt:Date.now(),version:'0.5.0',status:'starting'});return {started:true,pid:child.pid,status:daemonStatus({root})};
}
export async function stopDaemon({root=nativeRoot(),timeoutMs=3000}={}){const p=daemonPaths({root}),s=daemonStatus({root});if(!s.processAlive){try{fs.unlinkSync(p.pid);}catch{}return {stopped:true,alreadyStopped:true};}
 try{process.kill(s.pid,'SIGTERM');}catch{}
 const end=Date.now()+timeoutMs;while(Date.now()<end&&pidAlive(s.pid))await new Promise(r=>setTimeout(r,50));if(pidAlive(s.pid)){try{process.kill(s.pid,'SIGKILL');}catch{}}
 try{fs.unlinkSync(p.pid);}catch{}return {stopped:!pidAlive(s.pid),pid:s.pid};
}
export async function restartDaemon(opts={}){await stopDaemon(opts);return ensureDaemon(opts);}
function sessionStates(root){const dir=path.join(root,'sessions');let names=[];try{names=fs.readdirSync(dir).filter(x=>x.endsWith('.json'));}catch(e){if(e.code==='ENOENT')return [];throw e;}return names.map(n=>readJSON(path.join(dir,n))).filter(x=>x?.conversationId);}
export function nextPollMs(states,config,now=Date.now()){
 const d=config.daemon||{};if(states.some(s=>['RUNNING'].includes(s.status)||['CHECKING','DISPATCHING','RUNNING'].includes(s.scheduler?.status)))return d.activePollMs??500;
 const waits=states.filter(s=>WAITING.has(s.status)&&Number.isFinite(s.nextRetryAt));if(waits.some(s=>s.nextRetryAt-now<=(d.nearDeadlineMs??60000)))return d.nearDeadlinePollMs??1000;
 if(waits.some(s=>s.status==='WAIT_BACKOFF'))return d.waitBackoffPollMs??5000;if(waits.some(s=>s.status==='WAIT_QUOTA'))return d.waitQuotaPollMs??30000;return d.idlePollMs??10000;
}
class Semaphore{constructor(max=1){this.max=Math.max(1,Number(max)||1);this.used=0;this.q=[];}async acquire(){if(this.used<this.max){this.used++;return()=>this.release();}return await new Promise(r=>this.q.push(r));}release(){const n=this.q.shift();if(n)n(()=>this.release());else this.used=Math.max(0,this.used-1);}}
export async function runDaemon({root=nativeRoot(),configFile=controlConfigPath(),now=Date.now,signal,retryRunner=runNativeWorker,handoffRunner=runHandoffWorker,sessionStarter=startSession}={}){
 const p=claimDaemon(root,{now:now()}),retryTasks=new Map(),handoffTasks=new Map();let stopping=false,pendingTimer=null,pendingResolve=null;const pause=ms=>new Promise(r=>{pendingResolve=r;pendingTimer=setTimeout(()=>{pendingTimer=null;pendingResolve=null;r();},ms);}),stop=()=>{stopping=true;if(pendingTimer){clearTimeout(pendingTimer);pendingTimer=null;}const r=pendingResolve;pendingResolve=null;r?.();};process.once('SIGTERM',stop);process.once('SIGINT',stop);signal?.addEventListener?.('abort',stop,{once:true});
 let config=loadControlConfig({file:configFile}),sem=new Semaphore(config.daemon?.maxConcurrentDispatch??1),lastHeartbeat=0;
 const heartbeat=(states)=>{const t=now();if(t-lastHeartbeat<(config.daemon?.heartbeatMs??5000))return;lastHeartbeat=t;const waitQuota=states.filter(x=>x.status==='WAIT_QUOTA').length,waitBackoff=states.filter(x=>x.status==='WAIT_BACKOFF').length;atomicJSON(p.runtime,{schemaVersion:1,status:'RUNNING',pid:process.pid,startedAt:readJSON(p.pid)?.startedAt||t,heartbeatAt:t,sessions:states.length,waitQuota,waitBackoff,retryTasks:retryTasks.size,handoffTasks:handoffTasks.size,memory:processMemory(process.pid)});};
 try{
  let cachedStates=[],nextScanAt=0;
  while(!stopping&&!signal?.aborted){try{config=loadControlConfig({file:configFile});}catch{}if(config.daemon?.enabled===false)break;const tick=now();
   if(tick>=nextScanAt){cachedStates=sessionStates(root);for(let s of cachedStates){if(WAITING.has(s.status)&&s.retryIncident?.id&&s.daemonManaged!==true){const oldId=s.retryIncident.id;s.retryIncident={...s.retryIncident,id:oldId+'-v5-'+String(now()).slice(-6),supersedesIncidentId:oldId,updatedAt:now()};s.daemonManaged=true;s.scheduler={...(s.scheduler||{}),incidentId:s.retryIncident.id,workerPid:null,workerStartedAt:null,lastHeartbeatAt:now(),status:'STARTING',migration:'v0.5.0'};saveNative(root,s);}
     if(WAITING.has(s.status)&&s.retryIncident?.id&&!retryTasks.has(s.conversationId)){const lockDir=path.join(root,'locks');if(['LOST','STALE'].includes(retrySchedulerDiagnostics(s).status)){try{releaseDeadLock(lockDir,'native:'+s.conversationId);}catch{}}const incidentId=s.retryIncident.id,task=(async()=>{try{return await retryRunner(root,s.conversationId,{expectedIncidentId:incidentId,adapter:async cfg=>{const release=await sem.acquire();const session=sessionStarter(cfg);session.closed.finally(release).catch(()=>release());return session;}});}finally{retryTasks.delete(s.conversationId);}})();retryTasks.set(s.conversationId,task);task.catch(()=>{});}
     if(ACTIVE_HANDOFF.has(s.handoff?.status)&&!handoffTasks.has(s.conversationId)){const task=(async()=>{try{return await handoffRunner(root,s.conversationId);}finally{handoffTasks.delete(s.conversationId);}})();handoffTasks.set(s.conversationId,task);task.catch(()=>{});}
    }
    nextScanAt=tick+nextPollMs(cachedStates,config,tick);
   }
   heartbeat(cachedStates);const heartbeatMs=Math.max(500,config.daemon?.heartbeatMs??5000),untilScan=Math.max(100,nextScanAt-now());await pause(Math.min(heartbeatMs,untilScan));
  }
 }finally{const end=now();atomicJSON(p.runtime,{...(readJSON(p.runtime,{})||{}),status:'STOPPED',heartbeatAt:end,stoppedAt:end,pid:process.pid});const owner=readJSON(p.pid);if(owner?.pid===process.pid){try{fs.unlinkSync(p.pid);}catch{}}process.off('SIGTERM',stop);process.off('SIGINT',stop);signal?.removeEventListener?.('abort',stop);}
 return {status:'STOPPED'};
}
function arg(name){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:undefined;}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const cmd=process.argv[2]||'status',root=path.resolve(arg('--state-root')||nativeRoot());try{if(cmd==='run')await runDaemon({root});else if(cmd==='start')console.log(JSON.stringify(ensureDaemon({root}),null,2));else if(cmd==='stop')console.log(JSON.stringify(await stopDaemon({root}),null,2));else if(cmd==='restart')console.log(JSON.stringify(await restartDaemon({root}),null,2));else if(cmd==='status')console.log(JSON.stringify(daemonStatus({root}),null,2));else throw Error('usage: daemon.js run|start|stop|restart|status [--state-root PATH]');}catch(e){if(e.code==='DAEMON_RUNNING')process.exitCode=0;else{process.stderr.write((e?.message||String(e))+'\n');process.exitCode=2;}}
}
