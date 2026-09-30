import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {renderHUD,InputModel,sanitize,parseInput} from '../src/hud.js';import {validateResume,validateMessage} from '../src/session.js';
test('HUD renders unknown context, stale quota and nonnegative countdown without side effects',()=>{
 const j={status:'WAIT_QUOTA',model:'gemini',conversation:'123456789',nextRetryAt:1000,quotaRetries:1,transientRetries:0,config:{maxQuotaRetries:2,maxTransientRetries:6},quota:{observedAt:0,buckets:[{window:'5h',remainingFraction:.2,resetAt:999999}]}};
 const before=JSON.stringify(j);for(let i=0;i<100;i++){const text=renderHUD(j,80,400000);assert.match(text,/Context unknown/);assert.match(text,/stale/);assert.match(text,/00:00:00/);}
 assert.equal(JSON.stringify(j),before);assert.ok(renderHUD(j,25,400000).split('\n').every(x=>x.length<=25));
});
test('Unicode editing and redraw do not discard busy drafts; pasted newline never submits',()=>{
 const m=new InputModel();m.insert('Tiếng Việt');m.move(-1);m.backspace();assert.equal(m.value,'Tiếng Vit');
 m.insert('\n:cancel');assert.equal(m.submit(true).kind,'busy');assert.ok(m.value.includes(':cancel'));
 const snapshot=m.value;for(let i=0;i<100;i++)renderHUD({},40,0);assert.equal(m.value,snapshot);
 m.value=':pause';m.cursor=m.value.length;assert.equal(m.submit(true).kind,'pause');assert.equal(m.value,'');
 assert.equal(parseInput(':message tiếp tục').value,'tiếp tục');assert.equal(parseInput(':unknown').kind,'invalid');
});
test('terminal control sequences cannot set title or inject cursor actions',()=>{
 const cleaned=sanitize('\x1b]0;evil\x07Hello\x1b[2J\r\x08\u202eWorld');assert.equal(cleaned,'HelloWorld');
});
test('session guard checks workspace, model and checkpoint; message validates bytes',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agy-session-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const j={cwd:dir,conversation:'session',model:'chosen',checkpointFile:path.join(dir,'missing')};
 const e={conversation_id:'session',init:{cwd:dir,model:'chosen'}};assert.throws(()=>validateResume(j,e));
 fs.writeFileSync(j.checkpointFile,'progress');assert.doesNotThrow(()=>validateResume(j,e));assert.throws(()=>validateResume(j,{...e,init:{cwd:dir,model:'other'}}));
 assert.throws(()=>validateMessage('á'.repeat(2049)));assert.throws(()=>validateMessage(' '));assert.equal(validateMessage('Tiếp tục'),'Tiếp tục');
});
