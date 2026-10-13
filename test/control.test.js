import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {DEFAULT_CONTROL_CONFIG,loadControlConfig,saveControlConfig,setConversationOverride,effectiveControls,getConversationOverride,updateGlobal,setHudMode,setDaemonEnabled} from '../src/control.js';
function temp(){return fs.mkdtempSync(path.join(os.tmpdir(),'agy-control-'));}
const conv='12345678-abcd-ef01-2345-6789abcdef01';
test('retry and handoff global/session controls are isolated and deterministic',()=>{const dir=temp(),file=path.join(dir,'config.json'),root=path.join(dir,'state');saveControlConfig(JSON.parse(JSON.stringify(DEFAULT_CONTROL_CONFIG)),{file});let c=updateGlobal('retry',false,{file});assert.equal(c.retry.enabled,false);setConversationOverride(root,'retry',conv,'on');let e=effectiveControls(root,conv,{config:loadControlConfig({file})});assert.equal(e.retryOverride,'on');assert.equal(e.retryEnabled,true);const other='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';e=effectiveControls(root,other,{config:loadControlConfig({file})});assert.equal(e.retryOverride,'inherit');assert.equal(e.retryEnabled,false);setConversationOverride(root,'retry',conv,'inherit');assert.equal(getConversationOverride(root,'retry',conv),'inherit');});
test('config validates weekly threshold and ordered handoff thresholds',()=>{const dir=temp(),file=path.join(dir,'config.json'),c=JSON.parse(JSON.stringify(DEFAULT_CONTROL_CONFIG));c.retry.weeklyRemainingThreshold=.01;c.handoff.snapshotAt=85;c.handoff.prepareAt=90;c.handoff.rolloverAt=95;saveControlConfig(c,{file});assert.equal(loadControlConfig({file}).handoff.rolloverAt,95);c.handoff.cancelRolloverBelow=90;assert.throws(()=>saveControlConfig(c,{file}),/thresholds/);});

test('HUD modes and daemon enablement have explicit non-ambiguous semantics',()=>{const dir=temp(),file=path.join(dir,'config.json');saveControlConfig(JSON.parse(JSON.stringify(DEFAULT_CONTROL_CONFIG)),{file});let c=setHudMode('hide',{file});assert.equal(c.hud.visible,false);assert.equal(c.daemon.enabled,true);assert.equal(c.retry.enabled,true);c=setHudMode('off',{file});assert.equal(c.hud.enabled,false);assert.equal(c.daemon.enabled,false);assert.equal(c.retry.enabled,false);assert.equal(c.handoff.enabled,false);c=setHudMode('on',{file});assert.equal(c.hud.visible,true);assert.equal(c.daemon.enabled,true);assert.equal(c.retry.enabled,true);assert.equal(c.handoff.enabled,true);c=setDaemonEnabled(false,{file});assert.equal(c.daemon.enabled,false);assert.equal(c.daemon.autoStart,false);});


test('v0.4 config migrates to v0.5 defaults without losing existing retry/handoff choices',()=>{const dir=temp(),file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify({hud:{color:false,barWidth:7},retry:{enabled:false},handoff:{enabled:false}}));const c=loadControlConfig({file});assert.equal(c.hud.color,false);assert.equal(c.hud.barWidth,7);assert.equal(c.hud.enabled,true);assert.equal(c.hud.visible,true);assert.equal(c.retry.enabled,false);assert.equal(c.handoff.enabled,false);assert.equal(c.daemon.enabled,true);assert.equal(c.daemon.autoStart,true);});

test('transient NO_COLOR/TERM=dumb never persists into the saved control config',()=>{
 const dir=temp(),file=path.join(dir,'config.json'),dumbEnv={...process.env,TERM:'dumb',NO_COLOR:'1'};
 // Loading under a dumb terminal must not flip the in-memory default...
 assert.equal(loadControlConfig({file,env:dumbEnv}).hud.color,true);
 // ...and a load→save roundtrip (repair/install/toggles) must not poison the file.
 const c=loadControlConfig({file,env:dumbEnv});saveControlConfig(c,{file});
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).hud.color,true);
 // An explicit user choice in the file is still respected.
 const dir2=temp(),file2=path.join(dir2,'config.json');fs.writeFileSync(file2,JSON.stringify({hud:{color:false}}));
 assert.equal(loadControlConfig({file:file2,env:dumbEnv}).hud.color,false);
});

test('retry.policy defaults to wait and normalizes unknown values',()=>{
 const dir=temp(),file=path.join(dir,'config.json');
 // default when the file (or the key) is absent
 assert.equal(loadControlConfig({file}).retry.policy,'wait');
 fs.writeFileSync(file,JSON.stringify({retry:{}}));
 assert.equal(loadControlConfig({file}).retry.policy,'wait');
 // explicit rotate survives the load
 fs.writeFileSync(file,JSON.stringify({retry:{policy:'rotate'}}));
 assert.equal(loadControlConfig({file}).retry.policy,'rotate');
 // unknown values normalize to wait instead of throwing on load
 fs.writeFileSync(file,JSON.stringify({retry:{policy:'nope'}}));
 assert.equal(loadControlConfig({file}).retry.policy,'wait');
 // saving an invalid policy is rejected explicitly
 const c=loadControlConfig({file});c.retry.policy='nope';
 assert.throws(()=>saveControlConfig(c,{file}),/policy/);
});
