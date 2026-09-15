import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const ctx = vm.createContext({}); vm.runInContext(await readFile('extension/inspect.js', 'utf8'), ctx);
const id = 'diagnostic-current';
test('read-only inspection reports nonstandard code layout without exposing commands', () => {
  const raw = JSON.stringify({ request_id: id, kind: 'tool_calls', calls: [{ name: 'pwsh', arguments: { command: 'PRIVATE_COMMAND_MUST_NOT_APPEAR' } }] });
  const node = { textContent: raw, innerText: raw, tagName: 'DIV', className: 'code-content', parentElement: { className: 'code-block' }, getClientRects: () => [1], closest: () => null, matches: () => false };
  const doc = { querySelectorAll: s => s === 'pre, code, [class*="code"]' ? [node] : [] };
  const result = ctx.DSHBridgeInspect.inspect(doc, id);
  assert.equal(result.records.length, 2); assert.ok(result.records.every(r => r.jsonValid && r.matchingId && !r.standard && r.callCount === 1));
  assert.equal(result.executed, false); assert.ok(!JSON.stringify(result).includes('PRIVATE_COMMAND'));
  node.closest = () => ({}); assert.equal(ctx.DSHBridgeInspect.inspect(doc, id).records.length, 0);
  node.closest = () => null; node.getClientRects = () => []; assert.equal(ctx.DSHBridgeInspect.inspect(doc, id).records.length, 0);
});
