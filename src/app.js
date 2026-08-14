// dsh Desktop launcher page (local, tauri://localhost).
// Waits for the Rust shell to report the dsh web loopback URL, then navigates.
const stateEl = document.getElementById('state');
const logEl = document.getElementById('log');
const retryBtn = document.getElementById('retry');
const openDataBtn = document.getElementById('opendata');
const spinner = document.getElementById('spinner');

function setState(text, failed = false) {
  stateEl.textContent = text;
  stateEl.style.color = failed ? '#f85149' : '';
  spinner.hidden = failed;
  retryBtn.hidden = !failed;
  openDataBtn.hidden = !failed;
}

function appendLog(line) {
  logEl.hidden = false;
  logEl.textContent += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

const tauri = globalThis.__TAURI__;

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
  logEl.textContent = '';
  logEl.hidden = true;
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