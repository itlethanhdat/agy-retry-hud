import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {agyboxSandboxRoot,agyboxSupervisorActive,agyboxRequestRotate} from '../src/agybox-bus.js';
import {sandboxRoot} from '../agybox/lib/config.js';
import {acquireLock,releaseLock,supervisorActive,takeRotateRequest} from '../agybox/lib/supervisor.js';

// Parity lock-in: src/agybox-bus.js deliberately duplicates agybox/lib's IPC
// helpers (the installed plugin ships dist/ as a verbatim copy of src/, so a
// cross-boundary import would break). If the wire formats ever diverge, these
// tests fail. No Docker/AGY needed: tmp dirs + live/dead pids only.
function temp(prefix='agybox-bus-parity-'){return fs.mkdtempSync(path.join(os.tmpdir(),prefix));}
function withRoot(t,fn){
 const root=temp(),prev=process.env.AGYBOX_ROOT;process.env.AGYBOX_ROOT=root;
 t.after(()=>{if(prev===undefined)delete process.env.AGYBOX_ROOT;else process.env.AGYBOX_ROOT=prev;fs.rmSync(root,{recursive:true,force:true});});
 return fn(root);
}
function deadPid(){const r=spawnSync(process.execPath,['-e','']);assert.equal(r.status,0);return r.pid;}

test('sandboxRoot parity: src mirror matches agybox sandboxRoot',t=>{
 withRoot(t,root=>{assert.equal(agyboxSandboxRoot(),root);assert.equal(sandboxRoot(),root);});
 const prev=process.env.AGYBOX_ROOT;delete process.env.AGYBOX_ROOT;
 try{assert.equal(agyboxSandboxRoot(),sandboxRoot());}
 finally{if(prev!==undefined)process.env.AGYBOX_ROOT=prev;}
});

test('rotate-request parity: src write is consumed by agybox takeRotateRequest',t=>{
 withRoot(t,root=>{
  const before=Date.now();
  agyboxRequestRotate(root,{to:'b',source:'daemon'});
  const raw=JSON.parse(fs.readFileSync(path.join(root,'rotate-request.json'),'utf8'));
  assert.deepEqual(Object.keys(raw).sort(),['requestedAt','source','to']);
  assert.equal(raw.to,'b');assert.equal(raw.source,'daemon');
  assert.ok(Number.isFinite(raw.requestedAt)&&raw.requestedAt>=before);
  assert.deepEqual(takeRotateRequest(root),{to:'b',requestedAt:raw.requestedAt});
  assert.equal(takeRotateRequest(root),null); // one-shot: consumed
 });
});

test('rotate-request parity: default args round-trip with null target',t=>{
 withRoot(t,root=>{
  agyboxRequestRotate(root,{});
  const got=takeRotateRequest(root);
  assert.equal(got.to,null);assert.ok(Number.isFinite(got.requestedAt));
 });
});

test('supervisorActive parity: agybox lock file agreed by both implementations',t=>{
 withRoot(t,root=>{
  const r=acquireLock(root,'a');assert.equal(r.ok,true); // agybox's real lock format
  assert.equal(supervisorActive(root),true);
  assert.equal(agyboxSupervisorActive(root),true);
  releaseLock(root,'a');
  assert.equal(supervisorActive(root),false);
  assert.equal(agyboxSupervisorActive(root),false);
 });
});

test('supervisorActive parity: dead pid and missing dir agreed by both',t=>{
 withRoot(t,root=>{
  fs.mkdirSync(path.join(root,'locks'),{recursive:true});
  fs.writeFileSync(path.join(root,'locks','a.json'),JSON.stringify({pid:deadPid(),startedAt:Date.now()}));
  assert.equal(supervisorActive(root),false);
  assert.equal(agyboxSupervisorActive(root),false);
 });
 const bare=temp();t.after(()=>fs.rmSync(bare,{recursive:true,force:true}));
 assert.equal(supervisorActive(bare),false);
 assert.equal(agyboxSupervisorActive(bare),false);
});
