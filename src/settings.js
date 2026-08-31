// DSH Smoothly Desktop — proxy settings window (standalone local page, opened from the
// main window menu bar or the tray). No dependency on the launcher page, so it
// works whether or not dsh is loaded; the dsh page is never interrupted.
const tauri = globalThis.__TAURI__;

const proxyEnabled = document.getElementById('proxyEnabled');
const proxyProtocol = document.getElementById('proxyProtocol');
const proxyHost = document.getElementById('proxyHost');
const proxyPort = document.getElementById('proxyPort');
const proxyUser = document.getElementById('proxyUser');
const proxyPass = document.getElementById('proxyPass');
const providerHostsEl = document.getElementById('providerHosts');
const otherHostsEl = document.getElementById('otherHosts');
const hostSearch = document.getElementById('hostSearch');
const saveStatus = document.getElementById('saveStatus');
const saveProxyBtn = document.getElementById('saveProxy');
const testProxyBtn = document.getElementById('testProxy');
const testStatus = document.getElementById('testStatus');

// Cached candidate lists so typing in the search box re-renders without
// re-fetching the config from the shell.
let providersCache = [];
let othersCache = [];
let proxiedCache = new Set();

function renderHosts(filter) {
  const q = (filter || '').trim().toLowerCase();
  const match = (label) => !q || label.toLowerCase().includes(q);
  const onChange = () => { saveStatus.textContent = ''; };
  const proxied = [...proxiedCache];
  renderHostGroup(providerHostsEl, providersCache.filter((e) => match(e.label)), proxied, onChange, '尚未读取到模型提供方（在 dsh 设置里配置模型后会自动出现）');
  renderHostGroup(otherHostsEl, othersCache.filter((e) => match(e.label)), proxied, onChange, '暂无（dsh 访问过外部主机后会自动出现，含 registry.npmjs.org 等安装流量）');
}

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
    proxyProtocol.value = ['https', 'socks5'].includes(up.protocol) ? up.protocol : 'http';
    proxyHost.value = up.host || '';
    proxyPort.value = up.port ? String(up.port) : '';
    proxyUser.value = up.username || '';
    proxyPass.value = up.password || '';

    // Hosts saved before the comma-cleaning fix may carry a trailing comma
    // ("api.xxx.com,") that never matches the real target — normalize them so
    // old selections still light up (and get overwritten with clean values on
    // the next save).
    const normalizeHost = (h) => String(h || '').trim().toLowerCase().replace(/,\s*$/, '');
    const proxied = new Set((cfg.proxiedHosts || []).map(normalizeHost).filter(Boolean));
    // 模型提供方：settings.yaml 读到的 [{name, host, displayName?}]。
    // 显示名 fallback：displayName（dsh 里配的友好名）→ route key（去掉
    // llm-pi-ai/ 前缀）→ host 可读部分（anyrouter.top → anyrouter）→ host。
    // 绝不显示 llm-pi-ai 这类内部命名空间。
    const hostLabel = (h) => {
      const m = String(h || '').match(/^(?:www\.)?([^.]+)\./);
      return m ? m[1] : h;
    };
    const friendlyName = (p) => {
      if (p.displayName) return p.displayName;
      const name = p.name || '';
      if (name === 'llm-deepseek') return 'DeepSeek';
      const key = name.split('/').pop();
      if (key && key !== name) return key; // llm-pi-ai/anyrouter -> anyrouter
      return hostLabel(p.host);
    };
    // 路由是 host 级（TCP 层只能按地址区分），所以同一地址下的多个提供方
    // 归并成一个条目：标签列出所有名称，共用一个开关（同地址一起走代理）。
    const byHost = new Map(); // host -> [friendly names]
    for (const p of cfg.providers || []) {
      const host = p.host;
      if (!host) continue;
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host).push(friendlyName(p));
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
    providersCache = providers;
    othersCache = others;
    proxiedCache = new Set([...proxied]);
    renderHosts('');
  } catch (err) {
    saveStatus.textContent = '读取失败：' + String(err);
  }
}

hostSearch.addEventListener('input', () => renderHosts(hostSearch.value));

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
    protocol: proxyProtocol.value,
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

testProxyBtn.addEventListener('click', async () => {
  testStatus.textContent = '测试中…';
  testProxyBtn.disabled = true;
  try {
    const res = await tauri.core.invoke('test_proxy', {
      upstream: {
        enabled: true,
        protocol: proxyProtocol.value,
        host: proxyHost.value.trim(),
        port: Number(proxyPort.value) || 0,
        username: proxyUser.value.trim(),
        password: proxyPass.value,
      },
    });
    if (res && res.ok) {
      testStatus.textContent = `✓ 连接成功${res.detail ? '（' + res.detail + '）' : ''}`;
      testStatus.style.color = '#3fb950';
    } else {
      testStatus.textContent = `✗ ${res?.detail || '连接失败'}`;
      testStatus.style.color = '#f85149';
    }
  } catch (err) {
    testStatus.textContent = '✗ 测试失败：' + String(err);
    testStatus.style.color = '#f85149';
  } finally {
    testProxyBtn.disabled = false;
    setTimeout(() => { testStatus.textContent = ''; testStatus.style.color = ''; }, 6000);
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
