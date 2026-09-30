import fs from 'node:fs';import path from 'node:path';import {randomUUID,randomInt} from 'node:crypto';
import {startSession} from './adapter.js';import {classify,decide,defaults} from './policy.js';import {acquire,keyFor} from './state.js';import {Clock} from './clock.js';
import {DEFAULT_RESUME_MESSAGE,validateMessage,validateResume} from './session.js';import {blockingReset} from './quota.js';

export function newJob({cwd=process.cwd(),conversation='',model='',agent='',checkpointFile='',config={}}={}){
 return {schemaVersion:1,id:randomUUID(),cwd:fs.realpathSync(cwd),conversation,model,agent,checkpointFile:checkpointFile?path.resolve(cwd,checkpointFile):'',config:{...defaults,message:DEFAULT_RESUME_MESSAGE,...config},status:'IDLE',phase:'ready',quotaRetries:0,transientRetries:0,pendingTools:{},createdAt:Date.now(),contextHealth:'unknown',quotaRefreshes:0};
}
export class Supervisor {
 constructor({store,lockDir,clock=new Clock(),adapter=startSession,quota,onChange=()=>{},onOutput=()=>{},rng}={}){
  Object.assign(this,{store,lockDir,clock,adapter,quota,onChange,onOutput});this.rng=rng||((max)=>randomInt(max+1));
 }
 save(){this.store.save(this.job);this.onChange(structuredClone(this.job));}
 set(status,reason=''){Object.assign(this.job,{status,reason});this.save();}
 checkCancel(){if(!this.canceled&&fs.existsSync(path.join(this.store.dir,this.job.id+'.cancel')))this.control('cancel');}
 control(action,value){
  if(!this.job)return;
  if(['SUCCEEDED','EXHAUSTED','NEEDS_USER','PAUSED_UNCERTAIN','CANCELED'].includes(this.job.status))return;
  if(action==='message'){this.job.config.message=validateMessage(value);this.save();return;}
  if(action==='pause'){this.job.paused=true;this.save();}
  if(action==='resume'){this.job.paused=false;this.save();}
  if(action==='cancel'){this.canceled=true;this.job.canceled=true;this.save();this.session?.abort();this.controller?.abort();}
 }
 async wait(){
  for(;;){this.controller.signal.throwIfAborted();if(this.canceled)throw Error('canceled');
   if(!this.job.paused&&this.clock.now()>=this.job.nextRetryAt)return;
   const at=this.job.paused?this.clock.now()+1000:this.job.nextRetryAt;
   await this.clock.waitUntil(at,this.controller.signal);
  }
 }
 async readQuota(maxAge,force=false){
  const j=this.job,scope={profile:j.config.profileKey||'unknown',group:j.config.quotaGroup};if(!this.quota||!scope.group)return null;
  if(!force){try{const cached=this.quota.snapshot(scope,maxAge);j.quota=cached;return cached;}catch{}}
  if(j.quotaRefreshes>=2)throw Error('quota refresh budget exhausted');
  j.quotaRefreshes++;this.save();const snapshot=await this.quota.refresh(scope,this.controller.signal);j.quota=snapshot;this.save();return snapshot;
 }
 async run(job,{prompt,signal}={}){
  this.job=job;this.canceled=Boolean(job.canceled);this.controller=new AbortController();const cancel=()=>this.control('cancel');
  if(signal?.aborted)this.controller.abort();signal?.addEventListener('abort',cancel,{once:true});
  const leases=[];let lockedConversation=job.conversation,poll;
  try{
   leases.push(acquire(this.lockDir,'job:'+job.id));
   this.checkCancel();poll=setInterval(()=>{try{this.checkCancel();}catch{this.controller.abort();void this.session?.abort();}},1000);
   if(job.conversation)leases.push(acquire(this.lockDir,keyFor(job.cwd,job.conversation)));
   if(job.phase!=='ready'||job.status==='RUNNING'||Object.keys(job.pendingTools||{}).length){this.set('PAUSED_UNCERTAIN','previous operation outcome is unknown');return job;}
   if(job.canceled){this.set('CANCELED','job already canceled');return job;}
   if(['SUCCEEDED','EXHAUSTED','NEEDS_USER','PAUSED_UNCERTAIN','CANCELED'].includes(job.status))return job;
   job.startedAt??=this.clock.now();this.save();let first=true;
   for(;;){
    this.controller.signal.throwIfAborted();
    if(this.clock.now()-job.startedAt>=job.config.maxJobElapsedMs){this.set('EXHAUSTED','job budget expired');return job;}
    const retry=job.status==='WAIT_QUOTA'||job.status==='WAIT_BACKOFF';
    if(retry){
     await this.wait();this.controller.signal.throwIfAborted();
     if(job.retryKind==='quota'||job.retryKind==='long-quota'){
      try{const q=await this.readQuota(60000,true);if(q){const reset=blockingReset(q,this.clock.now());if(reset){
       const d=decide({kind:'quota',resetAt:reset},job,this.clock.now(),this.rng(job.config.jitterMs),job.config);
       if(d.action!=='wait_quota'){this.set('NEEDS_USER',d.reason);return job;}
       // One reschedule is allowed, but the exhausted refresh budget cannot loop.
       job.nextRetryAt=d.at;this.save();await this.wait();this.set('NEEDS_USER','quota still blocked after deadline check; inspect /usage');return job;
      }}}catch{this.set('NEEDS_USER','quota refresh unavailable or ambiguous at deadline');return job;}
     }
    }
    while(job.paused){job.nextRetryAt??=this.clock.now();await this.wait();}
    this.checkCancel();
    this.controller.signal.throwIfAborted();
    if(this.clock.now()-job.startedAt>=job.config.maxJobElapsedMs){this.set('EXHAUSTED','job budget expired while waiting');return job;}
    const message=first&&prompt!==undefined?prompt:job.config.message;
    if(!job.conversation&&!(first&&prompt?.trim())){this.set('NEEDS_USER','a new conversation requires an initial prompt');return job;}
    validateMessage(message);
    let result,protocolError,initialized=false,dispatched=false;job.pendingTools={};job.phase='starting';this.set('RUNNING');
    this.session=this.adapter({executable:job.config.executable||'agy',prefixArgs:job.config.prefixArgs,cwd:job.cwd,conversation:job.conversation,model:job.model,agent:job.agent,watchdogMs:job.config.watchdogMs});
    for await(const e of this.session.events()){
     if(this.canceled){await this.session.abort();break;}
     if(e.event==='protocol_error'){protocolError=e.reason;continue;}
     if(e.event==='init'){
      if(initialized){protocolError='repeated init';await this.session.abort();break;}
      try{validateResume(job,e);}catch(err){protocolError=err.message;await this.session.close();break;}
      if(!lockedConversation){leases.push(acquire(this.lockDir,keyFor(job.cwd,e.conversation_id)));lockedConversation=e.conversation_id;}
      initialized=true;job.model ||= e.init.model||'';job.agent ||= e.init.agent||'';
      job.conversation=e.conversation_id;job.permissionMode=e.init.permission_mode;
      while(job.paused){job.nextRetryAt=this.clock.now();await this.wait();}
      this.checkCancel();
      this.controller.signal.throwIfAborted();
      if(this.clock.now()-job.startedAt>=job.config.maxJobElapsedMs){await this.session.close();this.set('EXHAUSTED','job budget expired before dispatch');return job;}
      if(retry){if(job.retryKind==='transient')job.transientRetries++;else job.quotaRetries++;}
      job.phase='dispatching';this.save();this.controller.signal.throwIfAborted();await this.session.send(message);dispatched=true;
     }
     if(e.event==='step_update'){
      if(!dispatched){protocolError='step before validated dispatch';await this.session.abort();break;}
      const st=e.step_update;if(st.conversation_id&&st.conversation_id!==job.conversation){protocolError='step conversation mismatch';await this.session.abort();break;}
      if(st.step_type==='tool'){
       if(st.state==='ACTIVE')job.pendingTools[String(st.step_index)]=st.tool_name||'tool';
       if(st.state==='DONE')delete job.pendingTools[String(st.step_index)];
      }
      if(st.state==='DONE')job.lastCompletedStep=st.step_index;
      if(st.step_type==='agent_response'&&typeof st.text_delta==='string')this.onOutput(st.text_delta);
      if(st.step_type==='tool')this.onOutput(`[tool ${st.tool_name||'unknown'} ${st.state||''}]\n`);
      this.save();
     }
     if(e.event==='result'){
      if(!initialized||!dispatched){protocolError='result before validated dispatch';await this.session.abort();break;}
      if(e.result.conversation_id&&e.result.conversation_id!==job.conversation){protocolError='result conversation mismatch';await this.session.abort();break;}
      result=e.result;await this.session.close();break;
     }
    }
    const exited=await this.session.close();this.session=null;
    if(this.canceled){job.phase=Object.keys(job.pendingTools).length?'uncertain':'ready';this.set(Object.keys(job.pendingTools).length?'PAUSED_UNCERTAIN':'CANCELED','canceled by user');return job;}
    if(protocolError||!result||!exited.clean){job.phase='uncertain';this.set(protocolError?.includes('mismatch')?'NEEDS_USER':'PAUSED_UNCERTAIN',protocolError||'no reliable terminal result / process shutdown');return job;}
    if(Object.keys(job.pendingTools).length){job.phase='uncertain';this.set('PAUSED_UNCERTAIN','tool completion unknown');return job;}
    job.phase='classifying';this.save();job.lastResultStatus=result.status;
    if(result.response)this.onOutput(result.response+'\n');
    let c=classify(result,this.clock.now());
    if(c.kind==='success'){job.phase='ready';this.set('SUCCEEDED');return job;}
    job.quotaRefreshes=0;
    if(['quota','long-quota'].includes(c.kind)){
     try{const q=await this.readQuota(60000);if(q){const reset=blockingReset(q,this.clock.now());if(reset)c={...c,resetAt:Math.max(reset,c.resetAt||0)};}}
     catch{ /* A reliable terminal reset remains usable; otherwise policy uses conservative fallback. */ }
    }
    const d=decide(c,job,this.clock.now(),this.rng(job.config.jitterMs),job.config);
    if(!d.action.startsWith('wait_')){job.phase='ready';this.set(d.action==='exhausted'?'EXHAUSTED':d.action==='canceled'?'CANCELED':'NEEDS_USER',d.reason);return job;}
    job.phase='ready';job.retryKind=c.kind;job.nextRetryAt=d.at;this.set(d.action==='wait_quota'?'WAIT_QUOTA':'WAIT_BACKOFF',d.reason);first=false;
   }
  }catch(err){
   if(!leases.length)throw err;
   if(this.session){await this.session.abort();this.session=null;}
   job.phase=job.phase==='dispatching'?'uncertain':job.phase;
   this.set(this.canceled&&!Object.keys(job.pendingTools||{}).length?'CANCELED':'PAUSED_UNCERTAIN',this.canceled?'canceled by user':'supervisor stopped; inspect diagnostics and saved state');
   return job;
  }finally{clearInterval(poll);signal?.removeEventListener('abort',cancel);if(this.canceled){try{fs.unlinkSync(path.join(this.store.dir,job.id+'.cancel'));}catch{}}for(const lease of leases.reverse()){try{lease.release();}catch{}}}
 }
}
