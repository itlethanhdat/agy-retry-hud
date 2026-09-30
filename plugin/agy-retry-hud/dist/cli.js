#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';import {parseArgs} from 'node:util';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import readline from 'node:readline';
import {loadConfig,pathsFor,validateConfig} from './config.js';import {Store,acquire,releaseDeadLock,keyFor} from './state.js';import {newJob,Supervisor} from './supervisor.js';import {QuotaProvider} from './quota.js';import {TerminalHUD,parseInput,sanitize} from './hud.js';import {MIN_AGY_VERSION,RECOMMENDED_AGY_VERSION,versionAtLeast} from './version.js';
const exec=promisify(execFile);
const help=`AGY HUD + Auto Retry 0.3.0 (pre-release; Node.js 24)
  agy-retry run [--prompt TEXT | --conversation ID] [--model MODEL]
  agy-retry resume --job JOB_ID
  agy-retry status [--job JOB_ID | --conversation ID] [--json]
  agy-retry cancel --job JOB_ID
  agy-retry unlock --job JOB_ID
  agy-retry doctor [--json]
  agy-retry demo
Options: --cwd PATH --agy PATH --config PATH --data-dir PATH --message TEXT
         --quota-group gemini --profile-key LABEL --checkpoint FILE --agent NAME
         --plain --once
Interactive: :pause :resume :cancel :message TEXT :help :quit
Resume uses an explicit conversation ID, never the most recent session.
Use doctor before a live run. Demo makes no API calls. See docs/compatibility.md.
`;
const exits=j=>({SUCCEEDED:0,EXHAUSTED:3,NEEDS_USER:4,PAUSED_UNCERTAIN:4,CANCELED:130}[j.status]??4);
async function main(){
 const strings=['prompt','conversation','job','model','agent','message','config','data-dir','cwd','agy','quota-group','profile-key','checkpoint'];
 const options=Object.fromEntries(strings.map(x=>[x,{type:'string'}]));for(const x of ['plain','once','json','help'])options[x]={type:'boolean'};
 const {values:v,positionals}=parseArgs({options,allowPositionals:true});const command=positionals[0]||'help';
 if(v.help||command==='help'){process.stdout.write(help);return 0;}if(positionals.length>1)throw Error('unexpected positional arguments');
 if(!['run','resume','status','cancel','unlock','doctor','demo'].includes(command))throw Error('unknown command');
 const data=path.resolve(v['data-dir']||pathsFor().data),store=new Store(path.join(data,'jobs')),lockDir=path.join(data,'locks');
 const pick=()=>{if(v.job)return store.load(v.job);if(v.conversation){const all=store.list().filter(j=>j.conversation===v.conversation);if(all.length!==1)throw Error('conversation matches zero or multiple jobs; use --job');return all[0];}throw Error('--job required');};
 if(command==='status'){const jobs=v.job||v.conversation?[pick()]:store.list();const publicJobs=jobs.map(j=>({id:j.id,conversation:j.conversation,status:j.status,paused:!!j.paused,nextRetryAt:j.nextRetryAt?new Date(j.nextRetryAt).toISOString():null,transientRetries:j.transientRetries,quotaRetries:j.quotaRetries,reason:j.reason}));process.stdout.write(JSON.stringify(publicJobs,null,2)+'\n');return 0;}
 if(command==='cancel'){const j=pick();fs.writeFileSync(path.join(store.dir,j.id+'.cancel'),'cancel',{mode:0o600});process.stdout.write('Cancellation requested for '+j.id+'\n');return 0;}
 if(command==='unlock'){const j=pick();for(const key of ['job:'+j.id,...(j.conversation?[keyFor(j.cwd,j.conversation)]:[])]){try{releaseDeadLock(lockDir,key);}catch(e){if(e.code!=='ENOENT')throw e;}}process.stdout.write('Dead-owner locks removed. An uncertain dispatch still requires manual inspection.\n');return 0;}
 let config=command==='resume'?null:loadConfig({explicitPath:v.config,flags:{message:v.message,executable:v.agy,quotaGroup:v['quota-group'],profileKey:v['profile-key']}});
 if(command==='doctor'){
  let version='',found=false;try{version=(await exec(config.executable,[...config.prefixArgs,'--version'],{timeout:10000,maxBuffer:65536,windowsHide:true})).stdout.trim();found=true;}catch{}
  const agySupported=found&&versionAtLeast(version);
  const report={node:process.version,nodeSupported:Number(process.versions.node.split('.')[0])===24,agyFound:found,agyVersion:sanitize(version),agySupported,minimumAgyVersion:MIN_AGY_VERSION,recommendedAgyVersion:RECOMMENDED_AGY_VERSION,liveVerified:false,initHandshake:'verified per run before any prompt',quotaGroup:config.quotaGroup||'unknown',profileScope:config.profileKey?'user-labelled (not authenticated)':'unknown',platform:process.platform};
  process.stdout.write(JSON.stringify(report,null,2)+'\n');return found&&agySupported&&report.nodeSupported?0:4;
 }
 let demoDir;
 if(command==='demo'){demoDir=fs.mkdtempSync(path.join(os.tmpdir(),'agy-retry-demo-'));config={...config,executable:process.execPath,prefixArgs:[fileURLToPath(new URL('../examples/demo-agent.js',import.meta.url)),path.join(demoDir,'count')],transientBaseMs:2000,transientCapMs:2000,jitterMs:0};}
 const cwd=fs.realpathSync(v.cwd||process.cwd());
 let job=command==='resume'?pick():newJob({cwd,conversation:v.conversation,model:v.model,agent:v.agent,checkpointFile:v.checkpoint,config});
 if(command==='resume'){
  for(const flag of ['config','prompt'])if(v[flag]!==undefined)throw Error('--'+flag+' is not supported on resume');
  const identity={conversation:job.conversation,model:job.model,agent:job.agent,cwd:job.cwd,checkpoint:job.checkpointFile,'quota-group':job.config.quotaGroup,'profile-key':job.config.profileKey};
  for(const [flag,saved] of Object.entries(identity))if(v[flag]!==undefined){const requested=['cwd','checkpoint'].includes(flag)?path.resolve(job.cwd,v[flag]):v[flag];if(requested!==saved)throw Error('--'+flag+' cannot change a saved job');}
  job.config={...job.config,...(v.agy!==undefined?{executable:v.agy}:{}),...(v.message!==undefined?{message:v.message}:{})};validateConfig(job.config);
 }
 config=job.config;
 const ui=new TerminalHUD({plain:v.plain,onAction:act=>{void handle(act).catch(e=>ui.log('Error: '+sanitize(e.message)+'\n'));}});
 let active,supervisor,closed=false,finish,code=0;const finished=new Promise(r=>finish=r);
 const once=Boolean(v.once||!ui.tty);ui.setJob(job);
 const quit=async()=>{if(closed)return;closed=true;if(active)supervisor?.control('cancel');await active;ui.close();finish();};
 async function launch(prompt,resume=false){
  if(active){ui.log('Busy: draft retained; pause/cancel before a new task.\n');return;}
  if(!resume&&job.status!=='IDLE')job=newJob({cwd:job.cwd,conversation:job.conversation,model:job.model,agent:job.agent,checkpointFile:job.checkpointFile,config:job.config});
  const quota=new QuotaProvider({dir:path.join(data,'quota'),executable:config.executable,prefixArgs:config.prefixArgs,cwd:job.cwd});
  supervisor=new Supervisor({store,lockDir,quota,onChange:j=>ui.setJob(j),onOutput:s=>ui.log(s)});
  active=supervisor.run(job,{prompt});
  try{await active;code=exits(job);ui.log(`\nJob ${job.id}: ${job.status}\n`);if(job.status==='SUCCEEDED')ui.setJob({...job,status:'IDLE'});}
  catch(e){code=4;ui.log('Error: '+sanitize(e.message)+'\n');}
  finally{active=null;if(once){closed=true;ui.close();finish();}}
 }
 async function handle(a){
  if(a.kind==='quit'){await quit();return;}
  if(a.kind==='help'){ui.log(help);return;}
  if(['pause','resume','cancel','message'].includes(a.kind)){if(active)supervisor.control(a.kind,a.value);else ui.log('No active job. Start a prompt or use resume --job from the shell.\n');return;}
  if(a.kind==='busy'){ui.log('Busy: input remains a draft and was not queued.\n');return;}
  if(a.kind==='invalid'){ui.log('Unknown command. Use :help.\n');return;}
  if(a.kind==='prompt'&&a.value.trim())await launch(a.value);
 }
 const sig=()=>{supervisor?.control('cancel');if(!active)void quit();};process.on('SIGINT',sig);process.on('SIGTERM',sig);
 let rl;
 if(!ui.tty&&!once){rl=readline.createInterface({input:process.stdin});rl.on('line',s=>void handle(parseInput(s)));}
 if(command==='resume')void launch(undefined,true);
 else if(command==='demo')void launch('Demo: continue this synthetic task without contacting any API.');
 else if(v.prompt!==undefined||v.conversation)void launch(v.prompt);
 else if(once){ui.close();throw Error('--prompt or --conversation is required without an interactive terminal');}
 await finished;process.off('SIGINT',sig);process.off('SIGTERM',sig);rl?.close();if(demoDir)fs.rmSync(demoDir,{recursive:true,force:true});return code;
}
try{process.exitCode=await main();}catch(e){process.stderr.write('Error: '+sanitize(e.message)+'\n');process.exitCode=2;}
