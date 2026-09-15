import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Broker } from '../plugins/dsh-web-bridge/broker.js';
import { WebAdapter } from '../plugins/dsh-web-bridge/index.js';
import { submitRemote } from '../plugins/dsh-web-bridge/remote.js';
import { prepareRequest, parseReply } from '../plugins/dsh-web-bridge/protocol.js';
import { ensureBridgeTab, showBridgeTab, pageHealthState } from '../extension/tabs.js';

const options = { sessionId: 'test', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], tools: [] };

test('brief missing page health during activation waits without redispatching; persistent loss fails', () => {
  const active = { id: 'current', dispatched: true, healthMissingAt: 1000 };
  assert.equal(pageHealthState(active, null, 2000), 'waiting');
  assert.equal(pageHealthState(active, {}, 15999), 'waiting');
  assert.equal(pageHealthState(active, { activeId: 'current' }, 16000), 'alive');
  assert.equal(pageHealthState(active, null, 16000), 'lost');
  assert.equal(pageHealthState(active, { activeId: 'different-request' }, 2000), 'lost');
});

test('transport and invalid-JSON failures leave a visible terminal message without pretending success', async () => {
  for (const transportFailure of [true, false]) {
    const adapter = new WebAdapter({ submit: async (_request, _signal, progress) => {
      progress({ phase: '网页正在生成回复', reasoning: 'visible thought' });
      if (transportFailure) throw Object.assign(new Error('网页正文已停止更新，但没有有效的本轮协议 JSON'), { code: 'WEB_PAGE_ERROR' });
      return 'invalid JSON';
    } });
    const chunks = [];
    await assert.rejects(async () => { for await (const chunk of adapter.stream(options)) chunks.push(chunk); });
    const terminal = chunks.at(-1);
    assert.equal(terminal.type, 'block-end');
    assert.equal(terminal.block.type, 'text');
    assert.match(terminal.block.text, /网页桥接已停止/);
    assert.equal(terminal.index, 1);
    assert.ok(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'reasoning'));
    assert.ok(chunks.every(chunk => chunk.type !== 'finish' && chunk.type !== 'tool-call-delta'));
  }
});
const pageContext = vm.createContext({ setTimeout, clearTimeout });
vm.runInContext(await readFile(new URL('../extension/page.js', import.meta.url), 'utf8'), pageContext);
const page = pageContext.DSHBridgePage;

test('background wake advances a due page wait even when its timer never fires', async () => {
  let time = 0, finished = false;
  const sleep = page.createClock(() => time, () => 1, () => {});
  const wait = sleep(200).then(() => { finished = true; });
  time = 199; sleep.flush(); await Promise.resolve(); assert.equal(finished, false);
  time = 250; sleep.flush(); await wait; assert.equal(finished, true);
});

function markdown(text, code = [], shown = true, thinking = false) {
  return { innerText: text, matches: () => thinking, closest: () => thinking ? {} : null, getClientRects: () => shown ? [1] : [], querySelector: () => null, querySelectorAll: selector => selector === 'pre code, pre' ? code.map(textContent => ({ textContent })) : [] };
}
test('page extraction preserves fenced code, isolates this turn and excludes hidden text and prompts', () => {
  const id = 'current';
  const html = '<script>const x = "C:\\tmp\\a"; const y = `quoted`;\n</script>';
  const json = JSON.stringify({ request_id: id, kind: 'final', text: html });
  const previous = markdown('previous private conversation');
  const prompt = markdown('你正在通过本机桥接为 DeepSeek Harness 完成用户任务。request_id=current');
  const thinking = markdown('我先核对需求，再生成文件。', [], true, true);
  const hidden = markdown('hidden application state', [], false);
  const answer = markdown('json 复制代码 ' + json, [json]);
  const doc = { querySelectorAll: () => [previous, prompt, thinking, hidden, answer] };
  const snapshot = page.scan(doc, new Set([previous]), id);
  assert.equal(snapshot.reasoning, '我先核对需求，再生成文件。');
  assert.equal(JSON.parse(snapshot.answer).text, html);
  assert.equal(page.scan(doc, new Set([previous]), 'another-id').answer, null);
  assert.equal(parseReply('```json\n' + json + '\n```', { id, validators: new Map() }).text, html);
});

test('displayed reasoning is omitted from subsequent model context', () => {
  const request = prepareRequest({ ...options, messages: [...options.messages, { role: 'assistant', content: [{ type: 'reasoning', text: 'bridge-only-status' }, { type: 'text', text: 'actual answer' }] }] });
  assert.ok(!request.prompt.includes('bridge-only-status')); assert.ok(request.prompt.includes('actual answer'));
});

test('compaction accepts only this turn completed summary, never thought or tool calls', () => {
  const request = prepareRequest({ ...options, purpose: 'compaction', tools: [{ name: 'write', parameters: {} }] }, 'summary-current');
  assert.equal(request.replyFormat, 'summary');
  assert.equal(request.validators.size, 0);
  const end = '[[DSH_SUMMARY_END:summary-current]]';
  const thought = markdown('I should summarize. ' + end, [], true, true);
  const draft = markdown('已完成：写入 index.html。\n待办：展示页面。');
  const doc = { querySelectorAll: () => [thought, draft] };
  const partial = page.scan(doc, new Map(), request.id, request.replyFormat);
  assert.equal(partial.answer, null);
  assert.equal(partial.reasoning, thought.innerText);
  assert.equal(partial.outputText, draft.innerText);
  draft.innerText = '[[DSH_SUMMARY_BEGIN:summary-current]]\n' + draft.innerText + '\n' + end;
  const complete = page.scan(doc, new Map(), request.id, request.replyFormat);
  assert.equal(parseReply(complete.answer, request).text, '已完成：写入 index.html。\n待办：展示页面。');
  assert.equal(page.scan(doc, new Map(), 'wrong-id', 'summary').answer, null);
  assert.equal(page.scan(doc, new Map(), request.id, 'json').answer, null);
  assert.throws(() => parseReply('unfinished summary', request), /结束标记/);
  assert.throws(() => parseReply(JSON.stringify({ request_id: request.id, kind: 'tool_calls', calls: [{ name: 'write', arguments: {} }] }), request), /结束标记/);
});

test('summary text fence preserves dollar identifiers and Windows paths with the installed collector', () => {
  const request = prepareRequest({ ...options, purpose: 'compaction' }, 'literal-summary');
  assert.match(request.prompt, /```text\n\[\[DSH_SUMMARY_BEGIN:literal-summary\]\]/);
  assert.ok(!request.prompt.includes('不要用代码块'));
  const body = '【文件与代码】\nconst $ = id => document.getElementById(id); const $sunRays = $("sunRays");\nE:\\DSH套娃测试\\.patch-work\\pelican\\structure-check.mjs\n';
  const value = `[[DSH_SUMMARY_BEGIN:${request.id}]]\n${body}[[DSH_SUMMARY_END:${request.id}]]`;
  const node = markdown('text\n复制\n' + value, [value]);
  const doc = { querySelectorAll: selector => selector === 'pre code, pre' ? [] : [node] };
  const result = page.scan(doc, new Map(), request.id, 'summary');
  assert.equal(parseReply(result.answer, request).text, body.trim());
});

test('summary format and progress purpose survive remote transport and worker dispatch', { timeout: 10000 }, async () => {
  const token = randomBytes(32).toString('hex');
  const broker = new Broker({ token, port: 0, timeoutMs: 5000 }); await broker.start();
  try {
    const request = prepareRequest({ ...options, purpose: 'compaction' }, 'summary-remote');
    let wake; const queued = new Promise(resolve => { wake = resolve; });
    const progress = [];
    const result = submitRemote({ token, port: broker.port }, request, undefined, update => { progress.push(update.phase); wake(); });
    await queued;
    const post = async (path, data) => (await fetch(`http://127.0.0.1:${broker.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ clientId: 'summary-worker', version: '0.2.19', ...data }) })).json();
    const { job } = await post('/worker/poll', { version: '0.2.19' });
    assert.equal(job.replyFormat, 'summary');
    assert.equal(job.contextPolicy, 1);
    const text = '[[DSH_SUMMARY_BEGIN:summary-remote]]\n写入已完成，仍需展示页面。\n[[DSH_SUMMARY_END:summary-remote]]';
    await post('/job/' + job.id, { lease: job.lease, action: 'result', text });
    assert.equal(parseReply(await result, request).text, '写入已完成，仍需展示页面。');
    assert.ok(progress.every(phase => phase.startsWith('上下文压缩：')));
  } finally { await broker.close(); }
});

test('visible-text summary fallback works with zero known DOM nodes and rejects prompt, partial and old markers', () => {
  const id = 'fallback-current';
  const begin = `[[DSH_SUMMARY_BEGIN:${id}]]`, end = `[[DSH_SUMMARY_END:${id}]]`;
  const prompt = `最终摘要的首行单独写「${begin}」，最后一行单独写「${end}」。`;
  const doc = { querySelectorAll: () => [], body: { innerText: prompt }, visibilityState: 'hidden' };
  const scan = () => page.scan(doc, new Map(), id, 'summary');
  assert.equal(scan().answer, null);
  doc.body.innerText += '\n' + begin + '\nPrimary Request and Intent\n用户要求骑车动画。\nCurrent Work\n写入已完成。';
  assert.equal(scan().answer, null);
  doc.body.innerText += '\n' + end + '\n给 DeepSeek 发送消息';
  assert.equal(scan().metrics.totalNodes, 0);
  assert.equal(scan().metrics.fallbackUsed, true);
  const request = prepareRequest({ ...options, purpose: 'compaction' }, id);
  assert.match(parseReply(scan().answer, request).text, /写入已完成/);
  assert.equal(page.scan(doc, new Map(), 'old-id', 'summary').answer, null);
  doc.body.innerText += '\n' + begin + '\nambiguous duplicate\n' + end;
  assert.equal(scan().answer, null);
});

test('JSON code extraction does not depend on Markdown class names', () => {
  const raw = JSON.stringify({ request_id: 'code-current', kind: 'final', text: 'done' });
  const code = { textContent: raw, getClientRects: () => [1] };
  const doc = { querySelectorAll: selector => selector === 'pre code, pre' ? [code] : [] };
  assert.equal(page.scan(doc, new Map(), 'code-current').answer, raw);
  assert.equal(page.scan(doc, new Map(), 'old-code').answer, null);
  code.closest = () => ({});
  assert.equal(page.scan(doc, new Map(), 'code-current').answer, null);
});

test('nested response wrappers still expose code, and an initially empty response container can be reused', () => {
  const code = JSON.stringify({ request_id: 'current', kind: 'final', text: '5117' });
  const node = markdown('json 复制代码 ' + code, [code]);
  node.querySelector = () => ({ className: 'ds-markdown' });
  const doc = { querySelectorAll: () => [node] };
  const result = page.scan(doc, new Map([[node, '']]), 'current');
  assert.equal(JSON.parse(result.answer).text, '5117');
  assert.equal(result.reasoning, '');
});

test('automatic requests never create windows or activate tabs; only explicit viewing focuses Chrome', async () => {
  const storage = {}; const tabs = new Map(); const windows = new Map(); const actions = []; let nextTab = 10;
  const chrome = {
    storage: { local: { get: async () => storage, set: async value => Object.assign(storage, value) } },
    tabs: {
      get: async id => tabs.get(id),
      create: async config => { actions.push(['create-tab', config]); const tab = { id: ++nextTab, windowId: config.windowId, url: config.url }; tabs.set(tab.id, tab); return tab; },
      update: async (id, config) => { actions.push(['update-tab', config]); return Object.assign(tabs.get(id), config); },
      move: async (id, config) => Object.assign(tabs.get(id), { windowId: config.windowId })
    },
    windows: {
      getLastFocused: async () => ({ id: 5 }),
      get: async id => windows.get(id),
      create: async config => { actions.push(['create-window', config]); const tab = { id: ++nextTab, windowId: 5, url: config.url }; tabs.set(tab.id, tab); const win = { id: 5, tabs: [tab], state: 'normal' }; windows.set(5, win); return win; },
      update: async (id, config) => { actions.push(['update-window', id, config]); return Object.assign(windows.get(id), config); }
    }
  };
  const first = await ensureBridgeTab(chrome, { sessionKey: 'a' });
  const second = await ensureBridgeTab(chrome, { sessionKey: 'a' });
  const other = await ensureBridgeTab(chrome, { sessionKey: 'b' });
  assert.equal(first, second); assert.notEqual(first, other);
  assert.equal(actions.filter(([name]) => name === 'create-window').length, 0);
  assert.equal(actions.filter(([name]) => name === 'update-window').length, 0);
  assert.equal(actions.find(([name]) => name === 'create-tab')[1].windowId, 5);
  assert.ok(actions.filter(([name]) => name === 'create-tab').every(([,config]) => config.active === false));
  assert.ok(actions.filter(([name]) => name === 'update-tab').every(([,config]) => config.active === undefined && config.autoDiscardable === false));
  windows.set(5, { id: 5 });
  await showBridgeTab(chrome);
  assert.ok(actions.some(([name,, config]) => name === 'update-window' && config.focused));
});

test('native Harness reasoning streams through HTTP before final result; progress never becomes a tool call', { timeout: 10000 }, async () => {
  const token = randomBytes(32).toString('hex');
  const broker = new Broker({ token, port: 0, timeoutMs: 5000 }); await broker.start();
  const config = { token, port: broker.port, timeoutMs: 5000 };
  const adapter = new WebAdapter({ submit: (request, signal, onProgress) => submitRemote(config, request, signal, onProgress) });
  const chunks = []; let sawQueue, sawThinking;
  const queued = new Promise(resolve => { sawQueue = resolve; });
  const thinking = new Promise(resolve => { sawThinking = resolve; });
  const consume = (async () => { for await (const chunk of adapter.stream(options)) {
    chunks.push(chunk);
    if (chunk.type === 'reasoning-delta') { sawQueue(); if (chunk.text.includes('visible-thought')) sawThinking(); }
  } })();
  const post = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${broker.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ clientId: 'worker-test', version: '0.2.19', ...body }) });
    return { status: response.status, data: await response.json() };
  };
  try {
    await queued;
    const { data: { job } } = await post('/worker/poll', {});
    await post('/job/' + job.id, { lease: job.lease, action: 'progress', phase: '网页正在思考', reasoning: 'visible-thought' });
    await thinking;
    assert.ok(chunks.every(chunk => chunk.type !== 'finish' && chunk.type !== 'tool-call-delta'));
    assert.equal((await post('/job/' + job.id, { lease: 'wrong', action: 'progress', reasoning: 'forged' })).status, 409);
    await post('/job/' + job.id, { lease: job.lease, action: 'result', text: JSON.stringify({ request_id: job.id, kind: 'final', text: 'done' }) });
    await consume;
    assert.equal(chunks.at(-1).reason.kind, 'stop');
    assert.equal(chunks.find(chunk => chunk.type === 'text-delta').index, 1);
    assert.equal(chunks.filter(chunk => chunk.type === 'reasoning-delta').map(c => c.text).join('').split('visible-thought').length, 2);
    assert.ok(!JSON.stringify(chunks).includes('forged'));
  } finally { await broker.close(); await consume.catch(() => {}); }
});
