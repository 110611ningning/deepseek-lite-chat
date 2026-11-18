import fs from 'node:fs';
import path from 'node:path';
import { hashToken, newId, randomToken } from './crypto.js';

const EMPTY_STORE = {
  version: 1,
  users: {},
  sessions: {},
  conversations: {},
  shares: {}
};

function ensureShape(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('数据文件格式不正确');
  }
  if (data.version !== 1) throw new Error(`不支持的数据文件版本：${data.version}`);
  for (const key of ['users', 'sessions', 'conversations', 'shares']) {
    if (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key])) {
      throw new Error(`数据文件缺少 ${key}`);
    }
  }
  return data;
}

function cleanTitle(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return (text || '新对话').slice(0, 80);
}

export class Store {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      this.data = ensureShape(JSON.parse(raw));
    } else {
      this.data = structuredClone(EMPTY_STORE);
      this.save();
    }
  }

  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
  }

  createUser() {
    const id = newId();
    const token = randomToken(32);
    const user = {
      id,
      createdAt: new Date().toISOString(),
      apiKey: null
    };
    this.data.users[id] = user;
    this.data.sessions[hashToken(token)] = id;
    this.save();
    return { user, token };
  }

  getUserByToken(token) {
    if (!token) return null;
    const userId = this.data.sessions[hashToken(token)];
    if (!userId) return null;
    return this.data.users[userId] || null;
  }

  getUser(userId) {
    return this.data.users[userId] || null;
  }

  setApiKey(userId, encrypted) {
    const user = this.getUser(userId);
    if (!user) throw new Error('用户不存在');
    user.apiKey = encrypted;
    this.save();
  }

  deleteApiKey(userId) {
    const user = this.getUser(userId);
    if (!user) return;
    user.apiKey = null;
    this.save();
  }

  listConversations(userId) {
    return Object.values(this.data.conversations)
      .filter((conv) => conv.userId === userId)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map((conv) => ({
        id: conv.id,
        title: conv.title,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        messageCount: conv.messages.length
      }));
  }

  getConversation(userId, id) {
    if (!Object.hasOwn(this.data.conversations, id)) return null;
    const conv = this.data.conversations[id];
    return conv && conv.userId === userId ? conv : null;
  }

  findConversationBySource(userId, sourceKey) {
    if (!sourceKey) return null;
    return (
      Object.values(this.data.conversations).find(
        (conv) => conv.userId === userId && conv.sourceKey === sourceKey
      ) || null
    );
  }

  listSourceKeys(userId) {
    return new Set(
      Object.values(this.data.conversations)
        .filter((conv) => conv.userId === userId && conv.sourceKey)
        .map((conv) => conv.sourceKey)
    );
  }

  findFork(userId, shareId) {
    return (
      Object.values(this.data.conversations).find(
        (conv) => conv.userId === userId && conv.forkOfShare === shareId
      ) || null
    );
  }

  insertConversation(userId, input = {}) {
    const now = new Date().toISOString();
    const conv = {
      id: newId(),
      userId,
      title: cleanTitle(input.title),
      createdAt: input.createdAt || now,
      updatedAt: input.updatedAt || now,
      messages: Array.isArray(input.messages) ? input.messages : []
    };
    if (input.sourceKey) conv.sourceKey = String(input.sourceKey);
    if (input.forkOfShare) conv.forkOfShare = String(input.forkOfShare);
    this.data.conversations[conv.id] = conv;
    return conv;
  }

  createConversation(userId, input = {}) {
    const conv = this.insertConversation(userId, input);
    this.save();
    return conv;
  }

  touchConversation(conv) {
    conv.updatedAt = new Date().toISOString();
  }

  updateTitle(conv, title) {
    conv.title = cleanTitle(title);
    this.save();
  }

  deleteConversation(userId, id) {
    const conv = this.getConversation(userId, id);
    if (!conv) return false;
    delete this.data.conversations[id];
    for (const [shareId, share] of Object.entries(this.data.shares)) {
      if (share.ownerId === userId && share.conversationId === id) {
        delete this.data.shares[shareId];
      }
    }
    this.save();
    return true;
  }

  deleteAllConversations(userId) {
    for (const [id, conv] of Object.entries(this.data.conversations)) {
      if (conv.userId === userId) delete this.data.conversations[id];
    }
    for (const [id, share] of Object.entries(this.data.shares)) {
      if (share.ownerId === userId) delete this.data.shares[id];
    }
    this.save();
  }

  createShare(ownerId, conversation, snapshot) {
    const id = inputSafeShareId();
    const share = {
      id,
      ownerId,
      conversationId: conversation.id,
      title: conversation.title,
      createdAt: new Date().toISOString(),
      messages: snapshot
    };
    this.data.shares[id] = share;
    this.save();
    return share;
  }

  getShare(id) {
    if (!Object.hasOwn(this.data.shares, id)) return null;
    return this.data.shares[id];
  }
}

function inputSafeShareId() {
  // 16 随机字节 -> 22 个 URL 安全字符，不可枚举。
  return randomToken(16);
}
