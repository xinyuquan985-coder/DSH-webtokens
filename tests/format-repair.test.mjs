import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parseReply, prepareRequest } from '../plugins/dsh-web-bridge/protocol.js';
const read = name => readFile(new URL('../extension/' + name, import.meta.url), 'utf8');
const [repairSource, contentSource, pageSource, recordsSource] = await Promise.all(['repair.js','content.js','page.js','records.js'].map(read));
const id = 'repair-test';
const dsml = '<｜DSML｜calls><｜DSML｜invoke name="read"><｜DSML｜parameter name="file_path" string="true">fixture.txt</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜calls>';
async function scenario({ first = dsml, second, cancelBeforeCorrection = false, persistedRepair = false, growingThought = false, validation, protocolIssue } = {}) {
  let clock = 0, handler;
  const events = [], sends = [], storage = new Map(persistedRepair ? [['dsh-repair-' + id, 'sending']] : []);
  let settle; const done = new Promise(resolve => { settle = resolve; });
  class Input {
    get value() { return this._value ?? ''; } set value(v) { this._value = v; }
    isConnected = true; getClientRects() { return [1]; } focus() {}
    dispatchEvent(e) { if (e.type === 'keydown') { sends.push(this.value); this.value = ''; } }
  }
  const input = new Input();
  const sleep = async ms => { clock += ms; }; sleep.flush = () => {};
  const ctx = vm.createContext({
    Date: { now: () => clock }, setInterval: () => {}, HTMLTextAreaElement: Input,
    Event: class { constructor(type, options) { Object.assign(this, {type}, options); } },
    KeyboardEvent: class { constructor(type, options) { Object.assign(this, {type}, options); } },
    MutationObserver: class { observe() {} },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    document: { visibilityState: 'hidden', body: { innerText: '', append() {} }, getElementById: () => ({}),
      querySelectorAll: selector => selector === 'textarea' ? [input] : [], dispatchEvent() {} },
    chrome: { runtime: {
      onMessage: { addListener: listener => { handler = listener; } },
      sendMessage: async event => {
        events.push(event);
        if (event.action === 'validate') return validation(event.text);
        if (cancelBeforeCorrection && event.action === 'status' && storage.get('dsh-repair-' + id) === 'sending') { settle(); return { cancelled: true }; }
        if (event.action === 'error' || event.action === 'result') settle();
        return {};
      }
    } },
    DSHBridgePage: { createClock: () => sleep, capture: () => new Map(), scan: () => {
      const text = growingThought && clock > 70000 ? JSON.stringify({ request_id: id, kind: 'final', text: 'done after thinking' }) : sends.length === 1 ? first : second ?? JSON.stringify({ request_id: id, kind: 'tool_calls', calls: [{ name: 'read', arguments: { file_path: 'fixture.txt' } }] });
      let answer = null; try { const value = JSON.parse(text); if (value.request_id === id) answer = text; } catch {}
      return { answer, protocolIssue: answer ? null : protocolIssue, outputText: text, reasoning: growingThought && clock <= 70000 ? 'Thinking ' + clock : '', metrics: { visibility: 'hidden' } };
    } }
  });
  vm.runInContext(recordsSource, ctx); vm.runInContext(repairSource, ctx); vm.runInContext(contentSource, ctx);
  handler({ type: 'run', job: { id, prompt: 'Original task', replyFormat: 'json', replyValidation: validation ? 1 : undefined } }, {}, () => {});
  await done; await new Promise(resolve => setImmediate(resolve));
  return { sends, events, storage, input, ctx };
}
test('DSML is never executed; one format-only message precedes one validated tool request', async () => {
  const run = await scenario();
  assert.equal(run.sends.length, 2);
  assert.match(run.sends[0], /不能使用 DSML/);
  assert.match(run.sends[1], /仅纠正上一条回复/);
  assert.ok(!run.sends[1].includes('Original task'));
  assert.equal(run.events.filter(e => e.action === 'sent').length, 1);
  const result = run.events.filter(e => e.action === 'result'); assert.equal(result.length, 1);
  const request = prepareRequest({ messages: [], tools: [{ name: 'read', parameters: { type: 'object', required: ['file_path'], properties: { file_path: { type: 'string' } }, additionalProperties: false } }] }, id);
  assert.equal(parseReply(result[0].text, request).calls[0].name, 'read');
  assert.ok(run.events.some(e => /格式纠正 1\/1：已发送/.test(e.phase ?? '')));
});

test('missing closing brace gives the model the precise error and is never patched locally', async () => {
  const pageCtx = vm.createContext({}); vm.runInContext(pageSource, pageCtx);
  const supplied = JSON.parse(await readFile('tests/fixtures/reported-pwsh-0.2.15.json', 'utf8')); supplied.request_id = id;
  const raw = JSON.stringify(supplied), broken = raw.replace(/}\]}$/, ']}');
  const issue = pageCtx.DSHBridgePage.jsonIssue(broken, id);
  assert.equal(issue.expected, '}'); assert.equal(issue.actual, ']');
  const run = await scenario({ first: broken, second: raw, protocolIssue: issue });
  assert.equal(run.sends.length, 2); assert.ok(run.sends[1].includes(issue.message));
  assert.equal(run.events.filter(e => e.action === 'result')[0].text, raw);
  const fail = await scenario({ first: broken, second: broken, protocolIssue: issue });
  assert.equal(fail.sends.length, 2); assert.equal(fail.events.filter(e => e.action === 'result').length, 0);
  assert.ok(fail.events.find(e => e.action === 'error').error.includes(issue.message));
});

test('complete but invalid tool schema is corrected once before any result is released', async () => {
  const first = JSON.stringify({ request_id: id, kind: 'tool_calls', calls: [{ name: 'read', arguments: { file_path: 7 } }] });
  const request = prepareRequest({ messages: [], tools: [{ name: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }] }, id);
  const validation = raw => { try { parseReply(raw, request); return { valid: true }; } catch (e) { return { valid: false, correctable: true, message: e.message }; } };
  const run = await scenario({ first, validation });
  assert.equal(run.sends.length, 2); assert.match(run.sends[1], /第 1\/1 项工具参数/);
  const results = run.events.filter(e => e.action === 'result'); assert.equal(results.length, 1);
  assert.equal(parseReply(results[0].text, request).calls.length, 1);
  const invalidAgain = await scenario({ first, second: first, validation });
  assert.equal(invalidAgain.sends.length, 2); assert.equal(invalidAgain.events.filter(e => e.action === 'result').length, 0);
  const cancelled = await scenario({ first, validation, cancelBeforeCorrection: true });
  assert.equal(cancelled.sends.length, 1); assert.equal(cancelled.events.filter(e => e.action === 'result').length, 0);
});
test('second malformed reply terminates without a third submission or any tool result', async () => {
  const run = await scenario({ second: dsml });
  assert.equal(run.sends.length, 2);
  assert.equal(run.events.filter(e => e.action === 'result').length, 0);
  assert.match(run.events.find(e => e.action === 'error').error, /已进行 1 次格式纠正/);
});
test('wrong request ID and persisted uncertain correction fail closed without resubmission', async () => {
  for (const options of [{ first: '{"request_id":"other","kind":"final","text":"old"}' }, { persistedRepair: true }]) {
    const run = await scenario(options);
    assert.equal(run.sends.length, 1); assert.ok(run.events.some(e => e.action === 'error'));
    assert.ok(!run.events.some(e => e.action === 'result'));
  }
});
test('cancellation immediately before correction clears only our draft and sends no correction', async () => {
  const run = await scenario({ cancelBeforeCorrection: true });
  assert.equal(run.sends.length, 1); assert.equal(run.input.value, '');
  assert.ok(!run.events.some(e => e.action === 'result'));
});
test('valid original answer sends no correction', async () => {
  const run = await scenario({ first: JSON.stringify({ request_id: id, kind: 'final', text: 'done' }) });
  assert.equal(run.sends.length, 1); assert.equal(run.events.filter(e => e.action === 'result').length, 1);
});
test('growing thought prevents a stationary old body from causing premature error or correction', async () => {
  const run = await scenario({ growingThought: true, first: '{"request_id":"old-id","kind":"final","text":"stale"}' });
  assert.equal(run.sends.length, 1);
  assert.ok(!run.events.some(e => e.action === 'error'));
  assert.match(run.events.find(e => e.action === 'result').text, /done after thinking/);
});
test('nested request_id in tool data is not the transport request identifier', () => {
  const ctx = vm.createContext({}); vm.runInContext(recordsSource, ctx); vm.runInContext(repairSource, ctx);
  assert.equal(ctx.DSHBridgeRepair.failureKind(JSON.stringify({ request_id: id, kind: 'tool_calls', calls: [{ arguments: { request_id: 'data-field' } }] }), id), 'format');
  assert.equal(ctx.DSHBridgeRepair.failureKind(JSON.stringify({ request_id: 'old', kind: 'final', text: 'done' }), id), 'wrong-id');
});
test('correction cannot harvest old code or old body blocks with the same request ID', () => {
  const ctx = vm.createContext({ setTimeout, clearTimeout }); vm.runInContext(pageSource, ctx);
  const code = text => ({ textContent: text, getClientRects: () => [1], matches: () => false });
  const old = code(JSON.stringify({ request_id: id, kind: 'final', text: 'previous reply' }));
  const body = code(`DSH_BODY:${id}:file1\nold file\nDSH_BODY_END:${id}:file1`);
  let nodes = [old, body];
  const doc = { querySelectorAll: selector => selector === 'pre code, pre' ? nodes : [] };
  const baseline = ctx.DSHBridgePage.capture(doc);
  assert.equal(ctx.DSHBridgePage.scan(doc, baseline, id).answer, null);
  nodes.push(code(JSON.stringify({ request_id: id, kind: 'tool_calls', body_format: 'dsh-text-v1', calls: [{ name: 'write', arguments: { file_path: 'x', content: { $body: 'file1' } } }] })));
  assert.equal(ctx.DSHBridgePage.scan(doc, baseline, id).answer, null);
  nodes.push(code(`DSH_BODY:${id}:file1\nnew file\nDSH_BODY_END:${id}:file1`));
  const result = JSON.parse(ctx.DSHBridgePage.scan(doc, baseline, id).answer);
  assert.equal(result.body_blocks.length, 1); assert.match(result.body_blocks[0], /new file/);
});
