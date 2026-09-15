import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Broker } from '../plugins/dsh-web-bridge/broker.js';
import { prepareRequest, parseReply, replyChunks } from '../plugins/dsh-web-bridge/protocol.js';
import { submitRemote } from '../plugins/dsh-web-bridge/remote.js';
const options = { messages: [{ role: 'user', content: [{ type: 'text', text: '读取文件' }], source: { kind: 'user' } }], tools: [{ name: 'read', description: 'read file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }] };

test('remote transport preserves broker timeout and propagates cancellation without retries', async () => {
  const token = randomBytes(32).toString('hex');
  const events = [];
  const broker = new Broker({ token, port: 0, timeoutMs: 60, onEvent: event => events.push(event) });
  await broker.start();
  const config = { token, port: broker.port, timeoutMs: 60 };
  try {
    await assert.rejects(submitRemote(config, prepareRequest(options)), { code: 'WEB_TIMEOUT' });
    assert.equal(events.filter(e => e.type === 'queued').length, 1);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(submitRemote(config, prepareRequest(options), controller.signal), { code: 'WEB_ABORTED' });
    assert.equal(events.filter(e => e.type === 'queued').length, 1);
  } finally { await broker.close(); }
});

test('protocol preserves real context and validates tool calls before emitting native chunks', () => {
  const request = prepareRequest(options);
  assert.match(request.prompt, /读取文件/);
  const reply = parseReply(JSON.stringify({ request_id: request.id, kind: 'tool_calls', calls: [{ name: 'read', arguments: { path: 'fixture.txt' } }] }), request);
  const chunks = [...replyChunks(reply)];
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
  assert.equal(chunks.find(c => c.type === 'block-end').block.arguments, '{"path":"fixture.txt"}');
  assert.throws(() => parseReply(JSON.stringify({ request_id: request.id, kind: 'tool_calls', calls: [{ name: 'exec', arguments: {} }] }), request), /不存在/);
  assert.throws(() => parseReply(JSON.stringify({ request_id: request.id, kind: 'tool_calls', calls: [{ name: 'read', arguments: { path: 3 } }] }), request), /参数/);
  assert.throws(() => parseReply(JSON.stringify({ request_id: 'old', kind: 'final', text: 'old response' }), request), /不匹配/);
  assert.throws(() => parseReply('not json', request), /JSON/);
});
test('tool results survive serialization; context overflow and unsupported options fail explicitly', () => {
  const request = prepareRequest({ messages: [{ role: 'user', source: { kind: 'tool' }, content: [{ type: 'tool-result', toolCallId: 'a', content: [{ type: 'text', text: 'random-secret-marker' }] }] }] });
  assert.match(request.prompt, /random-secret-marker/); assert.match(request.prompt, /tool-result/);
  assert.throws(() => prepareRequest({ ...options, stop: ['END'] }), /不支持/);
  assert.throws(() => prepareRequest({ ...options, system: 'x'.repeat(100001) }), /上限/);
});
test('broker authenticates, serializes work, cancels and rejects stale replies', async () => {
  const token = randomBytes(32).toString('hex'); const broker = new Broker({ token, port: 0, timeoutMs: 10000 }); await broker.start();
  const base = 'http://127.0.0.1:' + broker.port;
  const post = async (path, body, auth = token, origin) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + auth, ...(origin ? { origin } : {}) }, body: JSON.stringify({ clientId: 'test-worker', version: '0.2.19', ...body }) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  try {
    assert.equal((await post('/worker/poll', {}, 'wrong')).status, 401);
    assert.equal((await post('/worker/poll', {}, token, 'https://evil.example')).status, 403);
    const controller = new AbortController();
    const r1 = prepareRequest(options); const r2 = prepareRequest(options);
    const p1 = broker.submit(r1, controller.signal); const rejected = assert.rejects(p1, /取消/); const p2 = broker.submit(r2);
    const first = (await post('/worker/poll', {})).body.job; assert.equal(first.id, r1.id);
    assert.equal((await post('/worker/poll', {})).body.job, null);
    assert.equal((await post('/job/' + first.id, { lease: 'wrong', action: 'result', text: 'fake' })).status, 409);
    controller.abort(); await rejected;
    assert.equal((await post('/job/' + first.id, { lease: first.lease, action: 'result', text: 'late' })).status, 410);
    const second = (await post('/worker/poll', {})).body.job; assert.equal(second.id, r2.id);
    const actual = JSON.stringify({ request_id: second.id, kind: 'final', text: 'actual response' });
    await post('/job/' + second.id, { lease: second.lease, action: 'result', text: actual });
    assert.equal(await p2, actual);
  } finally { await broker.close(); }
});

test('old extension is rejected before dispatching a capacity-managed job', async () => {
  const token = randomBytes(32).toString('hex'); const broker = new Broker({ token, port: 0 }); await broker.start();
  try {
    const request = prepareRequest(options);
    const pending = broker.submit(request);
    const rejected = assert.rejects(pending, { code: 'WEB_EXTENSION_UPDATE' });
    const response = await fetch(`http://127.0.0.1:${broker.port}/worker/poll`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ clientId: 'old-worker', version: '0.2.13' }) });
    assert.equal((await response.json()).job, null); await rejected;
    assert.equal(broker.jobs.size, 0); assert.equal(broker.active, null);
  } finally { await broker.close(); }
});

test('website conversation audit records only the official origin and path', async () => {
  const events = [], broker = new Broker({ token: 'x'.repeat(40), onEvent: event => events.push(event) });
  const request = prepareRequest(options), pending = broker.submit(request), job = broker.jobs.get(request.id);
  broker.progress(job, { url: 'https://chat.deepseek.com/a/chat/s/chat-id?private=value#secret' });
  broker.progress(job, { url: 'https://evil.example/private' });
  broker.progress(job, { url: 'https://chat.deepseek.com/a/chat/s/chat-id?different=value' });
  broker.progress(job, { url: 'https://chat.deepseek.com/' });
  broker.finish(job, null, 'done'); await pending;
  assert.deepEqual(events.filter(e => e.type === 'website-conversation').map(e => e.url), ['https://chat.deepseek.com/a/chat/s/chat-id']);
  assert.equal(broker.panel().detail.websiteUrl, 'https://chat.deepseek.com/a/chat/s/chat-id');
  assert.ok(!JSON.stringify(events).includes('private=value'));
});
