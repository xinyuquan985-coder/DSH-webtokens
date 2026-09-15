import test from 'node:test';
import assert from 'node:assert/strict';
import { WebAdapter } from '../plugins/dsh-web-bridge/index.js';
import { SECTIONS, validateSummary } from '../plugins/dsh-web-bridge/context.js';
import { ensureBridgeTab, accountBridgeResult } from '../extension/tabs.js';
const text = value => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: value }] });
const summary = SECTIONS.map(s => '## ' + s + '\n记录：已创建 E:\\项目\\page.html；尚未通过视觉验收。修改前必须重新读取当前文件；保留未完成事项。').join('\n\n');
const options = () => ({ sessionId: 'api-to-web', system: 'Keep user constraints.', tools: [{ name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }], messages: [text('Create animation'), { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'write', arguments: JSON.stringify({ path: 'page.html', content: '🌟代码\\\n'.repeat(30000) }) }] }, { role: 'user', source: { kind: 'tool' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'Created file page.html' }] }] }, text('提升质量，必须保留当前文件路径和空格键功能。') ] });
const collect = async (adapter, input) => { const chunks = []; for await (const chunk of adapter.stream(input)) chunks.push(chunk); return chunks; };
test('summary structure survives visible Markdown heading rendering without accepting missing sections', () => {
  const visible = summary.replace(/^## /gm, '');
  assert.equal(validateSummary(visible, 'x'.repeat(20000), 5000), visible);
  const bracketed = summary.replace(/^## (.+)$/gm, '【$1】');
  assert.equal(validateSummary(bracketed, 'x'.repeat(20000), 5000), bracketed);
  const inline = bracketed.replace(/】\n/g, '】');
  assert.equal(validateSummary(inline, 'x'.repeat(20000), 5000), inline);
  assert.throws(() => validateSummary(visible.replace('用户目标与约束', 'some other heading'), 'x'.repeat(20000), 5000), { code: 'WEB_SUMMARY_INVALID' });
});
test('all eight bracketed headings remain valid after paragraph line breaks collapse', () => {
  const collapsed = SECTIONS.map(s => '【' + s + '】 本节已知事实和待验证事项。').join(' ');
  assert.equal(validateSummary(collapsed, 'x'.repeat(20000), 100000), collapsed);
  const adjacent = collapsed.replaceAll('。 【', '。【');
  assert.equal(validateSummary(adjacent, 'x'.repeat(20000), 100000), adjacent);
  assert.throws(() => validateSummary(collapsed.replace('【待办事项】', '【其他信息】'), 'x'.repeat(20000), 100000), /缺少：待办事项/);
  assert.throws(() => validateSummary(collapsed + '【关键上下文】重复。', 'x'.repeat(20000), 100000), /重复：关键上下文/);
  assert.throws(() => validateSummary(collapsed.replace('【待办事项】 本节已知事实和待验证事项。', '【待办事项】'), 'x'.repeat(20000), 100000), /空节：待办事项/);
  const swapped = [...SECTIONS]; [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
  assert.throws(() => validateSummary(swapped.map(s => '【' + s + '】正文。').join(''), 'x'.repeat(20000), 100000), /标题顺序不符/);
});
function responder() {
  const requests = [];
  const adapter = new WebAdapter({ submit: async (request, signal, progress) => {
    requests.push(request); progress({ phase: '模拟网页响应' });
    return request.replyFormat === 'summary' ? `[[DSH_SUMMARY_BEGIN:${request.id}]]\n${summary}\n[[DSH_SUMMARY_END:${request.id}]]` : JSON.stringify({ request_id: request.id, kind: 'tool_calls', calls: [{ name: 'read', arguments: { path: 'page.html' } }] });
  } });
  return { adapter, requests };
}

test('reported 2686/4994-character summaries fit directly, without a forced merge', async () => {
  const requests = [];
  const adapter = new WebAdapter({ submit: async r => {
    requests.push(r);
    if (r.replyFormat !== 'summary') return JSON.stringify({ request_id: r.id, kind: 'final', text: 'continued' });
    assert.match(r.contextPhase, /第 1 层/);
    const size = requests.length === 1 ? 2686 : 4994;
    const value = summary + '有效历史记录'.repeat(1000).slice(0, size - summary.length);
    return `[[DSH_SUMMARY_BEGIN:${r.id}]]\n${value}\n[[DSH_SUMMARY_END:${r.id}]]`;
  } });
  const input = { sessionId: 'reported-lengths', messages: [text('x'.repeat(130000)), text('保持作品路径，继续当前修改')], tools: [] };
  const chunks = await collect(adapter, input);
  assert.equal(requests.filter(r => r.replyFormat === 'summary').length, 2);
  assert.equal(chunks.find(c => c.type === 'text-delta').text, 'continued');
  assert.match(requests.at(-1).prompt, /历史片段 2/);
  assert.ok(requests.at(-1).prompt.length < 100000);
});

test('a complete 5778-character summary is accepted when actual continuation capacity allows it', async () => {
  const large = summary + '记录'.repeat(3000).slice(0, 5778 - summary.length);
  assert.equal(validateSummary(large, 'x'.repeat(7700), 100000), large);
  const requests = [];
  const adapter = new WebAdapter({ submit: async r => {
    requests.push(r);
    return r.replyFormat === 'summary' ? `[[DSH_SUMMARY_BEGIN:${r.id}]]\n${large}\n[[DSH_SUMMARY_END:${r.id}]]` : JSON.stringify({ request_id: r.id, kind: 'final', text: 'continued' });
  } });
  await collect(adapter, { sessionId: 'above-target', messages: [text('x'.repeat(130000)), text('继续')], tools: [] });
  assert.equal(requests.filter(r => r.replyFormat === 'summary').length, 2);
  assert.ok(JSON.parse(requests.at(-1).prompt.split('\n').at(-1)).messages[0].content[0].text.includes(large));
});

test('summaries are merged only when the actual system, tools and recent tail leave insufficient space', async () => {
  const requests = [];
  const adapter = new WebAdapter({ submit: async r => {
    requests.push(r);
    if (r.replyFormat !== 'summary') return JSON.stringify({ request_id: r.id, kind: 'final', text: 'continued' });
    const sourceLength = JSON.parse(r.prompt.split('\n')[2]).messages[0].content[0].text.length;
    const size = Math.min(r.contextPhase.includes('第 1 层') ? 5000 : 1000, Math.floor(sourceLength / 2));
    const value = summary + '记录'.repeat(3000).slice(0, size - summary.length);
    return `[[DSH_SUMMARY_BEGIN:${r.id}]]\n${value}\n[[DSH_SUMMARY_END:${r.id}]]`;
  } }, { maxPromptChars: 20000 });
  await collect(adapter, { sessionId: 'tight-budget', system: 's'.repeat(9000), messages: [text('x'.repeat(40000)), text('继续')], tools: [] });
  assert.ok(requests.some(r => r.contextPhase?.includes('第 2 层')));
  assert.ok(requests.every(r => r.prompt.length <= 20000));
});
test('large API tool history is split without data loss; same session continues with a validated native tool call', async () => {
  const { adapter, requests } = responder(); const input = options(); const original = JSON.stringify(input);
  const chunks = await collect(adapter, input);
  assert.equal(JSON.stringify(input), original);
  assert.ok(requests.filter(r => r.replyFormat === 'summary').length > 2);
  assert.ok(requests.every(r => r.prompt.length <= 100000));
  const segments = requests.filter(r => r.contextPhase?.startsWith('整理历史：第 1 层')).map(r => JSON.parse(r.prompt.split('\n')[2]).messages[0].content[0].text);
  assert.equal(segments.join(''), JSON.stringify(input.messages.slice(0, 3)));
  assert.match(requests.at(-1).prompt, /必须保留当前文件路径和空格键功能/);
  assert.match(requests.at(-1).prompt, /Created file|尚未通过视觉验收/);
  assert.equal(requests.at(-1).sessionKey, 'api-to-web:conversation');
  assert.equal(chunks.filter(c => c.type === 'tool-call-delta').length, 1);
  const starts = chunks.filter(c => c.type === 'block-start').map(c => c.index);
  assert.equal(new Set(starts).size, starts.length);
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
  assert.equal((await adapter.resolveModel('deepseek-web', 'deepseek-web')).context.contextWindow, 1000000);
});
test('prefix cache reuses only exact unchanged history and invalidates changed system, source and session', async () => {
  const { adapter, requests } = responder(); const input = options();
  await collect(adapter, input); requests.length = 0;
  await collect(adapter, input); assert.equal(requests.length, 1);
  input.messages[0] = text('Different requirement'); requests.length = 0;
  await collect(adapter, input); assert.ok(requests.length > 1);
  input.system = 'Changed system'; requests.length = 0;
  await collect(adapter, input); assert.ok(requests.length > 1);
  input.sessionId = 'another-session'; requests.length = 0;
  await collect(adapter, input); assert.ok(requests.length > 1);
});
test('bad, unshrunk and wrong-ID summaries stop before any conversation or native tool calls', async () => {
  assert.throws(() => validateSummary(summary, 'tiny', 6000), { code: 'WEB_SUMMARY_INVALID' });
  for (const mode of ['missing-section', 'wrong-id', 'too-large']) {
    const requests = [], chunks = [];
    const adapter = new WebAdapter({ submit: async r => {
      requests.push(r); const id = mode === 'wrong-id' ? 'old-id' : r.id;
      const body = mode === 'missing-section' ? 'Summary without headings' : mode === 'too-large' ? summary + 'x'.repeat(100000) : summary;
      return `[[DSH_SUMMARY_BEGIN:${id}]]\n${body}\n[[DSH_SUMMARY_END:${id}]]`;
    } });
    await assert.rejects(async () => { for await (const c of adapter.stream(options())) chunks.push(c); });
    assert.equal(requests.length, 1); assert.equal(requests[0].replyFormat, 'summary');
    assert.ok(chunks.every(c => c.type !== 'tool-call-delta' && c.type !== 'finish'));
    assert.equal(adapter.context.cache.size, 0);
  }
});
test('cancellation between summary pieces stops immediately and commits no cache', async () => {
  const controller = new AbortController(); let count = 0;
  const adapter = new WebAdapter({ submit: async r => { count++; controller.abort(); return `[[DSH_SUMMARY_BEGIN:${r.id}]]\n${summary}\n[[DSH_SUMMARY_END:${r.id}]]`; } });
  await assert.rejects(collect(adapter, { ...options(), signal: controller.signal }), { code: 'WEB_ABORTED' });
  assert.equal(count, 1); assert.equal(adapter.context.cache.size, 0);
});
test('oversize native compaction runs through the same web-only bounded path', async () => {
  const { adapter, requests } = responder();
  const chunks = await collect(adapter, { ...options(), purpose: 'compaction' });
  assert.ok(requests.length > 1); assert.ok(requests.every(r => r.replyFormat === 'summary' && r.validators.size === 0));
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  assert.ok(chunks.find(c => c.type === 'text-delta').text.includes(summary));
});
test('recent user request larger than the budget is never truncated or submitted', async () => {
  const { adapter, requests } = responder();
  await assert.rejects(collect(adapter, { ...options(), messages: [...options().messages, text('x'.repeat(110000))] }), { code: 'WEB_CONTEXT_LIMIT' });
  assert.equal(requests.length, 0);
});
test('website capacity rollover reserves once, migrates old bindings and never focuses or creates extra tabs', async () => {
  const storage = { bindings: { session: { tabId: 1 } } }, actions = [];
  const tab = { id: 1, url: 'https://chat.deepseek.com/a/chat-id' };
  const chrome = { storage: { local: { get: async () => storage, set: async value => Object.assign(storage, value) } }, tabs: { get: async () => tab, sendMessage: async () => ({ hasDraft: false, generating: false }), update: async (_, change) => { actions.push(change); return Object.assign(tab, change); }, create: async () => { throw new Error('Should reuse tab'); } }, windows: {} };
  const job = { id: 'one', sessionKey: 'session', prompt: 'x'.repeat(90000), contextPolicy: 1 };
  await ensureBridgeTab(chrome, job);
  assert.equal(actions.filter(a => a.url).length, 1);
  const reserved = storage.bindings.session.usedUnits;
  await ensureBridgeTab(chrome, job); assert.equal(storage.bindings.session.usedUnits, reserved);
  await ensureBridgeTab(chrome, { ...job, id: 'two' });
  assert.equal(actions.filter(a => a.url).length, 1);
  await accountBridgeResult(chrome, { ...job, id: 'two' }, { action: 'result', text: 'x'.repeat(300000) });
  const accounted = storage.bindings.session.usedUnits;
  await accountBridgeResult(chrome, { ...job, id: 'two' }, { action: 'result', text: 'x'.repeat(300000) });
  assert.equal(storage.bindings.session.usedUnits, accounted);
  await ensureBridgeTab(chrome, { ...job, id: 'three' });
  assert.equal(actions.filter(a => a.url).length, 2);
  assert.ok(actions.every(a => a.active !== true));
  chrome.tabs.sendMessage = async () => ({ hasDraft: true, generating: false });
  await accountBridgeResult(chrome, { ...job, id: 'three' }, { action: 'error' });
  await assert.rejects(ensureBridgeTab(chrome, { ...job, id: 'four' }), /草稿/);
  assert.equal(actions.filter(a => a.url).length, 2);
});
