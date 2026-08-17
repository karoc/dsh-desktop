// DSH Desktop launcher page (local, tauri://localhost).
// Waits for the Rust shell to report the dsh web loopback URL, then navigates.
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

// ── 无框片尾字幕式日志 ──────────────────────────────────
// .credits-viewport 高度固定 5 行 + 顶部淡出蒙版；新行从底部
// 淡入，旧行随内容向上滚动，超过视口后在顶部淡出并被裁剪。
// 因此屏幕同时最多显示最新的 5 行。为控制内存，仅当行数超过
// TRIM_AFTER 时才移除早已被完全裁剪的顶部旧行。
const TRIM_AFTER = 12;

function appendLog(line) {
  const el = document.createElement('div');
  el.className = 'credit-line';
  el.textContent = line;
  el.title = line; // 长路径被 ellipsis 截断，悬停看全文
  creditsEl.appendChild(el);
  // 下一帧再加 entered，让 opacity:0 的起始状态先被渲染，淡入才可见
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('entered'));
  });
  while (creditsEl.children.length > TRIM_AFTER) {
    creditsEl.firstElementChild.remove();
  }
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

const tauri = globalThis.__TAURI__;

if (tauri && tauri.event) {
  tauri.event.listen('server-url', (ev) => {
    const url = ev.payload;
    if (typeof url === 'string' && /^https?:\/\//.test(url)) {
      gotUrl = true;
      clearTimeout(launchStallTimer);
      setState('dsh 已就绪，正在打开界面…');
      window.location.href = url;
    }
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
    } else if (p.phase === 'error') {
      installProgress.hidden = true;
      clearTimeout(installStallTimer);
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
