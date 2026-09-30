// Synthetic local subprocess implementing the published stream envelope only.
import readline from 'node:readline';
const args=process.argv.slice(2), mode=args.find(x=>x.startsWith('--fixture='))?.split('=')[1];
if(mode==='no-init') setInterval(()=>{},1000);
else {
 const id=args[args.indexOf('--conversation')+1]||'session-1';
 console.log(JSON.stringify({event:'init',conversation_id:mode==='wrong-id'?'wrong':id,init:{cwd:process.cwd(),permission_mode:'request-review'}}));
 const rl=readline.createInterface({input:process.stdin});
 rl.on('line',line=>{
  const m=JSON.parse(line);const status=mode==='error'?'ERROR':'SUCCESS';
  console.log(JSON.stringify({event:'result',result:{conversation_id:id,status,response:m.message.content,error:status==='ERROR'?'503 Service unavailable':undefined}}));
 });
}
