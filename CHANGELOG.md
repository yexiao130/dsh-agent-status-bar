# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-11-22

### Added

- Global hide/show hotkey (default `Ctrl+Alt+H`), registered with
  `RegisterHotKey` inside the overlay so it works while any window is focused.
- Settings page section (`client.js`, `settings.section` slot) with a key
  recorder: record or type a combination, save, and see the live registration
  state.
- Settings persisted in `~/.dsh/dsh-agent-status-bar.json`, independent of the
  profile patch, so reinstalling or upgrading keeps the user's choice.
- Host routes `GET /api/dsh-agent-status-bar/state` and
  `POST /api/dsh-agent-status-bar/set`.
- Hotkey conflict reporting: a taken combination surfaces as `hotkeyState: fail`
  in the settings page, and the overlay retries quietly every ~10 s until the
  other app releases it.

### Changed

- `package.json` declares `dsh.client` and exports `./client`, and the version
  moves to 0.3.0.
- Documentation split into English `README.md` and Chinese `README.zh.md`,
  cross-linked at the top of both.
- Install command corrected to `dsh plugin --profile desktop add <spec>`: the
  CLI forwards its arguments to pnpm, so `--profile` must precede the action.
- Full-screen note refreshed: hiding is implemented behind `hideOnFullscreen`,
  so the README now states the real limitation (self-drawn full-screen windows).

## [0.2.0] - 2026-11-20

### Added

- Live thought line: `agent/assistant-stream` `reasoning-delta` frames feed a
  scrolling `思考中` line; `text-delta` frames feed `回答中`.
- Action words per tool (`正在写入文件`, `正在执行命令`, `正在操作桌面`, …) via
  name rules, replacing the generic placeholder during tool calls.
- `maxReasoningChars` config key.
- `test/selfcheck.mjs` plus `npm run selfcheck`: mounts the plugin against a
  fake Context and fires malformed payloads.
- Stability hardening: guarded listeners and activation, defensive payload
  reads, clamped config values, overlay restart backoff (1.5 s → 60 s), 15 s
  ready timeout, lock-file single instance, Host-pid watchdog, layout resync
  on display/DPI changes, protocol version on the UDP channel, self-truncating
  diagnostics.

### Fixed

- A tool-only step commits an `assistant/message` without visible text; the
  reasoning buffer is now kept so the following tool call can display it.
- `WS_EX_TOOLWINDOW` was written as `0x00800000`; the correct value is `0x80`.

## [0.1.0] - 2026-11-20

### Added

- Initial release: a click-through bar above the taskbar that shows the main
  agent's latest answer and its thinking time while another window covers DSH,
  and hides as soon as DSH is focused again.
- Only the main session is followed; subagent sessions are dropped after their
  `subagent/descriptor` event.
- Config keys: `enabled`, `barHeight`, `fontSize`, `doneHoldMs`, `maxChars`,
  `hideOnFullscreen`.
