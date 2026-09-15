import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parseReply } from '../plugins/dsh-web-bridge/protocol.js';
const ctx = vm.createContext({ setTimeout, clearTimeout });
for (const name of ['records', 'page', 'repair']) vm.runInContext(await readFile(new URL(`../extension/${name}.js`, import.meta.url), 'utf8'), ctx);
const original = (await readFile(new URL('./fixtures/reported-0.2.12-final.json', import.meta.url), 'utf8')).trim();
const displayed = await readFile(new URL('./fixtures/reported-0.2.12-final-rendered.txt', import.meta.url), 'utf8');
const id = JSON.parse(original).request_id;
const request = { id, validators: new Map() };
function scan(text, fenced) {
  const node = { innerText: text, textContent: text, getClientRects: () => [1], matches: () => false, querySelector: () => null, querySelectorAll: () => [] };
  const doc = { querySelectorAll: selector => selector === '[data-virtual-list-item-key]' ? [] : selector === 'pre code, pre' ? fenced ? [node] : [] : fenced ? [] : [node] };
  return ctx.DSHBridgePage.scan(doc, new Map(), id);
}
test('reported final is valid, but Markdown-rendered backslashes are rejected without guessing', () => {
  assert.equal(parseReply(original, request).kind, 'final');
  assert.throws(() => parseReply(displayed, request));
  assert.equal(scan(displayed, false).answer, null);
});
test('the same final in a code block preserves paths, inline backticks and escaped newlines exactly', () => {
  const answer = scan(original, true).answer;
  assert.equal(answer, original);
  assert.deepEqual(parseReply(answer, request), parseReply(original, request));
});
test('initial reminder and single correction both show complete fenced tool and final examples', () => {
  for (const prompt of [ctx.DSHBridgeRepair.formatReminder(id), ctx.DSHBridgeRepair.correctionPrompt(id)]) {
    const examples = [...prompt.matchAll(/^```json\n([^]*?)\n```$/gm)].map(match => JSON.parse(match[1]));
    assert.deepEqual(examples.map(value => value.kind), ['final']);
    assert.ok(examples.every(value => value.request_id === id));
    const record = [...prompt.matchAll(/^```text\n([^]*?)\n```$/gm)][0][1];
    assert.equal(ctx.DSHCallRecords.parse(record, id).calls.length, 2);
  }
});
