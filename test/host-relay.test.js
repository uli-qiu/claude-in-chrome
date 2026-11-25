// host.ts 中继测试：直接跑 host/host.ts（Node 原生剥离类型，不需要 bun 编译），
// 上游用一个假扩展（写它的 stdin、读它的 stdout）。
// bun build --compile 不做类型检查，未定义的标识符要到这里才暴露——host.ts 的改动靠这两个用例把关。
//   全链路：假扩展 → host.ts → TCP → 真的 MCP server（含 bridge 状态上报、版本号一致）
//   故障路径：假 bridge 控制断线 / 分片 / 坏帧，验证重连、重放扩展 hello、双向 ping
import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame, FrameDecoder } from "../lib/protocol.js";
import { ROOT, startServer, cleanup, trackProc, sleep } from "./harness.js";
import { SERVER_INFO } from "../server/config.js";

// 类型剥离：23.6+ / 22.18+ 默认开启；更老的 Node 跑不了 host.ts，跳过而不是误报失败
const [maj, min] = process.versions.node.split(".").map(Number);
const canRunTs = maj > 23 || (maj === 23 && min >= 6) || (maj === 22 && min >= 18);
const skipTs = canRunTs ? false : `Node ${process.versions.node} 不能直接运行 .ts`;
const HOST_TS = join(ROOT, "host", "host.ts");
// 19900–19980：与 e2e（19000–19499）/ multibrowser（19500–19899）/ takeover（18000–18999）错开
const PORT = 19900 + Math.floor(Math.random() * 80);

const logDir = mkdtempSync(join(tmpdir(), "claude-in-chrome-hostlog-"));
after(() => {
  cleanup();
  rmSync(logDir, { recursive: true, force: true });
});

/** 拉起 host.ts：返回写 stdin / 依次读 stdout 帧的句柄 */
function startHost(port, t) {
  const host = spawn(process.execPath, [HOST_TS, "--bridge-host", "127.0.0.1", "--bridge-port", String(port)], {
    // 日志改到临时目录：host 默认写在可执行文件（这里是 node 本体）旁边
    env: { ...process.env, CLAUDE_IN_CHROME_HOST_LOG: join(logDir, "host.log"), CLAUDE_IN_CHROME_ADDR: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  trackProc(host);
  t.after(() => host.kill());
  const out = []; // 已到达但还没被 next() 取走的 stdout 帧
  const waiters = [];
  const dec = new FrameDecoder();
  host.stdout.on("data", (chunk) => {
    for (const f of dec.feed(chunk)) (waiters.shift() ?? ((v) => out.push(v)))(f);
  });
  host.stderr.on("data", () => {});
  return {
    p: host,
    write: (obj) => host.stdin.write(encodeFrame(obj)),
    writeRaw: (buf) => host.stdin.write(buf),
    next: (ms = 5000) => {
      if (out.length) return Promise.resolve(out.shift());
      return new Promise((res, rej) => {
        const timer = setTimeout(
          () => rej(new Error(`timeout waiting for a stdout frame from host (exitCode=${host.exitCode})`)),
          ms
        );
        waiters.push((f) => (clearTimeout(timer), res(f)));
      });
    },
  };
}

const text = (resp) => resp.result.content[0].text;
const until = async (cond, what, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(20);
  }
};

test("全链路：假扩展 → host.ts → TCP → MCP server", { skip: skipTs }, async (t) => {
  const srv = await startServer(PORT);
  const host = startHost(PORT, t);

  // TCP 连上：扩展先收到 bridge 状态；bridge 侧看到 host hello
  assert.deepEqual(await host.next(), { type: "bridge", connected: true });
  const hello = JSON.parse((await srv.status()).slice("connected: ".length));
  assert.equal(hello.client, "host");
  // 版本号三处一致（host 过去停在 0.3.0，与 manifest / server 对不上）
  const manifest = JSON.parse(readFileSync(join(ROOT, "extension", "manifest.json"), "utf8"));
  assert.equal(hello.version, manifest.version);
  assert.equal(hello.version, SERVER_INFO.version);

  // 扩展 hello（带 deviceId）经 host 透传，server 认出这个浏览器
  host.write({ type: "hello", client: "extension", deviceId: "dev-1", label: "Chrome", version: manifest.version });
  await sleep(200);
  assert.match(await srv.status(), /"deviceId":"dev-1"/);

  // 工具往返：server → host → 扩展，扩展 → host → server
  const pending = srv.call("browser_tabs_list");
  const req = await host.next();
  assert.equal(req.type, "tool_request");
  assert.equal(req.tool, "tabs_list");
  host.write({ type: "tool_response", id: req.id, ok: true, result: [{ tabId: 1, title: "Fake Tab" }] });
  assert.match(text(await pending), /Fake Tab/);

  // server 没了 → TCP 断 → 扩展收到 bridge connected:false
  srv.p.kill();
  assert.deepEqual(await host.next(), { type: "bridge", connected: false });

  // 本用例最先跑，logDir 里还没有 host.log（= 全新安装）：日志必须能自己创建并写进去
  // （回归：日志不存在时 stat 抛错被吞掉，结果一行都写不出来）
  const log = readFileSync(join(logDir, "host.log"), "utf8");
  assert.match(log, /connected to bridge/);
});

test("故障路径：断线重连并重放扩展 hello、分片帧、双向 ping、坏帧", { skip: skipTs }, async (t) => {
  // 假 bridge：记录每条连接上收到的帧，自动回 pong
  const conns = []; // 最近的在前
  const srv = net.createServer((sock) => {
    const dec = new FrameDecoder();
    const c = { sock, frames: [] };
    conns.unshift(c);
    sock.on("error", () => {});
    sock.on("data", (chunk) => {
      for (const f of dec.feed(chunk)) {
        c.frames.push(f);
        if (f.type === "ping") sock.write(encodeFrame({ type: "pong", ts: f.ts }));
      }
    });
  });
  await new Promise((res) => srv.listen(PORT + 1, "127.0.0.1", res));
  t.after(() => srv.close());

  const host = startHost(PORT + 1, t);
  assert.deepEqual(await host.next(), { type: "bridge", connected: true });
  // 同下：stdout 的"已连接"可能先于 TCP 上的 hello 到达
  await until(() => conns[0]?.frames.length >= 1, "首个连接上的 host hello");
  const c1 = conns[0];
  assert.equal(c1.frames[0].client, "host");

  // 扩展 hello 透传
  const extHello = { type: "hello", client: "extension", deviceId: "dev-1", label: "Chrome", version: "0.4.0" };
  host.write(extHello);
  await until(() => c1.frames.length >= 2, "扩展 hello 透传到 bridge");
  assert.deepEqual(c1.frames[1], extHello);

  // 双向 ping：bridge 的 ping → TCP 上回 pong；扩展的 ping → stdout 回 pong
  c1.sock.write(encodeFrame({ type: "ping", ts: 111 }));
  await until(() => c1.frames.length >= 3, "bridge ping 的 pong");
  assert.deepEqual([c1.frames[2].type, c1.frames[2].ts], ["pong", 111]);
  host.write({ type: "ping", ts: 222 });
  const pong = await host.next();
  assert.deepEqual([pong.type, pong.ts], ["pong", 222]);

  // 断线：扩展先收到 bridge connected:false；重连后 connected:true，并重放缓存的扩展 hello
  c1.sock.destroy();
  assert.deepEqual(await host.next(), { type: "bridge", connected: false });
  assert.deepEqual(await host.next(), { type: "bridge", connected: true });
  // host 的 hello 走 TCP、"bridge connected" 走 stdout，两条通道谁先到不定：先把两帧等齐再断言
  // （CI 上曾因先断言后等待而间歇失败）
  await until(() => conns[0] !== c1 && conns[0].frames.length >= 2, "重连后的 host hello 与重放的扩展 hello");
  const c2 = conns[0];
  assert.equal(c2.frames[0].client, "host");
  assert.deepEqual(c2.frames[1], extHello);

  // 分片：一帧拆两半发，应拼回一帧
  const split = encodeFrame({ type: "tool_request", id: 6, tool: "x", args: {} });
  c2.sock.write(split.subarray(0, 5));
  await sleep(50);
  c2.sock.write(split.subarray(5));
  assert.deepEqual(await host.next(), { type: "tool_request", id: 6, tool: "x", args: {} });

  // bridge 发坏帧长度：断开该连接并重连，进程不退出
  c2.sock.write(Buffer.from([255, 255, 255, 255]));
  assert.deepEqual(await host.next(), { type: "bridge", connected: false });
  assert.deepEqual(await host.next(), { type: "bridge", connected: true });
  assert.equal(host.p.exitCode, null);

  // 扩展发坏帧：退出码 1
  host.writeRaw(Buffer.alloc(4));
  if (host.p.exitCode === null) await new Promise((res) => host.p.on("exit", res));
  assert.equal(host.p.exitCode, 1);
});

// 实测（Windows + 两个浏览器实例，17 天）：没有 MCP 会话时 host 每 3s 重连一次，
// 每次记一行 "tcp error: "——Windows 版 bun 抛的 AggregateError 连 message 都是空的——刷到 8.9MB。
test("连接失败日志：带错误码、相同错误不重复记、超过上限轮转", { skip: skipTs }, async (t) => {
  const logPath = join(logDir, "busy.log");
  writeFileSync(logPath, "x".repeat(2 * 1024 * 1024 + 10)); // 预置一个超过 2MB 的旧日志
  const host = spawn(process.execPath, [HOST_TS, "--bridge-host", "127.0.0.1", "--bridge-port", String(PORT + 2)], {
    env: { ...process.env, CLAUDE_IN_CHROME_HOST_LOG: logPath, CLAUDE_IN_CHROME_ADDR: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  trackProc(host);
  t.after(() => host.kill());
  host.stdout.on("data", () => {});
  host.stderr.on("data", () => {});

  // 重连退避：0s、2s、5s… → 2.6s 内试了 2 次
  await sleep(2600);
  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  const errors = lines.filter((l) => l.includes("tcp error"));
  assert.equal(errors.length, 1, `相同的连续错误只记一行，实际：${JSON.stringify(errors)}`);
  assert.match(errors[0], /ECONNREFUSED/);
  assert.ok(statSync(logPath).size < 4096, "新日志应从轮转后重新开始");
  assert.ok(statSync(`${logPath}.old`).size > 2 * 1024 * 1024, "旧日志应被轮转为 .old");
});
