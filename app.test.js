import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createApp } from '../server/app.js';
import { resolveConfig } from '../server/config.js';
import { KeyVault, loadMasterKey } from '../server/crypto.js';
import { Store } from '../server/store.js';

const API_KEY = 'sk-test-super-secret-key-1234567890';

test('完整数据管理与聊天流程', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-lite-test-'));
  const mock = await startMockDeepSeek();
  const config = resolveConfig({
    dataDir: tempDir,
    deepseekBaseUrl: mock.baseUrl,
    shareBaseUrl: mock.baseUrl
  });
  const store = new Store(config.storePath);
  const vault = new KeyVault(loadMasterKey(tempDir, 'test-app-secret'));
  const app = createApp({ config, store, vault });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await mock.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function request(pathname, { method = 'GET', body, headers = {} } = {}) {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    const response = await fetch(`${base}${pathname}`, { method, body, headers: h });
    const setCookie = response.headers.getSetCookie?.() || [];
    const fallbackCookie = response.headers.get('set-cookie');
    if (!setCookie.length && fallbackCookie) setCookie.push(fallbackCookie);
    if (setCookie[0]) cookie = setCookie[0].split(';')[0];
    return response;
  }

  async function json(pathname, options = {}) {
    const init = { ...options, headers: { ...(options.headers || {}) } };
    if (options.body !== undefined && !Buffer.isBuffer(options.body)) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    const response = await request(pathname, init);
    const data = await response.json().catch(() => ({}));
    return { response, data };
  }

  const boot = await json('/api/bootstrap');
  assert.equal(boot.response.status, 200);
  assert.equal(boot.data.hasApiKey, false);
  assert.equal(boot.data.model, 'deepseek-flash');

  const saved = await json('/api/settings/api-key', {
    method: 'POST',
    body: { apiKey: API_KEY }
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.data.hasApiKey, true);

  const storeText = fs.readFileSync(config.storePath, 'utf8');
  assert.ok(!storeText.includes(API_KEY), 'API Key 不能以明文出现在数据文件里');
  assert.ok(storeText.includes('"ct"'), '数据文件应包含加密后的密文');

  const chatResponse = await request('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '总结 https://example.com 的要点' })
  });
  assert.equal(chatResponse.status, 200);
  const chatText = await chatResponse.text();
  const events = parseSse(chatText);
  const meta = events.find((event) => event.type === 'meta');
  const done = events.find((event) => event.type === 'done');
  assert.ok(meta?.conversation?.id, '应该返回新对话 id');
  assert.ok(meta?.userMessageId, '应该返回服务端用户消息 id，供编辑使用');
  assert.ok(done?.message?.content.includes('网页摘要'), '应该收到回答');
  assert.equal(done.message.sources[0].url, 'https://example.com/');
  assert.equal(mock.lastBody.model, 'deepseek-flash');
  assert.deepEqual(mock.lastBody.tools, [{ type: 'deepseek_read_url' }]);
  assert.equal(mock.lastAuthorization, `Bearer ${API_KEY}`);
  assert.equal(mock.lastBody.input.at(-1).role, 'user');

  const conversationId = meta.conversation.id;
  const loaded = await json(`/api/conversations/${conversationId}`);
  assert.equal(loaded.response.status, 200);
  assert.equal(loaded.data.conversation.messages.length, 2);
  assert.ok(!JSON.stringify(loaded.data).includes('test-signature'), '签名不能发送到浏览器');
  assert.ok(!JSON.stringify(loaded.data).includes(API_KEY), 'API Key 不能发送到浏览器');

  const secondChat = await request('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '网页第一句是什么？', conversationId })
  });
  assert.equal(secondChat.status, 200);
  await secondChat.text();
  const historyCall = mock.lastBody.input.find((item) => item.type === 'web_search_call');
  assert.ok(historyCall, '第二轮应该带上一轮的 read_link 签名');
  assert.equal(historyCall.signature, 'test-signature-123');
  assert.equal(historyCall.kind, 'read_link');

  const beforeRegenerate = await json(`/api/conversations/${conversationId}`);
  const oldAssistantId = beforeRegenerate.data.conversation.messages.at(-1).id;
  const regenerateResponse = await request(`/api/conversations/${conversationId}/regenerate`, {
    method: 'POST'
  });
  assert.equal(regenerateResponse.status, 200);
  const regenerateEvents = parseSse(await regenerateResponse.text());
  const regenerateDone = regenerateEvents.find((event) => event.type === 'done');
  assert.ok(regenerateDone?.message?.content.includes('网页摘要'), '重新生成应该返回新回答');
  assert.equal(mock.lastBody.input.at(-1).role, 'user', '重新生成时最后一条输入应是用户提问');
  const afterRegenerate = await json(`/api/conversations/${conversationId}`);
  assert.equal(afterRegenerate.data.conversation.messages.length, 4, '重新生成不能追加多余消息');
  assert.notEqual(afterRegenerate.data.conversation.messages.at(-1).id, oldAssistantId);
  assert.ok(!JSON.stringify(afterRegenerate.data).includes('test-signature'), '重新生成不能泄露签名');

  const emptyConversation = await json('/api/conversations', {
    method: 'POST',
    body: { title: '空对话' }
  });
  const regenerateEmpty = await json(
    `/api/conversations/${emptyConversation.data.conversation.id}/regenerate`,
    { method: 'POST' }
  );
  assert.equal(regenerateEmpty.response.status, 400);
  assert.equal(regenerateEmpty.data.code, 'NO_ASSISTANT');

  const share = await json(`/api/conversations/${conversationId}/share`, { method: 'POST' });
  assert.equal(share.response.status, 201);
  assert.match(share.data.url, /\/s\/[A-Za-z0-9_-]{20,}$/);
  assert.ok(!share.data.url.includes('%'), '分享链接不能使用 URL 编码');

  const publicShare = await json(`/api/shares/${share.data.id}`);
  assert.equal(publicShare.response.status, 200);
  assert.equal(publicShare.data.share.messages.length, 4);
  assert.ok(!JSON.stringify(publicShare.data).includes('test-signature'));

  const fork = await json(`/api/shares/${share.data.id}/fork`, { method: 'POST' });
  assert.equal(fork.response.status, 201);
  assert.equal(fork.data.conversation.messages.length, 4);
  const forkAgain = await json(`/api/shares/${share.data.id}/fork`, { method: 'POST' });
  assert.equal(forkAgain.data.reused, true);

  const exportResponse = await request('/api/export');
  assert.equal(exportResponse.status, 200);
  assert.match(exportResponse.headers.get('content-type'), /application\/zip/);
  const exportBytes = new Uint8Array(await exportResponse.arrayBuffer());
  const exported = unzipSync(exportBytes);
  const manifest = JSON.parse(strFromU8(exported['manifest.json']));
  assert.equal(manifest.export_format_version, 3);
  assert.ok(exported[`chat_sessions/${conversationId}.json`], '导出包应包含对话 JSON');
  const exportedSession = JSON.parse(strFromU8(exported[`chat_sessions/${conversationId}.json`]));
  assert.equal(exportedSession.messages[0].fragments[0].type, 'REQUEST');
  assert.ok(!strFromU8(exported[`chat_sessions/${conversationId}.json`]).includes(API_KEY));

  const officialZip = makeOfficialZip();
  const importResponse = await request('/api/import/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: Buffer.from(officialZip)
  });
  const importData = await importResponse.json();
  assert.equal(importResponse.status, 201);
  assert.equal(importData.imported, 1);
  const importedId = importData.conversations[0].id;
  const imported = await json(`/api/conversations/${importedId}`);
  assert.equal(imported.data.conversation.messages.length, 4);
  assert.equal(imported.data.conversation.messages[0].content, '问题一');
  assert.equal(imported.data.conversation.messages[1].content, '回答一');
  assert.equal(imported.data.conversation.messages[2].content, '问题二');
  assert.equal(imported.data.conversation.messages[3].content, '回答二');
  assert.ok(!JSON.stringify(imported.data).includes('sig-import'));

  const duplicate = await request('/api/import/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: Buffer.from(officialZip)
  });
  const duplicateData = await duplicate.json();
  assert.equal(duplicate.status, 201);
  assert.equal(duplicateData.imported, 0);
  assert.ok(duplicateData.skipped >= 1);

  const shareImport = await json('/api/import/share', {
    method: 'POST',
    body: { url: 'https://chat.deepseek.com/share/abcdef123456' }
  });
  assert.equal(shareImport.response.status, 201);
  assert.equal(shareImport.data.conversation.title, '分享的对话标题');
  assert.equal(shareImport.data.conversation.messages.length, 2);

  const badShare = await json('/api/import/share', {
    method: 'POST',
    body: { url: 'https://evil.example.com/share/abcdef123456' }
  });
  assert.equal(badShare.response.status, 400);

  const badVersionZip = zipSync(
    {
      'manifest.json': strToU8(JSON.stringify({ export_format_version: 99 })),
      'chat_sessions/x.json': strToU8(JSON.stringify({ id: 'x', messages: [] }))
    },
    { level: 0 }
  );
  const badVersion = await request('/api/import/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: Buffer.from(badVersionZip)
  });
  const badVersionData = await badVersion.json();
  assert.equal(badVersion.status, 400);
  assert.equal(badVersionData.code, 'ZIP_NEWER');

  await json('/api/conversations', { method: 'DELETE' });
  const roundTrip = await request('/api/import/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: Buffer.from(exportBytes)
  });
  const roundTripData = await roundTrip.json();
  assert.equal(roundTrip.status, 201);
  assert.ok(roundTripData.imported >= 2, '导出的 ZIP 应该可以重新导入');
  const roundTripList = await json('/api/conversations');
  assert.ok(roundTripList.data.conversations.some((item) => item.title.includes('example.com')));
  const finalShare = await json(
    `/api/conversations/${roundTripList.data.conversations[0].id}/share`,
    { method: 'POST' }
  );
  assert.equal(finalShare.response.status, 201);

  const rewindChat = await request('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '重新生成测试的第一个问题' })
  });
  const rewindConversationId = parseSse(await rewindChat.text()).find(
    (event) => event.type === 'meta'
  ).conversation.id;
  const rewindSecondChat = await request('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: '重新生成测试的第二个问题',
      conversationId: rewindConversationId
    })
  });
  await rewindSecondChat.text();
  const rewindConversation = await json(`/api/conversations/${rewindConversationId}`);
  const firstAssistantId = rewindConversation.data.conversation.messages[1].id;
  const rewindAssistant = await request(
    `/api/conversations/${rewindConversationId}/rewind`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: firstAssistantId })
    }
  );
  assert.equal(rewindAssistant.status, 200);
  const rewindAssistantDone = parseSse(await rewindAssistant.text()).find(
    (event) => event.type === 'done'
  );
  assert.ok(rewindAssistantDone?.message?.content.includes('网页摘要'));
  const afterAssistantRewind = await json(`/api/conversations/${rewindConversationId}`);
  assert.equal(
    afterAssistantRewind.data.conversation.messages.length,
    2,
    '重新生成较早回答应删除它之后的对话'
  );

  const firstUserId = afterAssistantRewind.data.conversation.messages[0].id;
  const rewindUser = await request(`/api/conversations/${rewindConversationId}/rewind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId: firstUserId, content: '修改后的用户问题' })
  });
  assert.equal(rewindUser.status, 200);
  await rewindUser.text();
  assert.equal(mock.lastBody.input.at(-1).role, 'user');
  assert.equal(mock.lastBody.input.at(-1).content, '修改后的用户问题');
  const afterUserRewind = await json(`/api/conversations/${rewindConversationId}`);
  assert.equal(afterUserRewind.data.conversation.messages.length, 2);
  assert.equal(afterUserRewind.data.conversation.messages[0].content, '修改后的用户问题');

  const deleteKey = await json('/api/settings/api-key', { method: 'DELETE' });
  assert.equal(deleteKey.data.hasApiKey, false);

  const noKeyChat = await json('/api/chat', {
    method: 'POST',
    body: { content: '没有 Key 也能发吗？' }
  });
  assert.equal(noKeyChat.response.status, 400);
  assert.equal(noKeyChat.data.code, 'NO_API_KEY');

  const deleteAll = await json('/api/conversations', { method: 'DELETE' });
  assert.equal(deleteAll.response.status, 200);
  const afterDelete = await json('/api/conversations');
  assert.equal(afterDelete.data.conversations.length, 0);
  const shareAfterDelete = await json(`/api/shares/${finalShare.data.id}`);
  assert.equal(shareAfterDelete.response.status, 404);
});

function parseSse(text) {
  return text
    .split('\n\n')
    .map((block) =>
      block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
    )
    .filter(Boolean)
    .map((raw) => JSON.parse(raw));
}

function makeOfficialZip() {
  const session = {
    id: 'official-session-1',
    title: '官网导出的对话',
    pinned: false,
    current_message_id: 4,
    inserted_at: '2026-11-11T02:33:23.270Z',
    updated_at: '2026-11-11T02:40:23.270Z',
    messages: [
      message(1, null, 'USER', [{ type: 'REQUEST', content: '问题一' }]),
      message(2, 1, 'ASSISTANT', [
        { type: 'READ_LINK', results: [{ url: 'https://example.com/a', title: 'A', signature: 'sig-import' }] },
        { type: 'RESPONSE', content: '回答一' }
      ]),
      message(3, 2, 'USER', [{ type: 'REQUEST', content: '问题二' }]),
      message(4, 3, 'ASSISTANT', [{ type: 'RESPONSE', content: '回答二' }]),
      message(5, 2, 'USER', [{ type: 'REQUEST', content: '分支问题' }]),
      message(6, 5, 'ASSISTANT', [{ type: 'RESPONSE', content: '分支回答' }])
    ]
  };
  const index = [
    {
      id: session.id,
      title: session.title,
      pinned: false,
      message_count: 6,
      inserted_at: session.inserted_at,
      updated_at: session.updated_at
    }
  ];
  return zipSync(
    {
      'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
      'chat_sessions/official-session-1.json': strToU8(JSON.stringify(session)),
      'chat_session_index.json': strToU8(JSON.stringify(index))
    },
    { level: 0 }
  );
}

function message(id, parentId, role, fragments) {
  return {
    id,
    parent_id: parentId,
    role,
    status: 'FINISHED',
    thinking_enabled: false,
    search_enabled: false,
    accumulated_token_usage: 0,
    inserted_at: '2026-11-11T02:33:23.270Z',
    fragments
  };
}

async function startMockDeepSeek() {
  const state = {
    lastBody: null,
    lastAuthorization: '',
    baseUrl: '',
    close: null
  };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/responses') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      state.lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      state.lastAuthorization = req.headers.authorization || '';

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      const tool = {
        type: 'web_search_call',
        id: 'srvtoolu_rl_test_1',
        status: 'completed',
        kind: 'read_link',
        action: { type: 'open_page', url: 'https://example.com/' },
        page: { url: 'https://example.com/', title: 'Example Domain', published_at: null },
        signature: 'test-signature-123'
      };
      const message = {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '这是网页摘要。' }]
      };
      const events = [
        {
          type: 'response.output_item.added',
          item: { ...tool, status: 'in_progress' }
        },
        {
          type: 'response.output_item.done',
          item: tool
        },
        {
          type: 'response.output_text.delta',
          delta: '这是网页摘要。'
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp_test_1',
            status: 'completed',
            output: [tool, message],
            usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }
          }
        }
      ];
      for (const event of events) {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        await new Promise((resolve) => setTimeout(resolve, 4));
      }
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/api/v0/share/content')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          code: 0,
          data: {
            biz_code: 0,
            biz_data: {
              title: '分享的对话标题',
              messages: [
                {
                  role: 'USER',
                  inserted_at: 1765051924.948,
                  fragments: [{ type: 'REQUEST', content: '分享里的问题' }]
                },
                {
                  role: 'ASSISTANT',
                  inserted_at: 1765051924.958,
                  fragments: [{ type: 'RESPONSE', content: '分享里的回答' }]
                }
              ]
            }
          }
        })
      );
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.baseUrl = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise((resolve) => server.close(resolve));
  return state;
}
