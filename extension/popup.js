async function refresh() { const { state } = await chrome.storage.local.get('state'); document.getElementById('status').textContent = state ?? '等待本机 Harness 启动'; }
document.getElementById('open').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open-active' }));
chrome.runtime.sendMessage({ type: 'tick' }); refresh(); setInterval(refresh, 1500);
