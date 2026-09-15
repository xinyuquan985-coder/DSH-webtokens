import { request as httpRequest } from 'node:http';
import { BridgeError } from './protocol.js';

export function submitRemote({ port, token, timeoutMs = 600000 }, request, signal, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ id: request.id, sessionKey: request.sessionKey, prompt: request.prompt, replyFormat: request.replyFormat, contextPolicy: request.contextPolicy, contextPhase: request.contextPhase, replyValidation: request.replyValidation, callRecords: request.callRecords, tools: request.tools });
    let terminal = false;
    const req = httpRequest({ hostname: '127.0.0.1', port, path: '/adapter/stream', method: 'POST', signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'content-length': Buffer.byteLength(payload) }
    }, res => {
      let pending = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        pending += chunk;
        if (pending.length > 6000000) return req.destroy(new BridgeError('桥接回复超过大小限制。', 'WEB_RESPONSE_LIMIT'));
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (terminal) continue;
            if (data.type === 'progress') onProgress(data);
            if (data.type === 'result') {
              if (typeof data.text !== 'string') throw new BridgeError('桥接结果缺少文本。');
              terminal = true; resolve(data.text);
            }
            if (data.type === 'error') { terminal = true; reject(new BridgeError(data.error, data.code)); }
          } catch (error) { req.destroy(error); }
        }
      });
      res.on('error', reject);
      res.on('end', () => { if (!terminal) reject(new BridgeError(`本机桥接未返回最终结果（HTTP ${res.statusCode}）。`, 'WEB_TRANSPORT_ERROR')); });
    });
    const deadline = setTimeout(() => req.destroy(new BridgeError('本机桥接响应超时。', 'WEB_TIMEOUT')), timeoutMs + 15000);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', error => reject(signal?.aborted ? new BridgeError('任务已取消。', 'WEB_ABORTED') : error));
    req.end(payload);
  });
}
