// src/ai/dsml.js
// DeepSeek V4 的 DSML 工具调用文本解析。
// 部分自定义端点/网关不会把 DSML 转成 OpenAI 的 tool_calls，而是把标记漏进 content，
// 表现为「模型明明调了工具，客户端却认为它没调」。
const OPEN_RE = /<[｜|]{1,2}DSML[｜|]{1,2}\s*/gi;
const CLOSE_RE = /<\/[｜|]{1,2}DSML[｜|]{1,2}\s*/gi;

function normalize(text) {
  return String(text || '').replace(OPEN_RE, '<DSML ').replace(CLOSE_RE, '</DSML ');
}

/** 从 content/reasoning 文本里解析 DSML 工具调用，返回 OpenAI 格式的 toolCalls */
export function parseDsmlToolCalls(text) {
  const s = normalize(text);
  if (!/<DSML\s+invoke/i.test(s)) return [];
  const out = [];
  const invokeRe = /<DSML\s+invoke\s+name="([^"]+)"\s*>([\s\S]*?)(?:<\/DSML\s+invoke>|$)/gi;
  let m;
  while ((m = invokeRe.exec(s))) {
    const name = m[1];
    const body = m[2] || '';
    const args = {};
    const paramRe = /<DSML\s+parameter\s+name="([^"]+)"(?:\s+string="(true|false)")?\s*>([\s\S]*?)(?:<\/DSML\s+parameter>|$)/gi;
    let p;
    while ((p = paramRe.exec(body))) {
      const key = p[1];
      const isString = p[2] !== 'false';
      const raw = String(p[3] || '').trim();
      if (isString) args[key] = raw;
      else {
        try { args[key] = JSON.parse(raw); } catch { args[key] = raw; }
      }
    }
    out.push({
      id: `dsml_${out.length + 1}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
  }
  return out;
}

/** 去掉正文里的 DSML 标记，避免展示给用户 */
export function stripDsml(text) {
  let s = normalize(text);
  s = s.replace(/<DSML\s+(?:tool_?calls|calls)>[\s\S]*?<\/DSML\s+(?:tool_?calls|calls)>/gi, '');
  s = s.replace(/<DSML\s+invoke[\s\S]*?<\/DSML\s+invoke>/gi, '');
  s = s.replace(/<\/?DSML[^>]*>/gi, '');
  return s.trim();
}
