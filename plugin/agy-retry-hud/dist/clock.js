import {setTimeout as sleep} from 'node:timers/promises';
export class Clock {
 constructor(deps={}){this.now=deps.now||Date.now;this.mono=deps.mono||(()=>performance.now());this.sleep=deps.sleep||((ms,signal)=>sleep(ms,undefined,{signal}));}
 async waitUntil(at,signal){
  const startWall=this.now(),startMono=this.mono();
  for(;;){signal?.throwIfAborted();const now=this.now();
   if(now-(startWall+this.mono()-startMono)<-300000)throw Error('clock moved backwards; retry paused');
   if(now>=at)return;await this.sleep(Math.min(1000,at-now),signal);
  }
 }
}
