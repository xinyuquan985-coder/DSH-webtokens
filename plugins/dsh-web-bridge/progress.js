// Progress is display-only. Only the separately validated final reply may invoke tools.
export async function* streamProgress(broker, request, signal, index = 0) {
  const updates = []; let wake, done = false, response, failure;
  const notify = () => { wake?.(); wake = null; };
  Promise.resolve().then(() => broker.submit(request, signal, progress => {
    if (updates.length >= 64) updates[updates.length - 1] = progress;
    else updates.push(progress);
    notify();
  })).then(value => { response = value; }, error => { failure = error; }).finally(() => { done = true; notify(); });
  let opened = false, text = '', phase = '', thinking = '';
  while (!done || updates.length) {
    if (!updates.length) { await new Promise(resolve => { wake = resolve; }); continue; }
    const update = updates.shift(); let delta = '';
    if (update.phase && update.phase !== phase) { phase = update.phase; delta += '\n【桥接进度】' + phase + '\n'; }
    if (typeof update.reasoning === 'string' && update.reasoning !== thinking) {
      if (update.reasoning.startsWith(thinking)) {
        if (!thinking) delta += '\n【DeepSeek 网页可见思考】\n';
        delta += update.reasoning.slice(thinking.length);
      } else if (update.reasoning) delta += '\n【网页思考更新】\n' + update.reasoning;
      thinking = update.reasoning;
    }
    if (!delta) continue;
    if (!opened) { opened = true; yield { type: 'block-start', index, blockType: 'reasoning' }; }
    text += delta;
    yield { type: 'reasoning-delta', index, text: delta };
  }
  if (opened) yield { type: 'block-end', index, block: { type: 'reasoning', text } };
  return { response, failure, nextIndex: opened ? index + 1 : index };
}
