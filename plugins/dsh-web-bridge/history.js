import { open } from 'node:fs/promises';

// Restore only the last terminal request's location/status from our local audit.
// No browser profile access, raw replies, credentials or executable content.
export function lastPanelFromAudit(text) {
  const rows = text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const terminal = rows.findLast(e => ['completed', 'failed'].includes(e.type) && typeof e.id === 'string');
  if (!terminal) return null;
  const own = rows.filter(e => e.id === terminal.id);
  const location = own.findLast(e => e.type === 'website-conversation' && /^https:\/\/chat\.deepseek\.com\/a\/chat\/s\/[a-zA-Z0-9-]+$/.test(e.url ?? ''));
  const updatedAt = Date.parse(terminal.time);
  if (!Number.isFinite(updatedAt)) return null;
  return { id: terminal.id, sessionKey: terminal.sessionKey, websiteUrl: location?.url, state: terminal.type === 'failed' ? 'failed' : 'completed', phase: terminal.type === 'failed' ? terminal.message : '本轮网页回复已回传', reasoning: '', phases: [], createdAt: Date.parse(own.find(e => e.type === 'queued')?.time) || updatedAt, updatedAt };
}
export async function restoreLastPanel(path) {
  if (!path) return null;
  let file;
  try {
    file = await open(path, 'r');
    const { size } = await file.stat();
    const start = Math.max(0, size - 1048576);
    const buffer = Buffer.alloc(size - start);
    await file.read(buffer, 0, buffer.length, start);
    const tail = buffer.toString('utf8');
    return lastPanelFromAudit(start ? tail.slice(tail.indexOf('\n') + 1) : tail);
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  finally { await file?.close(); }
}
