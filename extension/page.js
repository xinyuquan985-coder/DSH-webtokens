(() => {
  const selectors = '[data-message-role="assistant"], [data-role="assistant"], .ds-markdown, .ds-think-content, [class*="thinking-content"], [class*="think-content"]';
  const thinkSelector = '.ds-think-content, [class*="thinking-content"], [class*="think-content"]';
  const rowSelector = '[data-virtual-list-item-key]';
  const rowKey = node => node?.getAttribute?.('data-virtual-list-item-key');
  const visible = node => !!node?.getClientRects().length;
  function createClock(now = Date.now, timer = setTimeout, clear = clearTimeout) {
    const waiting = new Set();
    function finish(entry) { if (waiting.delete(entry)) { clear(entry.timer); entry.resolve(); } }
    function sleep(ms) {
      return new Promise(resolve => {
        const entry = { due: now() + ms, resolve }; waiting.add(entry);
        entry.timer = timer(() => finish(entry), ms);
      });
    }
    sleep.flush = () => { for (const entry of waiting) if (entry.due <= now()) finish(entry); };
    return sleep;
  }
  function capture(doc) {
    const baseline = new Map([...doc.querySelectorAll(selectors), ...doc.querySelectorAll('pre code, pre')].map(node => [node, (node.innerText ?? node.textContent ?? '').trim()]));
    baseline.rows = new Set([...doc.querySelectorAll(rowSelector)].map(rowKey).filter(Boolean));
    baseline.texts = new Set([...baseline.values()].filter(Boolean));
    baseline.currentRows = new Set();
    baseline.scoped = baseline.rows.size > 0;
    return baseline;
  }
  function turnScope(doc, baseline, id) {
    const rows = [...doc.querySelectorAll(rowSelector)].filter(row => rowKey(row));
    baseline.currentRows ??= new Set();
    if (rows.length) baseline.scoped = true;
    // Virtualized rows are recreated, so DOM object identity is not a message ID.
    // Bind to the newest submitted prompt, then collect only rows after that prompt.
    const anchors = rows.filter(row => {
      const text = (row.textContent ?? row.innerText ?? '').trim();
      return !baseline.rows?.has(rowKey(row)) &&
        (text.startsWith('你正在通过本机桥接为 DeepSeek Harness') || text.startsWith('【仅纠正上一条回复的传输格式')) &&
        (text.includes('当前 REQUEST_ID: ' + id) || text.includes('"request_id":"' + id + '","purpose":"compaction"'));
    });
    const anchor = anchors.at(-1);
    if (anchor) baseline.anchor = rowKey(anchor);
    const index = rows.findIndex(row => rowKey(row) === baseline.anchor);
    if (index >= 0) for (const row of rows.slice(index + 1)) {
      const text = row.textContent ?? row.innerText ?? '';
      if (text.includes('你正在通过本机桥接为 DeepSeek Harness') || text.includes('当前 REQUEST_ID: ')) break;
      if (!baseline.rows?.has(rowKey(row))) baseline.currentRows.add(rowKey(row));
    }
    return node => {
      if (baseline.scoped) return baseline.currentRows.has(rowKey(node.closest?.(rowSelector)));
      const text = (node.innerText ?? node.textContent ?? '').trim();
      return (!baseline.has(node) || baseline.get?.(node) === '') && (!text || !baseline.texts?.has(text));
    };
  }
  function markedSummary(text, id) {
    const lines = text.split(/\r?\n/);
    const begin = `[[DSH_SUMMARY_BEGIN:${id}]]`, end = `[[DSH_SUMMARY_END:${id}]]`;
    const starts = lines.flatMap((line, index) => line.trim() === begin ? [index] : []);
    const ends = lines.flatMap((line, index) => line.trim() === end ? [index] : []);
    if (starts.length !== 1 || ends.length !== 1 || ends[0] <= starts[0] + 1) return null;
    const textBody = lines.slice(starts[0] + 1, ends[0]).join('\n').trim();
    return textBody ? begin + '\n' + textBody + '\n' + end : null;
  }
  function scan(doc, baseline, id, replyFormat = 'json') {
    const texts = []; const output = []; let answer = null, protocolIssue = null;
    const fresh = turnScope(doc, baseline, id);
    const bodyNodes = [...doc.querySelectorAll('pre code, pre')]
      .filter(node => fresh(node) && visible(node) && !node.closest?.(thinkSelector) && !(node.matches?.('pre') && node.querySelector?.('code')))
      .filter(node => (node.textContent ?? '').startsWith(`DSH_BODY:${id}:`));
    function candidate(plain, source) {
      const recordFormat = plain.startsWith('DSH_CALLS_BEGIN:');
      const value = recordFormat ? globalThis.DSHCallRecords.parse(plain, id) : JSON.parse(plain);
      if (recordFormat) value.call_records = plain;
      if (!value || value.request_id !== id || !['final', 'tool_calls'].includes(value.kind)) return null;
      if (value.body_format === undefined && value.body_blocks === undefined) return recordFormat ? JSON.stringify(value) : plain;
      if (!['dsh-text-v1', 'dsh-text-v2'].includes(value.body_format) || value.kind !== 'tool_calls' || value.body_blocks !== undefined || !Array.isArray(value.calls)) return null;
      // Even fresh rows cannot donate a body to another assistant message.
      const sourceRow = rowKey(source?.closest?.(rowSelector));
      const bodyBlocks = bodyNodes.filter(node => !sourceRow || rowKey(node.closest?.(rowSelector)) === sourceRow).map(node => node.textContent ?? '');
      const refs = value.calls.flatMap(call => {
        const ref = call?.name === 'write' ? call.arguments?.content : value.body_format === 'dsh-text-v2' && call?.name === 'pwsh' ? call.arguments?.command : null;
        return typeof ref?.$body === 'string' ? [ref.$body] : [];
      });
      if (!refs.length || new Set(refs).size !== refs.length || bodyBlocks.length !== refs.length) return null;
      for (const name of refs) {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(name)) return null;
        const matching = bodyBlocks.filter(raw => raw.split(/\r?\n/, 1)[0] === `DSH_BODY:${id}:${name}`);
        if (matching.length !== 1 || !matching[0].replace(/\r?\n$/, '').endsWith(`\nDSH_BODY_END:${id}:${name}`)) return null;
      }
      return JSON.stringify({ ...value, body_blocks: bodyBlocks });
    }
    const all = [...doc.querySelectorAll(selectors)];
    const nodes = all.filter(node => fresh(node) && visible(node));
    for (const node of nodes) {
      const raw = (node.innerText ?? node.textContent ?? '').trim();
      if (!raw || raw.includes('你正在通过本机桥接为 DeepSeek Harness') || raw.includes('当前 REQUEST_ID: ')) continue;
      const isThinking = !!(node.matches?.(thinkSelector) || node.closest?.(thinkSelector));
      if (isThinking) {
        if (!node.querySelector(selectors)) texts.push(raw);
        continue;
      }
      const codeNodes = [...node.querySelectorAll('pre code, pre')].filter(el => fresh(el) && !el.closest?.(thinkSelector));
      const code = codeNodes.map(el => el.textContent.trim());
      // DeepSeek can render a valid manifest as a normal paragraph followed by
      // a text code block. Parse that entire paragraph, never JSON substrings.
      const paragraphs = [...node.querySelectorAll('p, .ds-markdown-paragraph')]
        .filter(el => fresh(el) && visible(el) && !el.closest?.('pre, code, ' + thinkSelector) && !el.querySelector?.('pre, code, ' + thinkSelector));
      const choices = codeNodes.map(el => ({ source: el, choice: el.textContent.trim() }))
        .concat(paragraphs.map(el => ({ source: el, choice: (el.innerText ?? el.textContent ?? '').trim() })));
      if (!node.querySelector(thinkSelector)) choices.push({ source: node, choice: raw });
      for (const { choice, source } of choices) {
        const plain = choice.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
        try {
          if (replyFormat === 'json') answer = candidate(plain, source) ?? answer;
        } catch { protocolIssue = jsonIssue(plain, id) ?? protocolIssue; }
      }
      if (replyFormat === 'summary' && !node.querySelector(selectors)) answer = markedSummary(raw, id) ?? answer;
      const recordOutput = code.find(value => value.startsWith('DSH_CALLS_BEGIN:'));
      if (recordOutput) output.push(recordOutput);
      else if (raw.startsWith('{') || raw.startsWith('```') || code.some(value => value.startsWith('{'))) output.push(code.at(-1) ?? raw);
      else if (!node.querySelector(selectors)) output.push(raw);
    }
    let fallbackUsed = false;
    if (!answer && replyFormat === 'summary') answer = markedSummary(output.join('\n'), id);
    // Website class names are not a stable API. The visible page's unique, standalone
    // markers also delimit a summary when no known Markdown containers are present.
    if (!answer && replyFormat === 'summary' && !nodes.length && !baseline.scoped) {
      answer = markedSummary(doc.body?.innerText ?? '', id);
      if (answer) { output.push(answer); fallbackUsed = true; }
    }
    if (!answer && replyFormat === 'json') {
      for (const node of doc.querySelectorAll('pre code, pre')) {
        if (!fresh(node) || !visible(node) || node.closest?.(thinkSelector)) continue;
        const raw = (node.textContent ?? '').trim();
        try {
          const value = candidate(raw, node);
          if (value) { answer = value; output.push(raw); fallbackUsed = true; break; }
        } catch { protocolIssue = jsonIssue(raw, id) ?? protocolIssue; }
      }
    }
    return { answer, protocolIssue: answer ? null : protocolIssue, reasoning: texts.join('\n\n').slice(0, 100000), outputText: output.at(-1) ?? '', metrics: { totalNodes: all.length, currentNodes: nodes.length, thinkingNodes: texts.length, outputNodes: output.length, fallbackUsed, visibility: doc.visibilityState ?? 'unknown' } };
  }
  function jsonIssue(raw, id) {
    if (raw.startsWith('DSH_CALLS_BEGIN:' + id + ':')) {
      try { globalThis.DSHCallRecords.parse(raw, id); return null; } catch (e) { return { code: 'WEB_REPLY_CALLS', message: '工具逐条记录无效：' + e.message + '。请重新输出完整记录及正文，不得省略结束标记。' }; }
    }
    // Diagnose only a complete candidate belonging to this request. Never rewrite it.
    const first = raw.match(/^\{\s*"request_id"\s*:\s*"([^"\r\n]+)"/);
    if (!first || first[1] !== id) return null;
    let error;
    try { JSON.parse(raw); return null; } catch (e) { error = e; }
    const stack = []; let quoted = false, escaped = false;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
      if (c === '"') { quoted = true; continue; }
      if (c === '{' || c === '[') stack.push(c);
      if (c === '}' || c === ']') {
        const expected = stack.at(-1) === '{' ? '}' : stack.at(-1) === '[' ? ']' : null;
        if (expected !== c) return { code: 'WEB_REPLY_JSON', position: i, expected, actual: c, message: `JSON 第 ${i + 1} 个字符遇到 ${c}，${expected ? '前面的结构应先用 ' + expected + ' 闭合' : '但没有对应的起始括号'}。请检查每个 arguments 对象、工具调用对象、calls 数组和顶层对象的闭合顺序。原回复未执行；保持全部参数原意，重新输出完整合法 JSON。` };
        stack.pop();
      }
    }
    const position = Number(error.message.match(/position (\d+)/)?.[1]);
    return { code: 'WEB_REPLY_JSON', ...(Number.isFinite(position) ? { position } : {}), message: 'JSON 语法无效' + (Number.isFinite(position) ? `，错误位于第 ${position + 1} 个字符附近` : '') + '。请检查字符串转义、逗号和括号闭合；原回复未执行，重新输出完整合法 JSON，不改动工具参数意图。' };
  }
  globalThis.DSHBridgePage = { createClock, capture, scan, jsonIssue };
})();
