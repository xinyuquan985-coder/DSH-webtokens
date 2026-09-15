// Same authenticated origin as Harness. Never expose thought text through /status.
export function registerPanel(ctx, broker) {
  for (const [path, method] of [['/web-bridge/panel', 'GET'], ['/web-bridge/open-page', 'POST'], ['/web-bridge/inspect-page', 'POST']]) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler(req, res) {
      const rejection = ctx.connection.requestRejection(req);
      if (rejection !== undefined) { res.writeHead(rejection); res.end(); return; }
      res.setHeader('cache-control', 'no-store');
      res.setHeader('content-type', 'application/json');
      if (req.method !== method) { res.writeHead(405, { allow: method }); res.end('{}'); return; }
      if (method === 'GET') { res.end(JSON.stringify({ ...broker.panel(), inspection: broker.inspection, projectPath: process.cwd() })); return; }
      if (!broker.status().connected) { res.writeHead(409); res.end(JSON.stringify({ error: 'Chrome 扩展未连接' })); return; }
      const detail = broker.panel().detail;
      const requestedId = req.headers?.['x-dsh-request-id'];
      if (!detail || (requestedId && requestedId !== detail.id)) { res.writeHead(409); res.end(JSON.stringify({ error: '面板请求已变化，请等待更新后重试' })); return; }
      const version = broker.worker?.version?.split('.').map(Number) ?? [];
      if (path === '/web-bridge/inspect-page') {
        if (broker.active || broker.jobs.size || !detail.websiteUrl || !(version[0] > 0 || version[1] > 2 || (version[1] === 2 && version[2] >= 17))) { res.writeHead(409); res.end(JSON.stringify({ error: '只读诊断需要空闲服务、具体对话及扩展 0.2.17' })); return; }
        const target = { requestId: detail.id, url: detail.websiteUrl, nonce: crypto.randomUUID() };
        broker.inspectPageRequested = target; broker.inspection = { nonce: target.nonce, requestId: detail.id, state: 'pending' };
        res.end(JSON.stringify({ ok: true })); return;
      }
      if (!(version[0] > 0 || version[1] > 2 || (version[1] === 2 && version[2] >= 16))) { res.writeHead(409); res.end(JSON.stringify({ error: '请将 Chrome 桥接扩展刷新至 0.2.16，才能定位具体对话' })); return; }
      broker.openPageRequested = { requestId: detail.id, url: detail.websiteUrl };
      res.end(JSON.stringify({ ok: true }));
    } }), `web-bridge: ${method} ${path}`);
  }
}
