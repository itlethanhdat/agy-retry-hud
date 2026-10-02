import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {mergeStatusline,scheduleFromStop,loadNative} from '../src/native.js';
import {resolveConversationInfo} from '../src/retryctl.js';
function temp(p='agy-ctl-'){return fs.mkdtempSync(path.join(os.tmpdir(),p));}const conv='12345678-abcd-ef01-2345-6789abcdef01';
test('agy-retryctl controls current workspace session and creates/list handoffs deterministically',()=>{const base=temp(),root=path.join(base,'state'),cwd=path.join(base,'project'),config=path.join(base,'config.json');fs.mkdirSync(cwd,{recursive:true});mergeStatusline(root,{conversation_id:conv,cwd,workspace:{current_dir:cwd},model:{id:'gemini-test'},context_window:{used_percentage:20},quota:{},agent_state:'idle',pending_input_count:0,tool_confirmation_pending:false,terminal_width:100},Date.now());const cli=path.resolve('src/retryctl.js'),env={...process.env,AGY_RETRY_STATE_DIR:path.dirname(root),AGY_RETRY_HUD_CONFIG:config};let r=spawnSync(process.execPath,[cli,'retry','off','--config',config],{cwd,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);r=spawnSync(process.execPath,[cli,'retry','session','on','--state-root',root,'--config',config,'--json'],{cwd,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).effective,true);r=spawnSync(process.execPath,[cli,'handoff','create','--state-root',root,'--config',config,'--json'],{cwd,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);const h=JSON.parse(r.stdout);assert.ok(h.handoffId);r=spawnSync(process.execPath,[cli,'handoff','list','--state-root',root,'--json'],{cwd,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout)[0].id,h.handoffId);});

test('agy-retryctl exposes setup status and repair control plane',()=>{
 const home=temp('agy-ctl-home-'),pluginDir=path.join(home,'.gemini','config','plugins','agy-retry-hud'),env={...process.env,HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_STATE_HOME:path.join(home,'.state')};
 fs.mkdirSync(path.dirname(pluginDir),{recursive:true});fs.cpSync(path.resolve('plugin/agy-retry-hud'),pluginDir,{recursive:true});
 const cli=path.resolve('src/retryctl.js');let r=spawnSync(process.execPath,[cli,'setup','status','--json'],{env,encoding:'utf8'});assert.equal(r.status,4);let out=JSON.parse(r.stdout);assert.equal(out.installed,true);assert.equal(out.skills.setup,true);
 r=spawnSync(process.execPath,[cli,'setup','repair','--json'],{env,encoding:'utf8'});out=JSON.parse(r.stdout);assert.equal(out.doctor.statuslineWired,true);assert.equal(out.doctor.hooksReady,true);assert.equal(out.doctor.skillsReady,true);
});


test('terminal binding resolves the exact conversation before workspace-latest fallback',()=>{
 const root=temp('agy-bind-'),cwd=temp('agy-bind-project-'),convB='abcdef12-3456-7890-abcd-ef1234567890',base={cwd,workspace:{current_dir:cwd},model:{id:'gemini-test'},context_window:{used_percentage:20},quota:{},agent_state:'idle',pending_input_count:0,tool_confirmation_pending:false,terminal_width:100};
 mergeStatusline(root,{...base,conversation_id:conv},1000,{env:{TMUX_PANE:'%1'}});mergeStatusline(root,{...base,conversation_id:convB},2000,{env:{TMUX_PANE:'%2'}});
 const exact=resolveConversationInfo(root,{cwd,env:{TMUX_PANE:'%1'},now:2500});assert.equal(exact.conversationId,conv);assert.equal(exact.resolution,'terminal');
 const fallback=resolveConversationInfo(root,{cwd,env:{},now:2500});assert.equal(fallback.conversationId,convB);assert.equal(fallback.resolution,'workspace-latest');
});

test('agy-retryctl retry clear supersedes the current incident without disabling retry',()=>{
 const base=temp(),root=path.join(base,'state'),cwd=path.join(base,'project'),config=path.join(base,'config.json'),now=Date.now();fs.mkdirSync(cwd,{recursive:true});const p={conversation_id:conv,cwd,workspace:{current_dir:cwd},model:{id:'gemini-test'},context_window:{used_percentage:20},quota:{},agent_state:'idle',pending_input_count:0,tool_confirmation_pending:false,terminal_width:100};mergeStatusline(root,p,now,{env:{TMUX_PANE:'%1'}});scheduleFromStop(root,{executionNum:1,terminationReason:'error',error:'503 service unavailable',fullyIdle:true,conversationId:conv,workspacePaths:[cwd]},{now,config:{transientBaseMs:1000,transientCapMs:1000,jitterMs:0}});assert.equal(loadNative(root,conv).status,'WAIT_BACKOFF');
 const cli=path.resolve('src/retryctl.js'),env={...process.env,TMUX_PANE:'%1',AGY_RETRY_STATE_DIR:path.dirname(root),AGY_RETRY_HUD_CONFIG:config};let r=spawnSync(process.execPath,[cli,'retry','clear','--state-root',root,'--config',config,'--json'],{cwd,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);const out=JSON.parse(r.stdout);assert.equal(out.status,'IDLE');assert.equal(out.incidentStatus,'SUPERSEDED');assert.equal(out.conversationResolution,'terminal');const state=loadNative(root,conv);assert.equal(state.status,'IDLE');assert.equal(state.nextRetryAt,null);
 r=spawnSync(process.execPath,[cli,'retry','status','--state-root',root,'--config',config,'--json'],{cwd,env,encoding:'utf8'});const status=JSON.parse(r.stdout);assert.equal(status.effective,true);assert.equal(status.conversationResolution,'terminal');
});


test('agy-retryctl retry scheduler reports countdown, reason, attempt and scheduler health',()=>{
 const base=temp('agy-scheduler-'),root=path.join(base,'state'),cwd=path.join(base,'project'),config=path.join(base,'config.json'),now=Date.now();fs.mkdirSync(cwd,{recursive:true});
 const p={conversation_id:conv,cwd,workspace:{current_dir:cwd},model:{id:'gemini-test'},context_window:{used_percentage:20},quota:{},agent_state:'idle',pending_input_count:0,tool_confirmation_pending:false,terminal_width:120};mergeStatusline(root,p,now,{env:{TMUX_PANE:'%7'}});
 scheduleFromStop(root,{executionNum:1,terminationReason:'error',error:'503 service unavailable',fullyIdle:true,conversationId:conv,workspacePaths:[cwd]},{now,config:{transientBaseMs:60_000,transientCapMs:900_000,jitterMs:0,maxTransientRetries:6},spawnWorker:()=>process.pid});
 const cli=path.resolve('src/retryctl.js'),env={...process.env,TMUX_PANE:'%7',AGY_RETRY_STATE_DIR:path.dirname(root),AGY_RETRY_HUD_CONFIG:config};let r=spawnSync(process.execPath,[cli,'retry','scheduler','--state-root',root,'--config',config,'--json'],{cwd,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);const out=JSON.parse(r.stdout);assert.equal(out.conversationResolution,'terminal');assert.equal(out.nativeStatus,'WAIT_BACKOFF');assert.equal(out.scheduler.status,'OK');assert.equal(out.scheduler.retryLabel,'503');assert.equal(out.scheduler.attempt,1);assert.equal(out.scheduler.maxAttempts,6);assert.equal(out.scheduler.deadlineSource,'backoff');assert.equal(out.scheduler.workerAlive,true);assert.ok(out.scheduler.remainingMs>0);
 r=spawnSync(process.execPath,[cli,'retry','status','--state-root',root,'--config',config,'--json'],{cwd,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);const status=JSON.parse(r.stdout);assert.equal(status.scheduler.status,'OK');assert.equal(status.scheduler.retryLabel,'503');
});


test('agy-retryctl HUD modes are local deterministic controls and hide preserves retry',()=>{
 const base=temp('agy-hudctl-'),root=path.join(base,'state'),config=path.join(base,'config.json'),cli=path.resolve('src/retryctl.js'),env={...process.env,AGY_RETRY_SKIP_DAEMON:'1',AGY_RETRY_HUD_CONFIG:config};
 let r=spawnSync(process.execPath,[cli,'hud','hide','--state-root',root,'--config',config,'--json'],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);let out=JSON.parse(r.stdout);assert.equal(out.mode,'hide');assert.equal(out.hud.visible,false);assert.equal(out.retryEnabled,true);
 r=spawnSync(process.execPath,[cli,'hud','off','--state-root',root,'--config',config,'--json'],{env,encoding:'utf8'});out=JSON.parse(r.stdout);assert.equal(out.hud.enabled,false);assert.equal(out.retryEnabled,false);
 r=spawnSync(process.execPath,[cli,'hud','on','--state-root',root,'--config',config,'--json'],{env,encoding:'utf8'});out=JSON.parse(r.stdout);assert.equal(out.hud.visible,true);assert.equal(out.retryEnabled,true);
 r=spawnSync(process.execPath,[cli,'daemon','disable','--state-root',root,'--config',config,'--json'],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).enabled,false);
});
