import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { prepareRequest, parseReply } from '../plugins/dsh-web-bridge/protocol.js';

const context = vm.createContext({ setTimeout, clearTimeout });
vm.runInContext(await readFile(new URL('../extension/page.js', import.meta.url), 'utf8'), context);
const page = context.DSHBridgePage;
const id = 'e6f42388-a6a7-4d3c-bc88-f47000082e65';
// Exact user-supplied body; browsers render Markdown line endings as LF.
const supplied = await readFile(new URL('./fixtures/reported-0.2.11-body.txt', import.meta.url), 'utf8');
const body = supplied.replace(/\r\n/g, '\n');
// Transport fields transcribed from the screenshot, not claimed as captured DOM.
const manifest = { request_id: id, kind: 'tool_calls', body_format: 'dsh-text-v1', calls: [{ name: 'write', arguments: { file_path: 'logs/scope-0.2.11-pelican.html', content: { $body: 'file1' } } }] };
const request = prepareRequest({ messages: [], tools: [{ name: 'write', parameters: {
  type: 'object', required: ['file_path', 'content'], additionalProperties: false,
  properties: { file_path: { type: 'string' }, content: { type: 'string' } }
} }] }, id);

function fixture({ value = manifest, rawBody = body, oldBody = false, thinking = false, hidden = false } = {}) {
  const row = (key, textContent = '') => ({ textContent, getAttribute: () => key });
  const old = row('old-answer');
  const prompt = row('correction', '【仅纠正上一条回复的传输格式，1/1】\n当前 REQUEST_ID: ' + id);
  const current = row('current-answer');
  const node = (textContent, parent, thought = false, shown = true) => ({
    textContent, innerText: textContent, getClientRects: () => shown ? [1] : [],
    closest: selector => selector === '[data-virtual-list-item-key]' ? parent : thought && selector.includes('think') ? {} : null,
    matches: selector => thought && selector.includes('think'), querySelector: () => null, querySelectorAll: () => []
  });
  const block = node(rawBody, oldBody ? old : current);
  const paragraph = node(JSON.stringify(value), current, thinking, !hidden);
  const markdown = node(paragraph.innerText + '\ntext 复制 下载\n' + rawBody, current);
  markdown.querySelectorAll = selector => selector === 'pre code, pre' ? oldBody ? [] : [block] : selector === 'p, .ds-markdown-paragraph' ? [paragraph] : [];
  // A wrapper can include thinking nodes; they must not become output candidates.
  markdown.querySelector = selector => thinking && selector.includes('think') ? paragraph : null;
  const doc = { rows: [old], nodes: [], blocks: oldBody ? [block] : [], visibilityState: 'hidden', querySelectorAll(selector) {
    return selector === '[data-virtual-list-item-key]' ? this.rows : selector === 'pre code, pre' ? this.blocks : this.nodes;
  } };
  const baseline = page.capture(doc);
  doc.rows = [old, prompt, current]; doc.nodes = [markdown]; doc.blocks = [block];
  return { doc, baseline, paragraph, block, markdown, current };
}

test('reported bare JSON paragraph plus full text block survives extraction and tool validation', () => {
  const { doc, baseline } = fixture();
  const snapshot = page.scan(doc, baseline, id);
  assert.ok(snapshot.answer, 'bare manifest was omitted');
  const content = JSON.parse(parseReply(snapshot.answer, request).calls[0].arguments).content;
  assert.equal(content, body.slice(body.indexOf('\n') + 1, body.lastIndexOf('\nDSH_BODY_END:')));
  assert.ok(Buffer.byteLength(content) > 15000);
});

test('bare manifest cannot use old same-ID body, wrong ID, partial body, thought or hidden paragraph', () => {
  for (const options of [{ oldBody: true }, { value: { ...manifest, request_id: 'wrong' } },
    { rawBody: body.slice(0, body.indexOf('DSH_BODY_END:')) }, { thinking: true }, { hidden: true }]) {
    const { doc, baseline } = fixture(options);
    assert.equal(page.scan(doc, baseline, id).answer, null, JSON.stringify(options).slice(0, 100));
  }
});

test('duplicate body or body from a different current row cannot satisfy bare manifest', () => {
  const f = fixture();
  f.doc.blocks.push({ ...f.block });
  assert.equal(page.scan(f.doc, f.baseline, id).answer, null);
  f.doc.blocks.pop();
  const other = { getAttribute: () => 'other-answer', textContent: '' };
  f.doc.rows.push(other);
  f.block.closest = selector => selector === '[data-virtual-list-item-key]' ? other : null;
  assert.equal(page.scan(f.doc, f.baseline, id).answer, null);
});

test('malformed or nested JSON paragraphs are never repaired or unwrapped', () => {
  for (const raw of [JSON.stringify({ wrapper: manifest }), JSON.stringify(manifest).slice(0, -1), '说明 ' + JSON.stringify(manifest)]) {
    const f = fixture(); f.paragraph.innerText = raw; f.paragraph.textContent = raw;
    f.markdown.innerText = raw + '\ntext\n' + body;
    assert.equal(page.scan(f.doc, f.baseline, id).answer, null);
  }
});
