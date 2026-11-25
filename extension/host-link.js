// Native messaging 连接（带重连）
// 上行: chrome.runtime.connectNative → host.exe → TCP → MCP server
// 协议帧（经 native messaging，每条 postMessage 即一帧）:
//   hello（扩展的 client:"extension" 带 deviceId/label）
//   ping / pong / tool_request{id,tool,args} / tool_response{id,ok,result|error}
//   bridge{connected}（host.exe 报"到 MCP server 的 TCP 是否在连"，需 host ≥ 0.4.0）

import { dispatchTool } from "./tools.js";
import { connState } from "./conn-state.js";
import { getDeviceId, getDeviceLabel } from "./device.js";

const HOST_NAME = "com.user.claude_in_chrome";
const RECONNECT_MS = 5000;

let port = null;

// 直写指定的 native port（不看桥是否已连）
function post(obj, p = port) {
  if (!p) return false;
  try {
    p.postMessage(obj);
    return true;
  } catch (e) {
    console.warn("postMessage failed:", e);
    return false;
  }
}

// 工具应答等只在桥已连时发：TCP 没通时 host.exe 会静默丢弃，直接报 false 更诚实
export function send(obj) {
  return connState.connected && post(obj);
}

async function connectToHost() {
  let p;
  try {
    p = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    console.warn("connectNative failed:", e);
    scheduleReconnect();
    return;
  }
  port = p;
  connState.hostUp = true;
  connState.connected = false; // 等 host.exe 报 bridge connected（它可能还在重试 TCP）
  p.onMessage.addListener((msg) => onHostMessage(msg, p));
  p.onDisconnect.addListener(() => {
    // popup_reconnect 会先 disconnect 旧 port 再建新连接；
    // 旧 port 的断连回调晚于新连接赋值，这里必须只清自己，否则会把新 port 打掉
    if (port !== p) return;
    port = null;
    connState.hostUp = false;
    connState.connected = false;
    const err = chrome.runtime.lastError?.message ?? "unknown";
    console.warn("native host disconnected:", err);
    scheduleReconnect();
  });
  // deviceId 标识"哪个浏览器"：多浏览器并存时 server 按它路由（见 device.js）。
  // 发给刚打开的 p（而非当前 port）：取 deviceId 期间若发生重连，别把 hello 重复发给新 port。
  // 不看桥是否已连——host.exe 会缓存这一帧，等 TCP 连上再转发
  const [deviceId, label] = await Promise.all([getDeviceId(), getDeviceLabel()]);
  post({
    type: "hello",
    client: "extension",
    deviceId,
    label,
    extensionId: chrome.runtime.id,
    userAgent: navigator.userAgent,
    version: chrome.runtime.getManifest().version,
  }, p);
}

function scheduleReconnect() {
  setTimeout(connectToHost, RECONNECT_MS);
}

async function onHostMessage(msg, p) {
  switch (msg.type) {
    case "bridge":
      // 只认当前 port 的状态（reconnect 后旧 port 的回调可能晚到）
      if (port === p) connState.connected = msg.connected === true;
      break;
    case "tool_request":
      send(await dispatchTool(msg.id, msg.tool, msg.args ?? {}));
      break;
    default:
      send({ type: "error", error: `unknown message type: ${msg.type}` });
  }
}

/** popup 的 Reconnect 按钮：断开旧连接立即重连 */
export function reconnect() {
  if (port) {
    try { port.disconnect(); } catch {}
    connState.connected = false;
    port = null;
  }
  connectToHost();
}

connectToHost();
