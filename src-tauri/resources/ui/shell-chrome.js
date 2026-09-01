// DSH Smoothly Desktop — 壳顶栏（注入式覆盖标题栏 + 菜单栏）。
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

  // 应用名/图标随构建身份注入（dev 版 = "DSH Smoothly Desktop Dev"）。
  const PRODUCT_NAME = globalThis.__DSH_PRODUCT_NAME__ || 'DSH Smoothly Desktop';

  const SHELL_MENUS = [
    {
      // 唯一菜单：顶栏左侧 icon 触发；首项显示应用名。
      id: 'app',
      items: [
        { id: 'brand', label: PRODUCT_NAME, type: 'brand' },
        { type: 'sep' },
        { id: 'proxy-settings', label: '代理设置…' },
        { id: 'plugins', label: '插件管理…' },
        { id: 'check-update', label: '检查更新…' }, // 有更新时翻转为「有更新 vX（点击更新）」
        { id: 'dev-mode', label: '开发者模式', type: 'checkbox' },
        { type: 'sep' },
        { id: 'refresh', label: '刷新页面' },
        { id: 'restart', label: '重启服务' },
        { type: 'sep' },
        { id: 'open-data', label: '打开数据目录' },
        { id: 'about', label: `关于 ${PRODUCT_NAME}` },
        { type: 'sep' },
        { id: 'quit', label: '退出' },
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
    plugins: { ipc: 'open_plugins', bridge: '/shell/open-plugins' },
    'shell-status': { ipc: 'get_shell_status', bridge: '/shell/status', method: 'GET' },
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
  // 仅本地启动页（tauri://）走 IPC；dsh 远程页（http://127.0.0.1:port）即使
  // 存在 __TAURI__（Tauri 对允许的远程 origin 也做全局注入）也强制走环回桥——
  // 远程页 capability（remote-notifications）未授予 invoke，走 IPC 会被静默
  // 拒绝 → 表现为"点击全部无反应"（2026-09-01 实机日志实证：场地 chrome-hit
  // 正常但桥 /window/* 无到达）。
  const isLocalPage = typeof location !== 'undefined' && location.protocol === 'tauri:';
  const hasTauri = isLocalPage && !!(globalThis.__TAURI__ && globalThis.__TAURI__.core && globalThis.__TAURI__.core.invoke);
  const BRIDGE_PORT = globalThis.__DSH_BRIDGE_PORT__ || 0;

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

  // 真实应用图标（Rust 注入为 data URI；缺省回退闪电占位）。
  const LOGO = globalThis.__DSH_LOGO__ || ICONS.logo;

  const STYLE = `
    :host {
      all: initial;
      position: fixed;
      top: 0; left: 0; right: 0;
      height: 36px;
      z-index: 2147483647;
      font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
      /* 随系统配色：浅色默认 + @media 深色覆盖（与 styles.css 同色系）。
         显式设色/字号，避免继承页面（页面可能是深色主题、字号更大）。 */
      color-scheme: light dark;
      --dsh-fg: #1f2328;
      --dsh-bar-bg: linear-gradient(180deg, rgba(255, 255, 255, 0.80), rgba(250, 250, 250, 0.68));
      --dsh-bar-border: rgba(0, 0, 0, 0.08);
      --dsh-bar-highlight: rgba(255, 255, 255, 0.9);
      --dsh-hover: rgba(0, 0, 0, 0.07);
      --dsh-hover-acc: rgba(31, 111, 235, 0.10);
      --dsh-sep: rgba(0, 0, 0, 0.12);
      --dsh-dd-bg: rgba(255, 255, 255, 0.92);
      --dsh-dd-border: rgba(0, 0, 0, 0.10);
      --dsh-dd-shadow: 0 12px 36px rgba(0, 0, 0, 0.16), 0 1px 2px rgba(0, 0, 0, 0.08);
      --dsh-check: #1f6feb;
      --dsh-close: rgba(224, 30, 55, 0.92);
      --dsh-err-bg: #fdeaea;
      --dsh-err-fg: #c62828;
      --dsh-err-border: rgba(198, 40, 40, 0.35);
      --dsh-err-hover: rgba(198, 40, 40, 0.08);
      color: var(--dsh-fg);
      font-size: 12px;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --dsh-fg: #e6edf3;
        --dsh-bar-bg: linear-gradient(180deg, rgba(22, 27, 34, 0.74), rgba(13, 17, 23, 0.62));
        --dsh-bar-border: rgba(255, 255, 255, 0.09);
        --dsh-bar-highlight: rgba(255, 255, 255, 0.06);
        --dsh-hover: rgba(255, 255, 255, 0.10);
        --dsh-hover-acc: rgba(88, 166, 255, 0.22);
        --dsh-sep: rgba(255, 255, 255, 0.14);
        --dsh-dd-bg: rgba(22, 27, 34, 0.94);
        --dsh-dd-border: rgba(255, 255, 255, 0.11);
        --dsh-dd-shadow: 0 12px 36px rgba(0, 0, 0, 0.5), 0 1px 2px rgba(0, 0, 0, 0.3);
        --dsh-check: #58a6ff;
        --dsh-close: rgba(232, 17, 35, 0.94);
        --dsh-err-bg: rgba(140, 30, 30, 0.32);
        --dsh-err-fg: #f2a6a6;
        --dsh-err-border: rgba(242, 166, 166, 0.40);
        --dsh-err-hover: rgba(242, 166, 166, 0.14);
      }
    }
    .bar {
      display: flex;
      align-items: center;
      height: 100%;
      /* 随系统配色的毛玻璃顶栏 */
      background: var(--dsh-bar-bg);
      backdrop-filter: blur(18px) saturate(1.4);
      -webkit-backdrop-filter: blur(18px) saturate(1.4);
      border-bottom: 1px solid var(--dsh-bar-border);
      box-shadow: inset 0 1px 0 var(--dsh-bar-highlight);
      color: var(--dsh-fg);
      font-size: 12px;
      user-select: none;
      -webkit-user-select: none;
      cursor: default;
      /* WebView2 原生窗口拖动；交互按钮 no-drag。mousedown 兜底同时保留
         （app-region 生效时 mousedown 不触发，两者天然互斥）。 */
      -webkit-app-region: drag;
    }
    .menus { display: flex; align-items: stretch; height: 100%; }
    .menu-btn {
      display: flex; align-items: center; justify-content: center;
      width: 40px; margin: 0 2px;
      border: 0; background: transparent;
      border-radius: 6px;
      color: inherit;
      cursor: pointer;
      transition: background 0.12s ease;
      -webkit-app-region: no-drag;
    }
    .menu-btn:hover, .menu-btn.open { background: var(--dsh-hover); }
    .menu-btn .logo { display: flex; align-items: center; }
    .menu-btn .logo img {
      width: 20px; height: 20px;
      border-radius: 5px;
      display: block;
      user-select: none;
      -webkit-user-drag: none;
    }
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
      color: var(--dsh-fg); cursor: pointer;
      transition: background 0.12s ease;
      -webkit-app-region: no-drag;
    }
    .ctl:hover { background: var(--dsh-hover); }
    .ctl-close:hover { background: var(--dsh-close); color: #fff; }
    .dropdown {
      position: fixed; top: 37px;
      min-width: 212px;
      /* 随系统配色的毛玻璃浮层 */
      background: var(--dsh-dd-bg);
      backdrop-filter: blur(24px) saturate(1.4);
      -webkit-backdrop-filter: blur(24px) saturate(1.4);
      border: 1px solid var(--dsh-dd-border);
      border-radius: 12px;
      box-shadow: var(--dsh-dd-shadow);
      padding: 5px;
      z-index: 2147483647;
      animation: dsh-dd-in 0.15s ease-out;
    }
    .dropdown[hidden] { display: none; }
    @keyframes dsh-dd-in {
      from { opacity: 0; transform: translateY(-5px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .dropdown { animation: none; }
    }
    .dd-item {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 10px; border-radius: 7px;
      cursor: pointer; white-space: nowrap;
      transition: background 0.12s ease;
    }
    .dd-item:hover { background: var(--dsh-hover-acc); }
    .dd-check { width: 14px; color: var(--dsh-check); text-align: center; }
    .dd-sep { height: 1px; background: var(--dsh-sep); margin: 4px 8px; }
    .dd-brand {
      display: flex; align-items: center; gap: 8px;
      padding: 7px 10px 5px;
      font-weight: 600;
      cursor: default;
    }
    .dd-brand img { width: 18px; height: 18px; border-radius: 4px; display: block; }
    .errbanner {
      position: fixed; top: 36px; left: 0; right: 0;
      display: flex; align-items: center; gap: 12px;
      background: var(--dsh-err-bg);
      border-bottom: 1px solid var(--dsh-err-border);
      color: var(--dsh-err-fg);
      font-size: 12px;
      padding: 7px 12px;
      z-index: 2147483646;
    }
    .errbanner[hidden] { display: none; }
    .errbanner .err-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .errbanner button {
      margin: 0; padding: 3px 10px; font-size: 12px;
      border: 1px solid var(--dsh-err-border); border-radius: 6px;
      background: transparent; color: var(--dsh-err-fg); cursor: pointer;
    }
    .errbanner button:hover { background: var(--dsh-err-hover); }
    .mini-toast {
      position: fixed; top: 46px; left: 50%;
      transform: translateX(-50%) translateY(-4px);
      background: var(--dsh-dd-bg); color: var(--dsh-fg);
      border: 1px solid var(--dsh-dd-border); border-radius: 8px;
      padding: 6px 14px; font-size: 12px;
      box-shadow: var(--dsh-dd-shadow);
      opacity: 0; pointer-events: none;
      transition: opacity 0.15s ease, transform 0.15s ease;
      z-index: 2147483646;
    }
    .mini-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
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

  // 顶级菜单按钮：全部菜单收进左侧应用 icon（真实 logo），名字显示在下拉首项。
  const menuButtons = new Map(); // menuId -> button
  for (const entry of SHELL_MENUS) {
    const btn = document.createElement('button');
    btn.className = 'menu-btn';
    // 真实应用图标（data URI）；所有菜单经此 icon 展开。
    btn.innerHTML = `<span class="logo"><img src="${LOGO}" alt="" draggable="false"></span>`;
    btn.dataset.menu = entry.id;
    btn.setAttribute('aria-label', '菜单');
    btn.setAttribute('aria-haspopup', 'true');
    menusWrap.appendChild(btn);
    menuButtons.set(entry.id, btn);
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

  // ── 自适应推挤（不产生滚动条）：dsh 远程页 html 顶部补 36px padding，
  // border-box 下内容区减少 36、总高不变 → 内容下移不被顶栏遮挡、无额外
  // 滚动条。启动页（tauri://）居中布局无需推挤。
  let pushActive = false;
  if (typeof location !== 'undefined' && location.protocol !== 'tauri:') {
    const rootEl = document.documentElement;
    rootEl.style.paddingTop = '36px';
    rootEl.style.boxSizing = 'border-box';
    pushActive = true;
  }

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
      // 应用名展示项：下拉首行（仅文字，图标已去），不可点。
      if (item.type === 'brand') {
        const row = document.createElement('div');
        row.className = 'dd-brand';
        row.appendChild(document.createTextNode(item.label));
        dd.appendChild(row);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'dd-item';
      row.dataset.item = item.id;
      // 左侧统一占位（14px）：checkbox 显示 ✓，普通项留空——对齐一致
      const leader = document.createElement('span');
      leader.className = 'dd-check';
      if (item.type === 'checkbox') leader.dataset.check = item.id;
      row.appendChild(leader);
      row.appendChild(document.createTextNode(item.label));
      dd.appendChild(row);
    }
    root.appendChild(dd);
    dropdowns.set(entry.id, dd);
  }

  // ── 故障披露条幅：服务/启动异常时显示原因 + 重试/开日志（不再一片黑）──
  const errBanner = document.createElement('div');
  errBanner.className = 'errbanner';
  errBanner.hidden = true;
  const errText = document.createElement('span');
  errText.className = 'err-text';
  const errRetryBtn = document.createElement('button');
  errRetryBtn.textContent = '重试';
  const errDataBtn = document.createElement('button');
  errDataBtn.textContent = '打开数据目录';
  const errDismissBtn = document.createElement('button');
  errDismissBtn.textContent = '✕';
  errBanner.append(errText, errRetryBtn, errDataBtn, errDismissBtn);
  root.appendChild(errBanner);
  let errDismissed = false;
  function updateErrorBanner() {
    call('shell-status').then((r) => {
      if (!r) return;
      const hasErr = !!r.lastError;
      errBanner.hidden = !(hasErr && !errDismissed);
      if (hasErr && !errDismissed) errText.textContent = '⚠ ' + r.lastError;
    });
  }
  errRetryBtn.addEventListener('click', () => call('restart'));
  errDataBtn.addEventListener('click', () => call('open-data'));
  errDismissBtn.addEventListener('click', () => { errDismissed = true; errBanner.hidden = true; });
  setInterval(updateErrorBanner, 3000);
  updateErrorBanner();

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
  // 壳内瞬时提示条（2.4s 自动消失；不依赖系统通知，任何页面都有可见反馈）。
  let miniEl = null;
  let miniTimer = null;
  function miniToast(text) {
    if (!miniEl) {
      miniEl = document.createElement('div');
      miniEl.id = 'dsh-mini-toast';
      root.appendChild(miniEl);
    }
    miniEl.textContent = text;
    miniEl.className = 'mini-toast show';
    clearTimeout(miniTimer);
    miniTimer = setTimeout(() => { miniEl.className = 'mini-toast'; }, 2400);
  }

  // window 级 CAPTURE 统一分发：不依赖 shadow 内单个元素监听（实机曾出现
  // "全部点击无反应"——具体绑定可能因注入/遮蔽失效）。capture 阶段最早收包，
  // composedPath 穿透 shadow 边界定位 data 命中元素；命中即 stopPropagation，
  // 未命中（页面自身点击）原样放行。
  window.addEventListener(
    'click',
    (e) => {
      const path = e.composedPath ? e.composedPath() : [];
      const hit = path.find((el) => el && el.dataset && (el.dataset.menu || el.dataset.item || el.dataset.action));
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      const d = hit.dataset;
      if (d.menu) {
        toggleMenu(d.menu);
        return;
      }
      if (d.item) {
        runMenuAction(d.item);
        closeMenus();
        return;
      }
      if (d.action) {
        runControlAction(d.action);
      }
    },
    true
  );

  // ── 插件管理（入口挪到菜单栏，界面保留原插件控制台）─────────────
  // 原 dsh-plugin-console 渲染右下角浮动按钮 .dshc-btn（点击切换面板显隐）。
  // 壳菜单「插件管理」就地触发该按钮（原面板 UI/UX 零改动）；右下角原入口隐藏
  //（"挪"到菜单栏）。非 dsh 页/插件未注入时红框反馈。
  function dshcBtn() {
    return document.querySelector('button.dshc-btn');
  }
  function hideFabIfPresent() {
    const btn = dshcBtn();
    if (btn && btn.style.display !== 'none') btn.style.display = 'none';
  }
  hideFabIfPresent();

  function runMenuAction(id) {
    if (id === 'plugins') {
      // 插件管理：打开壳内独立管理窗口（与代理设置同尺寸、居中）。
      call('plugins');
      return;
    }
    if (id === 'check-update') {
      miniToast(updateInfo.updateAvailable ? '正在更新…' : '正在检查更新…');
      const actionId = updateInfo.updateAvailable ? 'update-now' : 'check-update';
      call(actionId).then(() => {
        if (!updateInfo.updateAvailable) refreshUpdateInfo(); // 手动检查后刷新状态
      });
    } else if (id === 'about') {
      // 壳内提示版本信息（不依赖系统通知，必定可见）。
      const ver = globalThis.__DSH_SHELL_VERSION__ || '?';
      miniToast(`DSH Smoothly Desktop v${ver} · dsh 当前 v${updateInfo.current || '?'}`);
    } else if (id === 'dev-mode') {
      call('dev-mode').then((r) => {
        if (r && typeof r.devMode === 'boolean') setDevMode(r.devMode);
      });
    } else {
      call(id);
    }
  }

  function runControlAction(actionId) {
    if (actionId === 'toggle-maximize') {
      call('toggle-maximize').then((r) => {
        if (r && typeof r.maximized === 'boolean') setMaximized(r.maximized);
      });
    } else {
      call(actionId);
    }
  }

  // 拖动窗口：mousedown → 桥/IPC → start_dragging（Tauri 官方 drag-region
  // 同款机制；不使用 CSS app-region，避免 WebView2 中按钮点击被拖拽吞掉）。
  bar.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return;
    if (openMenuId) closeMenus();
    e.preventDefault();
    call('drag');
  });

  bar.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    call('toggle-maximize').then((r) => {
      if (r && typeof r.maximized === 'boolean') setMaximized(r.maximized);
    });
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

  // ── 自愈：dsh SPA 重渲染 body 清掉顶栏后自动重挂（html padding 不受影响）─
  const observer = new MutationObserver(() => {
    if (!document.body.contains(host)) {
      closeMenus();
      document.body.appendChild(host);
    }
    // 插件控制台浮动按钮可能晚于 chrome 注入挂载：出现即隐藏（入口在菜单栏）。
    hideFabIfPresent();
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
