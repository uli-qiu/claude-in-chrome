// TCP 桥：接收 host.exe 的反向连接，转发工具调用
// - 多浏览器并存：扩展的 hello 携带 deviceId（每个浏览器安装时生成，见 extension/device.js），
//   本桥按 deviceId 各存一条连接（同官方 Claude in Chrome 的 relay 语义：peer per browser）。
//   多于一个浏览器在连时不猜——工具报错列出清单，由 browser_select / CLAUDE_IN_CHROME_DEVICE 选定。
//   旧扩展无 deviceId：保持 last-wins 单槽（后连顶替先连）。
// - 多会话并发：后启动的会话 evict 持有者（last-session-wins）；
//   被逐出的实例转休眠（MCP 保活，工具改报原因）
// - 心跳：pong 3 个周期未回即判定 host 已死并断开（host 侧 ≤3s 退避重连）

import net from "net";
import { encodeFrame, FrameDecoder, msg } from "../lib/protocol.js";
import { HOST, PORT, TOOL_TIMEOUT, DEVICE } from "./config.js";

const log = (...a) => console.error("[claude-in-chrome]", ...a);

let tcpServer = net.createServer();
// socket → entry: { deviceId, label, info(host hello), pongsMissed, connectedAt }
// deviceId 为 null 表示旧扩展（未上报扩展 hello），走 last-wins 单槽
const hosts = new Map();
let dormant = null; // 非 null 表示本实例不持有 TCP 桥，值为原因
let evictAttempts = 0; // EADDRINUSE 后的逐出重试次数（listen 成功清零）
let selected = DEVICE; // 显式选定的浏览器（browser_select 或环境变量），值为 deviceId
const pending = new Map(); // id -> {resolve, reject, timer, sock}
let nextId = 1;

function dropHost(socket, reason) {
  const entry = hosts.get(socket);
  if (!entry) return;
  hosts.delete(socket);
  log(`host disconnected (${describe(entry)}): ${reason}`);
  for (const [id, p] of pending) {
    if (p.sock !== socket) continue;
    clearTimeout(p.timer);
    p.reject(new Error(`connection lost: ${reason}`));
    pending.delete(id);
  }
  socket.destroy();
}

// 连接角色判定：host.exe 连上先发 hello；evict 是同机新会话的接管请求，不能当 host 收。
tcpServer.on("connection", (socket) => {
  let role = null; // "host" | "control" | null（首帧未到）
  const decoder = new FrameDecoder();
  socket.on("data", (chunk) => {
    let frames;
    try {
      frames = decoder.feed(chunk);
    } catch (e) {
      socket.destroy();
      if (role === "host") dropHost(socket, `bad frame: ${e.message}`);
      return;
    }
    for (const f of frames) {
      if (!role) {
        if (f.type === "hello") {
          role = "host";
          // host.exe 首帧 hello 不带 deviceId（扩展 hello 随后经同一连接上报），
          // 所以这里不能把其他无 deviceId 的连接当旧扩展踢掉——两个浏览器的 host
          // 会在彼此的扩展 hello 到达前无限互踢。只有同 pid（host.exe 自身掉线
          // 重连）才立即顶替；跨 pid 的交给 scheduleLegacyResolve 宽限收敛。
          for (const [s, h] of hosts) {
            if (!h.deviceId && h.info.pid === f.pid) dropHost(s, "replaced");
          }
          hosts.set(socket, {
            socket,
            deviceId: null,
            label: null,
            info: f,
            pongsMissed: 0,
            connectedAt: Date.now(),
          });
          log(`host connected: ${f.client ?? "?"} v${f.version ?? "?"} pid=${f.pid ?? "?"} from ${socket.remoteAddress}`);
          scheduleLegacyResolve();
          continue;
        }
        if (f.type === "evict") {
          role = "control";
          handleEvict(f);
          socket.end();
          return;
        }
        socket.destroy(); // 首帧不是 hello/evict：不是我们的客户端
        return;
      }
      if (role === "host") handleFrame(f, socket);
    }
  });
  socket.on("error", (e) => {
    if (role === "host") dropHost(socket, e.message);
  });
  socket.on("close", () => {
    if (role === "host") dropHost(socket, "closed");
  });
});

// 被新会话逐出：释放 TCP 桥但保活 MCP（本会话工具转为报错说明，而非 CONNECTION_CLOSED）
function handleEvict(f) {
  log(`evicted by newer session pid=${f.pid ?? "?"}; going dormant (MCP stays up)`);
  dormant =
    `taken over by a newer Claude Code session (pid ${f.pid ?? "?"}) at ` +
    `${new Date().toLocaleTimeString()} — this session keeps running but has no browser ` +
    `control; run /mcp reconnect here to reclaim`;
  try {
    tcpServer.close(); // close 后可重新 listen（/mcp 重连时由 wireServer 的重试路径接管）
  } catch {}
  for (const s of [...hosts.keys()]) dropHost(s, "evicted by newer session");
}

function handleFrame(f, socket) {
  switch (f.type) {
    case "hello": {
      // 扩展的 hello：携带 deviceId（host.exe 是纯中继，扩展 hello 透传到此处）
      const entry = hosts.get(socket);
      if (!entry || f.client !== "extension" || !f.deviceId) break;
      // 同 deviceId 的旧连接（重连竞态：新连接先到，旧连接 close 未触发）：踢旧留新
      for (const [s, h] of hosts) {
        if (s !== socket && h.deviceId === f.deviceId) dropHost(s, "reconnected");
      }
      entry.deviceId = f.deviceId;
      entry.label = f.label ?? null;
      log(`browser connected: ${describe(entry)} v${f.version ?? "?"}`);
      break;
    }
    case "pong": {
      const entry = hosts.get(socket);
      if (entry) entry.pongsMissed = 0;
      break;
    }
    case "tool_response": {
      const p = pending.get(f.id);
      if (!p || p.sock !== socket) return;
      pending.delete(f.id);
      clearTimeout(p.timer);
      if (f.ok) p.resolve(f.result);
      else p.reject(new Error(f.error ?? "tool failed"));
      break;
    }
    case "notification":
      log("notification:", f.event, JSON.stringify(f.data)?.slice(0, 200));
      break;
    case "ping":
      sendToHost(socket, msg.pong(f.ts));
      break;
    default:
      log("unknown frame type:", f.type);
  }
}

function sendToHost(socket, obj) {
  if (!socket || socket.destroyed) return false;
  try {
    socket.write(encodeFrame(obj));
    return true;
  } catch {
    return false;
  }
}

// 旧扩展（不上报 deviceId）的 last-wins 收敛：每个新 host hello 重置宽限计时，
// 到期仍无 deviceId 的连接视为旧扩展，只留最新的。新扩展的 hello 在宽限期内
// 到达即拿到 deviceId、豁免淘汰——上面不踢 + 这里宽限，双浏览器互踢死循环即消除。
const LEGACY_GRACE_MS = 2000;
let legacyTimer = null;
function scheduleLegacyResolve() {
  if (legacyTimer) clearTimeout(legacyTimer);
  legacyTimer = setTimeout(() => {
    legacyTimer = null;
    const legacy = hostList().filter((h) => !h.deviceId); // 旧→新排序，留最新的
    for (const h of legacy.slice(0, -1)) dropHost(h.socket, "replaced (legacy, no deviceId)");
  }, LEGACY_GRACE_MS);
  legacyTimer.unref();
}

// ---- 多浏览器选择（借鉴官方 relay：绝不猜，>1 个在连时必须点名） ----

function hostList() {
  return [...hosts.values()].sort((a, b) => a.connectedAt - b.connectedAt); // 旧→新
}

function describe(entry) {
  return entry.deviceId
    ? `${entry.deviceId}${entry.label ? ` (${entry.label})` : ""}`
    : "legacy (no deviceId)";
}

// 清单行：已选中的加标记（旧扩展无 deviceId，永不被选中——不能拿 null === null 当命中）
function listLine(entry) {
  return `- ${describe(entry)}${entry.deviceId && entry.deviceId === selected ? " ← selected" : ""}`;
}

// 选择器匹配：deviceId 全等 / id 前缀 / 设备名（忽略大小写）全等、前缀或包含
// （包含匹配让 "andrew@gmail.com" 能选中 "Chrome (andrew@gmail.com)"；歧义时报错要求更精确）
function matches(entry, sel) {
  if (!entry.deviceId) return false;
  if (entry.deviceId === sel || entry.deviceId.startsWith(sel)) return true;
  const label = entry.label?.toLowerCase();
  const s = sel.toLowerCase();
  return !!label && (label === s || label.startsWith(s) || label.includes(s));
}

function pickHost() {
  const all = hostList();
  if (!all.length) {
    throw new Error(
      "Browser extension is not connected. Ensure Chrome is running with the " +
        "claude-in-chrome extension loaded (chrome://extensions → Load unpacked → the " +
        "deployed extension dir shown by install.sh) and that install.sh finished. Then retry browser_status."
    );
  }
  if (selected) {
    const hits = all.filter((h) => matches(h, selected));
    if (hits.length === 1) return hits[0];
    if (!hits.length) {
      throw new Error(
        `no connected browser matches "${selected}" — connected: ${all.map(describe).join(", ")}. ` +
          `Call browser_select with one of them.`
      );
    }
    throw new Error(
      `"${selected}" matches ${hits.length} browsers; be more specific. Connected: ${all.map(describe).join(", ")}`
    );
  }
  if (all.length === 1) return all[0];
  throw new Error(
    `${all.length} browsers are connected: ${all.map(describe).join(", ")}. ` +
      `Pick one with the browser_select tool (deviceId, id prefix, or label) or set ` +
      `CLAUDE_IN_CHROME_DEVICE, then retry.`
  );
}

/** browser_select 工具：无参列出在连浏览器，带参选定并返回清单 */
function selectBrowser(sel) {
  const all = hostList();
  if (!sel) {
    const list = all.map(listLine).join("\n");
    return all.length ? `${all.length} browser(s) connected:\n${list}` : "no browser connected";
  }
  const hits = all.filter((h) => matches(h, sel));
  if (hits.length !== 1) {
    const list = all.map(listLine).join("\n");
    throw new Error(
      hits.length
        ? `"${sel}" matches ${hits.length} browsers; be more specific:\n${list}`
        : `no connected browser matches "${sel}". Connected:\n${list || "(none)"}`
    );
  }
  selected = hits[0].deviceId; // 存 id：label 改名/重连都不受影响
  // 清单在选定之后生成：标记要反映新的选择，而不是上一次的
  return `selected: ${describe(hits[0])}\n${all.length} browser(s) connected:\n${all.map(listLine).join("\n")}`;
}

async function callTool(tool, args) {
  if (dormant) throw new Error(`bridge not held by this session — ${dormant}`);
  const host = pickHost(); // 报错文案带在连浏览器清单
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`tool ${tool} timed out after ${TOOL_TIMEOUT}ms`));
    }, TOOL_TIMEOUT);
    pending.set(id, { resolve, reject, timer, sock: host.socket });
    if (!sendToHost(host.socket, msg.toolRequest(id, tool.replace(/^browser_/, ""), args))) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error("Browser extension is not connected."));
    }
  });
}

// 心跳：只发不查会让死连接一直显示 connected（逐连接计数）
setInterval(() => {
  for (const [socket, entry] of hosts) {
    if (socket.destroyed) continue;
    if (++entry.pongsMissed >= 3) {
      dropHost(socket, "3 pings unanswered");
      continue;
    }
    sendToHost(socket, msg.ping());
  }
}, 30000).unref();

function wireServer(srv) {
  srv.on("error", (e) => {
    if (e.code !== "EADDRINUSE") {
      log("TCP server error:", e.message);
      process.exit(1);
    }
    // 端口被占：逐出持有者，最后启动的会话胜出（多会话并发场景）。
    // 注意：旧版本持有者不认识 evict（会把我们误当 host 且不放端口），
    // 重试上限后转休眠——保住 MCP 连接，工具改报原因，不再 exit(1)。
    evictAttempts++;
    if (evictAttempts > 20) {
      dormant =
        `port ${PORT} is held by another process that did not yield to eviction ` +
        `(likely an old claude-in-chrome server). Free the port or /mcp reconnect later.`;
      log(dormant);
      return;
    }
    log(`port ${PORT} busy; evicting holder (attempt ${evictAttempts})`);
    const sock = net.connect(PORT, HOST);
    sock.on("connect", () => sock.end(encodeFrame(msg.evict({ pid: process.pid }))));
    sock.on("error", () => {}); // 持有者可能恰好退出；close 统一兜底重试
    sock.on("close", () => {
      setTimeout(() => srv.listen(PORT, HOST), 120 + Math.random() * 180); // 抖动防两个新会话同步互踢
    });
  });
}
wireServer(tcpServer);

/** browser_status 的状态文案 */
function statusText() {
  if (dormant) return `not connected — ${dormant}`;
  const all = hostList();
  if (!all.length) {
    return (
      "not connected — waiting for host.exe (Windows Chrome with claude-in-chrome extension). " +
      "Run install.sh and reload the extension, then retry."
    );
  }
  if (all.length === 1) {
    const h = all[0];
    const extra = h.deviceId ? { deviceId: h.deviceId, label: h.label, ...h.info } : h.info;
    return `connected: ${JSON.stringify(extra)}`;
  }
  const lines = all.map(listLine);
  return (
    `${all.length} browsers connected:\n${lines.join("\n")}\n` +
    `Tools target the selected browser; call browser_select (deviceId / id prefix / label) to switch.`
  );
}

export const bridge = { callTool, statusText, selectBrowser };

tcpServer.listen(PORT, HOST, () => {
  evictAttempts = 0;
  log(`TCP bridge listening on ${HOST}:${PORT} (host.exe connects here)`);
});
