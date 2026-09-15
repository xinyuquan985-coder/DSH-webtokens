import test from 'node:test';
import assert from 'node:assert/strict';
import { showBridgeTab } from '../extension/tabs.js';
import { lastPanelFromAudit } from '../plugins/dsh-web-bridge/history.js';
import { Broker } from '../plugins/dsh-web-bridge/broker.js';
import { registerPanel } from '../plugins/dsh-web-bridge/panel.js';
const url = 'https://chat.deepseek.com/a/chat/s/ef7f039e-6b93-411e-87d7-2ad0b061e415';
function fixture(tabs, data = {}) {
  const actions = [];
  const chrome = { storage: { local: { get: async () => data } }, tabs: {
    get: async id => tabs.find(t => t.id === id), query: async () => tabs,
    update: async (id, change) => { actions.push({ id, ...change }); return { id, ...change }; },
    create: async change => { actions.push({ create: true, ...change }); return { id: 7, ...change }; }
  }, windows: { update: async (id, change) => actions.push({ window: id, ...change }) } };
  return { chrome, actions };
}
test('view opens the requested conversation when last tab was reused, closed or returned home', async () => {
  for (const current of [[], [{ id: 1, url: 'https://chat.deepseek.com/' }], [{ id: 1, url: 'https://chat.deepseek.com/a/chat/s/other' }]]) {
    const f = fixture(current, { active: { id: 'other-request', tabId: 1 }, lastBridgeTabId: 1 });
    await showBridgeTab(f.chrome, { requestId: 'failed-request', url });
    assert.deepEqual(f.actions, [{ create: true, url, active: true }]);
  }
});
test('view reuses only an exact matching conversation and never navigates a busy tab', async () => {
  const f = fixture([{ id: 1, windowId: 2, url: 'https://chat.deepseek.com/' }, { id: 3, windowId: 4, url }], { lastBridgeTabId: 1 });
  await showBridgeTab(f.chrome, { requestId: 'failed-request', url });
  assert.deepEqual(f.actions, [{ id: 3, active: true }, { window: 4, state: 'normal', focused: true }]);
});
test('missing or untrusted saved URL cannot silently open a home or unrelated page', async () => {
  for (const target of [{ requestId: 'old' }, { requestId: 'old', url: 'https://evil.example/' }, { requestId: 'old', url: 'https://chat.deepseek.com/' }]) {
    const f = fixture([{ id: 1, url }], { lastBridgeTabId: 1 });
    await assert.rejects(showBridgeTab(f.chrome, target), /未跳转到主页/); assert.equal(f.actions.length, 0);
  }
});
test('active login page may be shown only for its own not-yet-created conversation', async () => {
  const f = fixture([{ id: 1, windowId: 4, url: 'https://chat.deepseek.com/' }], { active: { id: 'current', tabId: 1 } });
  await showBridgeTab(f.chrome, { requestId: 'current' });
  assert.equal(f.actions[0].id, 1); assert.ok(f.actions.every(a => !a.create && !a.url));
});
test('audit recovery binds the last terminal result to its own last concrete URL', () => {
  const rows = [{ type: 'queued', id: 'failed', time: '2026-09-14T07:12:00Z' }, { type: 'website-conversation', id: 'other', url: 'https://chat.deepseek.com/a/chat/s/other' }, { type: 'website-conversation', id: 'failed', url }, { type: 'website-conversation', id: 'failed', url: 'https://chat.deepseek.com/' }, { type: 'failed', id: 'failed', time: '2026-09-14T07:14:00Z', message: 'Stopped' }];
  const restored = lastPanelFromAudit('partial\n' + rows.map(JSON.stringify).join('\n'));
  assert.equal(restored.websiteUrl, url); assert.equal(restored.id, 'failed'); assert.equal(restored.state, 'failed');
  rows.push({ type: 'completed', id: 'new-no-url', time: '2026-09-14T07:15:00Z' });
  assert.equal(lastPanelFromAudit(rows.map(JSON.stringify).join('\n')).websiteUrl, undefined);
});
test('panel refuses stale request clicks and old workers, then queues a concrete target', () => {
  const broker = new Broker({ token: 'x'.repeat(40) }); const routes = new Map();
  registerPanel({ effect: fn => fn(), connection: { requestRejection: () => undefined }, webServer: { register: route => routes.set(route.path, route.handler) } }, broker);
  broker.lastPanel = { id: 'failed', websiteUrl: url, state: 'failed' };
  broker.worker = { id: 'worker', version: '0.2.15', seenAt: Date.now() };
  function invoke(id) { const result = {}; routes.get('/web-bridge/open-page')({ method: 'POST', headers: { 'x-dsh-request-id': id } }, { setHeader() {}, writeHead(s) { result.status = s; }, end(s) { result.body = JSON.parse(s); } }); return result; }
  assert.equal(invoke('failed').status, 409); assert.equal(broker.openPageRequested, false);
  broker.worker.version = '0.2.16'; assert.equal(invoke('stale').status, 409);
  assert.equal(invoke('failed').body.ok, true); assert.deepEqual(broker.openPageRequested, { requestId: 'failed', url });
});
