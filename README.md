# Pi Durable 小助手

一个网页版的个人 Agent，用来把 [Pi Durable](https://earendil.com/posts/pi-durable/) 的几个核心特性做成看得见的界面：会聊天、会抓网页、会记待办和备忘、会定提醒、会派子 Agent，进程崩了还能从断开的地方接着做。

基于 `@earendil-works/pi-durable@1.1.0`。Pi Durable 还在实验阶段，API 会变，升级前先对照新版本的源码和示例。

![界面](docs/screenshot.png)

## 界面上能看到什么

| 界面上的操作 | 对应的 Pi Durable 特性 |
|---|---|
| 等待倒计时的时候点“模拟进程崩溃”，进程重启后接着倒数 | 任务检查点与崩溃恢复，`api.memo` 记下结束时间 |
| 右侧记事本，Agent 自己维护待办和备忘 | Document，和对话记录一起提交 |
| “2 分钟后提醒我……”，答完以后提醒还挂着 | 后台任务（`background: true`） |
| “派一个子 Agent 去……”，持久任务面板里显示三层 | 子 Agent（任务拥有的子会话）和归属树 |
| 用户消息旁的“从这里分叉” | Fork，记事本回到分叉点的状态 |
| 两台设备打开同一个会话；输入框左边的“插话” | 多端同步（`viewState`），steer 与 followUp |
| 运行状态里的“第几次启动” | 用来确认进程真的重启过 |

## 本地运行

需要 Node.js 22.13 以上。

```bash
npm ci
LLM_API=faux npm run dev
```

`faux` 是写死的演示剧本，不需要 API Key。浏览器打开 http://localhost:3000 。`npm run dev` 会在进程退出后自动拉起，用来演示“模拟进程崩溃”。

接真实模型时，把 `.env.example` 复制成 `.env`，填 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`，再执行：

```bash
set -a && . ./.env && set +a && npm run dev
```

`LLM_API` 支持 `openai-completions`、`openai-responses`、`anthropic-messages` 和 `faux`。

## Docker 部署

```bash
cp .env.example .env    # 填 DEMO_PASSWORD 和模型配置
docker compose up -d --build
```

容器只绑在 `127.0.0.1:3300`，`restart: unless-stopped` 负责崩溃后拉起，数据存在命名卷里。对外访问请放在反向代理后面，并且一定要设置 `DEMO_PASSWORD`。用 nginx 时要关掉缓冲，否则实时推送会攒到最后才出来：

```nginx
location / {
    proxy_pass http://127.0.0.1:3300;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

删除：`docker compose down -v --rmi local`，再删掉反向代理里的站点配置。

## 安全

- 设置 `DEMO_PASSWORD` 后全站 Basic Auth（用户名 `demo`），写操作只接受同源请求。
- `fetch_page` 只连校验过的公网 IP，防止被引去访问内网（含 DNS 重绑定），响应限 512KB、15 秒。
- Key 只从环境变量读取，错误信息输出前会抹掉 Key。
- 这是演示项目，没有多用户隔离，不要直接当生产服务用。

## 文件

- `SPEC.md`：规格说明，以及在 1.1.0 上核对过的 API 用法
- `server.mjs`：HTTP 接口和 SSE 推送
- `lib/agent.mjs`：模型接入、Document、工具、子 Agent、Harness
- `lib/net.mjs`：安全抓取网页
- `public/index.html`：前端，单文件
- `AGENTS.md`：开发时给几个 AI 编程工具的协作规则，保留作参考

## 和 README 不一样的地方

GitHub 上 Pi Durable 的 README 比 1.1.0 发布版新，照着写会踩坑：

- 工具返回结果用 `content` 字段，不是 `output`。
- 没有 `harness.closed`，用 `onReport`。
- 用 faux 模型模拟工具调用时，那条回复要带 `stopReason: "toolUse"`，否则会被当成最终回答。

## 许可

MIT
