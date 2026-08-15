// dsh Desktop — notification client plugin, browser half.
//
// Classic-script bundle served by dsh web under /plugins/<id>/client.js and
// registered through window.__ModuleLoader__.load (the dsh client module
// system). Watches the sessions snapshot:
//   - pendingInteraction appears  -> "dsh needs you" notification (question /
//     approval / plan-review);
//   - completed turns true        -> "task done" notification.
// Skips notifying while the window is focused and visible.
//
// Delivery: plain-HTTP bridge to the Tauri shell. Tauri v2 does NOT inject
// __TAURI__ into remote pages (tauri#11934), so no tauri event/notification
// API is reachable from dsh's page. Instead the shell runs a tiny loopback
// HTTP server (127.0.0.1:<port>/notify, CORS-open) and the manager bakes the
// port into this script (replacing __DSH_BRIDGE_PORT__); on load the page
// pings /alive as a diagnostic canary (no toast).
window.__ModuleLoader__.load({
  id: '@dsh-desktop/client-notifications',
  factory: () => {
    const PENDING_LABELS = {
      question: '有一个问题需要你回答',
      approval: '有一个操作正在等待你批准',
      'plan-review': '有一份计划正在等你审阅',
    }
    // Manager replaces the literal token with the live bridge port.
    const BRIDGE_PORT = globalThis.__DSH_BRIDGE_PORT__ || '__DSH_BRIDGE_PORT__'

    function post(path, payload) {
      if (!BRIDGE_PORT || BRIDGE_PORT.startsWith('__DSH')) return Promise.resolve()
      return fetch(`http://127.0.0.1:${BRIDGE_PORT}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      }).catch(() => {})
    }

    function titleOf(item) {
      if (item.title && String(item.title).trim()) return String(item.title).trim()
      if (item.cwd) return String(item.cwd)
      return '会话'
    }

    function show(title, body) {
      try {
        if (
          typeof document !== 'undefined' &&
          typeof document.hasFocus === 'function' &&
          document.hasFocus() &&
          !document.hidden
        ) {
          return // user is looking at the UI; do not nag
        }
      } catch { /* keep going */ }
      post('/notify', { title, body })
    }

    return {
      name: 'desktop-notifications',
      inject: ['sessions'],
      apply(ctx) {
        const seen = new Map() // sessionId -> { pending?, completed }
        const scan = () => {
          let snap
          try {
            snap = ctx.sessions && ctx.sessions.list && typeof ctx.sessions.list.getSnapshot === 'function'
              ? ctx.sessions.list.getSnapshot()
              : null
          } catch { return }
          if (!snap || !Array.isArray(snap.ids) || !snap.byId) return
          const alive = new Set()
          for (const id of snap.ids) {
            const item = snap.byId[id]
            if (!item) continue
            alive.add(id)
            const before = seen.get(id)
            const pending = item.pendingInteraction
            const completed = item.completed === true
            if (before) {
              if (!before.pending && pending) {
                show('dsh 需要你', PENDING_LABELS[pending] ?? '有一条交互在等你')
              }
              if (!before.completed && completed) {
                show('dsh 任务完成', `「${titleOf(item)}」已完成`)
              }
            }
            seen.set(id, { pending: pending ?? undefined, completed })
          }
          for (const id of [...seen.keys()]) {
            if (!alive.has(id)) seen.delete(id)
          }
        }
        const list = ctx.sessions.list
        const unsubscribe = list && typeof list.subscribe === 'function'
          ? list.subscribe(scan)
          : undefined
        scan() // record baseline; never notify for pre-existing state
        // Diagnostic canary: tells the shell this module loaded and the bridge
        // is reachable (no toast, no tauri dependency).
        post('/alive', { loaded: true })
        return () => {
          if (unsubscribe) unsubscribe()
        }
      },
    }
  },
})