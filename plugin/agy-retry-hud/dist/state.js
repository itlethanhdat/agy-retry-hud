import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

export const keyFor=(...parts)=>createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export function atomicJSON(file,value){
 const text=JSON.stringify(value,null,2);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
 const tmp=file+'.'+randomUUID()+'.tmp';let fd;
 try{fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,text,'utf8');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(tmp,file);}
 finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp);}catch{}}
}
export class Store {
 constructor(dir){this.dir=dir;fs.mkdirSync(dir,{recursive:true,mode:0o700});}
 file(id){if(typeof id!=='string'||!/^[\w-]{1,128}$/.test(id))throw Error('invalid job ID');return path.join(this.dir,id+'.json');}
 save(state){if(state.schemaVersion!==1)throw Error('unsupported state schema');atomicJSON(this.file(state.id),state);}
 load(id){const s=JSON.parse(fs.readFileSync(this.file(id),'utf8'));if(s.schemaVersion!==1||s.id!==id)throw Error('invalid state schema');return s;}
 list(){return fs.readdirSync(this.dir).filter(x=>/^[\w-]+\.json$/.test(x)).map(f=>{try{return this.load(f.slice(0,-5));}catch{return null;}}).filter(Boolean);}
}
function lockPath(dir,key){return path.join(dir,keyFor(key)+'.lock');}
export function acquire(dir,key){
 fs.mkdirSync(dir,{recursive:true,mode:0o700});const file=lockPath(dir,key);const nonce=randomUUID();
 try{fs.mkdirSync(file,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw Error('session locked; inspect owner, use unlock only after it exits');throw e;}
 try{atomicJSON(path.join(file,'owner.json'),{pid:process.pid,nonce,createdAt:Date.now()});}catch(e){fs.rmSync(file,{recursive:true,force:true});throw e;}
 return {release(){const owner=JSON.parse(fs.readFileSync(path.join(file,'owner.json'),'utf8'));if(owner.nonce!==nonce)throw Error('lock ownership changed');fs.rmSync(file,{recursive:true});}};
}
// Explicit recovery only. Never infer ownership from age; PID reuse conservatively blocks recovery.
export function releaseDeadLock(dir,key){
 const file=lockPath(dir,key);const owner=JSON.parse(fs.readFileSync(path.join(file,'owner.json'),'utf8'));
 if(!Number.isInteger(owner.pid)||owner.pid<=0)throw Error('invalid lock owner; inspect manually');
 try{process.kill(owner.pid,0);throw Error('lock owner still alive');}catch(e){if(e.code!=='ESRCH')throw e;}
 const again=JSON.parse(fs.readFileSync(path.join(file,'owner.json'),'utf8'));if(again.nonce!==owner.nonce)throw Error('lock changed');fs.rmSync(file,{recursive:true});
}
