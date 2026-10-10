# Pi Durable Edge：Cloudflare 一键部署与验收

> 当前版本：v0.1，基于 Pi Durable 1.1.0 + Cloudflare Agents SDK 0.28.0（PiHarness Beta）。  
> 只需要 Cloudflare Free 账户和 GitHub 登录。**无需 VPS、Docker、数据库账号或模型 API Key。**  
> 这是可持续开发的最小版本；暂未在真实 Cloudflare 账户完成端到端部署验收。

## 1. 一键部署（推荐，无需命令行）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xiaomoBoy/pi-durable-assistant/tree/main/cloudflare)

1. 点击上面的 **Deploy to Cloudflare**，登录自己的 Cloudflare 账户。如被要求，授权 Cloudflare 访问 GitHub（它需要在你自己的 GitHub 账户创建新仓库，以便后续自动构建）。
2. 在部署页面选择 **Workers Free** 套餐，确认 Worker 名为 `pi-durable-edge`，保持默认构建配置。此入口指向原仓库 `cloudflare/` 子目录；Cloudflare 会把它当成单独项目的根目录复制出去。
3. 填写 **`ACCESS_TOKEN`**：至少 24 位，建议使用密码管理器生成 **48 位以上的随机字符**，或者在自己电脑终端运行 `openssl rand -hex 24`。把值保存到自己的密码管理器；**不要填写 GitHub Token、Cloudflare API Token，不要把它提交进代码或公开发在聊天里**。
4. 点击 **Deploy**（具体按钮文案以页面为准）。Cloudflare 根据 `wrangler.jsonc` 自动创建 Worker，以及 **SQLite-backed Durable Object `Assistant`**。不需要手动建 D1 数据库、R2 Bucket、KV 或 Containers。
5. 部署成功后打开页面给出的 `https://pi-durable-edge.<account-subdomain>.workers.dev` 链接；实际域名请以部署页面为准。将刚才设置的同一个 `ACCESS_TOKEN` 输入网页，点击“连接”。

部署入口参考：[Cloudflare 官方 Deploy button 说明](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。

> **Secret 输入框没出现怎么办？** Cloudflare 官方支持通过 `.dev.vars.example` 提示需要配置的 Secret。如果你的部署界面没有出现该字段，先完成部署，再进入 **Workers & Pages → pi-durable-edge → Settings → Variables and Secrets**，新增名为 `ACCESS_TOKEN` 的 **Secret**（不是公开 Variable），粘贴你的随机值并保存/部署。未配置时 API 会返回 503，这是预期的安全保护。

## 2. 一键功能自检

打开部署地址，填入 `ACCESS_TOKEN` 并点击“连接”，随后点击 **一键功能自检**。

自检会自动进行：

- 用唯一 `operationId` 提交一条 `faux` 模拟对话；再次提交同一个 ID，核验不重复创建。
- 新建 5 秒提醒，让 Cloudflare Agents Scheduler 通过 Durable Object Alarm 触发。
- 轮询已持久化的状态（最长 60 秒），确认对应模拟回复已存档、提醒状态为 `fired`。

页面出现“基本自检通过”说明 **HTTP API、PiHarness 模拟执行、SQLite 读写与提醒调度** 在当前环境基本可用。

**注意：这不是完整的崩溃恢复验收。** 刷新浏览器、关闭标签页、自检通过均不等于 Durable Object 被驱逐或 Worker 崩溃。要验证真实断点恢复，请在任务执行时部署一个兼容的新版本，再核对任务是否从检查点恢复、是否出现重复副作用；不要为测试破坏性重启生产服务。

## 3. 运行限制与费用

- `faux` 是固定脚本，不调用任何真实 AI 模型，模型 API 费用为 0。
- 使用 Workers + SQLite-backed Durable Objects，**不需要 Containers 付费套餐**。低频测试有机会使用 Workers Free 的免费额度；不能保证所有账户、所有 SDK 版本都能在免费限制内运行。
- 请求、CPU、SQL、存储和运行时长均有配额。PiHarness Beta 的长任务调度与 Worker 免费 CPU 限制可能导致任务失败；遇到失败应先看日志，不要直接升级付费套餐。
- 这不是全功能版：暂不包含真实 LLM、多会话、微信桥、Subagent、附件和推送通知。

定价：[Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/) · [Workers](https://developers.cloudflare.com/workers/platform/pricing/)；限制：[Workers](https://developers.cloudflare.com/workers/platform/limits/)。

## 4. 故障排查

| 现象 | 最可能原因 | 检查方式 |
| --- | --- | --- |
| 网页能打开，API 返回 503 | `ACCESS_TOKEN` 未配置或太短 | Workers → Settings → Variables and Secrets，添加 24 字符以上 Secret |
| API 返回 401 | 网页输入与部署 Secret 不一致 | 检查首尾空格、重新输入，不要将值写进 URL |
| 404 | Worker 路由/静态资源未正确部署 | 检查 Workers Builds 日志，以及 `wrangler.jsonc` 中的 `assets` |
| 500 | PiHarness、SQLite、迁移或调度运行出错 | Workers → Observability → Logs 查看服务端错误；不要在 Issue 里贴 Secret |
| 构建失败 | 依赖/Node 版本/Cloudflare Beta 接口不兼容 | 查看 Build logs，确认 Node ≥22、子目录独立安装依赖、CI 版本 |
| 任务一直 pending | 模拟工具、定时 Alarm 或免费额度限制 | 运行网页自检，检查 Workers 日志与 Dashboard 用量 |
| 部署按钮提示无法导入 | GitHub 授权或子目录导入失败 | 查看 GitHub 授权，或按下面的 Wrangler 备用方案部署 |

### Cloudflare 提示 GitHub 授权过期（Your GitHub authorization has expired）

这说明 **Cloudflare GitHub App 的授权失效**，不是 Pi Durable Edge 的源码编译错误；修改 `ACCESS_TOKEN` 或反复 Retry Build 都不会解决授权问题。

1. 打开 [GitHub → Settings → Applications → Installed GitHub Apps](https://github.com/settings/installations)，找到 **Cloudflare Workers and Pages**，点击 **Configure**。
2. 官方建议在 App 设置页面底部点击 **Uninstall**，卸载旧安装。
3. 回到 [Cloudflare Workers & Pages](https://dash.cloudflare.com/) → **Create application → Pages → Connect to Git → Add account → Install & Authorize**，重新连接当前 GitHub 账户。如果是组织仓库，应由组织有权限的管理员安装。
4. 再点击 README 顶部 **Deploy to Cloudflare**，重新开始导入。不需要修改代码，也不需要为此升级付费套餐。

**影响范围：** 卸载会暂时阻断这个 GitHub 账户此前连接的其他 Cloudflare Workers/Pages 项目的自动构建；线上已有部署仍继续运行。重新安装后，请检查其他项目的 Git 集成是否恢复。若暂时不希望卸载，可以先尝试 Cloudflare Workers & Pages → 项目 → Settings → Builds → Git Repository → Manage，检查现有安装授权状态。

官方文档：[Cloudflare Workers GitHub integration — Reinstall the Cloudflare GitHub App](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/#reinstall-the-cloudflare-github-app)。

### Cloudflare 显示“构建已过期 / Build expired”

该提示**不等同于源代码编译失败**。需要先区分部署是否已建立：

1. 登录 [Cloudflare Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)，检查是否已有 `pi-durable-edge`。
2. **已经有 Worker：**进入项目 → **Deployments（部署）** → **View Build History（查看构建历史）** → 找到对应构建 → 点击 **Retry build（重试构建）**。尽量保留原项目，避免重新从一键部署按钮重复创建。
3. **尚未创建 Worker：**关闭已经过期的一键部署页面，用 README 里的 Deploy to Cloudflare 按钮重新开启一次全新的导入流程；选择 Worker 名 `pi-durable-edge`。
4. 如果重试后显示 `Build was timed out`，Cloudflare Workers Builds 的单次构建上限为 **20 分钟**。进入构建详情查看发生超时的实际阶段，而不是修改 Token 或盲目重试。
5. 如果出现具体编译失败信息，请复制 **Build Details** 中最后一段错误日志（去掉账户 ID、密钥等敏感信息）；GitHub Actions 的 `wrangler deploy --dry-run` 成功，不能代替 Cloudflare 账户的真实部署验证。

参考：[Cloudflare 官方 Workers Builds 故障排查](https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/)。

### 备用：Wrangler 手动部署（只在按钮失败时使用）

在装有 Node.js 22+ 的电脑上运行：

```bash
git clone https://github.com/xiaomoBoy/pi-durable-assistant.git
cd pi-durable-assistant/cloudflare
npm install
npm run check
npx wrangler login
npm run deploy
npx wrangler secret put ACCESS_TOKEN
```

最后一条命令会提示交互输入密钥，请在本地输入刚生成的随机值。使用 Workers Free，不必填写任何模型 Key。打开 Wrangler 显示的 `workers.dev` 地址测试。

本地开发（不调用 Cloudflare 账户）：

```bash
cp .dev.vars.example .dev.vars
# 修改 .dev.vars 中 ACCESS_TOKEN 为自己的随机字符串
npm run dev
```

`.dev.vars` 被 Git 忽略，不能提交到公开仓库。

## 5. 维护与升级

一键部署会将 `cloudflare/` 子目录复制成你 GitHub 账户中的**新仓库**，并为这个部署副本设置 Workers Builds。修改部署副本的生产分支，Cloudflare 可自动重建部署；**原项目 upstream 新提交不会自动同步到你的副本**，需要你主动合并更新。

项目源码：[Pi Durable Edge](https://github.com/xiaomoBoy/pi-durable-assistant/tree/main/cloudflare) · [官方 PiHarness 文档](https://developers.cloudflare.com/agents/harnesses/pi/)。

部署后若出现错误，请记录不含 Token 的构建日志或运行时错误，便于复现。