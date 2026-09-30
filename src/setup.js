#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CONTROL_CONFIG,controlConfigPath,loadControlConfig,saveControlConfig} from './control.js';

function q(p){return '"'+String(p).replace(/"/g,'\\"')+'"';}
function psSingleQuoted(value){return "'"+String(value).replace(/'/g,"''")+"'";}
export function buildNativeEntryCommand({pluginDir,mode,platform=process.platform}={}){
 if(!pluginDir)throw Error('pluginDir is required');
 if(!mode)throw Error('mode is required');
 if(platform==='win32'){
  const entry=path.win32.join(pluginDir,'dist','native-entry.js');
  const script=`$ErrorActionPreference='Stop';$payload=[Console]::In.ReadToEnd();$entry=${psSingleQuoted(entry)};$mode=${psSingleQuoted(mode)};if($payload.Length -gt 0){$payload | & node $entry $mode}else{& node $entry $mode};if($null -eq $LASTEXITCODE){exit 0}else{exit $LASTEXITCODE}`;
  const encoded=Buffer.from(script,'utf16le').toString('base64');
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
 }
 const entry=path.join(pluginDir,'dist','native-entry.js');
 return `node ${q(entry)} ${mode}`;
}
export function buildStatusLineCommand(opts={}){return buildNativeEntryCommand({...opts,mode:'statusline'});}
export function wireNativeHooks({pluginDir,platform=process.platform}={}){
 if(!pluginDir)throw Error('pluginDir is required');
 const hookFile=path.join(pluginDir,'hooks.json');
 const hooks={"agy-retry-auto-retry":{"PreInvocation":[{type:'command',command:buildNativeEntryCommand({pluginDir,mode:'pre-invocation-hook',platform}),timeout:10}],"Stop":[{type:'command',command:buildNativeEntryCommand({pluginDir,mode:'stop-hook',platform}),timeout:10}]}};
 writeJSON(hookFile,hooks);
 return {hookFile,command:hooks['agy-retry-auto-retry'].Stop[0].command,preInvocationCommand:hooks['agy-retry-auto-retry'].PreInvocation[0].command};
}
export function commandReferencesPlugin(command){
 const raw=String(command||'');
 if(raw.includes('agy-retry-hud')&&(raw.includes('statusline')||raw.includes('stop-hook')||raw.includes('pre-invocation-hook')))return true;
 const m=raw.match(/(?:^|\s)-(?:EncodedCommand|enc)\s+([A-Za-z0-9+/=]+)/i);
 if(!m)return false;
 try{const decoded=Buffer.from(m[1],'base64').toString('utf16le');return decoded.includes('agy-retry-hud')&&(decoded.includes('statusline')||decoded.includes('stop-hook')||decoded.includes('pre-invocation-hook'));}catch{return false;}
}
function readJSON(file,fallback={}){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
function writeJSON(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp-'+process.pid;fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file);}
export function setupPaths({home=os.homedir(),env=process.env,platform=process.platform}={}){
 const cliPlugin=path.join(home,'.gemini','antigravity-cli','plugins','agy-retry-hud'),sharedPlugin=path.join(home,'.gemini','config','plugins','agy-retry-hud'),legacyPlugin=sharedPlugin;
 // AGY 1.0.2+ installs global plugins into the shared config path. Some docs/builds
 // still expose the CLI-private path, so accept both and prefer shared config.
 const candidates=[env.AGY_RETRY_PLUGIN_DIR,sharedPlugin,cliPlugin].filter(Boolean);
 const stateBase=platform==='win32'?(env.LOCALAPPDATA||path.join(home,'AppData','Local')):(env.XDG_STATE_HOME||path.join(home,'.local','state'));
 const launcher=platform==='win32'?path.join(env.LOCALAPPDATA||path.join(home,'AppData','Local'),'agy-retry-hud','bin','agy-retryctl.cmd'):path.join(home,'.local','bin','agy-retryctl');
 return {candidates,cliPlugin,sharedPlugin,legacyPlugin,settings:path.join(home,'.gemini','antigravity-cli','settings.json'),receipt:path.join(stateBase,'agy-retry-hud','install-receipt.json'),launcher};
}
export function locateInstalledPlugin(opts={}){const p=setupPaths(opts);return p.candidates.find(x=>fs.existsSync(path.join(x,'plugin.json'))&&fs.existsSync(path.join(x,'dist','native-entry.js')))||null;}
export function wireStatusLine({home=os.homedir(),env=process.env,pluginDir,force=false,platform=process.platform}={}){
 const p=setupPaths({home,env,platform}),dir=pluginDir||locateInstalledPlugin({home,env,platform});if(!dir)throw Error('installed agy-retry-hud plugin not found');
 const settings=readJSON(p.settings,{}),previous=settings.statusLine??null,current=String(previous?.command||'');
 if(current&&!commandReferencesPlugin(current)&&!force)throw Error('another custom statusLine is configured; rerun with --force-statusline to replace it');
 settings.statusLine={type:'command',command:buildStatusLineCommand({pluginDir:dir,platform}),padding:0,enabled:true,stack_with_default:false};writeJSON(p.settings,settings);
 const receipt=readJSON(p.receipt,null);if(!receipt)writeJSON(p.receipt,{schemaVersion:2,installedAt:new Date().toISOString(),previousStatusLine:previous,pluginDir:dir,settings:p.settings,launcher:p.launcher});
 return {pluginDir:dir,settings:p.settings,statusLine:settings.statusLine};
}
function runAgy(args,{agy=process.env.AGY_BIN||'agy',cwd,env=process.env}={}){
 let cmd=agy,callArgs=args;
 if(process.platform==='win32'&&fs.existsSync(agy)&&!agy.toLowerCase().endsWith('.exe')){
  cmd=process.execPath;callArgs=[agy,...args];
 }
 const r=spawnSync(cmd,callArgs,{cwd,env,encoding:'utf8',shell:false});
 if(r.error)throw r.error;
 if(r.status!==0)throw Error(`agy ${args.join(' ')} failed (${r.status}): ${(r.stderr||r.stdout||'').trim()}`);
 return r;
}
export function resolveInstallSourceDir({sourceDir,scriptFile=fileURLToPath(import.meta.url),cwd=process.cwd()}={}){
 const scriptDir=path.dirname(scriptFile),projectRoot=path.resolve(scriptDir,'..');
 const candidates=[sourceDir&&path.resolve(sourceDir),scriptDir,projectRoot,path.join(projectRoot,'plugin','agy-retry-hud'),path.resolve(cwd,'agy-retry-hud'),path.resolve(cwd,'plugin','agy-retry-hud')].filter(Boolean);
 const seen=new Set();for(const candidate of candidates){const key=path.resolve(candidate);if(seen.has(key))continue;seen.add(key);if(fs.existsSync(path.join(key,'plugin.json')))return key;}
 const checked=[...seen].map(x=>'  - '+x).join('\n');throw Error('could not locate an agy-retry-hud plugin root (plugin.json missing). Checked:\n'+checked+'\nIf you extracted the full project archive, use its plugin/agy-retry-hud directory.');
}
export function createCtlLauncher({home=os.homedir(),env=process.env,platform=process.platform,pluginDir}={}){
 const p=setupPaths({home,env,platform}),dir=pluginDir||locateInstalledPlugin({home,env,platform});if(!dir)throw Error('installed plugin not found for retryctl launcher');const target=p.launcher,entry=path.join(dir,'dist','retryctl.js');if(!fs.existsSync(entry))throw Error('retryctl entry missing from installed plugin');
 let existing='';try{existing=fs.readFileSync(target,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}if(existing&&!existing.includes('agy-retry-hud')&&!existing.includes('retryctl.js'))return {launcher:target,created:false,reason:'existing unrelated launcher preserved'};
 fs.mkdirSync(path.dirname(target),{recursive:true});if(platform==='win32')fs.writeFileSync(target,`@echo off\r\nnode "${entry}" %*\r\n`,'utf8');else{fs.writeFileSync(target,`#!/bin/sh\n# agy-retry-hud launcher\nexec node ${q(entry)} "$@"\n`,'utf8');fs.chmodSync(target,0o755);}return {launcher:target,created:true};
}
export function installAndWire({sourceDir,home=os.homedir(),env=process.env,agy=process.env.AGY_BIN||env?.AGY_BIN||'agy',force=false,validate=true,platform=process.platform}={}){
 sourceDir=resolveInstallSourceDir({sourceDir});const childEnv={...env,HOME:home,USERPROFILE:home};if(validate)runAgy(['plugin','validate',sourceDir],{agy,cwd:sourceDir,env:childEnv});runAgy(['plugin','install',sourceDir],{agy,cwd:sourceDir,env:childEnv});
 const paths=setupPaths({home,env:childEnv,platform}),pluginDir=locateInstalledPlugin({home,env:childEnv,platform});
 if(!pluginDir)throw Error(`agy plugin install completed but no valid agy-retry-hud installation was found. Checked shared config: ${paths.sharedPlugin} and CLI-private path: ${paths.cliPlugin}.`);
 const setupSkill=path.join(pluginDir,'skills','setup','SKILL.md');if(!fs.existsSync(setupSkill))throw Error('installed plugin is missing skills/setup/SKILL.md; reinstall the current package');
 const hook=wireNativeHooks({pluginDir,platform}),wired=wireStatusLine({home,env:childEnv,pluginDir,force,platform}),launcher=createCtlLauncher({home,env:childEnv,platform,pluginDir});return {...wired,...launcher,hook,skillsDiscoverable:true};
}
function hookReady(pluginDir){
 if(!pluginDir)return false;try{const hooks=readJSON(path.join(pluginDir,'hooks.json'),{}),group=hooks?.['agy-retry-auto-retry'],stop=group?.Stop?.[0],pre=group?.PreInvocation?.[0];return stop?.type==='command'&&pre?.type==='command'&&commandReferencesPlugin(stop.command)&&commandReferencesPlugin(pre.command);}catch{return false;}
}
function configHealth({home=os.homedir(),env=process.env,platform=process.platform}={}){
 const file=controlConfigPath({home,env,platform});if(!fs.existsSync(file))return {file,exists:false,valid:true,usingDefaults:true};
 try{loadControlConfig({file,env});return {file,exists:true,valid:true,usingDefaults:false};}catch(e){return {file,exists:true,valid:false,usingDefaults:false,error:e?.message||String(e)};}
}
export function setupDoctor({home=os.homedir(),env=process.env,platform=process.platform}={}){
 const p=setupPaths({home,env,platform}),pluginDir=locateInstalledPlugin({home,env,platform}),settings=readJSON(p.settings,{}),command=String(settings.statusLine?.command||''),skills=['retry','handoff','continue-handoff','handoff-status','retry-status','setup'];
 const skillStatus=Object.fromEntries(skills.map(x=>[x,!!pluginDir&&fs.existsSync(path.join(pluginDir,'skills',x,'SKILL.md'))]));
 const schema=!!pluginDir&&fs.existsSync(path.join(pluginDir,'shared','handoff-schema-v1.json')),launcher=fs.existsSync(p.launcher),hooks=hookReady(pluginDir),config=configHealth({home,env,platform});
 const statuslineWired=!!pluginDir&&commandReferencesPlugin(command),nodeSupported=Number(process.versions.node.split('.')[0])===24,skillsReady=Object.values(skillStatus).every(Boolean);
 const cliStaged=!!pluginDir&&path.resolve(pluginDir)===path.resolve(p.cliPlugin),sharedConfigStaged=!!pluginDir&&path.resolve(pluginDir)===path.resolve(p.sharedPlugin);
 const globallyDiscoverable=cliStaged||sharedConfigStaged,skillsDiscoverable=skillsReady&&globallyDiscoverable;
 const installLocation=sharedConfigStaged?'shared-config':cliStaged?'cli-private':pluginDir?'custom':'missing';
 const reinstallRequired=!!pluginDir&&(!skillsReady||!schema||!fs.existsSync(path.join(pluginDir,'dist','native-entry.js'))||!fs.existsSync(path.join(pluginDir,'dist','retryctl.js')));
 const ok=!!pluginDir&&statuslineWired&&hooks&&skillsDiscoverable&&schema&&launcher&&config.valid&&nodeSupported&&!reinstallRequired;
 return {ok,pluginDir,settings:p.settings,installed:!!pluginDir,cliPluginDir:p.cliPlugin,sharedPluginDir:p.sharedPlugin,legacyPluginDir:p.legacyPlugin,installLocation,cliStaged,sharedConfigStaged,skillsDiscoverable,statuslineWired,statusLine:settings.statusLine||null,hooksReady:hooks,node:process.version,nodeSupported,skills:skillStatus,skillsReady,handoffSchema:schema,launcher:p.launcher,launcherInstalled:launcher,config,reinstallRequired};
}
export function repairSetup({home=os.homedir(),env=process.env,platform=process.platform,force=false,agy='agy'}={}){
 let pluginDir=locateInstalledPlugin({home,env,platform});if(!pluginDir)throw Error('agy-retry-hud is not installed; run setup.js install from the extracted plugin package first');
 const actions=[],warnings=[],p=setupPaths({home,env,platform});
 const standardGlobal=[p.sharedPlugin,p.cliPlugin].map(x=>path.resolve(x));
 if(!standardGlobal.includes(path.resolve(pluginDir))){
  try{const childEnv={...env,HOME:home,USERPROFILE:home};runAgy(['plugin','install',pluginDir],{agy,cwd:pluginDir,env:childEnv});const installed=locateInstalledPlugin({home,env:{...childEnv,AGY_RETRY_PLUGIN_DIR:''},platform});if(installed){pluginDir=installed;actions.push('global plugin staging for skill discovery');}else warnings.push('agy plugin install completed but neither supported global plugin path is present');}
  catch(e){warnings.push(`plugin skill staging failed: ${e?.message||String(e)}`);}
 }
 wireNativeHooks({pluginDir,platform});actions.push('hooks');
 const before=setupDoctor({home,env,platform});
 if(!before.statuslineWired){try{wireStatusLine({home,env,pluginDir,force,platform});actions.push('statusline');}catch(e){warnings.push(e?.message||String(e));}}
 const launcher=createCtlLauncher({home,env,platform,pluginDir});if(launcher.created)actions.push('agy-retryctl launcher');else if(launcher.reason)warnings.push(launcher.reason);
 const cfg=configHealth({home,env,platform});if(!cfg.exists){saveControlConfig(JSON.parse(JSON.stringify(DEFAULT_CONTROL_CONFIG)),{file:cfg.file});actions.push('default config');}else if(!cfg.valid)warnings.push(`config invalid: ${cfg.error}`);
 const doctor=setupDoctor({home,env,platform});if(doctor.reinstallRequired)warnings.push('plugin assets are incomplete; reinstall the current plugin package to restore missing skills/schema/runtime files');if(!doctor.skillsDiscoverable)warnings.push('skills exist on disk but the plugin is not in a supported global discovery path (~/.gemini/config/plugins or ~/.gemini/antigravity-cli/plugins); reinstall with setup.js install or agy plugin install');
 return {actions,warnings,doctor};
}


if(process.argv[1]===fileURLToPath(import.meta.url)){
 const argv=process.argv.slice(2),cmd=argv.find(x=>!x.startsWith('--'))||'doctor',force=argv.includes('--force-statusline');
 try{let out;if(cmd==='install'){const sourceArg=argv[argv.indexOf('install')+1],sourceDir=sourceArg&&!sourceArg.startsWith('--')?path.resolve(sourceArg):undefined;out=installAndWire({sourceDir,force});}
  else if(cmd==='enable')out=wireStatusLine({force});else if(cmd==='repair')out=repairSetup({force});else if(cmd==='doctor')out=setupDoctor();else throw Error('usage: setup.js install [plugin-dir] [--force-statusline] | enable [--force-statusline] | repair [--force-statusline] | doctor');
  process.stdout.write(JSON.stringify(out,null,2)+'\n');
 }catch(e){process.stderr.write((e?.message||String(e))+'\n');process.exitCode=2;}
}
