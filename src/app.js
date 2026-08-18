// DSH Desktop launcher page (local, tauri://localhost).
// Waits for the Rust shell to report the dsh web loopback URL, then navigates.
// Proxy settings live in a standalone window (settings.html) opened from the
// window menu bar or the tray — not on this short-lived startup page.
const tauri = globalThis.__TAURI__;

const stateEl = document.getElementById('state');
const creditsEl = document.getElementById('credits');
const retryBtn = document.getElementById('retry');
const openDataBtn = document.getElementById('opendata');
const spinner = document.getElementById('spinner');
const installProgress = document.getElementById('installProgress');

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
// 单一逻辑（不分安装/日常）：光辉以停止时间为步进节奏——每次扫完推进，
// 速度 200→999 分 9 次递增、停止 700→20ms 分 9 次递减，第 9 次到顶点
// → 停止扫描、所有行全部点亮；时间不足则只看到前面阶段。
const MAX_ROWS = 5;
const GLOW_RADIUS = 40;
const GLOW_BASE = 0.28;
const RAMP_COUNT = 9;
const creditsViewport = document.querySelector('.credits-viewport');
const REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let rows = [];
let scanPos = null, restUntil = 0, lastTs = 0, rafId = null;
let allLit = false, sweepDisabled = false;
let GLOW_SPEED = 200, REST_MS = 700, step = 0;

function lightRow(el) {
  el.style.opacity = '1';
  el.style.textShadow = '0 0 12px rgba(120,200,255,0.9), 0 0 28px rgba(31,111,235,0.6)';
}

function lightAll() {
  allLit = true;
  rows.forEach(lightRow);
}

// 单一步进逻辑：每次扫完推进一次（9 次后到顶点并全部点亮）
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
      advanceStep();                          // 扫完即推进（单一逻辑，不分安装/日常）
      if (allLit) return;                     // 顶点：lightAll 已点亮全部 → 不再渲染/调度
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
  if (!sweepDisabled) startSweep(); // 有行即启动光辉扫动（单一逻辑，不分安装/日常）
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
      if (!allLit) lightAll(); // 安装完成 → 所有数据全部点亮（兜底）
    } else if (p.phase === 'error') {
      installProgress.hidden = true;
      clearTimeout(installStallTimer);
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
