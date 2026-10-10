# 协作规则（给参与本仓库的所有 Agent / CLI）

- 需求只以 `SPEC.md` 为准；不清楚的地方按 SPEC 的“简单、可读”原则取最简单的做法，并在交付说明里写明。
- API 以 `node_modules/@earendil-works/*/dist/**/*.d.ts` 和 `node_modules/@earendil-works/pi-durable/README.md` 为准，不凭记忆编 API。
- 只改派给你的文件，不改 `SPEC.md`、`AGENTS.md`、`package.json`，不新增依赖。
- 不读取、不打印任何 `.env` 和密钥；不访问远程服务器；不执行 git commit / push（由编排者统一提交）。
- 写完自己跑 `node --check` 和能跑的本地验证，交付时列出：改了哪些文件、怎么验证的、哪些没验证。
