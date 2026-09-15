import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { prepareRequest, parseReply } from '../plugins/dsh-web-bridge/protocol.js';

const context = vm.createContext({ setTimeout, clearTimeout });
vm.runInContext(await readFile(new URL('../extension/page.js', import.meta.url), 'utf8'), context);
const id = 'raw-body-test';
const request = prepareRequest({ messages: [], tools: [{ name: 'write', parameters: {
  type: 'object', required: ['file_path', 'content'], additionalProperties: false,
  properties: { file_path: { type: 'string' }, content: { type: 'string' } }
} }] }, id);
const manifest = { request_id: id, body_format: 'dsh-text-v1', kind: 'tool_calls', calls: [{ name: 'write', arguments: { file_path: 'test.html', content: { $body: 'file1' } } }] };
const block = body => `DSH_BODY:${id}:file1\n${body}\nDSH_BODY_END:${id}:file1\n`;
const scan = (blocks, value = manifest) => {
  const nodes = [JSON.stringify(value), ...blocks].map(textContent => ({ textContent, getClientRects: () => [1], matches: () => false }));
  return context.DSHBridgePage.scan({ querySelectorAll: selector => selector === 'pre code, pre' ? nodes : [] }, new Map(), id);
};
const contents = [
  '', 'no trailing newline', '  leading and trailing spaces  ', 'one LF\n', 'two LFs\n\n',
  '<html lang="zh-CN">\n<script>const path="C:\\\\temp\\\\rider.html";\nconst text=`中文 ${marker}: "abc"`;\nconst regex=/[a-z_]+\\s+\\d+/g;\n</script>\n```html\n<div>&lt; &amp; \'</div>\n```\n'
];
test('raw fenced bodies survive page extraction and original schema validation exactly', () => {
  for (const content of contents) {
    const snapshot = scan([block(content)]);
    assert.ok(snapshot.answer);
    const reply = parseReply(snapshot.answer, request);
    assert.equal(JSON.parse(reply.calls[0].arguments).content, content);
  }
});
test('manifest alone, unfinished body, wrong request, missing and duplicate bodies cannot become calls', () => {
  for (const blocks of [[], [`DSH_BODY:${id}:file1\npartial`], [block('a').replaceAll(id, 'old-id')], [block('a'), block('a')]]) {
    assert.equal(scan(blocks).answer, null);
    assert.throws(() => parseReply(JSON.stringify({ ...manifest, body_blocks: blocks }), request));
  }
  assert.throws(() => parseReply(JSON.stringify(manifest), request));
});
test('body transport cannot bypass tool schema, tool names or reference validation', () => {
  const value = () => JSON.parse(JSON.stringify({ ...manifest, body_blocks: [block('body')] }));
  const bad = [];
  let reply = value(); reply.calls[0].arguments.file_path = 123; bad.push(reply);
  reply = value(); reply.calls[0].name = 'shell'; bad.push(reply);
  reply = value(); reply.calls[0].arguments.content.extra = true; bad.push(reply);
  reply = value(); reply.calls[0].arguments.content.$body = 'missing'; bad.push(reply);
  reply = value(); reply.kind = 'final'; reply.text = 'done'; bad.push(reply);
  reply = value(); reply.body_format = 'unknown'; bad.push(reply);
  reply = value(); reply.body_blocks[0] = block(`DSH_BODY_END:${id}:file1`); bad.push(reply);
  for (const invalid of bad) assert.throws(() => parseReply(JSON.stringify(invalid), request));
});
test('bare malformed JSON resembling the reported HTML reply is rejected without repair', () => {
  const malformed = `{"request_id":"${id}","kind":"tool_calls","calls":[{"name":"write","arguments":{"file_path":"test.html","content":"<html lang="zh-CN">"}}]}`;
  assert.throws(() => parseReply(malformed, request), /有效协议 JSON/);
});
