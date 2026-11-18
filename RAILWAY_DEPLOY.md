# Railway 部署教程（超级小白版）

> 这份教程假设你**完全没有编程经验**。不需要用命令行，不需要懂 Docker，也不需要懂数据库。照着点就行。
>
> 你最终会得到一个自己的网址，例如：
> `https://deepseek-lite-chat-production-xxxx.up.railway.app`
> 手机和电脑都能打开。

---

## 开始前，先准备 4 样东西

| 要准备的东西 | 用途 | 在哪里弄 |
| --- | --- | --- |
| 一个浏览器 | 上传代码、操作 Railway | Chrome / Edge 都行 |
| 一个 GitHub 账号 | 存放代码，让 Railway 去取 | <https://github.com> |
| 一个 Railway 账号 | 把网站跑起来 | <https://railway.com> |
| 一个 DeepSeek API Key | 聊天时调用 DeepSeek | <https://platform.deepseek.com/api_keys> |

> Railway 可能需要绑定付款方式才能长期使用，以它官网显示为准。DeepSeek API 是**按用量扣你账户里的余额**，本应用不代收费用。

---

# 第一步：把项目解压到电脑上

1. 找到我给你发的项目压缩包，例如 `deepseek-lite-chat.zip`。
2. 在压缩包上点右键。
3. 点 **“全部解压缩”**（Windows）或双击解压（Mac）。
4. 打开解压后的文件夹。

打开后，你应该**直接看到**这些文件/文件夹：

```text
Dockerfile
package.json
railway.json
server（文件夹）
public（文件夹）
README.md
RAILWAY_DEPLOY.md
```

⚠️ 注意：

- 如果你看到的是一个**同名文件夹套着另一个文件夹**，请双击进去，直到看见上面的文件为止。
- 后面上传的必须是**这些文件本身**，不是最外层那个压缩包。
- 不要改文件名，尤其是 `Dockerfile`，它必须叫这个名字，且必须在这个文件夹的最外层。

---

# 第二步：把代码放到 GitHub

GitHub 你可以理解成“给程序用的网盘”。Railway 会从这个网盘把代码拿走。

## 2.1 注册 / 登录 GitHub

1. 打开 <https://github.com>。
2. 有账号就点右上角 **Sign in** 登录。
3. 没账号就点 **Sign up**，按提示填邮箱、密码、用户名，验证邮箱。

## 2.2 新建一个仓库

1. 登录后，点页面右上角的 **“+”** 号。
2. 点 **New repository**（新建仓库）。
3. 在 **Repository name** 里填：
   ```text
   deepseek-lite-chat
   ```
4. 下面选择 **Public**（公开）。
5. **不要**勾选 “Add a README file”。
6. 点最下面的绿色按钮 **Create repository**。
7. 创建成功后，你会看到一个空仓库页面。

## 2.3 上传项目文件

1. 在空仓库页面中间，点蓝色小字：
   **uploading an existing file**
   （如果没看到，就点页面上的 **Add file** → **Upload files**）。
2. 回到你解压好的项目文件夹。
3. 按 `Ctrl + A` 全选里面的**所有文件和文件夹**。
   - Mac 用 `Command + A`。
   - 注意：是进入文件夹里面全选，不是选中外层文件夹。
4. 把选中的东西直接**拖进浏览器**的上传区域。
5. 等文件名列表全部出现。
6. 在页面下方 **Commit changes** 的输入框里随便写：
   ```text
   上传 DeepSeek 聊天应用
   ```
7. 点绿色按钮 **Commit changes**。

上传成功后，仓库首页应该能看到：

- `Dockerfile`
- `package.json`
- `railway.json`
- `server`
- `public`

⚠️ 如果只看到一个压缩包，说明你上传错了。删掉重新上传“解压后的里面的文件”。

---

# 第三步：在 Railway 创建项目

## 3.1 登录 Railway

1. 打开 <https://railway.com>。
2. 点 **Login**。
3. 选择 **Login with GitHub**（用 GitHub 登录）。
4. 如果弹出授权页面，点 **Authorize**（同意）。

## 3.2 新建项目

1. 进入 Railway 后，点 **New Project**（新建项目）。
2. 选择 **Deploy from GitHub repo**（从 GitHub 仓库部署）。
3. 第一次使用会要求安装 Railway 的 GitHub 应用：
   - 点 **Configure GitHub App**。
   - 弹出 GitHub 页面后，选择 **Only select repositories**（只选指定仓库）。
   - 在下拉框里选中 `deepseek-lite-chat`。
   - 点 **Install & Authorize**。
4. 回到 Railway，在列表里点 `deepseek-lite-chat`。
5. 如果弹出 **Deploy now**，点它。

## 3.3 等它自动构建

1. 点页面里的服务方块（通常叫 `deepseek-lite-chat`）。
2. 点 **Deployments**（部署记录）。
3. 你会看到状态在变：
   - Building（正在构建）
   - Deploying（正在启动）
   - **Successful / Active**（成功）
4. 第一次大约需要 1～3 分钟，耐心等。

如果显示 **Failed**，先看本文最后“常见问题”的“构建失败”。

---

# 第四步：给网站加一块“永久硬盘”（非常重要）

> 这一步不做，网站虽然能打开，但**只要 Railway 重启或重新部署，你的对话和 API Key 就会全部消失**。
>
> 请务必在第一次正式使用前完成这一步。

## 4.1 创建 Volume（永久硬盘）

1. 回到 Railway 的项目画布（能看到服务方块的那个页面）。
2. 在**空白处点鼠标右键**。
3. 点 **Volume** 或 **Create Volume**（不同时间界面文字可能略有不同）。
4. 如果右键没有菜单，按键盘 `Ctrl + K`，输入 `volume`，选择 **Create Volume**。
5. Railway 会问你要挂到哪个服务：
   - 选 `deepseek-lite-chat`。
6. 设置 **Mount path**（挂载路径），必须填：
   ```text
   /data
   ```
   注意：是 `/data`，不是 `data`，也不是 `/app/data`。
7. 点 **Create** / **Attach** / **Deploy** 确认。

## 4.2 确认挂载成功

1. 再点服务方块。
2. 找到 **Volumes** 或 **Volume** 区域。
3. 应该能看到一块硬盘，挂载路径是 `/data`。
4. 服务可能会自动重新启动一次，等它重新变成 **Active**。

> 这个 `/data` 里会保存：
> - 所有对话
> - 加密后的 API Key
> - 解密用的主密钥
> - 分享快照
>
> 所以：**不要删除这块 Volume，不要改挂载路径。**

---

# 第五步：生成一个公开网址

1. 点你的服务方块。
2. 点上方 **Settings**（设置）。
3. 往下找到 **Networking**（网络）。
4. 找到 **Public Networking**（公网访问）。
5. 点 **Generate Domain**（生成域名）。
6. 如果它问你端口（Port / Target Port），填：
   ```text
   3000
   ```
   通常它会自动识别，不用手填。
7. 等几秒，会出现一个网址，类似：
   ```text
   https://deepseek-lite-chat-production-abcd.up.railway.app
   ```
8. 点这个网址，或者复制到浏览器打开。

如果你看到聊天页面（中间写着“今天想聊点什么？”），说明部署成功。

---

# 第六步：填入你自己的 DeepSeek API Key

1. 打开你的 Railway 网址。
2. 点右上角的 **齿轮图标**（设置）。
3. 打开 <https://platform.deepseek.com/api_keys>。
4. 登录 DeepSeek 开放平台。
5. 点 **创建 API Key**。
6. 复制以 `sk-` 开头的那一串。
7. 回到你的网站设置页，把 Key 粘贴到 **DeepSeek API Key** 输入框。
8. 点 **保存**。
9. 看到绿色的“已保存”后，点右上角 **×** 关闭设置。

> 如果提示余额不足，去 DeepSeek 开放平台充值。
>
> 保存后输入框会变空，这是正常的：Key 已经加密存到服务器，浏览器不会保存明文。

---

# 第七步：测试聊天和网页阅读

1. 在底部输入框粘贴：
   ```text
   总结 https://example.com 的要点
   ```
2. 点右边的圆形发送按钮。
3. 等几秒，应该能看到：
   - 顶部出现“正在阅读网页…”
   - 回答逐字出现
   - 回答下方出现网页来源

如果网页读取失败，换一个公开网页（例如新闻、博客）再试。需要登录的网页、PDF、动态网页可能读不了。

---

# 第八步：测试“数据管理”

点右上角齿轮 → 拉到 **数据管理**。

## 8.1 测试导出

1. 点 **导出所有历史对话**。
2. 浏览器会下载一个 `deepseek_data-日期.zip`。
3. 下载成功就说明导出正常。
4. 把这个 ZIP 保存好，它就是备份。

## 8.2 测试导入

1. 先准备一个 DeepSeek 官网导出的 `deepseek_data-*.zip`。
2. 在设置里点 **导入历史对话**。
3. 选择 ZIP。
4. 等提示“已导入 N 个对话”。
5. 页面会自动打开导入的对话。

> 不要先把 ZIP 解压。直接选 ZIP 文件。
>
> 导入是“追加”，不会删除你已有的对话。
> 同一个 ZIP 再导一次会自动跳过，不会重复。

## 8.3 测试从分享链接导入

1. 在设置里找到 **从分享链接导入**。
2. 粘贴一个 `https://chat.deepseek.com/share/...` 开头的链接。
3. 点 **导入**。
4. 等它自动打开成新对话。

## 8.4 测试一键分享

1. 打开任意一个已经有回答的对话。
2. 点右上角的 **分享图标**（一个向上的箭头）。
3. 弹出“分享链接已生成”，点 **复制**。
4. 用手机浏览器或无痕窗口打开这个链接。
5. 应该能看到完整对话。
6. 对方点输入框发消息时，会提示填自己的 API Key；填完后会自动复制这段对话继续聊。

---

# 第九步：以后怎么更新代码

1. 打开 GitHub 上你的仓库。
2. 点 **Add file** → **Upload files**。
3. 把修改后的文件/文件夹拖进去。
4. 点 **Commit changes**。
5. Railway 会自动检测到变化，自动重新构建。
6. 等它重新变成 **Active** 即可。

> 更新代码**不会**删除 `/data` 里的对话和 Key，只要你不删 Volume。

---

# 第十步：备份和换设备

## 备份

设置 → **导出所有历史对话**，把 ZIP 存到电脑或网盘。

## 换到新设备

1. 在新设备打开同一个网址。
2. 点设置。
3. 填入自己的 API Key。
4. 点 **导入历史对话**，选择之前导出的 ZIP。

> 注意：直接在新设备打开网址是看不到旧设备的对话的，因为每个浏览器是一个独立空间。用 ZIP 导入即可。

---

# 可选：让安全等级更高一点

不做也能用，做了更稳妥。

1. 在 Railway 点服务方块。
2. 点 **Variables**（变量）。
3. 点 **New Variable**。
4. 变量名填：
   ```text
   APP_SECRET
   ```
5. 值填一串**很长、随机、自己保存好**的字符，例如 40 位以上。
6. 点 **Add** / **Save**。
7. Railway 会自动重启。

⚠️ 设置了 `APP_SECRET` 之后**永远不要改它**。改了以后，之前保存的 API Key 就无法解密，只能在设置里删掉 Key 重新填。

如果嫌麻烦，可以完全不设置，程序会自动在 `/data` 里生成主密钥。

---

# 常见问题（照着排查）

## 1. 打开网址显示 “Application failed to respond”

- 等 1～2 分钟再刷新，第一次启动可能比较慢。
- 去 Railway 的 **Deployments** 看是否还在 Building。
- 如果 Failed，点进去看日志。最常见原因是 `Dockerfile` 不在仓库最外层。
- 确认 **Settings → Networking → Public Networking** 里已经生成域名，端口是 `3000`。

## 2. 构建失败（Build failed）

检查 GitHub 仓库首页，必须**直接**看到：

```text
Dockerfile
package.json
railway.json
server
public
```

如果它们被套在一个文件夹里，Railway 会找不到 `Dockerfile`。

## 3. 能聊天，但一重新部署，对话和 Key 就没了

说明没有挂载 Volume，或者挂载路径不对。

回到第四步：

- 右键空白处 → Volume
- 选择服务
- Mount path 必须是 `/data`

如果已经丢过 Key，重新在设置里删除 Key 再保存一次。

## 4. 提示 “API Key 无效”

- 确认复制完整，没有空格。
- 去 <https://platform.deepseek.com/api_keys> 重新创建一个。
- 在设置里删除旧 Key，再保存新 Key。

## 5. 提示 “余额不足”

去 DeepSeek 开放平台充值。本应用不提供额度，也不代收费用。

## 6. 网页读取失败

- 确认链接是公开网页，不需要登录。
- 有些网站禁止抓取，或者内容在登录后、App 里、PDF 里。
- 换一个公开网页试试，例如新闻文章、博客。

## 7. 分享链接打不开 / 404

- 原对话可能被“删除全部对话”删了，分享会一起失效。
- 确认复制的是完整链接，以 `/s/` 开头。
- 确认 Railway 服务正在运行。

## 8. 清理浏览器 Cookie 后对话没了

这个应用没有账号密码，浏览器 Cookie 就是空间的钥匙。清理 Cookie 等于换了一个新空间。

以后请定期导出 ZIP 备份。已经丢的空间无法找回。

## 9. 上传 ZIP 提示“不支持的对话包版本”

请确认是 DeepSeek 官网导出的 `deepseek_data-*.zip`，不要解压，也不要用别的软件重新压缩。

## 10. 网站能不能给别人用？

可以。每个浏览器会自动拥有自己的空间，别人的 API Key 和对话不会和你混在一起。

但是：

- 任何打开你网站的人都可以用**自己的 Key** 聊天。
- 分享链接是随机长 ID，不知道链接的人打不开。
- 不要把自己的 API Key 截图发给别人。
- 这个项目没有登录密码，不适合存放高度敏感的对话。

---

# 部署完成检查清单

全部打勾才算完成：

- [ ] GitHub 仓库首页能直接看到 `Dockerfile`、`package.json`、`server`、`public`
- [ ] Railway 显示 **Active / Successful**
- [ ] 已经挂载 Volume，路径是 `/data`
- [ ] 已经生成公开域名，能打开聊天页面
- [ ] 设置里保存 API Key 后显示“已保存”
- [ ] 发送“总结 https://example.com”能收到回答和网页来源
- [ ] 设置里“导出所有历史对话”能下载 ZIP
- [ ] 分享按钮能生成 `/s/...` 链接，别人打开能看
- [ ] 重新部署一次后，对话还在

---

# 最后提醒

1. **不要删 Volume。**
2. **不要改已经设置好的 `APP_SECRET`。**
3. **只跑 1 个副本**。这个版本用文件存数据，多副本会互相覆盖。
4. 定期在设置里导出 ZIP 备份。
5. DeepSeek API 的费用从你自己的开放平台余额扣，和 Railway 账单是两回事。
