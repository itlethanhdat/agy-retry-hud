#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {installAndWire,wireStatusLine,setupDoctor,repairSetup} from './dist/setup.js';
const here=path.dirname(fileURLToPath(import.meta.url)),argv=process.argv.slice(2),cmd=argv.find(x=>!x.startsWith('--'))||'doctor',force=argv.includes('--force-statusline');
try{
 let out;
 if(cmd==='install')out=installAndWire({sourceDir:here,force});
 else if(cmd==='enable')out=wireStatusLine({force});
 else if(cmd==='repair')out=repairSetup({force});
 else if(cmd==='doctor')out=setupDoctor();
 else throw Error('usage: setup.js install [--force-statusline] | enable [--force-statusline] | repair [--force-statusline] | doctor');
 process.stdout.write(JSON.stringify(out,null,2)+'\n');
}catch(e){process.stderr.write((e?.message||String(e))+'\n');process.exitCode=2;}
