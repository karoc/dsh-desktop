// DSH Smoothly Desktop — notification client plugin, browser half.
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
    // ── turn-end wording (P1-2) ─────────────────────────────────────────────
    // dsh 0.2.x exposes NO reachable turn/end reason to a client plugin:
    //   · `connection` has no `.api` member (`@deepseek-ai/dsh-client-connection@
    //     0.2.2-rc.1` typings carry no session history/events API — verified);
    //   · the session-list row (`SessionSummary`) has no end reason and no
    //     `completed` field (verified against dsh-api-session-controller);
    //   · view selection lives OUTSIDE the session controller, so even
    //     "was the user looking at it" is not readable.
    // The old `ctx.connection.api.sessions.history` probe therefore never ran a
    // real call: every end — error / aborted / blocked / interrupted — was
    // announced as 「已完成」(production log: 155/155 notify-classified =
    // completed, 0 error, 0 classify-error). Until a verified seam exists the
    // wording is deliberately NEUTRAL: 「已结束」 is true for every end;
    // 「已完成」 is a claim we cannot support.
    const END_TITLE = 'dsh 任务已结束'
    // Manager replaces the literal token with the live bridge port.
    const BRIDGE_PORT = globalThis.__DSH_BRIDGE_PORT__ || '__DSH_BRIDGE_PORT__'

    // ── service resolution WITHOUT required inject (P1-4) ────────────────────
    // cordis 4.1's `Inject` type is `string[] | { [name]: interceptConfig }` —
    // there is NO "optional" form: every declared service is REQUIRED, and a
    // plugin whose service never appears keeps its fiber pending. dsh's web boot
    // is fail-closed on pending entries ("Failed to load plugins"), so ONE
    // upstream rename (uiSession / uiWorkspace are 0.1.6-era seams) would turn
    // this plugin into a WHITE SCREEN — the whole UI, not just notifications.
    // Hence: declare no required services, resolve them here instead, and let
    // `ctx.get()` see services that are registered AFTER this plugin activates.
    // Everything degrades visibly (a /log `degraded` event + a shell log line)
    // instead of wedging boot.
    function svc(ctx, name) {
      try {
        if (ctx && typeof ctx.get === 'function') {
          const v = ctx.get(name)
          if (v !== undefined && v !== null) return v
        }
      } catch { /* service lookup must never throw into boot */ }
      try { return ctx ? ctx[name] : undefined } catch { return undefined }
    }

    function post(path, payload) {
      if (!BRIDGE_PORT || BRIDGE_PORT.startsWith('__DSH')) return Promise.resolve()
      return fetch(`http://127.0.0.1:${BRIDGE_PORT}${path}`, {
        method: 'POST',
        // 桥的阶段 0 准入：非 GET/HEAD/OPTIONS 必须带该头（跨源简单请求无法携带
        // 自定义头 → 外部网页即使猜到端口也会先触发预检，而预检不放行它）。
        // GET /pending-open 不需要。
        headers: { 'Content-Type': 'application/json', 'X-DSH-Shell': '1' },
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
        if (item.pendingInteraction) payload.pendingKind = pendingKind(item.pendingInteraction)
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

    // P2-4: `SessionPendingInteractionBase` is an object
    // ({key, kind, sessionId}), not a string. Accept both shapes so a future
    // regression to string keys cannot silently kill the labels again.
    function pendingKind(p) {
      if (!p) return undefined
      if (typeof p === 'string') return p
      return p.kind || p.key || undefined
    }

    // ── window focus (Bug 2) ───────────────────────────────────────────────
    // `document.hasFocus()` is NOT trustworthy in WebView2: after the window is
    // pushed behind another app it keeps returning true, so the shell logged
    // "suppressed / window focused" while the user was in a different program
    // and every notification was silently dropped. The shell now listens for
    // Tauri's `WindowEvent::Focused` and evals `window.__DSH_SHELL_FOCUSED__`;
    // that value is the only authority. When it is absent (older shell that
    // does not push it yet) fall back to the old document check rather than
    // muting every notification.
    function shellSaysFocused() {
      const pushed = globalThis.__DSH_SHELL_FOCUSED__
      if (pushed === true || pushed === false) return pushed
      try {
        return typeof document !== 'undefined'
          && typeof document.hasFocus === 'function'
          && document.hasFocus()
          && !document.hidden
      } catch {
        return false
      }
    }

    function show(title, body, item) {
      if (shellSaysFocused()) {
        logEvent('suppressed', item, 'window focused (shell state)')
        return // user is looking at the UI; do not nag
      }
      const payload = { title, body }
      const sid = idOf(item)
      if (sid) payload.sessionId = sid
      post('/notify', payload)
    }

    // The desktop shell remembers the last notifying session; when the user
    // activates the app (toast click), it exposes that session via
    // /pending-open and we open it here — the only side that can drive dsh.
    // ── turn/end reason classification (async) ────────────────────────────────
    // dsh's session-list `running` flips false on EVERY turn/end, including
    // turn/end with reason error/aborted/blocked/max-tokens/interrupted — not
    // just on a real completion. The list row exposes no end reason, so on a
    // completion edge we read the session tail via sessions.history and label
    // the toast by the last turn/end reason.kind:
    //   completed                -> 任务完成
    //   error                    -> 任务出错: <message>  (with per-session
    //                               3-min cooldown so an auto-retry burst does
    //                               not re-pop)
    //   aborted/blocked/...      -> 任务已停止 / 任务被阻止 / ... (never 已完成)
    //   RPC unavailable/failed   -> fall back to 任务完成 (previous behavior)
    // Never throws: the notification must still fire even if classification
    // cannot run. The /notify post itself is subject to the window-focus
    // suppression inside show().
    function notifyEnded(item) {
      logEvent('notify-ended', item, 'reason unavailable (neutral wording)')
      show(END_TITLE, `「${titleOf(item)}」已结束`, item)
    }
    let polling = false
    let disposed = false
    function pollPendingOpen(ctx) {
      if (polling) return
      if (!BRIDGE_PORT || BRIDGE_PORT.startsWith('__DSH')) return
      polling = true
      const sched = () => {
        if (disposed) return
        const h = setTimeout(tick, 1200)
        // Browser: no-op. Node (behavioral tests): don't pin the loop open.
        if (h && typeof h.unref === 'function') h.unref()
      }
      // A hung fetch would otherwise freeze the poll forever (`polling` is a
      // one-shot latch), and every later click would be ignored.
      const withTimeout = (promise, ms) => Promise.race([
        promise,
        new Promise((_, reject) => {
          const t = setTimeout(() => reject(new Error('timeout')), ms)
          if (t && typeof t.unref === 'function') t.unref()
        }),
      ])
      const tick = async () => {
        if (disposed) return // a tick already scheduled at dispose time must not run
        try {
          const res = await withTimeout(fetch(`http://127.0.0.1:${BRIDGE_PORT}/pending-open`), 3000)
          const data = await res.json()
          if (data && data.sessionId) {
            const sid = String(data.sessionId)
            // Open target lives in uiWorkspace; `ctx.sessions.open` does NOT
            // exist on dsh 0.2.x (it disappeared at 0.1.6). The old else-if
            // wrote a field that no one reads and logged success — that is why
            // clicking a toast brought the window forward but never switched
            // sessions, silently.
            try {
              const ws = svc(ctx, 'uiWorkspace')
              if (!ws || typeof ws.openSession !== 'function') {
                throw new Error('ctx.uiWorkspace.openSession unavailable')
              }
              ws.openSession(sid)
              post('/log', { tag: 'open', sessionId: sid, detail: 'uiWorkspace.openSession' })
            } catch (err) {
              post('/log', { tag: 'open-error', sessionId: sid, detail: String((err && err.message) || err) })
            }
          }
        } catch { /* bridge briefly unavailable / timeout; ignore */ }
        sched()
      }
      sched()
      return () => { disposed = true }
    }

    return {
      name: 'desktop-notifications',
      // NO required inject — see the `svc()` comment above. A required
      // `['sessions','connection','uiSession','uiWorkspace']` made this plugin
      // the whole site's single point of failure: any one of those service names
      // disappearing upstream left the fiber pending ⇒ dsh boot fail-closed ⇒
      // "Failed to load plugins" (white screen, dsh's own plugin page included).
      // All four are now resolved lazily via `svc()`: missing `sessions` ⇒ the
      // notifier idles; missing `uiSession` ⇒ tray ●/○ and 「需要你」 toasts
      // degrade; missing `uiWorkspace` ⇒ click-to-open reports a readable
      // error. None of them can stop dsh from booting.
      inject: [],
      apply(ctx) {
        const seen = new Map() // sessionId -> { pending?, running, completed, ended }
        // P1-3: sessions that hit running true→false and were not looked at
        // since. Driven by OUR OWN edge observation because dsh's
        // `completionUnread` only flips for sessions that were not the main
        // view — i.e. the tray's ✔ scenario ("hide the window, let the current
        // session finish") never produced a ○.
        const endedUnviewed = new Set()

        /** Live UI status for one session, or undefined when unavailable. */
        let statusDiag = false
        function statusOf(id) {
          try {
            const ui = svc(ctx, 'uiSession')
            if (!ui) {
              if (!statusDiag) { statusDiag = true; logEvent('status-missing', null, 'ctx.uiSession undefined') }
              return undefined
            }
            const obs = ui.sessionStatus
            if (!obs || typeof obs.getSnapshot !== 'function') {
              if (!statusDiag) {
                statusDiag = true
                logEvent('status-missing', null, 'sessionStatus=' + (obs === undefined ? 'undefined' : typeof obs))
              }
              return undefined
            }
            const snap = obs.getSnapshot()
            const st = snap && typeof snap.get === 'function' ? snap.get(id) : undefined
            if (!statusDiag) {
              statusDiag = true
              logEvent('status-probe', null, 'kind=' + (snap && snap.constructor && snap.constructor.name) +
                ' size=' + (snap && typeof snap.size === 'number' ? snap.size : '?') +
                ' hit=' + (st ? 'yes' : 'no') +
                ' st=' + (st ? JSON.stringify(st) : 'undefined'))
            }
            return st
          } catch (e) {
            if (!statusDiag) { statusDiag = true; logEvent('status-error', null, String((e && e.message) || e)) }
            return undefined
          }
        }
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
        // ── aggregate state for the shell (tray tooltip) ────────────────────
        // What a user needs without opening the window: which sessions are
        // working, which wait on them, which finished unviewed — with titles,
        // because "2 running" says nothing about WHAT is running. Posted only
        // when the aggregate CHANGES (the snapshot fires on every event; a
        // steady state must not keep the bridge warm).
        //
        // Row rules (same source as the toast suppression):
        //   - subagent rows never contribute a work/done entry (one parent turn
        //     covers their lifecycle) but their PENDING interaction still needs
        //     a person, so it gets an entry of its own;
        //   - blank rows (created, never used) contribute nothing;
        //   - `completed` only means "finished while not selected", so a session
        //     the user has already opened drops out by itself.
        // Entries are pre-sorted by urgency; the shell truncates to its 128-char
        // tooltip budget, so the cap here only avoids shipping junk.
        const AGGREGATE_MAX_ITEMS = 8
        let lastAggregateKey = null
        function reportAggregate(shaped) {
          const entries = []
          for (const id of shaped.ids) {
            const item = shaped.byId[id]
            if (!item || item.blank === true) continue
            // Live status comes from uiSession, not from the list row.
            const st = statusOf(id) || {}
            const running = st.running === undefined ? item.running === true : st.running === true
            // P1-3: our own ended-unviewed set is the primary signal (dsh's
            // flag only covered the non-main-view case). View selection lives
            // outside the session Controller (verified), so "seen" cannot be
            // detected on open — a new run clears it, and the tooltip wording
            // is 「已结束未查看」 rather than claiming a completion.
            const unread = endedUnviewed.has(id) || st.completionUnread === true
            if (st.pendingInteraction) {
              entries.push({ kind: 'pending', title: titleOf(item) })
              continue
            }
            if (item.origin === 'subagent') continue
            if (running) entries.push({ kind: 'running', title: titleOf(item) })
            else if (unread) entries.push({ kind: 'done', title: titleOf(item) })
          }
          const rank = { pending: 0, running: 1, done: 2 }
          entries.sort((a, b) => rank[a.kind] - rank[b.kind])
          const running = entries.reduce((n, e) => n + (e.kind === 'running' ? 1 : 0), 0)
          const pending = entries.reduce((n, e) => n + (e.kind === 'pending' ? 1 : 0), 0)
          const done = entries.reduce((n, e) => n + (e.kind === 'done' ? 1 : 0), 0)
          // Titles are part of the identity: a rename must refresh the tooltip.
          const key = entries.map((e) => `${e.kind}\u0000${e.title}`).join('\u0001')
          if (key === lastAggregateKey) return
          lastAggregateKey = key
          logEvent('aggregate', null, `${running}/${pending}/${done}`)
          post('/state', {
            running,
            pending,
            done,
            items: entries.slice(0, AGGREGATE_MAX_ITEMS),
          })
        }

        // One-shot full dump: every session's live status, so a mismatch
        // between the UI dot and this store is visible in the shell log.
        setTimeout(() => {
          try {
            const ui = svc(ctx, 'uiSession')
            const obs = ui && ui.sessionStatus
            const snap = obs && typeof obs.getSnapshot === 'function' ? obs.getSnapshot() : null
            if (!snap || typeof snap.forEach !== 'function') {
              logEvent('status-dump', null, 'no snapshot')
              return
            }
            const rows = []
            snap.forEach((v, k) => rows.push(String(k).slice(-6) + '=' + JSON.stringify(v)))
            logEvent('status-dump', null, rows.join(' | ').slice(0, 900))
          } catch (e) {
            logEvent('status-dump', null, 'error: ' + String((e && e.message) || e))
          }
        }, 4000)

        const scan = () => {
          let snap
          try {
            const sessions = svc(ctx, 'sessions')
            snap = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function'
              ? sessions.list.getSnapshot()
              : null
          } catch { return }
          const shaped = shapeOf(snap)
          if (!shaped) return
          const alive = new Set()
          for (const id of shaped.ids) {
            const item = shaped.byId[id]
            if (!item) continue
            alive.add(id)
            // Subagent rows are nested working sessions: dsh keeps one list row
            // per child (lineage), each with its own `running`/`completed`, but
            // a child's lifecycle is a segment of its parent's. Announcing
            // completions for them too would pop one toast per child — often
            // with the same body (child title falls back to the shared cwd) —
            // so a task that spawns subagents fires several identical
            // "任务完成" toasts. ONLY actual subagent rows are covered by the
            // parent's notification: `origin: 'subagent'` is the single host
            // origin value (fork children carry no origin and complete on
            // their own). Interaction waits, by contrast, are tracked per row
            // with no parent relay — dsh keys approval/question frames by the
            // requesting agent's session — so a subagent asking the user must
            // still raise 「需要你」 (pending branch below fires for every row).
            const isSubagentRow = item.origin === 'subagent'
            const before = seen.get(id)
            // The list row has no pendingInteraction field — it must come from
            // uiSession (see the inject comment). `completed` likewise only
            // means "ended while unselected"; completionUnread is the real
            // "finished and not yet acknowledged".
            const st = statusOf(id) || {}
            const pending = st.pendingInteraction
            // Completion signal: dsh's `completed` only means "finished while
            // NOT selected" (it never flips for a selected session, even when
            // the window is minimized). The universal edge is running true→false.
            const running = st.running === undefined ? item.running === true : st.running === true
            const completed = item.completed === true
            if (before) {
              if (!before.pending && pending) {
                // P2-4: pendingInteraction is an OBJECT ({key, kind, sessionId}),
                // not a string — looking it up in PENDING_LABELS never matched,
                // so every interaction showed the generic "有一条交互在等你"
                // and the body had no session title.
                const kind = pendingKind(pending)
                logEvent('notify-pending', item, String(PENDING_LABELS[kind] ?? kind ?? 'unknown'))
                show('dsh 需要你', `「${titleOf(item)}」${PENDING_LABELS[kind] ?? '有一条交互在等你'}`, item)
              }
              if (before.running && !running) {
                // Primary path: observed the running→done edge directly.
                // Manual stop needs the focused window, and focused => the
                // toasts are suppressed — so an unfocused edge is a real
                // finish (or a rare external/browser stop). The end REASON is
                // not reachable on dsh 0.2.x (see the END_TITLE comment), so the
                // wording stays neutral: 「已结束」, never 「已完成」.
                if (isSubagentRow) {
                  logEvent('notify-complete-suppressed', item, 'subagent row (parent turn covers it)')
                  seen.set(id, { pending: pending ?? undefined, running, completed, ended: true })
                  continue
                }
                if (pending) {
                  // A turn that ends to ASK the user something is not a
                  // completion: the needs-you announcement above is the only
                  // toast. Without this, one turn-end would pop both
                  // "dsh 任务完成" and "dsh 需要你" (the pending branch has no
                  // continue and the edges coalesce into one snapshot).
                  logEvent('notify-complete-suppressed', item, 'turn ended awaiting interaction')
                  seen.set(id, { pending: pending ?? undefined, running, completed, ended: true })
                  continue
                }
                logEvent('notify-ended', item, 'running-edge')
                seen.set(id, { pending: pending ?? undefined, running, completed, ended: true })
                endedUnviewed.add(id) // P1-3: tray ○ = "ended, not yet seen"
                notifyEnded(item)
                continue
              }
              // Fallback: the running edge was missed (very fast task, or a
              // snapshot coalesced true→false between ticks). `completed`
              // appearing false→true on an un-ended episode is the evidence.
              // A pending interaction or a subagent row in the same episode
              // suppresses the completion here too.
              // NOTE: this branch is inert on dsh 0.2.x — SessionSummary has no
              // `completed` field (verified against dsh-api-session-controller),
              // so `completed` is always false and an end between two scans is
              // simply unobservable without a start/end stream seam.
              if (!isSubagentRow && !before.ended && !before.running && !before.completed && completed && !running && !pending) {
                logEvent('notify-ended-fallback', item, 'completed transition')
                seen.set(id, { pending: pending ?? undefined, running, completed, ended: true })
                endedUnviewed.add(id)
                notifyEnded(item)
                continue
              }
            }
            // A fresh run arms a new episode (and dsh clears `completed` on it).
            if (running) endedUnviewed.delete(id)
            seen.set(id, { pending: pending ?? undefined, running, completed, ended: running ? false : (before ? before.ended : false) })
          }
          for (const id of [...seen.keys()]) {
            if (!alive.has(id)) {
              seen.delete(id)
              endedUnviewed.delete(id)
            }
          }
          reportAggregate(shaped)
        }
        // ── readiness (P1-4): services may arrive AFTER this plugin activates ──
        // No required inject means the notifier waits for what it needs without
        // blocking boot. `sessions.list` and `uiSession.sessionStatus` are waited
        // for INDEPENDENTLY: the status store is the newer seam, and losing it
        // must cost the tray ●/○ + 「需要你」 toast, not the turn-end notifier.
        // Both waits degrade with a readable /log event instead of going silent.
        const READY_RETRY_MS = 200
        // Test hook: the acceptance test cannot sit through the 20 s production
        // window; behaviour is unchanged when the global is unset.
        const READY_TIMEOUT_MS = Number(globalThis.__DSH_NOTIFY_READY_TIMEOUT_MS__) > 0
          ? Number(globalThis.__DSH_NOTIFY_READY_TIMEOUT_MS__)
          : 20000
        const readyStart = Date.now()
        let unsubscribe = null
        let unsubscribeStatus = null
        let listReady = false
        let statusReady = false
        let listDegraded = false
        let statusDegraded = false
        let listTimer = null
        let statusTimer = null

        function wireList() {
          if (disposed || listReady) return
          const sessions = svc(ctx, 'sessions')
          const l = sessions && sessions.list
          if (l && typeof l.getSnapshot === 'function') {
            listReady = true
            if (typeof l.subscribe === 'function') unsubscribe = l.subscribe(scan)
            scan() // record baseline; never notify for pre-existing state
            logEvent('ready', null, 'sessions.list wired')
            return
          }
          if (!listDegraded && Date.now() - readyStart > READY_TIMEOUT_MS) {
            listDegraded = true
            logEvent('degraded', null, 'sessions service unavailable → notifications idle (dsh seam renamed?); the UI is NOT affected')
          }
          listTimer = setTimeout(wireList, READY_RETRY_MS)
          if (listTimer && typeof listTimer.unref === 'function') listTimer.unref()
        }

        // CRITICAL: pendingInteraction lives in uiSession.sessionStatus, a
        // SEPARATE observable from sessions.list. A session entering "waiting
        // for approval" changes NO list row, so subscribing to the list alone
        // meant scan() never re-ran — the tray stayed on ▶ and the 「需要你」
        // toast never fired, even though the UI showed the orange dot. Both
        // sources must drive the scan.
        function wireStatus() {
          if (disposed || statusReady) return
          try {
            const ui = svc(ctx, 'uiSession')
            const obs = ui && ui.sessionStatus
            if (obs && typeof obs.subscribe === 'function') {
              unsubscribeStatus = obs.subscribe(scan)
              statusReady = true
              logEvent('ready', null, 'uiSession.sessionStatus wired')
              return
            }
          } catch { /* retry below */ }
          if (!statusDegraded && Date.now() - readyStart > READY_TIMEOUT_MS) {
            statusDegraded = true
            logEvent('degraded', null, 'uiSession.sessionStatus unavailable → tray ●/○ and 「需要你」 toasts disabled; turn-end notifications keep working')
          }
          statusTimer = setTimeout(wireStatus, READY_RETRY_MS)
          if (statusTimer && typeof statusTimer.unref === 'function') statusTimer.unref()
        }

        wireList()
        wireStatus()
        // Diagnostic canary: tells the shell this module loaded and the bridge
        // is reachable (no toast, no tauri dependency).
        post('/alive', { loaded: true })
        // The shell only pushes focus on Focused events, which do NOT fire for
        // a window that was already focused when the page loaded (e.g. after a
        // reload). Pull the initial value once so the first suppression
        // decision is not made against a missing global.
        // Poll rather than trust the push: on Windows the shell's
        // `WindowEvent::Focused(false)` does not fire when the window is merely
        // pushed behind another app, so the eval-driven global would stay stale
        // at `true` and mute every toast. A loopback GET every few seconds is
        // cheap and is the only signal that tracks reality.
        const FOCUS_POLL_MS = 5000
        function refreshFocus() {
          if (!BRIDGE_PORT || String(BRIDGE_PORT).startsWith('__DSH')) return
          fetch(`http://127.0.0.1:${BRIDGE_PORT}/window/focused`)
            .then((r) => r.json())
            .then((d) => {
              if (d && typeof d.focused === 'boolean') globalThis.__DSH_SHELL_FOCUSED__ = d.focused
            })
            .catch(() => {})
        }
        refreshFocus()
        {
          const h = setInterval(refreshFocus, FOCUS_POLL_MS)
          if (h && typeof h.unref === 'function') h.unref()
        }
        const stopPolling = pollPendingOpen(ctx)
        return () => {
          disposed = true
          if (unsubscribe) unsubscribe()
          if (unsubscribeStatus) unsubscribeStatus()
          if (listTimer) clearTimeout(listTimer)
          if (statusTimer) clearTimeout(statusTimer)
          if (stopPolling) stopPolling()
        }
      },
    }
  },
})