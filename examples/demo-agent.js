// User-facing simulator for `agy-retry demo`. No network or credentials.
import fs from 'node:fs';import readline from 'node:readline';
const file=process.argv[2],args=process.argv.slice(3),i=args.indexOf('--conversation'),id=i>=0?args[i+1]:'demo-session';
console.log(JSON.stringify({event:'init',conversation_id:id,init:{cwd:process.cwd(),permission_mode:'request-review'}}));
const rl=readline.createInterface({input:process.stdin});rl.on('line',()=>{
 const n=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8')):0;fs.writeFileSync(file,String(n+1));
 console.log(JSON.stringify({event:'result',result:{conversation_id:id,status:n?'SUCCESS':'ERROR',error:n?undefined:'503 Service unavailable',response:n?'Demo complete: resumed the same conversation once.':'Demo: simulated API error; waiting before retry.'}}));
});
