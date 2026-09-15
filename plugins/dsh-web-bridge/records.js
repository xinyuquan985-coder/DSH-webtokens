// Shared verbatim with extension/records.js. Explicit wire format, never JSON repair.
(() => {
  function parse(raw, id) {
    if (typeof raw !== 'string' || raw.length > 1000000) throw new Error('工具记录超过传输容量');
    const lines = raw.trim().split(/\r?\n/);
    const begin = lines[0].match(/^DSH_CALLS_BEGIN:([\w-]+):(\d+)$/);
    if (!begin || begin[1] !== id) throw new Error('工具记录起始编号不匹配');
    const count = Number(begin[2]);
    if (!Number.isSafeInteger(count) || count < 1 || lines.at(-1) !== `DSH_CALLS_END:${id}:${count}`) throw new Error('工具记录数量或结束标记不完整');
    const calls = []; let name, params = [];
    const finish = () => {
      if (!name) throw new Error('缺少工具记录头');
      let args; try { args = JSON.parse(params.join('\n')); } catch { throw new Error(`第 ${calls.length + 1} 项参数不是完整合法 JSON`); }
      if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('每项工具参数必须是对象');
      calls.push({ name, arguments: args }); params = [];
    };
    for (const line of lines.slice(1, -1)) {
      const header = line.match(/^DSH_CALL:(\d+):([A-Za-z0-9_.-]+)$/);
      if (header) {
        if (name) finish();
        if (Number(header[1]) !== calls.length + 1) throw new Error('工具记录序号必须连续且不得重复');
        name = header[2];
      } else { if (!name) throw new Error('工具记录头之前存在额外内容'); params.push(line); }
    }
    finish();
    if (calls.length !== count) throw new Error(`声明 ${count} 项工具，实际收齐 ${calls.length} 项`);
    const bodies = calls.some(c => [c.arguments.content, c.arguments.command].some(v => v && typeof v === 'object' && '$body' in v));
    return { request_id: id, kind: 'tool_calls', calls, ...(bodies ? { body_format: 'dsh-text-v2' } : {}) };
  }
  function instructions(id) {
    return [
      '需要工具时使用逐条记录格式，整个清单放在一个 text 代码块。不要生成嵌套 calls 数组。每项单独写工具头和一个合法 JSON 参数对象，序号从 1 连续递增，起止标记中的数量必须与实际项数一致。',
      '工具名称和参数来自本轮 tools，仍由 Harness 按原权限和调度执行。依赖前一步实际结果的步骤必须分轮。',
      'pwsh.command 和 write.content 必须用 {"$body":"唯一编号"} 引用后续原始 text 块，不把长命令或文件全文转义塞入 JSON。其他参数照常填写。',
      '下面是两项工具的完整格式示例，仅演示传输，实际工具/参数按本轮定义替换：',
      '```text', `DSH_CALLS_BEGIN:${id}:2`, 'DSH_CALL:1:pwsh', '{"command":{"$body":"cmd1"},"description":"说明","workdir":"工作目录"}', 'DSH_CALL:2:read', '{"file_path":"文件路径"}', `DSH_CALLS_END:${id}:2`, '```',
      '```text', `DSH_BODY:${id}:cmd1`, '原样命令文本，保留美元符号、引号、反斜杠及换行，不做 JSON 转义', `DSH_BODY_END:${id}:cmd1`, '```',
      '每个正文引用只能对应一个当前回复内的完整正文块。若正文自身含围栏，使用更长围栏。标记与正文之间各一个分隔换行会被移除；文件末尾换行需额外保留空行。收齐全部记录与正文后才校验和执行。',
      '回复最终答案时仍使用 json 代码块：', '```json', JSON.stringify({ request_id: id, kind: 'final', text: '完整回答' }), '```'
    ].join('\n');
  }
  globalThis.DSHCallRecords = { parse, instructions };
})();
