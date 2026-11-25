// 端到端集成测试：拉起 server/index.js，模拟 host.exe 反向连接，
// 走完整 MCP stdio 协议（initialize → tools/list → browser_status → tools/call）。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, FrameDecoder } from "../lib/protocol.js";
import { startServer, connect, cleanup, sleep } from "./harness.js";

const PORT = 19000 + Math.floor(Math.random() * 500);

after(cleanup);

test("MCP stdio ↔ TCP ↔ host 全链路", async () => {
  const srv = startServer(PORT);
  await sleep(700);

  const init = await srv.rpc("initialize", {});
  assert.equal(init.result.serverInfo.name, "claude-in-chrome");

  const tools = await srv.rpc("tools/list", {});
  assert.equal(tools.result.tools.length, 23);

  const before = await srv.call("browser_status");
  assert.match(before.result.content[0].text, /^not connected/);

  // 模拟 host.exe：server 已就绪后再连接，tool_request 应答假数据
  const toolAnswers = {
    tabs_list: [{ tabId: 1, title: "Fake Tab", url: "https://example.com/", active: true }],
  };
  const fakeHost = connect(PORT);
  const dec = new FrameDecoder();
  fakeHost.on("data", (chunk) => {
    for (const f of dec.feed(chunk)) {
      if (f.type === "tool_request") {
        const answer = toolAnswers[f.tool];
        fakeHost.write(encodeFrame({ type: "tool_response", id: f.id, ok: !!answer, ...(answer ? { result: answer } : { error: `no fake answer for ${f.tool}` }) }));
      } else if (f.type === "ping") {
        fakeHost.write(encodeFrame({ type: "pong", ts: f.ts }));
      }
    }
  });
  fakeHost.write(encodeFrame({ type: "hello", client: "host", version: "0.3.0-e2e" }));
  await sleep(400);
  assert.match(await srv.status(), /connected: /);

  const tabs = await srv.call("browser_tabs_list");
  assert.match(tabs.result.content[0].text, /Fake Tab/);

  const bad = await srv.call("browser_no_such");
  assert.ok(bad.error || bad.result?.isError, "未知工具应报错");

  fakeHost.destroy();
  await sleep(400);
  assert.match(await srv.status(), /^not connected/);
});

// 回归：stdin 上一行 "null" 曾让 handleRpc 抛进 catch 后再次解引用崩溃（未处理的 rejection）；
// 通知（无 id）曾被动回一条没有 id 的错误应答，违反 JSON-RPC。
test("stdio 容错：非对象/缺 method 的请求报 Invalid Request，通知不回应，server 不崩", async () => {
  const srv = startServer(PORT + 1);
  await sleep(700);

  srv.p.stdin.write("null\n");
  srv.p.stdin.write("[]\n");
  srv.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }) + "\n");
  srv.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 7 }) + "\n");
  await sleep(300);

  assert.equal(srv.p.exitCode, null, "畸形输入不应让 server 退出");
  assert.deepEqual(
    srv.responses,
    [
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request: expected an object" } },
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request: expected an object" } },
      { jsonrpc: "2.0", id: 7, error: { code: -32600, message: "invalid request: missing method" } },
    ],
    "null / [] 各回一条 Invalid Request；缺 method 回 Invalid Request；通知不回任何报文"
  );
  assert.match(await srv.status(), /^not connected/); // server 仍在正常服务
});
