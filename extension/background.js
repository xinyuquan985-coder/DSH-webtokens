import { ensureBridgeTab, showBridgeTab, pageHealthState, accountBridgeResult } from './tabs.js';
const BASE = 'http://127.0.0.1:3081';
let pumping = false;
const configPromise = fetch(chrome.runtime.getURL('local-config.json')).then(r => r.json());
let clientPromise = chrome.storage.local.get('clientId').then(async value => {
  const clientId = value.clientId ?? crypto.randomUUID(); await chrome.storage.local.set({ clientId }); return clientId;
});
async function api(path, body) {
  const config = await configPromise;
  const response = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.token }, body: JSON.stringify({ ...body, clientId: await clientPromise }), signal: AbortSignal.timeout(8000) });
  const result = await response.json().catch(() => ({}));
  if (response.status === 410) return { cancelled: true };
  if (!response.ok) throw new Error(result.error ?? '本机桥接 HTTP ' + response.status);
  return result;
}
async function setState(state) {
  await chrome.storage.local.set({ state, stateAt: Date.now() });
  await chrome.action.setBadgeText({ text: state.startsWith('错误') ? '!' : state.startsWith('等待') ? '…' : '连' });
  await chrome.action.setBadgeBackgroundColor({ color: state.startsWith('错误') ? '#c43636' : '#4361ee' });
}
async function ensureTab(job) {
  return ensureBridgeTab(chrome, job);
}
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    const { active, state } = await chrome.storage.local.get(['active', 'state']);
    const poll = await api('/worker/poll', { busy: !!active, version: '0.2.19', state: state ?? '已连接，等待任务' });
    if (poll.openPage) await showBridgeTab(chrome, typeof poll.openPage === 'object' ? poll.openPage : undefined);
    if (poll.inspectPage) {
      const target = poll.inspectPage;
      let result;
      try {
        if (active) throw new Error('Cannot inspect while a request is active');
        const tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
        const tab = tabs.find(t => t.url === target.url);
        if (!tab) throw new Error('Open the requested conversation before inspection');
        const health = await chrome.tabs.sendMessage(tab.id, { type: 'health' }).catch(() => null);
        if (health?.activeId || health?.hasDraft || health?.generating) throw new Error('Inspection page is busy');
        if (health?.version !== '0.2.19') throw new Error('Refresh the failed conversation page to load 0.2.19 diagnostics');
        result = await chrome.tabs.sendMessage(tab.id, { type: 'inspect-reply', requestId: target.requestId, url: target.url });
      } catch (e) { result = { error: e.message }; }
      await api('/worker/inspection', { nonce: target.nonce, result });
    }
    if (active) {
      const status = await api('/job/' + active.id, { lease: active.lease, action: 'status' });
      if (status.cancelled) {
        if (active.tabId) await chrome.tabs.sendMessage(active.tabId, { type: 'cancel', id: active.id }).catch(() => {});
        await chrome.storage.local.remove('active'); await setState('已连接，任务已取消'); return;
      }
      if (active.tabId) {
        const health = await chrome.tabs.sendMessage(active.tabId, { type: 'health' }).catch(() => null);
        const healthState = pageHealthState(active, health, Date.now());
        if (healthState === 'alive') {
          if (active.healthMissingAt) await chrome.storage.local.set({ active: { ...active, healthMissingAt: null } });
          return;
        }
        // A page or worker reload must never cause an uncertain request to be submitted again.
        if (active.dispatched) {
          if (healthState === 'waiting') {
            if (!active.healthMissingAt) await chrome.storage.local.set({ active: { ...active, healthMissingAt: Date.now() } });
            return;
          }
          await api('/job/' + active.id, { lease: active.lease, action: 'error', error: '网页重载或脚本中断，发送状态不明；已停止，避免重复发送。' });
          await chrome.storage.local.remove('active'); await setState('错误：网页中断，本轮已停止'); return;
        }
      }
      return await dispatch(active);
    }
    if (poll.job) {
      let tabId;
      try { tabId = await ensureTab(poll.job); }
      catch (error) { await api('/job/' + poll.job.id, { lease: poll.job.lease, action: 'error', error: error.message }); throw error; }
      const next = { ...poll.job, tabId, dispatched: false };
      await chrome.storage.local.set({ active: next }); await dispatch(next);
    } else await setState('已连接，等待 Harness 任务');
  } catch (error) { await setState('错误：' + error.message); }
  finally { pumping = false; }
}
async function dispatch(active) {
  const pageTab = await chrome.tabs.get(active.tabId).catch(() => null);
  if (pageTab?.status !== 'complete') return;
  const health = await chrome.tabs.sendMessage(active.tabId, { type: 'health' }).catch(() => null);
  const waiting = async phase => { await setState(phase); await api('/job/' + active.id, { lease: active.lease, action: 'progress', phase }); };
  if (!health || health.version !== '0.2.19') {
    const tab = await chrome.tabs.get(active.tabId).catch(() => null);
    if (tab?.status === 'complete' && !active.pageRefreshed) {
      await chrome.storage.local.set({ active: { ...active, pageRefreshed: true } });
      await chrome.tabs.reload(active.tabId);
    }
    await waiting('正在加载专用网页与新版桥接脚本'); return;
  }
  if (!health.ready) { await waiting('等待 DeepSeek 登录或验证，请查看专用窗口'); return; }
  // Persist before dispatch: interruption between these steps fails closed, never resends.
  await chrome.storage.local.set({ active: { ...active, dispatched: true } });
  const accepted = await chrome.tabs.sendMessage(active.tabId, { type: 'run', job: active });
  if (accepted?.error) {
    await api('/job/' + active.id, { lease: active.lease, action: 'error', error: accepted.error });
    await chrome.storage.local.remove('active'); await setState('错误：' + accepted.error); return;
  }
  await setState('正在发送 Harness 任务');
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const trustedPage = sender.url?.startsWith('https://chat.deepseek.com/') && sender.tab;
  const trustedPopup = sender.url === chrome.runtime.getURL('popup.html');
  if (!trustedPage && !trustedPopup) return false;
  (async () => {
    if (message.type === 'tick') { await pump(); return { ok: true }; }
    if (message.type === 'open-active' && trustedPopup) {
      await showBridgeTab(chrome);
      return { ok: true };
    }
    if (message.type === 'event' && trustedPage) {
      const { active } = await chrome.storage.local.get('active');
      if (!active || active.id !== message.id || active.tabId !== sender.tab.id) return { cancelled: true };
      if (!['sent', 'generating', 'result', 'error', 'status', 'progress', 'validate'].includes(message.action)) throw new Error('Invalid action');
      const result = await api('/job/' + active.id, { lease: active.lease, action: message.action, text: message.text, error: message.error, phase: message.phase, reasoning: message.reasoning, metrics: message.metrics, url: sender.tab.url });
      if (message.action === 'validate') return result;
      if (message.action === 'result' || message.action === 'error' || result.cancelled) {
        await accountBridgeResult(chrome, active, message);
        await chrome.storage.local.remove('active');
        await setState(message.action === 'error' ? '错误：' + message.error : '已回传 Harness，等待下一轮');
      } else if (message.action === 'progress') await setState(message.phase);
      else if (message.action !== 'status') await setState(message.action === 'sent' ? '等待 DeepSeek 回答' : 'DeepSeek 正在回答');
      return result;
    }
    return { error: 'Unknown message' };
  })().then(sendResponse, error => sendResponse({ error: error.message }));
  return true;
});
chrome.alarms.create('bridge-pump', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => pump());
chrome.tabs.onUpdated.addListener((_tabId, info) => { if (info.status === 'complete') pump(); });
chrome.runtime.onStartup.addListener(() => pump());
chrome.runtime.onInstalled.addListener(() => pump());
setInterval(pump, 1500);
pump();
