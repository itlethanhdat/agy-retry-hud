import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {atomicJSON} from './state.js';

export const CONTROL_SCHEMA_VERSION=1;
export const DEFAULT_CONTROL_CONFIG=Object.freeze({
 hud:{enabled:true,visible:true,color:true,compact:true,multiline:true,showProgressBar:true,showPlan:true,showBranch:true,showCwd:true,showTokens:false,showAgentState:true,showRetry:true,showHandoff:true,barWidth:10},
 retry:{enabled:true,stopWhenWeeklyExhausted:true,weeklyRemainingThreshold:0.01,autoDisarmIncidentOnSuccess:true,requireCurrentIncidentBeforeDispatch:true,quotaFallbackMs:18000000,resetMarginMs:90000,jitterMs:30000,transientBaseMs:60000,transientCapMs:900000,maxTransientRetries:6,maxQuotaRetries:2,maxJobElapsedMs:86400000,watchdogMs:3600000},
 handoff:{enabled:true,snapshotAt:85,prepareAt:90,rolloverAt:95,cancelRolloverBelow:80,autoCreateNewSession:true,semanticSummary:true,mechanicalFallback:true},
 daemon:{enabled:true,autoStart:true,heartbeatMs:5000,idlePollMs:10000,waitQuotaPollMs:30000,waitBackoffPollMs:5000,nearDeadlineMs:60000,nearDeadlinePollMs:1000,activePollMs:500,maxConcurrentDispatch:1}
});

function clone(v){return JSON.parse(JSON.stringify(v));}
function mergeSection(base,raw,key){return {...base,...(raw&&typeof raw[key]==='object'&&!Array.isArray(raw[key])?raw[key]:{})};}
export function controlConfigPath({platform=process.platform,home=os.homedir(),env=process.env}={}){
 if(env.AGY_RETRY_HUD_CONFIG)return path.resolve(env.AGY_RETRY_HUD_CONFIG);
 if(platform==='win32')return path.join(env.APPDATA||path.join(home,'AppData','Roaming'),'agy-retry-hud','config.json');
 return path.join(env.XDG_CONFIG_HOME||path.join(home,'.config'),'agy-retry-hud','config.json');
}
export function validateControlConfig(input){
 const c=clone(input||{}),r=c.retry,h=c.handoff,u=c.hud,d=c.daemon;
 if(!r||typeof r!=='object'||typeof r.enabled!=='boolean'||typeof r.stopWhenWeeklyExhausted!=='boolean'||typeof r.autoDisarmIncidentOnSuccess!=='boolean'||typeof r.requireCurrentIncidentBeforeDispatch!=='boolean')throw Error('invalid retry config');
 if(typeof r.weeklyRemainingThreshold!=='number'||r.weeklyRemainingThreshold<0||r.weeklyRemainingThreshold>1)throw Error('invalid weeklyRemainingThreshold');
 for(const k of ['quotaFallbackMs','resetMarginMs','jitterMs','transientBaseMs','transientCapMs','maxTransientRetries','maxQuotaRetries','maxJobElapsedMs','watchdogMs'])if(!Number.isFinite(r[k])||r[k]<0)throw Error('invalid retry config value: '+k);
 if(!h||typeof h!=='object'||typeof h.enabled!=='boolean')throw Error('invalid handoff config');
 for(const k of ['snapshotAt','prepareAt','rolloverAt','cancelRolloverBelow'])if(!Number.isFinite(h[k])||h[k]<0||h[k]>100)throw Error('invalid handoff threshold: '+k);
 if(!(h.cancelRolloverBelow<h.snapshotAt&&h.snapshotAt<=h.prepareAt&&h.prepareAt<=h.rolloverAt))throw Error('handoff thresholds must satisfy cancel < snapshot <= prepare <= rollover');
 for(const k of ['autoCreateNewSession','semanticSummary','mechanicalFallback'])if(typeof h[k]!=='boolean')throw Error('invalid handoff flag: '+k);
 if(!u||typeof u!=='object'||typeof u.enabled!=='boolean'||typeof u.visible!=='boolean')throw Error('invalid hud config');
 if(!d||typeof d!=='object'||typeof d.enabled!=='boolean'||typeof d.autoStart!=='boolean')throw Error('invalid daemon config');
 for(const k of ['heartbeatMs','idlePollMs','waitQuotaPollMs','waitBackoffPollMs','nearDeadlineMs','nearDeadlinePollMs','activePollMs','maxConcurrentDispatch'])if(!Number.isFinite(d[k])||d[k]<0)throw Error('invalid daemon config value: '+k);
 if(d.maxConcurrentDispatch<1)throw Error('maxConcurrentDispatch must be >= 1');
 return c;
}
export function loadControlConfig({file=controlConfigPath(),env=process.env}={}){
 let raw={};try{raw=JSON.parse(fs.readFileSync(file,'utf8'));if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('config must be an object');}catch(e){if(e.code!=='ENOENT')throw e;}
 // Backward-compatible flat HUD keys from v0.3.x.
 const hudRaw={...(raw.hud||{})};
 const flatMap={color:'color',multiline:'multiline',show_progress_bar:'showProgressBar',show_plan:'showPlan',show_branch:'showBranch',show_cwd:'showCwd',show_tokens:'showTokens',show_agent_state:'showAgentState',show_retry:'showRetry',bar_width:'barWidth'};
 for(const [oldKey,newKey] of Object.entries(flatMap))if(oldKey in raw&&!(newKey in hudRaw))hudRaw[newKey]=raw[oldKey];
 const c={hud:{...DEFAULT_CONTROL_CONFIG.hud,...hudRaw},retry:mergeSection(DEFAULT_CONTROL_CONFIG.retry,raw,'retry'),handoff:mergeSection(DEFAULT_CONTROL_CONFIG.handoff,raw,'handoff'),daemon:mergeSection(DEFAULT_CONTROL_CONFIG.daemon,raw,'daemon')};
 if(env.NO_COLOR!==undefined||env.TERM==='dumb')c.hud.color=false;
 return validateControlConfig(c);
}
export function saveControlConfig(config,{file=controlConfigPath()}={}){validateControlConfig(config);atomicJSON(file,config);return file;}

function overrideFile(root){return path.join(root,'controls.json');}
export function loadControlState(root){
 try{const x=JSON.parse(fs.readFileSync(overrideFile(root),'utf8'));if(x?.schemaVersion!==CONTROL_SCHEMA_VERSION)throw Error('unsupported control state');return {schemaVersion:1,retryOverrides:x.retryOverrides||{},handoffOverrides:x.handoffOverrides||{},updatedAt:x.updatedAt||0};}
 catch(e){if(e.code==='ENOENT')return {schemaVersion:1,retryOverrides:{},handoffOverrides:{},updatedAt:0};throw e;}
}
export function saveControlState(root,state){state={schemaVersion:1,retryOverrides:state.retryOverrides||{},handoffOverrides:state.handoffOverrides||{},updatedAt:Date.now()};atomicJSON(overrideFile(root),state);return state;}
export function normalizeOverride(v){if(!['inherit','on','off'].includes(v))throw Error('override must be inherit, on, or off');return v;}
export function effectiveFlag(globalEnabled,override='inherit'){override=normalizeOverride(override);return override==='on'?true:override==='off'?false:Boolean(globalEnabled);}
export function setConversationOverride(root,kind,conversationId,value){normalizeOverride(value);if(!conversationId)throw Error('conversation id required');const state=loadControlState(root),map=kind==='retry'?state.retryOverrides:kind==='handoff'?state.handoffOverrides:null;if(!map)throw Error('invalid override kind');if(value==='inherit')delete map[conversationId];else map[conversationId]=value;return saveControlState(root,state);}
export function getConversationOverride(root,kind,conversationId){const state=loadControlState(root),map=kind==='retry'?state.retryOverrides:kind==='handoff'?state.handoffOverrides:null;if(!map)throw Error('invalid override kind');return map[conversationId]||'inherit';}
export function effectiveControls(root,conversationId,{config=loadControlConfig()}={}){const state=loadControlState(root),retryOverride=state.retryOverrides[conversationId]||'inherit',handoffOverride=state.handoffOverrides[conversationId]||'inherit';return {config,retryOverride,handoffOverride,retryEnabled:effectiveFlag(config.retry.enabled,retryOverride),handoffEnabled:effectiveFlag(config.handoff.enabled,handoffOverride)};}

export function updateGlobal(rootKind,value,{file=controlConfigPath()}={}){if(!['retry','handoff'].includes(rootKind))throw Error('invalid control kind');if(typeof value!=='boolean')throw Error('boolean required');const c=loadControlConfig({file});c[rootKind].enabled=value;saveControlConfig(c,{file});return c;}

export function setHudMode(mode,{file=controlConfigPath()}={}){if(!['on','hide','off'].includes(mode))throw Error('hud mode must be on, hide, or off');const c=loadControlConfig({file});if(mode==='on'){c.hud.enabled=true;c.hud.visible=true;c.daemon.enabled=true;c.daemon.autoStart=true;c.retry.enabled=true;c.handoff.enabled=true;}else if(mode==='hide'){c.hud.enabled=true;c.hud.visible=false;}else{c.hud.enabled=false;c.hud.visible=false;c.daemon.enabled=false;c.daemon.autoStart=false;c.retry.enabled=false;c.handoff.enabled=false;}saveControlConfig(c,{file});return c;}
export function setDaemonEnabled(enabled,{file=controlConfigPath(),autoStart=enabled}={}){if(typeof enabled!=='boolean')throw Error('boolean required');const c=loadControlConfig({file});c.daemon.enabled=enabled;c.daemon.autoStart=Boolean(autoStart);saveControlConfig(c,{file});return c;}
