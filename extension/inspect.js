// Read-only diagnostics for a requested, already-finished conversation.
// Returns DOM shape and parsing metadata, never command contents or tool results.
(() => {
  function inspect(doc, id) {
    const records = [];
    const scopes = [...doc.querySelectorAll('.ds-markdown')];
    const nodes = [...new Set([...doc.querySelectorAll('pre, code, [class*="code"]'), ...scopes.flatMap(n => [...n.querySelectorAll('div, pre, code')])])];
    for (const node of nodes.slice(0, 10000)) {
      if (!node.getClientRects().length || node.closest('.ds-think-content, [class*="thinking-content"], [class*="think-content"]')) continue;
      for (const field of ['textContent', 'innerText']) {
        const raw = (node[field] ?? '').trim();
        if (!raw.includes(id) || !raw.includes('"request_id"') || raw.length > 1000000) continue;
        const entry = { tag: node.tagName, classes: String(node.className).slice(0, 200), parent: String(node.parentElement?.className ?? '').slice(0, 200), standard: node.matches('pre code, pre'), field, chars: raw.length, startsObject: raw.startsWith('{'), endsObject: raw.endsWith('}') };
        try { const v = JSON.parse(raw); entry.jsonValid = true; entry.matchingId = v?.request_id === id; entry.kind = ['final', 'tool_calls'].includes(v?.kind) ? v.kind : 'other'; entry.callCount = Array.isArray(v?.calls) ? v.calls.length : null; }
        catch (e) { entry.jsonValid = false; const pos = e.message.match(/position (\d+)/)?.[1]; if (pos) { entry.errorPosition = Number(pos); entry.errorCharCode = raw.charCodeAt(Number(pos)); } }
        records.push(entry);
        if (records.length >= 80) break;
      }
      if (records.length >= 80) break;
    }
    return { requestId: id, records, inspectedNodes: Math.min(nodes.length, 10000), standardCodeNodes: doc.querySelectorAll('pre code, pre').length, executed: false };
  }
  globalThis.DSHBridgeInspect = { inspect };
})();
