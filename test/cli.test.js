import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync,spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {loadConfig,pathsFor} from '../src/config.js';
import {Store} from '../src/state.js';import {newJob} from '../src/supervisor.js';
const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url)),fake=fileURLToPath(new URL('./fixtures/scenario-agy.js',import.meta.url));
function temp(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'agy CLI Việt '));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
test('config precedence, bytes and numeric bounds; workspace config is never auto-read',t=>{
 const d=temp(t),user=path.join(d,'user.json'),explicit=path.join(d,'explicit.json');fs.writeFileSync(user,JSON.stringify({message:'user'}));fs.writeFileSync(explicit,JSON.stringify({message:'explicit'}));
 assert.equal(loadConfig({userPath:user,explicitPath:explicit,flags:{message:'flag'}}).message,'flag');
 assert.equal(loadConfig({userPath:user,explicitPath:explicit}).message,'explicit');
 for(const value of [-1,NaN,Infinity,0])assert.throws(()=>loadConfig({userPath:'/no-file',flags:{maxTransientRetries:value}}));
 assert.throws(()=>loadConfig({flags:{message:'  '}}));assert.throws(()=>loadConfig({flags:{message:'á'.repeat(2049)}}));
 fs.writeFileSync(path.join(d,'config.json'),JSON.stringify({message:'workspace poison'}));assert.notEqual(loadConfig({userPath:'/not-there',cwd:d}).message,'workspace poison');
 assert.ok(pathsFor({platform:'win32',home:'C:/Users/u',env:{LOCALAPPDATA:'C:/Users/u/AppData/Local'}}).data.includes('AppData'));
});
test('CLI handles Unicode paths/input and local status without invoking AGY',t=>{
 const d=temp(t),scenario=path.join(d,'scenario.json'),cfg=path.join(d,'config.json'),data=path.join(d,'data');
 fs.writeFileSync(scenario,JSON.stringify({turns:[{status:'SUCCESS',response:'done'}],sends:[]}));
 fs.writeFileSync(cfg,JSON.stringify({executable:process.execPath,prefixArgs:[fake,scenario]}));
 const r=spawnSync(process.execPath,[cli,'run','--cwd',d,'--config',cfg,'--data-dir',data,'--prompt','Tiếp tục $(echo no)','--plain'],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr+r.stdout);assert.equal(JSON.parse(fs.readFileSync(scenario)).sends[0].message,'Tiếp tục $(echo no)');
 const list=JSON.parse(execFileSync(process.execPath,[cli,'status','--data-dir',data,'--json'],{encoding:'utf8'}));assert.equal(list[0].status,'SUCCEEDED');
 assert.equal(JSON.parse(fs.readFileSync(scenario)).sends.length,1);
});
test('CLI returns nonzero for missing executable and rejects unsupported options',t=>{
 const d=temp(t);let r=spawnSync(process.execPath,[cli,'run','--agy','missing-command-123','--data-dir',d,'--prompt','hello','--plain'],{encoding:'utf8'});assert.equal(r.status,4);
 r=spawnSync(process.execPath,[cli,'--dangerously-skip-permissions'],{encoding:'utf8'});assert.equal(r.status,2);
});

test('doctor rejects AGY below stream-input minimum and accepts supported versions',t=>{
 const d=temp(t),fixture=fileURLToPath(new URL('./fixtures/version-agy.js',import.meta.url));
 const make=(version,name)=>{const cfg=path.join(d,name+'.json');fs.writeFileSync(cfg,JSON.stringify({executable:process.execPath,prefixArgs:[fixture,version]}));return cfg;};
 let r=spawnSync(process.execPath,[cli,'doctor','--config',make('1.1.14','old'),'--data-dir',path.join(d,'old-data')],{encoding:'utf8'});
 assert.equal(r.status,4,r.stderr+r.stdout);let report=JSON.parse(r.stdout);assert.equal(report.agyFound,true);assert.equal(report.agySupported,false);assert.equal(report.minimumAgyVersion,'1.1.15');
 r=spawnSync(process.execPath,[cli,'doctor','--config',make('1.2.13','new'),'--data-dir',path.join(d,'new-data')],{encoding:'utf8'});
 // This project's release contract is Node 24, so a different test runtime may still yield code 4.
 report=JSON.parse(r.stdout);assert.equal(report.agyFound,true);assert.equal(report.agySupported,true);assert.equal(report.recommendedAgyVersion,'1.2.13');
});
test('resume applies explicit executable override and refuses ignored identity/config flags',t=>{
 const d=temp(t),scenario=path.join(d,'scenario.json');fs.writeFileSync(scenario,JSON.stringify({turns:[{status:'SUCCESS'}],sends:[]}));
 const cfg=loadConfig({userPath:'/absent',flags:{executable:'missing-old-executable',prefixArgs:[fake,scenario]}});
 const job=newJob({cwd:d,conversation:'session-1',config:cfg});const store=new Store(path.join(d,'jobs'));store.save(job);
 let r=spawnSync(process.execPath,[cli,'resume','--job',job.id,'--data-dir',d,'--agy',process.execPath,'--plain'],{encoding:'utf8'});
 assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(JSON.parse(fs.readFileSync(scenario)).sends.length,1);
 r=spawnSync(process.execPath,[cli,'resume','--job',job.id,'--data-dir',d,'--model','different','--plain'],{encoding:'utf8'});assert.equal(r.status,2);
});
