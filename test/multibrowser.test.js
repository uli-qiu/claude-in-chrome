// 多浏览器并存测试：两个浏览器（不同 deviceId）同时连到 TCP 桥
// - browser_status 列出两个；未选择时工具报错列出清单（绝不猜）
// - browser_select 按 label / id 前缀选定后，工具路由到对应浏览器
// - 选定浏览器断开后报"no connected browser matches"
// - 旧扩展（无 deviceId）：后连顶替先连（last-wins 单槽）
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, FrameDecoder } from "../lib/protocol.js";
import { startServer, connect, cleanup, sleep } from "./harness.js";

const PORT = 19500 + Math.floor(Math.random() * 400);

after(cleanup);

// 模拟一个浏览器：host.exe hello + 扩展 hello（带 deviceId/label），按 marker 答工具
function connectBrowser(deviceId, label, marker) {
  return new Promise((resolve) => {
    const sock = connect(PORT);
    sock.on("connect", () => {
      sock.write(encodeFrame({ type: "hello", client: "host", version: "test", pid: 1 }));
      sock.write(
        encodeFrame({ type: "hello", client: "extension", deviceId, label, version: "test" })
      );
    });
    const dec = new FrameDecoder();
    sock.on("data", (chunk) => {
      for (const f of dec.feed(chunk)) {
        if (f.type === "tool_request") {
          sock.write(
            encodeFrame({ type: "tool_response", id: f.id, ok: true, result: { marker, tool: f.tool } })
          );
        } else if (f.type === "ping") {
          sock.write(encodeFrame({ type: "pong", ts: f.ts }));
        }
      }
    });
    setTimeout(() => resolve(sock), 300);
  });
}

const text = (resp) => resp.result.content[0].text;

test("两个浏览器并存：列出 → 拒猜 → browser_select 路由 → 断开回退", async () => {
  const srv = startServer(PORT);
  await sleep(700);
  const browserA = await connectBrowser("aaaa1111-0000-0000-0000-000000000001", "work-chrome", "BROWSER-A");
  await connectBrowser("bbbb2222-0000-0000-0000-000000000002", "work-edge", "BROWSER-B");

  // 1. status 列出两个浏览器
  const statusText = await srv.status();
  assert.match(statusText, /2 browsers connected/);
  assert.match(statusText, /work-chrome/);
  assert.match(statusText, /work-edge/);

  // 2. 未选择时工具报错并列出清单（绝不猜）
  const refused = await srv.call("browser_tabs_list");
  assert.equal(refused.result.isError, true);
  assert.match(text(refused), /2 browsers are connected/);
  assert.match(text(refused), /browser_select/);

  // 3. browser_select 无参 = 列出
  const list = text(await srv.call("browser_select"));
  assert.match(list, /work-chrome/);
  assert.match(list, /work-edge/);

  // 4. 按 label 选定 → 工具路由到 B
  const sel = await srv.call("browser_select", { browser: "work-edge" });
  assert.match(text(sel), /selected: .*work-edge/);
  assert.match(text(sel), /work-edge\) ← selected/);
  assert.match(await srv.status(), /work-edge\) ← selected/);
  assert.match(text(await srv.call("browser_tabs_list")), /BROWSER-B/);

  // 5. 按 id 前缀切换 → 路由到 A；"← selected" 标记跟着换到 A，B 不再标
  const selA = text(await srv.call("browser_select", { browser: "aaaa1111" }));
  assert.match(selA, /work-chrome\) ← selected/);
  assert.doesNotMatch(selA, /work-edge\) ← selected/);
  assert.match(text(await srv.call("browser_tabs_list")), /BROWSER-A/);

  // 6. 歧义 label 前缀报错
  const amb = await srv.call("browser_select", { browser: "work" });
  assert.equal(amb.result.isError, true);
  assert.match(text(amb), /matches 2 browsers/);

  // 7. 选定的浏览器断开 → 明确报错（不悄悄切到另一个）
  browserA.destroy();
  await sleep(400);
  const gone = await srv.call("browser_tabs_list");
  assert.equal(gone.result.isError, true);
  assert.match(text(gone), /no connected browser matches/);

  // 8. status 仍显示在连的那个
  assert.match(await srv.status(), /connected: /);
});

test("同 deviceId 重连：旧连接被顶替，不产生重复条目", async () => {
  const srv = startServer(PORT);
  await sleep(700);
  await connectBrowser("cccc3333-0000-0000-0000-000000000003", "Chrome", "OLD");
  await connectBrowser("cccc3333-0000-0000-0000-000000000003", "Chrome", "NEW");
  // 单条：不走 "2 browsers" 分支
  assert.doesNotMatch(await srv.status(), /2 browsers/);
  assert.match(text(await srv.call("browser_tabs_list")), /NEW/); // 路由到新连接
});

test("旧扩展无 deviceId：后连顶替先连（last-wins）", async () => {
  const srv = startServer(PORT);
  await sleep(700);
  // 只发 host.exe hello，不带扩展 hello（旧版扩展行为）。
  // server 对无 deviceId 的连接有 2s 宽限（等扩展 hello），到期才 last-wins 收敛。
  const legacy = connect(PORT);
  legacy.on("connect", () => {
    legacy.write(encodeFrame({ type: "hello", client: "host", version: "old", pid: 1 }));
  });
  await sleep(300);
  const newer = connect(PORT);
  newer.on("connect", () => {
    newer.write(encodeFrame({ type: "hello", client: "host", version: "old", pid: 2 }));
  });
  await sleep(2500);
  const statusText = await srv.status();
  assert.match(statusText, /connected: /);
  assert.match(statusText, /pid":2/); // 只剩后连的
  assert.equal(legacy.destroyed, true);
});

// 回归：两个浏览器的 host.exe 先后连上（首帧 host hello 都不带 deviceId），
// 扩展 hello 稍后才到。旧实现把"无 deviceId"当旧扩展立即互踢，两个 host
// 在彼此扩展 hello 到达前无限循环顶替，server 永远看不到 deviceId。
test("双 host 先连、扩展 hello 迟到：不互踢，均以 deviceId 注册", async () => {
  const srv = startServer(PORT);
  await sleep(700);
  const late = [];
  for (const [pid, deviceId, label] of [
    [101, "dddd4444-0000-0000-0000-000000000004", "late-chrome"],
    [102, "eeee5555-0000-0000-0000-000000000005", "late-edge"],
  ]) {
    const sock = connect(PORT);
    sock.on("connect", () => {
      sock.write(encodeFrame({ type: "hello", client: "host", version: "test", pid }));
    });
    const dec = new FrameDecoder();
    sock.on("data", (chunk) => {
      for (const f of dec.feed(chunk)) {
        if (f.type === "ping") sock.write(encodeFrame({ type: "pong", ts: f.ts }));
      }
    });
    late.push({ sock, pid, deviceId, label });
  }
  await sleep(600); // 两个 host hello 都已到达，扩展 hello 还没发
  for (const b of late) assert.equal(b.sock.destroyed, false); // 宽限期内不许互踢
  // 宽限期内的两条连接都还没有 deviceId：谁都不是"已选中"，清单不许出现 selected 标记
  assert.doesNotMatch(await srv.status(), /← selected/);
  for (const b of late) {
    b.sock.write(
      encodeFrame({ type: "hello", client: "extension", deviceId: b.deviceId, label: b.label, version: "test" })
    );
  }
  await sleep(400);
  const statusText = await srv.status();
  assert.match(statusText, /2 browsers connected/);
  assert.match(statusText, /late-chrome/);
  assert.match(statusText, /late-edge/);
  for (const b of late) assert.equal(b.sock.destroyed, false); // 都活着
});
