import test from 'node:test';
import assert from 'node:assert/strict';
import { Broker } from '../plugins/dsh-web-bridge/broker.js';
import { registerPanel } from '../plugins/dsh-web-bridge/panel.js';
import { WebAdapter } from '../plugins/dsh-web-bridge/index.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('panel uses Harness authentication; public status never contains thought text', async () => {
  const broker = new Broker({ token: 'x'.repeat(40) });
  const routes = new Map();
  registerPanel({ effect: fn => fn(), connection: { requestRejection: req => req.authorized ? undefined : 401 }, webServer: { register: route => routes.set(route.path, route.handler) } }, broker);
  const invoke = (path, method, authorized = true) => {
    const result = { status: 200, body: '' };
    routes.get(path)({ method, authorized }, { setHeader() {}, writeHead(status) { result.status = status; }, end(text) { result.body = text ?? ''; } });
    return result;
  };
  assert.equal(invoke('/web-bridge/panel', 'GET', false).status, 401);
  assert.equal(invoke('/web-bridge/open-page', 'POST', false).status, 401);
  assert.equal(broker.openPageRequested, false);
  assert.equal(invoke('/web-bridge/open-page', 'GET').status, 405);
  assert.equal(invoke('/web-bridge/open-page', 'POST').status, 409);
  const result = broker.submit({ id: 'panel-current', sessionKey: 'test:conversation', prompt: 'test' });
  const job = broker.jobs.get('panel-current'); broker.active = job.id;
  broker.progress(job, { phase: 'thinking', reasoning: 'private-visible-thought', metrics: { visibility: 'hidden' } });
  assert.ok(!JSON.stringify(broker.status()).includes('private-visible-thought'));
  const panel = JSON.parse(invoke('/web-bridge/panel', 'GET').body);
  assert.equal(panel.projectPath, process.cwd());
  assert.equal(panel.detail.reasoning, 'private-visible-thought');
  assert.equal(panel.detail.visibility, 'hidden');
  broker.finish(job, null, 'done'); await result;
  assert.equal(broker.panel().detail.state, 'completed');
  broker.setPanelOutcome(job.id, 'invalid protocol');
  assert.equal(broker.panel().detail.state, 'failed');
  broker.worker = { id: 'test', version: '0.2.16', seenAt: Date.now() };
  assert.equal(invoke('/web-bridge/open-page', 'POST').status, 200);
  assert.deepEqual(broker.openPageRequested, { requestId: job.id, url: undefined });
});

test('adapter reports a validation failure to the panel instead of leaving success', async () => {
  const outcomes = [];
  const adapter = new WebAdapter({ submit: async () => 'bad JSON', setPanelOutcome: (...args) => outcomes.push(args) });
  await assert.rejects(async () => { for await (const ignored of adapter.stream({ messages: [], tools: [] })) {} });
  assert.equal(outcomes.length, 1);
  assert.match(outcomes[0][1], /有效协议 JSON/);
});

test('preflight failures before the first queued job preserve their real error and emit no tools', async () => {
  for (const [options, code] of [
    [{ messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(100001) }] }], tools: [] }, 'WEB_CONTEXT_LIMIT'],
    [{ messages: [], tools: [], temperature: 0.5 }, 'UNSUPPORTED_OPTION']
  ]) {
    const broker = new Broker({ token: 'x'.repeat(40) });
    const adapter = new WebAdapter(broker);
    const chunks = [];
    await assert.rejects(async () => { for await (const chunk of adapter.stream(options)) chunks.push(chunk); }, { code });
    assert.equal(broker.jobs.size, 0);
    assert.equal(broker.lastPanel, null);
    assert.equal(chunks.filter(chunk => chunk.type === 'block-end').length, 1);
    assert.ok(chunks.every(chunk => chunk.type !== 'tool-call-delta' && chunk.type !== 'finish'));
    assert.match(chunks.find(chunk => chunk.type === 'text-delta').text, /网页桥接已停止/);
  }
});

test('a preflight failure cannot change an unrelated previous panel result', () => {
  const broker = new Broker({ token: 'x'.repeat(40) });
  broker.lastPanel = { id: 'previous', state: 'completed', phase: 'done' };
  broker.setPanelOutcome(undefined, 'context limit');
  broker.setPanelOutcome('other', 'context limit');
  assert.deepEqual(broker.lastPanel, { id: 'previous', state: 'completed', phase: 'done' });
});

test('panel client renders an in-page aside, can collapse and requests Chrome only on click', async () => {
  let component;
  const actions = [], refs = [], effects = [];
  const state = [{ connected: true, projectPath: 'E:/Example Project', active: null, detail: { state: 'failed', phase: '已停止', reasoning: '<script>untrusted</script>', phases: [], createdAt: 1, updatedAt: 1001 } }, true, '', ''];
  let index = 0;
  const React = { Fragment: 'fragment', createElement: (tag, props, ...children) => ({ tag, props, children }), useState: initial => { const i = index++; return [state[i] ?? initial, value => actions.push(['state', i, value])]; }, useRef: value => { const ref = { current: value }; refs.push(ref); return ref; }, useEffect: fn => effects.push(fn) };
  const context = vm.createContext({ AbortSignal, window: { __ModuleLoader__: { load: definition => definition.factory(() => React).apply({ slots: { inject: (_, fn) => fn(), register: (_, view) => { component = view; } } }) } }, fetch: async (...args) => { actions.push(['fetch', ...args]); return { ok: true }; } });
  vm.runInContext(await readFile(new URL('../plugins/dsh-web-bridge/client.js', import.meta.url), 'utf8'), context);
  const tree = component({ wide: true });
  const nodes = [];
  const walk = node => { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) return node.forEach(walk); nodes.push(node); node.children?.forEach(walk); };
  walk(tree);
  assert.equal(nodes.filter(node => node.tag === 'aside').length, 1);
  assert.equal(nodes.filter(node => node.tag === 'iframe' || node.props?.dangerouslySetInnerHTML).length, 0);
  assert.equal(actions.filter(action => action[0] === 'fetch').length, 0);
  await nodes.find(node => node.tag === 'button' && node.children.includes('查看网页')).props.onClick();
  assert.equal(actions.find(action => action[0] === 'fetch')[1], '/web-bridge/open-page');
  nodes.find(node => node.props?.['aria-label'] === '收起桥接面板').props.onClick();
  assert.equal(refs[0].current, true);
  assert.equal(nodes.some(node => node.props?.['aria-label'] === '打开项目文件夹'), false);
});
