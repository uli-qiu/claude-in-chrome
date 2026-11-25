// claude-in-chrome Windows Native Messaging Host
// 职责：纯帧中继 —— Chrome native messaging (stdin/stdout, 4B LE 长度前缀 + JSON)
//       ↔ TCP (默认 localhost:8765 → WSL2 的 MCP server, 经 WSL localhostForwarding)
//
// 参数: --bridge-host <host>  默认 localhost
//       --bridge-port <port>  默认 8765
//       --selftest           不挂 stdin，向 bridge 发 hello+ping 后退出（安装验证用）
//
// 日志: 同目录 host.log（stderr 也会写，Chrome 会丢弃 stderr）；超过 2MB 轮转为 host.log.old
//       可用 CLAUDE_IN_CHROME_HOST_LOG 改路径（部署目录只读、或测试时用）

import { appendFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import net from "node:net";

const MAX_FRAME = 1048576;
const VERSION = "0.4.0";
const PING_INTERVAL = 30000;

function parseArgs() {
  const args = process.argv.slice(2);
  const out: { host: string; port: number; selftest: boolean } = {
    host: "localhost",
    port: 8765,
    selftest: false,
  };
  let hostGiven = false, portGiven = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--bridge-host") { out.host = args[++i]; hostGiven = true; }
    else if (args[i] === "--bridge-port") { out.port = Number(args[++i]); portGiven = true; }
    else if (args[i] === "--selftest") out.selftest = true;
  }
  // 环境变量仅补充未显式给定的参数（否则用户级 setx 的 CLAUDE_IN_CHROME_ADDR
  // 会覆盖 CLI 传参——selftest 指定端口时会连到错误地址）。manifest "path"
  // 只能是 exe 路径，所以运行态地址仍经环境变量由 install.sh 写入系统。
  // 旧名 CHROME_BRIDGE_ADDR 回退支持：存量 Windows 部署 setx 的还是旧名。
  const addrEnv = process.env.CLAUDE_IN_CHROME_ADDR ?? process.env.CHROME_BRIDGE_ADDR;
  if (addrEnv) {
    const [h, p] = addrEnv.split(":");
    if (h && !hostGiven) out.host = h;
    if (p && !portGiven) out.port = Number(p);
  }
  return out;
}

const cfg = parseArgs();

const LOG_PATH = process.env.CLAUDE_IN_CHROME_HOST_LOG ?? join(dirname(process.execPath), "host.log");
const LOG_MAX_BYTES = 2 * 1024 * 1024; // 超过则轮转为 host.log.old（只留一份）

// 没有 MCP 会话在听时，host 每 3s 重连一次；日志不轮转会无限增长
// （实测两个浏览器实例 17 天刷到 8.9MB）。appendFileSync 每次开关文件，重命名是安全的。
let logBytes = -1; // LOG_PATH 当前大小（进程内累加；<0 表示下次写之前重新 stat）
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [claude-in-chrome host] ${msg}\n`;
  try {
    // 全新安装时日志还不存在：从 0 起算（直接 stat 会 ENOENT，被下面 catch 掉就一行都写不出来）
    if (logBytes < 0) logBytes = existsSync(LOG_PATH) ? statSync(LOG_PATH).size : 0;
    if (logBytes > LOG_MAX_BYTES) {
      rmSync(`${LOG_PATH}.old`, { force: true });
      renameSync(LOG_PATH, `${LOG_PATH}.old`);
      logBytes = 0;
    }
    appendFileSync(LOG_PATH, line);
    logBytes += line.length;
  } catch {
    logBytes = -1; // 写不进去（只读目录/被占用）：下次重新 stat 再试，不抛
  }
  console.error(line.trimEnd());
}

// Windows 版 bun 连不上时抛的是 AggregateError：message 为空、只有 code——所以带上 code
function describeError(e: unknown): string {
  const err = e as { code?: string; message?: string; name?: string } | null;
  return [err?.code, err?.message].filter(Boolean).join(": ") || err?.name || String(e);
}

// ---------------------------------------------------------------------------
// 帧编解码（stdin 与 TCP 同构，共用）
// ---------------------------------------------------------------------------
function encodeFrame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), "utf-8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

// 解析缓冲区里所有完整帧，返回剩余字节；坏帧长度抛错，由调用方断连/退出
function decodeFrames(buffer: Buffer): { frames: object[]; rest: Buffer } {
  const frames: object[] = [];
  let buf = buffer;
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (len === 0 || len > MAX_FRAME) throw new Error(`invalid frame length ${len}`);
    if (buf.length < 4 + len) break;
    frames.push(JSON.parse(buf.subarray(4, 4 + len).toString("utf-8")));
    buf = buf.subarray(4 + len);
  }
  return { frames, rest: buf };
}

const writeStdoutFrame = (obj: unknown) => process.stdout.write(encodeFrame(obj));
function writeTcpFrame(obj: unknown) {
  if (tcp?.writable) tcp.write(encodeFrame(obj));
}
// 把"到 bridge 的 TCP 是否在连"报给扩展：扩展据此显示/判定已连接，
// 否则 native port 一建立（host.exe 刚被拉起）扩展就显示已连接，而 TCP 可能还在重试
// （selftest 模式 stdout 面向终端，不发）
const tellBridgeState = (connected: boolean) => {
  if (!cfg.selftest) writeStdoutFrame({ type: "bridge", connected });
};

// ---------------------------------------------------------------------------
// TCP 连接（指数退避重连）
// ---------------------------------------------------------------------------
let tcp: net.Socket | null = null;
let tcpConnected = false;
let stdinRest = Buffer.alloc(0);
let tcpBuf = Buffer.alloc(0);
let pingTimer: ReturnType<typeof setInterval> | null = null;
let pongsMissed = 0;
// 扩展 hello（带 deviceId）只在 native port 建立时发一次；若那时 TCP 尚未连上，
// 帧会被静默丢弃，server 从此认不出这个浏览器。缓存它，重连成功后随 host hello 重放。
let extHello: object | null = null;

function connectTcp(onFrame: (f: object) => void, onUp: () => void) {
  let attempt = 0;
  // 相同的连续连接错误不重复记（每 50 次提一句还在重试）；连上过一次后重新开始记
  let lastError = "";
  let repeats = 0;
  const tryConnect = () => {
    if (tcpConnected) return;
    // localhost 桥：服务端随 Claude Code 会话重启，退避封顶 3s，
    // 让 /chrome 的 0/2/4s 重试窗口（受钩子 10s 预算约束）能盖住重连
    const wait = Math.min(1000 * 2 ** attempt, 3000);
    setTimeout(() => {
      const sock = net.connect(cfg.port, cfg.host, () => {
        attempt = 0;
        lastError = "";
        repeats = 0;
        tcp = sock;
        tcpConnected = true;
        pongsMissed = 0;
        log(`connected to bridge ${cfg.host}:${cfg.port}`);
        writeTcpFrame({ type: "hello", client: "host", version: VERSION, pid: process.pid });
        onUp();
        tellBridgeState(true);
        pingTimer = setInterval(() => {
          if (!tcpConnected) return;
          writeTcpFrame({ type: "ping", ts: Date.now() });
          if (++pongsMissed >= 3) {
            log("3 pings unanswered; reconnecting");
            sock.destroy();
          }
        }, PING_INTERVAL);
      });
      sock.on("data", (chunk) => {
        try {
          const { frames, rest } = decodeFrames(Buffer.concat([tcpBuf, chunk]));
          tcpBuf = rest;
          for (const f of frames) onFrame(f);
        } catch (e) {
          log(`bad frame from bridge: ${(e as Error).message}`);
          sock.destroy();
        }
      });
      sock.on("error", (e) => {
        const desc = describeError(e);
        if (desc !== lastError) {
          log(`tcp error: ${desc}`);
          lastError = desc;
          repeats = 0;
        } else if (++repeats % 50 === 0) {
          log(`tcp error: ${desc} (×${repeats}, still retrying)`);
        }
      });
      sock.on("close", () => {
        if (tcpConnected) tellBridgeState(false);
        tcpConnected = false;
        if (pingTimer) clearInterval(pingTimer);
        if (!process.exitCode) tryConnect();
      });
    }, attempt++ === 0 ? 0 : wait);
  };
  tryConnect();
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
if (cfg.selftest) {
  log(`selftest: connecting ${cfg.host}:${cfg.port}`);
  connectTcp(
    (f) => {
      const m = f as { type?: string };
      log(`selftest frame: ${JSON.stringify(m).slice(0, 200)}`);
      if (m.type === "hello" || m.type === "pong") {
        log("selftest OK");
        process.exit(0);
      }
    },
    () => writeTcpFrame({ type: "ping", ts: Date.now() })
  );
  setTimeout(() => {
    log("selftest: no response within 10s");
    process.exit(1);
  }, 10000);
} else {
  // 正常模式：stdin 帧 → TCP，TCP 帧 → stdout（同构帧，纯中继）
  process.stdin.on("data", (chunk: Buffer) => {
    stdinRest = Buffer.concat([stdinRest, chunk]);
    try {
      const { frames, rest } = decodeFrames(stdinRest);
      stdinRest = rest;
      for (const f of frames) {
        const m = f as { type?: string; client?: string; ts?: number };
        if (m.type === "ping") {
          writeStdoutFrame({ type: "pong", ts: m.ts, now: Date.now() });
        } else {
          if (m.type === "hello" && m.client === "extension") extHello = f;
          log(`ext→bridge: ${m.type}`);
          writeTcpFrame(f);
        }
      }
    } catch (e) {
      log(`bad frame from extension: ${(e as Error).message}`);
      process.exit(1);
    }
  });
  process.stdin.on("end", () => {
    log("stdin closed (extension went away); exiting");
    process.exit(0);
  });
  process.stdin.on("error", () => process.exit(1));

  connectTcp(
    (f) => {
      const m = f as { type?: string; ts?: number };
      if (m.type === "ping") {
        writeTcpFrame({ type: "pong", ts: m.ts, now: Date.now() });
        return;
      }
      if (m.type === "pong") {
        pongsMissed = 0;
        return;
      }
      log(`bridge→ext: ${m.type}`);
      writeStdoutFrame(f);
    },
    () => {
      // TCP（重）连成功：重放缓存的扩展 hello，让 server 重新认出本浏览器
      if (extHello) writeTcpFrame(extHello);
    }
  );

  // 空转防护：extension 断开且 TCP 也断开时进程由 stdin end / Chrome 杀掉
  // Bun 下 stdin 需要显式 resume 读取
  (process.stdin as any).resume?.();
}

export {};
