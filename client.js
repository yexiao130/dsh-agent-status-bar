// dsh-agent-status-bar — 浏览器半 / browser half
//
// 注册一个设置页分区（settings.section）：自定义「隐藏/显示小条」的全局快捷键。
// 所有读写走宿主路由 /api/dsh-agent-status-bar/*，改完立即生效（不需要重启宿主）。
//
// 契约：
//   window.__ModuleLoader__.load({ id, factory(require) }) —— id 必须是包名
//   不 require 任何 @deepseek-ai/dsh-client-* 包；React 从 browser module table 取
//   样式只用 --dsw-alias-* 主题 token，且都带 fallback
window.__ModuleLoader__.load({
  id: 'dsh-agent-status-bar',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const API = '/api/dsh-agent-status-bar'
    const POLL_MS = 3000
    const NS = 'agentStatusBar'

    const DICTS = {
      zh: {
        nav: '智能体状态条',
        title: '智能体状态条',
        desc: '小条在任务栏上方显示主智能体的进度。这里设置一个全局快捷键，用来随时隐藏或恢复它。',
        'field.label': '隐藏/显示快捷键',
        'field.hint': '点「录制」后直接按组合键，至少包含一个修饰键（Ctrl / Alt / Shift / Win）。',
        'field.placeholder': '例如 Ctrl+Alt+H',
        record: '录制',
        recording: '请按下组合键…',
        save: '保存',
        saving: '保存中…',
        reset: '恢复默认',
        'state.ok': '已生效：{hotkey} 可以隐藏/恢复小条',
        'state.fail': '注册失败：{hotkey} 可能已被其他软件占用，换一个组合键试试',
        'state.invalid': '组合键无效，未注册',
        'state.pending': '正在应用…',
        'state.unknown': '尚未注册热键',
        'state.offline': '小条进程没有运行（插件被禁用，或当前不在桌面端）',
        'msg.saved': '已保存',
        'msg.savedWait': '已保存，正在应用新快捷键…',
        'msg.invalid': '组合键无效：需要至少一个修饰键加一个字母、数字或 F1–F12',
        'msg.saveFailed': '保存失败：{error}',
        'msg.connect': '无法连接宿主：{error}',
        foot: '设置保存在 ~/.dsh/dsh-agent-status-bar.json，重装或升级插件都不会丢。',
      },
      en: {
        nav: 'Agent status bar',
        title: 'Agent status bar',
        desc: 'The bar shows the main agent’s progress above the taskbar. Set a global hotkey here to hide or restore it at any time.',
        'field.label': 'Hide/show hotkey',
        'field.hint': 'Click Record, then press the combination. At least one modifier (Ctrl / Alt / Shift / Win) is required.',
        'field.placeholder': 'e.g. Ctrl+Alt+H',
        record: 'Record',
        recording: 'Press the combination…',
        save: 'Save',
        saving: 'Saving…',
        reset: 'Reset to default',
        'state.ok': 'Active: {hotkey} hides and restores the bar',
        'state.fail': 'Registration failed: {hotkey} may be taken by another app — try another combination',
        'state.invalid': 'Invalid combination; not registered',
        'state.pending': 'Applying…',
        'state.unknown': 'Hotkey not registered yet',
        'state.offline': 'The bar process is not running (plugin disabled, or not on desktop)',
        'msg.saved': 'Saved',
        'msg.savedWait': 'Saved; applying the new hotkey…',
        'msg.invalid': 'Invalid combination: use at least one modifier plus a letter, digit or F1–F12',
        'msg.saveFailed': 'Save failed: {error}',
        'msg.connect': 'Cannot reach the Host: {error}',
        foot: 'Stored in ~/.dsh/dsh-agent-status-bar.json; survives reinstall and upgrades.',
      },
    }

    let t = (key) => key

    const C = {
      text: 'var(--dsw-alias-text-primary, #1f2328)',
      dim: 'var(--dsw-alias-text-secondary, #6b7280)',
      border: 'var(--dsw-alias-border-subtle, #e5e7eb)',
      bg: 'var(--dsw-alias-bg-elevated, #ffffff)',
      accent: 'var(--dsw-alias-text-link, #2563eb)',
      radius: 'var(--dsw-alias-radius-sm, 6px)',
    }

    const S = {
      card: {
        border: '1px solid ' + C.border,
        borderRadius: C.radius,
        background: C.bg,
        padding: '14px 16px',
        display: 'grid',
        gap: '10px',
        fontFamily: 'inherit',
      },
      head: { display: 'flex', alignItems: 'baseline', gap: '8px' },
      title: { fontSize: '13px', fontWeight: 600, color: C.text },
      desc: { fontSize: '12px', color: C.dim, margin: 0, lineHeight: 1.5 },
      label: { fontSize: '12px', fontWeight: 600, color: C.text },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      input: {
        flex: '1 1 180px',
        minWidth: '160px',
        padding: '6px 10px',
        fontSize: '13px',
        color: C.text,
        background: 'transparent',
        border: '1px solid ' + C.border,
        borderRadius: C.radius,
        outline: 'none',
      },
      button: {
        padding: '6px 12px',
        fontSize: '12px',
        color: C.text,
        background: 'transparent',
        border: '1px solid ' + C.border,
        borderRadius: C.radius,
        cursor: 'pointer',
      },
      primary: {
        padding: '6px 14px',
        fontSize: '12px',
        color: '#fff',
        background: C.accent,
        border: '1px solid ' + C.accent,
        borderRadius: C.radius,
        cursor: 'pointer',
      },
      hint: { fontSize: '11px', color: C.dim, margin: 0, lineHeight: 1.5 },
      ok: { fontSize: '12px', color: 'var(--dsw-alias-text-success, #1a7f37)', margin: 0 },
      bad: { fontSize: '12px', color: 'var(--dsw-alias-text-danger, #cf222e)', margin: 0 },
    }

    function describeState(status) {
      if (!status) return null
      if (status.overlayRunning === false) return { bad: true, text: t('state.offline') }
      const hotkey = status.hotkey || ''
      const state = status.hotkeyState || 'unknown'
      if (state === 'ok') return { bad: false, text: t('state.ok').replace('{hotkey}', hotkey) }
      if (state === 'fail') return { bad: true, text: t('state.fail').replace('{hotkey}', hotkey) }
      if (state === 'invalid') return { bad: true, text: t('state.invalid') }
      if (state === 'pending') return { bad: false, text: t('state.pending') }
      return { bad: false, text: t('state.unknown') }
    }

    function SettingsCard() {
      const [status, setStatus] = useState(null)
      const [draft, setDraft] = useState('')
      const [recording, setRecording] = useState(false)
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState(null)

      const refresh = useCallback(async () => {
        try {
          const res = await fetch(API + '/state', { cache: 'no-store' })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          const data = await res.json()
          setStatus(data)
          setDraft((current) => (current === '' || current === data.hotkey ? data.hotkey : current))
        } catch (error) {
          setMessage({ bad: true, text: t('msg.connect').replace('{error}', String(error.message || error)) })
        }
      }, [])

      useEffect(() => {
        refresh()
        const timer = setInterval(() => {
          if (!document.hidden) refresh()
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [refresh])

      const captureKey = (event) => {
        if (!recording) return
        event.preventDefault()
        const parts = []
        if (event.ctrlKey) parts.push('Ctrl')
        if (event.altKey) parts.push('Alt')
        if (event.shiftKey) parts.push('Shift')
        if (event.metaKey) parts.push('Win')
        const key = event.key
        if (key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') return
        if (/^[a-zA-Z0-9]$/.test(key)) parts.push(key.toUpperCase())
        else if (/^F([1-9]|1[0-2])$/.test(key)) parts.push(key.toUpperCase())
        else return
        if (parts.length < 2) return
        setDraft(parts.join('+'))
        setRecording(false)
        setMessage(null)
      }

      const save = async (value) => {
        setBusy(true)
        setMessage(null)
        try {
          const res = await fetch(API + '/set', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ hotkey: value }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok || data.ok !== true) {
            const reason = data.error === 'invalid-hotkey' ? t('msg.invalid') : String(data.error || res.status)
            setMessage({ bad: true, text: t('msg.saveFailed').replace('{error}', reason) })
            return
          }
          setDraft(data.hotkey)
          setMessage({ bad: false, text: t('msg.savedWait') })
          refresh()
        } catch (error) {
          setMessage({ bad: true, text: t('msg.saveFailed').replace('{error}', String(error.message || error)) })
        } finally {
          setBusy(false)
        }
      }

      const state = describeState(status)

      return h(
        'div',
        { style: S.card },
        h('div', { style: S.head }, h('span', { style: S.title }, t('title'))),
        h('p', { style: S.desc }, t('desc')),
        h('div', { style: S.label }, t('field.label')),
        h(
          'div',
          { style: S.row },
          h('input', {
            style: S.input,
            value: recording ? '' : draft,
            placeholder: recording ? t('recording') : t('field.placeholder'),
            readOnly: recording,
            onKeyDown: captureKey,
            onFocus: () => setRecording(true),
            onBlur: () => setRecording(false),
            'aria-label': t('field.label'),
          }),
          h(
            'button',
            {
              type: 'button',
              style: S.button,
              onClick: () => setRecording((current) => !current),
            },
            recording ? t('recording') : t('record'),
          ),
          h(
            'button',
            { type: 'button', style: S.primary, disabled: busy, onClick: () => save(draft) },
            busy ? t('saving') : t('save'),
          ),
          h(
            'button',
            {
              type: 'button',
              style: S.button,
              disabled: busy || !status,
              onClick: () => save(status && status.defaultHotkey ? status.defaultHotkey : 'Ctrl+Alt+H'),
            },
            t('reset'),
          ),
        ),
        h('p', { style: S.hint }, t('field.hint')),
        state ? h('p', { style: state.bad ? S.bad : S.ok }, state.text) : null,
        message ? h('p', { style: message.bad ? S.bad : S.ok }, message.text) : null,
        h('p', { style: S.hint }, t('foot')),
      )
    }

    function contribute(ctx, key, options, Component, what) {
      const fail = (error) => console.error('[dsh-agent-status-bar] could not register ' + what + ':', error)
      try {
        return ctx.slots.inject(key, () => {
          try {
            return ctx.slots.register(options, Component)
          } catch (error) {
            fail(error)
            return () => {}
          }
        })
      } catch (error) {
        fail(error)
        return () => {}
      }
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      if (ctx.locale && typeof ctx.locale.register === 'function' && typeof ctx.locale.bind === 'function') {
        ctx.effect(() => ctx.locale.register(NS, DICTS), 'agent-status-bar-dicts')
        t = ctx.locale.bind(NS)
      }
      ctx.effect(
        () =>
          contribute(
            ctx,
            'settings.section',
            { name: 'settings.section', id: 'agent-status-bar', order: 260, locale: NS, label: () => t('nav') },
            SettingsCard,
            'settings.section',
          ),
        'agent-status-bar-settings-section',
      )
    }

    return { inject, apply }
  },
})
