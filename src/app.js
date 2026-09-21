// DSH Smoothly Desktop launcher page (local, tauri://localhost).
// Waits for the Rust shell to report the dsh web loopback URL, then navigates.
// Proxy settings live in a standalone window (settings.html) opened from the
// window menu bar or the tray — not on this short-lived startup page.
const tauri = globalThis.__TAURI__;

const stateEl = document.getElementById('state');
const creditsEl = document.getElementById('credits');
const retryBtn = document.getElementById('retry');
const openDataBtn = document.getElementById('opendata');
const openPluginsBtn = document.getElementById('openplugins');
const spinner = document.getElementById('spinner');
const installProgress = document.getElementById('installProgress');

function setState(text, failed = false) {
  stateEl.textContent = text;
  stateEl.style.color = failed ? '#f85149' : '';
  spinner.hidden = failed;
  retryBtn.hidden = !failed;
  openDataBtn.hidden = !failed;
  openPluginsBtn.hidden = !failed;
}

// ── 9 行替换 + 光辉扫过（demo-K 效果）────────────────────
// 固定 9 行：新行直接替换到顶部，最旧一行移除（直接模式，无动画）。
// 光辉从视口下方向上扫过，扫出顶部后按当前停止时间休息，再扫下一次。
// 单一逻辑（不分安装/日常）：光辉以停止时间为步进节奏——每次扫完推进，
// 速度 200→999 分 9 次递增、停止 700→20ms 分 9 次递减，第 9 次到顶点
// → 停止扫描、停顿 FINAL_LIGHT_DELAY_MS 后再全部点亮；时间不足则只看到前面阶段。
const MAX_ROWS = 9;
const GLOW_RADIUS = 40;
const GLOW_BASE = 0.28;
const RAMP_COUNT = 9;
const creditsViewport = document.querySelector('.credits-viewport');
const REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let rows = [];
let scanPos = null, restUntil = 0, lastTs = 0, rafId = null;
let allLit = false, sweepDisabled = false;
let GLOW_SPEED = 200, REST_MS = 700, step = 0;
let lightAllTimer = null;
// 最后一次光辉扫完后、全部点亮前的停顿（毫秒）：让顶点亮灯效果更醒目。
const FINAL_LIGHT_DELAY_MS = 1700;

function lightRow(el) {
  el.style.opacity = '1';
  el.style.textShadow = '0 0 12px rgba(120,200,255,0.9), 0 0 28px rgba(31,111,235,0.6)';
}

function lightAll() {
  if (lightAllTimer !== null) { clearTimeout(lightAllTimer); lightAllTimer = null; } // 幂等：任何路径触发都取消挂起定时器
  allLit = true;
  rows.forEach(lightRow);
}

// 单一步进逻辑：每次扫完推进一次（9 次后到顶点并全部点亮）
function advanceStep() {
  step++;
  if (step >= RAMP_COUNT) {
    GLOW_SPEED = 999; REST_MS = 20;
    stopSweep();
    // 最后的亮灯前停顿 FINAL_LIGHT_DELAY_MS 再全部点亮；
    // 等待期被 resetSweep / 失败态（server-down / install error）取消。
    clearTimeout(lightAllTimer);
    lightAllTimer = setTimeout(lightAll, FINAL_LIGHT_DELAY_MS);
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
      if (allLit || lightAllTimer !== null) return; // 顶点：立即点亮或等 1.7s 后点亮 → 不再调度
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
  // 顶点后（最终亮灯定时器已挂起）不再重启扫动：否则新日志到达会重新推进
  // advanceStep → clearTimeout + 重新 setTimeout，亮灯被持续涌入的日志无限推迟
  if (REDUCED_MOTION || allLit || lightAllTimer !== null || rafId !== null) return;
  lastTs = 0;
  rafId = requestAnimationFrame(scanTick);
}

function stopSweep() {
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
}

// 安装开始时归零：光辉重新从 200/700 起步；错误/退出态解除
function resetSweep() {
  stopSweep();
  clearTimeout(lightAllTimer); lightAllTimer = null; // 取消未触发的最终亮灯
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

  // 壳状态 → 启动页文案（异常退出时显示退出码 + 证据目录；壳不自动重启，
  // 重启只能由用户点「重试」触发 —— 决定 D1）。
  function applyShellStatus(st) {
    const exit = (st && st.lastManagerExit) || null;
    if (!exit) return false;
    const where = exit.evidenceDir
      ? `证据已保存到 ${exit.evidenceDir}`
      : '证据目录写入失败，完整日志见数据目录';
    showActionable(
      `dsh 服务异常退出（退出码 ${exit.hex || '?'}）。`,
      `${where}；点「重试」手动重启服务。`,
    );
    return true;
  }

  tauri.event.listen('server-down', () => {
    clearTimeout(launchStallTimer);
    clearTimeout(installStallTimer);
    clearTimeout(lightAllTimer); lightAllTimer = null; // 失败态不亮灯
    installProgress.hidden = true;
    sweepDisabled = true;
    stopSweep();
    const generic = () => showActionable('dsh 服务已退出。', '完整日志见数据目录里的 manager.log');
    try {
      tauri.core.invoke('get_shell_status')
        .then((st) => { if (!applyShellStatus(st)) generic(); })
        .catch(generic);
    } catch (_) {
      generic();
    }
  });

  // 冷启动 / 故障回退导航：server-down 事件在页面加载前就已经发过了，页面必须
  // 主动查一次壳状态，否则会停在「正在启动 dsh 服务…」的假象上（实机验证）。
  try {
    tauri.core.invoke('get_shell_status').then((st) => {
      if (st && st.managerAlive === false) applyShellStatus(st);
    }).catch(() => {});
  } catch (_) { /* IPC 不可用：保持默认文案 */ }

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
        setState('安装仍在进行 — 网络较慢时可能需要几分钟；卡住会自动切换镜像重试，或点击「重试」手动中断');
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
      clearTimeout(lightAllTimer); lightAllTimer = null; // 失败态不亮灯
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

// 壳内已无插件管理 UI（0.1.6-alpha.2 起交给 dsh 的 Web 侧边栏「插件」页，那个页面
// 要 dsh 能起来才打得开）。所以启动失败时这里提供不依赖 dsh 的自救：把插件启用列表
// 回退到 dsh 自带的两层。改动前会先备份 profile manifest，插件文件不会被删除。
openPluginsBtn.addEventListener('click', async () => {
  try {
    const res = await tauri.core.invoke('disable_third_party_plugins');
    if (!res || res.ok !== true) {
      appendLog('停用第三方插件失败：' + String((res && res.error) || '壳未响应'));
      return;
    }
    if (!res.changed) {
      appendLog('当前只有 dsh 自带的插件，无需改动。');
      return;
    }
    const removed = Array.isArray(res.removed) ? res.removed : [];
    appendLog('已停用 ' + removed.length + ' 个第三方插件，备份：' + String(res.backup || ''));
    appendLog('请点「重试」重启服务；之后可在 dsh 的「插件」页重新启用。');
  } catch (err) {
    appendLog('停用第三方插件失败：' + String(err));
  }
});

// ── 导航兜底：WebView2 冷启动时首次 server-url 的 navigate 可能丢失 ──────
// （壳黑屏根因：manager 1.5s 出 URL，窗口初始化需数秒）。launcher 自身轮询
// liveUrl 并跳转，不依赖窗口就绪时序；仅当仍停在本地页（tauri:）时执行。
const NAV_POLL_MS = 1000;
const NAV_POLL_LIMIT = 120;
let navPolled = 0;
const navTimer = setInterval(async () => {
  navPolled += 1;
  if (navPolled > NAV_POLL_LIMIT) {
    clearInterval(navTimer);
    return;
  }
  if (location.protocol !== 'tauri:') {
    clearInterval(navTimer); // 已离开启动页（正常导航完成）
    return;
  }
  try {
    const st = await tauri.core.invoke('get_shell_state');
    const url = st && typeof st.liveUrl === 'string' ? st.liveUrl : null;
    if (url && /^https?:\/\//.test(url) && !gotUrl) {
      gotUrl = true;
      clearTimeout(launchStallTimer);
      setState('dsh 已就绪，正在打开界面…');
      window.location.href = url;
    }
  } catch {
    /* 壳尚未就绪时静默重试 */
  }
}, NAV_POLL_MS);

// ── 旧版（0.3.x）残留检测横幅 ───────────────────────────
// 启动时查一次 check_legacy_install：发现旧安装或旧数据目录被空壳重建
// （dev.dsh.desktop 意外出现）→ 显示横幅，可一键清理（静默卸载旧版 +
// 删快捷方式；数据先自动备份至 %LOCALAPPDATA%\dsh-backup\，永不删除）。
const legacyBanner = document.getElementById('legacyBanner');
const legacyBannerText = document.getElementById('legacyBannerText');
const legacyCleanBtn = document.getElementById('legacyCleanBtn');
const legacyLaterBtn = document.getElementById('legacyLaterBtn');

async function checkLegacy() {
  if (!tauri || !tauri.core) return;
  try {
    const r = await tauri.core.invoke('check_legacy_install');
    if (!r || (!r.legacyDir && !r.dataRecreated)) return;
    if (sessionStorage.getItem('dsh-legacy-later')) return; // 本次会话已选"稍后"
    const parts = [];
    if (r.legacyDir) parts.push('安装残留（0.3.x）');
    if (r.dataRecreated) parts.push('旧数据目录被旧版重建');
    const canClean = r.legacyDir && !r.running;
    legacyBannerText.textContent = canClean
      ? `检测到${parts.join('、')}。清理前会先备份数据（${r.backupRoot || 'dsh-backup'}），数据不会删除。`
      : `检测到${parts.join('、')}。请退出旧版后再清理（可在「DSH Desktop」菜单 →「旧版清理…」操作）。`;
    legacyCleanBtn.hidden = !canClean;
    legacyBanner.hidden = false;
    legacyCleanBtn.onclick = async () => {
      legacyCleanBtn.disabled = true;
      legacyCleanBtn.textContent = '清理中…';
      try {
        const res = await tauri.core.invoke('cleanup_legacy_install');
        if (res && res.ok) {
          legacyBannerText.textContent = `清理完成：孤儿卸载器${res.removedUninstaller ? '已删' : '未删'}，快捷方式已删 ${res.removedShortcuts ?? 0} 个，旧目录${res.removedDir ? '已移除' : '留有残留'}。`;
        } else if (res && res.reason === 'legacy-app-present') {
          legacyBannerText.textContent = '旧版主程序仍在：其卸载器会按程序名结束同名的正式版进程，已跳过。请在「设置 → 应用」中手动卸载 DSH Desktop。';
        } else {
          legacyBannerText.textContent = `清理未完成（${(res && res.reason) || '未知原因'}）。请从「旧版清理…」菜单重试。`;
        }
        legacyCleanBtn.hidden = true;
      } catch (err) {
        legacyBannerText.textContent = '清理失败：' + String(err);
        legacyCleanBtn.disabled = false;
        legacyCleanBtn.textContent = '清理旧版残留';
      }
    };
    legacyLaterBtn.onclick = () => {
      sessionStorage.setItem('dsh-legacy-later', '1');
      legacyBanner.hidden = true;
    };
  } catch (err) {
    appendLog('旧版检测失败：' + String(err));
  }
}
if (tauri && tauri.core) checkLegacy();
