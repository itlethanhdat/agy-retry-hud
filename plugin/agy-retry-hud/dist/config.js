import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {defaults} from './policy.js';import {DEFAULT_RESUME_MESSAGE,validateMessage} from './session.js';
export function pathsFor({platform=process.platform,home=os.homedir(),env=process.env}={}){
 if(platform==='win32'){const base=env.LOCALAPPDATA||path.join(home,'AppData','Local');return {config:path.join(base,'agy-retry','config.json'),data:path.join(base,'agy-retry','data')};}
 if(platform==='darwin'){const base=path.join(home,'Library','Application Support','agy-retry');return {config:path.join(base,'config.json'),data:path.join(base,'data')};}
 return {config:path.join(env.XDG_CONFIG_HOME||path.join(home,'.config'),'agy-retry','config.json'),data:path.join(env.XDG_STATE_HOME||path.join(home,'.local','state'),'agy-retry')};
}
export function validateConfig(c){
 validateMessage(c.message);
 for(const k of Object.keys(defaults)){const v=c[k];if(typeof v!=='number'||!Number.isSafeInteger(v)||v<(['resetMarginMs','jitterMs'].includes(k)?0:1)||v>2147483647)throw Error('invalid config value: '+k);}
 if(c.transientBaseMs>c.transientCapMs)throw Error('transientBaseMs exceeds cap');
 if(typeof c.executable!=='string'||!c.executable.trim()||/\.(?:cmd|bat)$/i.test(c.executable))throw Error('executable must be a native executable, not a shell script');
 if(!Array.isArray(c.prefixArgs)||c.prefixArgs.some(x=>typeof x!=='string'))throw Error('prefixArgs must be a string array');
 for(const k of ['quotaGroup','profileKey'])if(c[k]!==undefined&&(typeof c[k]!=='string'||!/^[-\w]{1,64}$/.test(c[k])))throw Error('invalid '+k);
 return c;
}
export function loadConfig({userPath=pathsFor().config,explicitPath,flags={}}={}){
 const read=(file,required)=>{try{const v=JSON.parse(fs.readFileSync(file,'utf8'));if(!v||Array.isArray(v)||typeof v!=='object')throw Error('config must be an object');return v;}catch(e){if(e.code==='ENOENT'&&!required)return {};throw e;}};
 const base={...defaults,message:DEFAULT_RESUME_MESSAGE,executable:'agy',prefixArgs:[]};
 const allowed=new Set([...Object.keys(base),'quotaGroup','profileKey']);
 const file={...read(userPath,false),...(explicitPath?read(explicitPath,true):{})};
 for(const k of Object.keys(file))if(!allowed.has(k))throw Error('unknown config key: '+k);
 return validateConfig({...base,...file,...Object.fromEntries(Object.entries(flags).filter(([,v])=>v!==undefined))});
}
