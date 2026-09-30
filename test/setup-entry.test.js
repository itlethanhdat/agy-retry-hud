import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
function temp(prefix='agy-setup-entry-'){return fs.mkdtempSync(path.join(os.tmpdir(),prefix));}

function decodeIfEncoded(cmd){
 const m=String(cmd||'').match(/(?:^|\s)-(?:EncodedCommand|enc)\s+([A-Za-z0-9+/=]+)/i);
 return m?Buffer.from(m[1],'base64').toString('utf16le'):String(cmd||'');
}

test('packaged setup.js performs plugin install plus statusline wiring in one command',()=>{
 const home=temp(),bin=temp('agy-bin-'),fake=path.join(bin,'agy');
 fs.writeFileSync(fake,`#!/usr/bin/env node\nconst fs=require('fs'),path=require('path');const a=process.argv.slice(2);if(a[0]!=='plugin')process.exit(2);if(a[1]==='validate')process.exit(fs.existsSync(path.join(a[2],'plugin.json'))?0:2);if(a[1]==='install'){const dst=path.join(process.env.HOME,'.gemini','antigravity-cli','plugins','agy-retry-hud');fs.rmSync(dst,{recursive:true,force:true});fs.mkdirSync(path.dirname(dst),{recursive:true});fs.cpSync(a[2],dst,{recursive:true});process.exit(0)}process.exit(2);\n`);fs.chmodSync(fake,0o755);
 const setup=path.resolve('plugin/agy-retry-hud/setup.js'),r=spawnSync(process.execPath,[setup,'install'],{encoding:'utf8',env:{...process.env,AGY_BIN:fake,HOME:home,USERPROFILE:home,PATH:bin+path.delimiter+process.env.PATH}});
 assert.equal(r.status,0,r.stderr);const out=JSON.parse(r.stdout);assert.equal(out.pluginDir,path.join(home,'.gemini','antigravity-cli','plugins','agy-retry-hud'));const settings=JSON.parse(fs.readFileSync(path.join(home,'.gemini','antigravity-cli','settings.json'),'utf8'));assert.equal(settings.statusLine.enabled,true);assert.match(decodeIfEncoded(settings.statusLine.command),/agy-retry-hud.*native-entry\.js.*statusline/);
});
