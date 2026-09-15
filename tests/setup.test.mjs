import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from '../bin/dsh-web-bridge.mjs';

test('setup pairs a real profile, preserves unrelated settings, and remains idempotent', async () => {
 const dir=await mkdtemp(join(tmpdir(),'dsh-package-'));
 try {
  await writeFile(join(dir,'package.json'),JSON.stringify({dsh:{profile:{bundles:[]}}}));
  const original='- id: agent-default-model\n  config:\n    provider: existing\n    model: keep-me\n';
  await writeFile(join(dir,'cordis.patch.yml'),original);
  const result=await setup(['--profile-dir',dir]);
  const patch=await readFile(join(dir,'cordis.patch.yml'),'utf8');
  assert.ok(patch.startsWith(original));assert.equal(result.chromeVersion,'0.2.19');
  const config=JSON.parse(await readFile(join(result.chromeDir,'local-config.json'),'utf8'));
  assert.match(config.token,/^[A-Za-z0-9_-]{43}$/);assert.ok(patch.includes(config.token));
  assert.equal(JSON.parse(await readFile(join(result.chromeDir,'manifest.json'),'utf8')).version,'0.2.19');
  await setup(['--profile-dir',dir]);
  assert.equal(await readFile(join(dir,'cordis.patch.yml'),'utf8'),patch);
  assert.equal(JSON.parse(await readFile(join(result.chromeDir,'local-config.json'),'utf8')).token,config.token);
 } finally {await rm(dir,{recursive:true,force:true});}
});
test('setup handles empty YAML and rejects an existing manual bridge or a non-profile',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dsh-empty-'));
 try{
  await writeFile(join(dir,'package.json'),'{}');
  await assert.rejects(setup(['--profile-dir',dir]),/profile|指定/);
  await writeFile(join(dir,'package.json'),JSON.stringify({dsh:{profile:{}}}));
  await writeFile(join(dir,'cordis.patch.yml'),'# empty\n[]\n');
  await setup(['--profile-dir',dir]);
  assert.ok(!(await readFile(join(dir,'cordis.patch.yml'),'utf8')).includes('[]'));
  const manual='- insert:\n    - id: deepseek-web-bridge\n      name: dsh-web-bridge\n';
  await writeFile(join(dir,'cordis.patch.yml'),manual);
  await assert.rejects(setup(['--profile-dir',dir]),/手工配置/);
  assert.equal(await readFile(join(dir,'cordis.patch.yml'),'utf8'),manual);
 }finally{await rm(dir,{recursive:true,force:true});}
});
