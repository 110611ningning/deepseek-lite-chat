(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);

  const els = {
    main: $('#main'),
    empty: $('#empty'),
    emptyTitle: $('#emptyTitle'),
    emptyText: $('#emptyText'),
    exampleRow: $('#exampleRow'),
    emptyKeyBtn: $('#emptyKeyBtn'),
    retryBtn: $('#retryBtn'),
    messages: $('#messages'),
    shareNotice: $('#shareNotice'),
    composer: $('#composer'),
    prompt: $('#prompt'),
    sendBtn: $('#sendBtn'),
    historyBtn: $('#historyBtn'),
    titleButton: $('#titleButton'),
    chatTitle: $('#chatTitle'),
    shareBtn: $('#shareBtn'),
    settingsBtn: $('#settingsBtn'),
    drawerLayer: $('#drawerLayer'),
    drawerClose: $('#drawerClose'),
    drawerNew: $('#drawerNew'),
    conversationList: $('#conversationList'),
    settingsDialog: $('#settingsDialog'),
    keyStatus: $('#keyStatus'),
    keyForm: $('#keyForm'),
    apiKeyInput: $('#apiKeyInput'),
    saveKeyBtn: $('#saveKeyBtn'),
    keyFormMessage: $('#keyFormMessage'),
    deleteKeyRow: $('#deleteKeyRow'),
    importHistoryRow: $('#importHistoryRow'),
    historyFileInput: $('#historyFileInput'),
    shareUrlInput: $('#shareUrlInput'),
    importShareBtn: $('#importShareBtn'),
    shareImportMessage: $('#shareImportMessage'),
    exportRow: $('#exportRow'),
    deleteAllRow: $('#deleteAllRow'),
    dataMessage: $('#dataMessage'),
    shareDialog: $('#shareDialog'),
    shareUrlOutput: $('#shareUrlOutput'),
    copyShareBtn: $('#copyShareBtn'),
    confirmDialog: $('#confirmDialog'),
    confirmTitle: $('#confirmTitle'),
    confirmText: $('#confirmText'),
    confirmCancel: $('#confirmCancel'),
    confirmOk: $('#confirmOk'),
    toast: $('#toast')
  };

  const state = {
    hasApiKey: false,
    conversations: [],
    conversation: null,
    share: null,
    viewMessages: [],
    streaming: false,
    forkBusy: false,
    abortController: null,
    live: null,
    pendingSend: null,
    renderTimer: null,
    scrollStick: true,
    toastTimer: null,
    confirmResolve: null,
    fatalHandler: null,
    booted: false
  };

  init();

  async function init() {
    bindEvents();
    syncViewportHeight();
    updateComposerState();
    try {
      const data = await apiJSON('/api/bootstrap');
      state.hasApiKey = Boolean(data.hasApiKey);
      state.conversations = data.conversations || [];
      state.booted = true;
      updateKeyUI();
      await route();
    } catch (error) {
      showFatal('加载失败', error.message || '无法连接服务器，请稍后重试');
    }
  }

  function bindEvents() {
    els.composer.addEventListener('submit', (event) => {
      event.preventDefault();
      if (state.streaming) {
        stopStreaming();
        return;
      }
      sendMessage();
    });

    els.prompt.addEventListener('input', () => {
      autosizePrompt();
      updateComposerState();
    });

    els.prompt.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      if (window.matchMedia('(pointer: coarse)').matches) return;
      event.preventDefault();
      if (state.streaming) return;
      sendMessage();
    });

    els.exampleRow.addEventListener('click', (event) => {
      const button = event.target.closest('[data-fill]');
      if (!button) return;
      els.prompt.value = button.dataset.fill || '';
      autosizePrompt();
      updateComposerState();
      els.prompt.focus();
      els.prompt.setSelectionRange(els.prompt.value.length, els.prompt.value.length);
    });

    els.emptyKeyBtn.addEventListener('click', () => openSettings('key'));
    els.settingsBtn.addEventListener('click', () => openSettings(''));
    els.shareBtn.addEventListener('click', shareConversation);
    els.historyBtn.addEventListener('click', openDrawer);
    els.titleButton.addEventListener('click', openDrawer);
    els.drawerClose.addEventListener('click', closeDrawer);
    els.drawerNew.addEventListener('click', () => {
      closeDrawer();
      newChat({ push: true });
    });
    els.drawerLayer.addEventListener('click', (event) => {
      if (event.target.closest('[data-close-drawer]')) closeDrawer();
    });

    els.keyForm.addEventListener('submit', saveApiKey);
    els.deleteKeyRow.addEventListener('click', deleteApiKey);
    els.importHistoryRow.addEventListener('click', () => els.historyFileInput.click());
    els.historyFileInput.addEventListener('change', importHistoryZip);
    els.importShareBtn.addEventListener('click', importShareLink);
    els.shareUrlInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        importShareLink();
      }
    });
    els.exportRow.addEventListener('click', exportAll);
    els.deleteAllRow.addEventListener('click', deleteAllConversations);
    els.copyShareBtn.addEventListener('click', copyShareLink);
    els.retryBtn.addEventListener('click', () => {
      if (state.fatalHandler) {
        state.fatalHandler();
      } else {
        location.reload();
      }
    });

    document.querySelectorAll('[data-close-dialog]').forEach((button) => {
      button.addEventListener('click', () => closeDialog(button.dataset.closeDialog));
    });

    [els.settingsDialog, els.shareDialog].forEach((dialog) => {
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) closeDialog(dialog.id);
      });
      dialog.addEventListener('close', syncBodyLock);
    });

    els.settingsDialog.addEventListener('close', () => {
      if (!state.hasApiKey) state.pendingSend = null;
      els.apiKeyInput.value = '';
      els.keyFormMessage.textContent = '';
      els.keyFormMessage.className = 'form-message';
    });

    els.confirmDialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      resolveConfirm(false);
    });
    els.confirmDialog.addEventListener('close', () => {
      if (state.confirmResolve) resolveConfirm(false);
      syncBodyLock();
    });
    els.confirmCancel.addEventListener('click', () => resolveConfirm(false));
    els.confirmOk.addEventListener('click', () => resolveConfirm(true));

    els.main.addEventListener('scroll', () => {
      state.scrollStick = isNearBottom();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && els.drawerLayer.classList.contains('open')) {
        closeDrawer();
      }
    });

    window.addEventListener('popstate', async () => {
      if (state.streaming) stopStreaming();
      await route().catch((error) => showFatal('打开失败', error.message));
    });

    window.addEventListener('resize', syncViewportHeight);
    window.visualViewport?.addEventListener('resize', syncViewportHeight);
    window.visualViewport?.addEventListener('scroll', () => {
      if (isNearBottom()) scrollToBottom(false);
    });
  }

  function syncViewportHeight() {
    const height = window.visualViewport?.height;
    if (height && height > 240) {
      document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`);
    } else {
      document.documentElement.style.removeProperty('--app-height');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 路由与加载                                                         */
  /* ------------------------------------------------------------------ */

  async function route() {
    const path = location.pathname;
    const shareMatch = path.match(/^\/s\/([A-Za-z0-9_-]+)\/?$/);
    if (shareMatch) {
      await loadShare(shareMatch[1]);
      return;
    }
    const conversationMatch = path.match(/^\/c\/([A-Za-z0-9-]+)\/?$/);
    if (conversationMatch) {
      await loadConversation(conversationMatch[1]);
      return;
    }
    newChat({ push: false });
  }

  function newChat({ push }) {
    if (state.streaming) stopStreaming();
    state.live = null;
    state.conversation = null;
    state.share = null;
    state.viewMessages = [];
    state.scrollStick = true;
    resetEmpty();
    renderAllMessages();
    updateHeader();
    updateComposerState();
    if (push) {
      if (location.pathname !== '/') history.pushState({}, '', '/');
    } else if (location.pathname !== '/') {
      history.replaceState({}, '', '/');
    }
    els.prompt.focus();
  }

  async function loadConversation(id) {
    try {
      const data = await apiJSON(`/api/conversations/${id}`);
      if (state.streaming) stopStreaming();
      state.live = null;
      state.conversation = data.conversation;
      state.share = null;
      state.viewMessages = data.conversation.messages;
      state.scrollStick = true;
      resetEmpty();
      renderAllMessages();
      updateHeader();
      updateComposerState();
      scrollToBottom(true);
    } catch (error) {
      if (error.status === 404) {
        showFatal('对话不存在', '这段对话可能已经被删除了。', {
          label: '开始新对话',
          action: () => {
            history.pushState({}, '', '/');
            newChat({ push: false });
          }
        });
      } else {
        throw error;
      }
    }
  }

  async function loadShare(id) {
    try {
      const data = await apiJSON(`/api/shares/${id}`);
      if (state.streaming) stopStreaming();
      state.live = null;
      state.share = data.share;
      state.conversation = null;
      state.viewMessages = data.share.messages || [];
      state.scrollStick = true;
      resetEmpty();
      renderAllMessages();
      updateHeader();
      updateComposerState();
      scrollToBottom(true);
    } catch (error) {
      if (error.status === 404) {
        showFatal('分享不存在或已失效', '这个链接可能已被删除，或者分享者删除了对应的对话。', {
          label: '开始新对话',
          action: () => {
            history.pushState({}, '', '/');
            newChat({ push: false });
          }
        });
      } else {
        throw error;
      }
    }
  }

  async function refreshConversations() {
    try {
      const data = await apiJSON('/api/conversations');
      state.conversations = data.conversations || [];
      if (els.drawerLayer.classList.contains('open')) renderConversationList();
    } catch {
      /* 静默失败，不打断聊天 */
    }
  }

  function updateHeader() {
    const title = state.share?.title || state.conversation?.title || 'DeepSeek';
    els.chatTitle.textContent = title;
    document.title = title === 'DeepSeek' ? 'DeepSeek 极简聊天' : `${title} · DeepSeek`;

    const hasAnswer = state.viewMessages.some(
      (message) => message.role === 'assistant' && message.content
    );
    const canShare =
      !state.share &&
      Boolean(state.conversation?.id) &&
      hasAnswer &&
      !state.streaming;
    els.shareBtn.hidden = !canShare;
    els.shareNotice.hidden = !state.share;
    els.emptyKeyBtn.hidden = state.hasApiKey;
    els.prompt.placeholder = state.share ? '继续这段对话…' : '给 DeepSeek 发送消息…';
  }

  /* ------------------------------------------------------------------ */
  /* 渲染                                                               */
  /* ------------------------------------------------------------------ */

  function renderAllMessages() {
    els.messages.textContent = '';
    const hasMessages = state.viewMessages.length > 0;

    els.empty.hidden = hasMessages;
    els.messages.hidden = !hasMessages;

    if (!hasMessages) {
      els.prompt.value = els.prompt.value || '';
      scrollToBottom(true);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const message of state.viewMessages) {
      fragment.appendChild(createMessageElement(message));
    }
    els.messages.appendChild(fragment);
    updateHeader();
  }

  function createMessageElement(message) {
    if (message.role === 'user') {
      const wrap = document.createElement('div');
      wrap.className = 'message user';
      wrap.dataset.messageId = message.id || '';
      const bubble = document.createElement('div');
      bubble.className = 'user-bubble';
      bubble.textContent = message.content || '';
      wrap.appendChild(bubble);
      return wrap;
    }

    const wrap = document.createElement('div');
    wrap.className = 'message assistant';
    wrap.dataset.messageId = message.id || '';

    wrap.appendChild(createAssistantAvatar());

    const main = document.createElement('div');
    main.className = 'assistant-main';

    const head = document.createElement('div');
    head.className = 'assistant-head';
    const name = document.createElement('span');
    name.className = 'assistant-name';
    name.textContent = 'DeepSeek';
    head.appendChild(name);
    if (message.status === 'stopped') {
      const badge = document.createElement('span');
      badge.className = 'stopped-badge';
      badge.textContent = '已停止';
      head.appendChild(badge);
    }
    main.appendChild(head);

    const content = document.createElement('div');
    content.className = 'md';
    if (message.content) renderMarkdownInto(content, message.content);
    main.appendChild(content);

    if (message.status === 'refused' && !message.content) {
      const error = createErrorNote(message.error || '内容未通过安全检查，请换一种说法再试');
      main.appendChild(error);
    } else if (message.error) {
      main.appendChild(createErrorNote(message.error));
    }

    if (message.note) {
      const note = document.createElement('div');
      note.className = 'note-text';
      note.textContent = message.note;
      main.appendChild(note);
    }

    if (Array.isArray(message.sources) && message.sources.length) {
      main.appendChild(createSources(message.sources));
    }

    if (message.content) {
      const actions = document.createElement('div');
      actions.className = 'message-actions';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'action-button';
      copy.appendChild(iconEl('copy'));
      copy.appendChild(document.createTextNode('复制'));
      copy.addEventListener('click', async () => {
        const ok = await copyText(message.content);
        toast(ok ? '已复制' : '复制失败，请手动选择文字');
      });
      actions.appendChild(copy);
      main.appendChild(actions);
    }

    wrap.appendChild(main);
    return wrap;
  }

  function createAssistantAvatar() {
    const avatar = document.createElement('div');
    avatar.className = 'assistant-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const whale = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    whale.setAttribute(
      'd',
      'M4 14.2c2.6 0 4.1-2.2 7-2.2 2.3 0 3.7 1.4 5.5 1.4 1.1 0 2-.4 2.8-1.1-.2 4.3-3.6 7.6-7.9 7.6A7.6 7.6 0 0 1 4 13.7v.5Z'
    );
    whale.setAttribute('fill', 'currentColor');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.setAttribute('d', 'M7 7.5c1.7 1.5 3.9 2.2 6.8 2.3');
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '1.6');
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke-linecap', 'round');
    const eye = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    eye.setAttribute('cx', '16.4');
    eye.setAttribute('cy', '12');
    eye.setAttribute('r', '.9');
    eye.setAttribute('fill', 'currentColor');
    svg.append(whale, line, eye);
    avatar.appendChild(svg);
    return avatar;
  }

  function createErrorNote(text) {
    const note = document.createElement('div');
    note.className = 'error-note';
    const mark = document.createElement('span');
    mark.textContent = '!';
    mark.className = 'error-mark';
    note.appendChild(mark);
    const span = document.createElement('span');
    span.textContent = text;
    note.appendChild(span);
    return note;
  }

  function createSources(sources) {
    const wrap = document.createElement('div');
    wrap.className = 'sources';
    const seen = new Set();
    for (const source of sources) {
      if (!source?.url || seen.has(source.url)) continue;
      const href = safeUrl(source.url);
      if (href === '#') continue;
      seen.add(source.url);
      const anchor = document.createElement('a');
      anchor.className = 'source-chip';
      anchor.href = href;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.appendChild(iconEl('globe'));
      const label = document.createElement('span');
      label.textContent = source.title || source.domain || source.url;
      anchor.appendChild(label);
      wrap.appendChild(anchor);
    }
    return wrap;
  }

  function appendLiveAssistant() {
    const message = {
      id: `live-${Date.now()}`,
      role: 'assistant',
      content: '',
      status: 'streaming',
      sources: []
    };
    state.viewMessages.push(message);

    const wrap = document.createElement('div');
    wrap.className = 'message assistant streaming';
    wrap.dataset.messageId = message.id;

    wrap.appendChild(createAssistantAvatar());

    const main = document.createElement('div');
    main.className = 'assistant-main';

    const head = document.createElement('div');
    head.className = 'assistant-head';
    const name = document.createElement('span');
    name.className = 'assistant-name';
    name.textContent = 'DeepSeek';
    head.appendChild(name);
    main.appendChild(head);

    const status = document.createElement('div');
    status.className = 'stream-status';
    const dots = document.createElement('span');
    dots.className = 'dots';
    dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    const statusText = document.createElement('span');
    statusText.textContent = '正在连接 DeepSeek…';
    status.append(dots, statusText);
    main.appendChild(status);

    const toolBox = document.createElement('div');
    toolBox.className = 'tool-box';
    toolBox.hidden = true;
    main.appendChild(toolBox);

    const content = document.createElement('div');
    content.className = 'md';
    main.appendChild(content);

    const tail = document.createElement('div');
    tail.className = 'live-tail';
    main.appendChild(tail);

    wrap.appendChild(main);
    els.messages.appendChild(wrap);

    state.live = {
      message,
      wrap,
      status,
      statusText,
      toolBox,
      content,
      tail,
      text: '',
      tools: new Map(),
      serverError: null,
      renderTimer: null
    };
  }

  function setLiveStatus(text) {
    const live = state.live;
    if (!live) return;
    live.status.hidden = false;
    live.statusText.textContent = text;
  }

  function hideLiveStatus() {
    if (state.live) state.live.status.hidden = true;
  }

  function handleLiveTool(tool) {
    const live = state.live;
    if (!live || !tool) return;
    const key = tool.id || tool.url || `tool-${live.tools.size}`;
    const existing = live.tools.get(key) || {};
    live.tools.set(key, { ...existing, ...tool });
    live.toolBox.hidden = false;
    renderLiveTools();
    if (tool.status === 'reading') setLiveStatus('正在阅读网页…');
  }

  function renderLiveTools() {
    const live = state.live;
    if (!live) return;
    live.toolBox.textContent = '';
    for (const tool of live.tools.values()) {
      const line = document.createElement('div');
      line.className = `tool-line ${tool.status === 'completed' ? 'done' : tool.status === 'failed' ? 'failed' : ''}`;
      if (tool.status === 'reading') {
        const spinner = document.createElement('span');
        spinner.className = 'spinner';
        line.appendChild(spinner);
      } else {
        line.appendChild(iconEl(tool.status === 'failed' ? 'close' : 'check'));
      }
      const label = document.createElement('span');
      const domain = domainFromUrl(tool.url);
      if (tool.status === 'reading') {
        label.textContent = domain ? `正在阅读 ${domain}` : '正在阅读网页';
      } else if (tool.status === 'failed') {
        label.textContent = domain ? `无法读取 ${domain}` : '网页读取失败';
      } else {
        label.textContent = tool.title ? `已读取：${tool.title}` : `已读取 ${domain || '网页'}`;
      }
      line.appendChild(label);
      live.toolBox.appendChild(line);
    }
  }

  function appendLiveDelta(text) {
    const live = state.live;
    if (!live) return;
    const stick = isNearBottom();
    live.text += text;
    live.message.content = live.text;
    if (!live.renderTimer) {
      live.renderTimer = setTimeout(() => {
        if (!state.live) return;
        state.live.renderTimer = null;
        renderMarkdownInto(state.live.content, state.live.text);
        if (stick || isNearBottom()) scrollToBottom(false);
      }, 55);
    }
    hideLiveStatus();
    if (stick) scrollToBottom(false);
  }

  function finalizeLive(message) {
    const live = state.live;
    if (!live) return;
    const index = state.viewMessages.indexOf(live.message);
    if (index >= 0) state.viewMessages[index] = message;
    state.live = null;
    renderAllMessages();
    scrollToBottom(true);
  }

  function finalizeLiveFromLocal({ status, error, note }) {
    const live = state.live;
    if (!live) return;
    const sources = [...live.tools.values()]
      .filter((tool) => tool.status === 'completed' && tool.url)
      .map((tool) => ({ url: tool.url, title: tool.title || '' }));
    finalizeLive({
      id: live.message.id,
      role: 'assistant',
      content: live.text.trim(),
      createdAt: new Date().toISOString(),
      status,
      sources,
      error: error || '',
      note: note || ''
    });
  }

  /* ------------------------------------------------------------------ */
  /* Markdown（只创建 DOM 节点，不注入 HTML，天然防 XSS）                 */
  /* ------------------------------------------------------------------ */

  function renderMarkdownInto(container, text) {
    container.textContent = '';
    const fragment = document.createDocumentFragment();
    renderBlocks(fragment, String(text || '').replace(/\r\n?/g, '\n').split('\n'));
    container.appendChild(fragment);
  }

  function renderBlocks(parent, lines) {
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i += 1;
        continue;
      }

      const fence = line.match(/^```\s*([A-Za-z0-9_+-]*)\s*$/);
      if (fence) {
        const codeLines = [];
        i += 1;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          codeLines.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1;
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        if (fence[1]) code.className = `language-${fence[1]}`;
        code.textContent = codeLines.join('\n');
        pre.appendChild(code);
        parent.appendChild(pre);
        continue;
      }

      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        const el = document.createElement(`h${level}`);
        appendInline(el, heading[2]);
        parent.appendChild(el);
        i += 1;
        continue;
      }

      if (/^\s*(?:---|\*\*\*|___+)\s*$/.test(line)) {
        parent.appendChild(document.createElement('hr'));
        i += 1;
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        const quoteLines = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        const quote = document.createElement('blockquote');
        renderBlocks(quote, quoteLines);
        parent.appendChild(quote);
        continue;
      }

      if (isTableStart(lines, i)) {
        i = renderTable(parent, lines, i);
        continue;
      }

      const unordered = line.match(/^\s*[-*+]\s+(.*)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (unordered || ordered) {
        i = renderList(parent, lines, i, Boolean(ordered));
        continue;
      }

      const paragraphLines = [line];
      i += 1;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i)) {
        paragraphLines.push(lines[i]);
        i += 1;
      }
      const paragraph = document.createElement('p');
      appendInline(paragraph, paragraphLines.join('\n'), true);
      parent.appendChild(paragraph);
    }
  }

  function isBlockStart(lines, index) {
    const line = lines[index];
    if (!line?.trim()) return true;
    return (
      /^```/.test(line) ||
      /^#{1,4}\s+/.test(line) ||
      /^\s*>\s?/.test(line) ||
      /^\s*(?:---|\*\*\*|___+)\s*$/.test(line) ||
      /^\s*[-*+]\s+/.test(line) ||
      /^\s*\d+[.)]\s+/.test(line) ||
      isTableStart(lines, index)
    );
  }

  function isTableStart(lines, index) {
    if (index + 1 >= lines.length) return false;
    const header = lines[index];
    const divider = lines[index + 1];
    if (!header.includes('|') || !divider.includes('|')) return false;
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(divider);
  }

  function renderTable(parent, lines, start) {
    const headerRow = splitTableRow(lines[start]);
    const alignRow = splitTableRow(lines[start + 1]);
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headTr = document.createElement('tr');
    headerRow.forEach((cell, index) => {
      const th = document.createElement('th');
      appendInline(th, cell);
      if (alignRow[index]?.startsWith(':') && alignRow[index]?.endsWith(':')) {
        th.style.textAlign = 'center';
      } else if (alignRow[index]?.endsWith(':')) {
        th.style.textAlign = 'right';
      }
      headTr.appendChild(th);
    });
    thead.appendChild(headTr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    let i = start + 2;
    while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
      const cells = splitTableRow(lines[i]);
      const tr = document.createElement('tr');
      for (let index = 0; index < headerRow.length; index += 1) {
        const td = document.createElement('td');
        appendInline(td, cells[index] || '');
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
      i += 1;
    }
    table.appendChild(tbody);
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    wrap.appendChild(table);
    parent.appendChild(wrap);
    return i;
  }

  function splitTableRow(line) {
    return line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
  }

  function renderList(parent, lines, start, ordered) {
    const list = document.createElement(ordered ? 'ol' : 'ul');
    const pattern = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
    let i = start;
    while (i < lines.length) {
      const match = lines[i].match(pattern);
      if (!match) break;
      const item = document.createElement('li');
      let content = match[1];
      i += 1;
      while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !pattern.test(lines[i])) {
        content += `\n${lines[i].trim()}`;
        i += 1;
      }
      appendInline(item, content, true);
      list.appendChild(item);
    }
    parent.appendChild(list);
    return i;
  }

  const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(__[^_\n]+?__)|(~~[^*\n]+?~~)|(\*[^*\n]+?\*)|(_[^_\n]+?_)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(https?:\/\/[^\s<>]+)/g;

  function appendInline(parent, text, allowBreaks = false) {
    const value = String(text || '');
    const inlineRe = new RegExp(INLINE_RE.source, 'g');
    let last = 0;
    let match;
    while ((match = inlineRe.exec(value))) {
      if (match.index > last) appendText(parent, value.slice(last, match.index), allowBreaks);
      const token = match[0];
      if (token.startsWith('`')) {
        const code = document.createElement('code');
        code.textContent = token.slice(1, -1);
        parent.appendChild(code);
      } else if (token.startsWith('**') || token.startsWith('__')) {
        const strong = document.createElement('strong');
        appendInline(strong, token.slice(2, -2));
        parent.appendChild(strong);
      } else if (token.startsWith('~~')) {
        const del = document.createElement('del');
        appendInline(del, token.slice(2, -2));
        parent.appendChild(del);
      } else if (token.startsWith('*') || token.startsWith('_')) {
        const em = document.createElement('em');
        appendInline(em, token.slice(1, -1));
        parent.appendChild(em);
      } else if (token.startsWith('[')) {
        const linkMatch = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
        if (linkMatch) {
          const anchor = createExternalLink(linkMatch[2]);
          appendInline(anchor, linkMatch[1]);
          parent.appendChild(anchor);
        } else {
          appendText(parent, token, allowBreaks);
        }
      } else if (token.startsWith('http')) {
        const { url, trailing } = trimTrailingPunctuation(token);
        if (url) {
          const anchor = createExternalLink(url);
          anchor.textContent = url;
          parent.appendChild(anchor);
        }
        if (trailing) appendText(parent, trailing, allowBreaks);
      } else {
        appendText(parent, token, allowBreaks);
      }
      last = match.index + token.length;
    }
    if (last < value.length) appendText(parent, value.slice(last), allowBreaks);
  }

  function appendText(parent, text, allowBreaks) {
    if (!text) return;
    if (!allowBreaks) {
      parent.appendChild(document.createTextNode(text));
      return;
    }
    const parts = text.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) parent.appendChild(document.createElement('br'));
      if (part) parent.appendChild(document.createTextNode(part));
    });
  }

  function trimTrailingPunctuation(value) {
    let url = value;
    let trailing = '';
    while (/[.,;:!?，。；：！？、]$/.test(url)) {
      trailing = url.slice(-1) + trailing;
      url = url.slice(0, -1);
    }
    while (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) {
      trailing = `)${trailing}`;
      url = url.slice(0, -1);
    }
    return { url, trailing };
  }

  function createExternalLink(url) {
    const anchor = document.createElement('a');
    anchor.href = safeUrl(url);
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    return anchor;
  }

  /* ------------------------------------------------------------------ */
  /* 发送、流式输出                                                     */
  /* ------------------------------------------------------------------ */

  async function sendMessage() {
    if (state.streaming || state.forkBusy) return;
    const text = els.prompt.value.trim();
    if (!text) return;

    if (!state.hasApiKey) {
      state.pendingSend = text;
      openSettings('key');
      toast('请先保存 DeepSeek API Key');
      return;
    }

    if (state.share) {
      await forkShareAndSend(text);
      return;
    }

    els.prompt.value = '';
    autosizePrompt();
    updateComposerState();
    await runStream(text, state.conversation?.id || '');
  }

  async function forkShareAndSend(text) {
    state.forkBusy = true;
    updateComposerState();
    try {
      const data = await apiJSON(`/api/shares/${state.share.id}/fork`, { method: 'POST' });
      state.conversation = data.conversation;
      state.share = null;
      state.viewMessages = data.conversation.messages;
      history.replaceState({}, '', `/c/${data.conversation.id}`);
      state.scrollStick = true;
      renderAllMessages();
      updateHeader();
      els.prompt.value = '';
      autosizePrompt();
      updateComposerState();
      await runStream(text, data.conversation.id);
    } catch (error) {
      toast(error.message || '复制分享对话失败', 'error');
    } finally {
      state.forkBusy = false;
      updateComposerState();
    }
  }

  async function runStream(text, conversationId) {
    if (state.streaming) return;
    state.streaming = true;
    updateComposerState();
    updateHeader();

    const userMessage = {
      id: `local-user-${Date.now()}`,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
      status: 'completed'
    };
    state.viewMessages.push(userMessage);

    const marker = els.messages.children.length;
    els.empty.hidden = true;
    els.messages.hidden = false;
    els.messages.appendChild(createMessageElement(userMessage));
    appendLiveAssistant();
    state.scrollStick = true;
    scrollToBottom(true);

    const controller = new AbortController();
    state.abortController = controller;
    let finished = false;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, conversationId }),
        signal: controller.signal
      });

      if (!response.ok) {
        const data = await readJsonSafe(response);
        const error = new Error(data.message || `请求失败（${response.status}）`);
        error.code = data.code || 'HTTP_ERROR';
        error.status = response.status;
        error.preflight = true;
        throw error;
      }

      await consumeSSE(response, async (event) => {
        if (event.type === 'meta') {
          applyMeta(event.conversation);
        } else if (event.type === 'status') {
          if (event.status === 'connecting') setLiveStatus('正在连接 DeepSeek…');
          if (event.status === 'thinking') setLiveStatus('正在思考…');
          if (event.status === 'reading') setLiveStatus('正在阅读网页…');
          if (event.status === 'answering') hideLiveStatus();
        } else if (event.type === 'tool') {
          handleLiveTool(event.tool);
        } else if (event.type === 'delta') {
          appendLiveDelta(event.text || '');
        } else if (event.type === 'error') {
          if (state.live) {
            state.live.serverError = event.message || '生成失败';
            state.live.serverCode = event.code || '';
          }
        } else if (event.type === 'done') {
          finished = true;
          applyMeta(event.conversation);
          const finalMessage = event.message;
          if (finalMessage) {
            finalizeLive(finalMessage);
          } else if (state.live?.serverError) {
            finalizeLiveFromLocal({ status: 'error', error: state.live.serverError });
          } else {
            finalizeLiveFromLocal({ status: 'error', error: '服务器返回了空的回答' });
          }
          updateHeader();
          refreshConversations();
        }
      });

      if (!finished) {
        if (state.live?.serverError) {
          finalizeLiveFromLocal({ status: 'error', error: state.live.serverError });
        } else {
          finalizeLiveFromLocal({ status: 'error', error: '连接意外断开，请重试' });
        }
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        finalizeLiveFromLocal({ status: 'stopped' });
      } else if (error.preflight) {
        rollbackPreflight(text, marker);
        if (error.code === 'NO_API_KEY') {
          state.hasApiKey = false;
          updateKeyUI();
          state.pendingSend = text;
          openSettings('key');
        } else {
          toast(error.message || '发送失败', 'error');
        }
      } else {
        if (state.live) {
          finalizeLiveFromLocal({ status: 'error', error: error.message || '网络连接失败' });
        } else {
          toast(error.message || '网络连接失败', 'error');
        }
      }
    } finally {
      state.streaming = false;
      state.abortController = null;
      updateComposerState();
      updateHeader();
      refreshConversations();
    }
  }

  function applyMeta(summary) {
    if (!summary) return;
    if (!state.conversation || state.conversation.id !== summary.id) {
      state.conversation = {
        id: summary.id,
        title: summary.title,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        messages: state.viewMessages
      };
      history.replaceState({}, '', `/c/${summary.id}`);
    } else {
      state.conversation.title = summary.title;
      state.conversation.updatedAt = summary.updatedAt;
      state.conversation.messages = state.viewMessages;
    }
    updateHeader();
  }

  function rollbackPreflight(text, marker) {
    const live = state.live;
    if (live) {
      const index = state.viewMessages.indexOf(live.message);
      if (index >= 0) state.viewMessages.splice(index, 1);
      live.wrap.remove();
      state.live = null;
    }
    const children = Array.from(els.messages.children);
    while (children.length > marker) {
      const last = children.pop();
      if (last && last.parentNode) last.parentNode.removeChild(last);
    }
    const last = state.viewMessages[state.viewMessages.length - 1];
    if (last?.role === 'user' && last.content === text) state.viewMessages.pop();
    if (!els.prompt.value.trim()) {
      els.prompt.value = text;
      autosizePrompt();
    }
    if (state.viewMessages.length) {
      els.messages.hidden = false;
      els.empty.hidden = true;
    } else {
      els.messages.hidden = true;
      els.empty.hidden = false;
    }
    updateComposerState();
  }

  function stopStreaming() {
    if (!state.streaming) return;
    state.abortController?.abort();
  }

  function updateComposerState() {
    const hasText = Boolean(els.prompt.value.trim());
    els.sendBtn.disabled = state.streaming ? false : state.forkBusy || !hasText;
    els.sendBtn.classList.toggle('is-streaming', state.streaming);
    els.sendBtn.setAttribute('aria-label', state.streaming ? '停止生成' : '发送');
    els.sendBtn.title = state.streaming ? '停止生成' : '发送';
  }

  async function consumeSSE(response, handler) {
    if (!response.body) throw new Error('服务器没有返回内容');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLines = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart());
        if (!dataLines.length) continue;
        const raw = dataLines.join('\n');
        if (raw === '[DONE]') continue;
        let event;
        try {
          event = JSON.parse(raw);
        } catch {
          continue;
        }
        await handler(event);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 设置：API Key / 数据管理                                            */
  /* ------------------------------------------------------------------ */

  function openSettings(reason) {
    els.keyFormMessage.textContent = '';
    els.keyFormMessage.className = 'form-message';
    els.shareImportMessage.textContent = '';
    els.shareImportMessage.className = 'form-message';
    els.dataMessage.textContent = '';
    els.dataMessage.className = 'form-message';
    updateKeyUI();
    if (!els.settingsDialog.open) els.settingsDialog.showModal();
    document.body.classList.add('modal-open');
    if (reason === 'key' && !state.hasApiKey) {
      els.keyFormMessage.textContent = '保存 API Key 后就能开始聊天。它只会加密保存在服务器。';
      setTimeout(() => els.apiKeyInput.focus(), 80);
    } else if (!state.hasApiKey) {
      setTimeout(() => els.apiKeyInput.focus(), 80);
    }
  }

  function closeDialog(id) {
    const dialog = document.getElementById(id);
    if (dialog?.open) dialog.close();
  }

  function syncBodyLock() {
    const anyOpen = els.settingsDialog.open || els.shareDialog.open || els.confirmDialog.open;
    document.body.classList.toggle('modal-open', anyOpen);
  }

  function updateKeyUI() {
    els.keyStatus.textContent = state.hasApiKey ? '已保存' : '未设置';
    els.keyStatus.className = `status-pill ${state.hasApiKey ? 'status-on' : 'status-off'}`;
    els.emptyKeyBtn.hidden = state.hasApiKey;
    els.deleteKeyRow.disabled = !state.hasApiKey;
  }

  async function saveApiKey(event) {
    event.preventDefault();
    const apiKey = els.apiKeyInput.value.trim();
    if (!apiKey) {
      setFormMessage(els.keyFormMessage, '请先粘贴 API Key', 'error');
      return;
    }
    els.saveKeyBtn.disabled = true;
    setFormMessage(els.keyFormMessage, '正在加密保存…', '');
    try {
      await apiJSON('/api/settings/api-key', {
        method: 'POST',
        body: { apiKey }
      });
      state.hasApiKey = true;
      els.apiKeyInput.value = '';
      updateKeyUI();
      setFormMessage(els.keyFormMessage, '已加密保存。浏览器不会保留明文。', 'success');
      toast('API Key 已保存');
      if (state.pendingSend) {
        const pending = state.pendingSend;
        state.pendingSend = null;
        closeDialog('settingsDialog');
        setTimeout(() => {
          if (!els.prompt.value.trim()) {
            els.prompt.value = pending;
            autosizePrompt();
          }
          sendMessage();
        }, 120);
      }
    } catch (error) {
      setFormMessage(els.keyFormMessage, error.message || '保存失败', 'error');
    } finally {
      els.saveKeyBtn.disabled = false;
    }
  }

  async function deleteApiKey() {
    if (!state.hasApiKey) return;
    const ok = await askConfirm({
      title: '删除 API Key？',
      text: '删除后必须重新填写 Key 才能继续聊天。已有对话不会受影响。',
      confirmText: '删除 Key'
    });
    if (!ok) return;
    try {
      await apiJSON('/api/settings/api-key', { method: 'DELETE' });
      state.hasApiKey = false;
      updateKeyUI();
      toast('API Key 已删除');
    } catch (error) {
      setFormMessage(els.dataMessage, error.message || '删除失败', 'error');
    }
  }

  async function importHistoryZip() {
    const file = els.historyFileInput.files?.[0];
    els.historyFileInput.value = '';
    if (!file) return;
    if (file.size > 80 * 1024 * 1024) {
      setFormMessage(els.dataMessage, 'ZIP 超过 80MB，无法导入', 'error');
      return;
    }
    els.importHistoryRow.disabled = true;
    setFormMessage(els.dataMessage, '正在导入，请稍候…', '');
    try {
      const response = await fetch('/api/import/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: file
      });
      const data = await readJsonSafe(response);
      if (!response.ok) throw new Error(data.message || '导入失败');
      await refreshConversations();
      if (!data.imported) {
        setFormMessage(
          els.dataMessage,
          data.skipped ? '这些对话已经导入过了，没有重复添加' : '没有可导入的对话',
          'error'
        );
        return;
      }
      toast(`已导入 ${data.imported} 个对话`);
      const first = data.conversations?.[0];
      closeDialog('settingsDialog');
      if (first?.id) {
        history.pushState({}, '', `/c/${first.id}`);
        await loadConversation(first.id);
      }
    } catch (error) {
      setFormMessage(els.dataMessage, error.message || '导入失败', 'error');
    } finally {
      els.importHistoryRow.disabled = false;
    }
  }

  async function importShareLink() {
    const url = els.shareUrlInput.value.trim();
    if (!url) {
      setFormMessage(els.shareImportMessage, '请先粘贴分享链接', 'error');
      return;
    }
    els.importShareBtn.disabled = true;
    setFormMessage(els.shareImportMessage, '正在读取分享…', '');
    try {
      const data = await apiJSON('/api/import/share', {
        method: 'POST',
        body: { url }
      });
      els.shareUrlInput.value = '';
      await refreshConversations();
      toast('分享对话已导入');
      closeDialog('settingsDialog');
      const id = data.conversation?.id;
      if (id) {
        history.pushState({}, '', `/c/${id}`);
        await loadConversation(id);
      }
    } catch (error) {
      setFormMessage(els.shareImportMessage, error.message || '导入失败', 'error');
    } finally {
      els.importShareBtn.disabled = false;
    }
  }

  async function exportAll() {
    els.exportRow.disabled = true;
    setFormMessage(els.dataMessage, '正在打包，请稍候…', '');
    try {
      const response = await fetch('/api/export');
      if (!response.ok) {
        const data = await readJsonSafe(response);
        throw new Error(data.message || '导出失败');
      }
      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') || '';
      const match = disposition.match(/filename="([^"]+)"/);
      downloadBlob(blob, match?.[1] || `deepseek_data-${new Date().toISOString().slice(0, 10)}.zip`);
      setFormMessage(els.dataMessage, 'ZIP 已开始下载。', 'success');
      toast('已开始下载');
    } catch (error) {
      setFormMessage(els.dataMessage, error.message || '导出失败', 'error');
    } finally {
      els.exportRow.disabled = false;
    }
  }

  async function deleteAllConversations() {
    const ok = await askConfirm({
      title: '删除全部对话？',
      text: '这个操作不能撤销。所有对话和已生成的分享链接都会失效，但 API Key 会保留。',
      confirmText: '全部删除'
    });
    if (!ok) return;
    try {
      await apiJSON('/api/conversations', { method: 'DELETE' });
      state.conversations = [];
      state.conversation = null;
      state.share = null;
      state.viewMessages = [];
      closeDialog('settingsDialog');
      history.pushState({}, '', '/');
      newChat({ push: false });
      toast('全部对话已删除');
    } catch (error) {
      setFormMessage(els.dataMessage, error.message || '删除失败', 'error');
    }
  }

  function setFormMessage(element, text, type) {
    element.textContent = text;
    element.className = `form-message ${type || ''}`.trim();
  }

  /* ------------------------------------------------------------------ */
  /* 分享                                                               */
  /* ------------------------------------------------------------------ */

  async function shareConversation() {
    if (!state.conversation?.id || state.streaming) return;
    els.shareBtn.disabled = true;
    try {
      const data = await apiJSON(`/api/conversations/${state.conversation.id}/share`, {
        method: 'POST'
      });
      els.shareUrlOutput.value = data.url;
      if (!els.shareDialog.open) els.shareDialog.showModal();
      document.body.classList.add('modal-open');
      setTimeout(() => els.shareUrlOutput.select(), 80);
    } catch (error) {
      toast(error.message || '生成分享链接失败', 'error');
    } finally {
      els.shareBtn.disabled = false;
    }
  }

  async function copyShareLink() {
    const ok = await copyText(els.shareUrlOutput.value);
    if (ok) {
      toast('分享链接已复制');
      setCopyButtonLabel('已复制', 'check');
      setTimeout(() => setCopyButtonLabel('复制', 'copy'), 1500);
    } else {
      els.shareUrlOutput.select();
      toast('请长按或按 Ctrl+C 复制');
    }
  }

  function setCopyButtonLabel(label, iconName) {
    const text = document.createTextNode(label);
    els.copyShareBtn.replaceChildren(iconEl(iconName), text);
  }

  /* ------------------------------------------------------------------ */
  /* 对话抽屉                                                           */
  /* ------------------------------------------------------------------ */

  function openDrawer() {
    renderConversationList();
    els.drawerLayer.classList.add('open');
    els.drawerLayer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('drawer-open');
    refreshConversations();
  }

  function closeDrawer() {
    els.drawerLayer.classList.remove('open');
    els.drawerLayer.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('drawer-open');
  }

  function renderConversationList() {
    els.conversationList.textContent = '';
    if (!state.conversations.length) {
      const empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = '还没有对话';
      els.conversationList.appendChild(empty);
      return;
    }
    for (const conversation of state.conversations) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'conversation-item';
      if (conversation.id === state.conversation?.id) button.classList.add('active');
      const title = document.createElement('strong');
      title.textContent = conversation.title || '新对话';
      const meta = document.createElement('small');
      const count = Number(conversation.messageCount || 0);
      meta.textContent = `${relativeTime(conversation.updatedAt)} · ${count} 条消息`;
      button.append(title, meta);
      button.addEventListener('click', () => {
        closeDrawer();
        history.pushState({}, '', `/c/${conversation.id}`);
        loadConversation(conversation.id).catch((error) => toast(error.message, 'error'));
      });
      els.conversationList.appendChild(button);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 通用 UI                                                            */
  /* ------------------------------------------------------------------ */

  function showFatal(title, message, options = {}) {
    state.fatalHandler =
      options.action ||
      (() => {
        location.reload();
      });
    els.empty.hidden = false;
    els.messages.hidden = true;
    els.empty.classList.add('error');
    els.emptyTitle.textContent = title;
    els.emptyText.textContent = message;
    els.exampleRow.hidden = true;
    els.emptyKeyBtn.hidden = true;
    els.retryBtn.hidden = false;
    els.retryBtn.textContent = options.label || '重新加载';
    els.chatTitle.textContent = 'DeepSeek';
    els.shareNotice.hidden = true;
    document.title = 'DeepSeek 极简聊天';
  }

  function resetEmpty() {
    state.fatalHandler = null;
    els.empty.classList.remove('error');
    els.emptyTitle.textContent = '今天想聊点什么？';
    els.emptyText.textContent = '粘贴任意公开网页链接，我会自动阅读并总结。';
    els.exampleRow.hidden = false;
    els.retryBtn.hidden = true;
    els.emptyKeyBtn.hidden = state.hasApiKey;
  }

  function autosizePrompt() {
    els.prompt.style.height = 'auto';
    els.prompt.style.height = `${Math.min(els.prompt.scrollHeight, 170)}px`;
  }

  function isNearBottom() {
    return els.main.scrollHeight - els.main.scrollTop - els.main.clientHeight < 120;
  }

  function scrollToBottom(force) {
    if (!force && !state.scrollStick) return;
    requestAnimationFrame(() => {
      els.main.scrollTop = els.main.scrollHeight;
      state.scrollStick = true;
    });
  }

  function toast(message, type = '') {
    els.toast.textContent = message;
    els.toast.className = `toast show ${type}`.trim();
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      els.toast.className = 'toast';
    }, 2400);
  }

  function askConfirm({ title, text, confirmText }) {
    if (state.confirmResolve) resolveConfirm(false);
    els.confirmTitle.textContent = title;
    els.confirmText.textContent = text;
    els.confirmOk.textContent = confirmText || '确认';
    if (!els.confirmDialog.open) els.confirmDialog.showModal();
    document.body.classList.add('modal-open');
    return new Promise((resolve) => {
      state.confirmResolve = resolve;
    });
  }

  function resolveConfirm(value) {
    const resolve = state.confirmResolve;
    state.confirmResolve = null;
    if (els.confirmDialog.open) els.confirmDialog.close();
    if (resolve) resolve(value);
  }

  function iconEl(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.appendChild(use);
    return svg;
  }

  function domainFromUrl(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function safeUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '#';
    } catch {
      return '#';
    }
  }

  function relativeTime(iso) {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return '';
    const diff = Date.now() - date.getTime();
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    const now = new Date();
    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    if (sameDay) {
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (
      date.getFullYear() === yesterday.getFullYear() &&
      date.getMonth() === yesterday.getMonth() &&
      date.getDate() === yesterday.getDate()
    ) {
      return '昨天';
    }
    if (date.getFullYear() === now.getFullYear()) {
      return `${date.getMonth() + 1}月${date.getDate()}日`;
    }
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* 回退到 execCommand */
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      return ok;
    } catch {
      return false;
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  async function apiJSON(path, options = {}) {
    const init = {
      method: options.method || 'GET',
      credentials: 'same-origin',
      headers: { ...(options.headers || {}) }
    };
    if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(path, init);
    const data = await readJsonSafe(response);
    if (!response.ok) {
      const error = new Error(data.message || `请求失败（${response.status}）`);
      error.code = data.code || 'HTTP_ERROR';
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function readJsonSafe(response) {
    try {
      return await response.json();
    } catch {
      return {};
    }
  }
})();
