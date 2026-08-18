// DSH Desktop launcher page (local, tauri://localhost).
// Two views: 'launch' (wait for the dsh web loopback URL, then navigate) and
// 'settings' (proxy config panel; opened via the tray "代理设置…" or ⚙).
const VIEW = new URLSearchParams(window.location.search).get('view') || 'launch';
const tauri = globalThis.__TAURI__;

const stateEl = document.getElementById('state');
const creditsEl = document.getElementById('credits');
const retryBtn = document.getElementById('retry');
const openDataBtn = document.getElementById('opendata');
const spinner = document.getElementById('spinner');
const installProgress = document.getElementById('installProgress');
const launchView = document.getElementById('launchView');
const settingsView = document.getElementById('settingsView');
const settingsBtn = document.getElementById('settingsBtn');
const readyBanner = document.getElementById('readyBanner');
const readyBack = document.getElementById('readyBack');

function setState(text, failed = false) {
  stateEl.textContent = text;
  stateEl.style.color = failed ? '#f85149' : '';
  spinner.hidden = failed;
  retryBtn.hidden = !failed;
  openDataBtn.hidden = !failed;
}

// ── 5 行替换 + 光辉扫过（demo-K 效果）────────────────────
// 固定 5 行：新行直接替换到顶部，最旧一行移除（直接模式，无动画）。
// 光辉从视口下方向上扫过，扫出顶部后按当前停止时间休息，再扫下一次。
// 安装期间：以停止时间为步进节奏——速度 200→999 分 9 次递增、停止
// 700→20ms 分 9 次递减，第 9 次同到顶点 → 停止扫描、所有行全部点亮。
const MAX_ROWS = 5;
const GLOW_RADIUS = 40;
const GLOW_BASE = 0.28;
const RAMP_COUNT = 9;
const creditsViewport = document.querySelector('.credits-viewport');
const REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let rows = [];
let scanPos = null, restUntil = 0, lastTs = 0, rafId = null;
let allLit = false, installActive = false, sweepDisabled = false;
let GLOW_SPEED = 200, REST_MS = 700, step = 0;

function lightRow(el) {
  el.style.opacity = '1';
  el.style.textShadow = '0 0 12px rgba(120,200,255,0.9), 0 0 28px rgba(31,111,235,0.6)';
}

function lightAll() {
  allLit = true;
  rows.forEach(lightRow);
}

// 以停止时间为步进节奏：每次扫完才推进一次（9 次后到顶点并全部点亮）
function advanceStep() {
  step++;
  if (step >= RAMP_COUNT) {
    GLOW_SPEED = 999; REST_MS = 20;
    stopSweep();
    lightAll();
    return;
  }
  GLOW_SPEED = Math.min(999, Math.round(200 + (799 / RAMP_COUNT) * step));
  REST_MS = Math.max(20, Math.round(700 - (680 / RAMP_COUNT) * step));
}

function scanTick(ts) {
  if (allLit) { rafId = null; return; }
  if (!lastTs) lastTs = ts;
  const dt = Math.min((ts - lastTs) / 1000, 0.1);
  lastTs = ts;
  const VH = creditsViewport.clientHeight;
  if (scanPos === null) {
    if (ts >= restUntil) scanPos = VH + 40;   // 休息结束，从视口下方重新起扫（向上）
  } else {
    scanPos -= GLOW_SPEED * dt;               // 向上移动
    if (scanPos < -40) {
      scanPos = null;
      restUntil = ts + REST_MS;               // 按当前停止时间休息
      if (installActive) {
        advanceStep();                        // 安装期间：扫完即推进
        if (allLit) return;                   // 顶点：lightAll 已点亮全部 → 不再渲染/调度
      }
    }
  }
  rows.forEach((el, i) => {
    const y = i * 26 + 13;
    let lit = GLOW_BASE;
    if (scanPos !== null) {
      const d = Math.abs(y - scanPos);
      if (d < GLOW_RADIUS) lit = Math.max(GLOW_BASE, 1 - Math.pow(d / GLOW_RADIUS, 1.6));
    }
    const glow = 10 + 30 * lit;
    el.style.textShadow = `0 0 ${glow.toFixed(1)}px rgba(120,200,255,0.9)`;
    el.style.opacity = (0.22 + 0.78 * lit).toFixed(3);
  });
  rafId = requestAnimationFrame(scanTick);
}

function startSweep() {
  if (REDUCED_MOTION || allLit || rafId !== null) return;
  lastTs = 0;
  rafId = requestAnimationFrame(scanTick);
}

function stopSweep() {
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
}

// 安装开始时归零：光辉重新从 200/700 起步；错误/退出态解除
function resetSweep() {
  stopSweep();
  allLit = false;
  sweepDisabled = false;
  step = 0;
  GLOW_SPEED = 200;
  REST_MS = 700;
  scanPos = null;
  restUntil = 0;
  lastTs = 0;
}

function appendLog(line) {
  const el = document.createElement('div');
  el.className = 'credit-line';
  el.textContent = line;
  el.title = line; // 长内容 ellipsis 截断，悬停看全文
  creditsEl.insertBefore(el, creditsEl.firstChild); // 新行直接替换到顶部
  rows.unshift(el);
  while (rows.length > MAX_ROWS) {
    const old = rows.pop();
    if (old.parentNode) old.parentNode.removeChild(old);
  }
  if (allLit) { lightRow(el); return; }
  if (!sweepDisabled) startSweep(); // 有行即启动光辉扫动（日常启动/安装/更新都生效）；加速与"全部点亮"仅在安装期间
}

// ── 卡住 / 失败处理 ──────────────────────────────────────
// 安装 30 秒无进展 → 提示可重试（中断当前安装，备份机制保证插件不丢）；
// 启动 60 秒无 URL 且无安装进行 → 提示可能卡住，可重试或看日志。
const INSTALL_STALL_MS = 30000;
const LAUNCH_STALL_MS = 60000;
let installStartAt = 0;
let installStallTimer = null;
let launchStallTimer = null;
let gotUrl = false;

function showActionable(stateText, helpText) {
  setState(stateText, true); // 红字 + 显示重试/打开数据目录
  if (helpText) appendLog(helpText);
}

if (tauri && tauri.event) {
  tauri.event.listen('server-url', (ev) => {
    const url = ev.payload;
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return;
    gotUrl = true;
    if (VIEW === 'settings') {
      // Settings view: never auto-navigate away; just tell the user it's ready.
      readyBanner.hidden = false;
      return;
    }
    clearTimeout(launchStallTimer);
    setState('dsh 已就绪，正在打开界面…');
    window.location.href = url;
  });

  tauri.event.listen('server-log', (ev) => {
    if (typeof ev.payload === 'string') {
      appendLog(ev.payload);
    }
  });

  tauri.event.listen('server-down', () => {
    clearTimeout(launchStallTimer);
    clearTimeout(installStallTimer);
    installProgress.hidden = true;
    installActive = false;
    sweepDisabled = true;
    stopSweep();
    showActionable('dsh 服务已退出。', '完整日志见数据目录里的 manager.log');
  });

  // 安装/更新 dsh 的进度反馈：阶段事件 + 秒数心跳 + 卡住处理。
  tauri.event.listen('install-status', (ev) => {
    const p = ev.payload || {};
    if (p.phase === 'start') {
      installProgress.hidden = false;
      installStartAt = Date.now();
      retryBtn.hidden = false; // 安装中也可重试（中断当前安装，备份不丢插件）
      setState(`正在安装 dsh ${p.version || ''}…`);
      installActive = true;
      resetSweep(); // 新一轮安装：光辉重新从 200/700 起步
      clearTimeout(installStallTimer);
      installStallTimer = setTimeout(() => {
        setState('安装仍在进行 — 若长时间无进展，可点击「重试」中断后重新安装');
      }, INSTALL_STALL_MS);
    } else if (p.phase === 'running') {
      installProgress.hidden = false;
      retryBtn.hidden = false;
      setState(`正在安装 dsh… 已进行 ${p.seconds || 0} 秒`);
    } else if (p.phase === 'done') {
      installProgress.hidden = true;
      clearTimeout(installStallTimer);
      retryBtn.hidden = true;
      setState('安装完成，正在启动服务…');
      installActive = false;
      if (!allLit) lightAll(); // 安装完成 → 所有数据全部点亮
    } else if (p.phase === 'error') {
      installProgress.hidden = true;
      clearTimeout(installStallTimer);
      installActive = false;
      stopSweep();
      allLit = false;
      sweepDisabled = true;
      rows.forEach((el) => { el.style.opacity = ''; el.style.textShadow = ''; }); // 回到基础样式
      const msg = String(p.error || '');
      let hint = '';
      if (/registry|网络|timeout|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|超时|ESOCKET/i.test(msg)) {
        hint = '疑似网络问题：可设置镜像源加速后重试（环境变量 DSH_DESKTOP_REGISTRY=https://registry.npmmirror.com），或检查网络后重试。';
      } else {
        hint = '可点击「重试」重新安装，或打开数据目录查看完整日志。';
      }
      showActionable(`安装失败：${msg || '未知错误'}`, hint);
    }
  });

  // 启动卡住检测：60 秒内既没等到 URL、也没有安装在进行 → 提示可操作。
  launchStallTimer = setTimeout(() => {
    if (!gotUrl && installProgress.hidden) {
      showActionable('启动似乎卡住了。', '可点击「重试」重启服务，或打开数据目录查看 manager.log。');
    }
  }, LAUNCH_STALL_MS);
} else {
  setState('Tauri IPC 不可用，无法启动服务。', true);
}

retryBtn.addEventListener('click', async () => {
  setState('正在重启 dsh 服务…');
  installProgress.hidden = true;
  creditsEl.textContent = '';
  rows = [];
  installActive = false;
  resetSweep(); // 重置光辉状态
  try {
    await tauri.core.invoke('restart_server');
  } catch (err) {
    setState('重启失败：' + String(err), true);
  }
});

openDataBtn.addEventListener('click', async () => {
  try {
    await tauri.core.invoke('open_data_dir');
  } catch (err) {
    appendLog('打开数据目录失败：' + String(err));
  }
});

// ── 视图切换 ──────────────────────────────────────────────
function openSettings() {
  const u = new URL(window.location.href);
  u.searchParams.set('view', 'settings');
  window.location.href = u.toString();
}

function closeSettings() {
  const u = new URL(window.location.href);
  u.searchParams.delete('view');
  window.location.href = u.toString();
}

settingsBtn.addEventListener('click', openSettings);
document.getElementById('settingsClose').addEventListener('click', () => {
  // 回到 dsh（若有）或启动视图；由壳导航，避免页面自己猜 URL。
  tauri.core.invoke('back_to_dsh').catch(() => closeSettings());
});
readyBack.addEventListener('click', (e) => {
  e.preventDefault();
  tauri.core.invoke('back_to_dsh').catch(() => closeSettings());
});

// ── 设置视图：代理配置 ────────────────────────────────────
const proxyEnabled = document.getElementById('proxyEnabled');
const proxyHost = document.getElementById('proxyHost');
const proxyPort = document.getElementById('proxyPort');
const proxyUser = document.getElementById('proxyUser');
const proxyPass = document.getElementById('proxyPass');
const providerHostsEl = document.getElementById('providerHosts');
const otherHostsEl = document.getElementById('otherHosts');
const saveStatus = document.getElementById('saveStatus');
const saveProxyBtn = document.getElementById('saveProxy');

function hostCheckbox(host, label, checked, onChange) {
  const wrap = document.createElement('label');
  wrap.className = 'host-check';
  wrap.dataset.host = host; // 保存时读 data-host，标签可展示人类可读名
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = checked;
  cb.addEventListener('change', onChange);
  const span = document.createElement('span');
  span.textContent = label;
  wrap.append(cb, span);
  return wrap;
}

function renderHostGroup(el, entries, proxied, onChange, emptyText) {
  el.textContent = '';
  if (!entries.length) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = emptyText;
    el.appendChild(p);
    return;
  }
  for (const e of entries) {
    el.appendChild(hostCheckbox(e.host, e.label, proxied.includes(e.host), onChange));
  }
}

async function loadSettings() {
  saveStatus.textContent = '';
  try {
    const cfg = await tauri.core.invoke('get_proxy_config');
    const up = cfg.upstream || {};
    proxyEnabled.checked = !!up.enabled;
    proxyHost.value = up.host || '';
    proxyPort.value = up.port ? String(up.port) : '';
    proxyUser.value = up.username || '';
    proxyPass.value = up.password || '';

    const proxied = new Set(cfg.proxiedHosts || []);
    // 模型提供方：settings.yaml 读到的 [{name, host}]，标签显示名字 + 主机。
    const providers = (cfg.providers || []).map((p) => ({
      label: p.name ? `${p.name}（${p.host}）` : p.host,
      host: p.host,
    }));
    // 其它已观测主机：knownHosts（持久化）+ hosts（本次运行观测），去重、剔除提供方。
    const providerHosts = new Set(providers.map((p) => p.host));
    const seen = new Map();
    for (const h of [...(cfg.knownHosts || []), ...(cfg.hosts || [])]) {
      if (!providerHosts.has(h)) seen.set(h, h);
    }
    const others = [...seen.keys()].sort().map((h) => ({ label: h, host: h }));
    const onChange = () => {
      // 实时勾选 → 收集已选主机（仅前端状态，保存时提交）
      saveStatus.textContent = '';
    };
    renderHostGroup(providerHostsEl, providers, [...proxied], onChange, '尚未读取到模型提供方（在 dsh 设置里配置模型后会自动出现）');
    renderHostGroup(otherHostsEl, others, [...proxied], onChange, '暂无（dsh 访问过外部主机后会自动出现，含 registry.npmjs.org 等安装流量）');
  } catch (err) {
    saveStatus.textContent = '读取失败：' + String(err);
  }
}

function collectProxiedHosts() {
  const hosts = [];
  for (const el of [providerHostsEl, otherHostsEl]) {
    for (const input of el.querySelectorAll('.host-check input:checked')) {
      const host = input.closest('.host-check').dataset.host;
      if (host) hosts.push(host);
    }
  }
  return hosts;
}

saveProxyBtn.addEventListener('click', async () => {
  saveStatus.textContent = '保存中…';
  const upstream = {
    enabled: proxyEnabled.checked,
    host: proxyHost.value.trim(),
    port: Number(proxyPort.value) || 0,
    username: proxyUser.value.trim(),
    password: proxyPass.value,
  };
  try {
    await tauri.core.invoke('set_proxy_config', {
      upstream,
      proxiedHosts: collectProxiedHosts(),
    });
    saveStatus.textContent = '✓ 已保存，立即生效（无需重启）';
    setTimeout(() => { saveStatus.textContent = ''; }, 4000);
  } catch (err) {
    saveStatus.textContent = '保存失败：' + String(err);
  }
});

// ── 视图初始化 ────────────────────────────────────────────
if (VIEW === 'settings') {
  launchView.hidden = true;
  settingsView.hidden = false;
  settingsBtn.hidden = true;
  loadSettings();
}
