import crypto from 'node:crypto';
import { titleFromText, asIso } from './text.js';

const SHARE_HOST = 'chat.deepseek.com';
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const SHARE_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export class ShareImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ShareImportError';
    this.code = code;
  }
}

export function parseShareLink(value) {
  let text = String(value || '').trim();
  if (!text) throw new ShareImportError('SHARE_LINK_EMPTY', '请先粘贴分享链接');
  if (/^chat\.deepseek\.com\/share\//i.test(text)) text = `https://${text}`;

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new ShareImportError('SHARE_LINK_INVALID', '链接格式不对，请粘贴完整的 chat.deepseek.com 分享链接');
  }

  if (url.protocol !== 'https:' || url.hostname !== SHARE_HOST) {
    throw new ShareImportError('SHARE_LINK_INVALID', '只支持 https://chat.deepseek.com/share/ 开头的分享链接');
  }

  const match = url.pathname.match(/^\/share\/([^/]+)\/?$/);
  const id = match?.[1] || '';
  if (!SHARE_ID_RE.test(id)) {
    throw new ShareImportError('SHARE_LINK_INVALID', '分享链接里没有有效的对话 ID');
  }

  return { id, canonicalUrl: `https://${SHARE_HOST}/share/${id}` };
}

export async function fetchSharedConversation({ link, shareBaseUrl, timeoutMs = 20_000 }) {
  const { id, canonicalUrl } = parseShareLink(link);
  const endpoint = `${shareBaseUrl}/api/v0/share/content?share_id=${encodeURIComponent(id)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('分享链接读取超时')), timeoutMs);

  try {
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
        },
        redirect: 'error',
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new ShareImportError('SHARE_FETCH_FAILED', '读取分享链接超时，请稍后再试');
      }
      throw new ShareImportError('SHARE_FETCH_FAILED', '无法连接 DeepSeek 读取分享内容');
    }

    if (response.status === 404) {
      throw new ShareImportError('SHARE_NOT_FOUND', '分享不存在、已删除或已设为私密');
    }
    if (!response.ok) {
      throw new ShareImportError('SHARE_FETCH_FAILED', `DeepSeek 返回 HTTP ${response.status}`);
    }

    const text = await readTextLimited(response, MAX_RESPONSE_BYTES);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ShareImportError('SHARE_MALFORMED', '分享内容格式不正确');
    }

    if (payload?.code !== 0 || payload?.data?.biz_code !== 0) {
      const message = payload?.msg || payload?.data?.biz_msg;
      throw new ShareImportError(
        'SHARE_NOT_FOUND',
        message ? `分享读取失败：${message}` : '分享不存在或无法读取'
      );
    }

    const biz = payload?.data?.biz_data;
    const rawMessages = Array.isArray(biz?.messages) ? biz.messages : [];
    if (!rawMessages.length) {
      throw new ShareImportError('SHARE_EMPTY', '这个分享里没有可导入的对话内容');
    }

    const messages = [];
    let firstUserText = '';
    let latest = 0;

    const addUser = (content, createdAt) => {
      const text = String(content || '').trim();
      if (!text) return;
      if (!firstUserText) firstUserText = text;
      const last = messages[messages.length - 1];
      if (last?.role === 'user') {
        last.content += `\n\n${text}`;
        return;
      }
      messages.push({
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
        createdAt,
        status: 'completed'
      });
    };

    const addAssistant = (content, createdAt, sources) => {
      const text = String(content || '').trim();
      if (!text) return;
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant') {
        last.content += `\n\n${text}`;
        last.sources = mergeSources(last.sources, sources);
        return;
      }
      messages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: text,
        createdAt,
        status: 'completed',
        sources
      });
    };

    for (const item of rawMessages) {
      const role = String(item?.role || '').toUpperCase();
      const fragments = Array.isArray(item?.fragments) ? item.fragments : [];
      const createdAt = asIso(
        typeof item?.inserted_at === 'number' ? item.inserted_at * 1000 : item?.inserted_at,
        new Date().toISOString()
      );
      latest = Math.max(latest, new Date(createdAt).getTime() || 0);

      if (role === 'USER') {
        const text =
          fragments
            .filter((fragment) => fragment?.type === 'REQUEST')
            .map((fragment) => fragment.content)
            .filter((value) => typeof value === 'string')
            .join('\n\n') || (typeof item.content === 'string' ? item.content : '');
        addUser(text, createdAt);
      } else if (role === 'ASSISTANT') {
        const text =
          fragments
            .filter((fragment) => fragment?.type === 'RESPONSE')
            .map((fragment) => fragment.content)
            .filter((value) => typeof value === 'string')
            .join('\n\n') || (typeof item.content === 'string' ? item.content : '');
        const sources = collectSources(fragments);
        addAssistant(text, createdAt, sources);
      }
    }

    if (!messages.length) {
      throw new ShareImportError('SHARE_EMPTY', '这个分享里没有可导入的文字对话');
    }

    const bizTitle = typeof biz?.title === 'string' ? biz.title.trim() : '';
    const title =
      bizTitle && !/^shared conversation$/i.test(bizTitle)
        ? bizTitle
        : titleFromText(firstUserText, '分享的对话');

    return {
      sourceId: id,
      sourceUrl: canonicalUrl,
      title: title.slice(0, 80),
      createdAt: messages[0]?.createdAt || new Date().toISOString(),
      updatedAt: latest ? new Date(latest).toISOString() : new Date().toISOString(),
      messages
    };
  } finally {
    clearTimeout(timer);
  }
}

function collectSources(fragments) {
  const sources = [];
  const seen = new Set();
  for (const fragment of fragments) {
    if (!fragment || !Array.isArray(fragment.references)) continue;
    for (const reference of fragment.references) {
      const url = typeof reference?.url === 'string' ? reference.url : '';
      if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      sources.push({ url, title: typeof reference.title === 'string' ? reference.title : '' });
    }
  }
  return sources;
}

function mergeSources(existing, extra) {
  const result = [...(existing || [])];
  const seen = new Set(result.map((source) => source.url));
  for (const source of extra || []) {
    if (source.url && !seen.has(source.url)) {
      seen.add(source.url);
      result.push(source);
    }
  }
  return result;
}

async function readTextLimited(response, limit) {
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
      throw new ShareImportError('SHARE_TOO_LARGE', '分享内容过大，无法导入');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}
