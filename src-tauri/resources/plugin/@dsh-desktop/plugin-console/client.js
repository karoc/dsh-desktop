// DSH Desktop — plugin console, browser half.
//
// Classic-script bundle served by dsh web under /plugins/<id>/client.js and
// registered through window.__ModuleLoader__.load (the dsh client module
// system). Renders a floating "插件" button (bottom-right) opening a panel
// that manages the shell:
//   - preinstalled plugins (D3): enable / disable (writes dsh.profile.bundles)
//   - dsh update status + one-click update (D2: user decides)
//   - service actions: refresh page / restart dsh / restart service
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

    const L = (navigator.language || 'en').toLowerCase().startsWith('zh')
      ? {
          title: '插件与更新',
          install: '安装新插件',
          installHint: 'npm 包名 或 github:user/repo / git+https://…',
          installBtn: '安装',
          installing: '正在安装…',
          preinstalled: '预装插件（默认关闭）',
          enabled: '已启用',
          notEnabled: '未启用',
          enable: '启用',
          disable: '关闭',
          builtin: '内置',
          userInstalled: '用户安装',
          uninstall: '卸载',
          updateOne: '更新',
          update: 'dsh 更新',
          check: '检查更新',
          updateNow: '一键更新',
          upToDate: '已是最新版本',
          updating: '正在更新并重启…',
          unknown: '未知',
          actions: '操作',
          refresh: '刷新页面',
          restartDsh: '重启 dsh',
          restartAll: '重启服务',
          restartToApply: '重启 dsh 后生效',
          restartNow: '立即重启',
          failed: '操作失败',
          loading: '加载中…',
          noPreinstalled: '（无预装插件）',
          noUserPlugins: '（无用户安装的插件）',
          opActive: '正在处理',
          opDone: '完成',
          opErr: '失败',
        }
      : {
          title: 'Plugins & updates',
          install: 'Install plugin',
          installHint: 'npm package, or github:user/repo / git+https://…',
          installBtn: 'Install',
          installing: 'Installing…',
          preinstalled: 'Preinstalled (off by default)',
          enabled: 'Enabled',
          notEnabled: 'Off',
          enable: 'Enable',
          disable: 'Disable',
          builtin: 'Built-in',
          userInstalled: 'User installed',
          uninstall: 'Remove',
          updateOne: 'Update',
          update: 'dsh update',
          check: 'Check',
          updateNow: 'Update now',
          upToDate: 'Up to date',
          updating: 'Updating & restarting…',
          unknown: 'unknown',
          actions: 'Actions',
          refresh: 'Refresh page',
          restartDsh: 'Restart dsh',
          restartAll: 'Restart service',
          restartToApply: 'Restart dsh to apply',
          restartNow: 'Restart now',
          failed: 'Operation failed',
          loading: 'Loading…',
          noPreinstalled: '(no preinstalled plugins)',
          noUserPlugins: '(no user-installed plugins)',
          opActive: 'Working…',
          opDone: 'Done',
          opErr: 'Failed',
        }

    let panelEl = null
    let bodyEl = null
    let mounted = false

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

    // ── styling (injected once) ───────────────────────────────────────────
    const STYLE_ID = 'dsh-desktop-console-style'
    function injectStyle() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
.dshc-btn {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
  padding: 8px 14px; border: 1px solid rgba(255,255,255,.14); border-radius: 10px;
  background: rgba(22,27,34,.92); color: #e6edf3; font: 13px/1 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;
  cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.4); backdrop-filter: blur(6px);
}
.dshc-btn:hover { background: rgba(33,38,45,.95); }
.dshc-panel {
  position: fixed; right: 18px; bottom: 56px; z-index: 2147483000;
  width: 340px; max-height: 70vh; overflow: auto;
  background: rgba(22,27,34,.97); border: 1px solid rgba(255,255,255,.12); border-radius: 12px;
  color: #e6edf3; font: 13px/1.5 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;
  box-shadow: 0 12px 40px rgba(0,0,0,.55); padding: 14px 16px;
}
.dshc-panel h3 { margin: 0 0 8px; font-size: 14px; color: #e6edf3; }
.dshc-panel h4 { margin: 14px 0 6px; font-size: 12px; color: #8b949e; font-weight: 600; text-transform: none; }
.dshc-row {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 7px 0; border-top: 1px solid rgba(255,255,255,.06);
}
.dshc-row:first-of-type { border-top: none; }
.dshc-name { font-weight: 600; color: #e6edf3; word-break: break-all; }
.dshc-badge {
  font-size: 11px; padding: 1px 7px; border-radius: 99px;
  background: rgba(31,111,235,.25); color: #79b8ff; margin-left: 6px; white-space: nowrap;
}
.dshc-badge.on { background: rgba(63,185,80,.2); color: #56d364; }
.dshc-badge.core { background: rgba(139,148,158,.2); color: #8b949e; }
.dshc-desc { color: #8b949e; font-size: 12px; margin-top: 2px; }
.dshc-btn2 {
  border: 1px solid rgba(255,255,255,.18); background: transparent; color: #e6edf3;
  border-radius: 6px; padding: 3px 10px; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.dshc-btn2:hover { background: rgba(255,255,255,.08); }
.dshc-btn2.primary { border-color: #1f6feb; background: rgba(31,111,235,.35); color: #c9e1ff; }
.dshc-btn2:disabled { opacity: .45; cursor: default; }
.dshc-status {
  margin-top: 10px; padding: 7px 10px; border-radius: 8px; font-size: 12px; display: none;
}
.dshc-status.show { display: block; }
.dshc-status.ok { background: rgba(63,185,80,.14); color: #56d364; }
.dshc-status.warn { background: rgba(210,153,34,.16); color: #d29922; }
.dshc-status.err { background: rgba(248,81,73,.14); color: #f85149; }
.dshc-hint { color: #8b949e; font-size: 12px; margin-top: 8px; }
.dshc-install { display: flex; gap: 6px; margin: 8px 0 2px; }
.dshc-install input {
  flex: 1; min-width: 0; padding: 6px 9px; border-radius: 7px;
  border: 1px solid rgba(255,255,255,.18); background: rgba(255,255,255,.05);
  color: #e6edf3; font: 12px/1.4 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;
}
.dshc-install input:focus { outline: none; border-color: #1f6feb; }
.dshc-install input::placeholder { color: #6e7681; }
.dshc-op {
  margin-top: 8px; padding: 7px 10px; border-radius: 8px; font-size: 12px;
  background: rgba(210,153,34,.14); color: #d29922; display: none;
}
.dshc-op.show { display: block; }
.dshc-op.err { background: rgba(248,81,73,.14); color: #f85149; }
`
      ;(document.head || document.documentElement).appendChild(style)
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

    function row(label, badge, badgeCls, rightHtml) {
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
      const right = document.createElement('div')
      right.innerHTML = rightHtml
      div.appendChild(left)
      div.appendChild(right)
      return div
    }

    function section(title) {
      const h = document.createElement('h4')
      h.textContent = title
      bodyEl.appendChild(h)
    }

    async function refresh() {
      if (!bodyEl) return
      const data = await bridge('/plugins/list')
      bodyEl.textContent = ''
      bodyEl.appendChild(el('h3', L.title))
      if (!data) {
        bodyEl.appendChild(el('div', `${L.loading}（桥不可用）`))
        return
      }
      const bundles = data.bundles || []
      const pre = data.preinstalled || []
      const op = data.op || {}
      const TEMPLATE = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
      const userPlugins = bundles.filter((b) => !pre.includes(b) && !TEMPLATE.includes(b))

      // ── install new plugin ──
      section(L.install)
      const inputWrap = document.createElement('div')
      inputWrap.className = 'dshc-install'
      const input = document.createElement('input')
      input.type = 'text'
      input.placeholder = L.installHint
      input.id = 'dshc-spec'
      const installBtn = document.createElement('button')
      installBtn.className = 'dshc-btn2 primary'
      installBtn.id = 'dshc-install'
      installBtn.textContent = L.installBtn
      inputWrap.appendChild(input)
      inputWrap.appendChild(installBtn)
      bodyEl.appendChild(inputWrap)
      bodyEl.appendChild(el('div', L.installHint, 'dshc-hint'))

      // ── active operation status ──
      if (op && op.op && !op.done) {
        const opEl = el('div', `${L.opActive}：${op.op} ${op.spec || ''}`, 'dshc-op show')
        bodyEl.appendChild(opEl)
      } else if (op && op.done && op.ok) {
        const opEl = el('div', `${L.opDone}：${op.spec || ''} — ${L.restartToApply}`, 'dshc-op show')
        bodyEl.appendChild(opEl)
        showRestartNow()
      } else if (op && op.done && !op.ok) {
        const opEl = el('div', `${L.opErr}：${op.spec || ''} ${op.error || ''}`, 'dshc-op show err')
        bodyEl.appendChild(opEl)
      }

      // ── preinstalled ──
      section(L.preinstalled)
      if (pre.length === 0) {
        bodyEl.appendChild(el('div', L.noPreinstalled, 'dshc-hint'))
      }
      for (const name of pre) {
        const on = bundles.includes(name)
        const badge = on ? L.enabled : L.notEnabled
        const badgeCls = on ? 'on' : ''
        const btn = `<button class="dshc-btn2 ${on ? '' : 'primary'}" data-toggle="${name}">${on ? L.disable : L.enable}</button>`
        bodyEl.appendChild(row(name, badge, badgeCls, btn))
      }

      // ── user installed ──
      section(L.userInstalled)
      if (userPlugins.length === 0) {
        bodyEl.appendChild(el('div', L.noUserPlugins, 'dshc-hint'))
      }
      for (const name of userPlugins) {
        const btn = `<button class="dshc-btn2" data-remove="${name}">${L.uninstall}</button><button class="dshc-btn2" data-update="${name}">${L.updateOne}</button>`
        bodyEl.appendChild(row(name, null, null, btn))
      }

      // ── update ──
      section(L.update)
      const u = data.update || {}
      const current = u.current || L.unknown
      const latest = u.latest || L.unknown
      if (u.updateAvailable) {
        const btn = `<button class="dshc-btn2 primary" id="dshc-update">${L.updateNow}</button>`
        bodyEl.appendChild(row(`${L.update}: ${current} → ${latest}`, null, null, btn))
      } else {
        bodyEl.appendChild(el('div', `${L.update}: ${current}（${L.upToDate}）`, 'dshc-hint'))
      }
      // ── actions ──
      section(L.actions)
      const actions = [
        ['dshc-refresh', L.refresh],
        ['dshc-restart-dsh', L.restartDsh],
        ['dshc-restart-all', L.restartAll],
        ['dshc-devtools', 'DevTools (F12)'],
      ]
        .map(([id, label]) => `<button class="dshc-btn2" id="${id}">${label}</button>`)
        .join(' ')
      const actionsEl = document.createElement('div')
      actionsEl.className = 'dshc-actions'
      actionsEl.innerHTML = actions // innerHTML, not textContent — the buttons must parse
      bodyEl.appendChild(actionsEl)
      bindEvents()
    }

    function el(tag, text, cls) {
      const e = document.createElement(tag)
      e.textContent = text
      if (cls) e.className = cls
      return e
    }

    function bindEvents() {
      bodyEl.querySelectorAll('[data-toggle]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.toggle
          const on = (await bridge('/plugins/list'))?.bundles?.includes(name)
          const res = await bridge(on ? '/plugins/disable' : '/plugins/enable', { method: 'POST', body: { name } })
          if (res && res.ok) {
            status(`${L.restartToApply}（${name}）`, 'warn')
            showRestartNow()
          } else {
            status(`${L.failed}：${(res && res.error) || 'bridge'}`, 'err')
          }
          refresh()
        })
      })
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
        })
      }
      const refreshBtn = bodyEl.querySelector('#dshc-refresh')
      if (refreshBtn) refreshBtn.addEventListener('click', () => bridge('/refresh', { method: 'POST' }))
      const rdBtn = bodyEl.querySelector('#dshc-restart-dsh')
      if (rdBtn) rdBtn.addEventListener('click', () => bridge('/restart-dsh', { method: 'POST' }))
      const raBtn = bodyEl.querySelector('#dshc-restart-all')
      if (raBtn) raBtn.addEventListener('click', () => bridge('/restart', { method: 'POST' }))
      const dtBtn = bodyEl.querySelector('#dshc-devtools')
      if (dtBtn) dtBtn.addEventListener('click', () => bridge('/devtools', { method: 'POST' }))
    }

    function showRestartNow() {
      let el2 = bodyEl.querySelector('#dshc-restart-now')
      if (el2) return
      el2 = document.createElement('button')
      el2.id = 'dshc-restart-now'
      el2.className = 'dshc-btn2 primary'
      el2.textContent = L.restartNow
      el2.style.cssText = 'margin-top:8px; display:block;'
      el2.addEventListener('click', () => bridge('/restart-dsh', { method: 'POST' }))
      bodyEl.appendChild(el2)
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
          refresh()
        }
        panelEl.style.display = panelEl.style.display === 'none' ? 'block' : 'none'
        if (panelEl.style.display === 'block') refresh()
      })
      document.body.appendChild(btn)
      // Keep the panel fresh while open (cheap loopback polls).
      setInterval(() => {
        if (panelEl && panelEl.style.display !== 'none') refresh()
      }, 5000)
    }

    return { name: '@dsh-desktop/plugin-console', inject: [], apply() { mount() } }
  },
})
