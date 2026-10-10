# Pi Durable Demo v3 — 交付说明与后续计划

## 已完成

本阶段保留 v1/v2 的演示能力，新增：
- 可管理的持久计划：一次性/固定分钟间隔；支持暂停、恢复和取消；保存已执行次数与下次执行时间。
- 后台子 Agent：conversation-owned background Task，子会话由后台任务持有；父对话不需等待；结果以 followUp 回传。
- 可取消原有提醒；管理抽屉支持查看任务及后台子会话。
- 可选飞书或通用 webhook 通知（默认仅失败）；会话 Markdown 导出。
- 无前端框架、无额外生产 npm 依赖；Node 单测和 HTTP 冒烟测试。

## 管理 API

| 方法 | 路径 | 功能 |
| --- | --- | --- |
| GET | /api/conversations/:id/management | 查看计划、提醒和后台子 Agent |
| POST | /api/conversations/:id/schedules | 创建计划：text, minutesFromNow, everyMinutes?, requestId? |
| POST | /api/conversations/:id/schedules/:uuid/pause | 暂停 |
| POST | /api/conversations/:id/schedules/:uuid/resume | 恢复 |
| POST | /api/conversations/:id/schedules/:uuid/cancel | 取消 |
| POST | /api/conversations/:id/background | 创建后台 Agent：text, requestId? |
| POST | /api/conversations/:id/background/:uuid/stop | 停止后台 Agent |
| POST | /api/conversations/:id/reminders/:id/cancel | 取消提醒 |
| GET | /api/conversations/:id/export.md | 导出对话 Markdown |

## 启动、部署与验收

本地：依次运行 npm ci、npm run check、npm test、LLM_API=faux npm run dev。打开 http://localhost:3000，新建会话，右下角“任务中心”里创建任务。

Docker 延用既有 compose。NODE_ENV=production 时必须设置 DEMO_PASSWORD，否则拒绝启动；生产默认禁止 /api/crash。需要录制崩溃视频才设置 ENABLE_CRASH_DEMO=1。

可选环境变量：NOTIFY_WEBHOOK_URL（默认空）、NOTIFY_WEBHOOK_KIND（generic/feishu，默认 generic）、NOTIFY_MODE（errors/all/off，默认 errors）。通用通知内容为 id/type/text/failed/at，附带 X-Pi-Event-ID 供下游去重。推送目前是尽力而为，不承诺 exactly-once；如果必须保证到达，后续需要 outbox。

计划任务重复按固定分钟间隔，不保证本地时区夏令时后的“每天同一钟点”；长时间停机跳过错过的间隔，不补发积压。取消任务会请求 Durable abort，极端情况下已经投递到 inbox 的消息无法撤销。

## v3 下一阶段清单（本 PR 未实现）

- 带时区的日历/Cron/RRULE；修改计划的具体时间和内容。
- Webhook 持久 outbox、失败重试/去重、更多通知渠道。
- 多模型配置、准确的 Token / 缓存 / 账单计费。
- 增量 SSE、长会话分页与渲染性能优化。
- 安全的外部工具和写操作审批、持久文件 Artifacts、独立产物库。
- 高并发、模拟崩溃、长时间运行等更多集成/E2E 测试。

本 PR 仅通过静态与 CI 测试才能视为可合并；不要把“README 说明”代替上线验证。

## v3 第一阶段回归审计（2026-10-10）

本轮审计在 PR #1 中修复了以下实际缺陷：

- 接口把 JSON null/数组/字符串当成对象使用，原本会产生 500；现在返回 400。
- requestId 使用普通对象存储；特殊属性名（__proto__ / constructor / prototype）可能造成错误的“重复请求”判定；现已验证并拒绝保留名称，长度超出上限直接返回 400。
- 幂等重试曾返回创建当时的状态，即使任务已经取消；现在返回当前任务状态。
- 回写 HTTP 之前先序列化 JSON，避免异常时发出 200/201 却无响应体。
- 在提醒和后台子 Agent 的最后投递阶段增加了取消状态核对。
- SSE 的活动任务范围包含后台子 Agent 子会话；任务异常终止时管理页不再长期误显示为“运行中”。
- 管理抽屉定时请求加上会话/请求序列校验，避免切换会话后显示旧会话的数据。
- 未设置访问口令时，非生产环境服务仅监听 127.0.0.1；生产环境继续强制设置 DEMO_PASSWORD。
- 外部 webhook 失败日志隐藏原始错误详情，避免 URL 中的签名或密钥被日志带出。
- 新增异常请求、生产鉴权、关闭崩溃按钮的安全回归测试。

剩余已知限制：任务提交和人工取消存在不可完全消除的竞争窗口，已经进入会话 inbox 的提醒/结果不能撤销；通知仍是尽力投递，不含 outbox 和自动重试；尚未进行真实浏览器 UI/生产 VPS 的端到端验收；长会话 SSE 与任务数量没有实施分页及资源配额。这些不属于本轮已验证的能力，不能声称“零 Bug”或“正式生产级”。
