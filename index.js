/**
 * agent-status-bar — broadcasts the main agent's live work to a slim bar.
 *
 * Stability contract: this plugin reads DSH's internal event surface
 * (`session/event`, `agent/assistant-stream`) which may change between desktop
 * releases. Every callback here is guarded, every payload is read
 * defensively, and a bad payload degrades the bar instead of throwing into the
 * Host. The Host process cannot create native windows, so a PowerShell/WPF
 * overlay (shipped in ./overlay) draws the bar and decides visibility from the
 * real foreground window.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, statSync, writeFileSync } from 'node:fs'
import { createSocket } from 'node:dgram'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const overlayScript = join(here, 'overlay', 'statusbar.ps1')
const HOST_LOG = join(tmpdir(), 'dsh-status-bar-host.log')
const LOG_LIMIT_BYTES = 256 * 1024

/** UDP message schema version, agreed with overlay/statusbar.ps1. */
const PROTOCOL_VERSION = 1

/** Defaults; every key is a plugin row config in cordis.patch.yml. */
const DEFAULT_CONFIG = {
  enabled: true,
  barHeight: 30,
  fontSize: 12,
  doneHoldMs: 8000,
  maxChars: 600,
  maxReasoningChars: 160,
  hideOnFullscreen: true,
}

/** Accepted range per numeric key; anything else falls back to the default. */
const CONFIG_BOUNDS = {
  barHeight: [16, 80],
  fontSize: [8, 24],
  doneHoldMs: [1000, 60000],
  maxChars: [50, 2000],
  maxReasoningChars: [20, 400],
}

/** Restart backoff for the overlay subprocess. */
const RESTART_BASE_MS = 1500
const RESTART_MAX_MS = 60000
/** How long the overlay may take to report its port before we recycle it. */
const READY_TIMEOUT_MS = 15000
/** Exit code the overlay uses when another instance already owns the port. */
const EXIT_ALREADY_RUNNING = 2

/** What the agent is doing, matched against real tool names. Order matters. */
const TOOL_ACTION_RULES = [
  [/^mcp__windows__|desktop/, '正在操作桌面'],
  [/ask_user_question|question/, '正在向你提问'],
  [/subagent|agent_team|send_message|wait_agent/, '正在协调子智能体'],
  [/plugin_manager|plugin/, '正在管理插件'],
  [/skill/, '正在加载技能'],
  [/workflow/, '正在编排任务'],
  [/present/, '正在准备交付'],
  [/office|docx|xlsx|pptx|libreoffice/, '正在处理文档'],
  [/web_fetch|scrape|http/, '正在读取网页'],
  [/web_search|search/, '正在搜索内容'],
  [/bash|pwsh|terminal|shell|job_|exec/, '正在执行命令'],
  [/write/, '正在写入文件'],
  [/edit|replace/, '正在修改文件'],
  [/inspect|read/, '正在读取文件'],
  [/glob/, '正在查找文件'],
  [/grep/, '正在搜索内容'],
  [/schedule/, '正在处理定时任务'],
  [/goal/, '正在处理目标'],
  [/todo/, '正在更新计划'],
  [/discover/, '正在查找能力'],
]

function diagnostics(message) {
  try {
    let size = 0
    try {
      size = statSync(HOST_LOG).size
    } catch {
      size = 0
    }
    if (size > LOG_LIMIT_BYTES) writeFileSync(HOST_LOG, '')
    appendFileSync(HOST_LOG, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Diagnostics must never break the plugin.
  }
}

function describeError(error) {
  if (error instanceof Error) return error.stack ?? error.message
  return String(error)
}

/** Map a tool name to a short Chinese action phrase. */
function describeTool(name) {
  try {
    const lower = String(name ?? '').toLowerCase()
    for (const [pattern, phrase] of TOOL_ACTION_RULES) {
      if (pattern.test(lower)) return phrase
    }
  } catch {
    // An exotic tool name must not break the bar.
  }
  return '正在调用工具'
}

/** Flatten any text-ish value to one line. */
function flatten(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** Keep the newest end of a growing stream, flattened to one line. */
function streamTail(text, limit) {
  const flat = flatten(text)
  if (!flat) return ''
  if (flat.length <= limit) return flat
  return `…${flat.slice(-limit)}`
}

/**
 * Read visible text from a provider message. Tolerates a plain string body and
 * unknown block types so a future content shape degrades to "no text".
 */
function extractText(message, limit) {
  try {
    if (message === undefined || message === null) return ''
    const content = message.content
    if (typeof content === 'string') return flatten(content).slice(0, limit)
    if (!Array.isArray(content)) return ''
    const parts = []
    for (const block of content) {
      if (block === undefined || block === null) continue
      if (typeof block === 'string') {
        parts.push(block)
        continue
      }
      if (typeof block.text === 'string' && block.text.trim()) parts.push(block.text)
    }
    return flatten(parts.join(' ')).slice(0, limit)
  } catch (error) {
    diagnostics(`extractText failed: ${describeError(error)}`)
    return ''
  }
}

/** Coerce one config value into a safe number inside its bounds. */
function readNumber(raw, key, fallback) {
  const value = Number(raw?.[key])
  const bounds = CONFIG_BOUNDS[key]
  if (!Number.isFinite(value)) return fallback
  if (bounds === undefined) return value
  return Math.min(bounds[1], Math.max(bounds[0], value))
}

/** Normalize the row config; bad values fall back instead of failing activation. */
function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const config = {
    enabled: source.enabled === undefined ? DEFAULT_CONFIG.enabled : Boolean(source.enabled),
    hideOnFullscreen:
      source.hideOnFullscreen === undefined
        ? DEFAULT_CONFIG.hideOnFullscreen
        : Boolean(source.hideOnFullscreen),
  }
  for (const key of Object.keys(CONFIG_BOUNDS)) {
    config[key] = readNumber(source, key, DEFAULT_CONFIG[key])
  }
  return config
}

/** Register a listener that can never throw into the Host event bus. */
function safeOn(ctx, name, handler) {
  try {
    ctx.on(name, (...args) => {
      try {
        handler(...args)
      } catch (error) {
        diagnostics(`listener "${name}" failed: ${describeError(error)}`)
      }
    })
  } catch (error) {
    diagnostics(`subscribe "${name}" failed: ${describeError(error)}`)
  }
}

export function apply(ctx, rawConfig) {
  try {
    setup(ctx, rawConfig)
  } catch (error) {
    // Activation must never take the Host down; report and stay inert.
    diagnostics(`apply failed: ${describeError(error)}`)
    try {
      ctx.logger('agent-status-bar').warn(`activation failed: ${describeError(error)}`)
    } catch {
      // Logger itself may be unavailable; the diagnostics file has it.
    }
  }
}

function setup(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const dshPid = Number(process.ppid) > 0 ? Number(process.ppid) : 0
  const logger = ctx.logger('agent-status-bar')

  /** Mirrors what the bar should render; timestamps let the bar tick locally. */
  let state = { phase: 'idle', label: '空闲', text: '', since: 0, elapsed: 0 }
  /** Sessions proven to belong to a subagent; their events never reach the bar. */
  const childSessions = new Set()
  let activeSession = null

  /** Live reasoning and answer text of the current attempt. */
  let reasoning = ''
  let answerText = ''
  let attempt = null

  let child
  let socket
  let port = 0
  let disposed = false
  let restartAttempts = 0
  let restartTimer
  let readyTimer

  let lastPublishAt = 0
  let publishTimer

  diagnostics(
    `activate: protocol=${PROTOCOL_VERSION} dshPid=${dshPid} electron=${String(process.versions?.electron)} config=${JSON.stringify(config)}`,
  )
  if (dshPid === 0) {
    diagnostics('parent pid unavailable; the bar stays hidden without a desktop window')
  }

  const publish = () => {
    try {
      lastPublishAt = Date.now()
      if (!socket || !port) return
      const payload = Buffer.from(
        JSON.stringify({ type: 'state', v: PROTOCOL_VERSION, ...state, dshPid }),
        'utf8',
      )
      socket.send(payload, port, '127.0.0.1', () => {})
    } catch (error) {
      diagnostics(`publish failed: ${describeError(error)}`)
    }
  }

  const publishThrottled = () => {
    if (publishTimer) return
    const wait = Math.max(0, 220 - (Date.now() - lastPublishAt))
    if (wait === 0) {
      publish()
      return
    }
    publishTimer = setTimeout(() => {
      publishTimer = undefined
      publish()
    }, wait)
  }

  const setPhase = (phase, patch = {}) => {
    const now = Date.now()
    const working = phase === 'thinking' || phase === 'working' || phase === 'approval'
    const wasWorking = state.phase === 'thinking' || state.phase === 'working' || state.phase === 'approval'
    if (working && !wasWorking) {
      state = { ...state, phase, since: now, elapsed: 0, ...patch }
    } else if (working) {
      state = { ...state, phase, ...patch }
    } else if (phase === 'done') {
      const elapsed = state.since ? now - state.since : state.elapsed
      state = { ...state, phase, since: 0, elapsed, ...patch }
    } else {
      state = { ...state, phase, since: 0, ...patch }
    }
    publish()
  }

  /** The one live line: reasoning first, then streamed answer text. */
  const liveLine = (limit) => {
    const thoughts = streamTail(reasoning, limit)
    if (thoughts) return { text: thoughts, label: '思考中' }
    const answer = streamTail(answerText, limit)
    if (answer) return { text: answer, label: '回答中' }
    return null
  }

  const clearRestart = () => {
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = undefined
    }
  }

  const scheduleRestart = () => {
    if (disposed) return
    clearRestart()
    const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** restartAttempts)
    restartAttempts = Math.min(restartAttempts + 1, 8)
    diagnostics(`overlay restart in ${delay}ms (attempt ${restartAttempts})`)
    restartTimer = setTimeout(startOverlay, delay)
  }

  const killOverlay = () => {
    if (readyTimer) {
      clearTimeout(readyTimer)
      readyTimer = undefined
    }
    if (child === undefined) return
    const victim = child
    child = undefined
    port = 0
    try {
      victim.kill()
    } catch {
      // Already gone.
    }
  }

  const startOverlay = () => {
    if (disposed) return
    if (!config.enabled) {
      diagnostics('overlay disabled by config')
      return
    }
    if (socket === undefined) socket = createSocket('udp4')
    killOverlay()

    const env = { ...process.env, DSH_STATUS_BAR_DSH_PID: String(dshPid) }
    env.DSH_STATUS_BAR_HOST_PID = String(process.pid)
    env.DSH_STATUS_BAR_CONFIG = JSON.stringify({
      barHeight: config.barHeight,
      fontSize: config.fontSize,
      doneHoldMs: config.doneHoldMs,
      hideOnFullscreen: config.hideOnFullscreen,
    })
    diagnostics(`spawn overlay ${overlayScript}`)
    let proc
    try {
      proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', overlayScript],
        { cwd: join(here, 'overlay'), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      )
    } catch (error) {
      diagnostics(`spawn failed: ${describeError(error)}`)
      logger.warn(`overlay spawn failed: ${describeError(error)}`)
      scheduleRestart()
      return
    }
    child = proc

    readyTimer = setTimeout(() => {
      diagnostics(`overlay did not report a port within ${READY_TIMEOUT_MS}ms; recycling`)
      killOverlay()
      scheduleRestart()
    }, READY_TIMEOUT_MS)

    let buffer = ''
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk) => {
      try {
        buffer += String(chunk)
        let index
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          const match = /^PORT=(\d+)$/.exec(line)
          if (match !== null) {
            port = Number(match[1])
            restartAttempts = 0
            if (readyTimer) {
              clearTimeout(readyTimer)
              readyTimer = undefined
            }
            diagnostics(`overlay listening on ${port}`)
            publish()
          }
        }
      } catch (error) {
        diagnostics(`stdout parse failed: ${describeError(error)}`)
      }
    })
    proc.stderr?.on('data', (chunk) => {
      try {
        diagnostics(`overlay stderr: ${flatten(String(chunk)).slice(0, 500)}`)
      } catch {
        // Ignore.
      }
    })
    proc.once('error', (error) => {
      diagnostics(`overlay process error: ${describeError(error)}`)
    })
    proc.once('exit', (code) => {
      if (child === proc) {
        child = undefined
        port = 0
      }
      if (readyTimer) {
        clearTimeout(readyTimer)
        readyTimer = undefined
      }
      if (disposed) return
      diagnostics(`overlay exited code=${String(code)}`)
      if (code === EXIT_ALREADY_RUNNING) {
        // Another instance still owns the port; let its watchdog retire it.
        restartAttempts = Math.max(restartAttempts, 2)
      }
      scheduleRestart()
    })
  }

  ctx.effect(() => {
    startOverlay()
    return () => {
      disposed = true
      clearRestart()
      if (publishTimer) {
        clearTimeout(publishTimer)
        publishTimer = undefined
      }
      if (readyTimer) {
        clearTimeout(readyTimer)
        readyTimer = undefined
      }
      try {
        socket?.close()
      } catch {
        // Socket may already be closed.
      }
      socket = undefined
      try {
        child?.kill()
      } catch {
        // The overlay may already be gone.
      }
      child = undefined
      diagnostics('plugin disposed')
    }
  })

  // Live reasoning and answer text arrive as transient stream frames.
  let streamFrames = 0
  safeOn(ctx, 'agent/assistant-stream', (payload) => {
    const frame = payload?.frame
    if (frame === null || typeof frame !== 'object') return
    const sessionId = payload?.agent?.session?.id
    if (sessionId !== undefined && childSessions.has(sessionId)) return

    if (frame.type === 'start') {
      reasoning = ''
      answerText = ''
      attempt = frame.attemptId ?? '__none__'
      if (state.phase !== 'thinking') setPhase('thinking', { label: '思考中', text: '正在思考…' })
      return
    }
    if (frame.type !== 'chunk') return

    const chunk = frame.chunk
    if (chunk === null || typeof chunk !== 'object') return

    const attemptKey = frame.attemptId ?? '__none__'
    if (attempt !== attemptKey) {
      reasoning = ''
      answerText = ''
      attempt = attemptKey
    }

    if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      reasoning += chunk.text
      if (reasoning.length > 8000) reasoning = reasoning.slice(-4000)
    } else if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      answerText += chunk.text
      if (answerText.length > 8000) answerText = answerText.slice(-4000)
    } else {
      return
    }

    streamFrames += 1
    if (streamFrames === 1) diagnostics('stream frames flowing')

    const live = liveLine(config.maxReasoningChars)
    if (live === null) return
    if (state.phase !== 'thinking') state.phase = 'thinking'
    state.label = live.label
    state.text = live.text
    publishThrottled()
  })

  safeOn(ctx, 'session/event', (session, event) => {
    const sessionId = session?.id
    if (sessionId === undefined || event === null || typeof event !== 'object') return
    const type = event.type

    // A subagent announces itself inside its own session; stop following it.
    if (type === 'subagent/descriptor') {
      childSessions.add(sessionId)
      diagnostics(`child session detected: ${String(sessionId)}`)
      if (activeSession === sessionId) {
        activeSession = null
        reasoning = ''
        answerText = ''
        setPhase('idle', { label: '空闲', text: '' })
      }
      return
    }
    if (childSessions.has(sessionId)) return
    activeSession = sessionId

    switch (type) {
      case 'turn/start':
        reasoning = ''
        answerText = ''
        attempt = null
        setPhase('thinking', { label: '思考中', text: '正在思考…' })
        break
      case 'tool/call': {
        const action = describeTool(event.data?.name)
        const live = liveLine(config.maxReasoningChars)
        setPhase('working', { label: action, text: live ? live.text : '正在调用工具…' })
        break
      }
      case 'approval/asked':
        setPhase('approval', { label: '待确认', text: '等待你的确认' })
        break
      case 'assistant/message': {
        const text = extractText(event.data?.message, config.maxChars)
        // A tool-only step commits an assistant message without visible text;
        // keep the reasoning so the following tool call can show it.
        if (!text) break
        reasoning = ''
        answerText = ''
        setPhase('done', { label: '已完成', text })
        break
      }
      case 'turn/end':
        reasoning = ''
        answerText = ''
        if (state.phase === 'thinking' || state.phase === 'working' || state.phase === 'approval') {
          setPhase('done', { label: '已完成', text: state.text })
        }
        break
      default:
        break
    }
  })
}
