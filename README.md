# dsh-remote-gateway

**用手机/飞书远程指挥你电脑上的 [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) 干活。**

English: A self-hosted gateway that exposes your local DSH web UI to your phone over the internet, plus a Feishu (Lark) bot to drive DSH tasks from chat. No public callback URL needed.

```
手机/外网 ──▶ 公网入口:17888 (frps) ──frp隧道──▶ 本机 frpc ──▶ 127.0.0.1:8765 (本网关,密码) ──▶ 127.0.0.1:3080 (dsh web)
飞书 App ──────长连接(无需公网回调地址)──────────────▶ 本网关 feishu.js ──▶ dsh headless / dsh web 会话
```

两个能力，互相独立：

- **网页网关（server.js）**：给本机 DSH web 套一层密码反代。配合 frp 等隧道，手机浏览器就能用完整 DSH GUI（含 WebSocket 实时通道）。
- **飞书控制（feishu.js）**：飞书长连接机器人，发消息即下任务，跑完自动回结果。`/new` 开新会话、`/sessions` 接续历史会话，有预设的会话自动改走网页端执行。

## 功能

- 密码反代：scrypt 存储 + HMAC 签名 cookie（默认 30 天）+ 每 IP 每分钟 8 次登录限速
- WebSocket `upgrade` 透传：上游 cookie 由网关自签（读 `~/.dsh/.credentials.yaml`），浏览器无感
- 飞书命令：`/new` `/sessions` `/use` `/history` `/stop` `/status` `/reset` `/help`，纯文本=续聊，卡片交互（菜单/历史/选会话/新增会话）
- **默认拒绝 + 配对码绑定**：白名单外的飞书会话一律忽略，首次使用发 `/start 配对码` 完成绑定
- 任务超时强杀（`maxTaskMinutes`，默认 20 分钟）；飞书事件去重；任务切片回复（超长文本自动分段）

## 快速开始

前置要求：

- Node.js ≥ 20
- 本机已安装 DSH 并能跑 `dsh`（`dsh --profile web` 的默认端口 3080）
- macOS 用户可用 launchd 常驻；其他平台 `node server.js` + systemd/supervisor 同理
- （可选，公网访问才需要）frp 或其他隧道

### 1. 安装

```bash
git clone https://github.com/<you>/dsh-remote-gateway.git
cd dsh-remote-gateway
npm install
```

### 2. 生成配置

```bash
node setup.js 你的访问密码
```

生成 `config.json`（权限 0600，含随机 sessionSecret 和 scrypt 密码哈希）。然后编辑：

| 字段 | 说明 |
|---|---|
| `workdir` | headless 任务的工作目录 |
| `feishu.appId` / `feishu.appSecret` | 下面第 3 步创建的飞书应用凭证（不填则飞书功能不启动，网页网关不受影响） |
| `upstream` | dsh web 地址，默认 `http://127.0.0.1:3080` |
| `maxTaskMinutes` | 单任务超时分钟数 |

### 3. 创建飞书应用（约 5 分钟）

1. 打开 [飞书开放平台](https://open.feishu.cn) → 开发者后台 → **创建企业自建应用**
2. 应用里点 **添加应用能力 → 机器人**
3. **权限管理** 开通：`im:message`（读取与发送消息）、`im:message:send_as_bot`
4. **事件与回调** → 订阅方式选 **使用长连接接收事件**（免公网回调地址）→ 添加事件 `im.message.receive_v1`；**回调配置**里同样选长连接，再添加 `card.action.trigger`（卡片按钮回传，缺了它按钮点了没反应）
5. **版本管理与发布** → 创建版本并发布（企业管理员通过）；「可用范围」里要有会跟机器人说话的人
6. 把 **App ID / App Secret** 填进 `config.json` 的 `feishu` 字段，或者用辅助脚本一步写入并校验凭证/权限/机器人状态：

   ```bash
   FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx node setup-feishu-bot.js
   ```

> 权限变更后**必须发布新版本**才会生效；排查事件收不到时，先看开发者后台「事件与回调 → 事件日志」有没有投递记录。

### 4. 启动并绑定

```bash
node server.js
```

在飞书里搜到你的机器人，发送：

```
/start 配对码
```

配对码在网关目录的 `pairing-code.txt`（首次启动自动生成，权限 0600）。绑定成功后该码自动删除，你的会话被写进 `config.json` 的 `feishu.allowedChatIds`，之后直接发任务即可。**任何其他会话的消息都会被静默忽略。**

### 5.（可选）常驻与公网

macOS launchd 常驻：

```bash
# 编辑 examples/local.dsh.remote.gateway.plist 里的路径后：
cp examples/local.dsh.remote.gateway.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/local.dsh.remote.gateway.plist
launchctl list | grep dsh.remote          # 状态
launchctl kickstart -k gui/501/local.dsh.remote.gateway   # 重启
tail -f gateway.log                        # 日志
```

公网访问：用 frp 把本机 `8765` 映射到公网端口（示例见架构图），手机浏览器打开 `http://公网IP:端口` 输密码即用。改密码：

```bash
node change-password.js 新密码
```

## 飞书命令

| 发送 | 作用 |
|---|---|
| `/start 配对码` | 首次绑定（仅白名单外会话需要） |
| `/new 任务内容` | 开全新会话执行任务 |
| `/new` 或「新增会话」 | 先选文件夹，下一条消息作为任务开新会话 |
| 直接发文本 | 当前会话续聊（自动续上下文） |
| `/sessions` `/sessions 关键词` | 列历史会话（卡片翻页/筛选），`/use 编号` 接续 |
| `/history` | 看当前会话的对话记录 |
| `/status` | 是否在跑、当前会话、上次任务 |
| `/stop` | 强停当前任务 |
| `/reset` | 解绑会话，下条消息开新会话 |
| `/help` | 帮助 |

## 自定义 headless 模型

默认 `dsh --profile headless` 用 DSH 的默认 provider。想走自己的 OpenAI 兼容接口：

```bash
cp headless-patch.example.yml headless-patch.yml
# 编辑 provider/baseURL/模型名，export 对应的 API key 环境变量后重启
```

## 安全模型（务必读）

- **绑定 = 交出控制权**：飞书机器人能在你机器上执行任意 DSH 任务（跑命令、改文件）。只绑定你自己的飞书账号；`allowedChatIds` 保持最小。
- **默认拒绝**：白名单外消息静默忽略，不回复、不泄露任何信息。配对码只存在网关本机，用完即删。
- **公网是 HTTP 明文**：网关本身没有 TLS。若走公网，建议套 HTTPS（自签或反代），或至少意识到密码会明文过网。
- **只绑本机**：网关默认监听 `127.0.0.1`，外网只能通过你主动建的隧道进来，不会局域网裸奔。
- **单用户设计**：全局一个任务槽、一个会话绑定。多人共用会互相抢任务——请每个使用者部署自己的实例。
- **config.json 永远不要提交或外发**：里面有密码哈希、sessionSecret 和飞书凭证（本仓库已 gitignore）。

## 排错

| 症状 | 处理 |
|---|---|
| 飞书收不到任何事件 | 开发者后台「事件日志」看投递记录；确认权限已进**已发布**版本；长连接进程是否唯一 |
| 手机打开 401 | 上游 browser-session secret 轮换了，重启网关 |
| 任务没回复 | 看 `gateway.log`；超过 `maxTaskMinutes` 会被强杀 |
| 配对码丢了 | 删掉 `pairing-code.txt` 重启网关会重新生成 |

## License

[MIT](LICENSE)
