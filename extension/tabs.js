// Conservative byte accounting, not official token usage. Leave room for hidden
// system instructions, website thinking/output and the one protocol correction.
const WINDOW_BUDGET = 700000;
const RESPONSE_RESERVE = 256000;
export async function ensureBridgeTab(chrome, job) {
  const data = await chrome.storage.local.get(['bindings', 'bridgeWindowId']);
  const bindings = data.bindings ?? {};
  const binding = bindings[job.sessionKey];
  let tab = binding ? await chrome.tabs.get(binding.tabId).catch(() => null) : null;
  if (tab && !tab.url?.startsWith('https://chat.deepseek.com/')) tab = null;
  const charge = job.contextPolicy === 1 ? new TextEncoder().encode(job.prompt ?? '').length + RESPONSE_RESERVE : 0;
  if (charge > WINDOW_BUDGET) throw new Error('本次输入超过网页保守容量预算，请降低桥接单次传输预算。');
  const sameRequest = binding?.lastRequestId === job.id && !!job.id;
  const rotate = tab && job.contextPolicy === 1 && !sameRequest && (!Number.isFinite(binding.usedUnits) || binding.usedUnits + charge > WINDOW_BUDGET);
  if (rotate) {
    const health = await chrome.tabs.sendMessage(tab.id, { type: 'health' }).catch(() => null);
    if (health?.hasDraft || health?.generating || health?.activeId) throw new Error('专用网页仍有草稿或正在生成，本轮停止以保留当前内容。');
    // An old/unreachable script cannot attest that navigation is safe. Keep that
    // tab intact and create one new managed tab for this binding instead.
    if (health?.hasDraft !== false || health?.generating !== false) tab = null;
  }
  let win = data.bridgeWindowId ? await chrome.windows.get(data.bridgeWindowId).catch(() => null) : null;
  // Reuse an existing Chrome window without activating a tab or opening a popup.
  if (!tab) {
    if (!win) win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
    tab = await chrome.tabs.create({ ...(win ? { windowId: win.id } : {}), url: 'https://chat.deepseek.com/', active: false });
  } else if (rotate) {
    // Navigating to the public new-chat page keeps the tab in the background.
    // Historical website chats and Harness logs are not deleted.
    tab = await chrome.tabs.update(tab.id, { url: 'https://chat.deepseek.com/' });
  }
  await chrome.tabs.update(tab.id, { autoDiscardable: false });
  bindings[job.sessionKey] = { tabId: tab.id, ...(job.contextPolicy === 1 ? { lastRequestId: job.id, usedUnits: sameRequest ? binding.usedUnits : (rotate || binding?.tabId !== tab.id ? 0 : binding?.usedUnits ?? 0) + charge } : {}) };
  await chrome.storage.local.set({ bindings, lastBridgeTabId: tab.id });
  return tab.id;
}

export async function accountBridgeResult(chrome, active, data) {
  if (active.contextPolicy !== 1) return;
  const { bindings = {} } = await chrome.storage.local.get('bindings');
  const binding = bindings[active.sessionKey];
  if (!binding || binding.lastRequestId !== active.id || binding.accountedId === active.id) return;
  const actual = new TextEncoder().encode((data.text ?? '') + (data.reasoning ?? '')).length;
  binding.usedUnits = data.action === 'error' ? WINDOW_BUDGET : binding.usedUnits + Math.max(0, actual - RESPONSE_RESERVE);
  binding.accountedId = active.id;
  await chrome.storage.local.set({ bindings });
}

// This is called only for a user's explicit "查看网页" action.
export async function showBridgeTab(chrome, target) {
  const data = await chrome.storage.local.get(['active', 'lastBridgeTabId']);
  if (target && typeof target === 'object') {
    const url = target.url;
    if (typeof url === 'string' && /^https:\/\/chat\.deepseek\.com\/a\/chat\/s\/[a-zA-Z0-9-]+$/.test(url)) {
      const matches = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
      const tab = matches.find(t => t.url === url);
      if (tab) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { state: 'normal', focused: true });
      } else await chrome.tabs.create({ url, active: true });
      return;
    }
    if (!target.url && target.requestId === data.active?.id) {
      const activeTab = await chrome.tabs.get(data.active.tabId).catch(() => null);
      if (activeTab?.url?.startsWith('https://chat.deepseek.com/')) {
        await chrome.tabs.update(activeTab.id, { active: true });
        await chrome.windows.update(activeTab.windowId, { state: 'normal', focused: true });
        return;
      }
    }
    throw new Error('该请求尚未记录具体网页对话链接；未跳转到主页。');
  }
  const id = data.active?.tabId ?? data.lastBridgeTabId;
  const tab = id ? await chrome.tabs.get(id).catch(() => null) : null;
  if (tab?.url?.startsWith('https://chat.deepseek.com/')) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { state: 'normal', focused: true });
  } else throw new Error('没有可显示的桥接标签页；请从 Harness 对应请求查看网页。');
}

// A single absent health response during tab activation is not proof of a reload.
// Keep the same request; an actual reload still fails closed after this grace period.
export function pageHealthState(active, health, now) {
  if (health?.activeId === active.id) return 'alive';
  if (health?.activeId || (active.healthMissingAt && now - active.healthMissingAt >= 15000)) return 'lost';
  return 'waiting';
}
