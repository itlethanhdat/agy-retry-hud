import {stripVTControlCharacters} from 'node:util';
import {emitKeypressEvents} from 'node:readline';
const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
const graphemes=s=>[...segmenter.segment(s)].map(x=>x.segment);
export function sanitize(text){return stripVTControlCharacters(String(text)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,'');}
function clip(text,width){let out='',used=0;for(const c of graphemes(sanitize(text).replace(/\n/g,' '))){const n=/[\p{Extended_Pictographic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(c)?2:1;if(used+n>width)break;used+=n;out+=c;}return out;}
function duration(ms){const s=Math.max(0,Math.ceil(ms/1000));return [Math.floor(s/3600),Math.floor(s/60)%60,s%60].map(n=>String(n).padStart(2,'0')).join(':');}
export function renderHUD(job={},width=80,now=Date.now()){
 const q=job.quota;const quota=q?.buckets?.map(b=>`${b.window}: ${Math.round(b.remainingFraction*100)}% left (reset ${duration(b.resetAt-now)})`).join(' | ')||'5h: unknown | weekly: unknown';
 const age=q&&now-q.observedAt>300000?' [stale]':'';
 const retry=job.nextRetryAt&&job.status?.startsWith('WAIT_')?` | retry in ${duration(job.nextRetryAt-now)} (${new Date(job.nextRetryAt).toLocaleString()})`:'';
 return [
  `AGY HUD + Retry | ${job.model||'model unknown'} | session ${(job.conversation||'new').slice(0,8)} | ${job.cwd?.split(/[\\/]/).pop()||''}`,
  `Context ${Number.isFinite(job.contextPercent)?Math.round(job.contextPercent)+'%':'unknown'} | ${quota}${age}`,
  `${job.status||'IDLE'}${job.paused?' [PAUSED]':''}${retry} | API ${job.transientRetries||0}/${job.config?.maxTransientRetries??6} | quota ${job.quotaRetries||0}/${job.config?.maxQuotaRetries??2}`
 ].map(s=>clip(s,Math.max(10,width))).join('\n');
}
export function parseInput(line){
 if(!line.startsWith(':'))return {kind:'prompt',value:line};
 const [command,...rest]=line.split(' ');const kind=command.slice(1);if(['pause','resume','cancel','quit','help'].includes(kind)&&!rest.length)return {kind};
 if(kind==='message')return {kind,value:rest.join(' ')};
 return {kind:'invalid'};
}
export class InputModel {
 value='';cursor=0;
 insert(text){text=sanitize(text).replace(/\n/g,' ');this.value=this.value.slice(0,this.cursor)+text+this.value.slice(this.cursor);this.cursor+=text.length;}
 move(direction){const before=graphemes(this.value.slice(0,this.cursor)),after=graphemes(this.value.slice(this.cursor));this.cursor+=direction<0?-(before.at(-1)?.length||0):(after[0]?.length||0);}
 backspace(){const n=graphemes(this.value.slice(0,this.cursor)).at(-1)?.length||0;this.value=this.value.slice(0,this.cursor-n)+this.value.slice(this.cursor);this.cursor-=n;}
 submit(busy){const a=parseInput(this.value);if(a.kind==='prompt'&&busy)return {kind:'busy'};this.value='';this.cursor=0;return a;}
}
// Dedicated terminal screen; the HUD timer has no access to model or quota APIs.
export class TerminalHUD {
 constructor({input=process.stdin,output=process.stdout,onAction=()=>{},plain=false}={}){
  Object.assign(this,{input,output,onAction});this.tty=Boolean(input.isTTY&&output.isTTY&&!plain&&!process.env.NO_COLOR);this.model=new InputModel();this.job={};this.lines=[];this.paste=false;this.closed=false;
  if(this.tty){emitKeypressEvents(input);input.setRawMode(true);input.resume();output.write('\x1b[?1049h\x1b[?2004h\x1b[?25l');
   this.listener=(str,key={})=>this.key(str,key);input.on('keypress',this.listener);this.resize=()=>this.draw();output.on('resize',this.resize);this.timer=setInterval(()=>this.draw(),1000);this.draw();}
 }
 setJob(j){const changed=this.job.status!==j.status||this.job.nextRetryAt!==j.nextRetryAt;this.job=j;if(!this.tty&&changed)this.output.write(renderHUD(j,120)+'\n');}
 log(text){text=sanitize(text);if(!this.tty){this.output.write(text);return;}this.lines.push(...text.split('\n'));if(this.lines.length>200)this.lines=this.lines.slice(-200);}
 key(str,key){
  if(key.name==='paste-start'){this.paste=true;return;}if(key.name==='paste-end'){this.paste=false;return;}
  if(this.paste){if(str)this.model.insert(str);return;}
  if(key.ctrl&&key.name==='c'){this.onAction({kind:'cancel'});return;}
  if(key.ctrl&&key.name==='d'){this.onAction({kind:'quit'});return;}
  if(key.name==='return'||key.name==='enter'){const busy=['RUNNING','WAIT_QUOTA','WAIT_BACKOFF'].includes(this.job.status);this.onAction(this.model.submit(busy));}
  else if(key.name==='left')this.model.move(-1);
  else if(key.name==='right')this.model.move(1);
  else if(key.name==='home')this.model.cursor=0;
  else if(key.name==='end')this.model.cursor=this.model.value.length;
  else if(key.name==='backspace')this.model.backspace();
  else if(str&&!key.ctrl&&!key.meta&&!str.startsWith('\x1b'))this.model.insert(str);
  this.draw();
 }
 draw(){if(!this.tty||this.closed)return;const width=Math.max(10,this.output.columns||80),height=Math.max(8,this.output.rows||24);
  const draft=clip(this.model.value.slice(0,this.model.cursor),width-4)+'|'+clip(this.model.value.slice(this.model.cursor),width-4);
  const lines=[renderHUD(this.job,width),'-'.repeat(width),...this.lines.slice(-(height-7)).map(x=>clip(x,width))];
  while(lines.join('\n').split('\n').length<height-3)lines.push('');
  lines.push(clip(this.job.reason||':pause :resume :cancel :message <text> :quit',width),clip('> '+draft,width));
  this.output.write('\x1b[H\x1b[2J'+lines.join('\n'));
 }
 close(){if(this.closed)return;this.closed=true;clearInterval(this.timer);if(this.tty){this.input.off('keypress',this.listener);this.output.off('resize',this.resize);this.input.setRawMode(false);this.input.pause();this.output.write('\x1b[?2004l\x1b[?25h\x1b[?1049l');}}
}
