import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {atomicJSON,acquire,keyFor} from './state.js';
import {classify,decide,defaults} from './policy.js';
import {DEFAULT_RESUME_MESSAGE} from './session.js';
import {startSession} from './adapter.js';
import {QuotaProvider} from './quota.js';
import {sanitize} from './hud.js';
import {effectiveControls,loadControlConfig} from './control.js';
import {createHandoff,finalizeSemanticHandoff,loadHandoff,validateWorkspace,CONTINUE_PROMPT,HANDOFF_PROMPT} from './handoff.js';

const TERMINAL = new Set(['SUCCEEDED','CANCELED','EXHAUSTED','NEEDS_USER','PAUSED_UNCERTAIN','WEEKLY_BLOCKED','MULTI_CLI','RETRY_OFF']);
const WAITING = new Set(['WAIT_QUOTA','WAIT_BACKOFF']);
const INCIDENT_ACTIVE = new Set(['ARMED','WAITING','DISPATCHING']);
const MANUAL_SUPERSEDE_STATES = new Set(['WAIT_QUOTA','WAIT_BACKOFF','RUNNING','NEEDS_USER','PAUSED_UNCERTAIN','MULTI_CLI']);
const TERMINAL_INSTANCE_TTL_MS=30000;
const SCHEDULER_HEARTBEAT_INTERVAL_MS=15000;
const SCHEDULER_HEARTBEAT_STALE_MS=75000;

export function nativeRoot({platform=process.platform,home=os.homedir(),env=process.env}={}){
 if(env.AGY_RETRY_STATE_DIR)return path.resolve(env.AGY_RETRY_STATE_DIR,'native');
 if(platform==='win32')return path.join(env.LOCALAPPDATA||path.join(home,'AppData','Local'),'agy-retry','data','native');
 if(platform==='darwin')return path.join(home,'Library','Application Support','agy-retry','data','native');
 return path.join(env.XDG_STATE_HOME||path.join(home,'.local','state'),'agy-retry','native');
}
function idHash(id){return createHash('sha256').update(String(id)).digest('hex');}
function validConversation(id){return typeof id==='string'&&/^[A-Za-z0-9-]{16,128}$/.test(id);}
export function nativeFile(root,id){if(!validConversation(id))throw Error('invalid conversation id');return path.join(root,'sessions',idHash(id)+'.json');}
function telemetryFile(root,id){if(!validConversation(id))throw Error('invalid conversation id');return path.join(root,'telemetry',idHash(id)+'.json');}
export function loadNative(root,id){try{const s=JSON.parse(fs.readFileSync(nativeFile(root,id),'utf8'));if(s?.schemaVersion!==1||s.conversationId!==id)throw Error('invalid native state');return s;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export function loadTelemetry(root,id){try{const s=JSON.parse(fs.readFileSync(telemetryFile(root,id),'utf8'));if(s?.schemaVersion!==1||s.conversationId!==id)throw Error('invalid telemetry state');return s;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export function saveNative(root,state){if(state?.schemaVersion!==1||!validConversation(state.conversationId))throw Error('invalid native state');state.updatedAt=Date.now();atomicJSON(nativeFile(root,state.conversationId),state);return state;}

export function terminalInstanceBinding(env=process.env){
 const candidates=[['tmux',env.TMUX_PANE],['windows-terminal',env.WT_SESSION],['wezterm',env.WEZTERM_PANE],['kitty',env.KITTY_WINDOW_ID],['terminal-session',env.TERM_SESSION_ID],['gnome-terminal',env.GNOME_TERMINAL_SCREEN],['konsole',env.KONSOLE_DBUS_SESSION]];
 for(const [kind,value] of candidates)if(typeof value==='string'&&value.trim())return `${kind}:${value.trim()}`;
 return '';
}
export function activeTerminalInstances(telemetry,now=Date.now(),ttl=TERMINAL_INSTANCE_TTL_MS){
 const rows=[];for(const [key,value] of Object.entries(telemetry?.instances||{})){const lastSeen=value?.lastSeen;if(Number.isFinite(lastSeen)&&now-lastSeen<=ttl)rows.push({key,lastSeen,cwd:value?.cwd||''});}
 return rows.sort((a,b)=>b.lastSeen-a.lastSeen);
}
function mergeTerminalInstances(previous,binding,now,cwd){
 const instances={};for(const [key,value] of Object.entries(previous?.instances||{})){if(Number.isFinite(value?.lastSeen)&&now-value.lastSeen<=TERMINAL_INSTANCE_TTL_MS)instances[key]=value;}
 if(binding)instances[binding]={lastSeen:now,cwd:cwd||''};return instances;
}

function parseReset(b,now){
 if(typeof b?.reset_time==='string'){const t=Date.parse(b.reset_time);if(Number.isFinite(t))return t;}
 if(Number.isFinite(b?.reset_in_seconds)&&b.reset_in_seconds>=0)return now+b.reset_in_seconds*1000;
 return NaN;
}
export function quotaFromStatus(payload,now=Date.now()){
 const q=payload?.quota;if(!q||typeof q!=='object')return [];
 const out=[];
 for(const [name,b] of Object.entries(q)){
  const f=b?.remaining_fraction,resetAt=parseReset(b,now);if(!Number.isFinite(f)||f<0||f>1||!Number.isFinite(resetAt))continue;
  const lower=name.toLowerCase();const window=lower.includes('weekly')?'weekly':lower.includes('daily')?'daily':lower.includes('5h')||lower.includes('5-hour')?'5h':name;
  out.push({name,window,remainingFraction:f,resetAt});
 }
 return out;
}
export function snapshotFromStatusline(payload,now=Date.now()){
 const id=payload?.conversation_id||payload?.session_id;if(!validConversation(id))throw Error('statusline missing conversation id');
 const context=payload?.context_window;const pct=Number.isFinite(context?.used_percentage)?context.used_percentage:null;
 const cwd=payload?.workspace?.current_dir||payload?.cwd||'';
 return {schemaVersion:1,conversationId:id,cwd:typeof cwd==='string'?cwd:'',model:typeof payload?.model?.id==='string'?payload.model.id:'',status:'IDLE',phase:'native',createdAt:now,updatedAt:now,startedAt:now,transientRetries:0,quotaRetries:0,nextRetryAt:null,retryKind:'',retryLabel:'',reason:'',message:DEFAULT_RESUME_MESSAGE,retryIncident:null,scheduler:null,handoff:null,snapshot:{observedAt:now,agentState:payload?.agent_state||'unknown',contextPercent:pct,quota:quotaFromStatus(payload,now),toolConfirmationPending:payload?.tool_confirmation_pending===true,pendingInputCount:Number.isFinite(payload?.pending_input_count)?payload.pending_input_count:0,taskCount:Number.isFinite(payload?.task_count)?payload.task_count:0,artifactCount:Number.isFinite(payload?.artifact_count)?payload.artifact_count:0,terminalWidth:Number.isFinite(payload?.terminal_width)?payload.terminal_width:null}};
}
export function mergeStatusline(root,payload,now=Date.now(),{env=process.env}={}){
 const id=payload?.conversation_id||payload?.session_id;
 // AGY can invoke the status-line while the TUI is still bootstrapping, before a
 // conversation/session id exists. Render the HUD from the ephemeral payload but
 // do not persist telemetry until the conversation identity is available.
 if(!validConversation(id))return null;
 const snap=snapshotFromStatusline(payload,now);const previous=loadTelemetry(root,snap.conversationId),binding=terminalInstanceBinding(env);const instances=mergeTerminalInstances(previous,binding,now,snap.cwd);const telemetry={schemaVersion:1,conversationId:snap.conversationId,cwd:snap.cwd,model:snap.model,snapshot:snap.snapshot,instances,terminalBinding:binding||previous?.terminalBinding||'',updatedAt:now};
 const stable=x=>JSON.stringify({schemaVersion:x?.schemaVersion,conversationId:x?.conversationId,cwd:x?.cwd,model:x?.model,snapshot:x?.snapshot?{...x.snapshot,observedAt:0}:null,instanceKeys:Object.keys(x?.instances||{}).sort()});
 if(!previous||stable(previous)!==stable(telemetry)||now-(previous.updatedAt||0)>=5000)atomicJSON(telemetryFile(root,snap.conversationId),telemetry);
 const retry=loadNative(root,snap.conversationId);
 // v0.4.5 could persist PAUSED_UNCERTAIN when a Stop hook fired while AGY still
 // had background work. That state has no retry incident/timer and is safe to
 // clear once native telemetry for the same conversation is observed again.
 if(retry&&retry.status==='PAUSED_UNCERTAIN'&&!activeIncident(retry)&&retry.nextRetryAt==null&&retry.reason==='stop hook fired while background work is still active'){
  retry.status='IDLE';retry.reason='stale non-idle Stop marker cleared after native session telemetry resumed';retry.errorFingerprint='';saveNative(root,retry);
 }
 return retry?{...retry,cwd:retry.cwd||snap.cwd,model:retry.model||snap.model,snapshot:snap.snapshot}:snap;
}
function fmtMs(ms){
 const s=Math.max(0,Math.ceil(ms/1000)),d=Math.floor(s/86400),h=Math.floor(s/3600)%24,m=Math.floor(s/60)%60,sec=s%60;
 if(d)return `${d}d${h}h`;
 if(h>=10)return `${h}h${m?String(m).padStart(2,'0')+'m':''}`;
 if(h)return `${h}h${String(m).padStart(2,'0')}m`;
 return `${m}m${String(sec).padStart(2,'0')}s`;
}
export function fmtCountdown(ms){
 const total=Math.max(0,Math.ceil(Number(ms)||0)/1000),s=Math.floor(total%60),m=Math.floor(total/60)%60,h=Math.floor(total/3600)%24,d=Math.floor(total/86400);
 if(d)return `${d}d ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
 if(Math.floor(total/3600)>0)return `${String(Math.floor(total/3600)).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
 return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function defaultPidAlive(pid){
 if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e?.code==='EPERM';}
}
export function schedulerHealth(state,{now=Date.now(),pidAlive=defaultPidAlive}={}){
 const scheduler=state?.scheduler;if(!scheduler)return {status:WAITING.has(state?.status)?'LOST':'IDLE',workerAlive:false,heartbeatFresh:false};
 const workerAlive=pidAlive(scheduler.workerPid),heartbeatFresh=Number.isFinite(scheduler.lastHeartbeatAt)&&now-scheduler.lastHeartbeatAt<=SCHEDULER_HEARTBEAT_STALE_MS;
 if(['CHECKING','DISPATCHING','RUNNING'].includes(scheduler.status)){
  if(!workerAlive)return {status:'LOST',workerAlive:false,heartbeatFresh};
  return {status:scheduler.status==='CHECKING'?'CHECK':scheduler.status==='DISPATCHING'?'DISPATCH':'RUNNING',workerAlive:true,heartbeatFresh};
 }
 if(WAITING.has(state?.status)){
  if(scheduler.incidentId!==state?.retryIncident?.id||scheduler.nextRetryAt!==state?.nextRetryAt)return {status:'LOST',workerAlive,heartbeatFresh,reason:'scheduler state mismatch'};
  if(workerAlive&&heartbeatFresh)return {status:'OK',workerAlive:true,heartbeatFresh:true};
  if(workerAlive)return {status:'STALE',workerAlive:true,heartbeatFresh:false};
  if(scheduler.status==='STARTING'&&Number.isFinite(scheduler.requestedAt)&&now-scheduler.requestedAt<10000)return {status:'START',workerAlive:false,heartbeatFresh};
  return {status:'LOST',workerAlive:false,heartbeatFresh};
 }
 return {status:scheduler.status||'IDLE',workerAlive,heartbeatFresh};
}
function retryAttempt(state){
 const quota=['quota','long-quota'].includes(state?.retryKind),attempt=(quota?(state?.quotaRetries||0):(state?.transientRetries||0))+1,max=quota?(state?.config?.maxQuotaRetries??defaults.maxQuotaRetries):(state?.config?.maxTransientRetries??defaults.maxTransientRetries);return {attempt,max};
}
export function retrySchedulerDiagnostics(state,{now=Date.now(),pidAlive}={}){
 const health=schedulerHealth(state,{now,pidAlive}),remainingMs=Number.isFinite(state?.nextRetryAt)?Math.max(0,state.nextRetryAt-now):null,{attempt,max}=retryAttempt(state||{}),s=state?.scheduler||{};
 return {status:health.status,workerAlive:health.workerAlive,heartbeatFresh:health.heartbeatFresh,workerPid:Number.isInteger(s.workerPid)?s.workerPid:null,workerStartedAt:s.workerStartedAt||null,lastHeartbeatAt:s.lastHeartbeatAt||null,incidentId:s.incidentId||state?.retryIncident?.id||null,nextRetryAt:Number.isFinite(state?.nextRetryAt)?state.nextRetryAt:null,retryAt:Number.isFinite(state?.nextRetryAt)?new Date(state.nextRetryAt).toISOString():null,remainingMs,retryIn:remainingMs===null?null:fmtCountdown(remainingMs),deadlineSource:s.deadlineSource||null,retryLabel:s.retryLabel||state?.retryLabel||null,attempt:s.attempt||attempt,maxAttempts:s.maxAttempts||max};
}
function humanTokens(n){
 if(!Number.isFinite(n))return '?';const a=Math.abs(n);
 if(a>=1_000_000)return (n/1_000_000).toFixed(a>=10_000_000?0:1).replace(/\.0$/,'')+'M';
 if(a>=1_000)return (n/1_000).toFixed(a>=100_000?0:1).replace(/\.0$/,'')+'k';
 return String(Math.round(n));
}
function ansi(code,text,enabled){return enabled?`\x1b[${code}m${text}\x1b[0m`:text;}
function charWidth(ch){
 const cp=ch.codePointAt(0);if(cp===0||cp<32||(cp>=0x7f&&cp<0xa0))return 0;
 if((cp>=0x300&&cp<=0x36f)||(cp>=0x1ab0&&cp<=0x1aff)||(cp>=0x1dc0&&cp<=0x1dff)||(cp>=0x20d0&&cp<=0x20ff)||(cp>=0xfe20&&cp<=0xfe2f))return 0;
 if(cp>=0x1100&&(cp<=0x115f||cp===0x2329||cp===0x232a||(cp>=0x2e80&&cp<=0xa4cf&&cp!==0x303f)||(cp>=0xac00&&cp<=0xd7a3)||(cp>=0xf900&&cp<=0xfaff)||(cp>=0xfe10&&cp<=0xfe19)||(cp>=0xfe30&&cp<=0xfe6f)||(cp>=0xff00&&cp<=0xff60)||(cp>=0xffe0&&cp<=0xffe6)||(cp>=0x1f300&&cp<=0x1faff)||(cp>=0x20000&&cp<=0x3fffd)))return 2;
 return 1;
}
const ANSI_RE=/\x1b\[[0-?]*[ -\/]*[@-~]/g;
export function visibleWidth(text=''){let n=0;for(const ch of String(text).replace(ANSI_RE,''))n+=charWidth(ch);return n;}
export function clipVisible(text,max){
 text=String(text);if(max<=0)return '';let out='',used=0,i=0,sawAnsi=false;
 while(i<text.length){if(text[i]==='\x1b'){const m=text.slice(i).match(/^\x1b\[[0-?]*[ -\/]*[@-~]/);if(m){out+=m[0];i+=m[0].length;sawAnsi=true;continue;}}
  const cp=text.codePointAt(i),ch=String.fromCodePoint(cp),w=charWidth(ch);if(used+w>max)break;out+=ch;used+=w;i+=ch.length;
 }
 if(sawAnsi&&!out.endsWith('\x1b[0m'))out+='\x1b[0m';return out;
}
export function padVisible(text,width,align='left'){
 const clipped=clipVisible(text,width),pad=Math.max(0,width-visibleWidth(clipped));
 if(align==='right')return ' '.repeat(pad)+clipped;
 if(align==='center'){const left=Math.floor(pad/2);return ' '.repeat(left)+clipped+' '.repeat(pad-left);}
 return clipped+' '.repeat(pad);
}
export function metricColorCode(kind,value){
 const pct=Math.max(0,Math.min(100,Number(value)||0));
 if(kind==='context'){if(pct>=95)return '91';if(pct>=85)return '38;5;208';if(pct>=70)return '93';return '92';}
 if(kind==='quota'){if(pct<10)return '91';if(pct<30)return '38;5;208';if(pct<70)return '93';return '92';}
 if(kind==='retry')return '93';
 return '96';
}
function progressBar(value,width=10,{kind='quota',color=true}={}){
 const pct=Math.max(0,Math.min(100,Number(value)||0)),filled=Math.max(0,Math.min(width,Math.round(pct/100*width)));
 const raw='█'.repeat(filled)+'░'.repeat(width-filled);return ansi(metricColorCode(kind,pct),raw,color);
}
export function providerForModel(model=''){
 const m=String(model).toLowerCase();if(m.includes('gemini'))return 'gemini';if(m.includes('claude')||m.includes('anthropic'))return 'claude';if(m.includes('gpt')||m.includes('openai'))return 'openai';return '';
}
function providerForBucket(name=''){
 const n=String(name).toLowerCase();if(n.includes('gemini')||n.includes('google'))return 'gemini';if(n.includes('claude')||n.includes('anthropic'))return 'claude';if(n.includes('gpt')||n.includes('openai'))return 'openai';return n.split(/[-_:]/)[0]||'other';
}
export function selectDisplayQuotas(payload,now=Date.now()){
 const all=quotaFromStatus(payload,now).map(q=>({...q,provider:providerForBucket(q.name)})),wanted=providerForModel(payload?.model?.display_name||payload?.model?.id||'');
 const source=wanted&&all.some(q=>q.provider===wanted)?all.filter(q=>q.provider===wanted):all;
 const order={"5h":0,weekly:1,daily:2};const byWindow=new Map();
 for(const q of source){const key=q.window,prev=byWindow.get(key);if(!prev||q.remainingFraction<prev.remainingFraction)byWindow.set(key,q);}
 return [...byWindow.values()].sort((a,b)=>(order[a.window]??9)-(order[b.window]??9)).slice(0,3);
}
function retryDisplay(state,now,color,controls){
 const enabled=controls?.retryEnabled ?? state?.effectiveRetry ?? true;
 const override=controls?.retryOverride ?? state?.retryOverride ?? 'inherit';
 if(!enabled)return ansi('90','retry:OFF',color);
 if(state?.status==='WEEKLY_BLOCKED')return ansi('91','retry:WEEKLY BLOCK',color);
 if(state?.status==='NEEDS_USER')return ansi('91','retry:NEEDS USER',color);
 if(state?.status==='PAUSED_UNCERTAIN')return ansi('93','retry:UNCERTAIN',color);
 if(state?.status==='MULTI_CLI')return ansi('91','retry:MULTI-CLI',color);
 const incident=state?.retryIncident;
 if(incident?.status==='RESOLVED'&&Number.isFinite(incident.resolvedAt)&&now-incident.resolvedAt<60000)return ansi('92','retry:RESOLVED',color);
 if(incident?.status==='SUPERSEDED'&&Number.isFinite(incident.supersededAt)&&now-incident.supersededAt<60000)return ansi('90','retry:SUPERSEDED',color);
 if(incident?.status==='ARMED')return ansi('93','retry:ARMED',color);
 if(WAITING.has(state?.status)&&Number.isFinite(state.nextRetryAt)){
  const d=retrySchedulerDiagnostics(state,{now}),healthCode=['LOST','STALE'].includes(d.status)?'91':d.status==='OK'?'92':'96',waitCode=d.remainingMs!==null&&d.remainingMs<60000?'38;5;208':d.remainingMs!==null&&d.remainingMs<300000?'38;5;208':'93';
  const label=d.retryLabel||(['quota','long-quota'].includes(state.retryKind)?'QUOTA':'API');
  return `${ansi(waitCode,`retry:WAIT ${d.retryIn}`,color)} ${ansi('90','·',color)} ${ansi('93',label,color)} ${ansi('90','·',color)} ${ansi('90',`${d.attempt}/${d.maxAttempts}`,color)} ${ansi('90','·',color)} ${ansi(healthCode,`sched:${d.status}`,color)}`;
 }
 if(state?.status==='RUNNING'&&state?.scheduler){const d=retrySchedulerDiagnostics(state,{now});const label=d.retryLabel||'API';return `${ansi('96',`retry:${d.status==='DISPATCH'?'DISPATCH':'RUNNING'}`,color)} ${ansi('90','·',color)} ${ansi('93',label,color)} ${ansi('90','·',color)} ${ansi('90',`${d.attempt}/${d.maxAttempts}`,color)}`;}
 if(override==='on')return ansi('92','retry:SESSION',color);
 return ansi('90','retry:ON',color);
}
function handoffDisplay(state,color,controls){
 const enabled=controls?.handoffEnabled ?? state?.effectiveHandoff ?? true;
 if(!enabled)return ansi('90','handoff:OFF',color);
 const st=state?.handoff?.status||state?.handoffStatus;
 if(!st)return '';
 const labels={WARNING:'WARN',SNAPSHOT_READY:'SNAPSHOT',PREPARING:'PREP',PENDING:'PENDING',READY:'READY',ROLLOVER_ARMED:'READY',ROLLOVER:'ROLLOVER',BLOCKED:'BLOCKED',WORKSPACE_MISMATCH:'BLOCKED'};
 const label=labels[st]||st;const code=['BLOCKED','WORKSPACE_MISMATCH'].includes(st)?'91':['READY','ROLLOVER_ARMED'].includes(st)?'92':['PREPARING','PENDING','ROLLOVER'].includes(st)?'93':'90';
 return ansi(code,`handoff:${label}`,color);
}
export function defaultHudConfig(){return {color:true,compact:true,multiline:true,show_progress_bar:true,show_plan:true,show_branch:true,show_cwd:true,show_tokens:false,show_agent_state:true,show_retry:true,show_handoff:true,bar_width:10};}
export function loadHudConfig({env=process.env,home=os.homedir(),platform=process.platform}={}){
 let control;try{control=loadControlConfig({file:env.AGY_RETRY_HUD_CONFIG||undefined,env});}catch{control=null;}
 const base=defaultHudConfig(),h=control?.hud||{};
 const map={color:'color',compact:'compact',multiline:'multiline',showProgressBar:'show_progress_bar',showPlan:'show_plan',showBranch:'show_branch',showCwd:'show_cwd',showTokens:'show_tokens',showAgentState:'show_agent_state',showRetry:'show_retry',showHandoff:'show_handoff',barWidth:'bar_width'};
 for(const [a,b] of Object.entries(map))if(a in h)base[b]=h[a];
 if(env.NO_COLOR!==undefined||env.TERM==='dumb')base.color=false;base.bar_width=Math.max(6,Math.min(16,Number(base.bar_width)||10));return base;
}
function quotaMetric(q,barWidth,color,now){
 const remaining=Math.round(q.remainingFraction*100),code=metricColorCode('quota',remaining);
 return {
  label:q.window==='weekly'?'week':'5h',
  bar:barWidth?progressBar(remaining,barWidth,{kind:'quota',color}):'',
  value:ansi(code,`${remaining}%`,color),
  valueLong:ansi(code,`${remaining}% left`,color),
  detail:ansi('90',`↻ ${fmtMs(q.resetAt-now)}`,color)
 };
}
function joinSegments(parts,sep,color){return parts.filter(Boolean).join(ansi('90',sep,color));}
function compactHeader({stateText,model,plan,location,retry,handoff,color,width}){
 const sep=' │ ';let optional=[plan,location].filter(Boolean),policy=[retry,handoff].filter(Boolean),modelText=model;
 const render=()=>joinSegments([padVisible(stateText,10),ansi('95',modelText,color),...optional,...policy],sep,color);
 let out=render();
 if(visibleWidth(out)>width&&optional.length){optional.pop();out=render();}
 if(visibleWidth(out)>width&&optional.length){optional.pop();out=render();}
 if(visibleWidth(out)>width){modelText=clipVisible(modelText,24);out=render();}
 if(visibleWidth(out)>width&&policy.length>1){policy=policy.slice(0,1);out=render();}
 return clipVisible(out,width);
}
function compactMetric(label,bar,value,detail,color,{labelWidth=4,valueWidth=4}={}){
 const cells=[padVisible(ansi('90',label,color),labelWidth)];if(bar)cells.push(bar);cells.push(padVisible(value,valueWidth,'right'));if(detail)cells.push(detail);return cells.join(' ');
}
export function renderNativeStatusline(payload,state,now=Date.now(),config=defaultHudConfig(),controls){
 const cfg={...defaultHudConfig(),...config},color=cfg.color!==false&&process.env.NO_COLOR===undefined,width=Math.max(40,Number(payload?.terminal_width)||100),maxWidth=Math.max(36,width-4),contentWidth=Math.max(30,maxWidth-3);
 const rawModel=sanitize(payload?.model?.display_name||payload?.model?.id||state?.model||'model?'),model=clipVisible(rawModel,34);
 const pct=Number.isFinite(payload?.context_window?.used_percentage)?payload.context_window.used_percentage:state?.snapshot?.contextPercent,ctxPct=Number.isFinite(pct)?Math.max(0,Math.min(100,pct)):null;
 const ctxSize=payload?.context_window?.context_window_size,ctxUsed=Number.isFinite(ctxPct)&&Number.isFinite(ctxSize)?ctxSize*ctxPct/100:null,usage=payload?.context_window?.current_usage||{};
 const plan=sanitize(payload?.plan_tier||''),cwd=sanitize((payload?.workspace?.current_dir||payload?.cwd||'').split(/[\\/]/).pop()||''),branch=sanitize(payload?.vcs?.branch||''),dirty=payload?.vcs?.dirty===true;
 const agent=sanitize(String(payload?.agent_state||state?.snapshot?.agentState||'unknown')).toUpperCase(),agentCode=agent==='IDLE'?'92':agent==='THINKING'?'93':agent==='WORKING'?'96':agent==='TOOL_USE'?'95':'97';
 const stateText=cfg.show_agent_state?ansi(agentCode,agent==='IDLE'?'● READY':`● ${agent}`,color):ansi('90','AGY',color),sep=ansi('90',' │ ',color);
 const location=cfg.show_branch&&branch?ansi(dirty?'93':'94',`git:${branch}${dirty?'*':''}`,color):cfg.show_cwd&&cwd?ansi('97',cwd,color):'';
 const planText=cfg.show_plan&&plan?ansi('94',plan,color):'';
 const retry=cfg.show_retry?retryDisplay(state,now,color,controls):'',handoff=cfg.show_handoff?handoffDisplay(state,color,controls):'';
 const barWidth=cfg.show_progress_bar?Math.max(6,Math.min(16,Number(cfg.bar_width)||10)):0;
 const quotas=selectDisplayQuotas(payload,now),five=quotas.find(x=>x.window==='5h'),week=quotas.find(x=>x.window==='weekly');
 const ctxCode=Number.isFinite(ctxPct)?metricColorCode('context',ctxPct):'90',ctxBar=Number.isFinite(ctxPct)&&barWidth?progressBar(ctxPct,barWidth,{kind:'context',color}):'';
 const ctxValue=Number.isFinite(ctxPct)?ansi(ctxCode,`${Math.round(ctxPct)}%`,color):ansi('90','?',color),ctxValueLong=Number.isFinite(ctxPct)?ansi(ctxCode,`${Math.round(ctxPct)}% used`,color):ansi('90','? used',color);
 const ctxDetail=Number.isFinite(ctxUsed)&&Number.isFinite(ctxSize)?ansi('90',`${humanTokens(ctxUsed)}/${humanTokens(ctxSize)}`,color):'';

 if(cfg.compact!==false){
  const header=compactHeader({stateText,model,plan:planText,location,retry,handoff,color,width:contentWidth});
  const compactBar=barWidth?Math.min(barWidth,8):0;
  const ctx=compactMetric('ctx',Number.isFinite(ctxPct)&&compactBar?progressBar(ctxPct,compactBar,{kind:'context',color}):'',ctxValue,ctxDetail,color,{labelWidth:3,valueWidth:4});
  const chunks=[ctx];
  if(five){const f=quotaMetric(five,compactBar,color,now);chunks.push(compactMetric('5h',f.bar,f.value,f.detail,color,{labelWidth:3,valueWidth:4}));}
  if(week){const w=quotaMetric(week,compactBar,color,now);chunks.push(compactMetric('week',w.bar,w.value,w.detail,color,{labelWidth:4,valueWidth:4}));}
  let metricLine=joinSegments(chunks,' │ ',color),lines=[header];
  if(visibleWidth(metricLine)<=contentWidth)lines.push(metricLine);
  else{
   const first=joinSegments(chunks.slice(0,Math.min(2,chunks.length)),' │ ',color);lines.push(clipVisible(first,contentWidth));
   if(chunks.length>2)lines.push(clipVisible(chunks.slice(2).join('  '),contentWidth));
  }
  if(cfg.multiline===false)lines=[joinSegments(lines,' │ ',color)];
  return lines.map((line,i)=>clipVisible(ansi('90',lines.length===1?'':i===0?'╭─ ':i===lines.length-1?'╰─ ':'├─ ',color)+line,maxWidth)).join('\n');
 }

 const identity=[padVisible(stateText,12),ansi('95',model,color)];if(planText)identity.push(planText);if(location)identity.push(location);const identityLine=identity.join(sep);
 const prefixWidth=10,valueWidth=9,detailWidth=12;
 const metric=(prefix,bar,value,detail,tail='')=>{const cells=[padVisible(ansi('90',prefix,color),prefixWidth)];if(barWidth)cells.push(padVisible(bar,barWidth));cells.push(padVisible(value,valueWidth,'right'));if(detail)cells.push(padVisible(detail,detailWidth));let row=cells.join(' ');if(tail)row+='  '+tail;return clipVisible(row,contentWidth);};
 const runtime=[];if(Number.isFinite(payload?.task_count)&&payload.task_count>0)runtime.push(`tasks:${payload.task_count}`);if(Number.isFinite(payload?.artifact_count)&&payload.artifact_count>0)runtime.push(`artifacts:${payload.artifact_count}`);if(payload?.tool_confirmation_pending)runtime.push('confirm!');if(Number.isFinite(payload?.pending_input_count)&&payload.pending_input_count>0)runtime.push(`queued:${payload.pending_input_count}`);
 if(cfg.show_tokens&&maxWidth>=120){const bits=[];if(Number.isFinite(usage.input_tokens))bits.push(`in:${humanTokens(usage.input_tokens)}`);if(Number.isFinite(usage.output_tokens))bits.push(`out:${humanTokens(usage.output_tokens)}`);const cache=(usage.cache_read_input_tokens||0)+(usage.cache_creation_input_tokens||0);if(cache)bits.push(`cache:${humanTokens(cache)}`);runtime.push(...bits);}
 const ctxTail=[retry,handoff,...runtime.map(x=>ansi('90',x,color))].filter(Boolean).join('  ');
 let lines=[identityLine,metric('ctx',ctxBar,ctxValueLong,ctxDetail,ctxTail)];
 if(five&&week){const f=quotaMetric(five,barWidth,color,now),w=quotaMetric(week,barWidth,color,now),first=metric('quota  5h',f.bar,f.valueLong,f.detail),second=[padVisible(ansi('90','week',color),5),barWidth?padVisible(w.bar,barWidth):'',padVisible(w.valueLong,valueWidth,'right'),padVisible(w.detail,detailWidth)].filter(Boolean).join('  '),combined=`${first}${sep}${second}`;if(visibleWidth(combined)<=contentWidth)lines.push(combined);else{lines.push(metric('5h',f.bar,f.valueLong,f.detail));lines.push(metric('week',w.bar,w.valueLong,w.detail));}}
 else if(quotas.length){for(const q of quotas){const m=quotaMetric(q,barWidth,color,now);lines.push(metric(m.label,m.bar,m.valueLong,m.detail));}}else lines.push(metric('quota','',ansi('90','unknown',color),''));
 if(cfg.multiline===false)lines=[lines.join(sep)];return lines.map((line,i)=>clipVisible(ansi('90',lines.length===1?'':i===0?'╭─ ':i===lines.length-1?'╰─ ':'├─ ',color)+line,maxWidth)).join('\n');
}

function fingerprint(text){return createHash('sha256').update(String(text||'')).digest('hex').slice(0,16);}
function incidentSequence(payload){return Number.isInteger(payload?.executionNum)&&payload.executionNum>=0?payload.executionNum:null;}
function incidentId(conversationId,payload,fp,now){return 'ri-'+fingerprint(`${conversationId}:${incidentSequence(payload)??'na'}:${fp}:${now}`);}
function activeIncident(state){return state?.retryIncident&&INCIDENT_ACTIVE.has(state.retryIncident.status)?state.retryIncident:null;}
function setIncidentStatus(state,status,now,extra={}){if(!state?.retryIncident)return null;state.retryIncident={...state.retryIncident,status,updatedAt:now,...extra};return state.retryIncident;}
export function clearRetryState(root,id,{now=Date.now(),reason='manual_clear'}={}){
 const state=loadNative(root,id);if(!state)return {conversationId:id,cleared:false,status:'IDLE',reason:'no native retry state'};
 const previousStatus=state.status,previousReason=state.reason||'',incidentId=state.retryIncident?.id||null;
 if(state.retryIncident&&!['RESOLVED','SUPERSEDED','SUCCEEDED','CANCELED'].includes(state.retryIncident.status))setIncidentStatus(state,'SUPERSEDED',now,{supersededAt:now,supersededBy:reason,previousStatus,previousReason});
 state.status='IDLE';state.reason='retry state cleared by user';state.nextRetryAt=null;state.retryKind='';state.retryLabel='';state.errorFingerprint='';if(state.scheduler)setSchedulerStatus(state,'SUPERSEDED',now,{nextRetryAt:null,completedAt:now});saveNative(root,state);
 return {conversationId:id,cleared:true,status:state.status,incidentId,incidentStatus:state.retryIncident?.status||null,previousStatus,previousReason};
}
function armIncident(state,payload,fp,kind,now){
 const previous=activeIncident(state),seq=incidentSequence(payload);
 if(previous&&previous.fingerprint===fp&&(seq===null||previous.executionNum===null||previous.executionNum===seq))return {incident:previous,duplicate:true};
 const incident={id:incidentId(state.conversationId,payload,fp,now),conversationId:state.conversationId,status:'ARMED',kind,fingerprint:fp,executionNum:seq,createdAt:now,updatedAt:now};
 if(previous)incident.supersedesIncidentId=previous.id;
 state.retryIncident=incident;return {incident,duplicate:false};
}
function incidentMatches(state,expectedIncidentId,{requireCurrent=true,statuses=INCIDENT_ACTIVE}={}){
 const incident=state?.retryIncident;if(!requireCurrent&&!incident)return true;if(!incident||!statuses.has(incident.status))return false;
 return !expectedIncidentId||incident.id===expectedIncidentId;
}
function staleRetryResult(reason='retry incident is no longer current'){return {status:'STALE_RETRY',reason};}
function classifyStop(payload,now){
 if(payload?.terminationReason!=='error'&&!payload?.error)return {kind:'none'};
 return classify({status:'ERROR',error:payload.error},now);
}
function applyQuotaSnapshot(c,state,now){
 if(!['quota','long-quota'].includes(c.kind))return c;const blocked=(state?.snapshot?.quota||[]).filter(b=>b.remainingFraction===0&&b.resetAt>now);
 if(!blocked.length)return c;const latest=Math.max(...blocked.map(b=>b.resetAt));const long=blocked.some(b=>['weekly','daily'].includes(b.window));return {...c,kind:long?'long-quota':c.kind,resetAt:Math.max(c.resetAt||0,latest)};
}
function exhaustedFiveHourQuota(state,now){
 const bucket=(state?.snapshot?.quota||[]).find(b=>b.window==='5h'&&Number.isFinite(b.remainingFraction)&&b.remainingFraction<=0.001&&Number.isFinite(b.resetAt)&&b.resetAt>now);
 return bucket||null;
}
function quotaFallbackFromTelemetry(payload,state,c,now){
 if(payload?.terminationReason!=='error')return {classification:c,source:'payload'};
 if(['quota','long-quota','transient','permanent'].includes(c.kind))return {classification:c,source:'payload'};
 const bucket=exhaustedFiveHourQuota(state,now);if(!bucket)return {classification:c,source:'payload'};
 const text=typeof payload?.error==='string'?payload.error:'';
 // If the Stop error itself is missing, AGY may still expose the exhausted 5h
 // bucket through statusline telemetry. Only upgrade UNKNOWN/NONE to quota when
 // that structured bucket is truly exhausted and has a future reset.
 if(!text.trim()||c.kind==='none'||c.kind==='unknown')return {classification:{kind:'quota',resetAt:bucket.resetAt},source:'telemetry-5h'};
 return {classification:c,source:'payload'};
}
function recordLastStop(state,payload,c,source,now){
 state.lastStop={at:now,executionNum:Number.isInteger(payload?.executionNum)?payload.executionNum:null,terminationReason:typeof payload?.terminationReason==='string'?payload.terminationReason:'',fullyIdle:payload?.fullyIdle===true,hadError:typeof payload?.error==='string'?Boolean(payload.error.trim()):Boolean(payload?.error),classification:c?.kind||'unknown',classificationSource:source||'payload'};
}
function errorText(raw){return typeof raw==='string'?raw:typeof raw?.message==='string'?raw.message:'';}
function retryLabelFor(c,raw){
 if(['quota','long-quota'].includes(c?.kind))return 'QUOTA';const text=errorText(raw);if(c?.kind!=='transient')return String(c?.kind||'API').toUpperCase();
 if(/\b503\b|service unavailable/i.test(text))return '503';if(/\b502\b|bad gateway/i.test(text))return '502';if(/\b504\b|gateway timeout/i.test(text))return '504';if(/\b429\b|RESOURCE_EXHAUSTED/i.test(text))return '429';if(/ETIMEDOUT|timeout/i.test(text))return 'TIMEOUT';if(/ECONNRESET|EAI_AGAIN|ECONNREFUSED|network|transport/i.test(text))return 'NET';return 'API';
}
function deadlineSourceFor(c,classificationSource='payload'){
 if(classificationSource==='telemetry-5h')return 'telemetry-5h';if(['quota','long-quota'].includes(c?.kind))return c?.resetAt?'server':'fallback';if(c?.kind==='transient')return c?.retryAfterMs||c?.resetAt?'server-delay':'backoff';return null;
}
function schedulerPlan(state,c,classificationSource,nextRetryAt,now){
 const {attempt,max}=retryAttempt(state);return {status:'STARTING',incidentId:state.retryIncident?.id||null,requestedAt:now,workerPid:null,workerStartedAt:null,lastHeartbeatAt:now,nextRetryAt,deadlineSource:deadlineSourceFor(c,classificationSource),retryLabel:state.retryLabel||retryLabelFor(c,''),attempt,maxAttempts:max};
}
function setSchedulerStatus(state,status,now,extra={}){state.scheduler={...(state.scheduler||{}),status,lastHeartbeatAt:now,...extra};return state.scheduler;}
function heartbeatScheduler(root,state,now){if(!state?.scheduler)return;const last=state.scheduler.lastHeartbeatAt||0;if(now-last<SCHEDULER_HEARTBEAT_INTERVAL_MS)return;state.scheduler.lastHeartbeatAt=now;state.scheduler.workerPid=process.pid;saveNative(root,state);}
export function weeklyGate(state,now=Date.now(),retryConfig=loadControlConfig().retry){
 if(retryConfig.stopWhenWeeklyExhausted===false)return {status:'disabled'};
 const observed=state?.snapshot?.observedAt,week=(state?.snapshot?.quota||[]).find(b=>b.window==='weekly');
 if(!week)return {status:'unknown'};
 if(Number.isFinite(observed)&&now-observed>300000)return {status:'stale',bucket:week};
 const threshold=Number.isFinite(retryConfig.weeklyRemainingThreshold)?retryConfig.weeklyRemainingThreshold:.01;
 return week.remainingFraction<=threshold?{status:'blocked',bucket:week,threshold}:{status:'healthy',bucket:week,threshold};
}
function applyControlState(root,state,controlConfig){
 const controls=effectiveControls(root,state.conversationId,{config:controlConfig||loadControlConfig()});
 state.retryOverride=controls.retryOverride;state.handoffOverride=controls.handoffOverride;state.effectiveRetry=controls.retryEnabled;state.effectiveHandoff=controls.handoffEnabled;return controls;
}
function newNativeState(id,telemetry,payload,now){
 return {schemaVersion:1,conversationId:id,cwd:telemetry?.cwd||payload.workspacePaths?.[0]||'',model:telemetry?.model||payload.modelName||'',status:'IDLE',phase:'native',createdAt:now,startedAt:now,transientRetries:0,quotaRetries:0,nextRetryAt:null,retryKind:'',retryLabel:'',reason:'',message:DEFAULT_RESUME_MESSAGE,retryIncident:null,scheduler:null,lastStop:null,handoff:null,snapshot:telemetry?.snapshot||{observedAt:now,agentState:'unknown',contextPercent:null,quota:[],toolConfirmationPending:false,pendingInputCount:0,taskCount:0,artifactCount:0,terminalWidth:null}};
}
export function scheduleFromStop(root,payload,{now=Date.now(),config={},controlConfig,spawnWorker}={}){
 const id=payload?.conversationId;if(!validConversation(id))return {decision:'stop',scheduled:false,reason:'missing conversation id'};
 if(process.env.AGY_RETRY_NATIVE_WORKER==='1'||process.env.AGY_RETRY_HANDOFF_WORKER==='1'||process.env.AGY_RETRY_ROLLOVER_WORKER==='1')return {decision:'stop',scheduled:false,reason:'nested worker'};
 const telemetry=loadTelemetry(root,id);let state=loadNative(root,id)||newNativeState(id,telemetry,payload,now);
 if(telemetry){state.snapshot=telemetry.snapshot;state.cwd=state.cwd||telemetry.cwd;state.model=state.model||telemetry.model;}
 const ctl=controlConfig||loadControlConfig(),controls=applyControlState(root,state,ctl);
 let c=classifyStop(payload,now);const fallback=quotaFallbackFromTelemetry(payload,state,c,now);c=fallback.classification;recordLastStop(state,payload,c,fallback.source,now);
 if(payload.fullyIdle===false&&c.kind==='none'){
  // A non-idle normal Stop can occur while AGY still has background/subagent
  // work. It is not a retry failure and must not poison retry state.
  saveNative(root,state);return {decision:'stop',scheduled:false,deferred:true,reason:'native AGY still has background work; normal Stop deferred'};
 }
 if(payload.fullyIdle===false&&!['quota','long-quota','transient'].includes(c.kind)){
  // Non-retryable/unknown errors are not background-retried while AGY is still
  // active. Persist diagnostics, but wait for the final fully-idle Stop.
  saveNative(root,state);return {decision:'stop',scheduled:false,deferred:true,reason:`native AGY still active; ${c.kind} retry decision deferred`};
 }
 if(c.kind==='none'){
  if(ctl.retry.autoDisarmIncidentOnSuccess!==false&&activeIncident(state))setIncidentStatus(state,'RESOLVED',now,{resolvedAt:now,resolution:'normal_stop',resolvedExecutionNum:incidentSequence(payload)});
  if(WAITING.has(state.status)||state.status==='RUNNING'){state.status='IDLE';state.reason='native AGY completed normally; pending auto-retry resolved';state.nextRetryAt=null;state.errorFingerprint='';if(state.scheduler)setSchedulerStatus(state,'RESOLVED',now,{nextRetryAt:null,completedAt:now});}
  saveNative(root,state);return {decision:'stop',scheduled:false,reason:'normal stop'};
 }
 if(!controls.retryEnabled){if(activeIncident(state))setIncidentStatus(state,'CANCELED',now,{canceledAt:now,resolution:'retry_policy_off'});state.status='RETRY_OFF';state.reason='automatic retry disabled by policy';state.nextRetryAt=null;if(state.scheduler)setSchedulerStatus(state,'CANCELED',now,{nextRetryAt:null,completedAt:now});saveNative(root,state);return {decision:'stop',scheduled:false,reason:state.reason};}
 const weekly=weeklyGate(state,now,ctl.retry);if(weekly.status==='blocked'){if(activeIncident(state))setIncidentStatus(state,'BLOCKED',now,{blockedAt:now,resolution:'weekly_quota'});state.status='WEEKLY_BLOCKED';state.reason='weekly quota at or below safety threshold';state.nextRetryAt=null;state.weeklyResetAt=weekly.bucket.resetAt;if(state.scheduler)setSchedulerStatus(state,'BLOCKED',now,{nextRetryAt:null,completedAt:now});saveNative(root,state);return {decision:'stop',scheduled:false,reason:state.reason};}
 c=applyQuotaSnapshot(c,state,now);const fp=fingerprint(payload.error),armed=armIncident(state,payload,fp,c.kind,now);
 const activeInstances=activeTerminalInstances(telemetry,now);if(['quota','long-quota','transient'].includes(c.kind)&&activeInstances.length>1){setIncidentStatus(state,'BLOCKED',now,{blockedAt:now,resolution:'multi_cli',terminalInstanceCount:activeInstances.length});state.status='MULTI_CLI';state.reason='conversation is active in multiple AGY CLI instances';state.nextRetryAt=null;state.errorFingerprint=fp;if(state.scheduler)setSchedulerStatus(state,'BLOCKED',now,{nextRetryAt:null,completedAt:now});saveNative(root,state);return {decision:'stop',scheduled:false,reason:state.reason,incidentId:state.retryIncident?.id,multiCli:true};}
 if(armed.duplicate&&WAITING.has(state.status)&&state.nextRetryAt>now)return {decision:'stop',scheduled:false,reason:'duplicate stop',incidentId:armed.incident.id};
 if(!['quota','long-quota','transient'].includes(c.kind)){
  setIncidentStatus(state,'NEEDS_USER',now,{resolution:c.kind});state.status='NEEDS_USER';state.reason=c.kind;state.nextRetryAt=null;state.errorFingerprint=fp;saveNative(root,state);return {decision:'stop',scheduled:false,reason:c.kind,incidentId:state.retryIncident?.id};
 }
 state.startedAt=now;state.transientRetries=0;state.quotaRetries=0;state.message=state.message||DEFAULT_RESUME_MESSAGE;
 const cfg={...defaults,...ctl.retry,...config},d=decide(c,state,now,0,cfg);
 if(!d.action.startsWith('wait_')){setIncidentStatus(state,d.action==='exhausted'?'EXHAUSTED':'NEEDS_USER',now,{resolution:d.reason});state.status=d.action==='exhausted'?'EXHAUSTED':'NEEDS_USER';state.reason=d.reason;saveNative(root,state);return {decision:'stop',scheduled:false,reason:d.reason,incidentId:state.retryIncident?.id};}
 state.status=d.action==='wait_quota'?'WAIT_QUOTA':'WAIT_BACKOFF';state.retryKind=c.kind;state.retryLabel=retryLabelFor(c,payload.error);state.waitStartedAt=now;state.nextRetryAt=d.at;state.reason=c.kind;state.errorFingerprint=fp;state.config={...cfg};setIncidentStatus(state,'WAITING',now,{nextRetryAt:d.at,kind:c.kind,retryLabel:state.retryLabel,deadlineSource:deadlineSourceFor(c,fallback.source)});state.scheduler=schedulerPlan(state,c,fallback.source,d.at,now);saveNative(root,state);
 let workerPid=null;try{workerPid=spawnWorker?.(id,state.retryIncident.id)??null;}catch(e){state.scheduler.status='LOST';state.scheduler.spawnError=true;state.reason='retry worker failed to start';saveNative(root,state);return {decision:'stop',scheduled:false,state,incidentId:state.retryIncident.id,reason:state.reason};}
 if(Number.isInteger(workerPid)&&workerPid>0){state.scheduler.workerPid=workerPid;state.scheduler.workerStartedAt=now;state.scheduler.status='WAITING';state.scheduler.lastHeartbeatAt=now;saveNative(root,state);}return {decision:'stop',scheduled:true,state,incidentId:state.retryIncident.id,workerPid};
}

export function scheduleFromPreInvocation(root,payload,{now=Date.now(),controlConfig}={}){
 const id=payload?.conversationId;if(!validConversation(id))return {decision:'allow',superseded:false,reason:'missing conversation id'};
 if(process.env.AGY_RETRY_NATIVE_WORKER==='1'||process.env.AGY_RETRY_HANDOFF_WORKER==='1'||process.env.AGY_RETRY_ROLLOVER_WORKER==='1')return {decision:'allow',superseded:false,reason:'nested worker'};
 const state=loadNative(root,id);if(!state)return {decision:'allow',superseded:false,reason:'no native retry state'};
 const ctl=controlConfig||loadControlConfig();applyControlState(root,state,ctl);
 const shouldSupersede=MANUAL_SUPERSEDE_STATES.has(state.status)||Boolean(activeIncident(state))||['NEEDS_USER','PAUSED_UNCERTAIN','BLOCKED'].includes(state.retryIncident?.status);
 if(!shouldSupersede)return {decision:'allow',superseded:false,reason:'no supersedable retry state'};
 const incidentId=state.retryIncident?.id||null,previousStatus=state.status,previousReason=state.reason||'';
 if(state.retryIncident)setIncidentStatus(state,'SUPERSEDED',now,{supersededAt:now,supersededBy:'manual_invocation',invocationNum:Number.isInteger(payload?.invocationNum)?payload.invocationNum:null,previousStatus,previousReason});
 state.status='IDLE';state.reason='manual AGY invocation superseded previous retry state';state.nextRetryAt=null;state.retryKind='';state.retryLabel='';state.errorFingerprint='';if(state.scheduler)setSchedulerStatus(state,'SUPERSEDED',now,{nextRetryAt:null,completedAt:now});saveNative(root,state);
 return {decision:'allow',superseded:true,recovered:previousStatus==='PAUSED_UNCERTAIN'&&!incidentId,reason:state.reason,incidentId,previousStatus};
}


async function waitUntil(root,id,at,{now=Date.now,sleep=(ms)=>new Promise(r=>setTimeout(r,ms)),expectedIncidentId,requireCurrentIncident=true}={}){
 for(;;){const s=loadNative(root,id);if(!s||!WAITING.has(s.status)||s.nextRetryAt!==at||!incidentMatches(s,expectedIncidentId,{requireCurrent:requireCurrentIncident,statuses:new Set(['WAITING'])}))return false;const tick=now();heartbeatScheduler(root,s,tick);const left=at-tick;if(left<=0)return true;await sleep(Math.min(left,30000));}
}

async function oneTurn(state,{adapter=startSession,message=state.message||DEFAULT_RESUME_MESSAGE,conversation=state.conversationId,env={AGY_RETRY_NATIVE_WORKER:'1'},beforeSend}={}){
 const session=adapter({executable:state.config?.executable||'agy',prefixArgs:state.config?.prefixArgs||[],cwd:state.cwd||process.cwd(),conversation,model:state.model||undefined,watchdogMs:state.config?.watchdogMs||defaults.watchdogMs,env});
 let init=false,result=null,protocol='',newConversation='';
 try{
  for await(const e of session.events()){
   if(e.event==='protocol_error'){protocol=e.reason;break;}
   if(e.event==='init'){
    if(conversation&&e.conversation_id!==conversation){protocol='conversation mismatch';break;}
    if(state.cwd&&e.init?.cwd){try{if(fs.realpathSync(e.init.cwd)!==fs.realpathSync(state.cwd)){protocol='workspace mismatch';break;}}catch{protocol='workspace mismatch';break;}}
    init=true;newConversation=e.conversation_id;if(beforeSend)await beforeSend();await session.send(message);
   }
   if(e.event==='result'){result=e.result;break;}
  }
 }finally{if(protocol)await session.abort();else await session.close();}
 if(protocol||!init||!result)throw Error(protocol||'native retry produced no terminal result');return {result,newConversation};
}
async function refreshWeeklyIfNeeded(root,s,now,quotaProviderFactory){
 const ctl=loadControlConfig(),gate=weeklyGate(s,now,ctl.retry);if(!['unknown','stale'].includes(gate.status))return gate;
 // Only quota retries require a mandatory weekly pre-dispatch check. Transient API
 // retries may proceed when weekly telemetry is unavailable, but are still blocked
 // immediately if an exhausted weekly bucket is known.
 if(!['quota','long-quota'].includes(s.retryKind))return gate;
 const group=providerForModel(s.model)||'gemini',provider=quotaProviderFactory?quotaProviderFactory(s):new QuotaProvider({dir:path.join(root,'quota'),executable:s.config?.executable||'agy',prefixArgs:s.config?.prefixArgs||[],cwd:s.cwd});
 try{const snap=await provider.refresh({group,profile:'native'});s.snapshot={...(s.snapshot||{}),observedAt:snap.observedAt,quota:snap.buckets};saveNative(root,s);return weeklyGate(s,now,ctl.retry);}catch{return {status:'unknown'};}
}
function handoffReadyForRollover(s){
 return Boolean(s?.handoff?.id&&['READY','ROLLOVER_ARMED'].includes(s.handoff.status)&&s.handoff.rolloverArmed);
}
async function rolloverTurn(root,s,{adapter=startSession,beforeSend}={}){
 const h=loadHandoff({cwd:s.cwd,id:s.handoff.id}),wv=validateWorkspace(h.workspace,s.cwd);if(!wv.ok)throw Error('handoff workspace mismatch');
 const rel=path.relative(s.cwd,path.join(h.dir,'HANDOFF.md')).replaceAll('\\','/'),message=`${CONTINUE_PROMPT}\n\nRead and reconcile the handoff at ${rel}. Continue only after validating the current workspace.`;
 const {result,newConversation}=await oneTurn(s,{adapter,message,conversation:null,env:{AGY_RETRY_ROLLOVER_WORKER:'1',AGY_RETRY_NATIVE_WORKER:'1'},beforeSend});
 s.handoff.status='ROLLOVER';s.handoff.newConversationId=newConversation;s.handoff.rolledOverAt=Date.now();s.rolloverConversationId=newConversation;saveNative(root,s);return {result,newConversation};
}
export async function runNativeWorker(root,id,{now=Date.now,sleep,adapter=startSession,rng=()=>0,quotaProviderFactory,expectedIncidentId}={}){
 let lease;try{lease=acquire(path.join(root,'locks'),'native:'+id);}catch{return {status:'DUPLICATE_WORKER'};}
 try{
  for(;;){let s=loadNative(root,id);if(!s||TERMINAL.has(s.status)||s.status==='IDLE')return s||{status:'MISSING'};
   if(s.scheduler){const t=now();s.scheduler.workerPid=process.pid;s.scheduler.workerStartedAt=s.scheduler.workerStartedAt||t;s.scheduler.lastHeartbeatAt=t;if(WAITING.has(s.status))s.scheduler.status='WAITING';saveNative(root,s);}
   const ctl0=loadControlConfig(),requireCurrent=ctl0.retry.requireCurrentIncidentBeforeDispatch!==false;
   if(!incidentMatches(s,expectedIncidentId,{requireCurrent,statuses:new Set(['WAITING','ARMED'])}))return staleRetryResult();
   const incidentIdCurrent=s.retryIncident?.id||expectedIncidentId;
   if(!WAITING.has(s.status))return s;
   const due=s.nextRetryAt;if(!await waitUntil(root,id,due,{now,sleep,expectedIncidentId:incidentIdCurrent,requireCurrentIncident:requireCurrent}))continue;
   s=loadNative(root,id);if(!s||!WAITING.has(s.status))continue;
   if(!incidentMatches(s,incidentIdCurrent,{requireCurrent,statuses:new Set(['WAITING'])}))return staleRetryResult();
   setSchedulerStatus(s,'CHECKING',now(),{workerPid:process.pid});saveNative(root,s);
   const live=loadTelemetry(root,id);if(live){s.snapshot=live.snapshot;s.cwd=s.cwd||live.cwd;s.model=s.model||live.model;}
   const activeInstances=activeTerminalInstances(live,now());if(activeInstances.length>1){setIncidentStatus(s,'BLOCKED',now(),{blockedAt:now(),resolution:'multi_cli',terminalInstanceCount:activeInstances.length});s.status='MULTI_CLI';s.reason='conversation is active in multiple AGY CLI instances';s.nextRetryAt=null;setSchedulerStatus(s,'BLOCKED',now(),{nextRetryAt:null,completedAt:now()});saveNative(root,s);return s;}
   const ctl=loadControlConfig(),controls=applyControlState(root,s,ctl);if(!controls.retryEnabled){setIncidentStatus(s,'CANCELED',now(),{canceledAt:now(),resolution:'retry_policy_off'});s.status='RETRY_OFF';s.reason='automatic retry disabled before dispatch';s.nextRetryAt=null;setSchedulerStatus(s,'CANCELED',now(),{nextRetryAt:null,completedAt:now()});saveNative(root,s);return s;}
   let weekly=weeklyGate(s,now(),ctl.retry);if(['unknown','stale'].includes(weekly.status))weekly=await refreshWeeklyIfNeeded(root,s,now(),quotaProviderFactory);
   if(weekly.status==='blocked'){setIncidentStatus(s,'BLOCKED',now(),{blockedAt:now(),resolution:'weekly_quota'});s.status='WEEKLY_BLOCKED';s.reason='weekly quota at or below safety threshold';s.weeklyResetAt=weekly.bucket?.resetAt||null;s.nextRetryAt=null;setSchedulerStatus(s,'BLOCKED',now(),{nextRetryAt:null,completedAt:now()});saveNative(root,s);return s;}
   if(['quota','long-quota'].includes(s.retryKind)&&weekly.status==='unknown'){setIncidentStatus(s,'NEEDS_USER',now(),{resolution:'weekly_quota_unknown'});s.status='NEEDS_USER';s.reason='weekly quota unavailable before quota retry';s.nextRetryAt=null;setSchedulerStatus(s,'NEEDS_USER',now(),{nextRetryAt:null,completedAt:now()});saveNative(root,s);return s;}
   if(s.snapshot?.toolConfirmationPending){setIncidentStatus(s,'NEEDS_USER',now(),{resolution:'tool_confirmation_pending'});s.status='NEEDS_USER';s.reason='tool confirmation pending';setSchedulerStatus(s,'NEEDS_USER',now(),{nextRetryAt:null,completedAt:now()});saveNative(root,s);return s;}
   if((s.snapshot?.pendingInputCount||0)>0||(s.snapshot?.taskCount||0)>0||!['idle','unknown',undefined,null].includes(s.snapshot?.agentState)){
    setIncidentStatus(s,'SUPERSEDED',now(),{supersededAt:now(),supersededBy:'native_activity'});s.status='IDLE';s.reason='native AGY activity superseded pending retry';s.nextRetryAt=null;setSchedulerStatus(s,'SUPERSEDED',now(),{nextRetryAt:null,completedAt:now()});saveNative(root,s);return s;
   }
   if(now()-s.startedAt>=(s.config?.maxJobElapsedMs||defaults.maxJobElapsedMs)){setIncidentStatus(s,'EXHAUSTED',now(),{resolution:'job_budget_expired'});s.status='EXHAUSTED';s.reason='job budget expired';setSchedulerStatus(s,'EXHAUSTED',now(),{nextRetryAt:null,completedAt:now()});saveNative(root,s);return s;}
   // Re-read the state immediately before dispatch. A manual/new AGY invocation can
   // supersede the incident while the worker is waiting or checking quota.
   const latest=loadNative(root,id);if(!incidentMatches(latest,incidentIdCurrent,{requireCurrent,statuses:new Set(['WAITING'])}))return staleRetryResult();
   s=latest;const dispatchAt=now();setIncidentStatus(s,'DISPATCHING',dispatchAt,{dispatchStartedAt:dispatchAt});s.status='RUNNING';s.nextRetryAt=null;setSchedulerStatus(s,'DISPATCHING',dispatchAt,{workerPid:process.pid,nextRetryAt:null});saveNative(root,s);
   const beforeSend=async()=>{const current=loadNative(root,id);if(!incidentMatches(current,incidentIdCurrent,{requireCurrent,statuses:new Set(['DISPATCHING'])})){const e=Error('retry incident superseded before dispatch');e.code='STALE_RETRY';throw e;}setSchedulerStatus(current,'RUNNING',now(),{workerPid:process.pid});saveNative(root,current);};
   let turn;try{turn=handoffReadyForRollover(s)?await rolloverTurn(root,s,{adapter,beforeSend}):await oneTurn(s,{adapter,beforeSend});}catch(e){if(e?.code==='STALE_RETRY')return staleRetryResult(e.message);s.status='PAUSED_UNCERTAIN';setIncidentStatus(s,'PAUSED_UNCERTAIN',now(),{resolution:'uncertain_background_outcome'});s.reason='background AGY retry/rollover outcome uncertain';setSchedulerStatus(s,'UNCERTAIN',now(),{completedAt:now()});saveNative(root,s);return s; }
   const result=turn.result,c0=classify(result,now());if(c0.kind==='success'){const t=now();s.status='SUCCEEDED';setIncidentStatus(s,'SUCCEEDED',t,{completedAt:t,resolution:'background_retry_success'});s.reason=turn.newConversation?'rollover continuation completed':'background retry completed';setSchedulerStatus(s,'DONE',t,{completedAt:t});saveNative(root,s);return s;}
   if(c0.kind==='canceled'){const t=now();s.status='CANCELED';setIncidentStatus(s,'CANCELED',t,{canceledAt:t,resolution:'background_retry_canceled'});s.reason='background retry canceled';setSchedulerStatus(s,'CANCELED',t,{completedAt:t});saveNative(root,s);return s;}
   if(s.retryKind==='transient'||c0.kind==='transient')s.transientRetries=(s.transientRetries||0)+1;else if(['quota','long-quota'].includes(s.retryKind)||['quota','long-quota'].includes(c0.kind))s.quotaRetries=(s.quotaRetries||0)+1;
   const c=applyQuotaSnapshot(c0,s,now()),d=decide(c,s,now(),rng(s.config?.jitterMs||0),s.config||defaults);
   if(!d.action.startsWith('wait_')){const t=now(),terminal=d.action==='exhausted'?'EXHAUSTED':'NEEDS_USER';setIncidentStatus(s,terminal,t,{resolution:d.reason});s.status=terminal;s.reason=d.reason;setSchedulerStatus(s,terminal,t,{nextRetryAt:null,completedAt:t});saveNative(root,s);return s;}
   const waitAt=now();s.status=d.action==='wait_quota'?'WAIT_QUOTA':'WAIT_BACKOFF';s.retryKind=c.kind;s.retryLabel=retryLabelFor(c,result?.error);s.waitStartedAt=waitAt;s.nextRetryAt=d.at;s.reason=c.kind;setIncidentStatus(s,'WAITING',waitAt,{nextRetryAt:d.at,kind:c.kind,retryLabel:s.retryLabel,deadlineSource:deadlineSourceFor(c,'payload'),lastFailureFingerprint:fingerprint(result?.error?.message||result?.error||'')});const {attempt,max}=retryAttempt(s);setSchedulerStatus(s,'WAITING',waitAt,{workerPid:process.pid,nextRetryAt:d.at,deadlineSource:deadlineSourceFor(c,'payload'),retryLabel:s.retryLabel,attempt,maxAttempts:max});saveNative(root,s);
  }
 }finally{try{lease.release();}catch{}}
}

function safeHandoffPoint(snapshot={}){
 return !snapshot.toolConfirmationPending&&(snapshot.pendingInputCount||0)===0&&(snapshot.taskCount||0)===0&&['idle','unknown',undefined,null].includes(snapshot.agentState);
}
export function scheduleAutoHandoff(root,payload,{now=Date.now(),controlConfig,spawnWorker}={}){
 const id=payload?.conversation_id||payload?.session_id;if(!validConversation(id))return {scheduled:false,reason:'missing conversation id'};
 if(process.env.AGY_RETRY_HANDOFF_WORKER==='1'||process.env.AGY_RETRY_ROLLOVER_WORKER==='1')return {scheduled:false,reason:'nested worker'};
 const state=loadNative(root,id)||snapshotFromStatusline(payload,now),telemetry=loadTelemetry(root,id);if(telemetry){state.snapshot=telemetry.snapshot;state.cwd=state.cwd||telemetry.cwd;state.model=state.model||telemetry.model;}
 const ctl=controlConfig||loadControlConfig(),controls=applyControlState(root,state,ctl),pct=state.snapshot?.contextPercent;
 if(!controls.handoffEnabled){state.handoff={...(state.handoff||{}),status:'OFF',rolloverArmed:false};saveNative(root,state);return {scheduled:false,reason:'handoff disabled'};}
 if(!Number.isFinite(pct))return {scheduled:false,reason:'context unknown'};
 const h=state.handoff||{};
 if(pct<ctl.handoff.cancelRolloverBelow){
  if(h.rolloverArmed||['ROLLOVER_ARMED','PENDING','WARNING'].includes(h.status)){state.handoff={...h,status:h.id?'READY':null,rolloverArmed:false,canceledByCompactionAt:now};saveNative(root,state);}
  return {scheduled:false,reason:'context below rollover cancel threshold'};
 }
 if(pct>=80&&pct<ctl.handoff.snapshotAt&&!h.id){state.handoff={...h,status:'WARNING',contextPercent:pct};saveNative(root,state);return {scheduled:false,reason:'context warning'};}
 if(pct<ctl.handoff.snapshotAt)return {scheduled:false,reason:'below handoff snapshot threshold'};
 if(!safeHandoffPoint(state.snapshot)){state.handoff={...h,status:'PENDING',contextPercent:pct};saveNative(root,state);return {scheduled:false,reason:'waiting for safe handoff point'};}
 if(h.newConversationId)return {scheduled:false,reason:'rollover already created'};
 let needed=!h.id||(pct>=ctl.handoff.prepareAt&&h.quality!=='semantic')||(pct>=ctl.handoff.rolloverAt&&ctl.handoff.autoCreateNewSession&&!h.newConversationId);
 if(!needed)return {scheduled:false,reason:'handoff already ready'};
 if(h.status==='PREPARING'&&now-(h.workerRequestedAt||0)<30000)return {scheduled:false,reason:'handoff worker already requested'};
 state.handoff={...h,status:pct>=ctl.handoff.rolloverAt&&h.id?'ROLLOVER_ARMED':'PREPARING',rolloverArmed:pct>=ctl.handoff.rolloverAt,contextPercent:pct,workerRequestedAt:now};saveNative(root,state);spawnWorker?.(id);return {scheduled:true,state};
}
async function semanticHandoffTurn(state,{adapter=startSession}={}){
 const prompt=`${HANDOFF_PROMPT}\n\nReturn only the HANDOFF.md content. The handoff reason is context_rollover. Do not execute project changes while preparing this checkpoint.`;
 const {result}=await oneTurn(state,{adapter,message:prompt,conversation:state.conversationId,env:{AGY_RETRY_HANDOFF_WORKER:'1',AGY_RETRY_NATIVE_WORKER:'1'}});
 if(result.status!=='SUCCESS'||typeof result.response!=='string'||!result.response.trim())throw Error('semantic handoff generation failed');
 return result.response.trim();
}
export async function runHandoffWorker(root,id,{now=Date.now,adapter=startSession}={}){
 let lease;try{lease=acquire(path.join(root,'locks'),'handoff:'+id);}catch{return {status:'DUPLICATE_HANDOFF_WORKER'};}
 try{
  let s=loadNative(root,id);if(!s)return {status:'MISSING'};const live=loadTelemetry(root,id);if(live){s.snapshot=live.snapshot;s.cwd=s.cwd||live.cwd;s.model=s.model||live.model;}
  const ctl=loadControlConfig(),controls=applyControlState(root,s,ctl);if(!controls.handoffEnabled){s.handoff={...(s.handoff||{}),status:'OFF',rolloverArmed:false};saveNative(root,s);return s;}
  const pct=s.snapshot?.contextPercent;if(!Number.isFinite(pct)||pct<ctl.handoff.snapshotAt)return s;
  if(!safeHandoffPoint(s.snapshot)){s.handoff={...(s.handoff||{}),status:'PENDING',contextPercent:pct};saveNative(root,s);return s;}
  let h=s.handoff||{};
  if(!h.id){
   const created=createHandoff({cwd:s.cwd,conversationId:id,reason:'context_rollover',quality:'mechanical',checkpoint:s.lastCompletedStep||s.reason||''});
   h={id:created.handoffId,status:'READY',quality:'mechanical',createdAt:now(),contextPercent:pct,rolloverArmed:pct>=ctl.handoff.rolloverAt};s.handoff=h;saveNative(root,s);
  }
  const weekly=weeklyGate(s,now(),ctl.retry);
  if(pct>=ctl.handoff.prepareAt&&h.quality!=='semantic'&&ctl.handoff.semanticSummary&&weekly.status!=='blocked'){
   if(weekly.status==='healthy'||ctl.retry.stopWhenWeeklyExhausted===false){
    try{const text=await semanticHandoffTurn(s,{adapter});finalizeSemanticHandoff({cwd:s.cwd,id:h.id,text});h={...h,status:'READY',quality:'semantic',semanticAt:now()};s.handoff=h;saveNative(root,s);}catch{if(!ctl.handoff.mechanicalFallback){h.status='BLOCKED';h.reason='semantic handoff failed';s.handoff=h;saveNative(root,s);return s;}h={...h,status:'READY',quality:'mechanical',semanticError:true};s.handoff=h;saveNative(root,s);}
   }
  }
  if(pct>=ctl.handoff.rolloverAt){h={...h,status:'ROLLOVER_ARMED',rolloverArmed:true};s.handoff=h;saveNative(root,s);
   if(ctl.handoff.autoCreateNewSession&&weekly.status==='healthy'&&!h.newConversationId){
    try{const turn=await rolloverTurn(root,s,{adapter});const c=classify(turn.result,now());if(c.kind==='success'){s.status='SUCCEEDED';s.reason='context rollover continuation completed';}else{s.status='PAUSED_UNCERTAIN';s.reason='new-session rollover did not complete successfully';}saveNative(root,s);}catch{s.handoff={...s.handoff,status:'BLOCKED'};s.reason='automatic rollover outcome uncertain';s.status='PAUSED_UNCERTAIN';saveNative(root,s);}
   }
  }else{s.handoff={...h,status:'READY',rolloverArmed:false};saveNative(root,s);}
  return s;
 }finally{try{lease.release();}catch{}}
}
export function spawnDetachedHandoffWorker(script,id,root){
 const child=spawn(process.execPath,[script,'handoff-worker','--conversation',id,'--state-root',root],{detached:true,stdio:'ignore',windowsHide:true,env:{...process.env,AGY_RETRY_HANDOFF_WORKER:'1'}});child.unref();return child.pid;
}
export function spawnDetachedWorker(script,id,root,incidentId){
 const args=[script,'worker','--conversation',id,'--state-root',root];if(incidentId)args.push('--incident',incidentId);const child=spawn(process.execPath,args,{detached:true,stdio:'ignore',windowsHide:true,env:{...process.env,AGY_RETRY_NATIVE_WORKER:'1'}});child.unref();return child.pid;
}
