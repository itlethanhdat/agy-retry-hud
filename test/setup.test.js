import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {installAndWire,resolveInstallSourceDir,setupDoctor,wireStatusLine} from '../src/setup.js';
function temp(prefix='agy-setup-'){return fs.mkdtempSync(path.join(os.tmpdir(),prefix));}

function decodeIfEncoded(cmd){
 const m=String(cmd||'').match(/(?:^|\s)-(?:EncodedCommand|enc)\s+([A-Za-z0-9+/=]+)/i);
 return m?Buffer.from(m[1],'base64').toString('utf16le'):String(cmd||'');
}

test('one-command setup installs plugin then wires statusLine while preserving unrelated settings',()=>{
 const home=temp(),source=path.resolve('plugin/agy-retry-hud'),settings=path.join(home,'.gemini','antigravity-cli','settings.json');fs.mkdirSync(path.dirname(settings),{recursive:true});fs.writeFileSync(settings,JSON.stringify({theme:'dark',permissions:{mode:'request-review'}}));
 const fake=path.join(temp(),'agy');fs.writeFileSync(fake,`#!/usr/bin/env node\nconst fs=require('fs'),path=require('path');const a=process.argv.slice(2);if(a[0]!=='plugin')process.exit(2);if(a[1]==='validate')process.exit(fs.existsSync(path.join(a[2],'plugin.json'))?0:2);if(a[1]==='install'){const dst=path.join(process.env.HOME,'.gemini','antigravity-cli','plugins','agy-retry-hud');fs.rmSync(dst,{recursive:true,force:true});fs.mkdirSync(path.dirname(dst),{recursive:true});fs.cpSync(a[2],dst,{recursive:true});process.exit(0)}process.exit(2);\n`);fs.chmodSync(fake,0o755);
 const out=installAndWire({sourceDir:source,home,agy:fake,env:{...process.env,HOME:home,USERPROFILE:home}});assert.ok(fs.existsSync(path.join(out.pluginDir,'plugin.json')));const s=JSON.parse(fs.readFileSync(settings));assert.equal(s.theme,'dark');assert.deepEqual(s.permissions,{mode:'request-review'});assert.equal(s.statusLine.enabled,true);assert.equal(s.statusLine.stack_with_default,false);assert.match(decodeIfEncoded(s.statusLine.command),/native-entry\.js.*statusline/);const doctor=setupDoctor({home,env:{...process.env,HOME:home,USERPROFILE:home}});assert.equal(doctor.statuslineWired,true);assert.equal(doctor.skillsReady,true);const hooks=JSON.parse(fs.readFileSync(path.join(out.pluginDir,'hooks.json')));assert.ok(hooks['agy-retry-auto-retry'].PreInvocation?.[0]?.command);assert.ok(hooks['agy-retry-auto-retry'].Stop?.[0]?.command);assert.equal(doctor.handoffSchema,true);assert.equal(doctor.launcherInstalled,true);assert.ok(fs.existsSync(doctor.launcher));
});

test('setup refuses to overwrite another HUD unless force is explicit',()=>{
 const home=temp(),pluginDir=path.join(home,'.gemini','antigravity-cli','plugins','agy-retry-hud'),settings=path.join(home,'.gemini','antigravity-cli','settings.json');fs.mkdirSync(path.dirname(pluginDir),{recursive:true});fs.cpSync(path.resolve('plugin/agy-retry-hud'),pluginDir,{recursive:true});fs.mkdirSync(path.dirname(settings),{recursive:true});fs.writeFileSync(settings,JSON.stringify({statusLine:{type:'command',command:'other-hud'}}));
 assert.throws(()=>wireStatusLine({home,env:{...process.env,HOME:home},pluginDir}),/another custom statusLine/);const out=wireStatusLine({home,env:{...process.env,HOME:home},pluginDir,force:true});assert.match(decodeIfEncoded(out.statusLine.command),/agy-retry-hud/);
});

test('setup auto-detects nested plugin root when invoked from full project source',()=>{
 const fullRoot=path.resolve('.'),resolved=resolveInstallSourceDir({scriptFile:path.join(fullRoot,'src','setup.js'),cwd:path.dirname(fullRoot)});
 assert.equal(resolved,path.join(fullRoot,'plugin','agy-retry-hud'));
});

test('Windows statusLine command avoids literal quoted paths and survives spaces via EncodedCommand', async()=>{
 const {buildStatusLineCommand,commandReferencesPlugin}=await import('../src/setup.js');
 const pluginDir='C:\\Users\\First Last\\.gemini\\config\\plugins\\agy-retry-hud';
 const command=buildStatusLineCommand({pluginDir,platform:'win32'});
 assert.match(command,/^powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/);
 assert.doesNotMatch(command,/C:\\Users/);
 const encoded=command.match(/-EncodedCommand\s+(\S+)/)[1];
 const decoded=Buffer.from(encoded,'base64').toString('utf16le');
 assert.match(decoded,/C:\\Users\\First Last\\\.gemini\\config\\plugins\\agy-retry-hud\\dist\\native-entry\.js/);
 assert.match(decoded,/\$mode='statusline'/);
 assert.match(decoded,/\[Console\]::In\.ReadToEnd\(\)/);
 assert.equal(commandReferencesPlugin(command),true);
});

test('Windows Stop hook command uses the same quote-safe encoded launcher', async()=>{
 const {buildNativeEntryCommand}=await import('../src/setup.js');
 const command=buildNativeEntryCommand({pluginDir:'C:\\Users\\First Last\\.gemini\\config\\plugins\\agy-retry-hud',mode:'stop-hook',platform:'win32'});
 assert.match(command,/^powershell\.exe .* -EncodedCommand /);
 const encoded=command.match(/-EncodedCommand\s+(\S+)/)[1];
 const decoded=Buffer.from(encoded,'base64').toString('utf16le');
 assert.match(decoded,/\$mode='stop-hook'/);
 assert.match(decoded,/C:\\Users\\First Last/);
});


test('Windows PreInvocation stale-retry hook uses the same quote-safe encoded launcher', async()=>{
 const {buildNativeEntryCommand}=await import('../src/setup.js');
 const command=buildNativeEntryCommand({pluginDir:'C:\\Users\\First Last\\.gemini\\config\\plugins\\agy-retry-hud',mode:'pre-invocation-hook',platform:'win32'});
 assert.match(command,/^powershell\.exe .* -EncodedCommand /);const encoded=command.match(/-EncodedCommand\s+(\S+)/)[1];const decoded=Buffer.from(encoded,'base64').toString('utf16le');assert.match(decoded,/\$mode='pre-invocation-hook'/);assert.match(decoded,/C:\\Users\\First Last/);
});

test('setup doctor reports all six skills and repair restores hooks statusline launcher and default config', async()=>{
 const {repairSetup}=await import('../src/setup.js');
 const home=temp(),pluginDir=path.join(home,'.gemini','config','plugins','agy-retry-hud'),env={...process.env,HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:path.join(home,'.config')};
 fs.mkdirSync(path.dirname(pluginDir),{recursive:true});fs.cpSync(path.resolve('plugin/agy-retry-hud'),pluginDir,{recursive:true});
 fs.writeFileSync(path.join(pluginDir,'hooks.json'),'{}\n');
 let before=setupDoctor({home,env,platform:'linux'});assert.equal(before.skills.setup,true);assert.equal(before.hooksReady,false);assert.equal(before.statuslineWired,false);assert.equal(before.launcherInstalled,false);assert.equal(before.config.exists,false);
 const out=repairSetup({home,env,platform:'linux'});assert.ok(out.actions.includes('hooks'));assert.ok(out.actions.includes('statusline'));assert.ok(out.actions.includes('agy-retryctl launcher'));assert.ok(out.actions.includes('default config'));
 const after=out.doctor;assert.equal(after.hooksReady,true);assert.equal(after.statuslineWired,true);assert.equal(after.launcherInstalled,true);assert.equal(after.config.exists,true);assert.equal(after.config.valid,true);assert.equal(after.skillsReady,true);assert.equal(after.reinstallRequired,false);
});


test('repair accepts shared config global plugin as skill-discoverable without forcing CLI-private restaging', async()=>{
 const {repairSetup}=await import('../src/setup.js');
 const home=temp(),shared=path.join(home,'.gemini','config','plugins','agy-retry-hud'),env={...process.env,HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:path.join(home,'.config')};
 fs.mkdirSync(path.dirname(shared),{recursive:true});fs.cpSync(path.resolve('plugin/agy-retry-hud'),shared,{recursive:true});
 const out=repairSetup({home,env,platform:'linux'});assert.equal(out.doctor.sharedConfigStaged,true);assert.equal(out.doctor.cliStaged,false);assert.equal(out.doctor.installLocation,'shared-config');assert.equal(out.doctor.skillsDiscoverable,true);assert.equal(fs.existsSync(path.join(shared,'skills','setup','SKILL.md')),true);
});


test('one-command setup accepts AGY 1.2.x shared config plugin install path',()=>{
 const home=temp(),source=path.resolve('plugin/agy-retry-hud'),settings=path.join(home,'.gemini','antigravity-cli','settings.json');
 const fake=path.join(temp(),'agy');fs.writeFileSync(fake,`#!/usr/bin/env node\nconst fs=require('fs'),path=require('path');const a=process.argv.slice(2);if(a[0]!=='plugin')process.exit(2);if(a[1]==='validate')process.exit(fs.existsSync(path.join(a[2],'plugin.json'))?0:2);if(a[1]==='install'){const dst=path.join(process.env.HOME,'.gemini','config','plugins','agy-retry-hud');fs.rmSync(dst,{recursive:true,force:true});fs.mkdirSync(path.dirname(dst),{recursive:true});fs.cpSync(a[2],dst,{recursive:true});process.exit(0)}process.exit(2);\n`);fs.chmodSync(fake,0o755);
 const out=installAndWire({sourceDir:source,home,agy:fake,env:{...process.env,HOME:home,USERPROFILE:home}});
 assert.equal(path.resolve(out.pluginDir),path.resolve(path.join(home,'.gemini','config','plugins','agy-retry-hud')));
 const doctor=setupDoctor({home,env:{...process.env,HOME:home,USERPROFILE:home}});
 assert.equal(doctor.sharedConfigStaged,true);assert.equal(doctor.installLocation,'shared-config');assert.equal(doctor.skillsDiscoverable,true);assert.equal(doctor.skills.setup,true);assert.equal(doctor.statuslineWired,true);
 assert.equal(JSON.parse(fs.readFileSync(settings)).statusLine.enabled,true);
});
