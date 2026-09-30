import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
const conv='12345678-abcd-ef01-2345-6789abcdef01';
function temp(){return fs.mkdtempSync(path.join(os.tmpdir(),'agy-entry-'));}

test('packaged native statusline entry consumes AGY JSON stdin and renders without touching model APIs',()=>{
 const root=temp(),workspace=temp();const entry=path.resolve('plugin/agy-retry-hud/dist/native-entry.js');
 const body={conversation_id:conv,cwd:workspace,workspace:{current_dir:workspace},model:{id:'gemini-test',display_name:'Gemini Test'},context_window:{used_percentage:37},quota:{'gemini-5h':{remaining_fraction:.5,reset_time:'2030-01-01T01:00:00Z'}},agent_state:'idle',pending_input_count:0,tool_confirmation_pending:false,terminal_width:120};
 const r=spawnSync(process.execPath,[entry,'statusline','--state-root',root],{input:JSON.stringify(body),encoding:'utf8',env:{...process.env,AGY_RETRY_STATE_DIR:root,NO_COLOR:'1'}});
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/Gemini Test/);assert.match(r.stdout,/ctx .*37%/);assert.match(r.stdout,/5h .*50%/);assert.match(r.stdout,/↻ /);assert.equal(r.stderr,'');
});


test('packaged statusline tolerates AGY startup payload before conversation id exists',()=>{
 const root=temp(),entry=path.resolve('plugin/agy-retry-hud/dist/native-entry.js');
 const body={plan_tier:'Google AI Pro',cwd:'/tmp',workspace:{current_dir:'/tmp'},model:{id:'gemini-3.7-flash',display_name:'Gemini 3.7 Flash (Medium)'},context_window:{used_percentage:0,context_window_size:1048576},quota:{'gemini-5h':{remaining_fraction:.28,reset_in_seconds:600},'gemini-weekly':{remaining_fraction:.45,reset_in_seconds:100000}},agent_state:'idle',terminal_width:100};
 const r=spawnSync(process.execPath,[entry,'statusline','--state-root',root],{input:JSON.stringify(body),encoding:'utf8',env:{...process.env,AGY_RETRY_STATE_DIR:root,NO_COLOR:'1'}});
 assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');assert.match(r.stdout,/Gemini 3\.7 Flash/);assert.match(r.stdout,/5h .*28%/);assert.match(r.stdout,/week .*45%/);
 assert.equal(fs.existsSync(path.join(root,'telemetry')),false,'startup payload without conversation id must not persist telemetry');
});
