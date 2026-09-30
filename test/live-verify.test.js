import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyLive} from '../scripts/live-verify.js';

test('live verifier performs only read-only probes and summarizes without model turns',async()=>{
 const calls=[];
 const runner=async(_exe,args)=>{
  calls.push(args);
  const key=args.join(' ');
  if(key==='--version')return {ok:true,stdout:'agy 1.2.13\n',stderr:''};
  if(key==='--help')return {ok:true,stdout:'help',stderr:''};
  if(key==='plugin list')return {ok:true,stdout:'agy-retry-hud enabled\n',stderr:''};
  if(key==='-p /hooks --output-format json')return {ok:true,stdout:JSON.stringify({hooks:['agy-retry-auto-retry']}),stderr:''};
  if(key==='-p /skills --output-format json')return {ok:true,stdout:JSON.stringify({skills:['agy-retry-hud:handoff','agy-retry-hud:continue-handoff']}),stderr:''};
  if(key==='-p /usage --output-format json')return {ok:true,stdout:JSON.stringify({quota:{}}),stderr:''};
  throw Error('unexpected probe '+key);
 };
 const report=await verifyLive({executable:'agy',runner});
 assert.equal(report.ok,true);
 assert.equal(report.safety.modelTurnExecuted,false);
 assert.equal(report.plugin.agyRetryHudListed,true);
 assert.equal(report.hooks.agyRetryHookVisible,true);
 assert.equal(report.skills.agyRetrySkillsVisible,true);
 assert.equal(report.usage.json,true);
 assert.deepEqual(calls,[['--version'],['--help'],['plugin','list'],['-p','/hooks','--output-format','json'],['-p','/skills','--output-format','json'],['-p','/usage','--output-format','json']]);
});
