import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const ctx = vm.createContext({ setTimeout, clearTimeout });
vm.runInContext(await readFile(new URL('../extension/page.js', import.meta.url), 'utf8'), ctx);
const page = ctx.DSHBridgePage;
const id = 'next-request';
function row(key, text = '') {
  return { textContent: text, getAttribute: () => key };
}
function markdown(parent, text, thinking = false) {
  return { innerText: text, textContent: text, getClientRects: () => [1],
    closest: selector => selector === '[data-virtual-list-item-key]' ? parent : thinking ? {} : null,
    matches: () => thinking, querySelector: () => null, querySelectorAll: () => [] };
}
function document(rows = [], nodes = []) {
  return { rows, nodes, querySelectorAll(selector) {
    return selector === '[data-virtual-list-item-key]' ? this.rows : selector === 'pre code, pre' ? [] : this.nodes;
  } };
}
test('remounted previous reply and thought are excluded by row ID, while current thought remains readable', () => {
  const old = row('old-assistant'); const raw = '{"request_id":"previous","kind":"final","text":"old"}';
  const doc = document([old], [markdown(old, raw)]);
  const baseline = page.capture(doc);
  const clone = row('old-assistant');
  const prompt = row('new-user', '你正在通过本机桥接为 DeepSeek Harness 完成用户任务。\n当前 REQUEST_ID: ' + id);
  const current = row('new-assistant');
  doc.rows = [clone, prompt, current]; doc.nodes = [markdown(clone, raw), markdown(clone, 'old thinking', true), markdown(current, 'new thinking', true)];
  let scan = page.scan(doc, baseline, id);
  assert.equal(scan.outputText, ''); assert.equal(scan.reasoning, 'new thinking'); assert.equal(scan.answer, null);
  const final = JSON.stringify({ request_id: id, kind: 'final', text: 'current' });
  // Prompt scrolls out of the virtualized list; current row is recreated too.
  const remounted = row('new-assistant'); doc.rows = [remounted]; doc.nodes = [markdown(remounted, final)];
  scan = page.scan(doc, baseline, id); assert.equal(scan.answer, final);
});
test('pre-existing same-ID reply is not accepted until the new correction prompt has arrived', () => {
  const old = row('first-reply');
  const raw = JSON.stringify({ request_id: id, kind: 'final', text: 'old same id' });
  const doc = document([old], [markdown(old, raw)]); const baseline = page.capture(doc);
  doc.rows = [row('first-reply')]; doc.nodes = [markdown(doc.rows[0], raw)];
  assert.equal(page.scan(doc, baseline, id).answer, null);
  const prompt = row('correction', '【仅纠正上一条回复的传输格式，1/1】\n当前 REQUEST_ID: ' + id);
  const current = row('corrected-reply'); doc.rows.push(prompt, current);
  const final = JSON.stringify({ request_id: id, kind: 'final', text: 'new' }); doc.nodes.push(markdown(current, final));
  assert.equal(page.scan(doc, baseline, id).answer, final);
});
test('current row with a genuinely wrong request ID stays invalid', () => {
  const doc = document(); const baseline = page.capture(doc);
  const prompt = row('user', '你正在通过本机桥接为 DeepSeek Harness 完成用户任务。\n当前 REQUEST_ID: ' + id);
  const current = row('answer'); const raw = '{"request_id":"wrong","kind":"final","text":"x"}';
  doc.rows = [prompt, current]; doc.nodes = [markdown(current, raw)];
  const scan = page.scan(doc, baseline, id); assert.equal(scan.answer, null); assert.equal(scan.outputText, raw);
});
