// DSH Desktop — proxy settings window (standalone local page, opened from the
// main window menu bar or the tray). No dependency on the launcher page, so it
// works whether or not dsh is loaded; the dsh page is never interrupted.
const tauri = globalThis.__TAURI__;

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
    // 模型提供方：settings.yaml 读到的 [{name, host, displayName?}]。
    // 路由是 host 级（TCP 层只能按地址区分），所以同一地址下的多个提供方
    // 归并成一个条目：标签列出所有名称，共用一个开关（同地址一起走代理）。
    const byHost = new Map(); // host -> [friendly names]
    for (const p of cfg.providers || []) {
      const host = p.host;
      if (!host) continue;
      const disp = p.displayName || p.name || host;
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host).push(disp);
    }
    const providers = [...byHost.entries()].map(([host, names]) => ({
      label: `${[...new Set(names)].join(' / ')}（${host}）`,
      host,
    }));
    // 其它已观测主机：knownHosts（持久化）+ hosts（本次运行观测），去重、剔除提供方。
    const providerHosts = new Set(byHost.keys());
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

document.getElementById('settingsClose').addEventListener('click', async () => {
  try {
    await tauri.window.getCurrentWindow().close();
  } catch {
    // Fallback: nothing to do — window close is best-effort.
  }
});

loadSettings();
