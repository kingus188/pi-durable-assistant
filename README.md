# Pi Durable Demo

一个网页版个人 Agent，演示 [Pi Durable](https://earendil.com/posts/pi-durable/) 的五个概念：持久化存储、断点恢复、Document、Fork、多端同步。长文配套 Demo，基于 `@earendil-works/pi-durable@1.1.0`（实验版，API 可能变）。

| 页面上看到的 | 对应概念 |
|---|---|
| 会话列表刷新、重启都还在 | 存储（SQLite） |
| 等待中点“模拟崩溃”，进程重启后接着倒数 | 检查点与恢复 |
| 右侧记事本，Agent 自己维护待办和备忘 | Document |
| 用户消息旁的“从这里分叉” | Fork |
| 两台设备打开同一个 `#会话ID` | 多端同步 |

## 本地运行

```bash
npm ci
LLM_API=faux npm run dev     # 不需要 Key，用固定剧本演示；浏览器打开 http://localhost:3000
```

`scripts/dev.sh` 会在进程退出后自动拉起，用来演示“模拟崩溃”。

## 服务器部署

```bash
git clone <本仓库> /opt/pi-durable-demo && cd /opt/pi-durable-demo
cp .env.example .env           # 填 DEMO_PASSWORD、LLM_API_KEY、LLM_MODEL
docker compose up -d --build
```

容器加入 sub2api 所在的 Docker 网络，用 `http://sub2api:8080/v1` 调模型；端口只绑 `127.0.0.1:3300`。对外由同网络的 nginx 反代到 `http://pi-durable-demo:3000`，SSE 需要关闭缓冲：

```nginx
location / {
    proxy_pass http://pi-durable-demo:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

## 删除

```bash
cd /opt/pi-durable-demo && docker compose down -v --rmi local && cd / && rm -rf /opt/pi-durable-demo
```

再删掉 nginx 里对应的站点配置并重载。

## 安全

- 设置 `DEMO_PASSWORD` 后全站 Basic Auth（用户名 `demo`）；写操作只接受同源请求。
- `fetch_page` 只连校验过的公网 IP（防 DNS 重绑定），限制 512KB、15 秒。
- Key 只从环境变量读取，错误信息输出前会抹掉 Key。

## 文件

- `SPEC.md`：规格与已核对的 API 用法
- `server.mjs`：HTTP、SSE
- `lib/agent.mjs`：模型接入、Documents、工具、Harness
- `lib/net.mjs`：安全抓取网页
- `public/index.html`：前端
