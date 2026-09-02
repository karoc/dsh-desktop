// DSH Smoothly Desktop — 插件管理窗口（壳内独立窗口版插件控制台）。
//
// 与 dsh 页内原插件控制台（plugins/dsh-plugin-console/client.js）同一套渲染
// 核心与视觉 token（主题/语言/卡片行/开关/预发布通道），区别只在宿主：
// 本窗口是壳的独立 webview（label "plugins"），**不依赖 dsh 页面**——
// dsh 崩溃/未启动时同样能管理插件（安装/卸载/启用/禁用/更新）。
//
// 数据通道：环回桥 /plugins/*（桥由 Rust 壳拉起，不依赖 dsh 进程）。
// 桥端口由壳注入为 window.__DSH_BRIDGE_PORT__（字符串；注入晚于本脚本执行
// 是可能的，启动时轮询等待其就绪）。

(() => {
  'use strict';

  const BRIDGE_PORT = globalThis.__DSH_BRIDGE_PORT__ || ''
  const ready = () => Boolean(BRIDGE_PORT) && !String(BRIDGE_PORT).startsWith('__DSH')

  // ── i18n（与页内原面板同文案，中文默认，可切英文）──────────────────
  const ZH = {
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
    allPlugins: '全部插件',
    fullListHint: '完整只读清单（含 dsh 内置的内部插件）见 dsh 设置 → 插件',
    userInstalled: '已安装插件',
    userInstalledHint: '通过下方输入框安装',
    uninstall: '卸载',
    updateOne: '更新',
    update: 'dsh 更新',
    upToDate: '已是最新版本',
    updateNow: '一键更新',
    updating: '正在更新并重启…',
    prerelease: '预发布',
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
    langSwitch: '切换语言',
    confirmUninstall: '卸载插件 %s？',
    notABundle: '已安装：%s 未声明 dsh.bundle，不会作为插件加载',
  }
  const EN = {
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
    allPlugins: 'All plugins',
    fullListHint: 'Full read-only list (incl. built-in dsh plugins): dsh Settings → Plugins',
    userInstalled: 'Installed plugins',
    userInstalledHint: 'Add more with the input above',
    uninstall: 'Remove',
    updateOne: 'Update',
    update: 'dsh update',
    upToDate: 'Up to date',
    updateNow: 'Update now',
    updating: 'Updating & restarting…',
    prerelease: 'pre-release',
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
    langSwitch: 'Switch language',
    confirmUninstall: 'Remove plugin %s?',
    notABundle: 'Installed: %s declares no dsh.bundle — will not load as a plugin',
  }

  const LANG_STORAGE = 'dshc-lang'
  function loadLang() {
    try {
      return globalThis.localStorage?.getItem(LANG_STORAGE) === 'en' ? 'en' : 'zh'
    } catch { return 'zh' }
  }
  function saveLang(l) {
    try { globalThis.localStorage?.setItem(LANG_STORAGE, l) } catch { /* no storage */ }
  }
  let lang = loadLang()
  let L = lang === 'zh' ? ZH : EN
  function setLang(next) {
    lang = next === 'en' ? 'en' : 'zh'
    L = lang === 'zh' ? ZH : EN
    saveLang(lang)
  }

  // 预装插件的双语简介（壳自有插件的简介我们维护；未收录的用包自带 description）。
  const DESC = {
    'dsh-model-reasoning': {
      zh: '为第三方（pi-ai）模型提供按模型配置思考等级（reasoning effort）的设置页',
      en: 'Settings page to configure per-model reasoning efforts (thinking levels) for third-party (pi-ai) providers',
    },
  }
  function descFor(name, fallback) {
    return DESC[name]?.[lang] || fallback || ''
  }

  // ── themes（与页内原面板一致：深空/极光/月光/琥珀）──────────────────
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

  // ── 桥（与页内面板同：环回桥 /plugins/*，壳提供，不依赖 dsh）───────
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

  let bodyEl = null
  // Set when a plugin op / toggle succeeded and dsh must restart to apply.
  let pendingRestart = false
  // Preserved install input value across re-renders (a refresh must not wipe
  // what the user is typing).
  let installSpec = ''

  // ── styling（与页内面板同一套 .dshc-* token）─────────────────────────
  const STYLE_ID = 'dsh-desktop-console-window-style'
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = `
.dshc-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 16px; }
.dshc-title { font-size: 15px; font-weight: 700; letter-spacing: .2px; }
.dshc-themes { display: flex; gap: 7px; align-items: center; }
.dshc-theme-dot {
  width: 18px; height: 18px; border-radius: 50%; cursor: pointer; padding: 0;
  border: 2px solid transparent; transition: transform .12s ease, border-color .12s ease;
  box-shadow: 0 1px 4px rgba(0,0,0,.3);
}
.dshc-theme-dot:hover { transform: scale(1.2); }
.dshc-theme-dot.active { border-color: var(--dshc-text); }
.dshc-sec-label {
  font-size: 11px; font-weight: 700; letter-spacing: .8px; text-transform: uppercase;
  color: var(--dshc-muted); margin: 20px 0 8px; display: flex; align-items: center; gap: 8px;
}
.dshc-sec-label::after { content: ''; flex: 1; height: 1px; background: var(--dshc-border); }
.dshc-hint { color: var(--dshc-muted); font-size: 11.5px; margin-top: 5px; }
.dshc-row {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 12px 14px; margin: 7px 0; border-radius: 12px;
  background: var(--dshc-surface); border: 1px solid var(--dshc-border);
  transition: background .15s ease, transform .15s ease;
}
.dshc-row:hover { background: var(--dshc-surfaceHover); }
.dshc-row > div:last-child { display: flex; flex-wrap: wrap; gap: 7px; justify-content: flex-end; }
.dshc-name { font-weight: 600; word-break: break-all; font-size: 12.5px; }
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
.dshc-switch {
  position: relative; width: 42px; height: 23px; border-radius: 999px; padding: 0;
  background: color-mix(in srgb, var(--dshc-muted) 35%, transparent);
  border: 1px solid var(--dshc-border); cursor: pointer; flex-shrink: 0;
  transition: background .18s ease, border-color .18s ease;
}
.dshc-switch .dshc-switch-knob {
  position: absolute; top: 2px; left: 2px; width: 17px; height: 17px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.35);
  transition: transform .18s ease;
}
.dshc-switch.on {
  background: linear-gradient(135deg, var(--dshc-accent), var(--dshc-accent2));
  border-color: transparent;
}
.dshc-switch.on .dshc-switch-knob { transform: translateX(19px); }
.dshc-switch:disabled { opacity: .45; cursor: default; }
.dshc-upd-arrow {
  width: 24px; height: 24px; border-radius: 50%; border: none; padding: 0; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, var(--dshc-success), #22c55e); color: #fff;
  font-size: 13px; line-height: 1; flex-shrink: 0;
  box-shadow: 0 1px 4px rgba(34,197,94,.35);
  transition: transform .12s ease, filter .12s ease;
}
.dshc-upd-arrow:hover { transform: scale(1.1); filter: brightness(1.08); }
.dshc-upd-arrow:active { transform: scale(.95); }
.dshc-item { margin: 7px 0; }
.dshc-item {
  background: var(--dshc-surface); border: 1px solid var(--dshc-border);
  border-radius: 12px; padding: 12px 14px;
}
.dshc-item:hover { background: var(--dshc-surfaceHover); }
.dshc-item .dshc-row {
  margin: 0; padding: 0; background: transparent; border: none; border-radius: 0;
  align-items: stretch;
}
.dshc-item .dshc-row:hover { background: transparent; }
.dshc-item .dshc-row > div:last-child {
  display: flex; flex-direction: column; align-items: flex-end;
  justify-content: center; gap: 8px; flex-shrink: 0; flex-wrap: nowrap;
}
.dshc-item-right { display: flex; flex-direction: column; align-items: flex-end; justify-content: center; gap: 8px; }
.dshc-item-actions { display: flex; gap: 6px; white-space: nowrap; }
.dshc-reset { font-size: 11px; padding: 4px 10px; }
.dshc-lang { min-width: 44px; font-size: 11px; padding: 4px 8px; }
.dshc-actions { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 8px; }
.dshc-btn2 {
  border: 1px solid var(--dshc-border); background: var(--dshc-surface); color: var(--dshc-text);
  border-radius: 8px; padding: 7px 16px; min-width: 72px; text-align: center;
  font: 600 12.5px/1.4 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;
  cursor: pointer; transition: background .15s ease, transform .12s ease, border-color .15s ease;
  white-space: nowrap;
}
.dshc-btn2:hover { background: var(--dshc-surfaceHover); border-color: var(--dshc-accent); }
.dshc-btn2:active { transform: scale(.97); }
/* 主按钮：纯色 accent（与壳内弹窗/设置窗统一；不再用渐变） */
.dshc-btn2.primary {
  border-color: transparent;
  background: var(--dshc-accent);
  color: #fff;
}
.dshc-btn2.primary:hover { filter: brightness(1.08); }
/* 危险操作（卸载/恢复默认确认）：纯色错误色 */
.dshc-btn2.danger {
  border-color: transparent;
  background: var(--dshc-err);
  color: #fff;
}
.dshc-btn2.danger:hover { filter: brightness(1.1); }
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
  flex: 1; min-width: 0; padding: 8px 12px; border-radius: 8px;
  border: 1px solid var(--dshc-border); background: var(--dshc-surface);
  color: var(--dshc-text); font: 12.5px/1.4 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;
  outline: none; transition: border-color .15s ease;
}
.dshc-install input:focus { border-color: var(--dshc-accent); }
.dshc-install input::placeholder { color: color-mix(in srgb, var(--dshc-muted) 75%, transparent); }
.dshc-footer { margin-top: 16px; padding-top: 11px; border-top: 1px solid var(--dshc-border); font-size: 11px; color: var(--dshc-muted); }
@keyframes dshc-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
@keyframes dshc-spin { to { transform: rotate(360deg); } }
.dshc-spin {
  display: inline-block; width: 12px; height: 12px; margin-right: 7px;
  border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%;
  vertical-align: -1px; animation: dshc-spin .8s linear infinite;
}
.dshc-overlay {
  position: fixed; inset: 0; z-index: 2147483999;
  background: rgba(6, 8, 12, .7); backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px;
  color: #e6edf3; font: 600 14px/1.4 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;
}
.dshc-overlay .dshc-spin { width: 36px; height: 36px; border-width: 3px; }
/* ── 壳内确认弹窗（替换原生 confirm；与壳内模态弹窗同一视觉规范） ── */
.dshc-confirm-backdrop {
  position: fixed; inset: 0; z-index: 2147483900;
  background: rgba(0,0,0,.35); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
  display: flex; align-items: center; justify-content: center; padding: 24px;
  animation: dshc-in .15s ease;
}
.dshc-confirm {
  min-width: 280px; max-width: 380px; width: min(380px, 100%);
  background: var(--dshc-bg); color: var(--dshc-text);
  border: 1px solid var(--dshc-border); border-radius: 14px;
  box-shadow: var(--dshc-shadow); padding: 18px 20px 16px;
  animation: dshc-in .18s ease;
}
.dshc-confirm-title { font-size: 14px; font-weight: 700; margin-bottom: 8px; }
.dshc-confirm-msg { font-size: 12.5px; color: var(--dshc-muted); line-height: 1.5; word-break: break-all; }
.dshc-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
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
    // 主题只控制配色（bg/surface/border/text/muted/accent/…与浮层阴影氛围）；
    // 几何（圆角/按钮/间距/字号）由 CSS 固定值统一（与壳内/设置窗同一规范）。
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
    ].join('; ')
    document.body.style.background = theme.bg
    document.body.style.color = theme.text
    if (bodyEl) {
      bodyEl.style.cssText = `color: ${theme.text}; font: 13px/1.55 system-ui,"Segoe UI","Microsoft YaHei",sans-serif; ${vars}`
    }
    const dots = bodyEl ? bodyEl.querySelectorAll('.dshc-theme-dot') : []
    dots.forEach((d) => d.classList.toggle('active', d.dataset.theme === t))
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
  function attachTooltip(targetEl, text) {
    targetEl.addEventListener('mouseenter', () => {
      const t = tip()
      t.textContent = text
      t.style.opacity = '1'
    })
    targetEl.addEventListener('mousemove', (e) => {
      const t = tip()
      const x = (e.clientX || 0) + 14
      const y = (e.clientY || 0) + 14
      const vw = globalThis.innerWidth || 1280
      const vh = globalThis.innerHeight || 800
      t.style.left = `${Math.min(x, vw - 300)}px`
      t.style.top = `${Math.min(y, vh - 90)}px`
    })
    targetEl.addEventListener('mouseleave', () => {
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
      attachTooltip(s, sub)
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

  // ── 壳内确认弹窗（替代原生 confirm；resolve(true/false)）──────────
  function showConfirm({ title, message, okLabel, cancelLabel, danger }) {
    return new Promise((resolve) => {
      const bd = document.createElement('div')
      bd.className = 'dshc-confirm-backdrop'
      const card = document.createElement('div')
      card.className = 'dshc-confirm'
      card.appendChild(el('div', title, 'dshc-confirm-title'))
      card.appendChild(el('div', message, 'dshc-confirm-msg'))
      const actions = document.createElement('div')
      actions.className = 'dshc-confirm-actions'
      const cancel = document.createElement('button')
      cancel.className = 'dshc-btn2'
      cancel.textContent = cancelLabel || (lang === 'zh' ? '取消' : 'Cancel')
      const ok = document.createElement('button')
      ok.className = 'dshc-btn2' + (danger ? ' danger' : ' primary')
      ok.textContent = okLabel || (lang === 'zh' ? '确定' : 'OK')
      const done = (v) => { bd.remove(); resolve(v) }
      cancel.addEventListener('click', () => done(false))
      ok.addEventListener('click', () => done(true))
      bd.addEventListener('mousedown', (e) => { if (e.target === bd) done(false) })
      actions.append(cancel, ok)
      card.appendChild(actions)
      bd.appendChild(card)
      document.body.appendChild(bd)
    })
  }

  async function refresh() {
    if (!bodyEl) return
    const prevSpec = bodyEl.querySelector('#dshc-spec')
    const wasFocused = prevSpec !== null && document.activeElement === prevSpec
    if (prevSpec) installSpec = prevSpec.value
    const data = await bridge('/plugins/list')
    bodyEl.textContent = ''
    applyTheme()

    const head = document.createElement('div')
    head.className = 'dshc-head'
    head.appendChild(el('div', L.title, 'dshc-title'))
    const langBtn = document.createElement('button')
    langBtn.id = 'dshc-lang'
    langBtn.className = 'dshc-btn2 dshc-lang'
    langBtn.textContent = lang === 'zh' ? 'EN' : '中文'
    langBtn.title = L.langSwitch
    langBtn.addEventListener('click', () => { setLang(lang === 'zh' ? 'en' : 'zh'); refresh() })
    head.appendChild(langBtn)
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
      bodyEl.appendChild(el('div', `${L.loading}（桥不可用）`, 'dshc-hint'))
      return
    }
    const bundles = data.bundles || []
    const pre = (data.preinstalled || []).map((p) => (typeof p === 'string' ? { name: p, description: '' } : p))
    const preNames = pre.map((p) => p.name)
    const op = data.op || {}
    const TEMPLATE = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
    const userPlugins = bundles.filter((b) => !preNames.includes(b) && !TEMPLATE.includes(b))

    if (pendingRestart) {
      bodyEl.appendChild(el('div', `✓ ${L.opDone} — ${L.restartToApply}`, 'dshc-op show'))
      showRestartNow()
    } else if (op && op.op && !op.done) {
      const opEl = document.createElement('div')
      opEl.className = 'dshc-op show'
      opEl.innerHTML = `<span class="dshc-spin"></span>${L.opActive}：${op.op} ${op.spec || ''}…`
      bodyEl.appendChild(opEl)
    } else if (op && op.done && op.ok) {
      if (op.nextAction) pendingRestart = true
      let hintText = ''
      if (op.hintKey === 'not-a-bundle') {
        hintText = L.notABundle.replace('%s', (op.hintPlugins || []).join(', '))
      } else if (op.hint) {
        hintText = op.hint
      }
      const text = hintText ? `${L.opDone} — ${hintText}` : `✓ ${L.opDone} — ${L.restartToApply}`
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
      let sub = descFor(p.name, p.description)
      const right = document.createElement('div')
      right.className = 'dshc-item-right'
      const actions = document.createElement('div')
      actions.className = 'dshc-item-actions'
      let actionsHtml = `<button class="dshc-switch${on ? ' on' : ''}" data-toggle="${p.name}" role="switch" aria-checked="${on}"><span class="dshc-switch-knob"></span></button>`
      if (info.updateAvailable) {
        const tipText = `${L.updateTo}${info.latest}`
        actionsHtml = `<button class="dshc-upd-arrow" data-upd-pre="${p.name}" aria-label="${tipText}">↑</button>` + actionsHtml
      }
      actions.innerHTML = actionsHtml
      right.appendChild(actions)
      if (info.userUpdated) {
        if (!sub) sub = L.userUpdatedHint
        const resetBtn = document.createElement('button')
        resetBtn.className = 'dshc-btn2 dshc-reset'
        resetBtn.dataset.resetPre = p.name
        resetBtn.textContent = L.resetDefault
        right.appendChild(resetBtn)
      }
      const rowEl = document.createElement('div')
      rowEl.className = 'dshc-row'
      const left = document.createElement('div')
      const nameEl = document.createElement('span')
      nameEl.className = 'dshc-name'
      nameEl.textContent = p.name
      left.appendChild(nameEl)
      if (sub) {
        const s = el('div', sub, 'dshc-sub')
        attachTooltip(s, sub)
        left.appendChild(s)
      }
      rowEl.appendChild(left)
      rowEl.appendChild(right)
      const wrap = document.createElement('div')
      wrap.className = 'dshc-item'
      wrap.appendChild(rowEl)
      bodyEl.appendChild(wrap)
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
    bodyEl.appendChild(el('div', L.fullListHint, 'dshc-hint'))

    // ── update ──
    section(L.update)
    const u = data.update || {}
    const current = u.current || L.unknown
    const latest = u.latest || L.unknown
    if (u.updateAvailable) {
      const btn = `<button class="dshc-btn2 primary" id="dshc-update" data-version="${latest}">${L.updateNow}</button>`
      bodyEl.appendChild(row(`${L.update}：${L.current} ${current} → ${latest}`, null, null, btn, ''))
    } else if (u.nextAvailable && u.next) {
      const btn = `<button class="dshc-btn2 primary" id="dshc-update" data-version="${u.next}">${L.updateNow}</button>`
      bodyEl.appendChild(row(`${L.update}：${L.current} ${current} → ${u.next}（${L.prerelease}）`, null, null, btn, ''))
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
    bodyEl.appendChild(el('div', 'DSH Smoothly Desktop', 'dshc-footer'))
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
      const label = btn.getAttribute('aria-label') || ''
      if (label) attachTooltip(btn, label)
      btn.addEventListener('click', async () => {
        const name = btn.dataset.updPre
        await bridge('/plugins/update-preinstalled', { method: 'POST', body: { name } })
        status(`${L.opActive}：${L.updateOne} ${name}`, 'warn')
      })
    })
    bodyEl.querySelectorAll('[data-reset-pre]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.resetPre
        const ok = await showConfirm({
          title: L.resetDefault,
          message: `${L.resetDefault}：${name}？`,
          okLabel: L.resetDefault,
        })
        if (ok) {
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
        const ok = await showConfirm({
          title: L.uninstall,
          message: L.confirmUninstall.replace('%s', name),
          okLabel: L.uninstall,
          danger: true,
        })
        if (ok) {
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
        const res = await bridge('/update-dsh', { method: 'POST', body: updateBtn.dataset.version ? { version: updateBtn.dataset.version } : {} })
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

  // ── boot：等待壳注入桥端口（可能晚于脚本执行），就绪后初始化 ────────
  function init() {
    bodyEl = document.getElementById('dshc-app')
    if (!bodyEl) return
    injectStyle()
    applyTheme()
    refresh()
  }

  const appEl = document.getElementById('dshc-app')
  if (appEl) {
    const boot = document.createElement('div')
    boot.className = 'dshc-boot'
    boot.textContent = '加载中…'
    appEl.appendChild(boot)
    let tries = 0
    const timer = setInterval(() => {
      tries += 1
      if (ready() || tries > 50) {
        clearInterval(timer)
        init()
      }
    }, 100)
  }
})()