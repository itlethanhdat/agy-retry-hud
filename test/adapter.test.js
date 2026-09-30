import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {Decoder, startSession} from '../src/adapter.js';

const fake=fileURLToPath(new URL('./fixtures/fake-agy.js',import.meta.url));
test('decoder preserves split UTF-8 and CRLF; rejects corrupt or unknown events',()=>{
 const d=new Decoder(), bytes=Buffer.from('{"event":"result","result":{"status":"SUCCESS","response":"tiếng Việt"}}\r\n');
 const events=[]; for(const byte of bytes) events.push(...d.feed(Buffer.from([byte])));
 assert.equal(events[0].result.response,'tiếng Việt');
 assert.throws(()=>new Decoder().feed(Buffer.from('{bad}\n')),/protocol/i);
 assert.throws(()=>new Decoder().feed(Buffer.from('{"event":"unknown"}\n')),/unsupported/i);
 assert.throws(()=>new Decoder(20).feed(Buffer.alloc(21,65)),/limit/i);
 assert.throws(()=>{const a=new Decoder();a.feed(Buffer.from('{'));a.end();},/truncated/i);
});
test('session initializes before sending, preserves literal input and handles exit 0 error',async()=>{
 const s=startSession({executable:process.execPath,prefixArgs:[fake],cwd:process.cwd(),conversation:'session-1'});
 const input='Tiếp tục `touch nope` $(echo wrong)\nhello'; let result;
 for await(const e of s.events()) {
  if(e.event==='init'){assert.equal(e.conversation_id,'session-1');await s.send(input);}
  if(e.event==='result'){result=e.result; await s.close();}
 }
 assert.equal(result.response,input); assert.equal(result.status,'SUCCESS');
 const error=startSession({executable:process.execPath,prefixArgs:[fake,'--fixture=error']});
 for await(const e of error.events()) {if(e.event==='init')await error.send('x');if(e.event==='result'){assert.equal(e.result.status,'ERROR');await error.close();}}
 assert.equal((await error.closed).code,0);
});
test('no init is bounded, abnormal exit cannot hang event reader',async()=>{
 const s=startSession({executable:process.execPath,prefixArgs:[fake,'--fixture=no-init'],initTimeoutMs:100});
 const events=[]; for await(const e of s.events())events.push(e);
 assert.ok(events.some(e=>e.event==='protocol_error')); await s.close();
 const missing=startSession({executable:'this-executable-does-not-exist'});
 const errors=[];for await(const e of missing.events()) errors.push(e);
 assert.ok(errors.some(e=>e.event==='protocol_error'));
});
