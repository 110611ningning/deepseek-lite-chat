import crypto from 'node:crypto';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { safeHttpUrl, titleFromText, asIso } from './text.js';

export const EXPORT_FORMAT_VERSION = 3;
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 128 * 1024 * 1024;

export class HistoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HistoryError';
    this.code = code;
  }
}

export function importHistoryZip(buffer, { existingSourceKeys = new Set() } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new HistoryError('EMPTY_FILE', '请选择 DeepSeek 导出的 ZIP 文件');
  }

  let entries;
  try {
    let total = 0;
    entries = unzipSync(new Uint8Array(buffer), {
      filter(file) {
        if (!file || !file.name || file.name.endsWith('/')) return false;
        const allowed =
          file.name === 'manifest.json' ||
          file.name === 'chat_session_index.json' ||
          /^chat_sessions\/[^/\\]+\.json$/.test(file.name);
        if (!allowed) return false;
        total += Number(file.originalSize || 0);
        if (total > MAX_JSON_BYTES) {
          throw new HistoryError('ZIP_TOO_LARGE', 'ZIP 解压后的对话数据过大');
        }
        if (Number(file.originalSize || 0) > MAX_SESSION_BYTES) {
          throw new HistoryError('ZIP_TOO_LARGE', '单个对话文件过大');
        }
        return true;
      }
    });
  } catch (error) {
    if (error instanceof HistoryError) throw error;
    throw new HistoryError('ZIP_INVALID', '无法解压这个 ZIP，请确认是 DeepSeek 官网导出的对话包');
  }

  if (!entries['manifest.json']) {
    throw new HistoryError('ZIP_INVALID', 'ZIP 中缺少 manifest.json，不像是 DeepSeek 导出的对话包');
  }

  let manifest;
  try {
    manifest = JSON.parse(strFromU8(entries['manifest.json']));
  } catch {
    throw new HistoryError('ZIP_INVALID', 'manifest.json 无法解析');
  }

  if (manifest?.export_format_version !== EXPORT_FORMAT_VERSION) {
    if (Number(manifest?.export_format_version) > EXPORT_FORMAT_VERSION) {
      throw new HistoryError('ZIP_NEWER', '这个压缩包来自更新版本的 DeepSeek，请先更新本应用');
    }
    throw new HistoryError(
      'ZIP_VERSION',
      `不支持的对话包版本（${manifest?.export_format_version ?? '未知'}），请从 DeepSeek 官网重新导出`
    );
  }

  const sessionEntries = Object.entries(entries).filter(([name]) =>
    /^chat_sessions\/[^/\\]+\.json$/.test(name)
  );
  if (!sessionEntries.length) {
    throw new HistoryError('ZIP_EMPTY', 'ZIP 中没有找到任何对话');
  }

  const conversations = [];
  const skipped = [];
  const seen = new Set(existingSourceKeys);
  let parsedOk = 0;

  for (const [name, bytes] of sessionEntries) {
    try {
      const raw = JSON.parse(strFromU8(bytes));
      const conv = convertSession(raw);
      if (!conv || !conv.messages.length) {
        skipped.push({ file: name, reason: '没有可用的问答内容' });
        continue;
      }
      parsedOk += 1;
      const sourceKey = `zip:${conv.sourceId}`;
      if (seen.has(sourceKey)) {
        skipped.push({ file: name, reason: '这个对话已经导入过' });
        continue;
      }
      seen.add(sourceKey);
      conversations.push({
        title: conv.title,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        messages: conv.messages,
        sourceKey
      });
    } catch (error) {
      skipped.push({ file: name, reason: error.message || '文件格式不正确' });
    }
  }

  if (!parsedOk) {
    throw new HistoryError(
      'ZIP_NO_VALID_CHAT',
      '没有导入任何对话：' + (skipped[0]?.reason || '文件格式不正确')
    );
  }

  return { conversations, skipped };
}

function convertSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id || /[\\/]/.test(raw.id)) return null;
  if (!Array.isArray(raw.messages) || !raw.messages.length) return null;

  const byId = new Map();
  for (const message of raw.messages) {
    if (!message || !Number.isSafeInteger(message.id)) continue;
    byId.set(message.id, message);
  }
  if (!byId.size) return null;

  let current = byId.get(raw.current_message_id);
  if (!current) {
    const parents = new Set(
      [...byId.values()].map((message) => message.parent_id).filter((id) => id !== null)
    );
    const leaves = [...byId.values()].filter((message) => !parents.has(message.id));
    leaves.sort((a, b) => b.id - a.id);
    current = leaves[0] || [...byId.values()].sort((a, b) => b.id - a.id)[0];
  }

  const path = [];
  const visited = new Set();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.push(current);
    current = current.parent_id === null ? null : byId.get(current.parent_id);
  }
  path.reverse();

  const messages = [];
  let firstUserText = '';

  const pushUser = (text, createdAt) => {
    const content = String(text || '').trim();
    if (!content) return;
    if (!firstUserText) firstUserText = content;
    const last = messages[messages.length - 1];
    if (last?.role === 'user') {
      last.content += `\n\n${content}`;
      return;
    }
    messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      content,
      createdAt,
      status: 'completed'
    });
  };

  const pushAssistant = (text, tools, createdAt, status) => {
    const content = String(text || '').trim();
    if (!content) return;
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant') {
      last.content += `\n\n${content}`;
      last.toolItems.push(...tools);
      last.sources = mergeSources(last.sources, tools);
      return;
    }
    messages.push({
      id: crypto.randomUUID(),
      role: 'assistant',
      content,
      createdAt,
      status,
      toolItems: tools,
      sources: mergeSources([], tools)
    });
  };

  for (const message of path) {
    const fragments = Array.isArray(message.fragments) ? message.fragments : [];
    const createdAt = asIso(
      typeof message.inserted_at === 'number'
        ? message.inserted_at * 1000
        : message.inserted_at,
      new Date().toISOString()
    );

    if (message.role === 'USER') {
      const text = fragments
        .filter((fragment) => fragment?.type === 'REQUEST')
        .map((fragment) => fragment.content)
        .filter((value) => typeof value === 'string')
        .join('\n\n');
      pushUser(text, createdAt);
      continue;
    }

    if (message.role !== 'ASSISTANT') continue;
    if (['FAILED', 'TIMEOUT', 'CONTEXT_LENGTH_EXCEEDED', 'CONTENT_FILTER'].includes(message.status)) {
      continue;
    }

    const text = fragments
      .filter((fragment) => fragment?.type === 'RESPONSE')
      .map((fragment) => fragment.content)
      .filter((value) => typeof value === 'string')
      .join('\n\n');

    const tools = [];
    for (const fragment of fragments) {
      if (fragment?.type !== 'READ_LINK' || !Array.isArray(fragment.results)) continue;
      for (const result of fragment.results) {
        if (!result || typeof result.signature !== 'string' || !result.signature) continue;
        const url = safeHttpUrl(result.url || '');
        if (!url) continue;
        tools.push({
          id: `srvtoolu_rl_imp_${crypto.randomUUID().replace(/-/g, '')}`,
          kind: 'read_link',
          status: 'completed',
          url,
          title: typeof result.title === 'string' ? result.title : '',
          publishedAt: null,
          signature: result.signature,
          error: ''
        });
      }
    }

    const status =
      message.status === 'INCOMPLETE' || message.status === 'WIP' ? 'stopped' : 'completed';
    pushAssistant(text, tools, createdAt, status);
  }

  if (!messages.length) return null;

  const title =
    (typeof raw.title === 'string' && raw.title.trim()) ||
    titleFromText(firstUserText, '导入的对话');

  return {
    sourceId: raw.id,
    title: title.slice(0, 80),
    createdAt: asIso(raw.inserted_at),
    updatedAt: asIso(raw.updated_at),
    messages
  };
}

function mergeSources(existing, tools) {
  const result = [...(existing || [])];
  const seen = new Set(result.map((source) => source.url));
  for (const tool of tools) {
    if (tool.status === 'completed' && tool.url && !seen.has(tool.url)) {
      seen.add(tool.url);
      result.push({ url: tool.url, title: tool.title || '' });
    }
  }
  return result;
}

export function buildHistoryZip(conversations) {
  const files = {};
  const index = [];
  const ordered = [...conversations].sort((a, b) =>
    String(b.updatedAt).localeCompare(String(a.updatedAt))
  );

  files['manifest.json'] = strToU8(JSON.stringify({ export_format_version: EXPORT_FORMAT_VERSION }));

  for (const conv of ordered) {
    const exported = exportSession(conv);
    if (!exported) continue;
    files[`chat_sessions/${conv.id}.json`] = strToU8(JSON.stringify(exported.session));
    index.push(exported.index);
  }

  files['chat_session_index.json'] = strToU8(JSON.stringify(index));
  return zipSync(files, { level: 0 });
}

function exportSession(conv) {
  const sourceMessages = conv.messages.filter(
    (message) =>
      message &&
      (message.role === 'user' || message.role === 'assistant') &&
      typeof message.content === 'string' &&
      message.content.trim()
  );
  if (!sourceMessages.length) return null;

  // DeepSeek 官方归档要求根消息是提问、角色交替；导入的分享偶尔可能以回答开头或同角色相邻。
  const normalized = [];
  for (const message of sourceMessages) {
    if (!normalized.length && message.role !== 'user') continue;
    const last = normalized[normalized.length - 1];
    if (last && last.role === message.role) {
      last.content += `\n\n${message.content}`;
      if (message.role === 'assistant' && Array.isArray(message.toolItems)) {
        last.toolItems = [...(last.toolItems || []), ...message.toolItems];
      }
      continue;
    }
    normalized.push({ ...message });
  }
  if (!normalized.length || normalized[0].role !== 'user') return null;

  let previousId = null;
  const messages = normalized.map((message, position) => {
    const id = position + 1;
    const fragments = [];
    if (message.role === 'assistant') {
      const results = (message.toolItems || [])
        .filter((tool) => tool?.signature && tool?.url)
        .map((tool) => ({
          url: tool.url,
          title: tool.title || null,
          signature: tool.signature
        }));
      if (results.length) fragments.push({ type: 'READ_LINK', results });
      fragments.push({ type: 'RESPONSE', content: message.content });
    } else {
      fragments.push({ type: 'REQUEST', content: message.content });
    }

    const item = {
      id,
      parent_id: previousId,
      role: message.role === 'assistant' ? 'ASSISTANT' : 'USER',
      status: 'FINISHED',
      thinking_enabled: false,
      search_enabled: false,
      accumulated_token_usage: Number(message.usage?.totalTokens || 0),
      inserted_at: asIso(message.createdAt, asIso(conv.createdAt)),
      fragments
    };
    previousId = id;
    return item;
  });

  const session = {
    id: conv.id,
    title: conv.title || null,
    pinned: false,
    current_message_id: messages[messages.length - 1].id,
    inserted_at: asIso(conv.createdAt),
    updated_at: asIso(conv.updatedAt),
    messages
  };

  return {
    session,
    index: {
      id: conv.id,
      title: session.title,
      pinned: false,
      message_count: messages.length,
      inserted_at: session.inserted_at,
      updated_at: session.updated_at
    }
  };
}
