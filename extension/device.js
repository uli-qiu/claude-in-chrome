// 设备标识：本机多个浏览器/多个 Chrome profile 都装本扩展时，MCP server 靠它区分连的是哪个。
// - deviceId：安装时生成一次，持久存 chrome.storage.local。扩展存储按 profile 隔离，
//   所以每个浏览器、每个 Chrome profile 各拿各的 id；重装扩展会重新生成。
// - label：优先 options 里自定义的设备名；否则取当前 profile 登录账号的邮箱
//   （chrome.identity.getProfileUserInfo，多 Chrome profile 场景的天然区分）；
//   未登录则退回浏览器名（Chrome/Edge/…）。
// 与官方 Claude in Chrome 的 device_id 机制同构（connect 帧携带，relay 按 id 路由）。

export async function getDeviceId() {
  const { deviceId } = await chrome.storage.local.get("deviceId");
  if (deviceId) return deviceId;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ deviceId: fresh });
  return fresh;
}

// 当前 profile 登录的账号邮箱（Google/Microsoft 账号，取决于浏览器）。
// 需 manifest 声明 identity + identity.email 权限；未登录/权限缺失返回 null。
function getProfileEmail() {
  return new Promise((resolve) => {
    if (typeof chrome?.identity?.getProfileUserInfo !== "function") return resolve(null);
    try {
      chrome.identity.getProfileUserInfo((info) => resolve(info?.email || null));
    } catch {
      resolve(null);
    }
  });
}

function browserName() {
  const ua = navigator.userAgent;
  if (ua.includes("Edg/")) return "Edge";
  if (ua.includes("OPR/")) return "Opera";
  if (ua.includes("Brave/")) return "Brave";
  return ua.includes("Chrome/") ? "Chrome" : "Chromium";
}

export async function getDeviceLabel() {
  const { deviceName } = await chrome.storage.local.get("deviceName");
  if (deviceName) return deviceName;
  const email = await getProfileEmail();
  return email ? `${browserName()} (${email})` : browserName();
}
