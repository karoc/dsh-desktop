// DSH Smoothly Desktop — 危险动作确认窗（壳拥有的独立 webview）。
//
// 数据流：桥收到危险请求 → Rust 登记一次性槽位 + 打开本窗口 → 本窗口 invoke
// `get_pending_action`（**文案由 Rust 生成**，页面不接收调用方文案）→ 用户点击
// 「确认执行」/「取消」→ invoke `resolve_pending_action(nonce, approved)`。
//
// 细节：
//   - Esc = 取消（默认焦点在「取消」，避免回车误触危险动作）；
//   - 槽位过期（60s）或已被结算时 `get_pending_action` 返回 null → 显示「已失效」并禁用按钮；
//   - 关闭窗口不做任何动作（等于取消，但槽位留给过期清理，避免"关窗即批准"）。
const tauri = globalThis.__TAURI__;

const titleEl = document.getElementById('title');
const detailEl = document.getElementById('detail');
const hintEl = document.getElementById('hint');
const cancelBtn = document.getElementById('cancel');
const approveBtn = document.getElementById('approve');

let nonce = null;
let settled = false;

function disable(reason) {
  settled = true;
  approveBtn.disabled = true;
  cancelBtn.textContent = '关闭';
  if (reason) hintEl.textContent = reason;
}

async function load() {
  if (!tauri || !tauri.core) {
    detailEl.textContent = '壳 IPC 不可用，无法确认该操作。';
    disable('请关闭本窗口，并在应用内重试。');
    return;
  }
  let pending = null;
  try {
    pending = await tauri.core.invoke('get_pending_action');
  } catch (err) {
    detailEl.textContent = '读取待确认操作失败：' + String(err);
    disable();
    return;
  }
  if (!pending) {
    titleEl.textContent = '操作已失效';
    detailEl.textContent = '该请求已过期或已被处理，请重新发起。';
    disable();
    return;
  }
  nonce = String(pending.nonce);
  titleEl.textContent = String(pending.title || '确认操作');
  detailEl.textContent = String(pending.detail || '');
  cancelBtn.focus();
}

async function answer(approved) {
  if (settled || nonce === null) {
    window.close();
    return;
  }
  settled = true;
  approveBtn.disabled = true;
  cancelBtn.disabled = true;
  try {
    const res = await tauri.core.invoke('resolve_pending_action', { nonce, approved });
    if (approved && res && res.ok === false) {
      detailEl.textContent = '执行失败：' + String(res.error || '未知错误');
      hintEl.textContent = '动作未生效，可在壳菜单重试。';
      cancelBtn.textContent = '关闭';
      cancelBtn.disabled = false;
      cancelBtn.focus();
      return;
    }
  } catch (err) {
    detailEl.textContent = '答复失败：' + String(err);
    hintEl.textContent = '请关闭本窗口后重试。';
    cancelBtn.textContent = '关闭';
    cancelBtn.disabled = false;
    cancelBtn.focus();
    return;
  }
  window.close();
}

cancelBtn.addEventListener('click', () => { void answer(false); });
approveBtn.addEventListener('click', () => { void answer(true); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    void answer(false);
  }
});

void load();
