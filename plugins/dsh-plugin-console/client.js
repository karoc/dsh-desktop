// DSH Desktop — plugin console, browser half.
//
// Classic-script bundle served by dsh web under /plugins/<id>/client.js and
// registered through window.__ModuleLoader__.load (the dsh client module
// system). Renders a floating "插件" button (bottom-right) opening a panel
// that manages the shell:
//   - preinstalled plugins (D3): enable / disable (writes dsh.profile.bundles)
//   - user-installed plugins (P5): install / remove / update via bundled pnpm
//   - preinstalled plugin updates (P5b, user-gated, npm): update / reset
//   - dsh update status + one-click update (D2: user decides)
//   - service actions: refresh page / restart
//   - 4 selectable themes (color AND layout/style tokens), in localStorage
//
// Delivery: plain-HTTP bridge to the Tauri shell (tauri#11934 — remote pages
// have no __TAURI__). The manager bakes the bridge port into this script by
// replacing the literal '__DSH_BRIDGE_PORT__'.
window.__ModuleLoader__.load({
  id: '@dsh-desktop/plugin-console',
  factory: () => {
    // Manager replaces the literal token with the live bridge port.
    const BRIDGE_PORT = globalThis.__DSH_BRIDGE_PORT__ || '__DSH_BRIDGE_PORT__'
    const ready = () => Boolean(BRIDGE_PORT) && !String(BRIDGE_PORT).startsWith('__DSH')

    // 格式约定：中文与数字/字母之间统一加空格（"更新到 0.1.3"、"有更新 0.1.3"）。
    const L = (navigator.language || 'en').toLowerCase().startsWith('zh')
      ? {
          title: '插件与更新',
          install: '安装新插件',
          installHint: 'npm 包名 或 github:user/repo / git+https://…',
          installBtn: '安装',
          installing: '安装中…',
          preinstalled: '预装插件',
          preinstalledHint: '随壳自带，默认关闭，启用后重启生效',
          hasUpdate: '有更新',
          updateTo: '更新到 ',
          resetDefault: '恢复默认',
          checkPreUpdates: '检查预装插件更新',
          checkingPre: '正在检查…',
          userUpdatedHint: '已手动更新，未随壳验证，可恢复默认',
          core: '内置核心',
          coreHint: 'dsh 自带，不可禁用',
          allPlugins: '全部插件',
          fullListHint: '完整只读清单（含 dsh 内置 160+ 个内部插件）见 dsh 设置 → 插件',
          enabled: '已启用',
          notEnabled: '未启用',
          enable: '启用',
          disable: '关闭',
          builtin: '内置',
          unmanageable: '不可管理',
          userInstalled: '已安装插件',
          userInstalledHint: '通过下方输入框安装',
          uninstall: '卸载',
          updateOne: '更新',
          update: 'dsh 更新',
          upToDate: '已是最新版本',
          updateNow: '一键更新',
          updating: '正在更新并重启…',
          unknown: '未知',
          current: '当前',
          actions: '操作',
          refresh: '刷新页面',
          restart: '重启',
          restartHint: '重启 dsh 服务，插件变更生效',
          devtools: '开发者工具',
          restartToApply: '重启后生效',
          restartNow: '立即重启',
          failed: '操作失败',
          loading: '加载中…',
          noPreinstalled: '没有预装插件',
          noUserPlugins: '还没有安装其他插件',
          opActive: '处理中',
          opDone: '完成',
          opErr: '失败',
          theme: '主题',
        }
      : {
          title: 'Plugins & updates',
          install: 'Install plugin',
          installHint: 'npm package, or github:user/repo / git+https://…',
          installBtn: 'Install',
          installing: 'Installing…',
          preinstalled: 'Preinstalled',
          preinstalledHint: 'Shipped with the app, off by default',
          hasUpdate: 'Update',
          updateTo: 'Update to ',
          resetDefault: 'Reset to default',
          checkPreUpdates: 'Check preinstalled updates',
          checkingPre: 'Checking…',
          userUpdatedHint: 'Manually updated, not shell-verified — can reset',
          core: 'Core (built-in)',
          coreHint: 'Shipped with dsh, cannot be disabled',
          allPlugins: 'All plugins',
          fullListHint: 'Full read-only list (incl. 160+ built-in dsh plugins): dsh Settings → Plugins',
          enabled: 'On',
          notEnabled: 'Off',
          enable: 'Enable',
          disable: 'Disable',
          builtin: 'Built-in',
          unmanageable: 'Fixed',
          userInstalled: 'Installed plugins',
          userInstalledHint: 'Add more with the input above',
          uninstall: 'Remove',
          updateOne: 'Update',
          update: 'dsh update',
          upToDate: 'Up to date',
          updateNow: 'Update now',
          updating: 'Updating & restarting…',
          unknown: 'unknown',
          current: 'current',
          actions: 'Actions',
          refresh: 'Refresh page',
          restart: 'Restart',
          restartHint: 'Restart dsh to apply plugin changes',
          devtools: 'DevTools',
          restartToApply: 'Restart to apply',
          restartNow: 'Restart now',
          failed: 'Operation failed',
          loading: 'Loading…',
          noPreinstalled: 'No preinstalled plugins',
          noUserPlugins: 'No other plugins installed',
          opActive: 'Working…',
          opDone: 'Done',
          opErr: 'Failed',
          theme: 'Theme',
        }

    // ── themes: color tokens + layout/style tokens (radius/blur/padding) ──
    // Each theme is a distinct look, not just a palette:
    //   deep   深空  dark glass, medium radius, standard density
    //   aurora 极光  dark glass, large radius + heavy blur, roomy
    //   moon   月光  light, flat (no blur), small radius, compact
    //   amber  琥珀  warm, solid cards (no blur), medium radius, cosy
    const THEMES = {
      deep: {
        label: '深空',
        bg: 'linear-gradient(160deg, rgba(13,17,23,.94), rgba(22,27,34,.90))',
        surface: 'rgba(255,255,255,.05)',
        surfaceHover: 'rgba(255,255,255,.09)',
        border: 'rgba(255,255,255,.10)',
        text: '#e6edf3',
        muted: '#9ba7b4',
        accent: '#3b82f6',
        accent2: '#8b5cf6',
        success: '#4ade80',
        warn: '#fbbf24',
        err: '#f87171',
        shadow: '0 16px 48px rgba(0,0,0,.55)',
        radius: '18px',
        radiusRow: '12px',
        blur: '14px',
        pad: '16px 18px',
        gap: '8px',
      },
      aurora: {
        label: '极光',
        bg: 'linear-gradient(160deg, rgba(17,14,40,.94), rgba(10,26,38,.90))',
        surface: 'rgba(255,255,255,.06)',
        surfaceHover: 'rgba(255,255,255,.11)',
        border: 'rgba(167,139,250,.24)',
        text: '#ede9fe',
        muted: '#a5b4fc',
        accent: '#a78bfa',
        accent2: '#22d3ee',
        success: '#34d399',
        warn: '#fcd34d',
        err: '#fb7185',
        shadow: '0 18px 56px rgba(76,29,149,.45)',
        radius: '24px',
        radiusRow: '16px',
        blur: '28px',
        pad: '22px 24px',
        gap: '12px',
      },
      moon: {
        label: '月光',
        bg: 'linear-gradient(160deg, rgba(248,250,252,.96), rgba(241,245,249,.94))',
        surface: 'rgba(255,255,255,.85)',
        surfaceHover: '#ffffff',
        border: 'rgba(15,23,42,.12)',
        text: '#1e293b',
        muted: '#64748b',
        accent: '#2563eb',
        accent2: '#7c3aed',
        success: '#16a34a',
        warn: '#d97706',
        err: '#dc2626',
        shadow: '0 14px 40px rgba(15,23,42,.14)',
        radius: '10px',
        radiusRow: '8px',
        blur: '0px',
        pad: '12px 14px',
        gap: '6px',
      },
      amber: {
        label: '琥珀',
        bg: 'linear-gradient(160deg, rgba(30,20,10,.95), rgba(40,26,12,.92))',
        surface: 'rgba(120,70,20,.22)',
        surfaceHover: 'rgba(150,90,30,.30)',
        border: 'rgba(251,191,36,.22)',
        text: '#fef3c7',
        muted: '#d6b98a',
        accent: '#f59e0b',
        accent2: '#ef4444',
        success: '#4ade80',
        warn: '#fbbf24',
        err: '#f87171',
        shadow: '0 16px 48px rgba(120,53,15,.5)',
        radius: '14px',
        radiusRow: '10px',
        blur: '0px',
        pad: '18px 20px',
        gap: '10px',
      },
    }

    const THEME_STORAGE = 'dshc-theme'
    function loadTheme() {
      try {
        const t = globalThis.localStorage?.getItem(THEME_STORAGE)
        return THEMES[t] ? t : 'deep'
      } catch { return 'deep' }
    }
    function saveTheme(t) {
      try { globalThis.localStorage?.setItem(THEME_STORAGE, t) } catch { /* no storage */ }
    }

    let panelEl = null
    let bodyEl = null
    let mounted = false
    // Set when a plugin op / toggle succeeded and dsh must restart to apply;
    // refresh() re-renders the banner from this flag so it survives re-renders.
    let pendingRestart = false
    // Preserved install input value across re-renders (a 5s poll refresh must
    // not wipe what the user is typing).
    let installSpec = ''

    function bridge(path, opts) {
      if (!ready()) return Promise.resolve(null)
      return fetch(`http://127.0.0.1:${BRIDGE_PORT}${path}`, {
        method: opts?.method || 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: opts?.body ? JSON.stringify(opts.body) : undefined,
      })
        .then((r) => r.text().then((t) => {
          try { return JSON.parse(t) } catch { return { raw: t, status: r.status } }
        }))
        .catch(() => null)
    }

    // ── styling (injected once; themed via panel style CSS variables) ──────
    const STYLE_ID = 'dsh-desktop-console-style'
    function injectStyle() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
.dshc-btn {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  padding: 10px 16px; border: 1px solid rgba(255,255,255,.14); border-radius: 999px;
  background: rgba(22,27,34,.9); color: #e6edf3; font: 600 13px/1 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;
  cursor: pointer; box-shadow: 0 8px 24px rgba(0,0,0,.35); backdrop-filter: blur(8px);
  transition: transform .15s ease, box-shadow .15s ease, background .15s ease;
}
.dshc-btn:hover { transform: translateY(-1px); box-shadow: 0 12px 32px rgba(0,0,0,.45); background: rgba(33,38,45,.95); }
.dshc-panel {
  position: fixed; right: 20px; bottom: 64px; z-index: 2147483000;
  width: 356px; max-height: 74vh; overflow: auto;
  border-radius: var(--dshc-radius); padding: var(--dshc-pad);
  color: var(--dshc-text); font: 13px/1.55 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;
  box-shadow: var(--dshc-shadow);
  backdrop-filter: blur(var(--dshc-blur)); -webkit-backdrop-filter: blur(var(--dshc-blur));
  background: var(--dshc-bg); border: 1px solid var(--dshc-border);
  scrollbar-width: thin; scrollbar-color: var(--dshc-border) transparent;
}
.dshc-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 14px; }
.dshc-title { font-size: 14px; font-weight: 700; letter-spacing: .2px; }
.dshc-themes { display: flex; gap: 7px; align-items: center; }
.dshc-theme-dot {
  width: 16px; height: 16px; border-radius: 50%; cursor: pointer; padding: 0;
  border: 2px solid transparent; transition: transform .12s ease, border-color .12s ease;
  box-shadow: 0 1px 4px rgba(0,0,0,.3);
}
.dshc-theme-dot:hover { transform: scale(1.2); }
.dshc-theme-dot.active { border-color: var(--dshc-text); }
.dshc-sec-label {
  font-size: 11px; font-weight: 700; letter-spacing: .8px; text-transform: uppercase;
  color: var(--dshc-muted); margin: 18px 0 8px; display: flex; align-items: center; gap: 8px;
}
.dshc-sec-label::after { content: ''; flex: 1; height: 1px; background: var(--dshc-border); }
.dshc-hint { color: var(--dshc-muted); font-size: 11.5px; margin-top: 5px; }
.dshc-row {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 11px 13px; margin: 7px 0; border-radius: var(--dshc-radius-row);
  background: var(--dshc-surface); border: 1px solid var(--dshc-border);
  transition: background .15s ease, transform .15s ease;
}
.dshc-row:hover { background: var(--dshc-surfaceHover); }
.dshc-row > div:last-child { display: flex; flex-wrap: wrap; gap: 7px; justify-content: flex-end; }
.dshc-name { font-weight: 600; word-break: break-all; font-size: 12.5px; }
/* 描述最多两行，多余省略，悬停显示完整 */
.dshc-sub {
  color: var(--dshc-muted); font-size: 11px; margin-top: 3px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  word-break: break-all;
}
.dshc-badge {
  font-size: 10.5px; font-weight: 700; padding: 2px 9px; border-radius: 999px; margin-left: 6px;
  background: color-mix(in srgb, var(--dshc-muted) 22%, transparent); color: var(--dshc-muted);
  white-space: nowrap; vertical-align: 1px;
}
.dshc-badge.on { background: color-mix(in srgb, var(--dshc-success) 20%, transparent); color: var(--dshc-success); }
.dshc-badge.warn { background: color-mix(in srgb, var(--dshc-warn) 20%, transparent); color: var(--dshc-warn); }
.dshc-badge.core { background: color-mix(in srgb, var(--dshc-muted) 16%, transparent); color: var(--dshc-muted); }
.dshc-badge.err { background: color-mix(in srgb, var(--dshc-err) 18%, transparent); color: var(--dshc-err); }
.dshc-actions { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 6px; }
.dshc-btn2 {
  border: 1px solid var(--dshc-border); background: var(--dshc-surface); color: var(--dshc-text);
  border-radius: 9px; padding: 6px 13px; min-width: 58px; text-align: center;
  font: 600 12px/1.4 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;
  cursor: pointer; transition: background .15s ease, transform .12s ease, border-color .15s ease;
  white-space: nowrap;
}
.dshc-btn2:hover { background: var(--dshc-surfaceHover); border-color: var(--dshc-accent); }
.dshc-btn2:active { transform: scale(.97); }
.dshc-btn2.primary {
  border-color: transparent;
  background: linear-gradient(135deg, var(--dshc-accent), var(--dshc-accent2));
  color: #fff;
}
.dshc-btn2.primary:hover { filter: brightness(1.08); }
.dshc-btn2:disabled { opacity: .45; cursor: default; }
.dshc-status, .dshc-op {
  margin-top: 12px; padding: 9px 13px; border-radius: 11px; font-size: 12px;
  display: none; animation: dshc-in .2s ease;
}
.dshc-status.show, .dshc-op.show { display: block; }
.dshc-status.ok { background: color-mix(in srgb, var(--dshc-success) 16%, transparent); color: var(--dshc-success); }
.dshc-status.warn { background: color-mix(in srgb, var(--dshc-warn) 16%, transparent); color: var(--dshc-warn); }
.dshc-status.err { background: color-mix(in srgb, var(--dshc-err) 16%, transparent); color: var(--dshc-err); }
.dshc-op { background: color-mix(in srgb, var(--dshc-warn) 16%, transparent); color: var(--dshc-warn); }
.dshc-op.err { background: color-mix(in srgb, var(--dshc-err) 16%, transparent); color: var(--dshc-err); }
.dshc-install { display: flex; gap: 7px; margin-top: 6px; }
.dshc-install input {
  flex: 1; min-width: 0; padding: 8px 12px; border-radius: 10px;
  border: 1px solid var(--dshc-border); background: var(--dshc-surface);
  color: var(--dshc-text); font: 12.5px/1.4 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;
  outline: none; transition: border-color .15s ease;
}
.dshc-install input:focus { border-color: var(--dshc-accent); }
.dshc-install input::placeholder { color: color-mix(in srgb, var(--dshc-muted) 75%, transparent); }
.dshc-footer { margin-top: 14px; padding-top: 11px; border-top: 1px solid var(--dshc-border); font-size: 11px; color: var(--dshc-muted); }
@keyframes dshc-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
@keyframes dshc-spin { to { transform: rotate(360deg); } }
/* 处理中 / 重启 的加载指示 */
.dshc-spin {
  display: inline-block; width: 12px; height: 12px; margin-right: 7px;
  border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%;
  vertical-align: -1px; animation: dshc-spin .8s linear infinite;
}
/* 全屏重启遮罩：点重启后立刻有反馈，直到页面跳转 */
.dshc-overlay {
  position: fixed; inset: 0; z-index: 2147483999;
  background: rgba(6, 8, 12, .7); backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px;
  color: #e6edf3; font: 600 14px/1.4 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;
}
.dshc-overlay .dshc-spin { width: 36px; height: 36px; border-width: 3px; }
/* 自定义 tooltip（替代原生 title） */
.dshc-tip {
  position: fixed; z-index: 2147483998; max-width: 280px; padding: 7px 10px;
  border-radius: 8px; background: rgba(13,17,23,.96); border: 1px solid rgba(255,255,255,.14);
  color: #e6edf3; font: 12px/1.5 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;
  box-shadow: 0 8px 24px rgba(0,0,0,.45); pointer-events: none;
  opacity: 0; transition: opacity .12s ease;
}
`
      ;(document.head || document.documentElement).appendChild(style)
    }

    function applyTheme() {
      const t = loadTheme()
      const theme = THEMES[t] || THEMES.deep
      if (panelEl) {
        const vars = [
          `--dshc-bg: ${theme.bg}`,
          `--dshc-surface: ${theme.surface}`,
          `--dshc-surfaceHover: ${theme.surfaceHover}`,
          `--dshc-border: ${theme.border}`,
          `--dshc-text: ${theme.text}`,
          `--dshc-muted: ${theme.muted}`,
          `--dshc-accent: ${theme.accent}`,
          `--dshc-accent2: ${theme.accent2}`,
          `--dshc-success: ${theme.success}`,
          `--dshc-warn: ${theme.warn}`,
          `--dshc-err: ${theme.err}`,
          `--dshc-shadow: ${theme.shadow}`,
          `--dshc-radius: ${theme.radius}`,
          `--dshc-radius-row: ${theme.radiusRow}`,
          `--dshc-blur: ${theme.blur}`,
          `--dshc-pad: ${theme.pad}`,
          `--dshc-gap: ${theme.gap}`,
        ].join('; ')
        panelEl.style.cssText = `position: fixed; right: 20px; bottom: 64px; z-index: 2147483000; width: 356px; max-height: 74vh; overflow: auto; border-radius: var(--dshc-radius); padding: var(--dshc-pad); color: var(--dshc-text); font: 13px/1.55 system-ui,"Segoe UI","Microsoft YaHei",sans-serif; box-shadow: var(--dshc-shadow); backdrop-filter: blur(var(--dshc-blur)); -webkit-backdrop-filter: blur(var(--dshc-blur)); background: var(--dshc-bg); border: 1px solid var(--dshc-border); scrollbar-width: thin; scrollbar-color: var(--dshc-border) transparent; ${vars}`
        const dots = panelEl.querySelectorAll('.dshc-theme-dot')
        dots.forEach((d) => d.classList.toggle('active', d.dataset.theme === t))
      }
    }

    // ── rendering ─────────────────────────────────────────────────────────
    function status(text, kind) {
      if (!bodyEl) return
      let el = bodyEl.querySelector('.dshc-status')
      if (!el) {
        el = document.createElement('div')
        el.className = 'dshc-status'
        bodyEl.appendChild(el)
      }
      el.textContent = text
      el.className = `dshc-status show ${kind || 'ok'}`
      if (kind === 'err') setTimeout(() => el.classList.remove('show'), 6000)
    }

    function el(tag, text, cls) {
      const e = document.createElement(tag)
      e.textContent = text
      if (cls) e.className = cls
      return e
    }

    function section(label, hint) {
      const h = document.createElement('div')
      h.className = 'dshc-sec-label'
      h.textContent = label
      bodyEl.appendChild(h)
      if (hint) bodyEl.appendChild(el('div', hint, 'dshc-hint'))
    }

    // ── custom tooltip component (replaces native title) ──────────────────
    let tipEl = null
    function tip() {
      if (!tipEl) {
        tipEl = document.createElement('div')
        tipEl.className = 'dshc-tip'
        document.body.appendChild(tipEl)
      }
      return tipEl
    }
    /** Attach a styled tooltip (full text) to a clamped/truncated element. */
    function attachTooltip(el, text) {
      el.addEventListener('mouseenter', () => {
        const t = tip()
        t.textContent = text
        t.style.opacity = '1'
      })
      el.addEventListener('mousemove', (e) => {
        const t = tip()
        const x = (e.clientX || 0) + 14
        const y = (e.clientY || 0) + 14
        const vw = globalThis.innerWidth || 1280
        const vh = globalThis.innerHeight || 800
        t.style.left = `${Math.min(x, vw - 300)}px`
        t.style.top = `${Math.min(y, vh - 90)}px`
      })
      el.addEventListener('mouseleave', () => {
        if (tipEl) tipEl.style.opacity = '0'
      })
    }

    function row(label, badge, badgeCls, rightHtml, sub) {
      const div = document.createElement('div')
      div.className = 'dshc-row'
      const left = document.createElement('div')
      const name = document.createElement('span')
      name.className = 'dshc-name'
      name.textContent = label
      left.appendChild(name)
      if (badge) {
        const b = document.createElement('span')
        b.className = `dshc-badge ${badgeCls || ''}`
        b.textContent = badge
        left.appendChild(b)
      }
      if (sub) {
        const s = el('div', sub, 'dshc-sub')
        attachTooltip(s, sub) // 悬停显示完整说明（自定义组件，非原生 title）
        left.appendChild(s)
      }
      const right = document.createElement('div')
      right.innerHTML = rightHtml
      div.appendChild(left)
      div.appendChild(right)
      return div
    }

    function showRestartNow() {
      let b = bodyEl.querySelector('#dshc-restart-now')
      if (b) return
      b = document.createElement('button')
      b.id = 'dshc-restart-now'
      b.className = 'dshc-btn2 primary'
      b.textContent = L.restartNow
      b.style.cssText = 'margin-top:10px; display:block; width:100%;'
      b.addEventListener('click', () => {
        bridge('/restart-dsh', { method: 'POST' })
        showOverlay(L.restartNow + '…')
      })
      bodyEl.appendChild(b)
    }

    // ── full-screen restart/update veil: instant feedback on click ─────────
    // A restart navigates the page away (to the launcher or a fresh dsh page),
    // so this veil stays up until the navigation happens; the timeout only
    // unblocks a broken restart that never navigates.
    let overlayEl = null
    function showOverlay(text) {
      if (!overlayEl) {
        overlayEl = document.createElement('div')
        overlayEl.className = 'dshc-overlay'
        const spin = document.createElement('div')
        spin.className = 'dshc-spin'
        const txt = document.createElement('div')
        txt.id = 'dshc-overlay-text'
        overlayEl.appendChild(spin)
        overlayEl.appendChild(txt)
        document.body.appendChild(overlayEl)
      }
      const txt = overlayEl.querySelector('#dshc-overlay-text')
      if (txt) txt.textContent = text
      overlayEl.style.display = 'flex'
      if (overlayEl._timer) clearTimeout(overlayEl._timer)
      overlayEl._timer = setTimeout(() => { if (overlayEl) overlayEl.style.display = 'none' }, 20000)
    }

    async function refresh() {
      if (!bodyEl) return
      // Preserve the install input across re-renders.
      const prevSpec = bodyEl.querySelector('#dshc-spec')
      const wasFocused = prevSpec !== null && document.activeElement === prevSpec
      if (prevSpec) installSpec = prevSpec.value
      const data = await bridge('/plugins/list')
      bodyEl.textContent = ''
      applyTheme()

      const head = document.createElement('div')
      head.className = 'dshc-head'
      head.appendChild(el('div', L.title, 'dshc-title'))
      const themes = document.createElement('div')
      themes.className = 'dshc-themes'
      const cur = loadTheme()
      for (const key of Object.keys(THEMES)) {
        const dot = document.createElement('button')
        dot.className = `dshc-theme-dot${key === cur ? ' active' : ''}`
        dot.dataset.theme = key
        dot.title = THEMES[key].label
        dot.style.background = THEMES[key].accent2
        dot.style.boxShadow = `0 0 0 1px ${THEMES[key].border}, 0 1px 4px rgba(0,0,0,.3)`
        dot.addEventListener('click', () => {
          saveTheme(key)
          applyTheme()
        })
        themes.appendChild(dot)
      }
      head.appendChild(themes)
      bodyEl.appendChild(head)

      if (!data) {
        bodyEl.appendChild(el('div', `${L.loading}（桥不可用）`))
        return
      }
      const bundles = data.bundles || []
      const pre = (data.preinstalled || []).map((p) => (typeof p === 'string' ? { name: p, description: '' } : p))
      const preNames = pre.map((p) => p.name)
      const op = data.op || {}
      const TEMPLATE = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
      const userPlugins = bundles.filter((b) => !preNames.includes(b) && !TEMPLATE.includes(b))

      // ── pending restart banner (survives re-renders) ──
      if (pendingRestart) {
        bodyEl.appendChild(el('div', `✓ ${L.opDone} — ${L.restartToApply}`, 'dshc-op show'))
        showRestartNow()
      } else if (op && op.op && !op.done) {
        const opEl = document.createElement('div')
        opEl.className = 'dshc-op show'
        opEl.innerHTML = `<span class="dshc-spin"></span>${L.opActive}：${op.op} ${op.spec || ''}…`
        bodyEl.appendChild(opEl)
      } else if (op && op.done && op.ok) {
        // A hint means the install landed as a plain dependency (no dsh.bundle):
        // it will never load as a plugin, and no restart is needed — say so
        // plainly instead of promising "重启后生效".
        if (op.nextAction) pendingRestart = true
        const text = op.hint ? `${L.opDone} — ${op.hint}` : `✓ ${L.opDone} — ${L.restartToApply}`
        bodyEl.appendChild(el('div', text, 'dshc-op show'))
        if (op.nextAction) showRestartNow()
      } else if (op && op.done && !op.ok) {
        bodyEl.appendChild(el('div', `✗ ${L.opErr}：${op.spec || ''} ${op.error || ''}`, 'dshc-op show err'))
      }

      // ── install ──
      section(L.install)
      const inputWrap = document.createElement('div')
      inputWrap.className = 'dshc-install'
      const input = document.createElement('input')
      input.type = 'text'
      input.placeholder = L.installHint
      input.id = 'dshc-spec'
      input.value = installSpec
      input.addEventListener('input', () => { installSpec = input.value })
      if (wasFocused && typeof input.focus === 'function') input.focus()
      const installBtn = document.createElement('button')
      installBtn.className = 'dshc-btn2 primary'
      installBtn.id = 'dshc-install'
      installBtn.textContent = L.installBtn
      inputWrap.appendChild(input)
      inputWrap.appendChild(installBtn)
      bodyEl.appendChild(inputWrap)

      // ── preinstalled ──
      section(L.preinstalled, L.preinstalledHint)
      const pu = data.preinstalledUpdates || {}
      if (pre.length === 0) {
        bodyEl.appendChild(el('div', L.noPreinstalled, 'dshc-hint'))
      }
      for (const p of pre) {
        const on = bundles.includes(p.name)
        const info = pu[p.name] || {}
        let badge = on ? L.enabled : L.notEnabled
        let badgeCls = on ? 'on' : ''
        let sub = p.description || ''
        let right = `<button class="dshc-btn2 ${on ? '' : 'primary'}" data-toggle="${p.name}">${on ? L.disable : L.enable}</button>`
        // 有更新时不再额外加 "有更新 vX" 徽标——右侧高亮的「更新到 vX」按钮本身就是提示
        if (info.updateAvailable) {
          right = `<button class="dshc-btn2 primary" data-upd-pre="${p.name}">${L.updateTo}${info.latest}</button>` + right
        }
        if (info.userUpdated) {
          if (!sub) sub = L.userUpdatedHint
          right += `<button class="dshc-btn2" data-reset-pre="${p.name}">${L.resetDefault}</button>`
        }
        bodyEl.appendChild(row(p.name, badge, badgeCls, right, sub))
      }
      const checkPreBtn = document.createElement('button')
      checkPreBtn.id = 'dshc-check-pre'
      checkPreBtn.className = 'dshc-btn2'
      checkPreBtn.textContent = L.checkPreUpdates
      bodyEl.appendChild(checkPreBtn)

      // ── user installed ──
      section(L.userInstalled, L.userInstalledHint)
      if (userPlugins.length === 0) {
        bodyEl.appendChild(el('div', L.noUserPlugins, 'dshc-hint'))
      }
      for (const name of userPlugins) {
        const btn = `<button class="dshc-btn2" data-remove="${name}">${L.uninstall}</button><button class="dshc-btn2" data-update="${name}">${L.updateOne}</button>`
        bodyEl.appendChild(row(name, null, null, btn, ''))
      }
      // 完整只读清单（含 dsh 内置 160+ 个内部插件）在 dsh 自己的设置页，不在此重复。
      bodyEl.appendChild(el('div', L.fullListHint, 'dshc-hint'))

      // ── update ──
      section(L.update)
      const u = data.update || {}
      const current = u.current || L.unknown
      const latest = u.latest || L.unknown
      if (u.updateAvailable) {
        const btn = `<button class="dshc-btn2 primary" id="dshc-update">${L.updateNow}</button>`
        bodyEl.appendChild(row(`${L.update}：${L.current} ${current} → ${latest}`, null, null, btn, ''))
      } else {
        bodyEl.appendChild(el('div', `${L.update}：${L.current} ${current}（${L.upToDate}）`, 'dshc-hint'))
      }

      // ── actions ──
      section(L.actions, L.restartHint)
      const actions = [
        ['dshc-refresh', L.refresh],
        ['dshc-restart', L.restart],
      ]
      if (data.devMode) actions.push(['dshc-devtools', L.devtools])
      const actionsEl = document.createElement('div')
      actionsEl.className = 'dshc-actions'
      actionsEl.innerHTML = actions
        .map(([id, label]) => `<button class="dshc-btn2" id="${id}">${label}</button>`)
        .join(' ')
      bodyEl.appendChild(actionsEl)
      bodyEl.appendChild(el('div', 'DSH Desktop', 'dshc-footer'))
      bindEvents()
    }

    function bindEvents() {
      bodyEl.querySelectorAll('.dshc-theme-dot').forEach((dot) => {
        if (dot._bound) return
        dot._bound = true
        dot.addEventListener('click', () => {
          saveTheme(dot.dataset.theme)
          applyTheme()
        })
      })
      bodyEl.querySelectorAll('[data-toggle]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.toggle
          const on = (await bridge('/plugins/list'))?.bundles?.includes(name)
          const res = await bridge(on ? '/plugins/disable' : '/plugins/enable', { method: 'POST', body: { name } })
          if (res && res.ok) {
            pendingRestart = true
            status(`${L.opDone} — ${L.restartToApply}`, 'ok')
            refresh()
          } else {
            status(`${L.failed}：${(res && res.error) || 'bridge'}`, 'err')
          }
        })
      })
      bodyEl.querySelectorAll('[data-upd-pre]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.updPre
          await bridge('/plugins/update-preinstalled', { method: 'POST', body: { name } })
          status(`${L.opActive}：${L.updateOne} ${name}`, 'warn')
        })
      })
      bodyEl.querySelectorAll('[data-reset-pre]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.resetPre
          if (!globalThis.confirm || confirm(`${L.resetDefault}：${name}？`)) {
            await bridge('/plugins/reset-preinstalled', { method: 'POST', body: { name } })
            status(`${L.opActive}：${L.resetDefault} ${name}`, 'warn')
          }
        })
      })
      const checkPreBtn = bodyEl.querySelector('#dshc-check-pre')
      if (checkPreBtn) {
        checkPreBtn.addEventListener('click', async () => {
          checkPreBtn.disabled = true
          checkPreBtn.textContent = L.checkingPre
          await bridge('/plugins/check-preinstalled-updates', { method: 'POST' })
          setTimeout(() => {
            checkPreBtn.disabled = false
            checkPreBtn.textContent = L.checkPreUpdates
          }, 1500)
        })
      }
      bodyEl.querySelectorAll('[data-remove]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.remove
          if (!globalThis.confirm || confirm(`卸载插件 ${name}？`)) {
            await bridge('/plugins/remove', { method: 'POST', body: { name } })
            status(`${L.opActive}：${L.uninstall} ${name}`, 'warn')
          }
        })
      })
      bodyEl.querySelectorAll('[data-update]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.update
          await bridge('/plugins/update', { method: 'POST', body: { name } })
          status(`${L.opActive}：${L.updateOne} ${name}`, 'warn')
        })
      })
      const specInput = bodyEl.querySelector('#dshc-spec')
      const installBtn = bodyEl.querySelector('#dshc-install')
      const doInstall = async () => {
        if (!specInput) return
        const spec = specInput.value.trim()
        if (!spec) return
        installBtn.disabled = true
        installBtn.textContent = L.installing
        await bridge('/plugins/install', { method: 'POST', body: { spec } })
        status(`${L.opActive}：${L.install} ${spec}`, 'warn')
        setTimeout(() => { if (installBtn) { installBtn.disabled = false; installBtn.textContent = L.installBtn } }, 1500)
      }
      if (installBtn) installBtn.addEventListener('click', doInstall)
      if (specInput) specInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doInstall() })
      const updateBtn = bodyEl.querySelector('#dshc-update')
      if (updateBtn) {
        updateBtn.addEventListener('click', async () => {
          updateBtn.disabled = true
          updateBtn.textContent = L.updating
          const res = await bridge('/update-dsh', { method: 'POST' })
          if (res === null) status(L.failed, 'err')
          else showOverlay(L.updating)
        })
      }
      const refreshBtn = bodyEl.querySelector('#dshc-refresh')
      if (refreshBtn) refreshBtn.addEventListener('click', () => bridge('/refresh', { method: 'POST' }))
      const restartBtn = bodyEl.querySelector('#dshc-restart')
      if (restartBtn) {
        restartBtn.addEventListener('click', () => {
          bridge('/restart', { method: 'POST' })
          showOverlay(L.restart + '…')
        })
      }
      const dtBtn = bodyEl.querySelector('#dshc-devtools')
      if (dtBtn) dtBtn.addEventListener('click', () => bridge('/devtools', { method: 'POST' }))
    }

    function mount() {
      if (mounted) return
      mounted = true
      injectStyle()
      const btn = document.createElement('button')
      btn.className = 'dshc-btn'
      btn.textContent = '⚙ 插件'
      btn.title = L.title
      btn.addEventListener('click', () => {
        if (!panelEl) {
          panelEl = document.createElement('div')
          panelEl.className = 'dshc-panel'
          bodyEl = document.createElement('div')
          panelEl.appendChild(bodyEl)
          document.body.appendChild(panelEl)
          applyTheme()
          refresh()
          return // first click opens (display is visible from applyTheme)
        }
        const visible = panelEl.style.display !== 'none'
        panelEl.style.display = visible ? 'none' : 'block'
        if (!visible) refresh()
      })
      document.body.appendChild(btn)
      // Keep the panel fresh while open (cheap loopback polls); never re-render
      // while the user is typing in the install input.
      setInterval(() => {
        const typing = document.activeElement && document.activeElement.id === 'dshc-spec'
        if (panelEl && panelEl.style.display !== 'none' && !typing) refresh()
      }, 5000)
    }

    return {
      name: '@dsh-desktop/plugin-console',
      inject: [],
      apply() { mount() },
    }
  },
})
