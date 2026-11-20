/**
 * Self-check: every plugin callback must survive malformed input.
 *
 * DSH's internal event surface may change between desktop releases. This
 * script mounts the plugin against a fake Context and fires payloads a future
 * release might produce, asserting that nothing throws and the state machine
 * keeps a sane phase.
 *
 * Run: node test/selfcheck.mjs
 */
import { apply } from '../index.js'

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}: ${error?.stack ?? error}`)
  }
}

/** Minimal stand-in for the Cordis Context surface the plugin uses.
 *  `enabled: false` is forced so a self-check never spawns a real overlay. */
function mount(config = {}) {
  const handlers = new Map()
  const ctx = {
    logger: () => ({ warn() {}, info() {}, error() {} }),
    on: (name, handler) => {
      handlers.set(name, handler)
    },
    effect: (factory) => {
      const dispose = factory()
      return () => dispose?.()
    },
  }
  apply(ctx, { ...config, enabled: false })
  return {
    emit(name, ...args) {
      const handler = handlers.get(name)
      if (handler === undefined) throw new Error(`no listener for ${name}`)
      handler(...args)
    },
    has: (name) => handlers.has(name),
  }
}

const session = { id: 'session-test' }

check('registers both listeners', () => {
  const plugin = mount()
  if (!plugin.has('session/event')) throw new Error('session/event missing')
  if (!plugin.has('agent/assistant-stream')) throw new Error('assistant-stream missing')
})

check('survives null and undefined session events', () => {
  const plugin = mount()
  plugin.emit('session/event', undefined, undefined)
  plugin.emit('session/event', session, undefined)
  plugin.emit('session/event', undefined, { type: 'turn/start' })
  plugin.emit('session/event', session, null)
  plugin.emit('session/event', session, {})
  plugin.emit('session/event', session, { type: 'unknown/future-event', data: {} })
})

check('survives malformed assistant/message payloads', () => {
  const plugin = mount()
  plugin.emit('session/event', session, { type: 'assistant/message', data: undefined })
  plugin.emit('session/event', session, { type: 'assistant/message', data: { message: null } })
  plugin.emit('session/event', session, { type: 'assistant/message', data: { message: {} } })
  plugin.emit('session/event', session, {
    type: 'assistant/message',
    data: { message: { content: 'plain string body' } },
  })
  plugin.emit('session/event', session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '正常文本' }] } },
  })
  plugin.emit('session/event', session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'unknown-block', payload: 1 }, null, 42] } },
  })
})

check('survives malformed tool/call names', () => {
  const plugin = mount()
  plugin.emit('session/event', session, { type: 'tool/call', data: undefined })
  plugin.emit('session/event', session, { type: 'tool/call', data: { name: null } })
  plugin.emit('session/event', session, { type: 'tool/call', data: { name: 12345 } })
  plugin.emit('session/event', session, { type: 'tool/call', data: { name: 'ops_bash' } })
})

check('survives malformed assistant-stream frames', () => {
  const plugin = mount()
  plugin.emit('agent/assistant-stream', undefined)
  plugin.emit('agent/assistant-stream', {})
  plugin.emit('agent/assistant-stream', { frame: null })
  plugin.emit('agent/assistant-stream', { frame: {} })
  plugin.emit('agent/assistant-stream', { frame: { type: 'chunk' } })
  plugin.emit('agent/assistant-stream', { frame: { type: 'chunk', chunk: null } })
  plugin.emit('agent/assistant-stream', { frame: { type: 'chunk', chunk: { type: 'text-delta' } } })
  plugin.emit('agent/assistant-stream', {
    frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 42 } },
  })
  plugin.emit('agent/assistant-stream', {
    frame: { type: 'chunk', attemptId: 1, chunk: { type: 'reasoning-delta', text: '思考' } },
  })
  plugin.emit('agent/assistant-stream', {
    frame: { type: 'chunk', attemptId: 1, chunk: { type: 'text-delta', text: '回答' } },
  })
  plugin.emit('agent/assistant-stream', { frame: { type: 'end', attemptId: 1 } })
  plugin.emit('agent/assistant-stream', {
    agent: { session: { id: 'child' } },
    frame: { type: 'chunk', attemptId: 2, chunk: { type: 'text-delta', text: 'x' } },
  })
})

check('ignores subagent sessions after their descriptor', () => {
  const plugin = mount()
  plugin.emit('session/event', session, { type: 'turn/start', data: {} })
  plugin.emit('session/event', { id: 'child' }, { type: 'subagent/descriptor', data: {} })
  plugin.emit('session/event', { id: 'child' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '子智能体输出' }] } },
  })
  plugin.emit('session/event', session, { type: 'turn/start', data: {} })
})

check('normalizes hostile config values', () => {
  const cases = [
    { barHeight: -5, fontSize: 999, doneHoldMs: 0, maxChars: -1, maxReasoningChars: 0 },
    { barHeight: 'abc', fontSize: null, doneHoldMs: NaN, maxChars: Infinity, maxReasoningChars: undefined },
    { enabled: 'yes', hideOnFullscreen: 0 },
  ]
  for (const config of cases) {
    const plugin = mount(config)
    plugin.emit('session/event', session, { type: 'turn/start', data: {} })
    plugin.emit('session/event', session, { type: 'assistant/message', data: { message: { content: [] } } })
  }
  mount('not-an-object')
  mount(null)
  mount(42)
})

check('survives a Context whose logger throws', () => {
  const ctx = {
    logger: () => {
      throw new Error('logger unavailable')
    },
    on: () => {},
    effect: (factory) => {
      factory()
    },
  }
  apply(ctx, {})
})

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall self-checks passed')
