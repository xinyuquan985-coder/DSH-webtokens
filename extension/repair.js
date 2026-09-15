(() => {
  function formatReminder(id) {
    return '【本机桥接输出约定】不能使用 DSML 或 XML。参数必须遵守本轮真实工具定义，不猜测内容。' + '\n' + globalThis.DSHCallRecords.instructions(id) + '\n当前 REQUEST_ID: ' + id;
  }
  function correctionPrompt(id, reason) {
    return [
      '【仅纠正上一条回复的传输格式，1/1】',
      '上一条回复没有通过本机桥接格式校验，本轮没有任何工具被执行。',
      ...(reason ? ['本机完整校验发现：' + reason, '请保留原任务意图，仅修正指出的字段或结构。缺少必需信息时用 final 说明，不要猜测参数。'] : []),
      '请仅把你刚才的最终回复或待执行工具请求重新表达为下列格式；不要重新规划任务，不要增加或重复执行步骤，不要把历史工具结果当成本次已经执行的结果。',
      '保留原来的工具意图和参数。缺失信息时不能猜测，请用 final 说明无法形成有效指令。',
      '工具请求改用下列逐条记录和原始正文块，最终答案用 json 代码块。不要继续重写嵌套 calls 数组，也不要猜测或修改参数内容。',
      formatReminder(id)
    ].join('\n');
  }
  function failureKind(output, id) {
    const text = output.trim().replace(/^```(?:json|text)?\s*/, '').replace(/\s*```$/, '');
    const recordId = text.match(/^DSH_CALLS_BEGIN:([\w-]+):/)?.[1];
    if (recordId && recordId !== id) return 'wrong-id';
    // A different request identifier is an isolation failure, not a formatting retry.
    try {
      const value = JSON.parse(text);
      if (typeof value?.request_id === 'string' && value.request_id !== id) return 'wrong-id';
    } catch {
      const firstField = text.match(/^\{\s*"request_id"\s*:\s*"([^"\r\n]+)"/);
      if (firstField && firstField[1] !== id) return 'wrong-id';
    }
    return /DSML/i.test(text) ? 'dsml' : 'format';
  }
  globalThis.DSHBridgeRepair = { formatReminder, correctionPrompt, failureKind };
})();
