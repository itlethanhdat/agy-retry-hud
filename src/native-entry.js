#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {nativeRoot,mergeStatusline,renderNativeStatusline,loadHudConfig,loadNative,saveNative,scheduleFromStop,scheduleFromPreInvocation,runNativeWorker,spawnDetachedWorker,scheduleAutoHandoff,runHandoffWorker,spawnDetachedHandoffWorker} from './native.js';
import {effectiveControls,loadControlConfig} from './control.js';

async function readStdin({timeoutMs=0}={}){
 return await new Promise((resolve,reject)=>{
  let text='',done=false,timer=null;
  const cleanup=()=>{if(timer)clearTimeout(timer);process.stdin.off('data',onData);process.stdin.off('end',onEnd);process.stdin.off('error',onError);process.stdin.pause();if(!process.stdin.destroyed)process.stdin.destroy();};
  const finish=(err,value)=>{if(done)return;done=true;cleanup();err?reject(err):resolve(value);};
  const tryParse=(final=false)=>{const trimmed=text.trim();if(!trimmed){if(final)finish(null,{});return false;}try{finish(null,JSON.parse(trimmed));return true;}catch(e){if(final)finish(e);return false;}};
  const onData=chunk=>{text+=chunk;tryParse(false);};
  const onEnd=()=>tryParse(true);
  const onError=e=>finish(e);
  process.stdin.setEncoding('utf8');process.stdin.on('data',onData);process.stdin.once('end',onEnd);process.stdin.once('error',onError);
  if(timeoutMs>0)timer=setTimeout(()=>{const e=Error('stdin read timeout');e.code='STDIN_TIMEOUT';finish(e);},timeoutMs);
  process.stdin.resume();
 });
}
function arg(name){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:undefined;}
const cmd=process.argv[2];const root=path.resolve(arg('--state-root')||nativeRoot());
try{
 if(cmd==='statusline'){
  const payload=await readStdin({timeoutMs:Number(process.env.AGY_RETRY_STATUSLINE_STDIN_TIMEOUT_MS||1000)});const state=mergeStatusline(root,payload),cfg=loadControlConfig(),id=payload?.conversation_id||payload?.session_id;
  let controls={config:cfg,retryOverride:'inherit',handoffOverride:'inherit',retryEnabled:cfg.retry.enabled,handoffEnabled:cfg.handoff.enabled};
  if(id&&state){controls=effectiveControls(root,id,{config:cfg});scheduleAutoHandoff(root,payload,{controlConfig:cfg,spawnWorker:(conversation)=>spawnDetachedHandoffWorker(fileURLToPath(import.meta.url),conversation,root)});}
  process.stdout.write(renderNativeStatusline(payload,state,Date.now(),loadHudConfig(),controls)+'\n');
 }else if(cmd==='stop-hook'){
  const payload=await readStdin({timeoutMs:5000}),script=fileURLToPath(import.meta.url);const r=scheduleFromStop(root,payload,{spawnWorker:(id,incidentId)=>spawnDetachedWorker(script,id,root,incidentId)});process.stdout.write(JSON.stringify({decision:'stop'})+'\n');if(process.env.AGY_RETRY_DEBUG==='1')process.stderr.write(JSON.stringify({scheduled:r.scheduled,reason:r.reason})+'\n');
 }else if(cmd==='pre-invocation-hook'){
  const payload=await readStdin({timeoutMs:5000});const r=scheduleFromPreInvocation(root,payload);process.stdout.write(JSON.stringify({injectSteps:[]})+'\n');if(process.env.AGY_RETRY_DEBUG==='1')process.stderr.write(JSON.stringify({superseded:r.superseded,reason:r.reason})+'\n');
 }else if(cmd==='worker'){
  const id=arg('--conversation'),incidentId=arg('--incident');if(!id)throw Error('--conversation required');const r=await runNativeWorker(root,id,{expectedIncidentId:incidentId});process.exitCode=['SUCCEEDED','DUPLICATE_WORKER','RETRY_OFF','WEEKLY_BLOCKED','MULTI_CLI','STALE_RETRY','IDLE'].includes(r?.status)?0:4;
 }else if(cmd==='handoff-worker'){
  const id=arg('--conversation');if(!id)throw Error('--conversation required');const r=await runHandoffWorker(root,id);process.exitCode=['SUCCEEDED','IDLE','DUPLICATE_HANDOFF_WORKER'].includes(r?.status)||r?.handoff?.status==='READY'?0:4;
 }else if(cmd==='status'){
  const id=arg('--conversation');if(!id)throw Error('--conversation required');process.stdout.write(JSON.stringify(loadNative(root,id),null,2)+'\n');
 }else if(cmd==='cancel'){
  const id=arg('--conversation');if(!id)throw Error('--conversation required');const s=loadNative(root,id);if(!s)throw Error('conversation state not found');s.status='CANCELED';s.reason='canceled by user';s.nextRetryAt=null;saveNative(root,s);process.stdout.write('canceled\n');
 }else {process.stderr.write('usage: native-entry.js statusline|stop-hook|pre-invocation-hook|worker|handoff-worker|status|cancel\n');process.exitCode=2;}
}catch(e){if(cmd==='stop-hook'){process.stdout.write(JSON.stringify({decision:'stop'})+'\n');process.exitCode=0;}else if(cmd==='statusline'&&e?.code==='STDIN_TIMEOUT'){process.stdout.write('\n');process.exitCode=0;}else{process.stderr.write((e?.message||String(e))+'\n');process.exitCode=2;}}
