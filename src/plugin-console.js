// DSH Smoothly Desktop — 壳内插件管理窗口（本地页，走 IPC 命令）。
// 与桥端点 /plugins/* 共用同一套 Rust 逻辑（plugins_panel_state 等），
// 预装开关/更新/重置、用户插件安装/卸载/更新、dsh 更新、重启生效提示。
const tauri = globalThis.__TAURI__;

const $ = (id) => document.getElementById(id);
const statusEl = $('statusLine');

let pendingRestart = false;
let state = null;
let op = null;

function setStatus(text, kind) {
  statusEl.textContent = text || '';
  statusEl.className = kind || '';
}

function triggerRestart() {
  pendingRestart = true;
  $('restartBanner').style.display = 'flex';
}

function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined && text !== null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}

function btn(text, cls, onClick) {
  const b = el('button', text, cls);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

async function invoke(cmd, args) {
  try {
    return await tauri.core.invoke(cmd, args || {});
  } catch (err) {
    setStatus('操作失败：' + String(err), 'err');
    return null;
  }
}

// ── 渲染 ───────────────────────────────────────────────────────────
function renderUpdate(upd) {
  $('updCurrent').textContent = upd?.current || '?';
  $('updLatest').textContent = upd?.latest || '?';
  const nextBadge = $('updNextBadge');
  nextBadge.hidden = !(upd?.nextAvailable);
  if (upd?.nextAvailable) nextBadge.textContent = `预发布 ${upd.next} 可升`;
  const nowBtn = $('updNowBtn');
  nowBtn.hidden = !upd?.updateAvailable && !upd?.nextAvailable;
  nowBtn.textContent = upd?.updateAvailable
    ? `一键更新到 ${upd.latest}`
    : (upd?.nextAvailable ? `更新到预发布 ${upd.next}` : '一键更新');
}

function renderPreinstalled() {
  const list = $('preinstalledList');
  list.textContent = '';
  const pre = state?.preinstalled || [];
  const bundles = state?.bundles || [];
  const updates = state?.preinstalledUpdates || {};
  for (const p of pre) {
    const row = el('div', null, 'plug-row');
    const nameEl = el('div', p.name, 'plug-name');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = bundles.includes(p.name);
    cb.addEventListener('change', async () => {
      setStatus('保存中…');
      const res = await invoke('plugins_set_enabled', { name: p.name, enabled: cb.checked });
      if (res) {
        setStatus(`已${cb.checked ? '启用' : '禁用'} ${p.name}（重启服务后生效）`, 'ok');
        triggerRestart();
        refresh();
      }
    });
    const chkLabel = el('label', null, '');
    chkLabel.appendChild(cb);
    nameEl.appendChild(chkLabel);
    row.appendChild(nameEl);
    const upd = updates[p.name];
    if (upd && upd.latest && upd.latest !== upd.installed) {
      const b = el('span', `可升 ${upd.latest}`, 'badge');
      b.style.cssText = 'background: rgba(230,162,60,0.18); color:#8a4b00;';
      nameEl.appendChild(b);
    }
    const descEl = el('div', p.description || '', 'plug-desc');
    row.appendChild(descEl);
    const actions = el('div', null, 'plug-actions');
    actions.appendChild(btn('更新', 'secondary', async () => {
      setStatus(`更新 ${p.name}…`);
      await invoke('plugins_update_preinstalled', { name: p.name });
      const r = await invoke('get_plugins_panel');
      if (r?.op?.done && r.op.ok) { setStatus(`已更新 ${p.name}`, 'ok'); refresh(); }
      else { setStatus(r?.op?.error || `更新 ${p.name} 中…`, r?.op?.ok === false ? 'err' : ''); }
    }));
    actions.appendChild(btn('重置', 'secondary', async () => {
      if (!confirm(`恢复 ${p.name} 到出厂版本？`)) return;
      await invoke('plugins_reset_preinstalled', { name: p.name });
      const r = await invoke('get_plugins_panel');
      if (r?.op?.done && r.op.ok) { setStatus(`已重置 ${p.name}`, 'ok'); refresh(); }
      else { setStatus(r?.op?.error || `重置 ${p.name} 中…`, r?.op?.ok === false ? 'err' : ''); }
    }));
    row.appendChild(actions);
    list.appendChild(row);
  }
}

function renderUserPlugins() {
  const list = $('userPluginsList');
  list.textContent = '';
  const bundles = state?.bundles || [];
  const pre = (state?.preinstalled || []).map((p) => p.name);
  const template = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
  const users = bundles.filter((b) => !pre.includes(b) && !template.includes(b));
  if (!users.length) {
    list.appendChild(el('p', '暂无用户自装插件', 'muted small'));
    return;
  }
  for (const name of users) {
    const row = el('div', null, 'plug-row');
    row.appendChild(el('div', name, 'plug-name'));
    row.appendChild(el('div', null, 'plug-desc'));
    const actions = el('div', null, 'plug-actions');
    actions.appendChild(btn('更新', 'secondary', async () => {
      setStatus(`更新 ${name}…`);
      await invoke('plugins_update', { name });
      const r = await invoke('get_plugins_panel');
      setStatus(r?.op?.error || `更新 ${name} 中…`, r?.op?.ok === false ? 'err' : '');
    }));
    actions.appendChild(btn('卸载', 'secondary', async () => {
      if (!confirm(`卸载 ${name}？`)) return;
      await invoke('plugins_remove', { name });
      const r = await invoke('get_plugins_panel');
      if (r?.op?.done && r.op.ok) { setStatus(`已卸载 ${name}`, 'ok'); refresh(); }
      else { setStatus(r?.op?.error || `卸载 ${name} 中…`, r?.op?.ok === false ? 'err' : ''); }
    }));
    row.appendChild(actions);
    list.appendChild(row);
  }
}

async function refresh() {
  state = await invoke('get_plugins_panel');
  if (!state) return;
  renderUpdate(state.update);
  renderPreinstalled();
  renderUserPlugins();
}

// ── 事件 ───────────────────────────────────────────────────────────
$('closeBtn').addEventListener('click', async () => {
  try { await tauri.window.getCurrentWindow().close(); } catch { /* noop */ }
});
$('updCheckBtn').addEventListener('click', async () => {
  setStatus('检查中…');
  await invoke('check_update');
  const r = await invoke('get_update_status');
  if (r && r.updateAvailable) setStatus(`发现新版本 ${r.latest}（可一键更新）`, '');
  else setStatus('已是最新', 'ok');
  refresh();
});
$('updNowBtn').addEventListener('click', async () => {
  setStatus('更新中…（完成后自动重启服务）');
  await invoke('update_now');
});
$('preCheckBtn').addEventListener('click', async () => {
  setStatus('检查预装插件更新…');
  await invoke('plugins_check_preinstalled_updates');
  const r = await invoke('get_plugins_panel');
  if (r?.op?.done && r.op.ok) { setStatus('预装插件已是最新', 'ok'); refresh(); }
  else { setStatus(r?.op?.error || '检查中…', r?.op?.ok === false ? 'err' : ''); }
});
$('installBtn').addEventListener('click', async () => {
  const spec = $('installInput').value.trim();
  if (!spec) return setStatus('请输入插件地址', 'err');
  setStatus(`安装 ${spec}…`);
  const res = await invoke('plugins_install', { spec });
  if (res) setStatus('安装任务已提交（完成后提示）', '');
  $('installInput').value = '';
  refresh();
});
$('restartNowBtn').addEventListener('click', async () => {
  setStatus('正在重启服务…');
  await invoke('restart_server');
});
$('restartDismissBtn').addEventListener('click', () => {
  pendingRestart = false;
  $('restartBanner').style.display = 'none';
});

// ── 轮询（op 反馈 + 状态刷新）────────────────────────────────────
setInterval(async () => {
  const r = await invoke('get_plugins_panel');
  if (!r) return;
  const o = r.op;
  if (o && o.done) {
    if (o.ok) {
      setStatus((o.op === 'install' ? '已安装' : o.op === 'remove' ? '已卸载' : '操作完成') +
        (o.spec ? ` ${o.spec}` : '') + (o.nextAction === 'restart' ? '（重启服务后生效）' : ''), 'ok');
      if (o.nextAction === 'restart') triggerRestart();
    } else {
      setStatus((o.error || '操作失败') + (o.hint ? ` — ${o.hint}` : ''), 'err');
    }
  }
}, 1500);

refresh();