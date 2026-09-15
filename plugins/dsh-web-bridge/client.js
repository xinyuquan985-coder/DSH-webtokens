window.__ModuleLoader__.load({
  id: 'dsh-web-bridge',
  factory: (require) => {
    const React = require('react'), h = React.createElement;
    const button = { border: '1px solid #dce2e9', borderRadius: 8, background: '#fff', padding: '7px 10px', color: '#25344a', cursor: 'pointer', fontSize: 12 };
    function BridgeButton({ wide }) {
      const [status, setStatus] = React.useState(null);
      const [opened, setOpened] = React.useState(false);
      const [notice, setNotice] = React.useState('');
      const [error, setError] = React.useState('');
      const dismissed = React.useRef(false);
      React.useEffect(() => {
        let alive = true, busy = false;
        const update = async () => {
          if (busy) return; busy = true;
          try {
            const response = await fetch('/web-bridge/panel', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
            if (!response.ok) throw new Error(response.status === 401 ? '请刷新 Harness 重新连接' : '桥接面板暂未连接');
            const data = await response.json();
            if (alive) { setStatus(data); setError(''); if (data.active && !dismissed.current) setOpened(true); }
          } catch (e) { if (alive) setError(e.message); }
          finally { busy = false; }
        };
        update(); const timer = setInterval(update, 1500);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      const detail = status?.detail;
      const done = ['completed', 'failed'].includes(detail?.state);
      const openPage = async () => {
        setNotice('正在请求显示网页…');
        try {
          const response = await fetch('/web-bridge/open-page', { method: 'POST', headers: { 'content-type': 'application/json', ...(detail?.id ? { 'x-dsh-request-id': detail.id } : {}) }, body: '{}' });
          if (!response.ok) { const result = await response.json(); throw new Error(result.error ?? '未能显示网页，请检查 Chrome 扩展连接'); }
          setNotice('已请求 Chrome 打开本轮对话');
        } catch (e) { setNotice(e.message); }
      };
      const close = () => { dismissed.current = true; setOpened(false); };
      return h('div', { style: { display: 'flex', flexDirection: 'column', width: '100%' } },
        h('button', { type: 'button', 'aria-label': '展开桥接面板', onClick: () => { dismissed.current = opened; setOpened(!opened); }, style: { border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: '10px 7px', display: 'flex', alignItems: 'center', gap: 7, fontSize: 13 } },
          h('span', { style: { color: !error && status?.connected ? '#169567' : '#d58b24' } }, '●'), wide ? h('span', { style: { display: 'grid', gap: 3, textAlign: 'left' } }, '网页桥接', h('small', { style: { maxWidth: 145, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: .75 }, title: error || status?.worker }, error || (status?.active ? status.worker : '展开桥接面板'))) : '桥'),
        opened && h('aside', { 'aria-label': '网页桥接面板', style: { position: 'fixed', top: 58, right: 16, bottom: 108, width: 'min(410px, calc(100vw - 32px))', zIndex: 500, background: '#fff', color: '#233247', border: '1px solid #dde4ed', borderRadius: 14, boxShadow: '0 10px 36px #1e34551a', display: 'flex', flexDirection: 'column', overflow: 'hidden', font: '13px/1.65 system-ui' } },
          h('header', { style: { padding: '14px 16px', borderBottom: '1px solid #edf0f4', display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, h('strong', null, '网页桥接'), h('button', { type: 'button', onClick: close, style: button, 'aria-label': '收起桥接面板' }, '收起')),
          h('div', { style: { padding: '12px 16px', borderBottom: '1px solid #edf0f4' } },
            h('div', { role: 'status', style: { color: error || detail?.state === 'failed' ? '#bd3232' : '#28645b' } }, error || (detail ? detail.phase : status?.connected ? '已连接，等待任务' : '等待 Chrome 扩展连接')),
            detail && h('small', { style: { color: '#8190a2' } }, `${done ? '本轮' : '当前轮次'} · ${Math.max(0, Math.round(((done ? detail.updatedAt : Date.now()) - detail.createdAt) / 1000))} 秒${status?.queued ? ' · 排队 ' + status.queued : ''}`),
            !done && detail?.visibility === 'hidden' && h('p', { style: { margin: '8px 0 0', color: '#916623' } }, '网页在后台。若进度长时间不变，可点下方「查看网页」恢复更新。')),
          h('div', { style: { overflowY: 'auto', padding: 16, flex: 1 } },
            h('details', null, h('summary', { style: { cursor: 'pointer', color: '#64748b' } }, '桥接步骤'), h('ol', { style: { paddingLeft: 20 } }, ...(detail?.phases ?? []).map((item, index) => h('li', { key: index, style: { margin: '8px 0' } }, item.phase)))),
            h('h4', { style: { margin: '18px 0 8px', fontSize: 13 } }, '网页可见思考'),
            h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: '#53647a' } }, detail?.reasoning || '网页开始思考后，内容会同步到这里。')),
          h('footer', { style: { padding: '12px 16px', borderTop: '1px solid #edf0f4' } }, h('button', { type: 'button', onClick: openPage, disabled: !status?.connected, style: button }, '查看网页'), h('span', { style: { fontSize: 11, marginLeft: 10, color: '#8b96a5' } }, '仅点击时切换到 Chrome'), notice && h('p', { role: 'status', style: { marginBottom: 0 } }, notice))));
    }
    return { inject: ['slots'], apply(ctx) { ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'deepseek-web-bridge', order: -20 }, BridgeButton)); } };
  }
});

