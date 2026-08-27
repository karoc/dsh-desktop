// DSH Desktop — 壳顶栏（注入式覆盖标题栏 + 菜单栏）。
//
// 由 Rust 壳在每次页面加载时注入主窗口（include_str! 编译期内嵌 +
// on_page_load 里 w.eval()）：启动页（tauri://localhost，有 __TAURI__）
// 与远程 dsh 页（http://127.0.0.1:*，无 __TAURI__ —— 经环回桥通信）都生效。
// 注入前缀会写入 window.__DSH_BRIDGE_PORT__（环回桥端口）与
// window.__DSH_SHELL_VERSION__（壳版本）。
//
// ── 壳菜单唯一定义点 ──────────────────────────────────────────────
// 以后加壳菜单 = 往 SHELL_MENUS 加条目 + ACTIONS 加一行映射。
// 条目形态：
//   { id, label, items: [...] }        下拉菜单（items 内支持
//                                      { id, label } / { type: 'sep' } /
//                                      { type: 'checkbox', id, label }）
//   { id, label, action: 'actionId' }  直开动作条目（无下拉）
//
// 测试钩子：脚本开头检测 __DSH_CHROME_TEST__（scripts/test-shell-chrome.mjs
// 在 vm 沙箱中提供），命中则只暴露配置、不渲染。
(() => {
  'use strict';

  const TEST_HOOK = globalThis.__DSH_CHROME_TEST__;

  const SHELL_MENUS = [
    {
      // 应用菜单：图标 + 应用名，下拉应用级动作（通用桌面范式）。
      id: 'app',
      label: 'DSH Desktop',
      items: [
        { id: 'check-update', label: '检查更新…' }, // 有更新时翻转为「有更新 vX（点击更新）」
        { id: 'dev-mode', label: '开发者模式', type: 'checkbox' },
        { type: 'sep' },
        { id: 'quit', label: '退出' },
      ],
    },
    // 可见顶级条目：代理设置直开设置窗口（无需下拉）。
    { id: 'proxy-settings', label: '代理设置…', action: 'proxy-settings' },
    {
      id: 'view',
      label: '视图',
      items: [
        { id: 'refresh', label: '刷新页面' },
        { id: 'restart', label: '重启服务' },
      ],
    },
    {
      id: 'help',
      label: '帮助',
      items: [
        { id: 'open-data', label: '打开数据目录' },
        { id: 'about', label: '关于 DSH Desktop' },
      ],
    },
  ];

  // ── 动作表：每个 id → 本地 IPC 命令 + 环回桥路径（双通道）─────────
  // ipc 命令必须在 lib.rs 的 invoke_handler 注册；bridge 路径必须在
  // handle_bridge_conn 有 match 分支（契约测试校验，勿漂移）。
  const ACTIONS = {
    'proxy-settings': { ipc: 'open_settings', bridge: '/shell/open-settings' },
    'check-update': { ipc: 'check_update', bridge: '/check-update' },
    'update-now': { ipc: 'update_now', bridge: '/update-dsh' },
    'dev-mode': { ipc: 'toggle_dev_mode', bridge: '/shell/dev-mode-toggle' },
    refresh: { ipc: 'refresh_page', bridge: '/refresh' },
    restart: { ipc: 'restart_server', bridge: '/restart' },
    'open-data': { ipc: 'open_data_dir', bridge: '/shell/open-data-dir' },
    about: { ipc: 'show_about', bridge: '/shell/about' },
    quit: { ipc: 'quit_app', bridge: '/shell/quit' },
    // 窗口控制（本地页走 IPC 命令 window_control；远程页走桥端点）。
    minimize: { ipc: 'window_control', args: { action: 'minimize' }, bridge: '/window/minimize' },
    'toggle-maximize': { ipc: 'window_control', args: { action: 'toggle-maximize' }, bridge: '/window/toggle-maximize' },
    close: { ipc: 'window_control', args: { action: 'close' }, bridge: '/window/close' },
    drag: { ipc: 'window_control', args: { action: 'drag' }, bridge: '/window/drag' },
    'window-state': { ipc: 'window_control', args: { action: 'state' }, bridge: '/window/state', method: 'GET' },
    'shell-state': { ipc: 'get_shell_state', bridge: '/shell/state', method: 'GET' },
    'update-status': { ipc: 'get_update_status', bridge: '/update-status', method: 'GET' },
  };

  if (TEST_HOOK) {
    TEST_HOOK.config = { SHELL_MENUS, ACTIONS };
    return;
  }

  // 防重复注入（同一文档内 on_page_load 可能多次触发）。
  if (document.getElementById('dsh-shell-chrome')) return;

  // ── 传输层：双通道 ────────────────────────────────────────────────
  const hasTauri = !!(globalThis.__TAURI__ && globalThis.__TAURI__.core && globalThis.__TAURI__.core.invoke);
  const BRIDGE_PORT = globalThis.__DSH_BRIDGE_PORT__ || 0;
  // 应用名随构建身份注入（开发版 = "DSH Desktop Dev"，见 tauri.dev.conf.json）。
  const PRODUCT_NAME = globalThis.__DSH_PRODUCT_NAME__ || 'DSH Desktop';

  function invoke(ipc, args) {
    return globalThis.__TAURI__.core
      .invoke(ipc, args || {})
      .catch((err) => {
        console.error('[shell-chrome] invoke', ipc, err);
        return null;
      });
  }

  function bridge(path, method, args) {
    if (!BRIDGE_PORT) return Promise.resolve(null);
    const opts = { method: method || 'POST' };
    if (method !== 'GET') {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(args || {});
    }
    return fetch(`http://127.0.0.1:${BRIDGE_PORT}${path}`, opts)
      .then((r) => r.json().catch(() => ({})))
      .catch((err) => {
        console.error('[shell-chrome] bridge', path, err);
        return null;
      });
  }

  function call(actionId, args) {
    const a = ACTIONS[actionId];
    if (!a) return Promise.resolve(null);
    if (hasTauri) return invoke(a.ipc, a.args || args || {});
    return bridge(a.bridge, a.method, args);
  }

  function getShellState() {
    return call('shell-state');
  }

  function getUpdateStatus() {
    return call('update-status');
  }

  // ── 状态 ──────────────────────────────────────────────────────────
  let devMode = false;
  let updateInfo = { updateAvailable: false, latest: '', current: '', next: '', nextAvailable: false };
  let maximized = false;
  let openMenuId = null;

  // ── DOM 构建（Shadow DOM 隔离，防 dsh 页面 CSS 互相污染）──────────
  const host = document.createElement('div');
  host.id = 'dsh-shell-chrome';
  const root = host.attachShadow({ mode: 'open' });

  const ICONS = {
    logo: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect width="16" height="16" rx="4" fill="#1f6feb"/><path d="M9.4 2.6 4.8 8.7h2.7L6.9 13.4l4.6-6.1H8.7l.7-4.7z" fill="#fff"/></svg>',
    minimize: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><rect x="2" y="5.4" width="8" height="1.2" rx="0.6" fill="currentColor"/></svg>',
    maximize: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><rect x="2" y="2.5" width="8" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    restore: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><rect x="3.5" y="2" width="6.5" height="6.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.1"/><rect x="1.5" y="4" width="6.5" height="6.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>',
    close: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.2"/></svg>',
    chevron: '<span class="chevron" aria-hidden="true"></span>',
  };

  const STYLE = `
    :host {
      all: initial;
      position: fixed;
      top: 0; left: 0; right: 0;
      height: 36px;
      z-index: 2147483647;
      font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
    }
    .bar {
      display: flex;
      align-items: center;
      height: 100%;
      background: rgba(13, 17, 23, 0.85);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border-bottom: 1px solid rgba(48, 54, 61, 0.55);
      color: #e6edf3;
      font-size: 13px;
      user-select: none;
      -webkit-user-select: none;
      cursor: default;
    }
    .menus { display: flex; align-items: stretch; height: 100%; }
    .menu-btn {
      display: flex; align-items: center; gap: 6px;
      padding: 0 11px;
      border: 0; background: transparent;
      color: inherit; font: inherit;
      cursor: pointer; white-space: nowrap;
    }
    .menu-btn:hover, .menu-btn.open { background: rgba(255, 255, 255, 0.08); }
    .menu-btn .logo { display: flex; align-items: center; }
    .menu-btn .chevron {
      width: 7px; height: 7px;
      border-left: 1.5px solid currentColor;
      border-bottom: 1.5px solid currentColor;
      transform: rotate(-45deg) translateY(-2px);
      opacity: 0.75;
    }
    .menu-btn.badge { position: relative; }
    .menu-btn.badge::after {
      content: ''; position: absolute; top: 5px; right: 3px;
      width: 7px; height: 7px; border-radius: 50%;
      background: #f0883e;
    }
    .spacer { flex: 1; }
    .controls { display: flex; align-items: stretch; height: 100%; }
    .ctl {
      width: 44px; height: 100%;
      display: flex; align-items: center; justify-content: center;
      border: 0; background: transparent;
      color: #e6edf3; cursor: pointer;
    }
    .ctl:hover { background: rgba(255, 255, 255, 0.10); }
    .ctl-close:hover { background: #e81123; }
    .dropdown {
      position: fixed; top: 37px;
      min-width: 212px;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
      padding: 4px;
      z-index: 2147483647;
    }
    .dropdown[hidden] { display: none; }
    .dd-item {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 10px; border-radius: 6px;
      cursor: pointer; white-space: nowrap;
    }
    .dd-item:hover { background: rgba(56, 139, 253, 0.18); }
    .dd-check { width: 14px; color: #58a6ff; text-align: center; }
    .dd-sep { height: 1px; background: #30363d; margin: 4px 8px; }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = STYLE;

  const bar = document.createElement('div');
  bar.className = 'bar';
  const menusWrap = document.createElement('div');
  menusWrap.className = 'menus';
  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  const controls = document.createElement('div');
  controls.className = 'controls';

  // 顶级菜单按钮。
  const menuButtons = new Map(); // menuId -> button
  for (const entry of SHELL_MENUS) {
    const btn = document.createElement('button');
    btn.className = 'menu-btn';
    if (entry.id === 'app') {
      // 应用名跟随构建身份（开发版显示 "DSH Desktop Dev"）。
      btn.innerHTML = `<span class="logo">${ICONS.logo}</span><span class="label">${PRODUCT_NAME}</span>${ICONS.chevron}`;
      btn.dataset.menu = 'app';
    } else if (entry.items) {
      btn.innerHTML = `<span class="label">${entry.label}</span>${ICONS.chevron}`;
      btn.dataset.menu = entry.id;
    } else {
      btn.innerHTML = `<span class="label">${entry.label}</span>`;
      btn.dataset.action = entry.action || entry.id;
    }
    btn.setAttribute('aria-haspopup', entry.items ? 'true' : 'false');
    menusWrap.appendChild(btn);
    if (entry.items) menuButtons.set(entry.id, btn);
  }

  // 窗口控制三键。
  const ctlDefs = [
    { action: 'minimize', label: '最小化', icon: ICONS.minimize },
    { action: 'toggle-maximize', label: '最大化', icon: ICONS.maximize },
    { action: 'close', label: '关闭', icon: ICONS.close, cls: 'ctl-close' },
  ];
  const maximizeBtn = { el: null };
  for (const def of ctlDefs) {
    const btn = document.createElement('button');
    btn.className = 'ctl' + (def.cls ? ' ' + def.cls : '');
    btn.innerHTML = def.icon;
    btn.setAttribute('aria-label', def.label);
    btn.dataset.action = def.action;
    controls.appendChild(btn);
    if (def.action === 'toggle-maximize') maximizeBtn.el = btn;
  }

  bar.append(menusWrap, spacer, controls);
  root.append(styleEl, bar);
  document.body.appendChild(host);

  // 下拉面板（每个含 items 的菜单一个）。
  const dropdowns = new Map(); // menuId -> element
  for (const entry of SHELL_MENUS) {
    if (!entry.items) continue;
    const dd = document.createElement('div');
    dd.className = 'dropdown';
    dd.dataset.for = entry.id;
    dd.hidden = true;
    for (const item of entry.items) {
      if (item.type === 'sep') {
        const sep = document.createElement('div');
        sep.className = 'dd-sep';
        dd.appendChild(sep);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'dd-item';
      row.dataset.item = item.id;
      if (item.type === 'checkbox') {
        const check = document.createElement('span');
        check.className = 'dd-check';
        check.dataset.check = item.id;
        row.appendChild(check);
        row.appendChild(document.createTextNode(item.label));
      } else {
        row.appendChild(document.createTextNode(item.label));
      }
      dd.appendChild(row);
    }
    root.appendChild(dd);
    dropdowns.set(entry.id, dd);
  }

  // ── 菜单开关 ──────────────────────────────────────────────────────
  function closeMenus() {
    openMenuId = null;
    for (const [id, dd] of dropdowns) {
      dd.hidden = true;
      const btn = menuButtons.get(id);
      if (btn) btn.classList.remove('open');
    }
  }

  function openMenu(menuId) {
    const btn = menuButtons.get(menuId);
    const dd = dropdowns.get(menuId);
    if (!btn || !dd) return;
    refreshUpdateInfo();
    closeMenus();
    openMenuId = menuId;
    btn.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    dd.hidden = false;
    // 定位：左对齐按钮；右侧越界时右对齐（固定定位相对视口）。
    const left = btn.offsetLeft;
    dd.style.left = '';
    dd.style.right = '';
    if (left + dd.offsetWidth > window.innerWidth - 8) {
      dd.style.right = `${window.innerWidth - btn.offsetLeft - btn.offsetWidth - 4}px`;
    } else {
      dd.style.left = `${left}px`;
    }
  }

  function toggleMenu(menuId) {
    if (openMenuId === menuId) closeMenus();
    else openMenu(menuId);
  }

  // ── 菜单项动态渲染（更新/开发者模式）────────────────────────────
  function refreshUpdateInfo() {
    getUpdateStatus().then((r) => {
      if (!r) return;
      if (typeof r.updateAvailable === 'boolean') updateInfo = r;
      renderUpdateItem();
    });
  }

  function renderUpdateItem() {
    const appBtn = menuButtons.get('app');
    if (!appBtn) return;
    appBtn.classList.toggle('badge', !!updateInfo.updateAvailable);
    const dd = dropdowns.get('app');
    if (!dd) return;
    const item = dd.querySelector('[data-item="check-update"]');
    if (!item) return;
    item.textContent = updateInfo.updateAvailable
      ? `有更新 ${updateInfo.latest || '?'}（点击更新）`
      : '检查更新…';
  }

  function setDevMode(on) {
    devMode = !!on;
    for (const el of root.querySelectorAll('[data-check="dev-mode"]')) {
      el.textContent = devMode ? '✓' : '';
    }
  }

  function setMaximized(on) {
    maximized = !!on;
    if (!maximizeBtn.el) return;
    maximizeBtn.el.innerHTML = maximized ? ICONS.restore : ICONS.maximize;
    maximizeBtn.el.setAttribute('aria-label', maximized ? '还原' : '最大化');
  }

  // ── 事件 ──────────────────────────────────────────────────────────
  bar.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    // 点击空白/菜单区关闭已开菜单；交互元素除外。
    if (!e.target.closest('button')) {
      if (openMenuId) closeMenus();
      // 拖动窗口（mousedown → 桥 → start_dragging）。按钮区域不拖。
      e.preventDefault();
      call('drag');
    }
  });

  bar.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    call('toggle-maximize').then((r) => {
      if (r && typeof r.maximized === 'boolean') setMaximized(r.maximized);
    });
  });

  menusWrap.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-menu]');
    if (btn) {
      toggleMenu(btn.dataset.menu);
      return;
    }
    // 直开动作条目（如「代理设置…」）。
    const actBtn = e.target.closest('[data-action]');
    if (actBtn) call(actBtn.dataset.action);
  });

  for (const [menuId, dd] of dropdowns) {
    dd.addEventListener('click', (e) => {
      const row = e.target.closest('[data-item]');
      if (!row) return;
      const id = row.dataset.item;
      if (id === 'check-update') {
        const actionId = updateInfo.updateAvailable ? 'update-now' : 'check-update';
        call(actionId).then((r) => {
          if (!updateInfo.updateAvailable) refreshUpdateInfo(); // 手动检查后刷新状态
        });
      } else if (id === 'dev-mode') {
        call('dev-mode').then((r) => {
          if (r && typeof r.devMode === 'boolean') setDevMode(r.devMode);
        });
      } else {
        call(id);
      }
      closeMenus();
    });
  }

  controls.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'toggle-maximize') {
      call('toggle-maximize').then((r) => {
        if (r && typeof r.maximized === 'boolean') setMaximized(r.maximized);
      });
    } else {
      call(action);
    }
  });

  // 最大化状态跟随真实窗口（Aero 拖拽/Win+↑ 等外部路径会漂移）。
  window.addEventListener('resize', () => {
    call('window-state').then((r) => {
      if (r && typeof r.maximized === 'boolean') setMaximized(r.maximized);
    });
  });
  window.addEventListener('focus', () => {
    call('window-state').then((r) => {
      if (r && typeof r.maximized === 'boolean') setMaximized(r.maximized);
    });
  });

  // 更新可用性轮询（与托盘同源逻辑）。
  const UPDATE_POLL_MS = 60 * 1000;
  setInterval(refreshUpdateInfo, UPDATE_POLL_MS);

  // Esc 关闭菜单；点外部关闭（composedPath 穿透 shadow 边界）。
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenus();
  });
  document.addEventListener('mousedown', (e) => {
    if (!e.composedPath || !e.composedPath().includes(host)) closeMenus();
  });

  // 顶栏区域不出页面右键菜单。
  host.addEventListener('contextmenu', (e) => e.preventDefault());

  // ── 自愈：dsh SPA 重渲染 body 清掉顶栏后自动重挂 ──────────────────
  const observer = new MutationObserver(() => {
    if (!document.body.contains(host)) {
      closeMenus();
      document.body.appendChild(host);
    }
  });
  observer.observe(document.body, { childList: true });

  // ── 启动状态 ──────────────────────────────────────────────────────
  getShellState().then((r) => {
    if (!r) return;
    if (typeof r.devMode === 'boolean') setDevMode(r.devMode);
    if (r.update && typeof r.update.updateAvailable === 'boolean') {
      updateInfo = r.update;
      renderUpdateItem();
    }
  });
  call('window-state').then((r) => {
    if (r && typeof r.maximized === 'boolean') setMaximized(r.maximized);
  });
})();
