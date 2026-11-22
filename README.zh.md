# dsh-agent-status-bar

[English](README.md) | 简体中文

任务栏正上方的一条细条：当 DSH 窗口被其他程序挡住时，告诉你主智能体正在做什么，不用切回窗口也能看着进度。

## 你会看到什么

| 智能体状态 | 条上显示 |
| --- | --- |
| 模型在思考 | `思考中` + 它正在想的最后一段话（会滚动）+ 实时秒数 |
| 正在调用工具 | 动作词（`正在写入文件`、`正在执行命令`、`正在操作桌面`…）+ 最后的思考内容 + 实时秒数 |
| 等你确认 | 红色 `待确认` + 秒数 |
| 一段输出完成 | 那段回答（单行、超出省略）+ `本轮 12.4s` |
| 空闲，或 DSH 回到前台 | 条自动隐藏 |

条是鼠标穿透的（`WS_EX_TRANSPARENT`），不会抢焦点，不进任务栏也不进 Alt+Tab，宽度跟随主屏工作区。

## 工作原理

DSH 的宿主进程不能创建原生窗口，所以插件自带一个小小的 PowerShell/WPF 覆盖窗口（`overlay/statusbar.ps1`）：

1. 宿主侧插件订阅 `session/event`，把 `turn/start`、`tool/call`、`approval/asked`、`assistant/message`、`turn/end` 折叠成一个显示状态；同时跟随 `agent/assistant-stream`：`reasoning-delta` 帧喂给滚动的 `思考中` 行，`text-delta` 帧喂给 `回答中` 行，`tool/call` 的工具名映射成动作词。
2. 用 `powershell.exe -STA` 拉起覆盖窗口，从它 stdout 的 `PORT=<n>` 学到本地 UDP 端口，之后用 JSON 推送状态变化。
3. 覆盖窗口每 150 ms 调一次 `GetForegroundWindow`，只有前台窗口不属于 DSH 时才显示自己。

不修改 DSH 的任何文件，所以 DSH 升级不会弄坏插件。

## 系统要求

- Windows 10 或 11，Windows PowerShell 5.1（系统自带）。
- DSH 桌面端，或任意 DSH profile：没有桌面窗口时条仍然工作，只是把「前台不是 DSH」当作可见。
- 覆盖窗口刻意保持纯 ASCII：Windows PowerShell 5.1 会把无 BOM 的脚本按 ANSI 解码，非 ASCII 字面量会直接破坏它的解析器。

## 安装

新版 DSH 按 package spec 安装 bundle，所以只要有一个带标签的 GitHub Release 就够了，不需要发布到 npm：

```bash
dsh plugin --profile desktop add github:yexiao130/dsh-agent-status-bar#v0.2.0
```

重启 DSH 后，在 **插件** 里启用 **智能体状态条**，然后开始一轮对话并点开别的窗口，条就会出现在任务栏上方。

本地开发安装：

```text
插件 > 添加插件 > 选择本目录
```

仓库带上 `dsh-plugin` topic 之后也会出现在社区插件市场里，但从市场点安装需要 npm 包；在那之前请用上面的 `github:` spec。

## 配置

每一项都是 `cordis.patch.yml` 里的插件行配置；改 bundle 自带的 patch，或在 profile 自己的 patch 层里覆盖，然后重新加载插件（或重启 DSH）即可生效。

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 设为 `false` 时插件照常加载，但不启动细条。 |
| `barHeight` | `30` | 细条高度，单位 DIP。 |
| `fontSize` | `12` | 字号，单位 DIP；标签和计时用 `fontSize - 1`。 |
| `doneHoldMs` | `8000` | 一段回答完成后，条继续停留的毫秒数。 |
| `maxChars` | `600` | 传给细条的回答字符上限，超出部分发送前就截掉。 |
| `maxReasoningChars` | `160` | 思考过程中在条上保留的思考字符数。 |
| `hideOnFullscreen` | `true` | 前台是全屏应用时是否隐藏。 |

## 快捷键

一个全局快捷键可以随时隐藏或恢复小条，即使当前焦点在别的窗口上。默认是 `Ctrl+Alt+H`。

在 **设置 → 智能体状态条** 里改（插件会在那里加一个自己的分区）：点 **录制**，按下组合键，再点 **保存**。值存在 `~/.dsh/dsh-agent-status-bar.json`，重装或升级插件都不会丢。

如果组合键已经被别的软件占用，设置页会明确提示，同时覆盖窗口每 10 秒左右会静默重试一次——对方一释放，快捷键就自动能用了。

## 稳定性

DSH 升级会替换宿主和它的内部事件面；插件只从外部接触这个面，并且把每个输入都当成不可信的。

**依赖的契约**（全部做防御式读取）：

| 契约 | 用途 | 它变了的后果 |
| --- | --- | --- |
| `session/event` 及 `turn/start`、`tool/call`、`approval/asked`、`assistant/message`、`turn/end` | 显示状态机 | 未知类型直接忽略；已知类型缺字段时降级成占位文案 |
| `agent/assistant-stream` 的 `reasoning-delta`、`text-delta` | 滚动的思考/回答行 | 没有帧就保留动作词和计时 |
| `subagent/descriptor` | 丢弃子会话 | 没有它时条可能显示子智能体的文字 |
| `process.ppid` | 判断哪个进程持有 DSH 窗口 | 为 `0` 时条保持隐藏并记一条警告 |

**故障处理**

- 所有监听器都包了异常：回调抛错只记日志然后返回，不会冒进宿主的事件总线。`apply()` 本身也包了，激活失败不会把宿主带崩。
- 数值配置会被夹取（条高 16–80、字号 8–24、停留 1–60 秒），非数字回退默认值。
- 覆盖窗口重启采用指数退避（1.5 秒 → 60 秒），永久坏掉的 PowerShell 不会变成重启风暴。
- 覆盖窗口 15 秒内报不出端口就会被回收。
- 检测到第二个实例时覆盖窗口以退出码 2 退出；锁文件加 pid 检查防止两条叠加。
- 覆盖窗口盯住宿主 pid，宿主死后约 2 秒内自我退休，DSH 重启或升级不会留下孤儿条。
- 宿主若使用更新的 UDP 协议，旧覆盖窗口会按 `v` 字段忽略消息，而不是误读。
- 两份诊断日志都在 256 KiB 处自我截断。

**自检**

`npm run selfcheck` 会把插件挂到一个假 Context 上，然后喂进畸形载荷（null 事件、未来才有的类型、字符串形式的正文、非字符串工具名、坏配置、会抛异常的 logger）。DSH 每次升级后都该跑一遍。

## 已知限制

- 仅 Windows（覆盖窗口用到 Win32 窗口样式和 WPF）。
- 条画在主屏的工作区底部，多显示器跟随还没实现。
- 超过 600 字的回答会先被截断，再按单行省略号显示。
- 每个 profile 一个覆盖窗口进程；禁用插件会结束它。

## 隐私

插件只在本地读取会话事件，并且只写到覆盖窗口的本地回环 UDP 套接字，没有任何数据离开这台机器。条在屏幕上的那几秒可能原样显示文件路径或回答内容。
