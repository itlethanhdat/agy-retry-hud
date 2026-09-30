import {spawn} from 'node:child_process';
import {TextDecoder} from 'node:util';

export class Decoder {
 constructor(limit=8*1024*1024){this.limit=limit;this.buffer='';this.utf8=new TextDecoder('utf-8',{fatal:true});}
 feed(chunk){
  try {this.buffer+=this.utf8.decode(chunk,{stream:true});}catch{throw Error('protocol: invalid UTF-8');}
  const out=[];
  for(;;){const i=this.buffer.indexOf('\n');if(i<0)break; const line=this.buffer.slice(0,i).trim();this.buffer=this.buffer.slice(i+1);
   if(Buffer.byteLength(line)>this.limit)throw Error('protocol line limit');
   if(!line)continue;let e;try{e=JSON.parse(line);}catch{throw Error('protocol: invalid JSON');}
   if(!e||!['init','step_update','result'].includes(e.event))throw Error('unsupported stream event');
   if(e.event==='init'&&(!e.init||typeof e.conversation_id!=='string'||!e.conversation_id))throw Error('protocol: invalid init');
   if(e.event==='result'&&(!e.result||typeof e.result.status!=='string'))throw Error('protocol: invalid result');
   if(e.event==='step_update'&&(!e.step_update||typeof e.step_update!=='object'))throw Error('protocol: invalid step');
   out.push(e);
  }
  if(Buffer.byteLength(this.buffer)>this.limit)throw Error('protocol line limit');return out;
 }
 end(){try{this.buffer+=this.utf8.decode();}catch{throw Error('protocol: truncated UTF-8');}if(this.buffer.trim())throw Error('protocol: truncated JSON line');}
}

export function startSession(cfg={}) {
 const args=[...(cfg.prefixArgs||[]),'--input-format','stream-json','--output-format','stream-json'];
 if(cfg.conversation)args.push('--conversation',cfg.conversation);
 if(cfg.model)args.push('--model',cfg.model);if(cfg.agent)args.push('--agent',cfg.agent);
 const child=spawn(cfg.executable||'agy',args,{cwd:cfg.cwd,env:{...process.env,...cfg.env},shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
 const decoder=new Decoder();let queue=[],wake,ended=false,failed=false,initialized=false,terminal=false,closeResolve,closeResult;
 const closed=new Promise(r=>closeResolve=r);
 const put=e=>{queue.push(e);wake?.();wake=null;};
 const kill=()=>{
  if(!child.pid)return;
  if(process.platform==='win32'){
   const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>child.kill());
  }else {try{process.kill(-child.pid,'SIGKILL');}catch{try{child.kill('SIGKILL');}catch{}}}
 };
 const fail=reason=>{if(failed)return;failed=true;put({event:'protocol_error',reason});kill();};
 const initTimer=setTimeout(()=>fail('init timeout; no prompt was sent'),cfg.initTimeoutMs??15000);
 const watchdog=setTimeout(()=>fail('turn watchdog expired; outcome uncertain'),cfg.watchdogMs??3600000);
 child.stdout.on('data',chunk=>{try{for(const e of decoder.feed(chunk)){
  if(e.event==='init'){if(initialized)throw Error('protocol: repeated init');initialized=true;clearTimeout(initTimer);}
  if(e.event==='result'){if(terminal)continue;terminal=true;}
  if(!terminal||e.event==='result')put(e);
 }}catch(e){fail(e.message);}});
 child.stdout.on('end',()=>{try{decoder.end();}catch(e){fail(e.message);}});
 // Drain diagnostics without persisting potentially sensitive stderr or parsing unverified AGY_ERROR fields.
 child.stderr.on('data',()=>{});
 child.stdin.on('error',()=>fail('stdin write failed; outcome uncertain'));
 child.on('error',()=>fail('failed to launch CLI; check executable path'));
 child.on('close',(code,signal)=>{
  clearTimeout(initTimer);clearTimeout(watchdog);ended=true;closeResult={code,signal,clean:!failed&&signal===null};closeResolve(closeResult);wake?.();
 });
 let closing;
 return {
  pid:child.pid,closed,
  async *events(){while(!ended||queue.length){if(queue.length)yield queue.shift();else await new Promise(r=>wake=r);}},
  send(message){if(!initialized||terminal||failed||ended)return Promise.reject(Error('session not ready'));
   return new Promise((resolve,reject)=>child.stdin.write(JSON.stringify({event:'user',message:{content:message}})+'\n',e=>e?reject(e):resolve()));},
  close(){if(closing)return closing;closing=(async()=>{if(ended)return closeResult;child.stdin.end();const timer=setTimeout(()=>{failed=true;kill();},cfg.closeTimeoutMs??3000);try{return await closed;}finally{clearTimeout(timer);}})();return closing;},
  abort(){failed=true;kill();return closed;}
 };
}
