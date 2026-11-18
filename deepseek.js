export const MODEL = 'deepseek-flash';
export class DeepSeekError extends Error {
  constructor(message, { status = 0, code = 'UPSTREAM_ERROR' } = {}) {
    super(message);
    this.name = 'DeepSeekError';
    this.status = status;
    this.code = code;
  }
}

export function buildInstructions() {
  const today = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());

  return [
    '你是一个简洁、可靠的 AI 助手，运行在一个极简 DeepSeek 网页聊天应用中。',
    '请使用与用户相同的语言回答；用户没有特别说明时使用简体中文。',
    '当用户的消息中包含 http:// 或 https:// 开头的公开网页链接时，必须使用 deepseek_read_url 工具阅读网页，再结合网页内容回答；即使用户只发了一个链接，也要主动总结网页。',
    '不要在没有调用工具的情况下声称自己无法访问网页。只有工具返回读取失败时，才如实说明。',
    '优先给出直接、准确的答案；适当使用 Markdown，但不要堆砌格式。',
    `今天的日期是 ${today}（中国标准时间）。`
  ].join('\n');
}

/**
 * 把本地消息转换为 Responses API 的 input。
 * 关键点：把历史中成功读取的网页（signature）原样回传，长对话才能持续引用网页内容。
 */
export function buildInput(messages) {
  const input = [];

  for (const message of messages) {
    if (!message || !message.content) continue;

    if (message.role === 'user') {
      input.push({ role: 'user', content: String(message.content) });
      continue;
    }

    if (message.role !== 'assistant') continue;

    for (const tool of message.toolItems || []) {
      if (
        tool &&
        tool.kind === 'read_link' &&
        tool.status === 'completed' &&
        tool.signature &&
        tool.url
      ) {
        input.push({
          type: 'web_search_call',
          id: tool.id || `srvtoolu_rl_import_${Math.random().toString(36).slice(2)}`,
          status: 'completed',
          kind: 'read_link',
          action: { type: 'open_page', url: tool.url },
          page: {
            url: tool.url,
            title: tool.title || null,
            published_at: tool.publishedAt || null
          },
          signature: tool.signature
        });
      }
    }

    input.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: String(message.content) }]
    });
  }

  return input;
}

export function extractFinal(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const texts = [];
  const tools = [];

  for (const item of output) {
    if (!item) continue;
    if (item.type === 'message') {
      for (const part of item.content || []) {
        if (part?.type === 'output_text' && typeof part.text === 'string') {
          texts.push(part.text);
        }
      }
    }
    if (item.type === 'web_search_call') {
      tools.push({
        id: item.id || '',
        kind: item.kind || 'read_link',
        status: item.status || 'completed',
        url: item.action?.url || item.page?.url || '',
        title: item.page?.title || '',
        publishedAt: item.page?.published_at || null,
        signature: item.signature || '',
        error: item.error?.code || ''
      });
    }
  }

  return {
    text: texts.join(''),
    tools,
    sources: buildSources(tools),
    status: response?.status || 'completed',
    incompleteReason: response?.incomplete_details?.reason || '',
    usage: normalizeUsage(response?.usage),
    responseId: response?.id || ''
  };
}

function buildSources(tools) {
  const seen = new Set();
  const sources = [];
  for (const tool of tools) {
    if (tool.kind !== 'read_link' || tool.status !== 'completed' || !tool.url) continue;
    if (seen.has(tool.url)) continue;
    seen.add(tool.url);
    sources.push({ url: tool.url, title: tool.title || '' });
  }
  return sources;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    inputTokens: Number(usage.input_tokens || 0),
    outputTokens: Number(usage.output_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0)
  };
}

/**
 * 发起 DeepSeek Responses 流式请求，逐条产出 SSE 事件对象。
 */
export async function* streamDeepSeek({
  apiKey,
  input,
  baseUrl,
  timeoutMs = 180_000,
  signal
}) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(new DOMException('Aborted', 'AbortError'));
  if (signal) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error('DeepSeek 请求超时')), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'User-Agent': 'deepseek-lite-chat/1.0'
      },
      body: JSON.stringify({
        model: MODEL,
        instructions: buildInstructions(),
        input,
        tools: [{ type: 'deepseek_read_url' }],
        safety_check: { level: 'high' },
        max_output_tokens: 8192,
        stream: true
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const detail = await readErrorBody(response);
      throw new DeepSeekError(detail.message || `DeepSeek 返回 HTTP ${response.status}`, {
        status: response.status,
        code: detail.code || 'UPSTREAM_HTTP_ERROR'
      });
    }

    if (!response.body) {
      throw new DeepSeekError('DeepSeek 没有返回内容', { code: 'EMPTY_UPSTREAM' });
    }

    let buffer = '';
    const decoder = new TextDecoder();

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');

      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseBlock(block);
        if (event) yield event;
      }
    }

    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, '\n');
    if (buffer.trim()) {
      const event = parseSseBlock(buffer);
      if (event) yield event;
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function parseSseBlock(block) {
  let eventName = '';
  const dataLines = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return null;
  const raw = dataLines.join('\n');
  try {
    const data = JSON.parse(raw);
    if (!data.type && eventName) data.type = eventName;
    return data;
  } catch {
    return null;
  }
}

async function readErrorBody(response) {
  try {
    const text = await readLimited(response, 256 * 1024);
    const data = JSON.parse(text);
    const message = data?.error?.message || data?.message || data?.msg || text.slice(0, 300);
    const code = data?.error?.code || data?.code || '';
    return { message: String(message || ''), code: String(code || '') };
  } catch {
    return { message: '', code: '' };
  }
}

async function readLimited(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

export function friendlyDeepSeekError(error) {
  if (error?.name === 'AbortError') {
    return { code: 'ABORTED', message: '生成已停止' };
  }
  if (error?.name === 'TimeoutError' || /超时/.test(error?.message || '')) {
    return { code: 'TIMEOUT', message: 'DeepSeek 响应超时，请稍后再试' };
  }
  if (error?.message?.includes('fetch failed')) {
    return { code: 'NETWORK_ERROR', message: '无法连接 DeepSeek，请检查服务器网络' };
  }
  if (error instanceof DeepSeekError) {
    if (error.status === 401) return { code: 'INVALID_KEY', message: 'API Key 无效，请在设置中更新' };
    if (error.status === 402) return { code: 'INSUFFICIENT_BALANCE', message: 'DeepSeek 账户余额不足，请充值后再试' };
    if (error.status === 429) return { code: 'RATE_LIMITED', message: '请求太频繁，请稍后再试' };
    if (error.status === 400 && /context|token|length/i.test(error.message)) {
      return { code: 'CONTEXT_TOO_LONG', message: '对话太长，超出模型上下文限制。请新开一个对话。' };
    }
    if (error.status === 400 && /Content Exists Risk|safety|risk/i.test(error.message)) {
      return { code: 'CONTENT_RISK', message: '内容未通过安全检查，请调整后再试' };
    }
    return { code: error.code || 'UPSTREAM_ERROR', message: error.message || 'DeepSeek 请求失败' };
  }
  return { code: 'UNKNOWN', message: error?.message || '发生未知错误' };
}
