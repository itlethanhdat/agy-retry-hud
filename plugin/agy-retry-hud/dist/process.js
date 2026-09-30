import {spawn} from 'node:child_process';

// Own a separate process group so a timed-out read cannot leave descendants.
export function boundedCommand(executable,args,{cwd,env,signal,timeoutMs=20000,maxBytes=1024*1024}={}){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(Error('command canceled'));return;}
  const child=spawn(executable,args,{cwd,env,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
  let chunks=[],bytes=0,failure,cleanup=Promise.resolve();
  const stop=reason=>{
   if(failure)return;failure=Error(reason);
   if(!child.pid)return;
   if(process.platform==='win32'){
    cleanup=new Promise(done=>{
     const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
     let finished=false;const finish=()=>{if(finished)return;finished=true;clearTimeout(timer);try{child.kill();}catch{}done();};
     const timer=setTimeout(()=>{try{killer.kill();}catch{}finish();},5000);
     killer.on('error',finish);killer.on('close',finish);
    });
   }else{try{process.kill(-child.pid,'SIGKILL');}catch{try{child.kill('SIGKILL');}catch{}}}
  };
  const abort=()=>stop('command canceled');
  const timer=setTimeout(()=>stop('command timeout'),timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});
  child.stdout.on('data',data=>{bytes+=data.length;if(bytes>maxBytes)stop('command output limit');else chunks.push(data);});
  child.stderr.on('data',()=>{});
  child.on('error',()=>stop('failed to launch command'));
  child.on('close',async(code,exitSignal)=>{
   clearTimeout(timer);signal?.removeEventListener('abort',abort);await cleanup;
   if(failure)reject(failure);else if(code!==0||exitSignal)reject(Error('command failed'));else resolve(Buffer.concat(chunks).toString('utf8'));
  });
  if(signal?.aborted)abort();
 });
}
