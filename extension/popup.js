// popup: 连接状态 + 手动重连
document.getElementById("reconnect").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "popup_reconnect" }).catch(() => {});
  // host.exe 被重新拉起并连上 TCP 需要一点时间，太早刷新会显示成未连接
  setTimeout(() => location.reload(), 1000);
};

const s = await chrome.runtime.sendMessage({ type: "popup_status" }).catch(() => null);
const statusEl = document.getElementById("status");
const hostEl = document.getElementById("hostinfo");
// connected：host.exe 到 MCP server 的 TCP 在连；hostUp：native port 打开（host.exe 进程在）
const STATE = {
  ok: ["connected to bridge", "ok"],
  noBridge: ["bridge unreachable (host.exe retrying, ≤3s) — is Claude Code running?", "bad"],
  noHost: ["native host not running (retrying every 5s)", "bad"],
};
const [text, cls] = !s
  ? ["background unreachable", "bad"]
  : s.connected ? STATE.ok : s.hostUp ? STATE.noBridge : STATE.noHost;
statusEl.textContent = text;
statusEl.className = cls;
if (s) hostEl.textContent = `extension ${s.extensionId ?? ""} · ${s.userAgent?.slice(0, 60) ?? ""}`;
