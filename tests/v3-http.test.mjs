import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
async function post(origin, path, data = {}) {
  const response = await fetch(origin + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
  });
  const raw = await response.text();
  if (!raw) throw new Error("接口返回空响应：" + path + " HTTP " + response.status);
  const body = JSON.parse(raw);
  assert.equal(response.status < 400, true, JSON.stringify(body));
  return body;
}
async function launch(dataDir, port) {
  let logs = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, LLM_API: "faux", DATA_DIR: dataDir, PORT: String(port), NODE_ENV: "test", DEMO_PASSWORD: "", NOTIFY_MODE: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  const origin = "http://127.0.0.1:" + port;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("服务启动失败：" + logs);
    try { const r = await fetch(origin + "/api/info"); if (r.ok) return { child, origin, getLogs: () => logs }; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill("SIGKILL");
  throw new Error("服务启动超时：" + logs);
}
async function stop(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000).unref();
  });
}
test("创建、管理、持久化和导出接口（无需 API Key）", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-v3-"));
  let app;
  try {
    app = await launch(dir, await freePort());
    const { id } = await post(app.origin, "/api/conversations");
    const prefix = "/api/conversations/" + id;
    const created = await post(app.origin, prefix + "/schedules", {
      text: "检查项目", minutesFromNow: 10, everyMinutes: 30, requestId: "test-schedule",
    });
    assert.equal(created.item.status, "active");
    const dupe = await post(app.origin, prefix + "/schedules", {
      text: "检查项目", minutesFromNow: 10, everyMinutes: 30, requestId: "test-schedule",
    });
    assert.equal(dupe.item.id, created.item.id);
    await post(app.origin, prefix + "/schedules/" + created.item.id + "/pause");
    await post(app.origin, prefix + "/schedules/" + created.item.id + "/resume");
    await post(app.origin, prefix + "/schedules/" + created.item.id + "/cancel");
    const management = await (await fetch(app.origin + prefix + "/management")).json();
    assert.equal(management.schedules.length, 1);
    assert.equal(management.schedules[0].status, "cancelled");
    const exported = await fetch(app.origin + prefix + "/export.md");
    assert.equal(exported.status, 200);
    assert.match(await exported.text(), /Pi Durable 会话/);
    await stop(app.child);
    app = await launch(dir, await freePort());
    const afterRestart = await (await fetch(app.origin + prefix + "/management")).json();
    assert.equal(afterRestart.schedules[0].id, created.item.id);
  } catch (error) {
    console.error("集成测试异常时服务输出：", app?.getLogs?.());
    throw error;
  } finally {
    if (app) await stop(app.child);
    await rm(dir, { recursive: true, force: true });
  }
});
