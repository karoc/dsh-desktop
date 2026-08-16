// DSH Desktop launcher page (local, tauri://localhost).
// Waits for the Rust shell to report the dsh web loopback URL, then navigates.
const stateEl = document.getElementById('state');
const creditsEl = document.getElementById('credits');
const retryBtn = document.getElementById('retry');
const openDataBtn = document.getElementById('opendata');
const spinner = document.getElementById('spinner');
const updateBanner = document.getElementById('update-banner');
const updateText = document.getElementById('update-text');
const updateNowBtn = document.getElementById('update-now');

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

const tauri = globalThis.__TAURI__;

// ── 更新横幅：轮询壳里的 dsh 更新状态，有新版则提示一键更新 ──
// 只在启动页可见期间有意义；托盘菜单的"检查更新/有更新"是常驻入口。
let updating = false;

async function pollUpdateStatus() {
  if (!tauri || !tauri.core || updating) return;
  try {
    const s = await tauri.core.invoke('get_update_status');
    if (s && s.updateAvailable && s.latest) {
      updateText.textContent = `发现新版本 ${s.latest}${s.current ? `（当前 ${s.current}）` : ''}`;
      updateBanner.hidden = false;
    } else {
      updateBanner.hidden = true;
    }
  } catch { /* IPC 未就绪，下轮再试 */ }
}

updateNowBtn.addEventListener('click', async () => {
  updating = true;
  updateBanner.classList.add('updating');
  updateText.textContent = '正在更新 dsh 并重启服务…';
  setState('正在更新 dsh（视网络需 1~10 分钟），完成后自动重启…');
  try {
    await tauri.core.invoke('update_now');
  } catch (err) {
    setState('更新失败：' + String(err), true);
    appendLog('update failed: ' + String(err));
    updating = false;
    updateBanner.classList.remove('updating');
    updateBanner.hidden = true;
  }
});

if (tauri && tauri.event) {
  tauri.event.listen('server-url', (ev) => {
    const url = ev.payload;
    if (typeof url === 'string' && /^https?:\/\//.test(url)) {
      setState('dsh 已就绪，正在打开界面…');
      window.location.href = url;
    }
  });

  tauri.event.listen('server-log', (ev) => {
    if (typeof ev.payload === 'string') {
      appendLog(ev.payload);
      // Keep the user informed during the slow first install.
      if (/updating @deepseek-ai|首次安装|已更新到|updated to|正在下载/.test(ev.payload)) {
        setState('正在安装/更新 dsh（首次需几分钟）…');
      }
    }
  });

  tauri.event.listen('server-down', () => {
    setState('dsh 服务已退出。', true);
    appendLog('server exited — 完整日志见数据目录里的 manager.log');
  });
} else {
  setState('Tauri IPC 不可用，无法启动服务。', true);
}

retryBtn.addEventListener('click', async () => {
  setState('正在重启 dsh 服务…');
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

// Poll the update status while the launcher page is visible (2s interval;
// cheap local IPC; stops mattering once we navigate to the dsh page).
setInterval(pollUpdateStatus, 2000);
pollUpdateStatus();