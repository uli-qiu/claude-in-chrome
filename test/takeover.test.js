// 多会话接管（last-session-wins）集成测试：
// 会话 A 持有端口且 host 已连 → 会话 B 启动（争同一端口）→ A 收 evict 转休眠
// （进程/stdio 保活，browser_status 报被接管）→ host 重连到 B → B 报 connected。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { encodeFrame } from "../lib/protocol.js";
import { startServer, connect, cleanup } from "./harness.js";

// 每个用例独占端口，避免用例间互相逐出；随机区间 18000–18999 与 e2e/multibrowser 错开，
// 否则并行跑时可能撞同一端口互相逐出
const BASE_PORT = 18000 + Math.floor(Math.random() * 1000);
let portSeq = 0;

after(cleanup);

const closed = (sock) => new Promise((res) => (sock.destroyed ? res() : sock.on("close", res)));

// 模拟 host.exe：连接、发 hello
function connectHost(port) {
  return new Promise((res, rej) => {
    const sock = connect(port);
    sock.on("connect", () => {
      sock.write(encodeFrame({ type: "hello", client: "host", version: "test", pid: 1 }));
      res(sock);
    });
    sock.on("error", rej);
  });
}

test("新会话逐出旧会话：旧会话休眠保活，host 重连到新会话", async () => {
  const port = BASE_PORT + portSeq++;
  const a = await startServer(port);

  const host1 = await connectHost(port);
  await a.waitLog("host connected");
  assert.match(await a.status(), /connected: /);

  const b = await startServer(port); // 与 A 争同一端口：等到它把 A 逐出、自己开始监听
  await a.waitLog("evicted by newer session");

  // host 侧旧连接被持有者关闭（真实 host.exe 会以 ≤3s 退避重连到新持有者）
  await closed(host1);
  const host2 = await connectHost(port);
  await b.waitLog("host connected");
  assert.match(await b.status(), /connected: /);

  // 旧会话：进程保活 + 状态可读 + 工具报被接管
  assert.equal(a.p.exitCode, null, "被逐出的会话不应退出（MCP 保活）");
  assert.match(await a.status(), /taken over by a newer Claude Code session/);
  host2.destroy();
});

test("evict 控制连接不会被持有者误当 host", async () => {
  const port = BASE_PORT + portSeq++;
  const a = await startServer(port);
  const host = await connectHost(port);
  await a.waitLog("host connected");

  // 只发 evict 的控制连接：持有者应休眠放端口，且 evict 帧记录来源 pid
  const ctrl = connect(port);
  ctrl.on("connect", () => ctrl.end(encodeFrame({ type: "evict", pid: 4242 })));
  await a.waitLog("evicted by newer session");
  // 真 host 连接被 handleEvict 主动断开（dropHost），而非被控制连接顶替
  await closed(host);
  await closed(ctrl);
  assert.match(await a.status(), /pid 4242/);
});

test("普通 TCP 连接首帧非 hello/evict 被丢弃且不影响 host", async () => {
  const port = BASE_PORT + portSeq++;
  const a = await startServer(port);
  const host = await connectHost(port);
  await a.waitLog("host connected");

  const junk = connect(port);
  junk.on("connect", () => junk.end(encodeFrame({ type: "tool_response", id: 99, ok: true })));
  await closed(junk);
  await new Promise((res) => setTimeout(res, 300));
  // 真 host 仍是当前连接
  assert.match(await a.status(), /connected: /);
  host.destroy();
});
