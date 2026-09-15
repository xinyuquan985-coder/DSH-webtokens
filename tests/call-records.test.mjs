import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { prepareRequest, parseReply } from '../plugins/dsh-web-bridge/protocol.js';
const ctx = vm.createContext({});
for (const file of ['records','page']) vm.runInContext(await readFile(`extension/${file}.js`, 'utf8'), ctx);
const id = 'record-current';
const request = prepareRequest({ messages: [], tools: [{ name: 'pwsh', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command','description'], additionalProperties: false } }] }, id);
const command = JSON.parse(await readFile('tests/fixtures/reported-pwsh-0.2.15.json', 'utf8')).calls[0].arguments.command + '\n';
const manifest = `DSH_CALLS_BEGIN:${id}:2\nDSH_CALL:1:pwsh\n{"command":{"$body":"cmd1"},"description":"first"}\nDSH_CALL:2:pwsh\n{"command":{"$body":"cmd2"},"description":"second"}\nDSH_CALLS_END:${id}:2`;
const body = (name, text) => `DSH_BODY:${id}:${name}\n${text}\nDSH_BODY_END:${id}:${name}`;
function collect(record = manifest, bodies = [body('cmd1',command),body('cmd2','Write-Output \'$quoted " [ ] { }\'')]) {
  const nodes = [record,...bodies].map(textContent => ({ textContent, getClientRects: () => [1], closest: () => null }));
  return ctx.DSHBridgePage.scan({ querySelectorAll: s => s === 'pre code, pre' ? nodes : [] }, new Map(), id);
}
test('shared records parser is identical; complex raw PowerShell survives complete browser and server validation', async () => {
  assert.equal(await readFile('extension/records.js','utf8'), await readFile('plugins/dsh-web-bridge/records.js','utf8'));
  const result = collect(); assert.ok(result.answer);
  const parsed = parseReply(result.answer, request);
  assert.equal(parsed.calls.length, 2); assert.equal(JSON.parse(parsed.calls[0].arguments).command, command);
  assert.ok(JSON.parse(result.answer).call_records.startsWith('DSH_CALLS_BEGIN:'));
});
test('partial, wrong count, wrong order, wrong ID and missing or duplicate bodies cannot release records', () => {
  for (const value of [manifest.slice(0,-1),manifest.replace(':2\n',':3\n'),manifest.replace('DSH_CALL:2:','DSH_CALL:1:'),manifest.replaceAll(id,'old')]) assert.equal(collect(value).answer,null);
  assert.equal(collect(manifest,[body('cmd1',command)]).answer,null);
  assert.equal(collect(manifest,[body('cmd1',command),body('cmd1',command)]).answer,null);
});
test('server independently rejects tampered record manifest and invalid original tool arguments', () => {
  const packet = JSON.parse(collect().answer);
  packet.calls[0].name = 'another-tool'; assert.throws(() => parseReply(JSON.stringify(packet),request),/不一致/);
  const bad = manifest.replace('"description":"second"','"description":42');
  const answer = collect(bad).answer; assert.ok(answer); assert.throws(() => parseReply(answer, request), { code:'WEB_TOOL_ARGUMENTS' });
});
test('record parser accepts twelve calls without an arbitrary count cap and rejects duplicate metadata', () => {
  const raw = `DSH_CALLS_BEGIN:${id}:12\n` + Array.from({length:12},(_,i)=>`DSH_CALL:${i+1}:read\n{"file_path":"fixture-${i}"}`).join('\n') + `\nDSH_CALLS_END:${id}:12`;
  assert.equal(ctx.DSHCallRecords.parse(raw,id).calls.length,12);
  assert.throws(()=>ctx.DSHCallRecords.parse(raw.replace('DSH_CALL:2:','DSH_CALL:1:'),id),/序号/);
});
