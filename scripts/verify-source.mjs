import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const manifest=JSON.parse(readFileSync(new URL('../SOURCE.json',import.meta.url)));
for(const [file,expected] of Object.entries(manifest.sha256)) assert.equal(createHash('sha256').update(readFileSync(new URL('../'+file,import.meta.url))).digest('hex'),expected,file);
console.log('Verified '+Object.keys(manifest.sha256).length+' baseline files: '+manifest.sourceCommit);
