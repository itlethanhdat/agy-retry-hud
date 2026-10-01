#!/usr/bin/env node
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {parseArgs} from 'node:util';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {MIN_AGY_VERSION,RECOMMENDED_AGY_VERSION,versionAtLeast} from '../src/version.js';

const exec=promisify(execFile);
function redact(text){
 const home=os.homedir();
 return String(text??'').replaceAll(home,'~').replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,'<redacted-email>').slice(0,2000);
}
async function run(exe,args,timeout=15000){
 try{
  const r=await exec(exe,args,{timeout,maxBuffer:1024*1024,windowsHide:true});
  return {ok:true,stdout:redact(r.stdout),stderr:redact(r.stderr)};
 }catch(e){return {ok:false,code:e.code??null,stdout:redact(e.stdout),stderr:redact(e.stderr||e.message)};}
}
function parseMaybeJson(text){try{return JSON.parse(text);}catch{return null;}}
export async function verifyLive({executable='agy',runner=run}={}){
 const version=await runner(executable,['--version']);
 const help=version.ok?await runner(executable,['--help']):{ok:false,stderr:'skipped: agy unavailable'};
 const plugins=version.ok?await runner(executable,['plugin','list']):{ok:false,stderr:'skipped: agy unavailable'};
 const hooks=version.ok?await runner(executable,['-p','/hooks','--output-format','json']):{ok:false,stderr:'skipped: agy unavailable'};
 const skills=version.ok?await runner(executable,['-p','/skills','--output-format','json']):{ok:false,stderr:'skipped: agy unavailable'};
 const usage=version.ok?await runner(executable,['-p','/usage','--output-format','json']):{ok:false,stderr:'skipped: agy unavailable'};
 const hooksJson=parseMaybeJson(hooks.stdout),skillsJson=parseMaybeJson(skills.stdout),usageJson=parseMaybeJson(usage.stdout);
 const report={
  generatedAt:new Date().toISOString(),platform:process.platform,node:process.version,
  agy:{found:version.ok,version:redact(version.stdout.trim()),supported:version.ok&&versionAtLeast(version.stdout),minimum:MIN_AGY_VERSION,recommended:RECOMMENDED_AGY_VERSION,helpOk:help.ok},
  plugin:{listOk:plugins.ok,agyRetryHudListed:/agy-retry-hud/i.test(plugins.stdout)},
  hooks:{queryOk:hooks.ok,json:hooksJson!==null,agyRetryHookVisible:/agy-retry-auto-retry|agy-retry-hud/i.test(hooks.stdout)},
  skills:{queryOk:skills.ok,json:skillsJson!==null,agyRetrySkillsVisible:/agy-retry-hud|continue-handoff|handoff-status|retry-status/i.test(skills.stdout)},
  usage:{queryOk:usage.ok,json:usageJson!==null},
  safety:{modelTurnExecuted:false,note:'Only read-only CLI/version/plugin/hooks/usage probes are executed.'},
  rawSummary:{pluginList:plugins.stdout,hooks:hooks.stdout,skills:skills.stdout,usageShape:usageJson&&typeof usageJson==='object'?Object.keys(usageJson):[]},
  externalGates:{statuslineVisualSmoke:'manual',sameConversationModelSmoke:'manual opt-in',naturalQuotaRecovery:'observe naturally',macOsWindowsLive:'run on target hosts'}
 };
 report.ok=Boolean(report.agy.found&&report.agy.supported&&report.agy.helpOk&&report.plugin.listOk&&report.hooks.queryOk);
 return report;
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 const {values}=parseArgs({options:{agy:{type:'string'},json:{type:'boolean'},strict:{type:'boolean'}}});
 const report=await verifyLive({executable:values.agy||process.env.AGY_RETRY_AGY||'agy'});
 if(values.json)process.stdout.write(JSON.stringify(report,null,2)+'\n');
 else{
  process.stdout.write(`AGY live verification: ${report.ok?'PASS':'INCOMPLETE'}\n`);
  process.stdout.write(`AGY: ${report.agy.version||'not found'} (supported=${report.agy.supported})\n`);
  process.stdout.write(`plugin listed=${report.plugin.agyRetryHudListed}, hook visible=${report.hooks.agyRetryHookVisible}, skills visible=${report.skills.agyRetrySkillsVisible}, usage json=${report.usage.json}\n`);
  process.stdout.write('No model turn was executed. Visual statusline, exact-conversation turn, natural quota, and target-OS smoke remain manual/live gates.\n');
 }
 if(values.strict&&!report.ok)process.exitCode=4;
}
