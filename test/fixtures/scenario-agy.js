import fs from 'node:fs';import readline from 'node:readline';
const file=process.argv[2],args=process.argv.slice(3),get=k=>{const i=args.indexOf(k);return i>=0?args[i+1]:undefined;};
const fixture=JSON.parse(fs.readFileSync(file,'utf8')),scenario=fixture.turns[fixture.sends.length]||{status:'SUCCESS'},id=get('--conversation')||'session-new';
console.log(JSON.stringify({event:'init',conversation_id:scenario.initID||id,init:{cwd:process.cwd(),model:get('--model'),agent:get('--agent'),permission_mode:'request-review'}}));
const rl=readline.createInterface({input:process.stdin});rl.on('line',line=>{
 const m=JSON.parse(line);fixture.sends.push({message:m.message.content,conversation:id});fs.writeFileSync(file,JSON.stringify(fixture));
 for(const step of scenario.steps||[])console.log(JSON.stringify({event:'step_update',step_update:{...step,conversation_id:id}}));
 if(scenario.nativeWarnings)process.stderr.write('native API retry attempt 1\nnative API retry attempt 2\n');
 console.log(JSON.stringify({event:'result',result:{conversation_id:id,status:scenario.status,response:scenario.response||'',error:scenario.error}}));
});
