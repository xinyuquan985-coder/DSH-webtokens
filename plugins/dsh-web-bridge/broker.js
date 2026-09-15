import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { BridgeError, MAX_PROMPT_CHARS, compileTools, parseReply, replyMetadata, canCorrectReply } from './protocol.js';

export class Broker {
  constructor({ token, port = 3081, timeoutMs = 600000, onEvent = () => {} }) {
    if (!token || token.length < 32) throw new Error('Missing strong local bridge pairing token');
    this.token = token; this.port = port; this.timeoutMs = timeoutMs; this.onEvent = onEvent;
    this.jobs = new Map(); this.active = null; this.worker = null; this.lastPanel = null; this.openPageRequested = false;
  }
  submit(request, signal, onProgress = () => {}) {
    if (signal?.aborted) return Promise.reject(new BridgeError('任务已取消。', 'WEB_ABORTED'));
    const validators = request.validators ?? compileTools(request.tools ?? []);
    return new Promise((resolve, reject) => {
      const job = { id: request.id, sessionKey: request.sessionKey, prompt: request.prompt, replyFormat: request.replyFormat === 'summary' ? 'summary' : 'json', contextPolicy: request.contextPolicy, contextPhase: request.contextPhase, replyValidation: request.replyValidation, callRecords: request.callRecords, validators, state: 'queued', createdAt: Date.now(), resolve, reject, signal, onProgress };
      job.abort = () => this.finish(job, new BridgeError('任务已取消，网页后续回复不会执行。', 'WEB_ABORTED'));
      signal?.addEventListener('abort', job.abort, { once: true });
      job.timer = setTimeout(() => this.finish(job, new BridgeError('等待网页超时。请检查 Chrome 的桥接标签页和登录状态。', 'WEB_TIMEOUT')), this.timeoutMs);
      this.jobs.set(job.id, job); this.event(job, 'queued');
      this.progress(job, { phase: this.worker ? '已排队，等待专用网页处理本轮任务' : '等待 Chrome 桥接扩展连接' });
    });
  }
  event(job, type, extra = {}) { this.onEvent({ time: new Date().toISOString(), id: job?.id, sessionKey: job?.sessionKey, type, ...extra }); }
  validateReply(job, text, stage = 'preflight') {
    const meta = replyMetadata(text);
    try {
      const parsed = parseReply(text, job);
      this.event(job, 'reply-validation', { stage, valid: true, ...meta });
      return { valid: true, kind: parsed.kind, callCount: parsed.calls?.length ?? 0 };
    } catch (error) {
      this.event(job, 'reply-validation', { stage, valid: false, ...meta, code: error.code, ...error.details });
      return { valid: false, code: error.code, message: error.message, correctable: canCorrectReply(error), ...error.details };
    }
  }
  progress(job, data) {
    if (!this.jobs.has(job.id)) return;
    if (typeof data.url === 'string') {
      try {
        const url = new URL(data.url);
        if (url.origin === 'https://chat.deepseek.com' && url.pathname.length < 1000) {
          const location = url.origin + url.pathname; // No query, fragment or credentials in audit.
          if (/^\/a\/chat\/s\/[a-zA-Z0-9-]+$/.test(url.pathname) && location !== job.websiteUrl) { job.websiteUrl = location; this.event(job, 'website-conversation', { url: location }); }
        }
      } catch {}
    }
    if (data.metrics && typeof data.metrics === 'object') {
      const metrics = Object.fromEntries(['totalNodes', 'currentNodes', 'thinkingNodes', 'outputNodes'].map(key => [key, Math.max(0, Math.min(10000, Number(data.metrics[key]) || 0))]));
      metrics.visibility = ['visible', 'hidden'].includes(data.metrics.visibility) ? data.metrics.visibility : 'unknown';
      job.visibility = metrics.visibility;
      metrics.fallbackUsed = data.metrics.fallbackUsed === true;
      const key = JSON.stringify(metrics);
      if (key !== job.metricsKey) { job.metricsKey = key; this.event(job, 'page-metrics', metrics); }
    }
    const rawPhase = typeof data.phase === 'string' ? data.phase.slice(0, 160) : job.rawPhase ?? '等待网页';
    job.rawPhase = rawPhase;
    const phase = (job.contextPhase ? job.contextPhase + ' · ' : '') + (job.replyFormat === 'summary' && !rawPhase.startsWith('上下文压缩：') ? '上下文压缩：' + rawPhase : rawPhase);
    const reasoning = typeof data.reasoning === 'string' ? data.reasoning.slice(0, 100000) : job.progress?.reasoning ?? '';
    if (job.progress?.phase === phase && job.progress?.reasoning === reasoning) return;
    const phaseChanged = job.progress?.phase !== phase;
    job.progress = { phase, reasoning, updatedAt: Date.now() };
    job.phases ??= [];
    if (phaseChanged) job.phases = [...job.phases, { phase, time: Date.now() }].slice(-24);
    job.onProgress(job.progress);
    if (phaseChanged) this.event(job, 'progress', { phase, reasoningChars: reasoning.length });
  }
  finish(job, error, text) {
    if (!this.jobs.has(job.id)) return false;
    if (error) this.progress(job, { phase: '本轮已停止：' + error.message });
    this.lastPanel = { id: job.id, sessionKey: job.sessionKey, websiteUrl: job.websiteUrl, state: error ? 'failed' : 'completed', phase: error ? error.message : '本轮网页回复已回传', reasoning: job.progress?.reasoning ?? '', phases: job.phases ?? [], createdAt: job.createdAt, updatedAt: Date.now(), visibility: job.visibility };
    clearTimeout(job.timer); job.signal?.removeEventListener('abort', job.abort);
    this.jobs.delete(job.id); if (this.active === job.id) this.active = null;
    this.event(job, error ? 'failed' : 'completed', error ? { code: error.code, message: error.message } : { responseChars: text.length });
    if (error) job.reject(error); else job.resolve(text);
    return true;
  }
  status() {
    const job = this.jobs.get(this.active);
    return { version: '0.2.15', connected: !!this.worker && Date.now() - this.worker.seenAt < 45000, workerVersion: this.worker?.version, worker: job?.progress?.phase ?? this.worker?.state ?? '未连接 Chrome 扩展', queued: [...this.jobs.values()].filter(j => j.state === 'queued').length, active: job ? { id: this.active, state: job.state, updatedAt: job.progress?.updatedAt, elapsedSeconds: Math.floor((Date.now() - job.createdAt) / 1000) } : null };
  }
  panel() {
    const job = this.jobs.get(this.active) ?? [...this.jobs.values()][0];
    return { ...this.status(), detail: job ? { id: job.id, sessionKey: job.sessionKey, websiteUrl: job.websiteUrl, state: job.state, phase: job.progress?.phase, reasoning: job.progress?.reasoning ?? '', phases: job.phases ?? [], createdAt: job.createdAt, updatedAt: job.progress?.updatedAt, visibility: job.visibility } : this.lastPanel };
  }
  setPanelOutcome(id, error, kind) {
    if (!this.lastPanel || !id || this.lastPanel.id !== id) return;
    Object.assign(this.lastPanel, { state: error ? 'failed' : 'completed', phase: error ? '本轮已停止：' + error : kind === 'tool_calls' ? '工具指令已校验，交给 Harness 执行' : '回答已校验并回传 Harness', updatedAt: Date.now() });
  }
  authorized(req) {
    const value = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const a = Buffer.from(value); const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  async start() {
    this.server = createServer((req, res) => this.handle(req, res).catch(error => { if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }));
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.port, '127.0.0.1', resolve); });
    this.port = this.server.address().port;
  }
  async close() {
    for (const job of [...this.jobs.values()]) this.finish(job, new BridgeError('本机桥接服务已停止。', 'WEB_DISCONNECTED'));
    if (this.server) { this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); }
  }
  async handle(req, res) {
    const host = `127.0.0.1:${this.port}`;
    if (req.headers.host !== host) { res.writeHead(403); return res.end(); }
    const origin = req.headers.origin;
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) && origin !== 'http://127.0.0.1:3080' && origin !== `http://${host}`) { res.writeHead(403); return res.end(); }
    if (origin) res.setHeader('access-control-allow-origin', origin);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type' }); return res.end(); }
    const pathname = new URL(req.url, `http://${host}`).pathname;
    if (req.method === 'GET' && pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors http://127.0.0.1:3080" }); return res.end(portal); }
    if (req.method === 'GET' && pathname === '/status') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(this.status())); }
    if (!this.authorized(req)) { res.writeHead(401); return res.end(); }
    if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) { res.writeHead(405); return res.end(); }
    req.setEncoding('utf8');
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 1500000) throw new Error('Request too large'); }
    const body = JSON.parse(raw || '{}');
    const send = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (pathname === '/adapter/request' || pathname === '/adapter/stream') {
      if (body.callRecords !== undefined && body.callRecords !== 1) return send({ error: 'Invalid tool record contract' }, 400);
      if (body.replyValidation !== undefined && (body.replyValidation !== 1 || !Array.isArray(body.tools))) return send({ error: 'Invalid reply validation contract' }, 400);
      if (typeof body.id !== 'string' || !/^[\w-]{1,100}$/.test(body.id) || typeof body.prompt !== 'string' || body.prompt.length > MAX_PROMPT_CHARS || typeof body.sessionKey !== 'string' || (body.contextPolicy !== undefined && body.contextPolicy !== 1) || (body.contextPhase !== undefined && (typeof body.contextPhase !== 'string' || body.contextPhase.length > 160)) || this.jobs.has(body.id)) return send({ error: 'Invalid adapter request' }, 400);
      const controller = new AbortController();
      res.once('close', () => { if (!res.writableEnded) controller.abort(); });
      if (pathname === '/adapter/stream') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const emit = value => { if (!res.destroyed) res.write(JSON.stringify(value) + '\n'); };
        const heartbeat = setInterval(() => emit({ type: 'heartbeat' }), 15000);
        try { const text = await this.submit(body, controller.signal, progress => emit({ type: 'progress', ...progress })); emit({ type: 'result', text }); }
        catch (error) { emit({ type: 'error', error: error.message, code: error.code }); }
        finally { clearInterval(heartbeat); res.end(); }
        return;
      }
      try { return send({ text: await this.submit(body, controller.signal) }); }
      catch (error) { if (!res.destroyed) return send({ error: error.message, code: error.code }, 409); }
      return;
    }
    if (pathname === '/worker/inspection') {
      if (!this.worker || body.clientId !== this.worker.id || !this.inspection || this.inspection.state !== 'pending' || body.nonce !== this.inspection.nonce) return send({ error: 'Stale inspection' }, 409);
      this.inspection = { ...this.inspection, state: 'complete', result: body.result };
      return send({ ok: true });
    }
    if (pathname === '/worker/poll') {
      if (typeof body.clientId !== 'string') return send({ error: 'Missing worker identity' }, 400);
      if (this.worker && this.worker.id !== body.clientId && Date.now() - this.worker.seenAt < 45000) return send({ error: '另一个 Chrome 桥接实例已连接' }, 409);
      this.worker = { id: body.clientId, version: String(body.version ?? '0.1.0'), state: String(body.state ?? '已连接').slice(0, 160), seenAt: Date.now() };
      const openPage = this.openPageRequested; this.openPageRequested = false;
      if (this.inspectPageRequested && !this.active && !body.busy) { const inspectPage = this.inspectPageRequested; this.inspectPageRequested = null; return send({ job: null, openPage, inspectPage }); }
      if (this.active || body.busy) return send({ job: null, openPage });
      const job = [...this.jobs.values()].find(j => j.state === 'queued');
      if (!job) return send({ job: null, openPage });
      const version = this.worker.version.split('.').map(Number);
      const capable = version.length === 3 && version.every(Number.isInteger) && (version[0] > 0 || version[1] > 2 || (version[1] === 2 && version[2] >= 14));
      const validatesReplies = capable && (version[0] > 0 || version[1] > 2 || version[2] >= 15);
      if (job.callRecords === 1 && !(capable && (version[0] > 0 || version[1] > 2 || version[2] >= 19))) {
        this.finish(job, new BridgeError('请刷新 Chrome 网页桥接扩展至 0.2.19，启用逐条工具记录和原始命令传输。', 'WEB_EXTENSION_UPDATE'));
        return send({ job: null, openPage });
      }
      if (job.replyValidation === 1 && !validatesReplies) {
        this.finish(job, new BridgeError('请重新加载 Chrome 网页桥接扩展至 0.2.15，以启用多工具完整校验和自动纠正。', 'WEB_EXTENSION_UPDATE'));
        return send({ job: null, openPage });
      }
      if (job.contextPolicy === 1 && !capable) {
        this.finish(job, new BridgeError('请在 Chrome 扩展管理页重新加载网页桥接 0.2.15 或更新版本，以启用上下文容量管理。', 'WEB_EXTENSION_UPDATE'));
        return send({ job: null, openPage });
      }
      job.state = 'claimed'; job.lease = randomUUID(); job.clientId = body.clientId; this.active = job.id; this.event(job, 'claimed');
      this.progress(job, { phase: '扩展已接收，正在准备专用网页' });
      return send({ openPage, job: { id: job.id, lease: job.lease, sessionKey: job.sessionKey, prompt: job.prompt, replyFormat: job.replyFormat, contextPolicy: job.contextPolicy, replyValidation: job.replyValidation } });
    }
    const match = pathname.match(/^\/job\/([\w-]+)$/);
    if (match) {
      const job = this.jobs.get(match[1]);
      if (!job) return send({ cancelled: true }, 410);
      if (job.lease !== body.lease || job.clientId !== body.clientId) return send({ error: 'Stale lease' }, 409);
      if (body.action === 'status') return send({ cancelled: false, state: job.state });
      if (body.action === 'validate' && job.replyValidation === 1) return send(this.validateReply(job, body.text));
      if (body.action === 'progress') { this.progress(job, body); return send({ ok: true }); }
      if (body.action === 'sent' || body.action === 'generating') {
        if (job.state !== body.action) { job.state = body.action; this.event(job, body.action, { url: typeof body.url === 'string' && body.url.startsWith('https://chat.deepseek.com/') ? body.url : undefined }); }
        return send({ ok: true });
      }
      if (body.action === 'result' && typeof body.text === 'string') {
        if (job.replyValidation === 1) {
          const validation = this.validateReply(job, body.text, 'completion');
          if (!validation.valid) { this.finish(job, new BridgeError(validation.message, validation.code)); return send({ ok: false, error: validation.message }); }
        }
        this.finish(job, null, body.text); return send({ ok: true });
      }
      if (body.action === 'error') { this.finish(job, new BridgeError(String(body.error ?? '网页读取失败').slice(0, 1000), 'WEB_PAGE_ERROR')); return send({ ok: true }); }
    }
    return send({ error: 'Unknown operation' }, 404);
  }
}

const portal = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>DeepSeek 网页桥接</title><style>body{margin:0;padding:32px;font:15px/1.7 system-ui;color:#18243b;background:#f8faff}main{max-width:720px;margin:auto}h1{font-size:24px}section{background:white;padding:24px;border:1px solid #e4e9f2;border-radius:16px;margin:18px 0}a{color:#4263eb}#status{font-size:18px}code{word-break:break-all}small{color:#65718a}</style><main><h1>DeepSeek 网页桥接</h1><p>在 Harness 选择「DeepSeek 网页」，由已登录的 Chrome 完成回答。</p><section><strong id="status">正在检查连接…</strong><p id="detail"></p><a href="https://chat.deepseek.com/" target="_blank" rel="noopener noreferrer">打开 DeepSeek 网页 ↗</a></section><section><b>首次安装 Chrome 扩展</b><ol><li>打开 Chrome 扩展管理页，开启开发者模式。</li><li>点击「加载已解压的扩展程序」，选择本项目的 <code>extension</code> 文件夹。</li><li>在 Chrome 正常登录 DeepSeek。扩展会为 Harness 会话建立专用网页标签。</li><li>回到 Harness，选择「DeepSeek 网页」发送任务。</li></ol></section><small>这里使用网页会话，无需 API Key。任务上下文和所请求的工具结果会送到 DeepSeek。工具操作仍经过 Harness 原有权限流程。</small></main><script>async function refresh(){try{const s=await(await fetch('/status')).json();document.getElementById('status').textContent=s.connected?'Chrome 扩展已连接':'等待 Chrome 扩展连接';document.getElementById('detail').textContent=s.worker+' · 排队 '+s.queued+(s.active?' · 当前 '+s.active.state:'')}catch{document.getElementById('status').textContent='本机服务未连接'}}refresh();setInterval(refresh,2000)</script></html>`;
