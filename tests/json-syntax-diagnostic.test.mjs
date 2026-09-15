import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const ctx = vm.createContext({}); vm.runInContext(await readFile('extension/page.js', 'utf8'), ctx);
const page = ctx.DSHBridgePage;
const supplied = (await readFile('tests/fixtures/reported-pwsh-0.2.15.json', 'utf8')).trim();
const id = JSON.parse(supplied).request_id;
test('one missing call-object brace reproduces the live 2248-character reply and error position 2246', () => {
  const broken = supplied.replace(/}\]}$/, ']}');
  assert.equal(broken.length, 2248);
  const issue = page.jsonIssue(broken, id);
  assert.equal(issue.position, 2246); assert.equal(issue.expected, '}'); assert.equal(issue.actual, ']');
  assert.equal(page.jsonIssue(supplied, id), null);
  assert.equal(page.jsonIssue(broken, 'wrong-id'), null);
  const code = { textContent: broken, getClientRects: () => [1], closest: () => null };
  const doc = { querySelectorAll: s => s === 'pre code, pre' ? [code] : [] };
  const result = page.scan(doc, new Map(), id);
  assert.equal(result.answer, null); assert.equal(result.protocolIssue.position, 2246);
  assert.ok(!JSON.stringify(issue).includes('Get-Content'));
});
test('braces, quotes and escapes inside JSON strings do not become structural errors', () => {
  const valid = JSON.stringify({ request_id: 'test', kind: 'final', text: '[]{} "quote" \\ trailing' });
  assert.equal(page.jsonIssue(valid, 'test'), null);
  const missingComma = '{"request_id":"test" "kind":"final"}';
  assert.equal(page.jsonIssue(missingComma, 'test').code, 'WEB_REPLY_JSON');
  assert.equal(page.jsonIssue(missingComma, 'test').expected, undefined);
});
