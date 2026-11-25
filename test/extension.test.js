// 扩展端单测：用最小的 chrome 桩直接加载 extension/*.js（不需要真实 Chrome）。
// 覆盖的回归：
//   - browser_tab_new({url}) 过去不在站点门禁内，带 url 开新标签可绕过允许清单
//   - tab 关闭时的状态清理过去只挂在 browser_tab_close 上，用户手动关标签会泄漏缓冲
//   - 并发工具调用同时 attach 同一个 tab 会报 "Another debugger is already attached"
//   - native port 一建立扩展就报"已连接"，而 host.exe 到 MCP server 的 TCP 可能还在重试
import { test } from "node:test";
import assert from "node:assert/strict";

const noop = () => {};
const ev = () => ({ addListener: noop });

const listeners = { removed: [] }; // cdp.js 与 indicator.js 都会订阅 onRemoved
const calls = { create: [], attach: 0, sendCommand: [] };
let allowedSites; // undefined = storage 里没存过（走默认 ["*"]）

// chrome.runtime.connectNative 返回的 port 桩，最近的在末尾
const ports = [];
const makePort = () => {
  const on = { message: [], disconnect: [] };
  const p = {
    posted: [], // 经 postMessage 发出的帧
    postMessage: (obj) => p.posted.push(obj),
    disconnect: noop,
    onMessage: { addListener: (f) => on.message.push(f) },
    onDisconnect: { addListener: (f) => on.disconnect.push(f) },
    // 模拟 host.exe 发来一帧 / native port 断开
    emit: (msg) => { for (const f of on.message) f(msg); },
    drop: () => { for (const f of on.disconnect) f(); },
  };
  ports.push(p);
  return p;
};

globalThis.chrome = {
  storage: { local: {
    get: async (defaults) => ({ ...defaults, ...(allowedSites ? { allowedSites } : {}) }),
    set: async () => {}, // getDeviceId 首次生成 deviceId 时写入
  } },
  runtime: {
    id: "test-extension",
    getManifest: () => ({ version: "0.4.0" }),
    connectNative: makePort,
    sendMessage: null, // popup 用例里按需替换
  },
  tabs: {
    onCreated: ev(),
    onRemoved: { addListener: (f) => listeners.removed.push(f) },
    get: async (tabId) => ({ id: tabId, url: "https://example.com/", windowId: 1 }),
    query: async () => [],
    create: async (props) => (calls.create.push(props), { id: 7, windowId: 1 }),
    group: async () => 3,
  },
  tabGroups: { query: async () => [], update: async () => ({}) },
  debugger: {
    onDetach: ev(),
    onEvent: { addListener: (f) => (listeners.debuggerEvent = f) },
    attach: (_target, _version, cb) => {
      calls.attach++;
      cb();
    },
    sendCommand: (_target, method, _params, cb) => (calls.sendCommand.push(method), cb({})),
  },
};

const { dispatchTool } = await import("../extension/tools.js");
const { consoleBuf, netBuf, ensureAttached } = await import("../extension/cdp.js");
// host-link 在导入时就 connectNative（拉起第一个 port 桩）
const { send, reconnect } = await import("../extension/host-link.js");
const { connState } = await import("../extension/conn-state.js");
const { replSource, PAGE_WALK } = await import("../extension/page.js");

test("站点允许清单对 browser_tab_new 生效：非允许站点被拒，允许站点/无 url 正常开标签", async () => {
  allowedSites = ["example.com"];
  calls.create.length = 0;

  const blocked = await dispatchTool(1, "tab_new", { url: "https://evil.test/" });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /site not allowed/);
  assert.equal(calls.create.length, 0, "被拒的 url 不应开标签");

  const ok = await dispatchTool(2, "tab_new", { url: "https://example.com/page" });
  assert.equal(ok.ok, true);
  assert.equal(ok.result.tabId, 7);
  assert.deepEqual(calls.create, [{ url: "https://example.com/page", active: true }]);

  const blank = await dispatchTool(3, "tab_new", {});
  assert.equal(blank.ok, true); // 不带 url = about:blank，不算打开新站点
  assert.equal(calls.create.at(-1).url, "about:blank");
});

test("默认允许清单（*）下 tab_new 不受限", async () => {
  allowedSites = undefined;
  const r = await dispatchTool(4, "tab_new", { url: "https://evil.test/" });
  assert.equal(r.ok, true);
});

test("tab 关闭（任意途径）即清掉该 tab 的 console/network 缓冲", async () => {
  listeners.debuggerEvent({ tabId: 5 }, "Runtime.consoleAPICalled", { timestamp: 1, type: "log", args: [] });
  listeners.debuggerEvent({ tabId: 5 }, "Network.requestWillBeSent", {
    requestId: "r1",
    request: { method: "GET", url: "https://example.com/" },
  });
  assert.equal(consoleBuf.get(5).length, 1);
  assert.equal(netBuf.get(5).length, 1);

  for (const f of listeners.removed) f(5);
  assert.equal(consoleBuf.has(5), false);
  assert.equal(netBuf.has(5), false);
});

test("并发 attach 同一个 tab 只 attach 一次；失败后可重试", async () => {
  calls.attach = 0;
  await Promise.all([ensureAttached(9), ensureAttached(9)]);
  assert.equal(calls.attach, 1);
  calls.sendCommand.length = 0;
  await ensureAttached(9); // 已 attach：直接返回
  assert.equal(calls.sendCommand.length, 0);

  // attach 失败：所有等待方都拿到错误，且不留下"进行中"的残留
  const attach = chrome.debugger.attach;
  chrome.debugger.attach = (_t, _v, cb) => {
    calls.attach++;
    chrome.runtime.lastError = { message: "denied" };
    cb();
    chrome.runtime.lastError = undefined;
  };
  try {
    await assert.rejects(Promise.all([ensureAttached(11), ensureAttached(11)]), /debugger\.attach: denied/);
    assert.equal(calls.attach, 2, "失败的那次也只 attach 一次");
  } finally {
    chrome.debugger.attach = attach;
  }
  await ensureAttached(11);
  assert.equal(calls.attach, 3);
});

test("host-link：port 打开≠已连接；host.exe 报 bridge 状态后才算已连接，桥没连时工具应答不发", async (t) => {
  const p = ports.at(-1);
  await new Promise((r) => setTimeout(r, 0)); // 等 connectToHost 里的 await 走完
  assert.equal(connState.hostUp, true);
  assert.equal(connState.connected, false, "port 刚建立时 TCP 未必连上，不能报已连接");

  // 扩展 hello 不看桥是否已连：host.exe 缓存它，等 TCP 连上再转发
  const hello = p.posted.find((m) => m.type === "hello");
  assert.equal(hello?.client, "extension");
  assert.ok(hello.deviceId, "hello 必须带 deviceId");
  assert.equal(p.posted.length, 1);

  // 桥没连：应答发不出去
  assert.equal(send({ type: "tool_response", id: 1, ok: true }), false);
  assert.equal(p.posted.length, 1);

  p.emit({ type: "bridge", connected: true });
  assert.equal(connState.connected, true);
  assert.equal(send({ type: "pong" }), true);

  // TCP 断了但 host.exe 进程还在：不算已连接，hostUp 不变
  p.emit({ type: "bridge", connected: false });
  assert.equal(connState.connected, false);
  assert.equal(connState.hostUp, true);

  // 手动 Reconnect：新 port 接替；旧 port 晚到的断连回调 / 状态帧不得影响当前状态
  const before = ports.length;
  reconnect();
  const fresh = ports.at(-1);
  assert.equal(ports.length, before + 1);
  p.emit({ type: "bridge", connected: true }); // 旧 port 的帧
  assert.equal(connState.connected, false);
  fresh.emit({ type: "bridge", connected: true });
  p.drop(); // 旧 port 的断连回调晚到
  assert.equal(connState.connected, true, "旧 port 断开不得把新 port 的状态打掉");
  assert.equal(connState.hostUp, true);

  // 当前 port 断开：状态清零，5s 后自动重连
  t.mock.timers.enable({ apis: ["setTimeout"] });
  fresh.drop();
  assert.equal(connState.connected, false);
  assert.equal(connState.hostUp, false);
  t.mock.timers.runAll();
  assert.equal(ports.length, before + 2, "应重连一次");
  assert.equal(connState.hostUp, true);
  assert.equal(connState.connected, false, "重连后仍要等 host.exe 报 bridge 状态");
});

// popup.js 顶层就读状态并写 DOM：每个场景用带 query 的 import 重新执行一遍模块
async function loadPopup(t, reply) {
  chrome.runtime.sendMessage = async () => reply;
  const els = {};
  let reloads = 0;
  globalThis.document = { getElementById: (id) => (els[id] ??= { textContent: "", className: "" }) };
  Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { reload: () => reloads++ } });
  await import(`../extension/popup.js?case=${reply ? `${reply.connected}-${reply.hostUp}` : "none"}`);
  return { els, reloads: () => reloads };
}

test("popup 文案区分三种未连接：已连接 / bridge 不可达 / native host 未运行 / 后台不可达", async (t) => {
  let r = await loadPopup(t, { connected: true, hostUp: true, extensionId: "x", userAgent: "UA" });
  assert.equal(r.els.status.textContent, "connected to bridge");
  assert.equal(r.els.status.className, "ok");

  // 过去这种情况（port 开着、TCP 没通）也显示 connected to bridge
  r = await loadPopup(t, { connected: false, hostUp: true });
  assert.match(r.els.status.textContent, /bridge unreachable/);
  assert.equal(r.els.status.className, "bad");

  r = await loadPopup(t, { connected: false, hostUp: false });
  assert.match(r.els.status.textContent, /native host not running/);
  assert.equal(r.els.status.className, "bad");

  r = await loadPopup(t, null);
  assert.equal(r.els.status.textContent, "background unreachable");
  assert.equal(r.els.status.className, "bad");
});

test("popup 的 Reconnect：发 popup_reconnect，等 host.exe 连上后再刷新", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent = [];
  chrome.runtime.sendMessage = async (m) => (sent.push(m), { ok: true });
  const els = {};
  let reloads = 0;
  globalThis.document = { getElementById: (id) => (els[id] ??= { onclick: null, textContent: "", className: "" }) };
  Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { reload: () => reloads++ } });
  await import("../extension/popup.js?case=reconnect");
  await els.reconnect.onclick();
  assert.deepEqual(sent, [{ type: "popup_status" }, { type: "popup_reconnect" }]);
  t.mock.timers.tick(999);
  assert.equal(reloads, 0, "host.exe 还没来得及连上，先不刷新");
  t.mock.timers.tick(1);
  assert.equal(reloads, 1);
});

// 包装出来的代码与运行环境无关，直接在 Node 里求值即可（async 函数 / eval 语义与浏览器一致）。
// 回归：过去的实现是 async 函数里 eval(src)，顶层 await 是语法错误，而工具描述承诺支持。
const run = (expr) => (0, eval)(replSource(expr));
const loose = (t) => { try { return JSON.parse(t); } catch { return t; } };

test("browser_js 包装：顶层 await、表达式、语句序列、语句 + await", async () => {
  assert.equal(await run("1 + 1"), 2);
  assert.equal(await run("await Promise.resolve(1 + 1)"), 2, "顶层 await");
  assert.equal(await run("'a' + await Promise.resolve('b')"), "ab");
  assert.equal(await run("var q = 2; q + 3"), 5, "语句序列返回末表达式的值（旧行为保持）");
  assert.equal(await run("let r = await Promise.resolve(4); r * 2"), 8, "语句 + 顶层 await");
  assert.equal(await run("const r = await Promise.resolve(7)\nr"), 7, "换行分隔的语句");
  assert.equal(await run("globalThis.__cicProbe = 3; 1"), 1);
  assert.equal(globalThis.__cicProbe, 3, "副作用留在全局");
  assert.equal(await run("await Promise.all([1, 2, 3].map(async (n) => n * 2))").then((v) => v.join(",")), "2,4,6");
  await assert.rejects(run("await +"), SyntaxError, "语法错误原样抛出");
  await assert.rejects(run("null.x"), TypeError, "运行时错误原样抛出");
});

// 实测（Windows，两个 Chrome 窗口最小化）：页面不渲染且按几十像素宽重新布局，
// click 返回 clicked:true 却落在 <html> 上，hover/drag 无效，截图挂到 90s 超时。
test("窗口最小化时自动还原后再操作：按上次的状态还原，没见过的还原成普通窗口", async () => {
  const calls = [];
  let win = { id: 1, state: "maximized" };
  chrome.windows = {
    get: async () => win,
    update: async (id, props) => (calls.push([id, props.state]), (win = { ...win, state: props.state })),
  };
  const get_text = (n) => dispatchTool(n, "get_text", { tabId: 5 });

  await get_text(1); // 窗口可见：记住"最大化"，不动窗口
  assert.deepEqual(calls, []);

  win = { id: 1, state: "minimized" };
  await get_text(2);
  assert.deepEqual(calls, [[1, "maximized"]], "最小化后按上次的状态还原，而不是降级成普通窗口");
  assert.equal(win.state, "maximized");

  win = { id: 2, state: "minimized" }; // 从没见过可见状态的窗口
  const t0 = chrome.tabs.get;
  chrome.tabs.get = async (tabId) => ({ id: tabId, url: "https://example.com/", windowId: 2 });
  try { await get_text(3); } finally { chrome.tabs.get = t0; }
  assert.deepEqual(calls.at(-1), [2, "normal"]);

  calls.length = 0;
  win = { id: 1, state: "normal" };
  await get_text(4); // 还原之后再调用：不再动窗口
  assert.deepEqual(calls, []);
});

test("browser_js：语句 + 顶层 await 的拆分只在语句边界，不切坏属性名", async () => {
  assert.equal(await run("const r = await Promise.resolve({ status: 200, ok: true }); r.status + ':' + r.ok"), "200:true");
  // 回归：上一版在任意位置切，"r.o" + "k" 各自都能编译，结果 ReferenceError: k
  assert.equal(await run("const r = await Promise.resolve({ o: 9 }); r.status + ':' + r.o"), "undefined:9");
  assert.equal(await run("const a = await Promise.resolve(1)\nif (a) { globalThis.__t = a }\na + 1"), 2);
  assert.equal(globalThis.__t, 1, "前面的语句确实执行了");
  assert.equal(await run("const o = { a: await Promise.resolve(2) }; o.a"), 2);
  assert.equal(await run("await Promise.resolve(1)\n  .then((v) => v + 10)"), 11, "跨行的单条 await 表达式");
  assert.equal(await run("const a = await Promise.resolve(1)\n  .then((v) => v + 10)"), undefined, "const 声明不是表达式：只执行");
  assert.equal(await run("let s = 'x;await'; s.length"), 7, "字符串里的 await 不触发拆分");
  assert.equal(await run("for (let i = 0; i < 3; i++) { globalThis.__t = i }"), 2, "同步语句走 eval：取脚本完成值（最后一次迭代的值）");
  assert.equal(await run("for (const x of [1, 2, 3]) { await Promise.resolve(); globalThis.__t = x }"), undefined, "带 await 且没有末表达式：只执行");
  assert.equal(globalThis.__t, 3);
  assert.equal(await run("async function f() { return 5 }\nf()"), 5);
  assert.equal(await run("await Promise.resolve(1) + await Promise.resolve(2)"), 3);
});

// PAGE_WALK 是注入页面的脚本文本：用极简假 DOM 在 Node 里直接执行。
// 回归：walk() 过去只递归进 shadow root、不进普通子元素，snapshot 只看得到 body 的直接子元素。
test("PAGE_WALK 遍历嵌套子元素和 shadow root；snapshot / find / resolve 的 ref 编号一致", async () => {
  class HTMLInputElement {}
  class HTMLTextAreaElement {}
  class HTMLSelectElement {}
  const mk = (tag, children = [], props = {}) =>
    Object.assign(Object.create(tag === "input" ? HTMLInputElement.prototype : Object.prototype), {
      tagName: tag.toUpperCase(),
      children,
      shadowRoot: null,
      innerText: "",
      id: "",
      type: "text",
      labels: [],
      placeholder: "",
      name: "",
      value: "",
      getAttribute: () => null,
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
      matches: (sel) =>
        sel.split(",").some((s) => new RegExp("^" + tag + "(?![\\w-])").test(s.trim())),
      ...props,
    });
  const link = mk("a", [], { innerText: "Learn more", id: "second" });
  const nestedButton = mk("button", [], { innerText: "Click me" });
  const shadowButton = mk("button", [], { innerText: "Shadow btn" });
  const body = mk("body", [
    mk("main", [
      mk("h1", [], { innerText: "Example" }),
      mk("div", [link, mk("p", [nestedButton]), mk("script")]),
    ]),
    mk("input", [], { value: "v" }),
    mk("div", [mk("button", [], { innerText: "Hidden btn" })]), // 不可见：连同子元素一起跳过
    mk("section", [], { shadowRoot: { children: [shadowButton] } }),
  ]);
  globalThis.HTMLInputElement = HTMLInputElement;
  globalThis.HTMLTextAreaElement = HTMLTextAreaElement;
  globalThis.HTMLSelectElement = HTMLSelectElement;
  globalThis.window = { top: null };
  window.top = window;
  // display:none 的父元素：真实浏览器里它的子元素矩形也是 0×0，这里直接一并标成不可见
  const hidden = new Set([body.children[2], body.children[2].children[0]]);
  globalThis.getComputedStyle = (el) => ({ display: hidden.has(el) ? "none" : "block", visibility: "visible", opacity: "1" });
  globalThis.document = { body, title: "t" };
  globalThis.location = { href: "https://example.test/" };
  globalThis.scrollY = 0;
  const walk = (mode, arg, max = 400, startRef = 0) => eval("(" + PAGE_WALK + ")")(mode, arg, max, startRef);

  const snap = walk("snapshot", null);
  assert.deepEqual(
    snap.elements.map((e) => e.tag + (e.ref ? "#" + e.ref : "")),
    ["h1", "a#1", "button#2", "input#3", "button#4"],
    "嵌套三层的 a/button、body 直接子元素 input、shadow root 里的 button 都要出现；不可见的不出现"
  );
  assert.equal(snap.refCount, 4);
  assert.equal(snap.elements[0].text, "Example");

  assert.deepEqual(walk("find", "learn more").matches, [{ ref: 1, tag: "a", text: "learn more second   " }]); // 搜索文本 = 各字段以空格拼接（空字段也占位）
  const resolved = walk("resolve", 2);
  assert.equal(resolved.found && resolved.tag, "button");
  assert.deepEqual([resolved.cx, resolved.cy, resolved.w, resolved.h], [5, 5, 10, 10]);
  assert.equal(walk("resolve", 4).found, true, "shadow root 里的元素按同一套编号解析");
  assert.equal(walk("resolve", 99).found, false);
});

test("resize_window：最大化窗口先回到普通窗口再改尺寸", async () => {
  let win = { id: 9, state: "maximized", width: 2576, height: 1400 };
  const updates = [];
  chrome.windows = { get: async () => win, update: async (id, props) => (updates.push(props), (win = { ...win, ...props })) };
  await dispatchTool(1, "resize_window", { width: 1300, height: 800 });
  assert.deepEqual(updates[0], { width: 1300, height: 800, state: "normal" }, "最大化窗口只传 width/height 不生效（实测），要带 state");
  await dispatchTool(2, "resize_window", { width: 1000, height: 700 });
  assert.deepEqual(updates[1], { width: 1000, height: 700 }, "普通窗口不动 state");
  const last = async (args) => loose((await dispatchTool(3, "resize_window", args)).result).state;
  win = { id: 9, state: "normal", width: 1000, height: 700 };
  assert.equal(await last({ state: "maximized" }), "maximized", "显式 state 优先");
  assert.equal(await last({ state: "minimized" }), "minimized");
  assert.deepEqual(updates.at(-1), { state: "minimized" });
  win = { id: 9, state: "normal", width: 1000, height: 700 };
  await dispatchTool(4, "resize_window", { width: 900, state: "bogus" });
  assert.equal("state" in updates.at(-1) ? updates.at(-1).state : undefined, undefined, "不认识的 state 当没给");
});

test("drag：鼠标事件不返回时（原生 HTML5 拖放）限时报错，而不是挂到 90s", async () => {
  const send = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = (target, method, _params, cb) => {
    if (method === "Input.dispatchMouseEvent") return; // 拖放会话一旦开始就不再回调
    send(target, method, _params, cb);
  };
  const t0 = Date.now();
  try {
    const r = await dispatchTool(1, "drag", { tabId: 5, fromX: 10, fromY: 10, toX: 40, toY: 40 });
    assert.equal(r.ok, false);
    assert.match(r.error, /native HTML5 draggable/);
  } finally {
    chrome.debugger.sendCommand = send;
  }
  assert.ok(Date.now() - t0 < 8000, `应在上限（90s）之前返回，用时 ${Date.now() - t0}ms`);
});

test("drag：按下前清掉文本选区（否则变成原生的拖动选中文字），并识别原生 draggable", async () => {
  const send = chrome.debugger.sendCommand;
  const seq = []; // 调用顺序：evaluate 的表达式 / 鼠标事件类型
  let draggable = false;
  chrome.debugger.sendCommand = (target, method, params, cb) => {
    if (method === "Input.dispatchMouseEvent") seq.push(params.type);
    if (method === "Runtime.evaluate") {
      seq.push(params.expression.slice(0, 40));
      // 页面对"是不是原生 draggable"的回答；带 awaitPromise 的（指示器、清选区之后的等待）照常返回
      return cb({ result: { value: /closest\('\[draggable/.test(params.expression) ? draggable : undefined } });
    }
    return send(target, method, params, cb);
  };
  const args = { tabId: 5, fromX: 10, fromY: 10, toX: 40, toY: 40, steps: 2 };
  try {
    const ok = await dispatchTool(1, "drag", args);
    assert.equal(ok.ok, true, ok.error);
    const press = seq.indexOf("mousePressed");
    assert.ok(seq.indexOf("getSelection().removeAllRanges()") !== -1 && seq.indexOf("getSelection().removeAllRanges()") < press, "清选区要发生在按下之前");
    assert.ok(seq.indexOf("mouseReleased") > press, "鼠标序列完整");
    seq.length = 0;
    draggable = true;
    const bad = await dispatchTool(2, "drag", args);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /native HTML5 draggable/);
    assert.equal(seq.includes("mousePressed"), false, "是原生 draggable 就不发鼠标事件");
  } finally {
    chrome.debugger.sendCommand = send;
  }
});
