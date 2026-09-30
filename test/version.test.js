import test from 'node:test';import assert from 'node:assert/strict';
import {compareSemver,parseSemver,versionAtLeast,MIN_AGY_VERSION} from '../src/version.js';

test('AGY version parsing is conservative and enforces stream-input minimum',()=>{
 assert.deepEqual(parseSemver('agy 1.2.13'),[1,2,13]);
 assert.deepEqual(parseSemver('antigravity-cli v1.1.15'),[1,1,15]);
 assert.equal(parseSemver('dev build'),null);
 assert.equal(compareSemver([1,2,0],[1,1,99]),1);
 assert.equal(versionAtLeast('agy 1.1.15'),true);
 assert.equal(versionAtLeast('agy 1.1.14'),false);
 assert.equal(versionAtLeast('agy 1.2.13'),true);
 assert.equal(versionAtLeast('unknown'),false);
 assert.equal(MIN_AGY_VERSION,'1.1.15');
});
