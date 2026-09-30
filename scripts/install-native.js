#!/usr/bin/env node
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {buildStatusLineCommand,commandReferencesPlugin,createCtlLauncher,wireNativeHooks} from '../src/setup.js';
const here=path.dirname(fileURLToPath(import.meta.url)),project=path.resolve(here,'..'),source=path.join(project,'plugin','agy-retry-hud');
function homePaths(home=os.homedir()){
 const pluginDir=path.join(home,'.gemini','config','plugins','agy-retry-hud');
 return {pluginDir,settings:path.join(home,'.gemini','antigravity-cli','settings.json'),receipt:path.join(pluginDir,'.install-receipt.json')};
}
function readJSON(file,fallback={}){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
function writeJSON(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp-'+process.pid;fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file);}
export function install({home=os.homedir(),forceStatusline=false,dryRun=false}={}){
 const p=homePaths(home),settings=readJSON(p.settings,{}),previous=settings.statusLine??null;
 if(previous?.command&&!commandReferencesPlugin(previous.command)&&!forceStatusline)throw Error('custom statusLine already configured; rerun with --force-statusline to replace it');
 if(dryRun)return {...p,statusLineChanged:true};
 fs.rmSync(p.pluginDir,{recursive:true,force:true});fs.mkdirSync(path.dirname(p.pluginDir),{recursive:true});fs.cpSync(source,p.pluginDir,{recursive:true});
 wireNativeHooks({pluginDir:p.pluginDir,platform:process.platform});
 settings.statusLine={type:'command',command:buildStatusLineCommand({pluginDir:p.pluginDir,platform:process.platform}),enabled:true,stack_with_default:false};writeJSON(p.settings,settings);
 const launcher=createCtlLauncher({home,pluginDir:p.pluginDir});
 writeJSON(p.receipt,{schemaVersion:2,installedAt:new Date().toISOString(),pluginDir:p.pluginDir,settings:p.settings,previousStatusLine:previous,launcher:launcher.launcher});
 return {...p,statusLineCommand:settings.statusLine.command,...launcher};
}
export function uninstall({home=os.homedir(),dryRun=false}={}){
 const p=homePaths(home),receipt=readJSON(p.receipt,null),settings=readJSON(p.settings,{});if(!receipt)return {...p,removed:false};
 const owned=commandReferencesPlugin(settings.statusLine?.command);
 if(!dryRun&&owned){if(receipt.previousStatusLine===null)delete settings.statusLine;else settings.statusLine=receipt.previousStatusLine;writeJSON(p.settings,settings);}
 if(!dryRun){const launcher=receipt.launcher;if(launcher){try{const text=fs.readFileSync(launcher,'utf8');if(text.includes('agy-retry-hud')||text.includes('retryctl.js'))fs.rmSync(launcher,{force:true});}catch{}}fs.rmSync(p.pluginDir,{recursive:true,force:true});}return {...p,removed:true,statusLineRestored:owned};
}
export function doctor({home=os.homedir()}={}){
 const p=homePaths(home),settings=readJSON(p.settings,{}),plugin=fs.existsSync(path.join(p.pluginDir,'plugin.json')),entry=fs.existsSync(path.join(p.pluginDir,'dist','native-entry.js')),hooks=fs.existsSync(path.join(p.pluginDir,'hooks.json'));
 const wired=commandReferencesPlugin(settings.statusLine?.command);const nodeOk=Number(process.versions.node.split('.')[0])===24,skills=['retry','handoff','continue-handoff','handoff-status','retry-status','setup'].every(x=>fs.existsSync(path.join(p.pluginDir,'skills',x,'SKILL.md'))),schema=fs.existsSync(path.join(p.pluginDir,'shared','handoff-schema-v1.json')),launcher=fs.existsSync(process.platform==='win32'?path.join(process.env.LOCALAPPDATA||path.join(home,'AppData','Local'),'agy-retry-hud','bin','agy-retryctl.cmd'):path.join(home,'.local','bin','agy-retryctl'));return {...p,node:process.version,nodeOk,plugin,entry,hooks,skills,handoffSchema:schema,launcher,statuslineWired:wired,ok:nodeOk&&plugin&&entry&&hooks&&skills&&schema&&launcher&&wired};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const args=new Set(process.argv.slice(2));try{let r;if(args.has('--uninstall'))r=uninstall({dryRun:args.has('--dry-run')});else if(args.has('--doctor'))r=doctor();else r=install({forceStatusline:args.has('--force-statusline'),dryRun:args.has('--dry-run')});console.log(JSON.stringify(r,null,2));process.exitCode=r.ok===false?4:0;}catch(e){console.error(e.message);process.exitCode=2;}
}
