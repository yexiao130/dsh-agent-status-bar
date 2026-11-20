# dsh-agent-status-bar

[简体中文](README.zh.md) | English

A slim bar pinned just above the Windows taskbar that tells you what the main
agent is doing while another window covers DeepSeek Harness — so you can watch
progress without switching back.

## What you see

| Agent state | Bar content |
| --- | --- |
| Thinking | `思考中` followed by the tail of the live reasoning, plus a `12.4s` counter |
| Calling a tool | The action (`正在写入文件`, `正在执行命令`, …) followed by the last reasoning line, plus the counter |
| Waiting for your approval | `待确认` in red, with the counter |
| Answer produced | The answer text, one line, ellipsized, plus `本轮 12.4s` |
| Idle, or DSH in the foreground | The bar hides itself |

The bar is click-through (`WS_EX_TRANSPARENT`), never takes focus, stays out of
the taskbar and Alt+Tab, and follows the primary display's work area.

## How it works

The DSH Host process cannot create native windows, so the plugin ships a small
PowerShell/WPF overlay (`overlay/statusbar.ps1`):

1. The Host plugin subscribes to `session/event` and folds `turn/start`,
   `tool/call`, `approval/asked`, `assistant/message` and `turn/end` into one
   display state. It also follows `agent/assistant-stream`: `reasoning-delta`
   frames feed the scrolling `思考中` line, `text-delta` frames the `回答中` line,
   and `tool/call` names become the action word (`正在写入文件`, `正在执行命令`, …).
2. It spawns the overlay with `powershell.exe -STA`, learns the overlay's
   loopback UDP port from `PORT=<n>`, and pushes JSON state changes.
3. The overlay polls `GetForegroundWindow` every 150 ms and shows itself only
   when the foreground window belongs to a process other than DSH.

No DSH files are modified, so DSH upgrades do not break the plugin.

## Requirements

- Windows 10 or 11, Windows PowerShell 5.1 (shipped with Windows).
- DeepSeek Harness desktop, or any DSH profile: without a desktop window the
  bar still works and treats "foreground is not DSH" as visible.
- The overlay is pure ASCII on purpose: Windows PowerShell 5.1 decodes a
  BOM-less script as ANSI, and non-ASCII literals break its parser.

## Install

Newer DSH builds install a bundle by its package spec, so a tagged GitHub
release is enough — no npm publish required:

```bash
dsh plugin --profile desktop add github:yexiao130/dsh-agent-status-bar#v0.2.0
```

After a restart, enable **Agent status bar** in **Plugins**, then start a turn
and click another window: the bar appears above the taskbar.

Local development install:

```text
Plugins > Add plugin > choose this directory
```

Once the repository carries the `dsh-plugin` topic it also appears in the
community plugin marketplace, but installing from there needs an npm package;
until then use the `github:` spec above.

## Configuration

Every value is a plugin row config in `cordis.patch.yml`; edit the bundle's patch
or add an override in the profile's own patch layer, then reload the plugin (or
restart DSH).

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Load the plugin but do not start the bar when `false`. |
| `barHeight` | `30` | Bar height in device-independent pixels. |
| `fontSize` | `12` | Text size in DIP; the label and timer use `fontSize - 1`. |
| `doneHoldMs` | `8000` | How long a finished answer stays visible before hiding. |
| `maxChars` | `600` | Answer characters sent to the bar before truncation. |
| `maxReasoningChars` | `160` | Reasoning characters kept on the bar while a step runs. |
| `hideOnFullscreen` | `true` | Hide while a full-screen app owns the foreground. |

## Stability

DSH upgrades replace the Host and its internal event surface; this plugin only
touches that surface from the outside, and treats every input as untrusted.

**What it depends on** (all read defensively):

| Contract | Used for | If it changes |
| --- | --- | --- |
| `session/event` + `turn/start`, `tool/call`, `approval/asked`, `assistant/message`, `turn/end` | The display state machine | Unknown types are ignored; known types with missing fields degrade to the placeholder line |
| `agent/assistant-stream` frames (`reasoning-delta`, `text-delta`) | The scrolling thought/answer line | No frame = the bar keeps the action word and the counter |
| `subagent/descriptor` | Dropping child sessions | Without it the bar may show subagent text |
| `process.ppid` | Which process owns the DSH window | `0` = the bar stays hidden and logs a warning |

**Failure handling**

- All listeners are wrapped: a throwing callback logs and returns, never
  escapes into the Host event bus. `apply()` itself is wrapped too, so a
  broken activation cannot take the Host down.
- Numeric config values are clamped (bar height 16–80, font 8–24, hold
  1–60 s); non-numeric values fall back to defaults.
- Overlay restarts use exponential backoff (1.5 s → 60 s) so a permanently
  broken PowerShell never becomes a restart storm.
- The overlay reports its port within 15 s or it is recycled.
- The overlay exits with code 2 when a second instance is detected; the lock
  file plus pid check prevents two bars stacking.
- The overlay watches the Host pid and retires itself within ~2 s of a Host
  death, so no orphan bar survives a DSH restart or upgrade.
- A newer Host speaking a newer UDP schema is ignored (`v` field) instead of
  being misread.
- Both diagnostic logs self-truncate at 256 KiB.

**Self-check**

`npm run selfcheck` mounts the plugin against a fake Context and fires
malformed payloads (null events, future event types, string content bodies,
non-string tool names, bad config values, a throwing logger). Run it after any
DSH upgrade.

## Limits

- Windows only (the overlay uses Win32 window styles and WPF).
- The bar is drawn on the primary display's work area; multi-display follow is
  not implemented yet.
- Full-screen hiding relies on the foreground window covering its whole
  monitor; a few self-drawn full-screen apps may not be detected.
- Very long answers are truncated to 600 characters before being sent and then
  ellipsized to one line.
- One overlay process per profile; disabling the plugin kills it.

## Privacy

The plugin reads session events locally and writes them only to the overlay's
loopback UDP socket. Nothing leaves the machine. The bar can display file paths
or answer text verbatim while it is visible on screen.
