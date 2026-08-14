// dsh Desktop — notification client plugin, browser half.
//
// Classic-script bundle served by dsh web under /plugins/<id>/client.js and
// registered through window.__ModuleLoader__.load (the dsh client module
// system). Watches the sessions snapshot:
//   - pendingInteraction appears  -> "dsh needs you" notification (question /
//     approval / plan-review);
//   - completed turns true        -> "task done" notification.
// Skips notifying while the window is focused and visible. Delivers through
// window.__TAURI__.notification (Tauri shell, scoped permission) with an
// HTML5 Notification fallback (plain browser / dev).
window.__ModuleLoader__.load({
  id: '@dsh-desktop/client-notifications',
  factory: () => {
    const PENDING_LABELS = {
      question: '有一个问题需要你回答',
      approval: '有一个操作正在等待你批准',
      'plan-review': '有一份计划正在等你审阅',
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
      const tauri = globalThis.__TAURI__
      if (tauri && tauri.notification && typeof tauri.notification.sendNotification === 'function') {
        try {
          tauri.notification.sendNotification({ title, body })
          return
        } catch (err) {
          console.warn('[dsh-desktop] tauri notification failed', err)
        }
      }
      if (typeof Notification === 'function') {
        try {
          // eslint-disable-next-line no-new
          new Notification(title, { body })
        } catch (err) {
          console.warn('[dsh-desktop] HTML5 notification failed', err)
        }
      }
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
        return () => {
          if (unsubscribe) unsubscribe()
        }
      },
    }
  },
})