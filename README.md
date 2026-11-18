# DeepSeek 极简聊天

一个手机、电脑都能用的极简 DeepSeek 网页聊天应用。界面只有聊天窗口、输入框和设置弹窗，底层固定调用 **DeepSeek Responses API** 的 `deepseek-flash` 模型，并始终声明 `deepseek_read_url` 工具。

你粘贴任意公开网页链接，模型会自动读取网页再回答，不需要手动开任何工具开关。API Key 加密保存在服务端，浏览器不保存明文；对话、分享、导入导出都在服务端完成。

> 部署到 Railway 的**超级小白教程**见 [RAILWAY_DEPLOY.md](./RAILWAY_DEPLOY.md)。每一步都写了点哪里。

---

## 功能

- **固定模型**：`deepseek-flash`，不提供模型选择，避免误操作。
- **流式回答**：SSE 实时输出，可随时点停止；任意一条历史回答都可以重新生成。
- **编辑用户消息**：可以修改历史提问；修改后会从该消息开始截断后续对话并重新回答。生成失败时原对话完整保留。
- **链接自动阅读**：始终声明 `deepseek_read_url`；粘贴链接即可总结，不必手动开启工具。
- **安全密钥**：
  - 浏览器只保存一个 HttpOnly 会话 Cookie，不保存 API Key。
  - 服务端使用 AES-256-GCM 加密 API Key，主密钥放在数据目录或 `APP_SECRET` 中。
  - 发消息时由服务端解密并转发到 DeepSeek，Key 不会回传浏览器。
- **数据管理**（设置 → 数据管理）：
  - 删除 API Key
  - 导入历史对话：支持 DeepSeek 官网导出的 ZIP 对话包
  - 从分享链接导入：支持 `https://chat.deepseek.com/share/...`
  - 导出所有历史对话：生成 ZIP
  - 删除全部对话：同时让已生成的分享链接失效
- **一键分享**：对话快照保存在服务端，链接形如 `/s/AbCd...`，不使用 URL 编码的长参数，支持任意长度的对话。
- **分享后续聊**：别人打开链接可直接查看完整对话；填入自己的 API Key 后，会复制到自己的空间继续聊，消耗的是对方自己的余额。
- **手机适配**：底部输入框、安全区、软键盘、全屏设置面板、侧滑历史列表。
- **只保留必要界面**：没有主题切换、模型选择、插件市场、文件上传等额外功能。

---

## 本地运行

要求：Node.js **20 或更高版本**。

```bash
npm install
npm start
```

打开 <http://localhost:3000>。

默认数据在项目下的 `data/` 目录。想换位置：

```bash
DATA_DIR=./my-data PORT=3000 npm start
```

Windows PowerShell：

```powershell
$env:DATA_DIR="./my-data"
$env:PORT="3000"
npm start
```

### 第一次使用

1. 打开 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 创建 API Key。
2. 点右上角设置，把 Key 粘贴进输入框，保存。
3. 回到聊天，粘贴网页链接并提问，例如：
   ```text
   总结 https://example.com 的要点
   ```
4. 回答结束后，底部会显示已读取的网页来源。

---

## 环境变量

| 变量 | 是否必填 | 说明 |
| --- | --- | --- |
| `PORT` | 否 | 监听端口，默认 `3000`。Railway 会自动注入。 |
| `DATA_DIR` | 否 | 数据目录，默认 `./data`。Railway 上应设为 `/data`。 |
| `APP_SECRET` | 否 | 固定主密钥口令。设置后请勿更改，否则旧 Key 无法解密。不设置会自动生成 `master.key`。 |
| `PUBLIC_BASE_URL` | 否 | 分享链接的公开域名。一般不用设置，程序会自动读取 Railway 域名。 |
| `STORE_PATH` | 否 | 直接指定数据文件路径，默认 `$DATA_DIR/store.json`。 |

---

## 数据与安全说明

### 这个应用没有账号密码

每个浏览器第一次访问时，服务端会生成一个随机的匿名空间，并把会话令牌放进 **HttpOnly Cookie**。对话和加密后的 Key 都绑定到这个空间。

- 刷新、重启浏览器、重启服务器都不受影响。
- **清除浏览器 Cookie 会失去这个空间**。建议定期在设置里“导出所有历史对话”备份。
- 换设备时，先在新设备打开站点，再用“导入历史对话”恢复 ZIP。

### API Key 如何保存

1. 浏览器通过 HTTPS 把 Key 发给本站服务端。
2. 服务端用 `AES-256-GCM` 加密，AAD 绑定用户 ID，随机 IV；只保存密文、IV、认证标签。
3. 聊天时服务端解密，放在内存中请求 `https://api.deepseek.com/responses`，请求结束后不保留明文。
4. 浏览器永远拿不到已保存的 Key；刷新后输入框是空的。

主密钥来源：

- 设置了 `APP_SECRET`：用 scrypt 从它派生 32 字节主密钥。
- 没设置：首次启动自动生成随机 `master.key`，保存在数据目录。

> Railway 上如果没有挂载持久卷，重新部署会同时丢失数据库和 `master.key`，已保存的 Key 也会失效。**务必按教程挂载 `/data`。**

### 分享链接

- 点对话右上角分享按钮，服务端生成一个 128 位随机 ID，分享快照存在服务端。
- 链接是 `/s/<随机ID>`，不是把所有对话塞进 URL，所以长对话不会超长。
- 快照生成后不会随原对话继续变化。
- 分享页只展示文字和来源，不暴露 `deepseek_read_url` 的加密签名。
- 删除原对话或“删除全部对话”会让对应分享链接立即失效。
- 任何拿到链接的人都能查看快照；不要分享包含隐私的对话。

### 部署形态

- 数据保存在一个 JSON 文件里，写入使用临时文件 + 原子替换。
- 适合个人、小团队，**只能跑 1 个副本**。不要开多副本，否则多个进程会覆盖同一个文件。
- 数据量特别大、需要多用户隔离或高并发时，应换 PostgreSQL。

### 合规

本项目会向 DeepSeek 转发表单内容，并按 DeepSeek 文档开启 `safety_check: {"level": "high"}`。对外公开提供服务时，请自行履行内容安全、模型登记、AI 生成内容标识等义务。

---

## 编辑与重新生成

- **重新生成**：每条助手回答下面都有“重新生成”。最后一条直接重答；更早的回答会提示“之后的所有对话会被删除”，确认后从该位置重新生成。
- **编辑用户消息**：每条用户消息下面都有“编辑”。修改并保存后，会从这条消息开始截断后续对话，并重新生成回答。
- 重新生成或编辑期间都可以点停止。
- 如果 DeepSeek 报错、超时或用户停止，服务端不会提交截断结果，原对话会完整保留。

> 这个实现采用“截断重答”，不保留旧分支。需要保留多个版本时，应先导出备份，或复制对话后再修改。

---

## 数据管理细节

### 导入历史对话

支持 DeepSeek 官网导出的 `deepseek_data-*.zip`（`export_format_version: 3`）。

- 只导入对话文字和网页读取签名；图片、附件原件、思考过程不导入。
- 多分支消息会按 `current_message_id` 还原当前分支。
- 合并到现有对话列表，不会覆盖已有对话。
- 同一个 ZIP 重复导入会自动跳过。
- ZIP 内单个 JSON 最大 64MB，解压后的 JSON 总量最大 128MB；上传 ZIP 最大 80MB。

### 从分享链接导入

只接受 `https://chat.deepseek.com/share/<id>`。服务端通过 DeepSeek 的公开分享接口读取，不需要登录，也不会访问任意外部地址。

单次分享内容上限为 **128MB**，足够导入很长的对话。超过这个大小会提示“分享内容超过 128MB”。

### 导出所有历史对话

- 生成与 DeepSeek 官网兼容的 v3 ZIP：`manifest.json` / `chat_sessions/*.json` / `chat_session_index.json`。
- 可以直接再导回本应用，也可以尝试导入 DeepSeek 官方客户端。
- ZIP 不包含 API Key、Cookie、设置。

### 删除 API Key / 删除全部对话

- 删除 Key 只移除密钥，不影响对话。
- 删除全部对话会同时删除该空间下所有分享快照，API Key 保留。

---

## DeepSeek API 请求

每次发送消息，服务端向 `POST https://api.deepseek.com/responses` 发送：

```json
{
  "model": "deepseek-flash",
  "instructions": "……固定系统提示词……",
  "input": [
    {"role": "user", "content": "总结 https://example.com"}
  ],
  "tools": [{"type": "deepseek_read_url"}],
  "safety_check": {"level": "high"},
  "max_output_tokens": 8192,
  "stream": true
}
```

多轮对话会把历史消息重新放回 `input`；如果上一轮读取过网页，会把 `web_search_call`（含 `signature`）一起回传，让模型在后续轮次继续引用网页内容。参考：

- [Responses API](https://api-docs.deepseek.com/zh-cn/guides/responses_api)
- [联网工具：deepseek_read_url](https://api-docs.deepseek.com/zh-cn/guides/web_tools)

---

## 测试

```bash
npm test
```

测试使用本地模拟的 DeepSeek Responses SSE 和分享接口，不需要真实 API Key，覆盖：

- API Key 加密落盘、明文不出现、请求时能正确解密
- 固定 `deepseek-flash`、始终带 `deepseek_read_url`
- 流式聊天、网页来源、历史 `signature` 回传
- 任意历史回答重新生成、用户消息编辑与截断重答，失败保留原对话
- 分享链接生成、公开查看、复制继续、签名不泄露
- 官网 v3 ZIP 导入、分支还原、重复导入跳过
- 导出 ZIP 再导入的往返兼容
- 分享链接导入、非法域名拒绝
- 删除 Key、删除全部对话、分享链接失效

浏览器端还实际验证过桌面/手机布局、ZIP 上传、分享链接导入、ZIP 下载、删除全部和分享继续聊天。

---

## 文件结构

```text
.
├── Dockerfile                  # Railway 用
├── railway.json                # Railway 构建/健康检查配置
├── package.json
├── server/
│   ├── index.js                # 启动入口
│   ├── app.js                  # Express 路由、SSE、会话、安全头
│   ├── config.js               # 环境变量
│   ├── crypto.js               # AES-256-GCM、主密钥
│   ├── store.js                # JSON 数据存储
│   ├── deepseek.js             # Responses API 请求与 SSE 解析
│   ├── history.js              # DeepSeek v3 ZIP 导入/导出
│   ├── shares.js               # 分享链接读取
│   └── text.js
├── public/
│   ├── index.html
│   ├── styles.css
│   ├── app.js                  # 无框架前端、Markdown 安全渲染
│   └── favicon.svg
├── test/
│   └── app.test.js
├── README.md
└── RAILWAY_DEPLOY.md
```

---

## 部署

请直接看：[RAILWAY_DEPLOY.md](./RAILWAY_DEPLOY.md)

---

## 常见问题

**Q：刷新后对话还在吗？**
在。对话保存在服务端，浏览器只靠 Cookie 识别你的空间。

**Q：为什么换浏览器/清理 Cookie 后对话没了？**
这个应用没有账号密码，Cookie 就是空间的钥匙。请用“导出所有历史对话”备份。

**Q：为什么 API Key 输入框保存后不显示？**
这是故意的。服务端只返回“已保存/未保存”，不返回 Key 本身。

**Q：分享后对方要继续聊，为什么还要填 Key？**
因为调用 DeepSeek 要花钱。对方用自己的 Key 继续，不消耗你的余额。

**Q：网页读取失败？**
目标网页可能需要登录、禁止抓取、是动态页面或非公开链接。换公开网页试试。

**Q：回答太长被截断？**
单轮输出上限设为 8192 token。可以回复“继续”，或让它分段回答。
