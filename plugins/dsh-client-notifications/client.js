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

    // Decision trail: every judgment the plugin makes is posted to the shell's
    // session log (via the bridge /log sink) so a bad outcome is traceable to
    // the exact snapshot state. No-op when the bridge is unavailable.
    function logEvent(tag, item, detail) {
      const payload = { tag }
      if (item) {
        const sid = idOf(item)
        if (sid) payload.sessionId = sid
        if (item.pendingInteraction) payload.pending = item.pendingInteraction
        if (item.running === true) payload.running = true
        if (item.completed === true) payload.completed = true
      }
      if (detail) payload.detail = detail
      post('/log', payload)
    }

    function titleOf(item) {
      if (item.title && String(item.title).trim()) return String(item.title).trim()
      if (item.displayTitle && String(item.displayTitle).trim()) return String(item.displayTitle).trim()
      if (item.cwd) return String(item.cwd)
      return '会话'
    }

    function idOf(item) {
      return item.sessionId || item.id || undefined
    }

    function show(title, body, item) {
      try {
        if (
          typeof document !== 'undefined' &&
          typeof document.hasFocus === 'function' &&
          document.hasFocus() &&
          !document.hidden
        ) {
          logEvent('suppressed', item, 'window focused')
          return // user is looking at the UI; do not nag
        }
      } catch { /* keep going */ }
      const payload = { title, body }
      const sid = idOf(item)
      if (sid) payload.sessionId = sid
      post('/notify', payload)
    }

    // The desktop shell remembers the last notifying session; when the user
    // activates the app (toast click), it exposes that session via
    // /pending-open and we open it here — the only side that can drive dsh.
    let polling = false
    function pollPendingOpen(ctx) {
      if (polling) return
      if (!BRIDGE_PORT || BRIDGE_PORT.startsWith('__DSH')) return
      polling = true
      const sched = () => {
        const h = setTimeout(tick, 1200)
        // Browser: no-op. Node (behavioral tests): don't pin the loop open.
        if (h && typeof h.unref === 'function') h.unref()
      }
      const tick = async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/pending-open`)
          const data = await res.json()
          if (data && data.sessionId) {
            const sid = String(data.sessionId)
            try {
              if (ctx.sessions && typeof ctx.sessions.open === 'function') {
                ctx.sessions.open(sid)
                post('/log', { tag: 'open', sessionId: sid, detail: 'ctx.sessions.open' })
              } else if (ctx.sessions && ctx.sessions.list && typeof ctx.sessions.list.update === 'function') {
                ctx.sessions.list.update((draft) => { draft.current = sid })
                post('/log', { tag: 'open', sessionId: sid, detail: 'store.current' })
              }
            } catch (err) {
              console.warn('[dsh-desktop] open session failed', sid, err)
              post('/log', { tag: 'open-error', sessionId: sid, detail: String(err && err.message || err) })
            }
          }
        } catch { /* bridge briefly unavailable; ignore */ }
        sched()
      }
      sched()
    }

    return {
      name: 'desktop-notifications',
      inject: ['sessions'],
      apply(ctx) {
        const seen = new Map() // sessionId -> { pending?, running, completed, ended }
        // Defensive: the sessions store's canonical shape is { ids, byId }
        // (dsh-client-runtime/service.d.ts); accept the UI-projection shape
        // { items } too so a future shape change can never silently kill us.
        // Worst case we surface diagnosis via the /alive canary instead of
        // going quiet.
        const reportShape = (msg) => { try { post('/alive', { loaded: true, shape: msg }) } catch { /* ignore */ } }
        let shapeReported = false
        const shapeOf = (snap) => {
          if (snap && Array.isArray(snap.ids) && snap.byId && typeof snap.byId === 'object') {
            return { ids: snap.ids, byId: snap.byId }
          }
          if (snap && Array.isArray(snap.items)) {
            const ids = []
            const byId = {}
            for (const i of snap.items) {
              const k = i.sessionId || i.id
              if (!k) continue
              ids.push(k)
              byId[k] = i
            }
            return { ids, byId }
          }
          if (!shapeReported) { shapeReported = true; reportShape('unrecognized') }
          return null
        }
        const scan = () => {
          let snap
          try {
            snap = ctx.sessions && ctx.sessions.list && typeof ctx.sessions.list.getSnapshot === 'function'
              ? ctx.sessions.list.getSnapshot()
              : null
          } catch { return }
          const shaped = shapeOf(snap)
          if (!shaped) return
          const alive = new Set()
          for (const id of shaped.ids) {
            const item = shaped.byId[id]
            if (!item) continue
            alive.add(id)
            const before = seen.get(id)
            const pending = item.pendingInteraction
            // Completion signal: dsh's `completed` only means "finished while
            // NOT selected" (it never flips for a selected session, even when
            // the window is minimized). The universal edge is running true→false.
            const running = item.running === true
            const completed = item.completed === true
            if (before) {
              if (!before.pending && pending) {
                logEvent('notify-pending', item, PENDING_LABELS[pending] ?? pending)
                show('dsh 需要你', PENDING_LABELS[pending] ?? '有一条交互在等你', item)
              }
              if (before.running && !running) {
                // Primary path: observed the running→done edge directly.
                // Manual stop needs the focused window, and focused => the
                // toasts are suppressed — so an unfocused edge is a real
                // finish (or a rare external/browser stop; `completed` only
                // records "ended while unselected", never stop-vs-finish).
                // Wording is therefore always 已完成.
                logEvent('notify-complete', item, completed ? 'completed-flag' : 'running-edge')
                show('dsh 任务完成', `「${titleOf(item)}」已完成`, item)
                seen.set(id, { pending: pending ?? undefined, running, completed, ended: true })
                continue
              }
              // Fallback: the running edge was missed (very fast task, or a
              // snapshot coalesced true→false between ticks). `completed`
              // appearing false→true on an un-ended episode is the evidence.
              if (!before.ended && !before.running && !before.completed && completed && !running) {
                logEvent('notify-complete-fallback', item, 'completed transition')
                show('dsh 任务完成', `「${titleOf(item)}」已完成`, item)
                seen.set(id, { pending: pending ?? undefined, running, completed, ended: true })
                continue
              }
            }
            // A fresh run arms a new episode (and dsh clears `completed` on it).
            seen.set(id, { pending: pending ?? undefined, running, completed, ended: running ? false : (before ? before.ended : false) })
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
        pollPendingOpen(ctx)
        return () => {
          if (unsubscribe) unsubscribe()
        }
      },
    }
  },
})