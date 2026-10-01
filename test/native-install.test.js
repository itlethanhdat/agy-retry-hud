import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {install,uninstall,doctor} from '../scripts/install-native.js';
function temp(){return fs.mkdtempSync(path.join(os.tmpdir(),'agy-install-'));}

test('native installer stages plugin, wires statusline and restores prior setting on uninstall',()=>{
 const home=temp(),settings=path.join(home,'.gemini','antigravity-cli','settings.json');fs.mkdirSync(path.dirname(settings),{recursive:true});
 fs.writeFileSync(settings,JSON.stringify({theme:'dark',statusLine:{type:'command',command:'old-hud',enabled:true}}));
 assert.throws(()=>install({home}),/custom statusLine/);
 const r=install({home,forceStatusline:true});assert.ok(fs.existsSync(path.join(r.pluginDir,'plugin.json')));assert.ok(fs.existsSync(path.join(r.pluginDir,'dist','native-entry.js')));
 const after=JSON.parse(fs.readFileSync(settings));assert.equal(after.theme,'dark');assert.match(after.statusLine.command,/agy-retry-hud/);const hooks=JSON.parse(fs.readFileSync(path.join(r.pluginDir,'hooks.json')));const hookCommand=hooks['agy-retry-auto-retry'].Stop[0].command;assert.ok(hookCommand.includes('native-entry.js\" stop-hook')||hookCommand.includes('native-entry.js stop-hook'));assert.ok(hookCommand.includes(r.pluginDir));assert.doesNotMatch(hookCommand,/__AGY_RETRY_PLUGIN_DIR__/);const d=doctor({home});assert.equal(d.plugin,true);assert.equal(d.entry,true);assert.equal(d.hooks,true);assert.equal(d.statuslineWired,true);assert.equal(d.ok,d.nodeOk);
 const u=uninstall({home});assert.equal(u.removed,true);const restored=JSON.parse(fs.readFileSync(settings));assert.equal(restored.statusLine.command,'old-hud');assert.equal(restored.theme,'dark');assert.equal(fs.existsSync(r.pluginDir),false);
});

test('installer can wire a fresh profile without deleting unrelated settings',()=>{
 const home=temp(),settings=path.join(home,'.gemini','antigravity-cli','settings.json');fs.mkdirSync(path.dirname(settings),{recursive:true});fs.writeFileSync(settings,JSON.stringify({permissions:{mode:'request-review'}}));
 install({home});const s=JSON.parse(fs.readFileSync(settings));assert.deepEqual(s.permissions,{mode:'request-review'});assert.match(s.statusLine.command,/native-entry\.js.*statusline/);
 uninstall({home});const s2=JSON.parse(fs.readFileSync(settings));assert.deepEqual(s2.permissions,{mode:'request-review'});assert.equal('statusLine' in s2,false);
});

test('release plugin hooks.json is directly installable without placeholder rewriting',()=>{
 const hookFile=path.resolve('plugin/agy-retry-hud/hooks.json');
 const hooks=JSON.parse(fs.readFileSync(hookFile,'utf8'));
 const command=hooks['agy-retry-auto-retry'].Stop[0].command,preCommand=hooks['agy-retry-auto-retry'].PreInvocation[0].command;
 assert.doesNotMatch(command,/__AGY_RETRY_PLUGIN_DIR__/);assert.doesNotMatch(preCommand,/__AGY_RETRY_PLUGIN_DIR__/);
 const home=temp(),pluginDir=path.join(home,'.gemini','config','plugins','agy-retry-hud'),state=path.join(home,'state');
 fs.mkdirSync(path.dirname(pluginDir),{recursive:true});fs.cpSync(path.resolve('plugin/agy-retry-hud'),pluginDir,{recursive:true});
 const payload={executionNum:1,terminationReason:'model_stop',error:'',fullyIdle:true,conversationId:'12345678-abcd-ef01-2345-6789abcdef01',workspacePaths:[home],modelName:'gemini-test'};
 const r=spawnSync(command,{shell:true,input:JSON.stringify(payload),encoding:'utf8',env:{...process.env,HOME:home,USERPROFILE:home,AGY_RETRY_STATE_DIR:state}});
 assert.equal(r.status,0,r.stderr);
 assert.deepEqual(JSON.parse(r.stdout),{decision:'stop'});
 const p=spawnSync(preCommand,{shell:true,input:JSON.stringify({conversationId:payload.conversationId,invocationNum:2,workspacePaths:[home],modelName:'gemini-test'}),encoding:'utf8',env:{...process.env,HOME:home,USERPROFILE:home,AGY_RETRY_STATE_DIR:state}});assert.equal(p.status,0,p.stderr);assert.deepEqual(JSON.parse(p.stdout),{injectSteps:[],terminationBehavior:''});
});
