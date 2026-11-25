// 集成测试公用：拉起 server/index.js（独立端口）经 stdio 讲 JSON-RPC、模拟 host.exe 的 TCP 连接。
// node --test 每个测试文件是独立进程，这里的进程/socket 登记表按文件隔离，由各文件的 after(cleanup) 收尾。
import net from "net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "url";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const procs = [];
const socks = [];

/** 收尾：杀掉本文件拉起的 server 进程、关掉模拟连接 */
export function cleanup() {
  for (const p of procs) p.kill();
  for (const s of socks) s.destroy();
}

/** 登记一个子进程，cleanup 时杀掉 */
export function trackProc(p) {
  procs.push(p);
}

/** 连一个 socket 到 port（登记以便 cleanup 关闭） */
export function connect(port, host = "127.0.0.1") {
  const sock = net.connect(port, host);
  socks.push(sock);
  return sock;
}

/** 拉起 MCP server，等它真正开始监听（端口被上一个 server 占着时，含逐出对方、重新 listen）再返回 */
export async function startServer(port) {
  const p = spawn(process.execPath, [path.join(ROOT, "server/index.js")], {
    env: { ...process.env, CLAUDE_IN_CHROME_PORT: String(port) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(p);
  const stderr = [];
  p.stderr.on("data", (c) => stderr.push(c.toString()));
  const responses = []; // server 写出的每一条 JSON-RPC 报文（含未经 rpc() 发起的原始请求的应答）
  let rpcId = 0;
  const pending = new Map();
  let outBuf = "";
  p.stdout.on("data", (chunk) => {
    outBuf += chunk;
    let nl;
    while ((nl = outBuf.indexOf("\n")) !== -1) {
      const line = outBuf.slice(0, nl).trim();
      outBuf = outBuf.slice(nl + 1);
      if (!line) continue;
      const resp = JSON.parse(line);
      responses.push(resp);
      const resolve = pending.get(resp.id);
      if (resolve) {
        pending.delete(resp.id);
        resolve(resp);
      }
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = ++rpcId;
      pending.set(id, resolve);
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const call = (name, args = {}) => rpc("tools/call", { name, arguments: args });
  // 等 stderr 里出现指定日志
  const waitLog = (pat, ms = 5000) =>
    new Promise((res, rej) => {
      const t0 = Date.now();
      const poll = setInterval(() => {
        if (stderr.join("").includes(pat)) return (clearInterval(poll), res());
        if (Date.now() - t0 > ms || p.exitCode !== null)
          return (clearInterval(poll), rej(new Error(`timeout waiting "${pat}"`)));
      }, 30);
    });
  // 不用固定 sleep：慢机器上进程冷启动 + 逐出旧持有者 + 120~300ms 抖动后才 listen，定死了会连接被拒
  await waitLog("TCP bridge listening", 20000);
  return {
    p,
    rpc,
    call,
    responses,
    waitLog,
    status: async () => (await call("browser_status")).result.content[0].text,
  };
}
