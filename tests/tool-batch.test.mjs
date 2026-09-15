import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { prepareRequest, parseReply, replyChunks } from '../plugins/dsh-web-bridge/protocol.js';
import { WebAdapter } from '../plugins/dsh-web-bridge/index.js';
import { Broker } from '../plugins/dsh-web-bridge/broker.js';
import { submitRemote } from '../plugins/dsh-web-bridge/remote.js';
const options = { messages: [], tools: [{ name: 'edit', parameters: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['file_path', 'old_string', 'new_string'], additionalProperties: false } }] };
const calls = () => Array.from({ length: 12 }, (_, i) => ({ name: 'edit', arguments: { file_path: 'fixture.html', old_string: 'before-' + i, new_string: 'after-' + i } }));
test('12 complete edits are accepted in model order, with no arbitrary call-count rejection', () => {
  const request = prepareRequest(options);
  const parsed = parseReply(JSON.stringify({ request_id: request.id, kind: 'tool_calls', calls: calls() }), request);
  assert.equal(parsed.calls.length, 12);
  assert.deepEqual(parsed.calls.map(c => JSON.parse(c.arguments).new_string), calls().map(c => c.arguments.new_string));
  assert.equal([...replyChunks(parsed)].filter(c => c.type === 'tool-call-delta').length, 12);
});
test('invalid twelfth call releases zero native tool chunks and gives the exact failing position', async () => {
  const batch = calls(); batch[11].arguments.new_string = 42;
  const chunks = [];
  const adapter = new WebAdapter({ submit: async r => JSON.stringify({ request_id: r.id, kind: 'tool_calls', calls: batch }) });
  await assert.rejects(async () => { for await (const c of adapter.stream(options)) chunks.push(c); }, e => e.code === 'WEB_TOOL_ARGUMENTS' && /12\/12/.test(e.message));
  assert.ok(chunks.every(c => c.type !== 'tool-call-delta' && c.type !== 'finish'));
});
test('reply kind, text, calls and identity failures have distinct diagnostics', () => {
  const r = prepareRequest(options);
  for (const [payload, code] of [[{ kind: 'bad' }, 'WEB_REPLY_KIND'], [{ kind: 'final', text: [] }, 'WEB_REPLY_TEXT'], [{ kind: 'tool_calls', calls: [] }, 'WEB_REPLY_CALLS'], [{ kind: 'tool_calls', calls: calls(), text: {} }, 'WEB_REPLY_TEXT'], [{ kind: 'final', text: 'done', request_id: 'old' }, 'WEB_REQUEST_ID']]) {
    assert.throws(() => parseReply(JSON.stringify({ request_id: r.id, ...payload }), r), { code });
  }
});
test('12 raw file bodies survive browser collection and original write schema validation', async () => {
  const r = prepareRequest({ messages: [], tools: [{ name: 'write', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } }] }, 'twelve-bodies');
  const batch = Array.from({ length: 12 }, (_, i) => ({ name: 'write', arguments: { file_path: 'fixture-' + i, content: { $body: 'file' + i } } }));
  const bodyBlocks = batch.map((_, i) => `DSH_BODY:${r.id}:file${i}\ncontent-${i}\nDSH_BODY_END:${r.id}:file${i}`);
  const manifest = JSON.stringify({ request_id: r.id, kind: 'tool_calls', calls: batch, body_format: 'dsh-text-v1' });
  const ctx = vm.createContext({ setTimeout, clearTimeout }); vm.runInContext(await readFile('extension/page.js', 'utf8'), ctx);
  const nodes = [manifest, ...bodyBlocks].map(textContent => ({ textContent, getClientRects: () => [1], closest: () => null }));
  const doc = { querySelectorAll: selector => selector === 'pre code, pre' ? nodes : [] };
  const collected = ctx.DSHBridgePage.scan(doc, new Map(), r.id).answer;
  const parsed = parseReply(collected, r);
  assert.equal(parsed.calls.length, 12);
  assert.equal(JSON.parse(parsed.calls[11].arguments).content, 'content-11');
});
test('remote preflight validates all calls without completing the job, supports correction, and records no argument contents', async () => {
  const token = randomBytes(32).toString('hex'), events = [];
  const broker = new Broker({ token, port: 0, timeoutMs: 5000, onEvent: e => events.push(e) }); await broker.start();
  let result;
  try {
    const request = prepareRequest(options);
    let wake; const queued = new Promise(resolve => { wake = resolve; });
    result = submitRemote({ token, port: broker.port }, request, undefined, wake);
    await queued;
    const post = async (path, body) => (await fetch(`http://127.0.0.1:${broker.port}${path}`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ clientId: 'batch-worker', version: '0.2.19', ...body }) })).json();
    const { job } = await post('/worker/poll', {}); assert.equal(job.replyValidation, 1);
    const batch = calls(); batch[11].arguments.new_string = 7;
    const invalid = JSON.stringify({ request_id: job.id, kind: 'tool_calls', calls: batch });
    const failed = await post('/job/' + job.id, { lease: job.lease, action: 'validate', text: invalid });
    assert.equal(failed.valid, false); assert.equal(failed.callIndex, 12); assert.equal(failed.callCount, 12); assert.equal(failed.correctable, true);
    assert.equal(broker.jobs.size, 1); assert.equal(events.filter(e => e.type === 'completed').length, 0);
    const stale = await post('/job/' + job.id, { lease: 'stale', action: 'validate', text: invalid }); assert.equal(stale.error, 'Stale lease');
    const valid = JSON.stringify({ request_id: job.id, kind: 'tool_calls', calls: calls() });
    assert.equal((await post('/job/' + job.id, { lease: job.lease, action: 'validate', text: valid })).valid, true);
    assert.equal(broker.jobs.size, 1);
    await post('/job/' + job.id, { lease: job.lease, action: 'result', text: valid });
    assert.equal(await result, valid);
    assert.ok(events.some(e => e.type === 'reply-validation' && !e.valid && e.callIndex === 12 && e.callCount === 12));
    assert.ok(!JSON.stringify(events).includes('fixture.html') && !JSON.stringify(events).includes('before-0'));
  } finally { await broker.close(); await result?.catch(() => {}); }
});

test('completion cannot bypass schema validation by omitting preflight', async () => {
  const token = randomBytes(32).toString('hex'), events = [];
  const broker = new Broker({ token, port: 0, timeoutMs: 5000, onEvent: e => events.push(e) }); await broker.start();
  let result;
  try {
    const request = prepareRequest(options);
    let wake; const queued = new Promise(resolve => { wake = resolve; });
    result = submitRemote({ token, port: broker.port }, request, undefined, wake);
    const rejected = assert.rejects(result, { code: 'WEB_TOOL_ARGUMENTS' });
    await queued;
    const post = async (path, body) => (await fetch(`http://127.0.0.1:${broker.port}${path}`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ clientId: 'batch-worker', version: '0.2.19', ...body }) })).json();
    const { job } = await post('/worker/poll', {});
    const batch = calls(); batch[11].arguments = null;
    const response = await post('/job/' + job.id, { lease: job.lease, action: 'result', text: JSON.stringify({ request_id: job.id, kind: 'tool_calls', calls: batch }) });
    assert.equal(response.ok, false); assert.match(response.error, /12\/12.*arguments/);
    await rejected;
    assert.equal(events.filter(e => e.type === 'completed').length, 0);
    assert.equal(events.filter(e => e.type === 'failed').length, 1);
    assert.ok(events.some(e => e.type === 'reply-validation' && e.stage === 'completion' && !e.valid));
  } finally { await broker.close(); await result?.catch(() => {}); }
});
