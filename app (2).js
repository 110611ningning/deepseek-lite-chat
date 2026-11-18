import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { KeyVault } from './crypto.js';
import {
  DeepSeekError,
  buildInput,
  extractFinal,
  friendlyDeepSeekError,
  streamDeepSeek
} from './deepseek.js';
import { HistoryError, importHistoryZip, buildHistoryZip } from './history.js';
import { ShareImportError, fetchSharedConversation } from './shares.js';
import { Store } from './store.js';
import { titleFromText, domainOf, safeHttpUrl } from './text.js';

const COOKIE_NAME = 'ds_sid';
const CHAT_RATE_LIMIT = 15;
const CHAT_RATE_WINDOW_MS = 60_000;
const MAX_MESSAGE_CHARS = 32_000;

export function createApp({ config, store, vault }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (req.path.startsWith('/s/')) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    }
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'"
      ].join('; ')
    );
    next();
  });

  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (req, res) => {
    res.status(200).json({ ok: true, model: config.model });
  });

  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !isSameOrigin(req)) {
      return res.status(403).json({ code: 'BAD_ORIGIN', message: '请求来源不合法' });
    }
    next();
  });

  app.use('/api', sessionMiddleware(store));

  app.get('/api/bootstrap', (req, res) => {
    res.json({
      hasApiKey: Boolean(req.user.apiKey),
      conversations: store.listConversations(req.user.id),
      model: config.model
    });
  });

  app.post('/api/settings/api-key', (req, res) => {
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
    if (!apiKey || apiKey.length < 16 || apiKey.length > 300 || /\s/.test(apiKey)) {
      return fail(res, 400, 'INVALID_KEY', '请输入有效的 DeepSeek API Key');
    }
    store.setApiKey(req.user.id, vault.encrypt(apiKey, req.user.id));
    res.json({ hasApiKey: true });
  });

  app.delete('/api/settings/api-key', (req, res) => {
    store.deleteApiKey(req.user.id);
    res.json({ hasApiKey: false });
  });

  app.get('/api/conversations', (req, res) => {
    res.json({ conversations: store.listConversations(req.user.id) });
  });

  app.post('/api/conversations', (req, res) => {
    const conv = store.createConversation(req.user.id, {
      title: typeof req.body?.title === 'string' ? req.body.title : '新对话'
    });
    res.status(201).json({ conversation: displayConversation(conv) });
  });

  app.get('/api/conversations/:id', (req, res) => {
    const conv = store.getConversation(req.user.id, req.params.id);
    if (!conv) return fail(res, 404, 'NOT_FOUND', '对话不存在');
    res.json({ conversation: displayConversation(conv) });
  });

  app.patch('/api/conversations/:id', (req, res) => {
    const conv = store.getConversation(req.user.id, req.params.id);
    if (!conv) return fail(res, 404, 'NOT_FOUND', '对话不存在');
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title) return fail(res, 400, 'EMPTY_TITLE', '标题不能为空');
    store.updateTitle(conv, title);
    res.json({ conversation: displayConversation(conv) });
  });

  app.delete('/api/conversations/:id', (req, res) => {
    const deleted = store.deleteConversation(req.user.id, req.params.id);
    if (!deleted) return fail(res, 404, 'NOT_FOUND', '对话不存在');
    res.json({ ok: true });
  });

  app.delete('/api/conversations', (req, res) => {
    store.deleteAllConversations(req.user.id);
    res.json({ ok: true });
  });

  app.get('/api/export', (req, res, next) => {
    try {
      const conversations = Object.values(store.data.conversations).filter(
        (conv) => conv.userId === req.user.id
      );
      if (!conversations.length) {
        return fail(res, 404, 'NO_CONVERSATIONS', '还没有可以导出的对话');
      }
      const bytes = buildHistoryZip(conversations);
      const fileName = `deepseek_data-${new Date().toISOString().slice(0, 10)}.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Length', String(bytes.byteLength));
      res.end(Buffer.from(bytes));
    } catch (error) {
      next(error);
    }
  });

  app.post(
    '/api/import/history',
    express.raw({
      type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
      limit: config.maxZipBytes
    }),
    (req, res, next) => {
      try {
        const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const result = importHistoryZip(buffer, {
          existingSourceKeys: store.listSourceKeys(req.user.id)
        });
        const created = result.conversations.map((conv) => store.insertConversation(req.user.id, conv));
        if (created.length) store.save();
        res.status(201).json({
          imported: created.length,
          skipped: result.skipped.length,
          conversations: created.map(summaryConversation),
          skippedDetails: result.skipped.slice(0, 5)
        });
      } catch (error) {
        next(error);
      }
    }
  );

  app.post('/api/import/share', asyncRoute(async (req, res, next) => {
    try {
      const link = typeof req.body?.url === 'string' ? req.body.url : '';
      const shared = await fetchSharedConversation({
        link,
        shareBaseUrl: config.shareBaseUrl
      });
      const conv = store.insertConversation(req.user.id, {
        title: shared.title,
        createdAt: shared.createdAt,
        updatedAt: shared.updatedAt,
        messages: shared.messages,
        sourceKey: `share:${shared.sourceId}`
      });
      store.save();
      res.status(201).json({
        imported: 1,
        conversation: displayConversation(conv),
        sourceUrl: shared.sourceUrl
      });
    } catch (error) {
      next(error);
    }
  }));

  app.post('/api/conversations/:id/share', (req, res) => {
    const conv = store.getConversation(req.user.id, req.params.id);
    if (!conv) return fail(res, 404, 'NOT_FOUND', '对话不存在');
    const messages = conv.messages
      .filter(
        (message) =>
          (message.role === 'user' || message.role === 'assistant') &&
          typeof message.content === 'string' &&
          message.content.trim()
      )
      .map((message) => {
        const displayed = displayMessage(message);
        return {
          id: displayed.id,
          role: displayed.role,
          content: displayed.content,
          createdAt: displayed.createdAt,
          status: displayed.status,
          sources: displayed.sources
        };
      });
    if (!messages.length) return fail(res, 400, 'EMPTY_CONVERSATION', '这个对话还没有内容');

    const share = store.createShare(req.user.id, conv, messages);
    const base = publicBaseUrl(req, config);
    res.status(201).json({
      id: share.id,
      path: `/s/${share.id}`,
      url: `${base}/s/${share.id}`
    });
  });

  app.get('/api/shares/:id', (req, res) => {
    const share = store.getShare(req.params.id);
    if (!share) return fail(res, 404, 'SHARE_NOT_FOUND', '分享不存在或已失效');
    res.json({
      share: {
        id: share.id,
        title: share.title,
        createdAt: share.createdAt,
        messages: share.messages
      }
    });
  });

  app.post('/api/shares/:id/fork', (req, res) => {
    const share = store.getShare(req.params.id);
    if (!share) return fail(res, 404, 'SHARE_NOT_FOUND', '分享不存在或已失效');

    const existing = store.findFork(req.user.id, share.id);
    if (existing) {
      return res.json({ conversation: displayConversation(existing), reused: true });
    }

    const messages = share.messages.map((message) => ({
      id: crypto.randomUUID(),
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      status: 'completed',
      sources: Array.isArray(message.sources) ? message.sources : []
    }));
    const conv = store.insertConversation(req.user.id, {
      title: share.title,
      messages,
      forkOfShare: share.id
    });
    store.save();
    res.status(201).json({ conversation: displayConversation(conv), reused: false });
  });

  app.post('/api/conversations/:id/rewind', asyncRoute(async (req, res) => {
    if (!req.user.apiKey) {
      return fail(res, 400, 'NO_API_KEY', '请先在设置中填写 DeepSeek API Key');
    }
    if (!takeChatRateLimit(req.user.id)) {
      return fail(res, 429, 'TOO_MANY_REQUESTS', '操作太频繁，请等一分钟再试');
    }
    if (activeChats.has(req.user.id)) {
      return fail(res, 409, 'CHAT_IN_PROGRESS', '上一条回复还在生成，请稍候');
    }

    const conv = store.getConversation(req.user.id, req.params.id);
    if (!conv) return fail(res, 404, 'NOT_FOUND', '对话不存在');

    const messageId = typeof req.body?.messageId === 'string' ? req.body.messageId : '';
    const targetIndex = conv.messages.findIndex((message) => message.id === messageId);
    if (targetIndex < 0) return fail(res, 404, 'MESSAGE_NOT_FOUND', '这条消息不存在');
    const target = conv.messages[targetIndex];

    let newMessages;
    if (target.role === 'assistant') {
      if (targetIndex < 1 || conv.messages[targetIndex - 1]?.role !== 'user') {
        return fail(res, 400, 'INCOMPLETE_TURN', '这条回答没有对应的用户提问');
      }
      newMessages = conv.messages.slice(0, targetIndex);
    } else if (target.role === 'user') {
      const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
      if (!content) return fail(res, 400, 'EMPTY_MESSAGE', '消息不能为空');
      if (content.length > MAX_MESSAGE_CHARS) {
        return fail(res, 400, 'MESSAGE_TOO_LONG', `单条消息最多 ${MAX_MESSAGE_CHARS} 个字符`);
      }
      newMessages = [
        ...conv.messages.slice(0, targetIndex),
        { ...target, content, status: 'completed' }
      ];
    } else {
      return fail(res, 400, 'UNSUPPORTED_MESSAGE', '只能修改用户消息或重新生成回答');
    }

    const apiKey = vault.decrypt(req.user.apiKey, req.user.id);
    if (!apiKey) {
      return fail(
        res,
        500,
        'KEY_DECRYPT_FAILED',
        '保存的 API Key 无法解密，请在设置中删除后重新填写'
      );
    }

    // 成功后才用截断/改写后的消息替换原对话；失败时原对话完整保留。
    await streamAssistantReply({
      req,
      res,
      conv,
      apiKey,
      inputMessages: newMessages,
      commitMessages: newMessages,
      preserveOnError: true
    });
  }));

  app.post('/api/conversations/:id/regenerate', asyncRoute(async (req, res) => {
    if (!req.user.apiKey) {
      return fail(res, 400, 'NO_API_KEY', '请先在设置中填写 DeepSeek API Key');
    }
    if (!takeChatRateLimit(req.user.id)) {
      return fail(res, 429, 'TOO_MANY_REQUESTS', '操作太频繁，请等一分钟再试');
    }
    if (activeChats.has(req.user.id)) {
      return fail(res, 409, 'CHAT_IN_PROGRESS', '上一条回复还在生成，请稍候');
    }

    const conv = store.getConversation(req.user.id, req.params.id);
    if (!conv) return fail(res, 404, 'NOT_FOUND', '对话不存在');

    const lastIndex = conv.messages.length - 1;
    const oldAssistant = conv.messages[lastIndex];
    if (!oldAssistant || oldAssistant.role !== 'assistant') {
      return fail(res, 400, 'NO_ASSISTANT', '当前没有可以重新生成的回答');
    }
    if (lastIndex < 1 || conv.messages[lastIndex - 1]?.role !== 'user') {
      return fail(res, 400, 'INCOMPLETE_TURN', '最后一条回答没有对应的用户提问');
    }

    const apiKey = vault.decrypt(req.user.apiKey, req.user.id);
    if (!apiKey) {
      return fail(
        res,
        500,
        'KEY_DECRYPT_FAILED',
        '保存的 API Key 无法解密，请在设置中删除后重新填写'
      );
    }

    // 重新生成时保留旧回答作为失败兜底；成功后才替换。
    await streamAssistantReply({
      req,
      res,
      conv,
      apiKey,
      inputMessages: conv.messages.slice(0, lastIndex),
      replaceIndex: lastIndex,
      preserveOnError: true
    });
  }));

  app.post('/api/chat', asyncRoute(async (req, res, next) => {
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    const conversationId =
      typeof req.body?.conversationId === 'string' ? req.body.conversationId : '';

    if (!content) return fail(res, 400, 'EMPTY_MESSAGE', '请输入消息');
    if (content.length > MAX_MESSAGE_CHARS) {
      return fail(res, 400, 'MESSAGE_TOO_LONG', `单条消息最多 ${MAX_MESSAGE_CHARS} 个字符`);
    }
    if (!req.user.apiKey) {
      return fail(res, 400, 'NO_API_KEY', '请先在设置中填写 DeepSeek API Key');
    }
    if (!takeChatRateLimit(req.user.id)) {
      return fail(res, 429, 'TOO_MANY_REQUESTS', '发送太频繁，请等一分钟再试');
    }
    if (activeChats.has(req.user.id)) {
      return fail(res, 409, 'CHAT_IN_PROGRESS', '上一条回复还在生成，请稍候');
    }

    const apiKey = vault.decrypt(req.user.apiKey, req.user.id);
    if (!apiKey) {
      return fail(
        res,
        500,
        'KEY_DECRYPT_FAILED',
        '保存的 API Key 无法解密，请在设置中删除后重新填写'
      );
    }

    let conv;
    if (conversationId) {
      conv = store.getConversation(req.user.id, conversationId);
      if (!conv) return fail(res, 404, 'NOT_FOUND', '对话不存在');
    } else {
      conv = store.insertConversation(req.user.id, { title: titleFromText(content) });
    }

    const userMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
      status: 'completed'
    };
    conv.messages.push(userMessage);
    if (!conv.messages.some((message) => message.role === 'assistant')) {
      conv.title = titleFromText(content, conv.title);
    }
    store.touchConversation(conv);
    store.save();

    await streamAssistantReply({ req, res, conv, apiKey, userMessageId: userMessage.id });
  }));

  async function streamAssistantReply({
    req,
    res,
    conv,
    apiKey,
    inputMessages = null,
    replaceIndex = null,
    commitMessages = null,
    preserveOnError = false,
    userMessageId = null
  }) {
    const userId = req.user.id;
    activeChats.add(userId);
    const abortController = new AbortController();
    let clientGone = false;
    const heartbeat = setInterval(() => {
      if (!res.writableEnded && !clientGone) res.write(': keep-alive\n\n');
    }, 15_000);

    res.on('close', () => {
      if (!res.writableEnded) {
        clientGone = true;
        abortController.abort(new DOMException('Aborted', 'AbortError'));
      }
    });

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event) => {
      if (res.writableEnded || clientGone) return;
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        clientGone = true;
      }
    };

    send({
      type: 'meta',
      conversation: summaryConversation(conv),
      ...(userMessageId ? { userMessageId } : {})
    });
    send({ type: 'status', status: 'connecting' });

    let streamedText = '';
    let finalResponse = null;
    let thinkingShown = false;
    const toolEvents = new Map();

    try {
      const input = buildInput(inputMessages || conv.messages);
      for await (const event of streamDeepSeek({
        apiKey,
        input,
        baseUrl: config.deepseekBaseUrl,
        timeoutMs: config.requestTimeoutMs,
        signal: abortController.signal
      })) {
        switch (event.type) {
          case 'response.output_item.added': {
            const item = event.item;
            if (item?.type === 'web_search_call') {
              const tool = {
                id: item.id || '',
                kind: item.kind || 'read_link',
                status: 'reading',
                url: item.action?.url || item.page?.url || '',
                title: item.page?.title || item.action?.title || ''
              };
              if (tool.id) toolEvents.set(tool.id, tool);
              send({ type: 'tool', tool });
              send({ type: 'status', status: 'reading' });
            }
            break;
          }
          case 'response.output_item.done': {
            const item = event.item;
            if (item?.type === 'web_search_call') {
              const tool = {
                id: item.id || '',
                kind: item.kind || 'read_link',
                status: item.status === 'failed' ? 'failed' : 'completed',
                url: item.action?.url || item.page?.url || '',
                title: item.page?.title || '',
                error: item.error?.code || ''
              };
              if (tool.id) toolEvents.set(tool.id, tool);
              send({ type: 'tool', tool });
            }
            break;
          }
          case 'response.reasoning_text.delta': {
            if (!thinkingShown) {
              thinkingShown = true;
              send({ type: 'status', status: 'thinking' });
            }
            break;
          }
          case 'response.output_text.delta': {
            if (typeof event.delta === 'string' && event.delta) {
              streamedText += event.delta;
              send({ type: 'delta', text: event.delta });
              send({ type: 'status', status: 'answering' });
            }
            break;
          }
          case 'response.completed':
          case 'response.incomplete': {
            finalResponse = event.response || null;
            break;
          }
          case 'response.failed': {
            const detail = event.response?.error?.message || 'DeepSeek 生成失败，请重试';
            throw new DeepSeekError(detail, { code: event.response?.error?.code || 'FAILED' });
          }
          case 'error': {
            throw new DeepSeekError(event.error?.message || event.message || 'DeepSeek 请求失败', {
              code: event.error?.code || 'STREAM_ERROR'
            });
          }
          default:
            break;
        }
      }
    } catch (error) {
      clearInterval(heartbeat);
      activeChats.delete(userId);

      const friendly = friendlyDeepSeekError(error);
      const aborted = friendly.code === 'ABORTED';

      if (preserveOnError) {
        const oldAssistant =
          replaceIndex !== null && Number.isInteger(replaceIndex)
            ? conv.messages[replaceIndex]
            : null;
        // 重新生成/改写失败：对话保持原样，不写入错误气泡。
        if (!clientGone) {
          if (!aborted) send({ type: 'error', code: friendly.code, message: friendly.message });
          send({
            type: 'done',
            unchanged: true,
            message: oldAssistant ? displayMessage(oldAssistant) : null,
            conversation: summaryConversation(conv)
          });
          res.end();
        }
        return;
      }

      const partial = streamedText.trim();
      const assistant = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: partial,
        createdAt: new Date().toISOString(),
        status: aborted ? 'stopped' : 'error',
        sources: [],
        error: aborted ? '' : friendly.message,
        errorCode: aborted ? 'ABORTED' : friendly.code,
        toolItems: [...toolEvents.values()].filter((tool) => tool.status !== 'reading')
      };
      conv.messages.push(assistant);
      store.touchConversation(conv);
      store.save();

      if (!clientGone) {
        if (!aborted) send({ type: 'error', code: friendly.code, message: friendly.message });
        send({
          type: 'done',
          message: displayMessage(assistant),
          conversation: summaryConversation(conv)
        });
        res.end();
      }
      return;
    }

    clearInterval(heartbeat);
    activeChats.delete(userId);

    const extracted = extractFinal(finalResponse || {});
    const text = (extracted.text || streamedText).trim();
    const tools = extracted.tools.length ? extracted.tools : [...toolEvents.values()];
    const sources = extracted.sources.length
      ? extracted.sources
      : tools
          .filter((tool) => tool.status === 'completed' && tool.url)
          .map((tool) => ({ url: tool.url, title: tool.title || '' }));

    let status = 'completed';
    let error = '';
    let errorCode = '';
    let note = '';
    if (extracted.status === 'incomplete') {
      if (extracted.incompleteReason === 'content_filter') {
        status = 'refused';
        error = '内容未通过安全检查，请换一种说法再试';
        errorCode = 'CONTENT_RISK';
      } else {
        status = 'stopped';
        note = '回答达到长度上限，已停止';
      }
    }
    if (!text && !error) {
      status = 'error';
      error = 'DeepSeek 没有返回文字内容，请重试';
      errorCode = 'EMPTY_RESPONSE';
    } else if (!finalResponse && text) {
      status = 'stopped';
      note = '连接中断，已保留已生成的部分回答';
    }

    const assistant = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: text,
      createdAt: new Date().toISOString(),
      status,
      sources: uniqueSources(sources),
      usage: extracted.usage,
      responseId: extracted.responseId,
      toolItems: tools,
      error,
      errorCode,
      note
    };
    if (commitMessages) {
      conv.messages = [...commitMessages, assistant];
    } else if (replaceIndex !== null && Number.isInteger(replaceIndex)) {
      conv.messages[replaceIndex] = assistant;
    } else {
      conv.messages.push(assistant);
    }
    store.touchConversation(conv);
    store.save();

    send({
      type: 'done',
      message: displayMessage(assistant),
      conversation: summaryConversation(conv)
    });
    if (!clientGone) res.end();
  }

  app.use('/api', (req, res) => {
    res.status(404).json({ code: 'NOT_FOUND', message: '接口不存在' });
  });

  app.use(
    express.static(config.publicDir, {
      index: false,
      etag: true,
      maxAge: 0,
      setHeaders(res) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    })
  );

  app.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(config.publicDir, 'index.html'));
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error?.type === 'entity.too.large') {
      return fail(res, 413, 'TOO_LARGE', '文件或请求太大');
    }
    if (error instanceof SyntaxError && error.status === 400) {
      return fail(res, 400, 'BAD_JSON', '请求内容格式不正确');
    }
    if (error instanceof HistoryError) {
      return fail(res, 400, error.code, error.message);
    }
    if (error instanceof ShareImportError) {
      return fail(res, 400, error.code, error.message);
    }
    console.error('[server error]', error?.stack || error?.message || String(error));
    return fail(res, 500, 'INTERNAL_ERROR', '服务器出错了，请稍后再试');
  });

  return app;
}

const activeChats = new Set();
const chatAttempts = new Map();

function takeChatRateLimit(userId) {
  const now = Date.now();
  const recent = (chatAttempts.get(userId) || []).filter((time) => now - time < CHAT_RATE_WINDOW_MS);
  if (recent.length >= CHAT_RATE_LIMIT) {
    chatAttempts.set(userId, recent);
    return false;
  }
  recent.push(now);
  chatAttempts.set(userId, recent);
  return true;
}

function sessionMiddleware(store) {
  return (req, res, next) => {
    let token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    let user = token ? store.getUserByToken(token) : null;

    if (!user) {
      const created = store.createUser();
      user = created.user;
      token = created.token;
      res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: isSecureRequest(req),
        path: '/',
        maxAge: 365 * 24 * 60 * 60 * 1000
      });
    }

    req.user = user;
    next();
  };
}

function parseCookies(header) {
  const result = {};
  if (!header) return result;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      try {
        result[key] = decodeURIComponent(value);
      } catch {
        result[key] = value;
      }
    }
  }
  return result;
}

function isSecureRequest(req) {
  return Boolean(req.secure) || String(req.get('x-forwarded-proto') || '').split(',')[0] === 'https';
}

function isSameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const forwarded = String(req.get('x-forwarded-host') || req.get('host') || '')
    .split(',')[0]
    .trim();
  return normalizeHostPort(parsed.host, parsed.protocol) === normalizeHostPort(forwarded, parsed.protocol);
}

function normalizeHostPort(host, protocol) {
  try {
    const parsed = new URL(`${protocol}//${host}`);
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return `${parsed.hostname.toLowerCase()}:${port}`;
  } catch {
    return '';
  }
}

function publicBaseUrl(req, config) {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const forwarded = String(req.get('x-forwarded-host') || req.get('host') || '')
    .split(',')[0]
    .trim();
  return `${req.protocol}://${forwarded}`;
}

function summaryConversation(conv) {
  return {
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: conv.messages.length
  };
}

function displayConversation(conv) {
  return {
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messages: conv.messages.map(displayMessage)
  };
}

function displayMessage(message) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    status: message.status || 'completed',
    sources: Array.isArray(message.sources)
      ? message.sources
          .map((source) => {
            const url = safeHttpUrl(source?.url || '');
            if (!url) return null;
            return {
              url,
              title: source.title || '',
              domain: domainOf(url)
            };
          })
          .filter(Boolean)
      : [],
    usage: message.usage || null,
    error: message.error || '',
    errorCode: message.errorCode || '',
    note: message.note || ''
  };
}

function uniqueSources(sources) {
  const seen = new Set();
  return sources.filter((source) => {
    if (!source?.url || seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

function fail(res, status, code, message) {
  return res.status(status).json({ code, message });
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export async function buildAppFromEnv() {
  const { resolveConfig } = await import('./config.js');
  const { loadMasterKey } = await import('./crypto.js');
  const config = resolveConfig();
  const store = new Store(config.storePath);
  const vault = new KeyVault(loadMasterKey(config.dataDir, config.appSecret));
  return createApp({ config, store, vault });
}
