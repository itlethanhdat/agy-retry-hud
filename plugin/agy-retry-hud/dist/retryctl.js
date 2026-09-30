#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {nativeRoot,loadNative} from './native.js';
import {loadControlConfig,saveControlConfig,controlConfigPath,setConversationOverride,getConversationOverride,effectiveControls,updateGlobal} from './control.js';
import {createHandoff,finalizeSemanticHandoff,listHandoffs,loadHandoff,exportHandoff,importHandoff,inspectPortable,validateWorkspace,handoffSummary,markConsumed} from './handoff.js';
import {setupDoctor,repairSetup} from './setup.js';

const HELP=`agy-retryctl v0.4.5
  agy-retryctl setup status
  agy-retryctl setup repair [--force-statusline]
  agy-retryctl retry on|off|status
  agy-retryctl retry session on|off|inherit [--conversation ID]
  agy-retryctl handoff on|off|status
  agy-retryctl handoff session on|off|inherit [--conversation ID]
  agy-retryctl handoff create [--conversation ID] [--portable] [--include-untracked FILE ...] [--json]
  agy-retryctl handoff semantic ID --file FILE
  agy-retryctl handoff list [--json]
  agy-retryctl handoff show ID [--json]
  agy-retryctl handoff export ID [--output FILE]
  agy-retryctl handoff import FILE [--json]
  agy-retryctl handoff validate ID|FILE [--json]
  agy-retryctl handoff continue ID|FILE [--json]
Options: --cwd PATH --conversation ID --state-root PATH --config PATH --portable --include-untracked FILE --json --output FILE --file FILE --force-statusline
`;
function err(m){throw Error(m);}
function readTelemetry(root){const dir=path.join(root,'telemetry');let files=[];try{files=fs.readdirSync(dir);}catch(e){if(e.code==='ENOENT')return [];throw e;}return files.map(f=>{try{return JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));}catch{return null;}}).filter(Boolean);}
function samePath(a,b){try{return fs.realpathSync(a)===fs.realpathSync(b);}catch{return path.resolve(a)===path.resolve(b);}}
export function resolveConversation(root,{conversation,cwd=process.cwd()}={}){if(conversation)return conversation;const rows=readTelemetry(root).filter(x=>x.conversationId&&x.cwd&&samePath(x.cwd,cwd)).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));if(!rows.length)throw Error('no active/recent AGY conversation found for this workspace; pass --conversation');return rows[0].conversationId;}
function asBool(s){if(s==='on')return true;if(s==='off')return false;err('expected on or off');}
function output(v,json){process.stdout.write(json?JSON.stringify(v,null,2)+'\n':typeof v==='string'?v+'\n':JSON.stringify(v,null,2)+'\n');}
async function main(argv=process.argv.slice(2)){
 const {values:v,positionals:p}=parseArgs({args:argv,allowPositionals:true,options:{cwd:{type:'string'},conversation:{type:'string'},'state-root':{type:'string'},config:{type:'string'},portable:{type:'boolean'},'include-untracked':{type:'string',multiple:true},json:{type:'boolean'},output:{type:'string'},file:{type:'string'},'force-statusline':{type:'boolean'},help:{type:'boolean'}}});
 if(v.help||!p.length){process.stdout.write(HELP);return 0;}const cwd=path.resolve(v.cwd||process.cwd()),root=path.resolve(v['state-root']||nativeRoot()),cfgFile=v.config?path.resolve(v.config):controlConfigPath();const [group,action,arg1,...rest]=p;
 if(group==='setup'){
  if(action==='status'||action==='doctor'){const out=setupDoctor();output(out,v.json);return out.ok?0:4;}
  if(action==='repair'){const out=repairSetup({force:Boolean(v['force-statusline'])});output(out,v.json);return out.doctor.ok?0:4;}
  err('usage: setup status | setup repair [--force-statusline]');
 }
 if(group==='retry'){
  if(action==='on'||action==='off'){const c=updateGlobal('retry',asBool(action),{file:cfgFile});output({retry:c.retry.enabled},v.json);return 0;}
  if(action==='status'){let id;try{id=resolveConversation(root,{conversation:v.conversation,cwd});}catch{}const config=loadControlConfig({file:cfgFile}),data=id?effectiveControls(root,id,{config}):{config,retryOverride:'inherit',retryEnabled:config.retry.enabled},native=id?loadNative(root,id):null,incident=native?.retryIncident||null;output({conversationId:id||null,global:config.retry.enabled,override:data.retryOverride,effective:data.retryEnabled,weeklyThreshold:config.retry.weeklyRemainingThreshold,incident:incident?{id:incident.id,status:incident.status,kind:incident.kind||null,createdAt:incident.createdAt||null,updatedAt:incident.updatedAt||null}:null,nativeStatus:native?.status||null,reason:native?.reason||null,nextRetryAt:native?.nextRetryAt||null},v.json);return 0;}
  if(action==='session'){if(!['on','off','inherit'].includes(arg1))err('usage: retry session on|off|inherit');const id=resolveConversation(root,{conversation:v.conversation,cwd});setConversationOverride(root,'retry',id,arg1);const config=loadControlConfig({file:cfgFile}),data=effectiveControls(root,id,{config});output({conversationId:id,override:arg1,effective:data.retryEnabled},v.json);return 0;}
  err('unknown retry command');
 }
 if(group!=='handoff')err('unknown command group');
 if(action==='on'||action==='off'){const c=updateGlobal('handoff',asBool(action),{file:cfgFile});output({handoff:c.handoff.enabled},v.json);return 0;}
 if(action==='session'){if(!['on','off','inherit'].includes(arg1))err('usage: handoff session on|off|inherit');const id=resolveConversation(root,{conversation:v.conversation,cwd});setConversationOverride(root,'handoff',id,arg1);const config=loadControlConfig({file:cfgFile}),data=effectiveControls(root,id,{config});output({conversationId:id,override:arg1,effective:data.handoffEnabled},v.json);return 0;}
 if(action==='status'){let id;try{id=resolveConversation(root,{conversation:v.conversation,cwd});}catch{}const config=loadControlConfig({file:cfgFile}),controls=id?effectiveControls(root,id,{config}):{handoffOverride:'inherit',handoffEnabled:config.handoff.enabled};const items=listHandoffs({cwd});output({conversationId:id||null,global:config.handoff.enabled,override:controls.handoffOverride,effective:controls.handoffEnabled,count:items.length,latest:items[0]||null},v.json);return 0;}
 if(action==='create'){let id='';try{id=resolveConversation(root,{conversation:v.conversation,cwd});}catch{}const native=id?loadNative(root,id):null,reason='manual';const h=createHandoff({cwd,conversationId:id,reason,checkpoint:native?.lastCompletedStep||native?.reason||'',portable:Boolean(v.portable),output:v.output,includeUntracked:v['include-untracked']||[]});output(h,v.json);return 0;}
 if(action==='semantic'){const id=arg1;if(!id||!v.file)err('usage: handoff semantic ID --file FILE');const text=fs.readFileSync(path.resolve(v.file),'utf8');output(finalizeSemanticHandoff({cwd,id,text}),v.json);return 0;}
 if(action==='list'){output(listHandoffs({cwd}),v.json);return 0;}
 if(action==='show'){if(!arg1)err('handoff id required');const h=loadHandoff({cwd,id:arg1});output(v.json?{manifest:h.manifest,state:h.state,workspace:h.workspace,handoff:h.handoff,continuePrompt:h.continuePrompt}:h.handoff,false);return 0;}
 if(action==='export'){if(!arg1)err('handoff id required');const file=exportHandoff({cwd,id:arg1,output:v.output});output({file},v.json);return 0;}
 if(action==='import'){if(!arg1)err('portable .agyh path required');const out=importHandoff({cwd,file:path.resolve(arg1)});output(out,v.json);return out.workspaceValidation.ok?0:4;}
 if(action==='validate'){if(!arg1)err('handoff id or file required');let out;if(arg1.endsWith('.agyh')||fs.existsSync(path.resolve(arg1))){const p=inspectPortable(path.resolve(arg1));out={valid:true,manifest:p.manifest,workspaceValidation:validateWorkspace(p.workspace,cwd)};}else out={valid:true,...handoffSummary({cwd,id:arg1})};output(out,v.json);return out.workspaceValidation?.ok===false?4:0;}
 if(action==='continue'){if(!arg1)err('handoff id or file required');let id=arg1;if(arg1.endsWith('.agyh')||fs.existsSync(path.resolve(arg1))){const imp=importHandoff({cwd,file:path.resolve(arg1)});if(!imp.workspaceValidation.ok){output(imp,v.json);return 4;}id=imp.id;}const h=loadHandoff({cwd,id}),validation=validateWorkspace(h.workspace,cwd);if(!validation.ok){output({id,workspaceValidation:validation},v.json);return 4;}let conversationId=null;try{conversationId=resolveConversation(root,{conversation:v.conversation,cwd});}catch{}markConsumed({cwd,id,conversationId});const result={id,dir:h.dir,workspaceValidation:validation,continuePrompt:h.continuePrompt,handoff:h.handoff};output(v.json?result:`${h.continuePrompt.trim()}\n\nHANDOFF FILE: ${path.relative(cwd,path.join(h.dir,'HANDOFF.md'))}\n\n${h.handoff}`,v.json);return 0;}
 err('unknown handoff command');
}
if(import.meta.url===`file://${process.argv[1]}`||process.argv[1]?.endsWith('/retryctl.js')||process.argv[1]?.endsWith('\\retryctl.js'))main().then(c=>{process.exitCode=c;}).catch(e=>{process.stderr.write((e?.message||String(e))+'\n');process.exitCode=2;});
export {main};
