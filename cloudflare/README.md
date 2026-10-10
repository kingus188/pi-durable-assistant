# Pi Durable Edge

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xiaomoBoy/pi-durable-assistant/tree/main/cloudflare)

**[中文一键部署教程（零命令行）→](docs/DEPLOY.md)** · [Cloudflare 官方部署按钮说明](https://developers.cloudflare.com/workers/platform/deploy-buttons/)

> 原项目：[xiaomoBoy/pi-durable-assistant](https://github.com/xiaomoBoy/pi-durable-assistant)。Pi Durable Edge 是原项目的 Cloudflare Workers 版本，不影响原项目的 Docker / VPS 部署。**当前处于 v0.1 初始开发阶段，计划持续迭代；尚未在真实 Cloudflare 账户验证运行，Beta 兼容性以部署日志为准。**

## 当前版本范围和原理

- **真实 Pi Durable 1.1.0 + Cloudflare PiHarness**：从原项目移植 `faux` 剧本和 `wait_seconds` 记忆截止时间的策略。每条消息创建 Durable operation，Pi 的 transcript、任务及检查点存在 SQLite-backed Durable Object 中。
- **模拟回复（零模型费用）**：`faux` 不是通用 AI，所有输入都执行 12 秒等待，最后输出固定中文提示。不接外部 API，也不需要 Workers AI。
- **持久定时提醒**：使用 Agents SDK `schedule()` 和 SQLite `edge_reminders` 表，实例未活跃时由 Alarms 唤醒。只在网页显示提醒是否触发，**不发送手机推送**。
- **隔离**：当前初始版本为单用户、单 Durable Object；多会话、微信桥、Subagent、生产模型、上传附件及多租户暂未实现。

## 一键部署

1. 登录 Cloudflare Free 账户，点击顶部 **Deploy to Cloudflare**。
2. Cloudflare 从公开 GitHub 仓库的 `cloudflare/` 子目录克隆此应用，并自动创建 Worker + SQLite-backed Durable Object。确认 Worker 名 `pi-durable-edge`。
3. **唯一必须配置的应用 Secret：`ACCESS_TOKEN`**。请输入自己生成的至少 24 字符随机访问令牌（建议 `openssl rand -hex 24` 或使用密码管理器）；不要复用仓库中的示例值。密钥仅保存在自己的 Cloudflare 账户，**不得提交到公开仓库**。如部署页没有 Secret 输入框，部署后进入 Worker **Settings → Variables and Secrets** 添加同名 Secret，保存并重新部署。
4. 打开分配的 `*.workers.dev` URL，输入同一个 Token 并连接。
5. 点击网页中的 **“一键功能自检”**：自动验证固定模拟回复、同操作 ID 幂等提交、SQLite 状态与 5 秒提醒到期。请注意自检不能代替真实崩溃恢复测试。

> 免费限制：Workers Free 支持 SQLite-backed Durable Objects，但会受 CPU、持续运行时间、数据库读写等日限额约束。**不保证免费计划能在所有账户和运行负载下跑通完整 PiHarness。** 超额通常报错而非自动扣费。不要误把页面刷新当成真实的 Worker 崩溃测试。

## 本地验证

```sh
cd cloudflare
npm install
cp .dev.vars.example .dev.vars
# 把 ACCESS_TOKEN 改成至少 24 字符（切勿提交到仓库）
npm run check
npm run dev
# 浏览器打开 Wrangler 输出的本地地址
```

一键部署遇到问题时，参考 [完整教程](docs/DEPLOY.md) 中的 Wrangler 备用命令；不需要另外手动创建 Durable Object。

## 验收方法

1. **对话**：`POST /api/chat` 立即返回 `operationId`；前端会轮询 `/api/state`，最终显示模拟答复。
2. **数据持久化**：关闭浏览器并重新打开，使用同一个 Token 查看记录与提醒状态。Pi 会话在 Durable Object SQLite 中，数据不会因为浏览器关闭而清除。
3. **中断恢复**：在 12 秒任务进行期间重新部署 Worker、或强制中断本地 Wrangler Dev 再启动，检查最终答复只出现一次。复用原项目 `api.memo('deadline', ...)` 思路以保留原截止时间。**浏览器刷新只能验证前端重连，不能证明进程崩溃恢复。** 实际生产环境应额外验证重复副作用和升级兼容性。
4. **定时唤醒**：创建 10 秒提醒，关闭网页，超过 10 秒后重新打开，核对 SQLite 中的 `fired` 状态。

## API（必须发送 `Authorization: Bearer <ACCESS_TOKEN>`）

- `GET /api/state`：对话、未完成任务、提醒状态。
- `POST /api/chat`：`{ "text": "测试恢复", "operationId": "客户端唯一随机ID" }`；同 ID 重试幂等。
- `POST /api/reminders`：`{ "text": "站起来", "seconds": 10 }`。

## 费用与安全

- 不调用任何真实 AI 模型：模型费 **$0**；不用 Containers、不需要 Workers Paid。
- 平台预计在低频测试的免费额度内，但 **真实远程部署尚未验收**；参考 [Durable Objects 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/) 与 [PiHarness 文档](https://developers.cloudflare.com/agents/harnesses/pi/)。
- Worker 默认公开静态页面，API 必须使用 Cloudflare 侧 `ACCESS_TOKEN` Secret。建议另外设置 Cloudflare Access；当前版本不适合存储机密内容，也没有账号系统和细粒度限流。
- API 返回和状态不会暴露 Token。浏览器令牌仅存储于当前标签页的 `sessionStorage`，不作为 URL 参数。
- 当前版本定时提醒由 Agents Scheduler 的持久化存储执行，聊天恢复由 PiHarness 执行。**两者不是同一张任务表；提醒只保存 fired 状态，不会提交给 Pi 对话。**

## 后续方向

后续可逐步增加真实模型、多会话、子 Agent、持久通知和微信桥接，不牺牲现有 Pi Durable 的恢复语义；所有功能以实际合并、测试通过的版本为准。

## 兼容性与版本

从原项目 `main`（Node.js 22、Pi Durable 1.1.0）抽取最小功能。锁定 `agents@0.28.0`、`@earendil-works/pi-durable@1.1.0` 和 `@earendil-works/pi-ai@1.1.0`。PiHarness 仍在 Beta 阶段，未来升级应先在测试环境验证。

尚未实施完整的 npm 依赖安装和 Cloudflare 真正部署测试；已进行 Node 语法检查。若部署失败，先查看 Worker build logs，不应宣称已完成线上验收。
