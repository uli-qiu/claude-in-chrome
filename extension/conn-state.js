// host 连接状态（host-link 写，tools/background/popup 读——避免模块间循环引用）

export const connState = {
  hostUp: false, // native messaging port 是否打开（host.exe 进程在）
  connected: false, // host.exe 到 MCP server 的 TCP 是否在连；工具应答只有这时才送得出去
};
