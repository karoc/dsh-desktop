//! DSH Smoothly Desktop — Tauri 2 shell for DeepSeek Harness.
//!
//! Responsibilities (everything dsh-version-specific lives in the JS
//! `server-manager`; Rust only owns the window/shell lifecycle):
//!
//! 1. Spawn the bundled Node 24 + `server-manager.mjs`, which installs /
//!    updates `@deepseek-ai/dsh` from npm and starts `dsh web --port 0`
//!    with a `--patch` that injects the notification client plugin.
//! 2. Read the manager's stdout events, navigate the window to the printed
//!    loopback URL, and surface native notifications from the injected
//!    client plugin (permission is scoped to `http://127.0.0.1/*` only).
//! 3. Tray: close hides to tray; "退出" kills the whole service tree.

use std::io::{BufRead, BufReader, Read as _, Write as _};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::{AppHandle, Emitter, Listener, Manager, State};

mod job_object;
mod manager_guard;
mod web_dump;
use manager_guard::{MgrPhase, ManagerExit, ManagerGuard};

/// The shell chrome (custom title bar + menu bar), injected into the MAIN
/// webview on every page load. Embedded at compile time (include_str! is a
/// cargo rebuild dependency): the menu definition point is the `SHELL_MENUS`
/// array at the top of the file — adding a shell menu never touches Rust.
/// See scripts/test-shell-chrome.mjs for the chrome↔shell contract test.
const SHELL_CHROME: &str = include_str!("../resources/ui/shell-chrome.js");

/// The spawned `server-manager` child (owns the dsh service tree) plus the
/// control plane the shell needs to talk to it.
struct ServerState {
    child: Mutex<Option<Child>>,
    /// Manager's stdin pipe: JSON-line commands (`{"cmd":"restart-dsh"}` …).
    stdin: Mutex<Option<ChildStdin>>,
    /// Latest dsh update status reported by the manager.
    update: Mutex<UpdateStatus>,
    /// Latest **shell** update status (A-1). Deliberately separate from `update`:
    /// the tray's click action keys off `update.update_available` and sends
    /// `update-dsh`, so mixing shell availability into it would make the user
    /// update dsh while thinking they update the shell.
    shell_update: Mutex<ShellUpdateStatus>,
    /// Tray item whose text flips between "检查更新…" and "有更新 vX（点击更新）".
    update_item: Mutex<Option<MenuItem<tauri::Wry>>>,
    /// Tray checkbox mirroring the dsh.json devMode flag.
    dev_item: Mutex<Option<CheckMenuItem<tauri::Wry>>>,
    /// Tray checkbox mirroring the dsh.json webview.gpu flag (GPU 加速开关).
    gpu_item: Mutex<Option<CheckMenuItem<tauri::Wry>>>,
    /// Latest plugin operation status reported by the manager.
    op: Mutex<OpStatus>,
    /// Cached per-preinstalled update state, mirrored from the manager's
    /// (removed) preinstalled-updates state — the shell no longer manages plugin versions.
    /// Proxy UI data mirrored from the manager's `proxy-hosts` /
    /// `proxy-providers` protocol lines (observed hosts + settings.yaml
    /// provider hosts, for the settings panel's checkbox list).
    proxy: Mutex<ProxyState>,
    /// 最近一次故障（中文摘要，供 chrome 故障条幅披露）。服务正常启动后清空。
    last_error: Mutex<Option<String>>,
    /// manager 生命周期看护（阶段/世代/意图停止/最近一次退出）——见
    /// manager_guard.rs。**只检测+取证+提示，绝不自动重启**（决定 D1）。
    guard: Mutex<ManagerGuard>,
    /// 本壳进程启动时刻（unix 秒），取证时记入 shellUptimeSecs。
    shell_started_at: u64,
    /// 挂起 dump 状态（按 dsh web URL 去重，见 HangDump / dump_dsh_web）。
    hang_dump: Mutex<HangDump>,
}

/// 挂起 dump 的认领状态：壳内 watchdog 与 manager 的 dump-web 请求会几乎同时
/// 到达，两条路径必须收敛到一次 dump，且**回执只能在本轮 dump 结束后发**——
/// 否则 manager 会在 dump 还没写完时就杀掉进程，现场直接消失（2026-09-09 实测）。
#[derive(Clone, Debug, PartialEq, Eq)]
enum HangDump {
    Idle,
    InProgress(String),
    Done(String),
}

/// Proxy panel data mirrored from manager protocol lines (see ServerState.proxy).
#[derive(Default, Clone)]
struct ProxyState {
    /// Hosts the built-in proxy has actually seen traffic for.
    hosts: Vec<String>,
    /// Model provider hosts read from the web profile's settings.yaml.
    providers: Vec<serde_json::Value>,
}

/// dsh update status, mirrored from the manager's `update-status` protocol line.
#[derive(Default, Clone)]
struct UpdateStatus {
    current: Option<String>,
    latest: Option<String>,
    update_available: bool,
    /// Pre-release channel version (any dist-tag: alpha/beta/next…), e.g.
    /// 0.1.3-alpha.1 when latest is 0.1.2-rc.1.
    next: Option<String>,
    /// Which dist-tag the pre-release candidate came from (alpha/beta/next).
    next_tag: Option<String>,
    next_available: bool,
}

/// 壳自更新状态（A-1），镜像 manager 的 `shell-update` 协议行。
///
/// 与 `UpdateStatus` 严格分开：后者的 `update_available` 会翻转托盘文案并让
/// 点击发 `update-dsh`（更新 dsh 本体）；壳更新只做**只读展示**，不触发任何
/// 自动动作（一期不下载、不安装、不打开 URL）。
#[derive(Default, Clone)]
struct ShellUpdateStatus {
    current: Option<String>,
    latest: Option<String>,
    has_update: bool,
    /// Release 页面地址（仅展示给用户复制；壳不代为打开）。
    url: Option<String>,
    /// 检查失败原因（网络/限流/解析），UI 如实展示。
    error: Option<String>,
    /// dev 构建：不检查壳更新。
    dev: bool,
}

/// Latest plugin operation status, mirrored from the manager's `op-status`
/// protocol line (install / remove / update via the bundled-pnpm `dsh plugin`).
#[derive(Default, Clone)]
struct OpStatus {
    op: Option<String>,
    spec: Option<String>,
    done: bool,
    ok: Option<bool>,
    next_action: Option<String>,
    error: Option<String>,
    /// Human hint, e.g. "installed but declares no dsh.bundle — won't load".
    hint: Option<String>,
    /// Structured hint key so the console can localize it (e.g. "not-a-bundle").
    hint_key: Option<String>,
    /// Params for the localized hint (e.g. the plugin names that didn't load).
    hint_plugins: Option<Vec<String>>,
}

/// Send one JSON command line to the manager's stdin (no-op when absent).
fn send_manager(stdin: &mut Option<ChildStdin>, cmd: &str) {
    send_line(stdin, &serde_json::json!({ "cmd": cmd }).to_string());
}

/// Send one raw JSON line to the manager's stdin (no-op when absent).
fn send_line(stdin: &mut Option<ChildStdin>, line: &str) {
    use std::io::Write as _;
    if let Some(stdin) = stdin.as_mut() {
        let _ = writeln!(stdin, "{line}");
        let _ = stdin.flush();
    }
}

/// Kill the manager child and, on Windows, its whole process tree.
///
/// This is the **only** intentional stop path (tray 重启/退出、restart_server、
/// quit_app). It marks the current generation intentional and bumps it before
/// touching the process, so the stdout reader / watchdog treat the exit as
/// expected instead of reporting a crash.
///
/// Bug fix (2026-09-09): never `taskkill /PID` a PID that has already exited —
/// the PID may have been reused by an unrelated process by then. `try_wait`
/// first; a reaped child is simply waited on.
fn stop_child(state: &ServerState) {
    {
        let mut guard = state.guard.lock().unwrap();
        guard.intentional = true;
        guard.phase = MgrPhase::Stopping;
        guard.generation += 1; // stale detectors must ignore the coming exit
    }
    // Drop our stdin handle first: the manager sees EOF and stops reading.
    *state.stdin.lock().unwrap() = None;
    if let Some(mut child) = state.child.lock().unwrap().take() {
        let already_exited = matches!(child.try_wait(), Ok(Some(_)));
        if !already_exited {
            #[cfg(windows)]
            {
                let mut kill = Command::new("taskkill");
                no_console_window(&mut kill);
                let _ = kill
                    .arg("/pid")
                    .arg(child.id().to_string())
                    .arg("/T")
                    .arg("/F")
                    .status();
            }
            let _ = child.kill();
        }
        let _ = child.wait();
    }
    state.guard.lock().unwrap().phase = MgrPhase::Down;
}

/// Windows only: spawn console programs without flashing a cmd window
/// (CREATE_NO_WINDOW). The bundled node.exe (and its npm/dsh children, which
/// already run with windowsHide) must never pop a console on the user's desk.
#[cfg(windows)]
fn no_console_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
}

/// Append a line to <app_data>/dsh-desktop-session.log (persistent Rust-side
/// log; complements manager.log on the JS side). Never fails the caller.
fn log_line(data_dir: &std::path::Path, msg: &str) {
    use std::io::Write;
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("dsh-desktop-session.log"))
    {
        let _ = writeln!(f, "[{secs}] {msg}");
    }
}

/// Port of the loopback notification bridge, shared with the manager child.
static BRIDGE_PORT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);

/// Windows Job Object handle (raw value) holding the whole service tree with
/// kill-on-close. 0 = unavailable (job creation failed; orphan cleanup remains
/// the fallback). Kept for the process lifetime — closing it would kill the
/// service. Windows-only: on other platforms the field does not exist.
#[cfg(windows)]
static SERVICE_JOB: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Session id of the most recent notification — a toast click re-opens it.
static LAST_SESSION: Mutex<Option<String>> = Mutex::new(None);
/// Session id waiting to be revealed in the UI (set on app activation, cleared
/// once the client page reads it via /pending-open).
static PENDING_OPEN: Mutex<Option<String>> = Mutex::new(None);
/// Session id to reveal when the window next REGAINS FOCUS. Windows toast
/// clicks do not relaunch the exe (no single-instance callback) — they merely
/// activate/restore the window, so the focus event is the only observable
/// signal of "user clicked the toast and came back".
static FOCUS_OPEN: Mutex<Option<String>> = Mutex::new(None);

/// Whether the "dsh 有更新" toast has already been shown this process launch
/// (the manager reports update-status at boot and on demand — remind once).
static UPDATE_TOAST_SHOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The launcher page URL, captured at setup. On manager-down we navigate back
/// here so the page re-arms for the next dsh boot (restart) or shows the
/// error + retry (crash). The launcher's `server-url` listener only exists
/// while that page is loaded, so reconnection after a restart must be driven
/// by the shell, not the page.
static LAUNCHER_URL: Mutex<Option<String>> = Mutex::new(None);

/// The live dsh web root URL (current random port). Used by the navigation
/// guard to snap any user back/forward (or bfcache nav) away from stale ports
/// back to the currently-running dsh instance. Prevents the "back to initial
/// setup then refresh inaccessible" symptom after dsh web has cycled its port.
static LIVE_DSH_URL: Mutex<Option<String>> = Mutex::new(None);
/// 主窗口最近一次**真实加载完成**的 URL（on_page_load 触发即页面真的加载了，
/// 比 `window.url()` 可靠——后者在导航"空转"（URL 已变但 WebView 未渲染）时
/// 会误报已到达 dsh 页，导致导航兜底过早撒手 → 黑屏）。
static LAST_MAIN_LOADED: Mutex<Option<String>> = Mutex::new(None);
/// 页面"真正可用"信号：桥收到 client 的 /alive（= 页面 JS 已运行并回连）。
/// 只有这个能证明 webview 渲染完成；URL 层/on_page_load 都可能"空转"。
/// 每次 server-url 事件（新 dsh web 地址）时 reset，由导航兜底驱动重试。
static CLIENT_READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// 启动期孤儿清理（cleanup_stale_service_tree）是否已完成。它在后台线程
/// 跑 PowerShell 全进程扫描（冷启动实测 5-6 秒），必须在 setup 主线程之外
/// 执行，否则阻塞 WebView2 首帧 → 启动页前黑屏。boot 线程与 restart_server
/// 拉起新服务前都等待此标志，防止清理把刚拉起的 manager/web 树误杀。
static STARTUP_CLEANUP_DONE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// 陈旧 dsh 鉴权 cookie 的"启动清理已完成"标志。server-url 分支在 `emit`
/// 之前有界等待它（launcher 页自己也监听 server-url 并 location.href，必须
/// 保证"清理先于任何加载"，否则它会用脏 jar 加载 → 431）。
static AUTH_COOKIE_PRUNE_DONE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
/// janitor 线程的任务通道（单一后台线程串行处理；禁止每事件 spawn——乱序的
/// prune 会删掉新 authority 刚签发的 cookie，而那次导航成功后导航兜底会
/// `continue`、不自愈）。
static AUTH_COOKIE_JANITOR: std::sync::OnceLock<std::sync::mpsc::Sender<()>> =
    std::sync::OnceLock::new();
/// 最近一次上报的 dsh web origin（`host:port`）。authority 变化 = 新的 cookie
/// 命名空间，需要再清一次（同一 authority 的重复事件**不**清，否则会删掉页面
/// 正在使用的 cookie）。
static LAST_ANNOUNCED_ORIGIN: Mutex<Option<String>> = Mutex::new(None);

/// Deterministic 64-bit FNV-1a — used to derive a per-build-identity toast
/// activator CLSID without pulling in a hash/uuid crate.
#[cfg(target_os = "windows")]
fn fnv1a(seed: u64, data: &[u8]) -> u64 {
    let mut h = seed;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Toast activator CLSID for a build identity. The official identifier keeps
/// its long-standing stable GUID; any other identifier (e.g. the side-by-side
/// dev build `dsh.smoothly.desktop.dev`) gets a deterministic RFC-4122-shaped
/// GUID derived from it — two installs never clobber each other's toast
/// registration, and the value is stable across launches/upgrades.
#[cfg(target_os = "windows")]
fn toast_clsid(identifier: &str) -> String {
    if identifier == "dsh.smoothly.desktop" {
        return "{7C2F4B1A-9D3E-4A8F-B6C0-5E1D2A3B4C5D}".to_string();
    }
    let a = fnv1a(0xcbf2_9ce4_8422_2325, identifier.as_bytes());
    let b = fnv1a(0x9e37_79b9_7f4a_7c15, identifier.as_bytes());
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&a.to_le_bytes());
    bytes[8..].copy_from_slice(&b.to_le_bytes());
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // RFC 4122 version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    let hex: String = bytes.iter().map(|b| format!("{b:02X}")).collect();
    format!(
        "{{{}-{}-{}-{}-{}}}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Windows only: register a PROCESS-LEVEL toast activator. The WinRT `Activated`
/// event used by notify-rust only fires while the toast is visible on screen;
/// once it lands in the Action Center the system routes clicks to the app's
/// COM activator instead. Registering our exe as the activator (the two
/// registry keys DesktopNotificationManagerCompat::register_activator would
/// write — CLSID LocalServer32 + AppUserModelId CustomActivator) makes
/// Windows launch `dsh-desktop.exe -ToastActivated <args>` on ANY toast click,
/// screen or Action Center; the fresh instance is caught by
/// tauri-plugin-single-instance, which forwards the activation home and opens
/// the last notified session. No INotificationActivationCallback COM object
/// is needed — the relaunch IS the callback.
#[cfg(target_os = "windows")]
fn register_toast_activator(app_id: &str, product_name: &str) -> Result<(), String> {
    use std::process::Command;
    // Stable per-identity CLSID for our activator; only the registry hook that
    // makes Windows launch this exe on toast click.
    let clsid = toast_clsid(app_id);
    let exe = std::env::current_exe()
        .map_err(|e| format!("current_exe: {e}"))?
        .to_string_lossy()
        .to_string();
    // COM parses LocalServer32 as a command line: a path containing spaces
    // MUST be double-quoted, otherwise activation silently fails (the part
    // before the first space is treated as the executable).
    let exe_quoted = format!("\"{exe}\"");
    let run = |args: &[&str]| {
        // reg.exe is a console program: without CREATE_NO_WINDOW every write
        // flashes a cmd window on the user's desk.
        let mut cmd = Command::new("reg");
        no_console_window(&mut cmd);
        cmd.args(args).status()
    };
    // HKCU\Software\Classes\CLSID\{GUID}\LocalServer32  (default = quoted exe)
    let _ = run(&[
        "add",
        &format!(r"HKCU\Software\Classes\CLSID\{clsid}\LocalServer32"),
        "/ve",
        "/d",
        &exe_quoted,
        "/f",
    ])
    .map_err(|e| format!("reg add LocalServer32: {e}"))?;
    // HKCU\Software\Classes\AppUserModelId\<app_id>\CustomActivator  (= {GUID})
    let _ = run(&[
        "add",
        &format!(r"HKCU\Software\Classes\AppUserModelId\{app_id}"),
        "/ve",
        "/d",
        app_id,
        "/f",
    ])
    .map_err(|e| format!("reg add AUMID: {e}"))?;
    let _ = run(&[
        "add",
        &format!(r"HKCU\Software\Classes\AppUserModelId\{app_id}\CustomActivator"),
        "/ve",
        "/d",
        &clsid,
        "/f",
    ])
    .map_err(|e| format!("reg add CustomActivator: {e}"))?;
    ensure_shortcut_toast_activator(&clsid, product_name)?;
    Ok(())
}

/// Windows 11 resolves toast activation through the Start Menu shortcut's
/// `System.AppUserModel.ToastActivatorCLSID` property — the registry
/// CustomActivator keys alone are NOT enough (verified on 25H2: clicks were
/// silently dropped until this property was set). Set it (self-healing: runs
/// on every launch, so reinstall/shortcut-recreate is covered).
#[cfg(target_os = "windows")]
fn ensure_shortcut_toast_activator(clsid: &str, product_name: &str) -> Result<(), String> {
    use windows::core::{GUID, HSTRING, Interface, PWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemAlloc, CoUninitialize, CLSCTX_INPROC_SERVER,
        IPersistFile, STGM_READWRITE, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PROPVARIANT};
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::IShellLinkW;
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ToastActivatorCLSID;

    // Locate the NSIS-created Start Menu shortcut (name = productName; Windows
    // paths are case-insensitive, so both spellings hit the same file).
    let apdata = std::env::var("APPDATA").map_err(|e| format!("APPDATA: {e}"))?;
    let base = std::path::Path::new(&apdata)
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs");
    let mut lnk = None;
    // NSIS shortcut name = productName (Windows paths are case-insensitive,
    // so the lowercase-first-letter spelling hits the same file).
    let mut candidates = vec![format!("{product_name}.lnk")];
    if let Some(first) = product_name.chars().next() {
        let mut lower = product_name.to_string();
        lower.replace_range(..first.len_utf8(), &first.to_lowercase().to_string());
        candidates.push(lower);
    }
    for name in candidates {
        let p = base.join(name);
        if p.is_file() {
            lnk = Some(p);
            break;
        }
    }
    let lnk = lnk.ok_or_else(|| format!("start menu shortcut not found under {}", base.display()))?;
    let lnk_str = lnk.to_string_lossy().to_string();

    unsafe {
        // CRITICAL: this runs on a background thread — COM must be initialized
        // on this thread before touching ShellLink objects. Missing this was
        // the heap-corruption crash (0xc0000374) after the first successful
        // reg.exe registration.
        let _hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let result = (|| -> Result<(), String> {
            let clsid_shelllink = GUID::from_u128(0x00021401_0000_0000_c000_000000000046);
            let link: IShellLinkW = CoCreateInstance(&clsid_shelllink, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("CoCreate ShellLink: {e}"))?;
            let persist: IPersistFile = link.cast().map_err(|e| format!("cast IPersistFile: {e}"))?;
            persist
                .Load(&HSTRING::from(&lnk_str), STGM_READWRITE)
                .map_err(|e| format!("IShellLink Load: {e}"))?;
            let store: IPropertyStore = link.cast().map_err(|e| format!("cast IPropertyStore: {e}"))?;
            // The wide string must live in COM memory (CoTaskMemAlloc) — a
            // Rust heap pointer handed to IPropertyStore::SetValue corrupts the
            // heap when the property store copies/frees it.
            let mut wide: Vec<u16> = clsid.encode_utf16().chain(std::iter::once(0)).collect();
            let mem = CoTaskMemAlloc(wide.len() * 2) as *mut u16;
            if mem.is_null() {
                return Err("CoTaskMemAlloc failed".into());
            }
            std::ptr::copy_nonoverlapping(wide.as_mut_ptr(), mem, wide.len());
            let mut v = PROPVARIANT::default();
            (*v.Anonymous.Anonymous).vt = VT_LPWSTR;
            (*v.Anonymous.Anonymous).Anonymous.pwszVal = PWSTR(mem);
            let r = store
                .SetValue(&PKEY_AppUserModel_ToastActivatorCLSID, &v)
                .and_then(|_| store.Commit())
                .and_then(|_| persist.Save(&HSTRING::from(&lnk_str), true));
            let _ = PropVariantClear(&mut v); // free the COM string
            r.map_err(|e| format!("Set/Commit/Save ToastActivatorCLSID: {e}"))
        })();
        CoUninitialize();
        result
    }
}

/// Raise a native toast and record it. Shared by the event listener and the
/// HTTP bridge (the only delivery the dsh page can actually use — Tauri v2
/// does not inject `__TAURI__` into remote pages, tauri#11934).
/// Bring the main window to the user regardless of its current state:
/// hidden (tray) -> show; minimized -> unminimize; behind/置后 -> set_focus;
/// in front -> no-op. Windows restricts foreground-stealing from background
/// threads, so the topmost-toggle trick forces the OS to raise the window.
fn activate_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_skip_taskbar(false);
        let _ = w.show(); // no-op when already visible; reveals hidden windows
        if let Ok(true) = w.is_minimized() {
            let _ = w.unminimize();
        }
        let _ = w.set_focus();
        // Force foreground despite Windows' SetForegroundWindow restrictions:
        // briefly becoming topmost raises the window, then revert.
        let _ = w.set_always_on_top(true);
        let _ = w.set_always_on_top(false);
    }
}

fn show_toast(app: &AppHandle, title: String, body: String) {
    let data = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    log_line(&data, &format!("notification: {title} - {body}"));
    eprintln!("[dsh-desktop] notification: {title} - {body}");

    // Show via notify-rust DIRECTLY so we keep the NotificationHandle and can
    // listen for the in-process COM activation callback (tauri-winrt-
    // notification). tauri-plugin-notification's show() drops the handle, and
    // Windows toast clicks never relaunch/activate through the shell for this
    // app — the in-process activator is the ONLY reliable "toast clicked"
    // signal. On click: bring the window back (any state) and hand the last
    // notified session to the page via /pending-open.
    let clicked = |app: &AppHandle| {
        let last = LAST_SESSION.lock().unwrap().clone();
        *PENDING_OPEN.lock().unwrap() = last.clone();
        let data = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from("."));
        log_line(&data, &format!("toast-clicked pending-open={last:?}"));
        eprintln!("[dsh-desktop] toast-clicked pending-open={last:?}");
        activate_window(app);
    };

    let mut n = notify_rust::Notification::new();
    n.summary(&title);
    #[cfg(target_os = "windows")]
    n.app_id(app.config().identifier.as_str());
    if !body.is_empty() {
        n.body(&body);
    }
    match n.show() {
        Ok(handle) => {
            let app = app.clone();
            std::thread::spawn(move || {
                // wait_for_response 保留点击/消失的区分：Default/Action=点击（激活），
                // Closed=自动消失（忽略）——wait_for_action 会把无按钮 toast 的点击
                // 也折叠成 "__closed"。
                let app2 = app.clone();
                let _ = handle.wait_for_response(move |resp: &notify_rust::NotificationResponse| match resp {
                    notify_rust::NotificationResponse::Default
                    | notify_rust::NotificationResponse::Action(_) => clicked(&app2),
                    _ => {}
                });
            });
        }
        Err(e) => {
            // Fallback: tauri-plugin-notification (no click signal, but the
            // toast still appears).
            log_line(&data, &format!("notify-rust failed, plugin fallback: {e}"));
            use tauri_plugin_notification::NotificationExt;
            let mut b = app.notification().builder().title(title);
            if !body.is_empty() {
                b = b.body(body);
            }
            match b.show() {
                Ok(_) => {}
                Err(e2) => {
                    log_line(&data, &format!("toast failed: {e2}"));
                    eprintln!("[dsh-desktop] toast failed: {e2}");
                }
            }
        }
    }
}

// ── plugin management (P2: preinstalled bundles, default OFF) ────────────────
// The web profile manifest lives at <runtime>/dsh-home/profiles/web/package.json
// and its dsh.profile.bundles is the enable/disable switch. Preinstalled
// bundles are shell-shipped (resources/preinstalled -> <runtime>/node_modules,
// recorded in <runtime>/dsh.json) and are NEVER dependencies, so `dsh plugin`
// reconcile cannot touch them. Only names from the preinstalled list may be
// toggled through the bridge (a loopback CORS-open endpoint must not let a
// page enable arbitrary code).

/// The runtime dir (same path the manager receives as --runtime-dir).
fn runtime_dir(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("runtime")
}

/// App data dir helper (logging).
fn app_data_dir(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}

// ── 品牌统一数据迁移（legacy identifier → dsh.smoothly.desktop）────────────
// identifier 决定 %APPDATA%/<id>（runtime、dsh-home 会话/插件、proxy.json、
// 窗口状态等全部用户数据）。改 identifier 后，老版本已装用户的旧数据目录
// 不再被新版本读取——必须把旧目录整体迁移过来，否则"数据丢失"。
//
// 安全设计（绝不丢数据）：
//   1. 只迁移与当前身份对应的旧 identifier（正式迁 dev.dsh.desktop，
//      dev 迁 dev.dsh.desktop.dev），互不抢；
//   2. 只做「整目录 rename」：同卷内原子、秒级；node_modules 是相对符号链接
//      树（pnpm hoisted），整树一起移动相对链接关系保持不变；绝不逐文件
//      copy（会跟链放大并破坏链接结构）；
//   3. 新目录已存在 → 视为已有新数据/已迁移，跳过（新数据优先，旧目录保留）；
//   4. 迁移成功写 marker，防重复执行；
//   5. rename 失败（异常占用等）→ 记日志、本次不迁、旧数据原封不动，
//      下次启动再试——失败安全，宁可多启动一次也不冒覆盖/改链风险。
const LEGACY_IDENT_MIGRATIONS: &[(&str, &str)] = &[
    ("dsh.smoothly.desktop", "dev.dsh.desktop"),
    ("dsh.smoothly.desktop.dev", "dev.dsh.desktop.dev"),
];
const MIGRATION_MARKER: &str = ".dsh-migration-ok";

/// 单目录迁移核心（纯 Path 逻辑，可单测）。返回是否发生了迁移。
fn migrate_legacy_data_dir(old_dir: &std::path::Path, new_dir: &std::path::Path, mut log: impl FnMut(&str)) -> bool {
    if !old_dir.is_dir() {
        return false; // 无旧数据
    }
    if new_dir.join(MIGRATION_MARKER).exists() {
        return false; // 已迁移过
    }
    if new_dir.exists() {
        // 目标已有内容且无标记：新数据优先，旧目录保留，永不覆盖。
        log("target app-data exists without migration marker — new data wins, legacy left in place");
        return false;
    }
    if let Some(p) = new_dir.parent() {
        if std::fs::create_dir_all(p).is_err() {
            return false;
        }
    }
    match std::fs::rename(old_dir, new_dir) {
        Ok(()) => {
            let _ = std::fs::write(new_dir.join(MIGRATION_MARKER), b"migrated\n");
            log(&format!(
                "migrated legacy app data: {} -> {}",
                old_dir.display(),
                new_dir.display()
            ));
            true
        }
        Err(e) => {
            log(&format!("legacy migration rename failed: {e} — old data intact, retry next launch"));
            false
        }
    }
}

/// 启动时执行品牌统一迁移：app data 与 WebView2 缓存（local data）都搬。
/// 必须在 start_server（manager 拉起 dsh）之前完成。
fn migrate_legacy_data(app: &AppHandle) {
    let ident = app.config().identifier.as_str();
    let Some(old_name) = LEGACY_IDENT_MIGRATIONS
        .iter()
        .find(|(n, _)| n == &ident)
        .map(|(_, o)| *o)
    else {
        return;
    };
    let new_dir = app_data_dir(app);
    let log_sink = new_dir.clone();
    let Some(base) = new_dir.parent() else { return };
    let old_dir = base.join(old_name);
    // 迁移是否会发生（镜像 migrate_legacy_data_dir 的早退条件：旧目录存在、
    // 新目录无迁移标记、新目录不存在）。只有"本次确实会迁移"才做迁移前
    // 备份——否则已迁移完成后每次启动都会复制一份空备份（2026-09-07 观察：
    // %LOCALAPPDATA%\dsh-backup 下已积累 20 个 migration-<ts> 空目录）。
    let will_migrate = old_dir.is_dir()
        && !new_dir.join(MIGRATION_MARKER).exists()
        && !new_dir.exists();
    // 备份优先：rename 之前先把旧 dsh-home 的关键数据复制到
    // %LOCALAPPDATA%\dsh-backup\migration-<ts>\（双保险——即使 rename 失败或
    // 后续任何意外，都有一份独立副本；备份失败仅记日志，不阻断迁移）。
    let old_home = old_dir.join("runtime").join("dsh-home");
    let backup_root = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| new_dir.join(BACKUP_ROOT_DIR_NAME))
        .join(BACKUP_ROOT_DIR_NAME);
    if will_migrate && old_home.is_dir() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let back_dir = backup_root.join(format!("migration-{ts}"));
        let mut log2 = |m: &str| {
            eprintln!("[dsh-desktop] data-migration backup: {m}");
            log_line(&log_sink, &format!("data-migration backup: {m}"));
        };
        match backup_home_data(&old_home, &back_dir, &mut log2) {
            Ok(()) => log2(&format!("saved to {}", back_dir.display())),
            Err(e) => log2(&format!("FAILED ({e})")),
        }
    }
    let moved = migrate_legacy_data_dir(&old_dir, &new_dir, |m| {
        eprintln!("[dsh-desktop] data-migration: {m}");
        log_line(&log_sink, &format!("data-migration: {m}"));
    });
    if moved {
        // 同卷 WebView2 缓存：一并搬移（非关键，失败仅记日志）。
        if let Ok(new_local) = app.path().app_local_data_dir() {
            let old_local = new_local.parent().map(|p| p.join(old_name));
            if let Some(old_local) = old_local {
                if old_local.is_dir() && !new_local.exists() {
                    if let Err(e) = std::fs::rename(&old_local, &new_local) {
                        eprintln!("[dsh-desktop] data-migration: local cache rename skipped: {e}");
                    }
                }
            }
        }
    }
}

// ── 旧版接管（legacy takeover）─────────────────────────────────────────────
// 0.3.x → 0.4.x 品牌统一后，旧安装（%LOCALAPPDATA%\dsh Desktop，旧 identifier
// dev.dsh.desktop）已无数据；但旧 exe/快捷方式可能残留——旧壳一旦被启动会
// 重建空 dev.dsh.desktop runtime（"数据全丢"假象，2026-09-02 实发）。
// 本段提供：检测（旧安装/运行中/快捷方式/空壳重建迹象）+ 清理（备份旧数据
// → 静默卸载 → 白名单快捷方式删除 → 空目录回收）+ 迁移前备份。
// 安全规则：路径严格白名单（%LOCALAPPDATA%\dsh Desktop 且含 uninstall.exe）；
// 快捷方式删除前校验 lnk 目标；%APPDATA% 数据目录永不删除，只检测与提示。
const LEGACY_INSTALL_DIR_NAME: &str = "dsh Desktop";
const LEGACY_SHORTCUT_NAME: &str = "DSH Desktop.lnk";
const BACKUP_ROOT_DIR_NAME: &str = "dsh-backup";

/// %LOCALAPPDATA%\dsh Desktop（且含 uninstall.exe）才算旧安装；白名单判定。
fn legacy_install_dir(local_data: &std::path::Path) -> Option<std::path::PathBuf> {
    let dir = local_data.join(LEGACY_INSTALL_DIR_NAME);
    if dir.join("uninstall.exe").is_file() {
        Some(dir)
    } else {
        None
    }
}

/// 两个已知快捷方式候选（桌面 + 开始菜单），存在才列出。
fn legacy_shortcut_candidates(home: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for base in [
        home.join("Desktop"),
        home.join("AppData").join("Roaming").join("Microsoft").join("Windows").join("Start Menu").join("Programs"),
    ] {
        let lnk = base.join(LEGACY_SHORTCUT_NAME);
        if lnk.is_file() {
            out.push(lnk);
        }
    }
    out
}

/// 跑一条 PowerShell 并取 stdout 非空行（Windows 专用；跨平台编译安全）。
/// CREATE_NO_WINDOW：powershell.exe 是控制台程序，不加会在启动页出现前/后
/// 闪一个黑命令窗（cleanup 后台扫描 + launcher checkLegacy 每次启动都会跑）。
pub(crate) fn powershell_lines(script: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("powershell.exe");
        no_console_window(&mut cmd);
        let out = cmd.args(["-NoProfile", "-Command", script]).output();
        if let Ok(out) = out {
            return String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
        }
    }
    #[cfg(not(windows))]
    let _ = script;
    Vec::new()
}

/// 路径是否位于 `base` 之下（**组件级**比较，不是字符串前缀）。
///
/// 为什么不能只用 `starts_with`：`C:\a\dsh Desktop-evil` 会被
/// `C:\a\dsh Desktop` 前缀命中（缺分隔符边界）；Windows 路径大小写不敏感而
/// 字符串比较敏感（`...\DSH Smoothly Desktop\...` 会漏判）。
///
/// 已知局限（A-2 方案记录在案，未在本轮处理）：
///   - `\\?\C:\...`（VerbatimDisk 前缀）与 `C:\...` 的 `Path::components()`
///     不相等 → 调用方需先经 [`simplify_path`] 去掉该前缀；
///   - 8.3 短名（`DSHDES~1`）与 junction/symlink 目标不在此判定范围；
///   - 不做 canonicalize（会触发 I/O，且目标可能不存在）。
#[cfg(windows)]
fn path_under(path: &std::path::Path, base: &std::path::Path) -> bool {
    use std::path::Component;
    fn norm(c: Component<'_>) -> String {
        // Windows 路径比较大小写不敏感；统一小写后逐段比。
        c.as_os_str().to_string_lossy().to_ascii_lowercase()
    }
    let p: Vec<String> = path.components().map(norm).collect();
    let b: Vec<String> = base.components().map(norm).collect();
    // 必须严格长于 base（相等不算"之下"），且前缀逐段相同。
    p.len() > b.len() && p[..b.len()] == b[..]
}

#[cfg(not(windows))]
fn path_under(path: &std::path::Path, base: &std::path::Path) -> bool {
    use std::path::Component;
    fn norm(c: Component<'_>) -> String {
        c.as_os_str().to_string_lossy().to_string()
    }
    let p: Vec<String> = path.components().map(norm).collect();
    let b: Vec<String> = base.components().map(norm).collect();
    p.len() > b.len() && p[..b.len()] == b[..]
}

/// 去掉 Windows 的 `\\?\` / `\\?\UNC\` 前缀（`current_exe()` 等系统 API 会带）。
/// `simplify_path` 已在别处用于同一目的（Node 模块加载器不认该前缀）；这里复用
/// 其思路，保证路径判定与其它路径处理口径一致。
fn strip_verbatim(p: &std::path::Path) -> std::path::PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        std::path::PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        std::path::PathBuf::from(rest.to_string())
    } else {
        p.to_path_buf()
    }
}

/// 旧版 dsh-desktop.exe 是否仍在运行（按可执行文件路径前缀精确匹配）。
///
/// ⚠️ 只用于检测/展示（`legacy_check_json.running`）；**绝不能**用它决定是否
/// 执行旧版卸载器 —— 那个卸载器按 **exe 名**（不含路径）静默 kill，路径前缀
/// 判定对它恒不成立（2026-09-09 事故：静默安装 dev 版时正式版被静默杀掉）。
fn legacy_process_running(legacy_dir: &std::path::Path) -> bool {
    let want = strip_verbatim(legacy_dir);
    let script = r#"Get-CimInstance Win32_Process -Filter "Name='dsh-desktop.exe'" | ForEach-Object { $_.ExecutablePath }"#;
    powershell_lines(script)
        .into_iter()
        .map(|p| std::path::PathBuf::from(p.replace('/', "\\")))
        .any(|p| path_under(&strip_verbatim(&p), &want))
}

/// 启动时清理本身份 runtime 的残留 node 树（孤儿防驻留）。
/// 壳被强杀/崩溃后，manager 与 dsh web 的 node 进程没有父死子清机制会残留
/// （多个 dsh web 并存干扰导航、占端口）。
///
/// 匹配精确性（防误杀/防漏杀，2026-09-07 审计加固）：
/// - 目标：node.exe 且 CommandLine 含"本身份 runtime 目录路径"
/// - 边界：runtime 路径后必须是 `\`（web: `runtime\node_modules\…`）、空白或
///   引号（manager: `--runtime-dir C:\…\runtime` 后跟空格/引号）或行尾。
///   子串匹配会把 `runtime-backup` / `runtime_old` / `runtime-extra` 等
///   相似路径误命中（实测确认），因此用正则前瞻排除字母数字以外的延续。
/// - 路径中的 `.` 等正则元字符用 [regex]::Escape 转义，防误匹配相似目录名。
/// - CommandLine 为 null 的进程不匹配（不误杀；此类进程为初始化中的极短命
///   进程，漏杀无实质影响）。
/// - dev/正式各自只清自己（runtime 路径含 identifier，天然隔离）。
/// - 幂等：正常退出后无残留，扫描为空操作。taskkill /T /F 连树清理。
#[cfg(windows)]
fn cleanup_stale_service_tree(app: &AppHandle) {
    let runtime_dir = runtime_dir(app); // <app_data>/runtime
    let marker = runtime_dir.to_string_lossy().replace('/', "\\");
    // 匹配逻辑与取证共用 manager_guard::orphan_service_node_pids（正则前瞻：
    // runtime 路径后随 \ / 引号 / 空白 / 行尾，排除 runtime-backup、runtime_old
    // 等子串延续）。
    let stale: Vec<String> = manager_guard::orphan_service_node_pids(&marker)
        .into_iter()
        .map(|o| o.pid)
        .collect();
    if stale.is_empty() {
        return;
    }
    let data = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    for pid in &stale {
        // 壳是 dsh-desktop.exe 而非 node.exe，自身永不会被命中；此循环仅
        // 处理扫描到的残留 node。防御性跳过自身 PID（成本可忽略）。
        if let Ok(me) = std::process::id().to_string().parse::<u32>() {
            if pid.parse::<u32>().ok() == Some(me) {
                continue;
            }
        }
        let mut kill = std::process::Command::new("taskkill");
        no_console_window(&mut kill);
        let _ = kill.args(["/PID", pid, "/T", "/F"]).output();
        log_line(&data, &format!("stale service node {pid} killed (startup cleanup)"));
    }
}

/// 等待启动期孤儿清理完成（最多 20 秒，超时继续——清理挂死不应阻塞启动）。
/// 任何 start_server 路径（首启/托盘重启/launcher 重试）都在拉起新服务树
/// 前调用，防止后台 cleanup 线程把刚拉起的 manager/web 误杀。
fn wait_for_startup_cleanup() {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while !STARTUP_CLEANUP_DONE.load(std::sync::atomic::Ordering::SeqCst) {
        if std::time::Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// 读取 .lnk 的目标路径（Windows COM，WScript.Shell）。
fn shortcut_target(lnk: &std::path::Path) -> Option<std::path::PathBuf> {
    let l = lnk.to_string_lossy().replace('\'', "''");
    let script = format!(
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{l}');Write-Output $s.TargetPath"
    );
    powershell_lines(&script).into_iter().next().map(std::path::PathBuf::from)
}

/// 快捷方式是否指向旧安装目录（校验通过才删除，防误删同名 lnk）。
///
/// 用组件级 `path_under` 而非字符串前缀：后者会把 `dsh Desktop-evil` 判为命中，
/// 也会因大小写差异漏判（本机实测 lnk target 存创建时的真实大小写）。
fn should_delete_shortcut(lnk: &std::path::Path, legacy_dir: &std::path::Path) -> bool {
    let want = strip_verbatim(legacy_dir);
    shortcut_target(lnk)
        .map(|t| {
            let target = std::path::PathBuf::from(t.to_string_lossy().replace('/', "\\"));
            path_under(&strip_verbatim(&target), &want)
        })
        .unwrap_or(false)
}

/// dsh-home 中应备份的关键数据（跳过 node_modules 等可重建的大目录）。
fn backup_entries(home: &std::path::Path) -> Vec<(String, std::path::PathBuf)> {
    let mut out = Vec::new();
    for name in ["sessions", "storages"] {
        let p = home.join(name);
        if p.is_dir() {
            out.push((name.to_string(), p));
        }
    }
    for name in [
        "settings.yaml",
        "settings.yaml.bak-anyrouter-1m",
        "settings.yaml.bak-capture-dsh",
        ".credentials.yaml",
        ".anonymous-user-id",
    ] {
        let p = home.join(name);
        if p.is_file() {
            out.push((name.to_string(), p));
        }
    }
    let web = home.join("profiles").join("web");
    for name in ["cordis.yml", "cordis.patch.yml", "package.json", "pnpm-workspace.yaml"] {
        let p = web.join(name);
        if p.is_file() {
            out.push((format!("profiles/web/{name}"), p));
        }
    }
    out
}

fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&from, &to)?;
        } else if ty.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// 复制 dsh-home 关键数据到备份目录（复制不移动：原数据不动；单文件失败仅记日志）。
fn backup_home_data(home: &std::path::Path, back_dir: &std::path::Path, log: &mut dyn FnMut(&str)) -> Result<(), String> {
    for (rel, src) in backup_entries(home) {
        let dst = back_dir.join(&rel);
        if let Some(parent) = dst.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let r = if src.is_dir() {
            copy_dir_all(&src, &dst)
        } else {
            std::fs::copy(&src, &dst).map(|_| ())
        };
        if let Err(e) = r {
            log(&format!("backup skip {rel}: {e}"));
        }
    }
    Ok(())
}

/// 当前用户主目录（Windows 用 USERPROFILE；跨平台回退 HOME）。
fn user_home() -> std::path::PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
        .unwrap_or_default()
}

/// 检测结果（check_legacy_install command 与桥 GET /shell/legacy 共用）。
fn legacy_check_json(app: &AppHandle) -> serde_json::Value {
    let local = app.path().app_local_data_dir().unwrap_or_default();
    let home = user_home();
    let legacy = legacy_install_dir(&local);
    let running = legacy.as_ref().map(|d| legacy_process_running(d)).unwrap_or(false);
    let data_recreated = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|d| d.parent().map(|b| b.join("dev.dsh.desktop").is_dir()))
        .unwrap_or(false);
    serde_json::json!({
        "legacyDir": legacy.as_ref().map(|d| d.to_string_lossy().to_string()),
        "running": running,
        "shortcuts": legacy_shortcut_candidates(&home).iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>(),
        "dataRecreated": data_recreated,
        "canCleanup": legacy.as_ref().map(|_| !running).unwrap_or(false),
        "backupRoot": local.join(BACKUP_ROOT_DIR_NAME).to_string_lossy().to_string(),
    })
}

/// 清理动作（cleanup_legacy_install command 与桥 POST /shell/legacy-cleanup 共用）。
///
/// ⚠️ 绝不执行旧版卸载器（2026-09-09 事故）：旧版卸载器（0.3.9）的 Section
/// Uninstall 首句是 `CheckIfAppIsRunning "dsh-desktop.exe"`，静默模式直接
/// TerminateProcess **按 exe 名匹配的所有进程**（不看路径）。壳自身就是
/// dsh-desktop.exe（dev 版是 dsh-desktop-dev.exe），所以：
///   - 正式版壳执行它 = 杀掉自己（随后 manager/dsh web 变孤儿进程）；
///   - dev 版壳执行它 = 杀掉用户正在用的正式版，还会回报"清理完成"。
///
/// 因此这里只做无副作用的残留清理（孤儿卸载器 / 快捷方式 / 空目录）；旧版主
/// 程序仍在时拒绝清理并让用户手动卸载。`legacy_process_running` 的路径前缀判定
/// **不能**用作"能否执行卸载器"的门禁——危害是按 exe 名匹配的。
fn legacy_cleanup_json(app: &AppHandle) -> serde_json::Value {
    let data = app.path().app_data_dir().unwrap_or_default();
    let local = app.path().app_local_data_dir().unwrap_or_default();
    let mut log = |m: &str| {
        eprintln!("[dsh-desktop] legacy-cleanup: {m}");
        log_line(&data, &format!("legacy-cleanup: {m}"));
    };
    let Some(legacy) = legacy_install_dir(&local) else {
        return serde_json::json!({ "ok": false, "reason": "no-legacy", "removedUninstaller": false, "removedDir": false, "removedShortcuts": 0 });
    };
    // 旧版主程序仍在：它的卸载器按 exe 名静默 kill（含壳自身 / 正在跑的正式版），
    // 绝不能执行；改由用户手动卸载。
    if legacy.join("dsh-desktop.exe").is_file() {
        log("legacy main exe present — refusing to run its uninstaller (kills same-named exe)");
        return serde_json::json!({ "ok": false, "reason": "legacy-app-present", "removedUninstaller": false, "removedDir": false, "removedShortcuts": 0 });
    }
    // 1) 旧数据目录若已被旧壳重建（空壳产物），先备份其关键数据（纯保险，大概率空）。
    let old_home = data.parent().map(|b| b.join("dev.dsh.desktop").join("runtime").join("dsh-home"));
    if let Some(old_home) = old_home {
        if old_home.is_dir() {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let back = local.join(BACKUP_ROOT_DIR_NAME).join(format!("cleanup-{ts}"));
            let _ = backup_home_data(&old_home, &back, &mut log);
        }
    }
    // 2) 删除孤儿卸载器：旧版主程序已不在（上面已确认），它没有任何用途，留着
    //    只会让下次安装（或用户点 ARP 里的旧条目）重跑"按 exe 名杀进程"的危险路径。
    let uninstaller = legacy.join("uninstall.exe");
    let removed_uninstaller = std::fs::remove_file(&uninstaller).is_ok();
    log(&format!(
        "orphan uninstaller {}: {}",
        if removed_uninstaller { "removed" } else { "remove failed" },
        uninstaller.display()
    ));
    // 3) 快捷方式删除（target 校验通过才删）。
    let home = user_home();
    let mut removed = 0usize;
    for lnk in legacy_shortcut_candidates(&home) {
        if should_delete_shortcut(&lnk, &legacy) {
            match std::fs::remove_file(&lnk) {
                Ok(()) => {
                    removed += 1;
                    log(&format!("removed shortcut {}", lnk.display()));
                }
                Err(e) => log(&format!("shortcut remove failed {}: {e}", lnk.display())),
            }
        } else {
            log(&format!("shortcut skipped (target mismatch) {}", lnk.display()));
        }
    }
    // 4) 旧目录回收：仅当已空（卸载器清理后）；非空保留现场不递归删除。
    //    回收前额外确认它**不是** reparse point（junction/symlink）：若旧目录被
    //    替换成指向别处的链接，`remove_dir` 会删掉链接本身（Windows 语义下不进
    //    目标树），但保留该判定能防住"链接被后续工具跟随"的连锁误删。
    let is_reparse = std::fs::symlink_metadata(&legacy)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    if is_reparse {
        log("legacy install dir is a reparse point — keeping it in place (not removing)");
    }
    let emptied = !is_reparse
        && std::fs::read_dir(&legacy)
            .map(|mut d| d.next().is_none())
            .unwrap_or(false)
        && std::fs::remove_dir(&legacy).is_ok();
    if emptied {
        log(&format!("legacy install dir removed: {}", legacy.display()));
    }
    serde_json::json!({
        "ok": true,
        "removedUninstaller": removed_uninstaller,
        "removedDir": emptied,
        "removedShortcuts": removed,
    })
}

#[tauri::command]
fn check_legacy_install(app: AppHandle) -> serde_json::Value {
    legacy_check_json(&app)
}

#[tauri::command]
fn cleanup_legacy_install(app: AppHandle) -> serde_json::Value {
    legacy_cleanup_json(&app)
}

/// 缓存清理（A-3 L1）的**白名单**：只清可重建的缓存，绝不碰会话/证据。
///
/// 实测（2026-09-17，正式版真实数据）：`node_modules` 257MB、`.pnpm-store` 620MB、
/// `reports` 1381MB（其中 1381MB 是**最新**的 hang dump）、`dsh-home` 75MB。
/// 因此：
///   - `.pnpm-store` **保留**——暖 store 重建约 6s，删了要冷装（需联网、数分钟）；
///   - `reports` **保留**——它是崩溃/挂起取证目录，可能正是排障要的证据；
///     仅清理其中**超过保留份数**的历史 dump（复用 web_dump::prune_dumps）；
///   - `dsh-home` **保留**——会话、设置、凭据；
///   - 只删 `node_modules`（可重建；删除后首次启动需联网重装，UI 必须事先告知）。
///
/// 返回结构含逐项结果与失败项，UI 据此如实展示（不假成功）。
///
/// **前置：先停服务**（方案 A-3 L1 要求）。dsh 进程持有 node_modules 里的文件
/// （原生模块尤其），运行中删除会失败或留下半删的依赖树；这里先 stop_child 并等
/// 进程退出，再做删除。清理与 `restart_server` 的竞争由调用方的 UI 顺序保证
/// （弹窗内同步等待结果），删除失败会如实进入 blocked 列表而非假成功。
fn cache_cleanup_json(app: &AppHandle) -> serde_json::Value {
    let data = app.path().app_data_dir().unwrap_or_default();
    let log = |m: &str| {
        eprintln!("[dsh-desktop] cache-cleanup: {m}");
        log_line(&data, &format!("cache-cleanup: {m}"));
    };
    // 1) 先停服务：node_modules 里的原生模块被运行中的 dsh 持有，运行中删除会
    //    失败或留下半删状态。stop_child 内部会 try_wait + taskkill 整棵树。
    log("stopping dsh service before cache cleanup");
    stop_child(&app.state::<ServerState>());
    std::thread::sleep(std::time::Duration::from_millis(500));

    let runtime = data.join("runtime");
    let node_modules = runtime.join("node_modules");
    let reports = runtime.join("reports");

    // 2) 历史 dump：只保留最新 HANG_DUMP_KEEP 份（prune_dumps 已按名字排序保留尾部）。
    let pruned = web_dump::prune_dumps(&reports, "dshweb-hang-", HANG_DUMP_KEEP);
    log(&format!("pruned {pruned} old hang dump(s)"));

    // 3) node_modules：可重建。删除失败（被占用）如实上报，不假装成功。
    let mut removed_node_modules = false;
    let mut blocked: Vec<String> = Vec::new();
    if node_modules.is_dir() {
        match std::fs::remove_dir_all(&node_modules) {
            Ok(()) => {
                removed_node_modules = true;
                log("removed runtime/node_modules (will be reinstalled on next start)");
            }
            Err(e) => {
                log(&format!("could not remove runtime/node_modules: {e}"));
                blocked.push("runtime/node_modules".to_string());
            }
        }
    }

    serde_json::json!({
        "ok": blocked.is_empty(),
        "prunedDumps": pruned,
        "removedNodeModules": removed_node_modules,
        "blocked": blocked,
        // 明确告知调用方：清理后首次启动需要联网重装依赖。
        "needsNetworkOnNextStart": removed_node_modules,
        // 保留项（供 UI 如实展示"什么没被删"）
        "kept": ["runtime/dsh-home (sessions, settings, credentials)",
                 "runtime/.pnpm-store (warm rebuild)",
                 "runtime/reports (latest evidence)",
                 "runtime/proxy.json", "dsh.json"],
    })
}

#[tauri::command]
fn cleanup_caches(app: AppHandle) -> serde_json::Value {
    cache_cleanup_json(&app)
}

#[cfg(test)]
mod cookie_tests {
    use super::is_stale_auth_cookie;

    #[test]
    fn matches_only_dsh_auth_cookies_on_loopback_hosts() {
        // 命中：dsh 自己签发 + 回环 host（容忍前导点、大小写、空白、::1）
        for (name, domain) in [
            ("dsh-auth-abc", "127.0.0.1"),
            ("dsh-auth-abc", ".127.0.0.1"),
            ("dsh-auth-abc", "LOCALHOST"),
            ("dsh-auth-abc", " ::1 "),
            ("dsh-auth-kWr-QG6iCVLDYcRuGSs54jAs500", "127.0.0.1"),
        ] {
            assert!(is_stale_auth_cookie(name, domain), "{name} / {domain} 应命中");
        }
        // 不命中：别的 cookie、别的 host、空 domain、前缀不完整
        for (name, domain) in [
            ("session", "127.0.0.1"),
            ("dsh-authx", "127.0.0.1"),
            ("x-dsh-auth-abc", "127.0.0.1"),
            ("dsh-auth-abc", "evil.com"),
            ("dsh-auth-abc", "127.0.0.1.evil.com"),
            ("dsh-auth-abc", ""),
            ("", "127.0.0.1"),
        ] {
            assert!(!is_stale_auth_cookie(name, domain), "{name} / {domain} 不应命中");
        }
    }
}

#[cfg(test)]
mod close_confirm_tests {
    use super::close_needs_confirmation;

    #[test]
    fn first_hide_asks_once_and_linux_never_asks() {
        // 未确认过 → 问；已确认 → 不再问
        assert!(close_needs_confirmation(false, false));
        assert!(!close_needs_confirmation(true, false));
        // Linux 退化为最小化（没有托盘），永不确认
        assert!(!close_needs_confirmation(false, true));
        assert!(!close_needs_confirmation(true, true));
    }
}

#[cfg(test)]
mod danger_action_tests {
    use super::dangerous_bridge_action;

    #[test]
    fn covers_the_agreed_danger_set_and_nothing_else() {
        // D4 定稿的危险端点（+S8 的顶栏契约切换）
        let expected = [
            ("/shell/quit", "quit"),
            ("/restart", "restart"),
            ("/restart-dsh", "restart-dsh"),
            ("/update-dsh", "update-dsh"),
            ("/shell/disable-third-party-plugins", "disable-plugins"),
            ("/shell/cleanup-caches", "cleanup-caches"),
            ("/shell/legacy-cleanup", "legacy-cleanup"),
            ("/shell/dev-mode-toggle", "dev-mode"),
            ("/shell/gpu-accel-toggle", "gpu-accel"),
            ("/shell/titlebar-toggle", "titlebar-contract"),
            ("/shell/open-data-dir", "open-data"),
        ];
        for (path, id) in expected {
            let action = dangerous_bridge_action("POST", path).unwrap_or_else(|| panic!("{path} 未纳入危险表"));
            assert_eq!(action.id, id, "{path}");
            assert!(!action.title.is_empty() && !action.detail.is_empty(), "{path} 文案不能为空");
        }
        // 非危险端点与只读方法一律不拦
        for path in ["/window/state", "/window/drag", "/alive", "/log", "/notify", "/pending-open", "/shell/state", "/shell/status", "/devtools"] {
            assert!(dangerous_bridge_action("POST", path).is_none(), "{path} 不应被拦");
            assert!(dangerous_bridge_action("GET", path).is_none(), "GET {path} 不应被拦");
        }
        for path in ["/shell/quit", "/restart", "/update-dsh"] {
            assert!(dangerous_bridge_action("GET", path).is_none(), "GET {path} 不是执行路径");
        }
    }
}

#[cfg(test)]
mod bridge_guard_tests {
    use super::{bridge_cors_headers, bridge_origin_allowed, bridge_request_decision};

    const PORT: u16 = 41234;

    #[test]
    fn host_must_match_the_live_bridge_port() {
        assert!(bridge_request_decision("GET", Some("127.0.0.1:41234"), None, false, PORT).is_ok());
        assert!(bridge_request_decision("GET", Some("localhost:41234"), None, false, PORT).is_ok());
        // 端口不符 / 别的 host / 缺 Host —— 全部拒绝（DNS rebinding 的第一道门）
        for host in [Some("127.0.0.1:1"), Some("evil.com:41234"), Some("127.0.0.1"), None, Some("")] {
            assert_eq!(
                bridge_request_decision("GET", host, None, false, PORT),
                Err("bad-host"),
                "host={host:?} 应被拒"
            );
        }
    }

    #[test]
    fn origin_is_whitelisted_and_absent_origin_is_allowed() {
        // 白名单：本地页两种形态 + 回环页（端口任意）
        for origin in [
            "tauri://localhost",
            "http://tauri.localhost",
            "http://127.0.0.1:19387",
            "http://localhost:5",
        ] {
            assert!(bridge_origin_allowed(origin), "{origin} 应在白名单");
            assert!(bridge_request_decision("GET", Some("127.0.0.1:41234"), Some(origin), false, PORT).is_ok());
        }
        // 非白名单：外部站点 / 只差一个字符的伪装 host / https
        for origin in ["https://evil.com", "http://127.0.0.1.evil.com", "http://localhost.evil.com", "https://127.0.0.1:1"] {
            assert!(!bridge_origin_allowed(origin), "{origin} 不应被放行");
            assert_eq!(
                bridge_request_decision("GET", Some("127.0.0.1:41234"), Some(origin), false, PORT),
                Err("bad-origin")
            );
        }
        // 无 Origin（非浏览器调用方）放行
        assert!(bridge_request_decision("GET", Some("127.0.0.1:41234"), None, false, PORT).is_ok());
    }

    #[test]
    fn mutating_methods_need_the_shell_header() {
        for method in ["POST", "PUT", "DELETE", "PATCH"] {
            assert_eq!(
                bridge_request_decision(method, Some("127.0.0.1:41234"), None, false, PORT),
                Err("missing-shell-header"),
                "{method} 缺头应被拒"
            );
            assert!(bridge_request_decision(method, Some("127.0.0.1:41234"), None, true, PORT).is_ok());
        }
        // GET/HEAD/OPTIONS 不需要（预检不带自定义头；GET 只读）
        for method in ["GET", "HEAD", "OPTIONS"] {
            assert!(bridge_request_decision(method, Some("127.0.0.1:41234"), None, false, PORT).is_ok());
        }
    }

    #[test]
    fn cors_headers_echo_only_whitelisted_origins() {
        let ok = bridge_cors_headers(Some("http://127.0.0.1:19387"));
        assert!(ok.contains("Access-Control-Allow-Origin: http://127.0.0.1:19387"), "{ok}");
        assert!(ok.contains("x-dsh-shell"), "预检必须放行自定义头，否则壳自身动作全被挡死: {ok}");
        assert!(!ok.contains("Access-Control-Allow-Origin: *"), "不再无条件通配");
        assert_eq!(bridge_cors_headers(Some("https://evil.com")), "");
        assert_eq!(bridge_cors_headers(None), "");
    }
}

#[cfg(test)]
mod nav_fallback_tests {
    use super::{nav_fallback_interval_secs, NAV_FALLBACK_MAX_ATTEMPTS};

    #[test]
    fn backoff_keeps_fast_retries_first_then_caps() {
        // 前 3 次仍是 3s（黑屏修复依赖的快速回路）
        assert_eq!(nav_fallback_interval_secs(0), 3);
        assert_eq!(nav_fallback_interval_secs(2), 3);
        // 之后指数退避并封顶 30s
        assert_eq!(nav_fallback_interval_secs(3), 6);
        assert_eq!(nav_fallback_interval_secs(4), 12);
        assert_eq!(nav_fallback_interval_secs(5), 24);
        assert_eq!(nav_fallback_interval_secs(6), 30);
        assert_eq!(nav_fallback_interval_secs(NAV_FALLBACK_MAX_ATTEMPTS), 30);
        assert_eq!(nav_fallback_interval_secs(u32::MAX), 30, "no overflow at the cap");
    }
}

#[cfg(test)]
mod migration_tests {
    use super::*;

    fn tmp_base(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("dsh-mig-{tag}-{}", std::process::id()))
    }

    #[test]
    fn migrates_legacy_directory_and_is_idempotent() {
        let base = tmp_base("ok");
        let _ = std::fs::remove_dir_all(&base);
        let old = base.join("dev.dsh.desktop");
        let new = base.join("dsh.smoothly.desktop");
        std::fs::create_dir_all(old.join("runtime/dsh-home")).unwrap();
        std::fs::write(old.join("runtime/dsh-home/hello.txt"), "x").unwrap();

        let moved = migrate_legacy_data_dir(&old, &new, |_| {});
        assert!(moved, "legacy dir should migrate");
        assert!(new.join("runtime/dsh-home/hello.txt").is_file(), "data present at new location");
        assert!(new.join(MIGRATION_MARKER).is_file(), "marker written");
        assert!(!old.exists(), "legacy dir moved away");

        // 幂等：旧目录已不在 → 第二次 noop
        let moved2 = migrate_legacy_data_dir(&old, &new, |_| {});
        assert!(!moved2);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn new_data_wins_when_target_exists() {
        let base = tmp_base("skip");
        let _ = std::fs::remove_dir_all(&base);
        let old = base.join("dev.dsh.desktop");
        let new = base.join("dsh.smoothly.desktop");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(new.join("runtime")).unwrap();
        std::fs::write(new.join("runtime/keep.txt"), "keep").unwrap();

        let moved = migrate_legacy_data_dir(&old, &new, |_| {});
        assert!(!moved, "must not overwrite existing (new) data");
        assert!(old.exists(), "legacy dir untouched");
        assert!(new.join("runtime/keep.txt").is_file(), "new data kept");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn noop_without_legacy() {
        let base = tmp_base("none");
        let _ = std::fs::remove_dir_all(&base);
        let old = base.join("dev.dsh.desktop");
        let new = base.join("dsh.smoothly.desktop");
        let moved = migrate_legacy_data_dir(&old, &new, |_| {});
        assert!(!moved);
        assert!(!new.exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn legacy_dir_requires_exact_name_and_uninstaller() {
        let base = tmp_base("legacy-dir");
        let _ = std::fs::remove_dir_all(&base);
        let local = base.join("local");
        // 正确名字但无 uninstaller → 不识别
        let _ = std::fs::create_dir_all(local.join("dsh Desktop"));
        assert!(legacy_install_dir(&local).is_none());
        // uninstaller 就位 → 识别
        std::fs::write(local.join("dsh Desktop").join("uninstall.exe"), b"x").unwrap();
        assert!(legacy_install_dir(&local).is_some());
        // 名字不同的目录（dev 版等）→ 永不作为识别对象（识别结果仍指向 dsh Desktop）
        let _ = std::fs::create_dir_all(local.join("DSH Smoothly Desktop Dev"));
        std::fs::write(local.join("DSH Smoothly Desktop Dev").join("uninstall.exe"), b"x").unwrap();
        let got = legacy_install_dir(&local);
        assert_eq!(
            got.as_ref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string()),
            Some(LEGACY_INSTALL_DIR_NAME.to_string()),
            "dev 目录不得被识别为旧安装（白名单只认 dsh Desktop）"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn shortcut_candidates_only_existing_files() {
        let base = tmp_base("legacy-lnk");
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        let desktop = home.join("Desktop");
        std::fs::create_dir_all(&desktop).unwrap();
        std::fs::write(desktop.join(LEGACY_SHORTCUT_NAME), b"x").unwrap();
        let lnks = legacy_shortcut_candidates(&home);
        assert_eq!(lnks.len(), 1, "只应列出存在的 lnk（桌面）");
        assert_eq!(lnks[0].file_name().unwrap().to_string_lossy(), LEGACY_SHORTCUT_NAME);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn backup_entries_collects_key_data_and_skips_node_modules() {
        let base = tmp_base("legacy-backup");
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("dsh-home");
        std::fs::create_dir_all(home.join("sessions/ws-a")).unwrap();
        std::fs::write(home.join("sessions/ws-a/x.jsonl.zstd"), b"a").unwrap();
        std::fs::write(home.join("settings.yaml"), b"s").unwrap();
        std::fs::create_dir_all(home.join("profiles/web/node_modules")).unwrap();
        std::fs::write(home.join("profiles/web/node_modules/big.bin"), b"big").unwrap();
        std::fs::write(home.join("profiles/web/cordis.yml"), b"c").unwrap();
        let entries = backup_entries(&home);
        let rels: Vec<&str> = entries.iter().map(|(r, _)| r.as_str()).collect();
        assert!(rels.contains(&"sessions"), "会话目录必须备份");
        assert!(rels.contains(&"settings.yaml"), "模型配置必须备份");
        assert!(rels.contains(&"profiles/web/cordis.yml"), "web profile 配置必须备份");
        assert!(!rels.iter().any(|r| r.contains("node_modules")), "node_modules 不得备份");
        // 实际复制验证
        let back = base.join("backup");
        let mut log_calls = Vec::new();
        let mut log = |m: &str| log_calls.push(m.to_string());
        backup_home_data(&home, &back, &mut log).unwrap();
        assert!(back.join("sessions/ws-a/x.jsonl.zstd").is_file());
        assert!(back.join("settings.yaml").is_file());
        assert!(back.join("profiles/web/cordis.yml").is_file());
        assert!(!back.join("profiles/web/node_modules").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    // Windows 路径语义测试：断言盘符、反斜杠分隔、大小写不敏感。
    // **必须 cfg(windows)**：在 Linux 上 `Path::components()` 把 `C:\Users\u\...`
    // 当作**单个组件**（反斜杠不是分隔符），这些断言会失败——2026-09-19 CI 实测
    // （ubuntu 的 check job 跑 cargo test --lib 时红）。Windows 侧由 windows job
    // 的 cargo test 覆盖（G-2 加的步骤）。
    #[cfg(windows)]
    #[test]
    fn path_under_uses_component_boundaries_not_string_prefix() {
        let base = std::path::Path::new(r"C:\Users\u\AppData\Local\dsh Desktop");
        // 正常命中：真正的子路径
        assert!(path_under(
            std::path::Path::new(r"C:\Users\u\AppData\Local\dsh Desktop\dsh-desktop.exe"),
            base
        ));
        // 边界：相似名字不得命中（字符串前缀会误判为命中）
        assert!(!path_under(
            std::path::Path::new(r"C:\Users\u\AppData\Local\dsh Desktop-evil\x.exe"),
            base
        ));
        // 大小写不敏感（Windows 语义）：字符串比较会漏判
        assert!(path_under(
            std::path::Path::new(r"C:\Users\u\AppData\Local\DSH DESKTOP\x.exe"),
            base
        ));
        // 不同目录不得命中
        assert!(!path_under(
            std::path::Path::new(r"C:\Users\u\AppData\Local\DSH Smoothly Desktop\dsh-desktop.exe"),
            base
        ));
        // 相等不算"之下"（避免把 base 自身当子项删除）
        assert!(!path_under(base, base));
        // 父路径不得命中
        assert!(!path_under(
            std::path::Path::new(r"C:\Users\u\AppData\Local"),
            base
        ));
    }

    #[test]
    fn strip_verbatim_removes_windows_prefix() {
        // current_exe() 等 API 会返回 \\?\ 前缀（仓库里 simplify_path 就是为此存在）
        assert_eq!(
            strip_verbatim(std::path::Path::new(r"\\?\C:\Users\u\AppData\Local\dsh Desktop")),
            std::path::PathBuf::from(r"C:\Users\u\AppData\Local\dsh Desktop")
        );
        assert_eq!(
            strip_verbatim(std::path::Path::new(r"\\?\UNC\server\share\x")),
            std::path::PathBuf::from(r"\\server\share\x")
        );
        // 无前缀时原样返回
        assert_eq!(
            strip_verbatim(std::path::Path::new(r"C:\plain\path")),
            std::path::PathBuf::from(r"C:\plain\path")
        );
    }

    // 同样依赖 Windows 路径语义（`\\?\` + 盘符）：见上面 path_under 测试的说明。
    #[cfg(windows)]
    #[test]
    fn verbatim_prefixed_target_still_matches_after_stripping() {
        // 端到端语义：带 \\?\ 的进程路径经 strip 后仍能被 path_under 判中
        let base = std::path::Path::new(r"C:\Users\u\AppData\Local\dsh Desktop");
        let verbatim = std::path::Path::new(r"\\?\C:\Users\u\AppData\Local\dsh Desktop\dsh-desktop.exe");
        assert!(path_under(&strip_verbatim(verbatim), &strip_verbatim(base)));
    }
}

/// Absolute path of the web profile manifest.
fn profile_manifest_path(runtime: &std::path::Path) -> std::path::PathBuf {
    runtime
        .join("dsh-home")
        .join("profiles")
        .join("web")
        .join("package.json")
}

/// Absolute path of the proxy settings file (<runtime>/proxy.json).
fn proxy_config_path(runtime: &std::path::Path) -> std::path::PathBuf {
    runtime.join("proxy.json")
}

/// Read <runtime>/proxy.json, tolerant of a missing/corrupt file. The manager
/// keeps this file too (observed hosts), so both sides read-modify-write.
fn read_proxy_json(runtime: &std::path::Path) -> serde_json::Value {
    std::fs::read_to_string(proxy_config_path(runtime))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .unwrap_or_else(|| {
            serde_json::json!({
                "upstream": { "enabled": false, "host": "", "port": 0, "username": "", "password": "" },
                "proxiedHosts": [],
                "knownHosts": [],
            })
        })
}

/// Sanitize the upstream proxy object coming from the settings panel: only
/// known fields, only valid types/ports (a hostile page must not smuggle
/// extra keys into proxy.json).
fn sanitize_upstream(v: &serde_json::Value) -> serde_json::Value {
    let obj = v.as_object().cloned().unwrap_or_default();
    let get = |k: &str| obj.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    // Upstream protocol whitelist: http (default, legacy configs have no
    // field) / https / socks5. Anything else collapses to http.
    let protocol = match obj.get("protocol").and_then(|x| x.as_str()) {
        Some("https") => "https",
        Some("socks5") => "socks5",
        _ => "http",
    };
    serde_json::json!({
        "enabled": obj.get("enabled").and_then(|x| x.as_bool()).unwrap_or(false),
        "protocol": protocol,
        "host": get("host").trim().to_string(),
        "port": obj.get("port").and_then(|x| x.as_u64()).unwrap_or(0).min(u16::MAX as u64),
        "username": get("username"),
        "password": get("password"),
    })
}

/// Template bundles for the web profile (mirror of upstream PROFILE_TEMPLATES.web).
const WEB_PROFILE_TEMPLATE: &[&str] = &["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];

/// Read the web profile's dsh.profile.bundles, initializing the manifest with
/// the template when absent (idempotent, mirrors upstream initProfile).
fn web_profile_bundles(runtime: &std::path::Path) -> Vec<String> {
    let path = profile_manifest_path(runtime);
    if !path.exists() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let manifest = serde_json::json!({
            "name": "dsh-profile-web",
            "private": true,
            "dependencies": {},
            "dsh": { "profile": { "bundles": WEB_PROFILE_TEMPLATE } },
        });
        if let Ok(raw) = serde_json::to_string_pretty(&manifest) {
            let _ = std::fs::write(&path, raw + "\n");
        }
    }
    let raw = std::fs::read_to_string(&path).unwrap_or_default();
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
    value
        .get("dsh")
        .and_then(|d| d.get("profile"))
        .and_then(|p| p.get("bundles"))
        .and_then(|b| b.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_else(|| WEB_PROFILE_TEMPLATE.iter().map(|s| s.to_string()).collect())
}

/// Persist the bundles list, preserving every other manifest field.
fn write_web_profile_bundles(runtime: &std::path::Path, bundles: &[String]) -> Result<(), String> {
    let path = profile_manifest_path(runtime);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".into());
    let mut value: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or(serde_json::Value::Object(Default::default()));
    let obj = value
        .as_object_mut()
        .ok_or_else(|| "profile manifest must be an object".to_string())?;
    let dsh = obj
        .entry("dsh")
        .or_insert_with(|| serde_json::json!({}));
    let dsh_obj = dsh
        .as_object_mut()
        .ok_or_else(|| "dsh section must be an object".to_string())?;
    let profile = dsh_obj
        .entry("profile")
        .or_insert_with(|| serde_json::json!({}));
    let profile_obj = profile
        .as_object_mut()
        .ok_or_else(|| "dsh.profile must be an object".to_string())?;
    profile_obj.insert("bundles".into(), serde_json::json!(bundles));
    let out = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())? + "\n";
    std::fs::write(&path, out).map_err(|e| e.to_string())
}

/// Preinstalled plugin names from <runtime>/dsh.json.
fn preinstalled_names(runtime: &std::path::Path) -> Vec<String> {
    let raw = std::fs::read_to_string(runtime.join("dsh.json")).unwrap_or_default();
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
    value
        .get("preinstalled")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// `<runtime>/upgrade.json`：manager 在成功安装新版本后写的升级标记（S9）。
/// 启动成功（页面 POST /alive）时删除；启动失败时随 `manager-exit` 上报，
/// 供启动页做"上次升级 vA → vB 后启动失败"的归因与一键回退。
/// 读不到/损坏 → Null（只影响归因展示，不影响任何行为）。
fn upgrade_marker_json(app: &AppHandle) -> serde_json::Value {
    let path = runtime_dir(app).join("upgrade.json");
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .filter(|v| v.is_object())
        .unwrap_or(serde_json::Value::Null)
}

/// 启动成功即确认升级：删除标记（下一次失败才不会被误归因到这次升级）。
fn clear_upgrade_marker(app: &AppHandle) {
    let path = runtime_dir(app).join("upgrade.json");
    if path.exists() {
        match std::fs::remove_file(&path) {
            Ok(()) => log_line(&app_data_dir(app), "upgrade marker cleared (startup succeeded)"),
            Err(err) => log_line(&app_data_dir(app), &format!("upgrade marker clear failed: {err}")),
        }
    }
}

/// `<runtime>/dsh.json` 的 `preinstalledVersions` 映射（关于弹窗显示预装包版本用）。
/// 缺失/损坏时返回空对象 —— 只影响展示，不影响任何行为。
fn preinstalled_versions(runtime: &std::path::Path) -> serde_json::Value {
    let raw = std::fs::read_to_string(runtime.join("dsh.json")).unwrap_or_default();
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| v.get("preinstalledVersions").cloned())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}))
}

// ── dev mode (P3) ───────────────────────────────────────────────────────────
// dsh.json `devMode`: freezes dsh updates in the manager and unlocks the
// WebView2 devtools. Module-level HMR roots are NOT available in production
// builds (dsh hardcodes root: []), so dev iteration uses the fast restart-dsh
// loop + config hot-reload (on by default) + page refresh.

/// Whether dev mode is enabled in <runtime>/dsh.json.
fn dev_mode(runtime: &std::path::Path) -> bool {
    let raw = std::fs::read_to_string(runtime.join("dsh.json")).unwrap_or_default();
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| v.get("devMode").and_then(|d| d.as_bool()))
        .unwrap_or(false)
}

/// Flip dsh.json devMode, preserving every other field.
fn set_dev_mode(runtime: &std::path::Path, on: bool) -> Result<(), String> {
    let path = runtime.join("dsh.json");
    let mut value: serde_json::Value = if let Ok(raw) = std::fs::read_to_string(&path) {
        serde_json::from_str(&raw).unwrap_or(serde_json::Value::Object(Default::default()))
    } else {
        serde_json::Value::Object(Default::default())
    };
    if let Some(obj) = value.as_object_mut() {
        obj.insert("devMode".into(), serde_json::json!(on));
    }
    let out = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())? + "\n";
    std::fs::write(&path, out).map_err(|e| e.to_string())
}

// ── GPU 加速开关（P4）──────────────────────────────────────────────────────
// 2026-09-07 实测：用户级 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-gpu
// 让 WebView2 全部走软件渲染 → dsh 设置页（复杂 SPA）滚动/切换极卡；但该变量
// 当初是为排查"大模型执行中黑屏"而设，不能简单删。方案：开关收进壳——
// <runtime>/dsh.json `webview.gpu`（默认 true=开启），壳在窗口创建前按配置
// 注入进程级浏览器参数，用户可在壳菜单随时切换（排查黑屏时关，平时开）。
// 进程级 set_var 只影响本进程，不污染用户全局环境；WebView2 子进程继承。

/// Whether GPU acceleration is enabled (dsh.json `webview.gpu`, default true).
fn gpu_accel(runtime: &std::path::Path) -> bool {
    let raw = std::fs::read_to_string(runtime.join("dsh.json")).unwrap_or_default();
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| v.get("webview").and_then(|w| w.get("gpu").and_then(|g| g.as_bool())))
        .unwrap_or(true)
}

/// dsh.json `webview.titlebarContract`（S8，默认 false）：启用后壳不再自己推挤
/// 顶栏高度，而是设 `html[data-windows-titlebar]` + `--dsh-windows-titlebar-height`，
/// 让 Web 客户端自己预留标题栏、把侧栏开关搬进标题栏（官方 Electron 壳的做法）。
/// **默认关**：这是观感/遮挡问题，只能 Windows 实机判定（见 README runbook）。
fn titlebar_contract(runtime: &std::path::Path) -> bool {
    let raw = std::fs::read_to_string(runtime.join("dsh.json")).unwrap_or_default();
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| v.get("webview").and_then(|w| w.get("titlebarContract").and_then(|t| t.as_bool())))
        .unwrap_or(false)
}

/// Persist dsh.json webview.titlebarContract, preserving every other field.
fn set_titlebar_contract(runtime: &std::path::Path, on: bool) -> Result<(), String> {
    let path = runtime.join("dsh.json");
    let mut value: serde_json::Value = if let Ok(raw) = std::fs::read_to_string(&path) {
        serde_json::from_str(&raw).unwrap_or(serde_json::Value::Object(Default::default()))
    } else {
        serde_json::Value::Object(Default::default())
    };
    if let Some(obj) = value.as_object_mut() {
        let webview = obj.entry("webview").or_insert_with(|| serde_json::json!({}));
        if let Some(w) = webview.as_object_mut() {
            w.insert("titlebarContract".into(), serde_json::json!(on));
        }
    }
    std::fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?))
        .map_err(|e| e.to_string())
}

/// Persist dsh.json webview.gpu, preserving every other field.
fn set_gpu_accel(runtime: &std::path::Path, on: bool) -> Result<(), String> {
    let path = runtime.join("dsh.json");
    let mut value: serde_json::Value = if let Ok(raw) = std::fs::read_to_string(&path) {
        serde_json::from_str(&raw).unwrap_or(serde_json::Value::Object(Default::default()))
    } else {
        serde_json::Value::Object(Default::default())
    };
    if let Some(obj) = value.as_object_mut() {
        let webview = obj
            .entry("webview")
            .or_insert_with(|| serde_json::json!({}));
        if let Some(w) = webview.as_object_mut() {
            w.insert("gpu".into(), serde_json::json!(on));
        }
    }
    let out = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())? + "\n";
    std::fs::write(&path, out).map_err(|e| e.to_string())
}

/// Flip dsh.json webview.gpu, mirroring the tray checkbox, with a toast.
/// Shared by the tray and the bridge endpoint so the two surfaces never drift.
fn toggle_gpu_accel_impl(app: &AppHandle) -> Result<serde_json::Value, String> {
    let runtime = runtime_dir(app);
    let on = gpu_accel(&runtime);
    set_gpu_accel(&runtime, !on)?;
    if let Some(item) = app.state::<ServerState>().gpu_item.lock().unwrap().as_ref() {
        let _ = item.set_checked(!on);
    }
    show_toast(
        app,
        "GPU 加速".into(),
        if !on {
            "已开启（页面渲染流畅），重启应用后生效".into()
        } else {
            "已关闭（软件渲染，排查黑屏用），重启应用后生效".into()
        },
    );
    Ok(serde_json::json!({ "gpu": !on }))
}

/// 切换 dsh.json webview.titlebarContract（S8）。改完需刷新页面生效
///（下一次页面加载时注入前缀才会带上新值）。
fn toggle_titlebar_contract_impl(app: &AppHandle) -> Result<serde_json::Value, String> {
    let runtime = runtime_dir(app);
    let on = titlebar_contract(&runtime);
    set_titlebar_contract(&runtime, !on)?;
    show_toast(
        app,
        "Windows 顶栏契约".into(),
        if !on {
            "已开启（顶栏交给 Web 客户端布局）：刷新页面后生效；若观感异常请关掉".into()
        } else {
            "已关闭：恢复壳自绘顶栏 + 自己推挤高度".into()
        },
    );
    log_line(
        &app_data_dir(app),
        &format!("titlebar-contract toggled: {}", !on),
    );
    Ok(serde_json::json!({ "ok": true, "titlebarContract": !on }))
}


/// Minimal loopback HTTP server (std only): the injected client page POSTs
/// `/notify` (raise a toast) and `/alive` (loading canary). CORS-open, binds
/// 127.0.0.1:0 only — same attack surface as dsh web itself.
fn start_bridge(app: AppHandle) {
    std::thread::spawn(move || {
        let Ok(listener) = TcpListener::bind("127.0.0.1:0") else {
            return;
        };
        let Ok(port) = listener.local_addr().map(|a| a.port()) else {
            return;
        };
        BRIDGE_PORT.store(port, std::sync::atomic::Ordering::SeqCst);
        eprintln!("[dsh-desktop] bridge on 127.0.0.1:{port}");
        let data = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from("."));
        log_line(&data, &format!("bridge on 127.0.0.1:{port}"));
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let app = app.clone();
            std::thread::spawn(move || handle_bridge_conn(&mut stream, &app));
        }
    });
}

/// 桥请求的准入判定（**纯函数**，平台无关 → CI 的 ubuntu `check` job 会执行其单测；
/// 本机只能对 windows 目标做类型检查，跑不了二进制，所以判定逻辑必须与 Tauri 解耦）。
///
/// 规则（2026-09-09 审计定稿的分阶段方案阶段 0/3）：
/// - `Host` 必须是 `127.0.0.1:<bridge_port>` 或 `localhost:<bridge_port>`
///   （挡 DNS rebinding：攻击域名解析到 127.0.0.1 时浏览器仍会带自己的 Host）；
/// - `Origin` 缺省放行（非浏览器调用方：测试脚本、本机工具），
///   出现时必须在白名单内（`tauri://localhost` / `http://tauri.localhost` /
///   `http://127.0.0.1:*` / `http://localhost:*`）；
/// - 非 GET/HEAD/OPTIONS 必须带 `X-DSH-Shell: 1`：跨源**简单请求**无法携带自定义
///   头，恶意网页即使猜到端口也会先触发预检，而预检不放行该头。
fn bridge_request_decision(
    method: &str,
    host: Option<&str>,
    origin: Option<&str>,
    has_shell_header: bool,
    bridge_port: u16,
) -> Result<(), &'static str> {
    let host = host.unwrap_or("").trim();
    let host_ok = host.eq_ignore_ascii_case(&format!("127.0.0.1:{bridge_port}"))
        || host.eq_ignore_ascii_case(&format!("localhost:{bridge_port}"));
    if !host_ok {
        return Err("bad-host");
    }
    if let Some(origin) = origin.map(str::trim).filter(|o| !o.is_empty()) {
        if !bridge_origin_allowed(origin) {
            return Err("bad-origin");
        }
    }
    let needs_header = !matches!(method, "GET" | "HEAD" | "OPTIONS");
    if needs_header && !has_shell_header {
        return Err("missing-shell-header");
    }
    Ok(())
}

/// Origin 白名单（壳自身页面：本地页 `tauri://localhost` / `http://tauri.localhost`；
/// 远程 dsh 回环页 `http://127.0.0.1:<任意端口>` / `http://localhost:<任意端口>`）。
fn bridge_origin_allowed(origin: &str) -> bool {
    let o = origin.trim().to_ascii_lowercase();
    if o == "tauri://localhost" || o == "http://tauri.localhost" {
        return true;
    }
    let Some(rest) = o.strip_prefix("http://") else { return false };
    let host = rest.split('/').next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("");
    host == "127.0.0.1" || host == "localhost"
}

/// 桥的 CORS 响应头（阶段 3：不再无条件 `*`）。`None` = 不回 ACAO（浏览器读不到响应）。
fn bridge_cors_headers(origin: Option<&str>) -> String {
    match origin.map(str::trim).filter(|o| !o.is_empty()) {
        Some(o) if bridge_origin_allowed(o) => format!(
            "Access-Control-Allow-Origin: {o}\r\nAccess-Control-Allow-Methods: POST, GET, OPTIONS\r\nAccess-Control-Allow-Headers: content-type, x-dsh-shell\r\n"
        ),
        // 非浏览器调用方（无 Origin）：不需要 CORS 头，也不回 `*`。
        None => String::new(),
        Some(_) => String::new(),
    }
}

// ── 关窗首次确认（S5）──────────────────────────────────────────────────────
// 官方语义（apps/desktop/src/background-notice.ts）：关窗 = 隐藏到托盘，但**首次**
// 隐藏前必须确认一次（"任务不会中断，可从托盘找回"），标记落盘后不再打扰；
// Esc/关窗不记录确认。Linux 退化为最小化（GNOME 可能没有托盘），不需要确认。
/// 关窗是否需要弹确认（纯函数 → CI 可执行单测）。
fn close_needs_confirmation(marker_exists: bool, linux: bool) -> bool {
    !linux && !marker_exists
}

/// `<app_data>/background-close-confirmed`：用户已确认过"关窗进托盘"。
fn close_marker_path(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("background-close-confirmed")
}

/// 是否已确认过（读不到就是没确认过 —— 宁多问一次，不少问一次）。
fn close_confirmed(app: &AppHandle) -> bool {
    close_marker_path(app).exists()
}

/// 写确认标记；失败只记日志（不阻止隐藏，与官方一致）。
fn write_close_marker(app: &AppHandle) {
    let path = close_marker_path(app);
    if let Err(err) = std::fs::write(&path, b"1\n") {
        log_line(&app_data_dir(app), &format!("close-confirm: 标记写入失败 {}: {err}", path.display()));
    }
}

/// 关窗确认用的合成动作（不走桥，只复用确认窗与槽位机制）。
const CLOSE_HIDE_ACTION: DangerAction = DangerAction {
    id: "close-hide",
    title: "隐藏窗口到托盘",
    detail: "窗口会隐藏到系统托盘，dsh 与正在运行的任务都不会中断；从托盘图标或再次启动可以找回窗口。确认后不再重复询问。",
};

// ── 阶段 1：危险动作的壳内确认（D4 / 2026-09-09 审计定稿）──────────────────
// 桥线程**不执行**危险动作，只登记一个一次性槽位并打开壳拥有的确认窗；真正的
// 执行由确认窗通过 IPC `resolve_pending_action` 触发。这样：
//   - 同源第三方插件无法靠 `fetch` 直接达成危险动作（必须在壳窗口里点确认）；
//   - 桥线程不阻塞（非阻塞设计，避免同步 IPC 与主线程互等）；
//   - 槽位一次一个 + 60s 过期 + 同动作去重（防脚本刷窗）。
/// 危险动作的展示文案**由 Rust 生成**（调用方只能给 action id，不能伪造文案）。
#[derive(Clone, Copy)]
struct DangerAction {
    id: &'static str,
    title: &'static str,
    detail: &'static str,
}

/// 危险端点表（纯函数，平台无关 → CI 的 ubuntu job 会跑它的单测）。
fn dangerous_bridge_action(method: &str, path: &str) -> Option<DangerAction> {
    if method != "POST" {
        return None;
    }
    let action = |id, title, detail| Some(DangerAction { id, title, detail });
    match path {
        "/shell/quit" => action("quit", "退出应用", "将结束 dsh 服务及其全部子进程；正在运行的任务会被中断。"),
        "/restart" => action("restart", "重启服务", "结束当前 dsh 服务并重新启动；页面会重新加载，运行中的任务会中断。"),
        "/restart-dsh" => action("restart-dsh", "重启 dsh（不重装）", "只重启 dsh 进程，不检查更新。"),
        "/update-dsh" => action(
            "update-dsh",
            "更新 dsh 本体",
            "安装 npm 上的新版本并重启。dsh 0.1.7 起会话按 v4 写入：升级后无法回退读取新数据，建议先用「打开数据目录」备份。",
        ),
        "/shell/disable-third-party-plugins" => action(
            "disable-plugins",
            "停用全部第三方插件",
            "把 profile 的启用列表回退到 dsh 自带两层；改动前会先备份 profile 配置。",
        ),
        "/shell/cleanup-caches" => action(
            "cleanup-caches",
            "清理缓存",
            "会**先停止服务**，再删除运行时 node_modules —— 下次启动需要重新安装约 590 个包（数分钟）。",
        ),
        "/shell/legacy-cleanup" => action(
            "legacy-cleanup",
            "清理旧版残留",
            "删除旧版孤儿卸载器与指向旧版的快捷方式（会先备份；旧版仍在运行时拒绝执行）。",
        ),
        "/shell/dev-mode-toggle" => action(
            "dev-mode",
            "切换开发者模式",
            "开发者模式会解除 dsh 更新冻结，并解锁页面 DevTools（调试用）。",
        ),
        "/shell/gpu-accel-toggle" => action("gpu-accel", "切换 GPU 加速", "写入 dsh.json 的 webview.gpu；需重启应用才生效。"),
        "/shell/open-data-dir" => action("open-data", "打开数据目录", "在文件管理器中打开壳的数据目录（含 dsh-home、日志与备份入口）。"),
        "/shell/titlebar-toggle" => action(
            "titlebar-contract",
            "切换 Windows 顶栏契约",
            "把顶栏交还给 Web 客户端布局（实验项）：写入 dsh.json 的 webview.titlebarContract，刷新页面后生效。",
        ),
        _ => None,
    }
}

/// 待确认的一次性槽位。
struct PendingConfirm {
    action: DangerAction,
    nonce: String,
    body: String,
    created: std::time::Instant,
}

static PENDING_CONFIRM: Mutex<Option<PendingConfirm>> = Mutex::new(None);
/// 确认窗请求计数（仅用于生成不可预测的 nonce，不是安全边界）。
static CONFIRM_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 确认槽位的有效期（超时后必须重新发起）。
const CONFIRM_TTL_SECS: u64 = 60;

/// 生成 nonce（时间 + 序号 + pid 混合；只用于把确认窗绑定到某次请求）。
fn new_confirm_nonce() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = CONFIRM_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    format!("{nanos:x}-{seq:x}-{:x}", std::process::id())
}

/// 登记槽位并打开确认窗；已有未过期的槽位时返回 `Err("pending")`（单飞 + 去重）。
fn request_confirmation(app: &AppHandle, action: DangerAction, body: String) -> Result<String, &'static str> {
    let nonce = {
        let mut slot = PENDING_CONFIRM.lock().unwrap();
        if let Some(pending) = slot.as_ref() {
            if pending.created.elapsed().as_secs() < CONFIRM_TTL_SECS {
                // 已有未过期槽位（含同一动作重复请求）：聚焦已有窗口而不是叠窗。
                let duplicate = pending.action.id == action.id;
                drop(slot);
                if let Some(w) = app.get_webview_window("confirm") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                return Err(if duplicate { "pending" } else { "busy" });
            }
            // 过期槽位直接丢弃（窗口可能还开着，由 get_pending_action 返回 null 收尾）。
            *slot = None;
        }
        let nonce = new_confirm_nonce();
        *slot = Some(PendingConfirm { action, nonce: nonce.clone(), body, created: std::time::Instant::now() });
        nonce
    };
    open_confirm_window(app);
    Ok(nonce)
}

/// 打开（或聚焦）壳拥有的确认窗。窗口是普通带边框小窗：可键盘操作、Esc 取消。
fn open_confirm_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("confirm") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = tauri::WebviewWindowBuilder::new(app, "confirm", tauri::WebviewUrl::App("confirm.html".into()))
        .title(format!("{} — 确认操作", app.package_info().name))
        .inner_size(560.0, 320.0)
        .min_inner_size(460.0, 260.0)
        .resizable(false)
        .always_on_top(true)
        .center()
        .build();
}

/// 确认窗读取当前待确认动作（文案全部来自 Rust，页面只负责渲染）。
#[tauri::command(async)]
fn get_pending_action() -> serde_json::Value {
    match PENDING_CONFIRM.lock().unwrap().as_ref() {
        Some(p) if p.created.elapsed().as_secs() < CONFIRM_TTL_SECS => serde_json::json!({
            "nonce": p.nonce,
            "id": p.action.id,
            "title": p.action.title,
            "detail": p.action.detail,
        }),
        _ => serde_json::Value::Null,
    }
}

/// 确认窗的答复：批准则执行危险动作，取消则丢弃；两种情况都清空槽位。
#[tauri::command(async)]
fn resolve_pending_action(app: AppHandle, nonce: String, approved: bool) -> Result<serde_json::Value, String> {
    let pending = {
        let mut slot = PENDING_CONFIRM.lock().unwrap();
        let expired = slot.as_ref().map(|p| p.created.elapsed().as_secs() >= CONFIRM_TTL_SECS).unwrap_or(false);
        match slot.take() {
            Some(p) if !expired && p.nonce == nonce => Some(p),
            Some(p) if expired => {
                let _ = p;
                return Err("expired".into());
            }
            other => {
                *slot = other;
                return Err("stale".into());
            }
        }
    };
    if let Some(w) = app.get_webview_window("confirm") {
        let _ = w.close();
    }
    let Some(pending) = pending else { return Err("stale".into()) };
    let data = app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    if !approved {
        log_line(&data, &format!("danger-action: {} declined", pending.action.id));
        return Ok(serde_json::json!({ "ok": true, "declined": true }));
    }
    log_line(&data, &format!("danger-action: {} approved", pending.action.id));
    let outcome = execute_danger_action(&app, pending.action.id, &pending.body);
    Ok(serde_json::json!({ "ok": outcome.is_ok(), "error": outcome.err() }))
}

/// 执行危险动作（唯一执行点：桥/页面都只能经确认窗走到这里）。
fn execute_danger_action(app: &AppHandle, id: &str, body: &str) -> Result<(), String> {
    match id {
        "quit" => quit_app(app.clone(), app.state::<ServerState>()),
        "restart" => restart_server(app.clone(), app.state::<ServerState>()),
        "restart-dsh" => {
            send_manager(&mut app.state::<ServerState>().stdin.lock().unwrap(), "restart-dsh");
            Ok(())
        }
        "update-dsh" => {
            let version = serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|v| v.get("version").and_then(|v| v.as_str()).map(String::from));
            let line = if let Some(v) = version {
                serde_json::json!({ "cmd": "update-dsh", "version": v }).to_string()
            } else {
                serde_json::json!({ "cmd": "update-dsh" }).to_string()
            };
            send_line(&mut app.state::<ServerState>().stdin.lock().unwrap(), &line);
            Ok(())
        }
        "disable-plugins" => {
            let r = disable_third_party_plugins(app.clone())?;
            if r.get("ok").and_then(|v| v.as_bool()) == Some(true) { Ok(()) } else { Err(r.to_string()) }
        }
        "cleanup-caches" => {
            let _ = cleanup_caches(app.clone());
            Ok(())
        }
        "legacy-cleanup" => {
            let r = cleanup_legacy_install(app.clone());
            if r.get("ok").and_then(|v| v.as_bool()) == Some(true) { Ok(()) } else { Err(r.to_string()) }
        }
        "dev-mode" => { toggle_dev_mode(app.clone()).map(|_| ()) }
        "gpu-accel" => { toggle_gpu_accel(app.clone()).map(|_| ()) }
        "titlebar-contract" => { toggle_titlebar_contract(app.clone()).map(|_| ()) }
        "open-data" => open_data_dir(app.clone()),
        "close-hide" => {
            // 关窗确认：写标记 + 隐藏主窗口（隐藏失败如实返回错误）。
            write_close_marker(app);
            let w = app.get_webview_window("main").ok_or("main window missing")?;
            w.hide().map_err(|e| e.to_string())
        }
        other => Err(format!("unknown danger action: {other}")),
    }
}

fn handle_bridge_conn(stream: &mut TcpStream, app: &AppHandle) {
    use std::io::{Read as _, Write as _};
    let Ok(peer) = stream.try_clone() else { return };
    let mut reader = BufReader::new(peer);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");
    let mut content_length = 0usize;
    let mut host: Option<String> = None;
    let mut origin: Option<String> = None;
    let mut has_shell_header = false;
    let mut header = String::new();
    loop {
        header.clear();
        if reader.read_line(&mut header).is_err() || header == "\r\n" || header.is_empty() {
            break;
        }
        if let Some((k, v)) = header.split_once(':') {
            let key = k.trim();
            let val = v.trim();
            if key.eq_ignore_ascii_case("content-length") {
                content_length = val.parse().unwrap_or(0);
            } else if key.eq_ignore_ascii_case("host") {
                host = Some(val.to_string());
            } else if key.eq_ignore_ascii_case("origin") {
                origin = Some(val.to_string());
            } else if key.eq_ignore_ascii_case("x-dsh-shell") && val == "1" {
                has_shell_header = true;
            }
        }
    }
    // 阶段 0：Host / Origin / 自定义头三重准入。失败一律 403 且**不回** CORS 头
    //（浏览器读不到响应；本机工具能看到原因，便于排障）。
    let bridge_port = BRIDGE_PORT.load(std::sync::atomic::Ordering::SeqCst);
    if let Err(reason) = bridge_request_decision(method, host.as_deref(), origin.as_deref(), has_shell_header, bridge_port) {
        let data = app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        log_line(&data, &format!("bridge reject: {reason} method={method} path={path} origin={origin:?} host={host:?}"));
        let body = format!("{{\"ok\":false,\"reason\":\"{reason}\"}}");
        let resp = format!(
            "HTTP/1.1 403 Forbidden\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(resp.as_bytes());
        let _ = stream.flush();
        return;
    }
    // 阶段 1（D4）：危险动作不在桥线程执行 —— 登记一次性槽位 + 打开壳拥有的
    // 确认窗，立即以 202 返回（非阻塞；真正执行在 confirm 窗的 IPC 里）。
    if let Some(action) = dangerous_bridge_action(method, path) {
        let mut body_bytes = vec![0u8; content_length];
        let _ = reader.read_exact(&mut body_bytes);
        let body_text = String::from_utf8_lossy(&body_bytes).into_owned();
        let (status, payload) = match request_confirmation(app, action, body_text) {
            Ok(nonce) => (
                "202 Accepted",
                serde_json::json!({ "ok": false, "pending": true, "nonce": nonce, "action": action.id }),
            ),
            Err(reason) => (
                "202 Accepted",
                serde_json::json!({ "ok": false, "pending": true, "duplicate": true, "reason": reason }),
            ),
        };
        let payload = payload.to_string();
        let resp = format!(
            "HTTP/1.1 {status}\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n{payload}",
            bridge_cors_headers(origin.as_deref()),
            payload.len()
        );
        let _ = stream.write_all(resp.as_bytes());
        let _ = stream.flush();
        return;
    }
    let mut body = vec![0u8; content_length];
    let _ = reader.read_exact(&mut body);
    let body = String::from_utf8_lossy(&body).into_owned();

    let (status, resp_body) = match (method, path) {
        ("OPTIONS", _) => ("204 No Content", String::new()),
        ("GET", "/pending-open") => {
            let sid = PENDING_OPEN.lock().unwrap().take();
            // Log only real handoffs — the 1.2s poll would otherwise flood the
            // session log with thousands of "None" lines.
            if sid.is_some() {
                let data = app
                    .path()
                    .app_data_dir()
                    .unwrap_or_else(|_| std::path::PathBuf::from("."));
                log_line(&data, &format!("pending-open: {sid:?}"));
            }
            let body = match &sid {
                Some(s) => format!("{{\"sessionId\":{}}}", serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())),
                None => "{\"sessionId\":null}".into(),
            };
            ("200 OK", body)
        }
        ("POST", "/alive") => {
            let data = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            // 页面 JS 已运行：导航兜底以此作为"真正渲染完成"信号。
            CLIENT_READY.store(true, std::sync::atomic::Ordering::SeqCst);
            // 启动成功 = 本次升级（若有）已确认可用 → 清掉归因标记（S9）。
            clear_upgrade_marker(app);
            log_line(&data, &format!("client-ready (http): {body}"));
            eprintln!("[dsh-desktop] client-ready (http): {body}");
            ("200 OK", String::new())
        }
        ("POST", "/log") => {
            let data = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let (tag, sid, detail) = serde_json::from_str::<serde_json::Value>(&body)
                .map(|v| {
                    (
                        v.get("tag").and_then(|x| x.as_str()).unwrap_or("?").to_string(),
                        v.get("sessionId").and_then(|x| x.as_str()).map(|s| s.to_string()),
                        v.get("detail").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    )
                })
                .unwrap_or_else(|_| ("?".into(), None, body.clone()));
            let line = match sid {
                Some(s) if !s.is_empty() => format!("client/log {tag} [session={s}] {detail}"),
                _ => format!("client/log {tag} {detail}"),
            };
            log_line(&data, &line);
            eprintln!("[dsh-desktop] {line}");
            ("200 OK", String::new())
        }
        ("POST", "/notify") => {
            let (title, body2, sid) =
                serde_json::from_str::<serde_json::Value>(&body)
                    .map(|v| {
                        (
                            v.get("title").and_then(|x| x.as_str()).unwrap_or("dsh").to_string(),
                            v.get("body").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                            v.get("sessionId").and_then(|x| x.as_str()).map(|s| s.to_string()),
                        )
                    })
                    .unwrap_or_else(|_| ("dsh".into(), body.clone(), None));
            if let Some(s) = &sid {
                *LAST_SESSION.lock().unwrap() = Some(s.clone());
                // A notify only happens while the window is unfocused (the
                // client suppresses focused toasts) — so the next focus event
                // is almost certainly the user clicking this toast. Stage the
                // session to open on that focus.
                *FOCUS_OPEN.lock().unwrap() = Some(s.clone());
                let data = app
                    .path()
                    .app_data_dir()
                    .unwrap_or_else(|_| std::path::PathBuf::from("."));
                log_line(&data, &format!("notification session={s}"));
            }
            show_toast(app, title, body2);
            ("200 OK", String::new())
        }
        ("GET", "/update-status") => {
            let state = app.state::<ServerState>();
            let s = state.update.lock().unwrap();
            let body = serde_json::json!({
                "current": s.current,
                "latest": s.latest,
                "updateAvailable": s.update_available,
                "next": s.next,
                "nextAvailable": s.next_available,
            })
            .to_string();
            ("200 OK", body)
        }
        // 壳自更新状态（A-1）：独立端点，与 /update-status 无耦合。
        ("GET", "/shell-update-status") => {
            let state = app.state::<ServerState>();
            let s = state.shell_update.lock().unwrap();
            let body = serde_json::json!({
                "current": s.current,
                "latest": s.latest,
                "hasUpdate": s.has_update,
                "url": s.url,
                "error": s.error,
                "dev": s.dev,
            })
            .to_string();
            ("200 OK", body)
        }
        ("POST", "/check-shell-update") => {
            // 触发 manager 去查 GitHub Releases（只报告，不下载/不安装）。
            send_manager(
                &mut app.state::<ServerState>().stdin.lock().unwrap(),
                "check-shell-update",
            );
            ("200 OK", String::new())
        }
        ("POST", "/check-update") => {
            send_manager(
                &mut app.state::<ServerState>().stdin.lock().unwrap(),
                "check-update",
            );
            ("200 OK", String::new())
        }
        ("POST", "/update-dsh") => {
            // Optional target version (e.g. a pre-release from the `next` tag);
            // without it the manager installs `dist-tags.latest`.
            let version = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("version").and_then(|v| v.as_str()).map(String::from));
            let line = if let Some(v) = version {
                serde_json::json!({ "cmd": "update-dsh", "version": v }).to_string()
            } else {
                serde_json::json!({ "cmd": "update-dsh" }).to_string()
            };
            send_line(&mut app.state::<ServerState>().stdin.lock().unwrap(), &line);
            ("200 OK", String::new())
        }
        ("POST", "/restart-dsh") => {
            send_manager(
                &mut app.state::<ServerState>().stdin.lock().unwrap(),
                "restart-dsh",
            );
            ("200 OK", String::new())
        }
        ("POST", "/refresh") => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.reload();
            }
            ("200 OK", String::new())
        }
        ("POST", "/restart") => {
            let _ = restart_server(app.clone(), app.state::<ServerState>());
            ("200 OK", String::new())
        }
        ("POST", "/devtools") => {
            if dev_mode(&runtime_dir(app)) {
                if let Some(w) = app.get_webview_window("main") {
                    w.open_devtools();
                }
                ("200 OK", String::new())
            } else {
                ("403 Forbidden", "devtools requires dev mode (tray: 开发者模式)".into())
            }
        }
        // ── shell chrome (custom title bar + menu bar; remote dsh page has
        // no __TAURI__, so window/menu actions ride the bridge) ────────────
        // 诊断（临时）：记录窗口动作到达桥的时间，配合 chrome 闪框区分
        // "点击没到页面" vs "页面到了桥但窗口操作失败"。
        ("POST", "/window/minimize") => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.minimize();
            }
            log_line(&app_data_dir(app), "bridge: /window/minimize");
            ("200 OK", serde_json::json!({ "ok": true }).to_string())
        }
        ("POST", "/window/toggle-maximize") => {
            let maximized = app
                .get_webview_window("main")
                .and_then(|w| w.is_maximized().ok())
                .unwrap_or(false);
            log_line(&app_data_dir(app), "bridge: /window/toggle-maximize");
            if let Some(w) = app.get_webview_window("main") {
                if maximized {
                    let _ = w.unmaximize();
                } else {
                    let _ = w.maximize();
                }
            }
            ("200 OK", serde_json::json!({ "ok": true, "maximized": !maximized }).to_string())
        }
        ("POST", "/window/close") => {
            // Same semantics as the native close button: CloseRequested →
            // prevent + hide to tray (menu bar 退出 is the real quit).
            log_line(&app_data_dir(app), "bridge: /window/close");
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.close();
            }
            ("200 OK", serde_json::json!({ "ok": true }).to_string())
        }
        ("POST", "/window/drag") => {
            log_line(&app_data_dir(app), "bridge: /window/drag");
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.start_dragging();
            }
            ("200 OK", serde_json::json!({ "ok": true }).to_string())
        }
        ("GET", "/window/state") => {
            let maximized = app
                .get_webview_window("main")
                .and_then(|w| w.is_maximized().ok())
                .unwrap_or(false);
            ("200 OK", serde_json::json!({ "ok": true, "maximized": maximized }).to_string())
        }
        ("POST", "/shell/open-settings") => {
            open_settings_window(app);
            ("200 OK", serde_json::json!({ "ok": true }).to_string())
        }
        // 安全网（dsh 起不来时的自救）：回退到 dsh 自带的两层 bundle。
        ("POST", "/shell/disable-third-party-plugins") => {
            match disable_third_party_plugins(app.clone()) {
                Ok(v) => ("200 OK", v.to_string()),
                Err(e) => (
                    "500 Internal Server Error",
                    serde_json::json!({ "ok": false, "error": e }).to_string(),
                ),
            }
        }
        ("POST", "/shell/dev-mode-toggle") => match toggle_dev_mode_impl(app) {
            Ok(v) => ("200 OK", v.to_string()),
            Err(e) => (
                "500 Internal Server Error",
                serde_json::json!({ "ok": false, "error": e }).to_string(),
            ),
        },
        ("POST", "/shell/titlebar-toggle") => match toggle_titlebar_contract_impl(app) {
            Ok(v) => ("200 OK", v.to_string()),
            Err(e) => ("500 Internal Server Error", serde_json::json!({ "ok": false, "error": e }).to_string()),
        },
        ("POST", "/shell/gpu-accel-toggle") => match toggle_gpu_accel_impl(app) {
            Ok(v) => ("200 OK", v.to_string()),
            Err(e) => (
                "500 Internal Server Error",
                serde_json::json!({ "ok": false, "error": e }).to_string(),
            ),
        },
        ("POST", "/shell/open-data-dir") => {
            let _ = open_data_dir(app.clone());
            ("200 OK", serde_json::json!({ "ok": true }).to_string())
        }
        ("POST", "/shell/open-evidence") => {
            // 最近一次 manager 故障的证据目录（无故障时开 reports 根目录）。
            let _ = open_evidence_dir(app.clone());
            ("200 OK", serde_json::json!({ "ok": true }).to_string())
        }
        ("POST", "/shell/quit") => {
            let _ = quit_app(app.clone(), app.state::<ServerState>());
            ("200 OK", serde_json::json!({ "ok": true }).to_string())
        }
        ("GET", "/shell/state") => {
            // Bind the State first: the lock guard borrows it, so an inline
            // app.state() temporary would be dropped while still borrowed.
            let state = app.state::<ServerState>();
            let upd = state.update.lock().unwrap();
            (
                "200 OK",
                serde_json::json!({
                    "version": env!("CARGO_PKG_VERSION"),
                    "devMode": dev_mode(&runtime_dir(app)),
                    "gpu": gpu_accel(&runtime_dir(app)),
                    "titlebarContract": titlebar_contract(&runtime_dir(app)),
                    "preinstalled": preinstalled_versions(&runtime_dir(app)),
                    "update": {
                        "current": upd.current,
                        "latest": upd.latest,
                        "updateAvailable": upd.update_available,
                        "next": upd.next,
                        "nextAvailable": upd.next_available,
                    },
                })
                .to_string(),
            )
        }
        ("GET", "/shell/status") => {
            let state = app.state::<ServerState>();
            ("200 OK", shell_status_json(app, &state).to_string())
        }
        ("GET", "/shell/legacy") => {
            ("200 OK", legacy_check_json(app).to_string())
        }
        ("POST", "/shell/legacy-cleanup") => {
            ("200 OK", legacy_cleanup_json(app).to_string())
        }
        ("POST", "/shell/cleanup-caches") => {
            ("200 OK", cache_cleanup_json(app).to_string())
        }
        _ => ("404 Not Found", "not found".into()),
    };
    let resp = format!(
        "HTTP/1.1 {status}\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n{resp_body}",
        bridge_cors_headers(origin.as_deref()),
        resp_body.len()
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
}

/// Per-platform bundled-node path fragment, e.g. `node/win32-x64/node.exe`.
fn node_rel_path() -> &'static str {
    #[cfg(windows)]
    let rel = "node/win32-x64/node.exe";
    #[cfg(target_os = "macos")]
    let rel = "node/darwin-x64/node";
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    let rel = "node/linux-x64/node";
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    let rel = "node/linux-arm64/node";
    #[cfg(not(any(
        windows,
        target_os = "macos",
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64")
    )))]
    compile_error!("unsupported target: add a resources/node/<platform> layout in lib.rs");
    rel
}

/// Strip the `\\?\` extended-length prefix Windows `current_exe()` adds: such
/// paths break Node's module loader (it lstat's a bare `C:` component) and are
/// unreliable as CreateProcess argument paths.
fn simplify_path(p: &std::path::Path) -> std::path::PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return std::path::PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return std::path::PathBuf::from(rest);
    }
    p.to_path_buf()
}

/// Resolve the bundled resources root and node binary. Tauri's
/// `resource_dir()` returns the EXE directory on Windows (the bundler puts
/// everything under a `resources/` subfolder), so probe the candidate layouts
/// and use whichever actually exists — never assume one.
fn resource_paths(app: &AppHandle) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let res = simplify_path(
        &app
            .path()
            .resource_dir()
            .map_err(|e| format!("resource dir: {e}"))?,
    );
    let rel = node_rel_path();

    let mut bases: Vec<std::path::PathBuf> = Vec::new();
    bases.push(res.join("resources"));
    bases.push(res.clone());
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let dir = simplify_path(dir);
            bases.push(dir.join("resources"));
            bases.push(dir);
        }
    }

    for base in &bases {
        let node_exe = base.join(rel);
        if node_exe.exists() {
            return Ok((base.clone(), node_exe));
        }
    }
    Err(format!(
        "bundled node not found; probed: {} — 资源缺失，请重新安装 DSH Smoothly Desktop",
        bases
            .iter()
            .map(|b| b.display().to_string())
            .collect::<Vec<_>>()
            .join("; ")
    ))
}

/// Spawn the server-manager under the bundled Node and stream its events.
fn start_server(app: &AppHandle) -> Result<(), String> {
    // 等启动期孤儿清理完成再拉起新服务树（防止后台 cleanup 误杀新起的
    // manager/web）。首启 boot 线程、托盘重启、launcher 重试都走这里。
    wait_for_startup_cleanup();
    stop_child(&app.state::<ServerState>());

    let (res, node_exe) = resource_paths(app)?;
    eprintln!("[dsh-desktop] resources root: {}", res.display());
    let _ = app.emit("server-log", format!("resources root: {}", res.display()));
    let manager = simplify_path(&res.join("manager/server-manager.mjs"));
    let patch = simplify_path(&res.join("patch/dsh-desktop.patch.yml"));
    let data = simplify_path(
        &app
            .path()
            .app_data_dir()
            .map_err(|e| format!("app data dir: {e}"))?,
    );
    let home = simplify_path(
        &app
            .path()
            .home_dir()
            .map_err(|e| format!("home dir: {e}"))?,
    );

    let mut cmd = Command::new(&node_exe);
    #[cfg(windows)]
    no_console_window(&mut cmd);
    cmd.arg(&manager)
        .arg("--runtime-dir")
        .arg(data.join("runtime"))
        .arg("--resource-dir")
        .arg(&res)
        .arg("--patch")
        .arg(&patch)
        .arg("--cwd")
        .arg(&home)
        // 壳版本与身份：manager 的壳自更新检查需要它们（A-1）。
        // dev 构建靠 identifier 后缀判定，不提示壳更新。
        .arg("--shell-version")
        .arg(env!("CARGO_PKG_VERSION"))
        .arg("--shell-identifier")
        .arg(&app.config().identifier)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let bridge_port = BRIDGE_PORT.load(std::sync::atomic::Ordering::SeqCst);
    if bridge_port > 0 {
        cmd.arg("--bridge-port").arg(bridge_port.to_string());
    }

    // Optional npm registry override (e.g. a China mirror) via env.
    if let Ok(registry) = std::env::var("DSH_DESKTOP_REGISTRY") {
        if !registry.trim().is_empty() {
            cmd.arg("--registry").arg(&registry);
        }
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn manager: {e}"))?;
    // 把 manager（及其后代）放进 kill-on-close job：壳进程死亡时系统整树清理，
    // 不留孤儿 node 与下次启动抢端口/文件。失败只记日志（启动期孤儿清理兜底）。
    #[cfg(windows)]
    {
        let job = SERVICE_JOB.load(std::sync::atomic::Ordering::SeqCst);
        if job != 0 {
            if let Err(e) = job_object::assign(job, child.id()) {
                let data = app
                    .path()
                    .app_data_dir()
                    .unwrap_or_else(|_| std::path::PathBuf::from("."));
                log_line(&data, &format!("job assign failed: {e}"));
                eprintln!("[dsh-desktop] job assign failed: {e}");
            }
        }
    }
    let generation: u64;
    {
        // Fresh manager: reset every mirrored state and the tray item text.
        // The manager re-reports `update-status`/`preinstalled-updates` after
        // boot; op-status is reset here so a stale "restart to apply" hint from
        // the previous manager never re-appears on the freshly loaded page.
        let state = app.state::<ServerState>();
        *state.stdin.lock().unwrap() = child.stdin.take();
        // 新一代 manager：世代号 +1、清意图停止位、记录 pid。检测线程（stdout
        // EOF + try_wait 看护）用世代号围栏，旧世代的迟到事件一律丢弃。
        generation = {
            let mut guard = state.guard.lock().unwrap();
            guard.generation += 1;
            guard.intentional = false;
            guard.pid = child.id();
            guard.phase = MgrPhase::Starting;
            guard.generation
        };
        *state.update.lock().unwrap() = UpdateStatus::default();
        *state.op.lock().unwrap() = OpStatus::default();
        let guard = state.update_item.lock().unwrap();
        if let Some(item) = guard.as_ref() {
            let _ = item.set_text("检查更新…");
        }
        drop(guard);
        // Mirror the dsh.json devMode flag onto the tray checkbox.
        let guard = state.dev_item.lock().unwrap();
        if let Some(item) = guard.as_ref() {
            let _ = item.set_checked(dev_mode(&runtime_dir(app)));
        }
    }

    let stdout = child.stdout.take().expect("piped stdout");
    let handle = app.clone();
    let lines = BufReader::new(stdout).lines();
    std::thread::spawn(move || {
        for line in lines.map_while(Result::ok) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            // Mirror the protocol to stderr too: headless smoke tests and
            // console debugging can observe the full chain without the webview.
            eprintln!("[dsh-desktop manager] {trimmed}");
            // Manager protocol: JSON lines {"t":"url"|"log"|"down", ...}
            if let Ok(ev) = serde_json::from_str::<serde_json::Value>(trimmed) {
                let t = ev.get("t").and_then(|v| v.as_str());
                match t {
                    Some("url") => {
                        if let Some(url) = ev.get("url").and_then(|v| v.as_str()) {
                            // ── 陈旧鉴权 cookie 清理必须早于"交付 URL" ────────
                            // launcher 页自己也会监听 server-url 并 location.href，
                            // 另有 1s 轮询 get_shell_state.liveUrl；所以"清理先于
                            // 任何加载"要求先清理、后 emit（见 cookie-431 方案）。
                            wait_for_startup_auth_prune();
                            let origin = tauri::Url::parse(url)
                                .ok()
                                .map(|u| u.origin().ascii_serialization());
                            if let Some(origin) = origin {
                                let changed = {
                                    let mut last = LAST_ANNOUNCED_ORIGIN.lock().unwrap();
                                    let changed = last.as_deref() != Some(origin.as_str());
                                    if changed {
                                        *last = Some(origin);
                                    }
                                    changed
                                };
                                if changed {
                                    // authority 变化 = 新 cookie 命名空间：清掉旧
                                    // authority 的 cookie（同一 authority 的重复事件
                                    // 不清，避免删掉页面正在用的那条）。
                                    request_auth_cookie_prune();
                                }
                            }
                            // 服务起来了：清空历史故障提示，条幅不再显示。
                            *handle.state::<ServerState>().last_error.lock().unwrap() = None;
                            {
                                let state = handle.state::<ServerState>();
                                let mut guard = state.guard.lock().unwrap();
                                if guard.generation == generation && !guard.intentional {
                                    guard.phase = MgrPhase::Running;
                                }
                            }
                            let _ = handle.emit("server-url", url);
                            *LIVE_DSH_URL.lock().unwrap() = Some(url.to_string());
                            // 新地址到来：页面可用信号重置，导航兜底会持续驱动
                            // 到新页面的 /alive 出现（旧 alive 不代表新页面就绪）。
                            CLIENT_READY.store(false, std::sync::atomic::Ordering::SeqCst);
                            // Reconnect: the launcher page's JS listener is gone
                            // once the webview is on the dsh page, so a dsh /
                            // manager restart (new random port) must be driven by
                            // the shell. Navigating on every server-url is
                            // idempotent when it is already the current page.
                            if let Ok(u) = tauri::Url::parse(url) {
                                if let Some(w) = handle.get_webview_window("main") {
                                    let _ = w.navigate(u);
                                }
                            }
                        }
                    }
                    Some("dump-web") => {
                        // manager 判定 dsh web 挂起：壳负责抓现场（MiniDumpWriteDump），
                        // 抓完回 dump-done 让 manager 立刻重启（见 dump_dsh_web）。
                        let url = ev
                            .get("url")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .map(String::from)
                            .or_else(|| LIVE_DSH_URL.lock().unwrap().clone());
                        match url {
                            Some(url) => {
                                let app2 = handle.clone();
                                std::thread::spawn(move || dump_dsh_web(&app2, &url));
                            }
                            None => {
                                let data = handle
                                    .path()
                                    .app_data_dir()
                                    .unwrap_or_else(|_| std::path::PathBuf::from("."));
                                log_line(&data, "dump-web requested but no live url");
                                ack_dump_done(&handle);
                            }
                        }
                    }
                    Some("log") => {
                        if let Some(line) = ev.get("line").and_then(|v| v.as_str()) {
                            let _ = handle.emit("server-log", line);
                        }
                    }
                    Some("install-status") => {
                        // Forward install/update progress to the launcher page
                        // (phase: start|running|done|error, seconds heartbeat).
                        let payload = serde_json::json!({
                            "phase": ev.get("phase").and_then(|v| v.as_str()).unwrap_or(""),
                            "version": ev.get("version").and_then(|v| v.as_str()).unwrap_or(""),
                            "seconds": ev.get("seconds").and_then(|v| v.as_u64()).unwrap_or(0),
                            "error": ev.get("error").and_then(|v| v.as_str()).unwrap_or(""),
                        });
                        let _ = handle.emit("install-status", payload);
                    }
                    Some("update-status") => {
                        let current = ev.get("current").and_then(|v| v.as_str()).map(String::from);
                        let latest = ev.get("latest").and_then(|v| v.as_str()).map(String::from);
                        let available = ev.get("updateAvailable").and_then(|v| v.as_bool()).unwrap_or(false);
                        let next = ev.get("next").and_then(|v| v.as_str()).map(String::from);
                        let next_tag = ev.get("nextTag").and_then(|v| v.as_str()).map(String::from);
                        let next_available = ev.get("nextAvailable").and_then(|v| v.as_bool()).unwrap_or(false);
                        let state = handle.state::<ServerState>();
                        {
                            let mut upd = state.update.lock().unwrap();
                            upd.current = current.clone();
                            upd.latest = latest.clone();
                            upd.update_available = available;
                            upd.next = next.clone();
                            upd.next_tag = next_tag.clone();
                            upd.next_available = next_available;
                        }
                        // Flip the tray item between "检查更新…" and "有更新 vX（点击更新）".
                        // 托盘是壳内入口（不经桥的确认窗），所以把"先备份"的提示直接
                        // 写进标签：dsh ≥0.1.7 起会话按 v4 写入，回退旧版读不到新数据。
                        let guard = state.update_item.lock().unwrap();
                        if let Some(item) = guard.as_ref() {
                            let text = if available {
                                format!(
                                    "有更新 {}（当前 {}）→ 点击更新（建议先备份数据目录）",
                                    latest.as_deref().unwrap_or("?"),
                                    current.as_deref().unwrap_or("?"),
                                )
                            } else {
                                "检查更新…".to_string()
                            };
                            let _ = item.set_text(text);
                        }
                        // Once per launch, remind the user an update is waiting
                        // (the launcher page is only visible for seconds, so a
                        // native toast is the real "red dot"; the tray item is
                        // the persistent entry point).
                        if available
                            && !UPDATE_TOAST_SHOWN.swap(true, std::sync::atomic::Ordering::SeqCst)
                        {
                            show_toast(
                                &handle,
                                "dsh 有更新".into(),
                                format!(
                                    "{} → {}，点托盘「有更新」可一键更新；升级后无法回退读取新数据，建议先备份数据目录",
                                    current.as_deref().unwrap_or("?"),
                                    latest.as_deref().unwrap_or("?"),
                                ),
                            );
                        }
                    }
                    // 壳自更新检查结果（A-1）：**独立于 update-status**。
                    // update-status 驱动托盘点击行为（available → 点击发 update-dsh），
                    // 把壳更新塞进同一布尔会让用户"看到壳有更新、点下去却更新了 dsh"
                    // （审计 P0）。因此单独存一份，只读展示，不参与任何自动动作。
                    Some("shell-update") => {
                        let state = handle.state::<ServerState>();
                        let mut s = state.shell_update.lock().unwrap();
                        s.current = ev.get("current").and_then(|v| v.as_str()).map(String::from);
                        s.latest = ev.get("latest").and_then(|v| v.as_str()).map(String::from);
                        s.has_update = ev.get("hasUpdate").and_then(|v| v.as_bool()).unwrap_or(false);
                        s.url = ev.get("url").and_then(|v| v.as_str()).map(String::from);
                        s.error = ev.get("error").and_then(|v| v.as_str()).map(String::from);
                        s.dev = ev.get("dev").and_then(|v| v.as_bool()).unwrap_or(false);
                    }
                    Some("op-status") => {
                        let state = handle.state::<ServerState>();
                        let mut s = state.op.lock().unwrap();
                        s.op = ev.get("op").and_then(|v| v.as_str()).map(String::from);
                        s.spec = ev.get("spec").and_then(|v| v.as_str()).map(String::from);
                        s.done = ev.get("done").and_then(|v| v.as_bool()).unwrap_or(false);
                        s.ok = ev.get("ok").and_then(|v| v.as_bool());
                        s.next_action = ev.get("nextAction").and_then(|v| v.as_str()).map(String::from);
                        s.error = ev.get("error").and_then(|v| v.as_str()).map(String::from);
                        s.hint = ev.get("hint").and_then(|v| v.as_str()).map(String::from);
                        s.hint_key = ev.get("hintKey").and_then(|v| v.as_str()).map(String::from);
                        s.hint_plugins = ev
                            .get("hintPlugins")
                            .and_then(|v| v.as_array())
                            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect());
                    }
                    Some("proxy-hosts") => {
                        let hosts = ev
                            .get("hosts")
                            .and_then(|v| v.as_array())
                            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<_>>())
                            .unwrap_or_default();
                        handle.state::<ServerState>().proxy.lock().unwrap().hosts = hosts;
                    }
                    Some("proxy-providers") => {
                        let providers = ev
                            .get("providers")
                            .and_then(|v| v.as_array())
                            .cloned()
                            .unwrap_or_default();
                        handle.state::<ServerState>().proxy.lock().unwrap().providers = providers;
                    }
                    _ => {}
                }
            }
        }
        // stdout EOF => manager exited (or closed its stdout). Report it through
        // the lifecycle guard: exit code + evidence, never an auto-restart.
        handle_manager_exit(&handle, generation, "stdout-eof");
    });

    // Manager's stderr: surface in the UI log AND our own stderr so that any
    // pre-protocol failure (e.g. node script crash) is never silent.
    if let Some(err) = child.stderr.take() {
        let handle = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let _ = handle.emit("server-log", line.clone());
                eprintln!("[dsh-desktop manager] {line}");
                // 故障披露：捕获 manager 侧错误特征行（node 崩溃/异常），
                // 存为最近故障摘要供 chrome 条幅展示。
                let low = line.to_ascii_lowercase();
                let is_error = low.contains("error")
                    || low.contains("failed")
                    || low.contains("exit code")
                    || low.contains("exception")
                    || low.contains("cannot")
                    || low.contains("uncaught")
                    || low.contains("econnrefused")
                    || low.contains("esockettimeout");
                if is_error {
                    let trimmed: String = line.trim().chars().take(300).collect();
                    *handle.state::<ServerState>().last_error.lock().unwrap() = Some(trimmed);
                }
            }
        });
    }

    let handle = app.clone();
    let pid = child.id();
    eprintln!("[dsh-desktop] manager spawned (pid {pid})");
    let _ = handle.emit("server-log", format!("manager spawned (pid {pid})"));
    *app.state::<ServerState>().child.lock().unwrap() = Some(child);
    // 看护线程：stdout EOF 之外的第二条检测路径。若 manager 的某个孙进程继承
    // 了 stdout 管道，EOF 可能永不出现；`try_wait` 是权威信号（2s 轮询）。
    start_manager_watchdog(app, generation);
    // ── 首启 URL 索要：manager 的首个 URL 协议事件可能在 shell 的 stdout
    // 读取器就绪前发出而丢失（LIVE_DSH_URL 永远为空 → 黑屏且重启服务才恢复
    // 的根因之一）。启动后按 2s/2s/4s 主动让 manager 重发（report-url）；
    // 已拿到 URL 即停。幂等。
    {
        let app2 = app.clone();
        std::thread::spawn(move || {
            for delay_ms in [2000u64, 2000, 4000] {
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                if LIVE_DSH_URL.lock().unwrap().is_some() {
                    break;
                }
                let state = app2.state::<ServerState>();
                let mut stdin = state.stdin.lock().unwrap();
                send_line(&mut stdin, r#"{"cmd":"report-url"}"#);
            }
        });
    }
    Ok(())
}

/// 导航兜底的节流曲线（秒）：前 3 次保持 3s（覆盖"冷启动 navigate 丢失"这一
/// 主场景），之后 6/12/24s，封顶 30s。任何"页面起不来"的原因都不该变成 3s
/// 无限重载——2026-09-20 cookie-431 事故实测 535 次 nav-fallback，页面永远停在
/// 错误页并持续刷网络/CPU（详见 docs/2026-09-20-webview2-cookie-431-fix-plan.md）。
fn nav_fallback_interval_secs(attempts: u32) -> u64 {
    match attempts {
        0..=2 => 3,
        3 => 6,
        4 => 12,
        5 => 24,
        _ => 30,
    }
}

/// 超过该次数后只写一条"放弃快速重试"的日志（仍按封顶间隔继续重试，页面
/// 一旦恢复可用仍能自愈）。
const NAV_FALLBACK_MAX_ATTEMPTS: u32 = 8;

/// 本地壳页面（启动页）URL 判定：macOS/Linux 是 `tauri://localhost`，Windows
/// 是 `http://tauri.localhost`（WebView2 不支持自定义 scheme，Tauri 用
/// `<scheme>.localhost` 代管）。故障回退导航只认这两种，否则会落到
/// `about:blank` 黑屏（2026-09-09 实机验证）。
fn is_shell_local_url(u: &tauri::Url) -> bool {
    if u.scheme() == "tauri" {
        return true;
    }
    u.scheme() == "http"
        && u.host_str()
            .map(|h| h == "tauri.localhost" || h.ends_with(".localhost"))
            .unwrap_or(false)
}

// ── dsh web 鉴权 cookie 清理（2026-09-20「cookie-431」修复）──────────────────
// 背景：dsh web 的鉴权 cookie 名绑定 authority（`dsh-auth-<base64url(sha256(
// host:port))>`），而壳用 `dsh web --port 0`（每轮随机端口）→ 每一轮"完成的
// token 导航"都会新增一条 226B、Max-Age 30 天的 cookie；HTTP cookie 不按端口
// 隔离，于是 Cookie 请求头单调增长，越过 Node 默认 16KB 头上限（**请求行也计入
// 该预算**）后，页面上唯一 >1KB 的 URL——客户端插件批 bundle（≈2.85KB）——第一个
// 被 `431 Request Header Fields Too Large` 打掉：批 bundle 未注册任何模块 →
// 61 个客户端插件全部 `import failed` → 页面停在「Failed to load plugins」，
// 且导航兜底因永远等不到 `/alive` 而每 3s 重载。
// 详见 docs/2026-09-20-webview2-cookie-431-fix-plan.md（含阈值实测与审计）。

/// 是否属于 dsh 自己签发、且落在本机回环 host 上的鉴权 cookie。
/// 只认 `dsh-auth-` 前缀 + 回环 host：绝不触碰任何其它 cookie。
fn is_stale_auth_cookie(name: &str, domain: &str) -> bool {
    name.starts_with("dsh-auth-")
        && matches!(
            domain
                .trim()
                .trim_start_matches('.')
                .to_ascii_lowercase()
                .as_str(),
            "127.0.0.1" | "localhost" | "::1"
        )
}

/// 清理陈旧 dsh 鉴权 cookie，返回 `(清理前条数, 尝试删除条数, 清理后剩余条数)`。
///
/// ⚠️ **只能在后台线程调用**：Windows 上 `Webview::cookies()` 是同步阻塞 +
/// 嵌套消息泵，Tauri 官方明确"在同步 command / 事件处理器里调用会死锁"
/// （wry#583）。因此本函数不在 setup / on_page_load / 任何同步 command 里调用。
///
/// `delete_cookie` 是"入队即返回"（失败被框架的 log 吞掉，而本 crate 没有
/// logger），所以**必须回读复核**：第二次 `cookies()` 会阻塞到主线程处理完
/// 之前排队的删除，读到的就是删除后的真实状态。
fn prune_stale_auth_cookies(app: &AppHandle) -> (usize, usize, usize) {
    let data = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let Some(w) = app.get_webview_window("main") else {
        log_line(&data, "dsh-auth cookies: main webview not ready");
        return (0, 0, 0);
    };
    let Ok(all) = w.cookies() else {
        log_line(&data, "dsh-auth cookies: cookies() failed");
        return (0, 0, 0);
    };
    let jar = all.len();
    let stale: Vec<_> = all
        .into_iter()
        .filter(|c| is_stale_auth_cookie(c.name(), c.domain().unwrap_or_default()))
        .collect();
    let before = stale.len();
    if before == 0 {
        log_line(&data, &format!("dsh-auth cookies: jar={jar} stale_before=0 deleted=0 remaining=0"));
        return (0, 0, 0);
    }
    let mut deleted = 0;
    for c in stale {
        if w.delete_cookie(c).is_ok() {
            deleted += 1;
        }
    }
    // 复核（并给一次有界重试机会）。
    let mut remaining = count_stale_auth_cookies(&w);
    if remaining > 0 {
        if let Ok(all) = w.cookies() {
            for c in all
                .into_iter()
                .filter(|c| is_stale_auth_cookie(c.name(), c.domain().unwrap_or_default()))
            {
                let _ = w.delete_cookie(c);
            }
        }
        remaining = count_stale_auth_cookies(&w);
    }
    log_line(
        &data,
        &format!(
            "dsh-auth cookies: jar={jar} stale_before={before} deleted={deleted} remaining={remaining}"
        ),
    );
    (before, deleted, remaining)
}

/// 复核用：当前 jar 里仍存在的陈旧 cookie 条数（读取失败按 0 处理并留痕）。
fn count_stale_auth_cookies<R: tauri::Runtime>(w: &tauri::WebviewWindow<R>) -> usize {
    w.cookies()
        .map(|all| {
            all.iter()
                .filter(|c| is_stale_auth_cookie(c.name(), c.domain().unwrap_or_default()))
                .count()
        })
        .unwrap_or(0)
}

/// 启动 cookie janitor：单一后台线程串行处理清理请求。
/// - 启动时先清一次（此时 dsh 还没起来，清理必然早于首次导航）；
///   首轮可能撞上 WebView2 尚未就绪，因此带**有界重试**（最多 6 次 × 500ms），
///   只有 `cookies()` 读成功才算"启动清理完成"。
/// - 之后每次 authority 变化再清一次（长时间运行 + 多次重启服务的卫生措施）。
/// - 整段用 `catch_unwind` 包住：wry 会对 profile 里每条 cookie 调
///   `CookieBuilder::build()`，panic 会打死所在线程（比 431 更糟）。
fn spawn_auth_cookie_janitor(app: &AppHandle) {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    if AUTH_COOKIE_JANITOR.set(tx).is_err() {
        return; // 已经启动过
    }
    let janitor_app = app.clone();
    std::thread::spawn(move || {
        let mut first = true;
        while rx.recv().is_ok() {
            let attempts = if first { 6 } else { 1 };
            for attempt in 0..attempts {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    prune_stale_auth_cookies(&janitor_app)
                }));
                match result {
                    Ok((before, deleted, remaining)) => {
                        if first && before == 0 && deleted == 0 && remaining == 0 {
                            // 可能是 WebView2 未就绪（cookies() 失败）——再试；
                            // 真正"干净"的情况也在最后一次尝试后放行。
                            if attempt + 1 < attempts {
                                std::thread::sleep(std::time::Duration::from_millis(500));
                                continue;
                            }
                        }
                        break;
                    }
                    Err(_) => {
                        let data = janitor_app
                            .path()
                            .app_data_dir()
                            .unwrap_or_else(|_| std::path::PathBuf::from("."));
                        log_line(&data, "dsh-auth cookies: prune panicked (caught)");
                        break;
                    }
                }
            }
            if first {
                first = false;
                AUTH_COOKIE_PRUNE_DONE.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
    });
}

/// 请求一次清理（非阻塞）。janitor 未启动时静默返回（不应发生）。
fn request_auth_cookie_prune() {
    if let Some(tx) = AUTH_COOKIE_JANITOR.get() {
        let _ = tx.send(());
    }
}

/// server-url 分支用：等到"启动清理已完成"（有界，最多 3s）。
/// 正常路径下 janitor 早就完成（dsh 启动需 ≥2s，清理是 ms 级），等待几乎零成本。
fn wait_for_startup_auth_prune() {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !AUTH_COOKIE_PRUNE_DONE.load(std::sync::atomic::Ordering::SeqCst) {
        if std::time::Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

/// 主窗口若停在 dsh 页则退回启动页（故障披露 + 重试入口）。
fn navigate_back_to_launcher(app: &AppHandle) {
    let Some(cur) = app.get_webview_window("main").and_then(|w| w.url().ok()) else {
        return;
    };
    let is_dsh = cur.scheme() == "http"
        && cur
            .host_str()
            .map(|h| h == "127.0.0.1" || h == "localhost")
            .unwrap_or(false);
    if !is_dsh {
        return;
    }
    if let Some(url) = LAUNCHER_URL.lock().unwrap().clone() {
        if let Ok(u) = tauri::Url::parse(&url) {
            if is_shell_local_url(&u) {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.navigate(u);
                }
            }
        }
    }
}

/// manager 是否真的还活着：以 `try_wait` 为准（句柄在手，权威、零依赖）。
/// 修 bug ①（2026-09-09）：旧实现用 `child.is_some()` 判活，manager 死后
/// Child 从不清空 → UI 永远看到 hasServer=true，分不清死活。
fn manager_alive(state: &ServerState) -> bool {
    let mut child = state.child.lock().unwrap();
    match child.as_mut() {
        Some(c) => !matches!(c.try_wait(), Ok(Some(_))),
        None => false,
    }
}

/// 取 manager 退出码：stdout EOF 可能比进程真正退出早几毫秒，故有界轮询。
/// 世代号变化（意图停止 / 新 manager 已起）立即放弃，避免把新世代的结果
/// 记到旧世代头上。
fn wait_exit_code(state: &ServerState, generation: u64, timeout: std::time::Duration) -> Option<i32> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if state.guard.lock().unwrap().generation != generation {
            return None;
        }
        {
            let mut child = state.child.lock().unwrap();
            if let Some(c) = child.as_mut() {
                if let Ok(Some(status)) = c.try_wait() {
                    return status.code();
                }
            }
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// 该世代是否仍需要上报退出（世代匹配、非意图停止、尚未登记）。
fn exit_report_pending_locked(guard: &ManagerGuard, generation: u64) -> bool {
    guard.generation == generation && !guard.intentional && guard.reported_generation != generation
}

fn exit_report_pending(state: &ServerState, generation: u64) -> bool {
    exit_report_pending_locked(&state.guard.lock().unwrap(), generation)
}

/// manager 退出处理：**只检测 + 取证 + 提示，绝不自动重启**（决定 D1）。
/// 两条检测路径（stdout EOF / 看护线程）竞争同一世代号，先到者登记，后到者
/// 空转（`reported_generation` 幂等）。自动重启会掩盖复现并污染证据。
fn handle_manager_exit(app: &AppHandle, generation: u64, detected_by: &str) {
    if manager_guard::shutting_down() {
        return; // 壳正在退出，manager 下线是预期行为
    }
    let state = app.state::<ServerState>();
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    if !exit_report_pending(&state, generation) {
        return; // 意图停止 / 旧世代 / 已登记
    }
    let code = wait_exit_code(&state, generation, std::time::Duration::from_secs(3));
    if code.is_none() && manager_alive(&state) {
        // 罕见：stdout 已关闭但进程仍在跑（manager 的 stdout 管道由它自己
        // 持有，正常退出才会 EOF）。不占用上报槽位，交给看护线程继续观察。
        log_line(
            &data_dir,
            &format!("manager stdout EOF but process still alive (gen={generation}, by={detected_by})"),
        );
        return;
    }
    // 重新确认并原子登记：两条检测路径可能同时走到这里，也可能期间被 stop_child
    // 抢走世代号。
    let pid = {
        let mut guard = state.guard.lock().unwrap();
        if !exit_report_pending_locked(&guard, generation) {
            return;
        }
        guard.reported_generation = generation;
        guard.phase = MgrPhase::Down;
        guard.pid
    };
    let mut exit = ManagerExit {
        generation,
        pid,
        code,
        hex: manager_guard::hex_code(code),
        at: manager_guard::now_unix(),
        detected_by: detected_by.to_string(),
        evidence_dir: None,
    };
    let runtime = runtime_dir(app);
    let webview_url = app
        .get_webview_window("main")
        .and_then(|w| w.url().ok())
        .map(|u| u.to_string());
    let input = manager_guard::EvidenceInput {
        runtime: &runtime,
        data_dir: &data_dir,
        exit: &exit,
        shell_uptime_secs: manager_guard::now_unix().saturating_sub(state.shell_started_at),
        webview_url,
        version: env!("CARGO_PKG_VERSION"),
    };
    exit.evidence_dir = manager_guard::collect_evidence(&input).map(|p| p.display().to_string());
    let described = manager_guard::describe_exit(code);
    let summary = match &exit.evidence_dir {
        Some(dir) => format!("服务异常退出（{described}）——证据已保存到 {dir}"),
        None => format!("服务异常退出（{described}）——证据目录写入失败，完整日志见数据目录"),
    };
    *state.last_error.lock().unwrap() = Some(summary.clone());
    state.guard.lock().unwrap().last_exit = Some(exit.clone());
    log_line(
        &data_dir,
        &format!(
            "manager exit: gen={generation} pid={pid} code={code:?} detectedBy={detected_by} evidence={:?}",
            exit.evidence_dir
        ),
    );
    eprintln!("[dsh-desktop] manager exit: gen={generation} pid={pid} code={code:?} detectedBy={detected_by}");
    let _ = app.emit(
        "manager-exit",
        serde_json::json!({
            "generation": exit.generation,
            "pid": exit.pid,
            "code": exit.code,
            "hex": exit.hex,
            "at": exit.at,
            "detectedBy": exit.detected_by,
            "evidenceDir": exit.evidence_dir,
            "summary": summary,
            "upgrade": upgrade_marker_json(app),
        }),
    );
    let _ = app.emit("server-down", ());
    *LIVE_DSH_URL.lock().unwrap() = None;
    navigate_back_to_launcher(app);
}

/// manager 看护线程：每 2s `try_wait` 一次。stdout EOF 是快路径，但孙进程继承
/// stdout 管道时 EOF 可能永不出现；`try_wait` 才是权威信号。检测到非意图退出
/// 即走 handle_manager_exit（取证 + 提示），**不重启**（D1）。
fn start_manager_watchdog(app: &AppHandle, generation: u64) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(2));
        if manager_guard::shutting_down() {
            return;
        }
        {
            let state = app.state::<ServerState>();
            if !exit_report_pending(&state, generation) {
                return; // 已由 stop_child / 另一条检测路径处理
            }
        }
        let exited = {
            let state = app.state::<ServerState>();
            let mut child = state.child.lock().unwrap();
            match child.as_mut() {
                Some(c) => matches!(c.try_wait(), Ok(Some(_))),
                None => false,
            }
        };
        if exited {
            handle_manager_exit(&app, generation, "watchdog");
            return;
        }
    });
}

/// dsh web 挂起探测间隔（秒）。
const HANG_PROBE_SECS: u64 = 3;
/// 连续 miss 达到该值 → 抓 dump（约 9 秒无响应）。
const HANG_MISS_LIMIT: u32 = 3;
/// 新 URL 到达后的启动宽限（秒）：启动/重载期慢响应不算挂起（与 L3 风暴同类误判）。
const HANG_STARTUP_GRACE_SECS: u64 = 30;
/// 保留最近几份挂起 dump（全内存 dump 体积大）。
const HANG_DUMP_KEEP: usize = 3;

/// dsh web 挂起看护：**只探测 + dump，不 kill、不重启**（决定 D1）。挂起是唯一
/// 还能拿到内存现场的故障（被杀进程地址空间已销毁）。manager 的 watchdog 负责
/// 恢复，壳负责现场；两者同时触发时 manager 会先等一段宽限再重启（见 manager）。
fn start_hang_watchdog(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let data = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from("."));
        let mut misses = 0u32;
        let mut current: Option<String> = None;
        let mut armed_at = std::time::Instant::now();
        let mut dumped_for: Option<String> = None;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(HANG_PROBE_SECS));
            if manager_guard::shutting_down() {
                return;
            }
            let Some(url) = LIVE_DSH_URL.lock().unwrap().clone() else {
                misses = 0;
                current = None;
                continue;
            };
            if current.as_deref() != Some(url.as_str()) {
                // 新 URL（首启 / manager 重启 / dsh web 重生）：重置计数并进入
                // 启动宽限。
                current = Some(url.clone());
                armed_at = std::time::Instant::now();
                misses = 0;
                dumped_for = None;
                continue;
            }
            if armed_at.elapsed() < std::time::Duration::from_secs(HANG_STARTUP_GRACE_SECS) {
                continue;
            }
            if web_dump::probe_url(&url, std::time::Duration::from_millis(1500)) {
                if misses > 0 {
                    log_line(&data, &format!("dsh web probe recovered after {misses} miss(es)"));
                }
                misses = 0;
                continue;
            }
            let before = misses;
            misses = (misses + 1).min(HANG_MISS_LIMIT);
            if misses != before {
                log_line(&data, &format!("dsh web probe miss {misses}/{HANG_MISS_LIMIT}"));
            }
            if misses >= HANG_MISS_LIMIT && dumped_for.as_deref() != Some(url.as_str()) {
                dumped_for = Some(url.clone());
                let app2 = app.clone();
                std::thread::spawn(move || dump_dsh_web(&app2, &url));
            }
        }
    });
}

/// 抓一份 dsh web 的挂起 dump 并披露。**同一 URL 只抓一次**，且认领与回执分离：
/// 壳内 watchdog 与 manager 的 dump-web 请求几乎同时到达，先到者抓、后到者直接
/// 返回；**只有抓完的那条路径回 dump-done**，否则 manager 会在 dump 写盘前就重启
/// （实测：进程先被杀，OpenProcess 报 0x80070057，现场归零）。
fn dump_dsh_web(app: &AppHandle, url: &str) {
    let runtime = runtime_dir(app);
    let data = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let claim = {
        let state = app.state::<ServerState>();
        let mut slot = state.hang_dump.lock().unwrap();
        match &*slot {
            HangDump::Done(u) if u == url => false,
            HangDump::InProgress(u) if u == url => false,
            _ => {
                *slot = HangDump::InProgress(url.to_string());
                true
            }
        }
    };
    if !claim {
        // 已有同一 URL 的 dump（进行中或已完成）：不重复抓，也**不回执**——
        // 抓完的那条路径会回执（若它已经回过，manager 侧也已记录）。
        log_line(&data, "dsh web hang: dump already claimed for this url");
        return;
    }
    let finish = |app: &AppHandle| {
        {
            let state = app.state::<ServerState>();
            let mut slot = state.hang_dump.lock().unwrap();
            *slot = HangDump::Done(url.to_string());
        }
        ack_dump_done(app);
    };
    let Some(pid) = web_dump::dsh_web_pid_for_url(url, &runtime) else {
        log_line(&data, "dsh web hang: cannot locate pid for the live url");
        finish(app);
        return;
    };
    let reports = runtime.join("reports");
    let _ = std::fs::create_dir_all(&reports);
    let out = reports.join(format!("dshweb-hang-{}-{}.dmp", pid, manager_guard::now_unix()));
    let path = out.display().to_string();
    log_line(&data, &format!("dsh web hang: dumping pid {pid} -> {path}"));
    let summary = match web_dump::dump_process(pid, &out) {
        Ok(bytes) => {
            log_line(&data, &format!("dsh web hang: dump saved {path} ({bytes} bytes)"));
            format!(
                "dsh web 无响应（已保存现场 dump：{path}，{} MiB）——若服务未自行恢复，点「重启服务」",
                bytes / (1024 * 1024)
            )
        }
        Err(e) => {
            log_line(&data, &format!("dsh web hang: dump FAILED for pid {pid}: {e}"));
            format!("dsh web 无响应，且现场 dump 失败（{e}）——点「重启服务」恢复")
        }
    };
    *app.state::<ServerState>().last_error.lock().unwrap() = Some(summary.clone());
    let _ = app.emit(
        "web-hang",
        serde_json::json!({ "pid": pid, "dump": path, "summary": summary }),
    );
    web_dump::prune_dumps(&reports, "dshweb-hang-", HANG_DUMP_KEEP);
    finish(app);
}

/// 告诉 manager 现场已抓完（成功、失败或早已抓过都要回执，否则它会等满上限）。
fn ack_dump_done(app: &AppHandle) {
    let state = app.state::<ServerState>();
    send_line(&mut state.stdin.lock().unwrap(), r#"{"cmd":"dump-done"}"#);
}

/// 壳健康状态（chrome 故障条幅轮询 / 启动页）：最近故障摘要 + manager 真实
/// 存活 + 最近一次退出的退出码与证据目录。
fn shell_status_json(app: &AppHandle, state: &ServerState) -> serde_json::Value {
    let last_error = state.last_error.lock().unwrap().clone();
    let alive = manager_alive(state);
    let (phase, pid, last_exit) = {
        let guard = state.guard.lock().unwrap();
        (guard.phase.as_str(), guard.pid, guard.last_exit.clone())
    };
    serde_json::json!({
        "lastError": last_error,
        // hasServer 保留给既有调用方；语义已修正为"真的还活着"（bug ①）。
        "hasServer": alive,
        "managerAlive": alive,
        "managerPid": pid,
        "managerPhase": phase,
        "lastManagerExit": last_exit.map(|e| serde_json::json!({
            "generation": e.generation,
            "pid": e.pid,
            "code": e.code,
            "hex": e.hex,
            "at": e.at,
            "detectedBy": e.detected_by,
            "evidenceDir": e.evidence_dir,
            "summary": manager_guard::describe_exit(e.code),
            // 升级归因（S9）：启动页读的是本结构（get_shell_status / 桥 /shell/status），
            // 不是 manager-exit 事件负载 —— 只加到 emit 上等于死代码（2026-09-25 dev 实测：
            // 标记文件在、失败态却没有任何升级文案）。
            "upgrade": upgrade_marker_json(app),
        })),
    })
}

/// Restart the service (used by the tray and the launcher's retry button).
#[tauri::command]
fn restart_server(app: AppHandle, state: State<'_, ServerState>) -> Result<(), String> {
    stop_child(&state);
    start_server(&app)
}

/// Open a directory in the platform file manager.
fn open_dir(dir: &std::path::Path) -> Result<(), String> {
    #[cfg(windows)]
    let res = Command::new("explorer").arg(dir).status();
    #[cfg(target_os = "macos")]
    let res = Command::new("open").arg(dir).status();
    #[cfg(target_os = "linux")]
    let res = Command::new("xdg-open").arg(dir).status();
    res.map(|_| ()).map_err(|e| format!("open dir: {e}"))
}

/// Open the dsh data directory in the platform file manager.
#[tauri::command]
fn open_data_dir(app: AppHandle) -> Result<(), String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    std::fs::create_dir_all(&data).map_err(|e| format!("mkdir: {e}"))?;
    open_dir(&data)
}

/// 打开最近一次 manager 故障的证据目录（无故障记录时打开 reports 根目录）。
/// chrome 故障条幅的「打开证据目录」按钮走这里（IPC / 环回桥双通道）。
#[tauri::command]
fn open_evidence_dir(app: AppHandle) -> Result<(), String> {
    let state = app.state::<ServerState>();
    let latest = state
        .guard
        .lock()
        .unwrap()
        .last_exit
        .as_ref()
        .and_then(|e| e.evidence_dir.clone());
    let dir = latest
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| runtime_dir(&app).join("reports"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    open_dir(&dir)
}

/// Current proxy configuration + the settings panel's candidate host lists.
/// `upstream`/`proxiedHosts`/`knownHosts` come from proxy.json (persisted);
/// `hosts`/`providers` are mirrored live from the manager (observed traffic +
/// settings.yaml providers) so the checkbox list reflects reality.
#[tauri::command]
fn get_proxy_config(app: AppHandle, state: State<'_, ServerState>) -> Result<serde_json::Value, String> {
    let runtime = runtime_dir(&app);
    let cfg = read_proxy_json(&runtime);
    let proxy = state.proxy.lock().unwrap();
    Ok(serde_json::json!({
        "upstream": cfg.get("upstream").cloned().unwrap_or_else(|| serde_json::json!({})),
        "proxiedHosts": cfg.get("proxiedHosts").cloned().unwrap_or_else(|| serde_json::json!([])),
        "knownHosts": cfg.get("knownHosts").cloned().unwrap_or_else(|| serde_json::json!([])),
        "hosts": proxy.hosts,
        "providers": proxy.providers,
    }))
}

/// Persist the proxy configuration from the settings panel. Takes effect
/// immediately: the built-in proxy re-reads proxy.json on every request, so no
/// dsh restart is needed.
#[tauri::command]
fn set_proxy_config(
    app: AppHandle,
    upstream: serde_json::Value,
    proxied_hosts: Vec<String>,
) -> Result<serde_json::Value, String> {
    let runtime = runtime_dir(&app);
    let path = proxy_config_path(&runtime);
    let mut cfg = read_proxy_json(&runtime);
    // Clean each host: trim, lowercase, drop a trailing comma (a historical
    // "api.xxx.com," never matches the real CONNECT target and silently breaks
    // routing — never let it back into proxy.json).
    let hosts: Vec<serde_json::Value> = proxied_hosts
        .iter()
        .filter_map(|h| {
            let t = h.trim().to_lowercase().trim_end_matches(',').trim().to_string();
            if t.is_empty() { None } else { Some(serde_json::Value::String(t)) }
        })
        .collect();
    cfg["upstream"] = sanitize_upstream(&upstream);
    cfg["proxiedHosts"] = serde_json::Value::Array(hosts);
    let text = serde_json::to_string_pretty(&cfg).map_err(|e| format!("serialize proxy config: {e}"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir proxy dir: {e}"))?;
    }
    std::fs::write(&path, format!("{text}\n")).map_err(|e| format!("write proxy config: {e}"))?;
    Ok(cfg)
}

/// Open (or focus) the standalone proxy settings window. Never interrupts the
/// main window's dsh page — settings live in their own window, reachable from
/// the window menu bar and the tray whether or not dsh is loaded.
fn open_settings_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = tauri::WebviewWindowBuilder::new(app, "settings", tauri::WebviewUrl::App("settings.html".into()))
        .title(format!("{} — 代理设置", app.package_info().name))
        .inner_size(680.0, 720.0)
        .min_inner_size(520.0, 560.0)
        .resizable(true)
        .center()
        .build();
}

/// Inject the shell chrome (custom title bar + menu bar) into the MAIN
/// webview on every page load. Works on both the launcher page
/// (tauri://localhost, has __TAURI__) and the remote dsh page
/// (http://127.0.0.1:*, no __TAURI__ — the chrome falls back to the loopback
/// bridge). Skipped for the settings window, which keeps its native frame.
/// The preamble bakes in the shell version and the bridge port (the bridge is
/// started in setup before any page can load, but port 0 is tolerated — the
/// launcher page uses IPC anyway).
fn inject_shell_chrome(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let mut prefix = format!(
        "window.__DSH_SHELL_VERSION__={};window.__DSH_PRODUCT_NAME__={};window.__DSH_BUILD_DATE__={};window.__DSH_TITLEBAR_CONTRACT__={}",
        serde_json::to_string(env!("CARGO_PKG_VERSION")).unwrap_or_else(|_| "\"\"".into()),
        serde_json::to_string(app.package_info().name.as_str())
            .unwrap_or_else(|_| "\"DSH Smoothly Desktop\"".into()),
        serde_json::to_string(env!("DSH_BUILD_DATE")).unwrap_or_else(|_| "\"\"".into()),
        if titlebar_contract(&runtime_dir(app)) { "true" } else { "false" }
    );
    // 真实应用图标：打包进二进制的 logo.png → data URI，顶栏按钮与下拉品牌项使用
    // （页面 origin 无 img 权限问题，跨 tauri:// 也不会被第三方 CSP 拦）。
    let logo_uri = format!("data:image/png;base64,{}", b64(include_bytes!("../../src/logo.png")));
    prefix.push_str(&format!(
        ";window.__DSH_LOGO__={}",
        serde_json::to_string(&logo_uri).unwrap_or_else(|_| "\"\"".into())
    ));
    let port = BRIDGE_PORT.load(std::sync::atomic::Ordering::SeqCst);
    if port > 0 {
        // 契约：client-notifications 插件的 BRIDGE_PORT 用 startsWith('__DSH')
        // 判 token，且 manager 只替换带引号字面量、保留 globalThis 读取路径
        // 给外部注入者——因此这里必须以字符串注入（JSON 引号），数字字面量
        // 会让 globalThis.__DSH_BRIDGE_PORT__ 为 number → startsWith 崩溃。
        prefix.push_str(&format!(
            ";window.__DSH_BRIDGE_PORT__={}",
            serde_json::to_string(&port.to_string()).unwrap_or_else(|_| "\"0\"".into())
        ));
    }
    let _ = w.eval(format!("(()=>{{{prefix};{SHELL_CHROME}}})()"));
}

// ── proxy connection test (settings window "测试连接") ────────────────────────
/// Basic base64 (RFC 4648, no padding variants) — avoids a crate for one use.
fn b64(input: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        out.push(TABLE[(b[0] >> 2) as usize] as char);
        out.push(TABLE[(((b[0] & 0x03) << 4) | (b[1] >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[(((b[1] & 0x0f) << 2) | (b[2] >> 6)) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(b[2] & 0x3f) as usize] as char } else { '=' });
    }
    out
}

fn read_n(stream: &mut std::net::TcpStream, n: usize) -> Result<Vec<u8>, String> {
    let mut buf = vec![0u8; n];
    let mut got = 0;
    while got < n {
        match stream.read(&mut buf[got..]) {
            Ok(0) => return Err("上游提前关闭连接".into()),
            Ok(k) => got += k,
            Err(e) => return Err(format!("读取失败: {e}")),
        }
    }
    Ok(buf)
}

fn read_line(stream: &mut std::net::TcpStream) -> Result<String, String> {
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => {
                line.push(byte[0]);
                if line.ends_with(b"\n") { break; }
            }
            Err(e) => return Err(format!("读取失败: {e}")),
        }
    }
    Ok(String::from_utf8_lossy(&line).to_string())
}

/// Verify the configured upstream proxy is reachable and speaks its protocol.
/// HTTP/HTTPS: send a CONNECT probe (1.1.1.1:443); SOCKS5: handshake + CONNECT.
/// HTTPS upstreams can't be TLS-verified without a TLS crate — TCP reachability
/// is the honest signal available.
#[tauri::command]
fn test_proxy(upstream: serde_json::Value) -> Result<serde_json::Value, String> {
    let u = sanitize_upstream(&upstream);
    let host = u.get("host").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let port = u.get("port").and_then(|x| x.as_u64()).unwrap_or(0) as u16;
    let protocol = u.get("protocol").and_then(|x| x.as_str()).unwrap_or("http").to_string();
    let username = u.get("username").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let password = u.get("password").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if host.is_empty() || port == 0 {
        return Ok(serde_json::json!({ "ok": false, "detail": "请先填写代理主机和端口" }));
    }
    let addr = format!("{host}:{port}");
    let mut stream = match std::net::TcpStream::connect_timeout(
        &addr.parse().map_err(|e| format!("地址无效: {e}"))?,
        std::time::Duration::from_secs(5),
    ) {
        Ok(s) => s,
        Err(e) => return Ok(serde_json::json!({ "ok": false, "detail": format!("无法连接 {addr}: {e}") })),
    };
    stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).map_err(|e| format!("set timeout: {e}"))?;
    stream.set_write_timeout(Some(std::time::Duration::from_secs(5))).map_err(|e| format!("set timeout: {e}"))?;

    match protocol.as_str() {
        "socks5" => {
            let has_auth = !username.is_empty();
            if has_auth {
                stream.write_all(&[0x05, 0x02, 0x00, 0x02]).map_err(|e| format!("write: {e}"))?;
            } else {
                stream.write_all(&[0x05, 0x01, 0x00]).map_err(|e| format!("write: {e}"))?;
            }
            let resp = read_n(&mut stream, 2)?;
            if resp[0] != 0x05 { return Ok(serde_json::json!({ "ok": false, "detail": format!("SOCKS5 版本异常 ({})", resp[0]) })); }
            match resp[1] {
                0xff => return Ok(serde_json::json!({ "ok": false, "detail": "上游无可用认证方式" })),
                0x02 => {
                    let user = username.as_bytes();
                    let pass = password.as_bytes();
                    let mut auth = vec![0x01, user.len() as u8];
                    auth.extend_from_slice(user);
                    auth.push(pass.len() as u8);
                    auth.extend_from_slice(pass);
                    stream.write_all(&auth).map_err(|e| format!("write: {e}"))?;
                    let ar = read_n(&mut stream, 2)?;
                    if ar[0] != 0x01 || ar[1] != 0x00 {
                        return Ok(serde_json::json!({ "ok": false, "detail": "SOCKS5 认证失败" }));
                    }
                }
                _ if resp[1] != 0x00 => return Ok(serde_json::json!({ "ok": false, "detail": format!("不支持的认证方式 ({})", resp[1]) })),
                _ => {}
            }
            // CONNECT 1.1.1.1:443 (IPv4 atyp=1, port 0x01bb)
            stream.write_all(&[0x05, 0x01, 0x00, 0x01, 1, 1, 1, 1, 0x01, 0xbb]).map_err(|e| format!("write: {e}"))?;
            let cr = read_n(&mut stream, 4)?;
            if cr[0] != 0x05 || cr[1] != 0x00 {
                return Ok(serde_json::json!({ "ok": false, "detail": format!("SOCKS5 CONNECT 失败 (code {})", cr[1]) }));
            }
            let _ = read_n(&mut stream, 6)?; // BND.ADDR/PORT (IPv4)
            Ok(serde_json::json!({ "ok": true, "detail": "SOCKS5 握手成功，可转发" }))
        }
        "https" => {
            // No TLS crate in this shell: TCP reachability is what we can verify.
            Ok(serde_json::json!({ "ok": true, "detail": "端口已连通（HTTPS 代理的 TLS 握手未验证）" }))
        }
        _ => {
            // http proxy: CONNECT probe through the upstream.
            let target = "1.1.1.1:443";
            let mut req = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
            if !username.is_empty() {
                let token = b64(format!("{username}:{password}").as_bytes());
                req.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
            }
            req.push_str("\r\n");
            stream.write_all(req.as_bytes()).map_err(|e| format!("write: {e}"))?;
            let status = read_line(&mut stream)?;
            loop {
                let l = read_line(&mut stream)?;
                if l.trim().is_empty() { break; }
            }
            if status.starts_with("HTTP/1.") && status.contains(" 2") {
                Ok(serde_json::json!({ "ok": true, "detail": "上游代理可转发（CONNECT 2xx）" }))
            } else if status.contains("407") {
                Ok(serde_json::json!({ "ok": false, "detail": "上游要求认证（407）" }))
            } else {
                Ok(serde_json::json!({ "ok": false, "detail": format!("上游响应异常: {}", status.trim()) }))
            }
        }
    }
}

/// Quit: kill the service tree and exit the app.
#[tauri::command]
fn quit_app(app: AppHandle, state: State<'_, ServerState>) -> Result<(), String> {
    // 先置退出标志：manager 下线是预期行为，看护线程不得写成"异常退出"。
    manager_guard::mark_shutting_down();
    stop_child(&state);
    app.exit(0);
    Ok(())
}

/// Current dsh update status (launcher page banner / console).
#[tauri::command]
fn get_update_status(state: State<'_, ServerState>) -> serde_json::Value {
    let s = state.update.lock().unwrap();
    // op 镜像（manager op-status）：更新失败时 UI 需要看到 error，而不是
    // 只看远端版本号产生"升级成功"的错觉。
    let op = state.op.lock().unwrap();
    serde_json::json!({
        "current": s.current,
        "latest": s.latest,
        "updateAvailable": s.update_available,
        "next": s.next,
        "nextTag": s.next_tag,
        "nextAvailable": s.next_available,
        "op": {
            "op": op.op,
            "done": op.done,
            "ok": op.ok,
            "error": op.error,
        },
    })
}

/// Ask the manager to re-check the registry for a newer dsh.
#[tauri::command]
fn check_update(state: State<'_, ServerState>) -> Result<(), String> {
    send_manager(&mut state.stdin.lock().unwrap(), "check-update");
    Ok(())
}

/// 壳自更新状态（A-1）：只读查询，与 dsh 更新状态完全分开。
#[tauri::command]
fn get_shell_update_status(state: State<'_, ServerState>) -> serde_json::Value {
    let s = state.shell_update.lock().unwrap();
    serde_json::json!({
        "current": s.current,
        "latest": s.latest,
        "hasUpdate": s.has_update,
        "url": s.url,
        "error": s.error,
        "dev": s.dev,
    })
}

/// 触发壳更新检查（manager 侧查 GitHub Releases；只报告，不下载/不安装）。
#[tauri::command]
fn check_shell_update(state: State<'_, ServerState>) -> Result<(), String> {
    send_manager(&mut state.stdin.lock().unwrap(), "check-shell-update");
    Ok(())
}

/// One-click: install the newest dsh, then restart the service.
#[tauri::command]
fn update_now(state: State<'_, ServerState>, version: Option<String>) -> Result<(), String> {
    // 可选目标版本：启动页的「回退到 vX」用它装回升级前的版本（S9）。
    // 菜单路径不传 → None → manager 用 dist-tags.latest。
    match version.filter(|v| !v.trim().is_empty()) {
        Some(v) => send_line(
            &mut state.stdin.lock().unwrap(),
            &serde_json::json!({ "cmd": "update-dsh", "version": v }).to_string(),
        ),
        None => send_manager(&mut state.stdin.lock().unwrap(), "update-dsh"),
    }
    Ok(())
}

/// Reload the WebView (picks up edited client bundles — served no-cache).
#[tauri::command]
fn refresh_page(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.reload();
    }
    Ok(())
}

/// Restart only the dsh web process (no registry check, no plugin reinstall).
#[tauri::command]
fn restart_dsh(state: State<'_, ServerState>) -> Result<(), String> {
    send_manager(&mut state.stdin.lock().unwrap(), "restart-dsh");
    Ok(())
}

/// Flip dsh.json devMode, mirroring the tray checkbox, with a toast
/// confirming the change. Shared by the tray, the IPC command, and the bridge
/// endpoint so the three surfaces never drift.
fn toggle_dev_mode_impl(app: &AppHandle) -> Result<serde_json::Value, String> {
    let runtime = runtime_dir(app);
    let on = dev_mode(&runtime);
    set_dev_mode(&runtime, !on)?;
    if let Some(item) = app.state::<ServerState>().dev_item.lock().unwrap().as_ref() {
        let _ = item.set_checked(!on);
    }
    show_toast(
        app,
        "开发者模式".into(),
        if !on {
            "已开启（dsh 更新冻结、devtools 可用），重启服务后生效".into()
        } else {
            "已关闭，重启服务后生效".into()
        },
    );
    Ok(serde_json::json!({ "devMode": !on }))
}

/// Window control for the custom (frameless) title bar: minimize /
/// toggle-maximize / close / state / drag. `close` keeps the existing
/// close-to-tray semantics (CloseRequested → prevent + hide).
#[tauri::command]
fn window_control(app: AppHandle, action: String) -> Result<serde_json::Value, String> {
    // 诊断：IPC 路径到达证据（桥路径已另有 bridge: 行）。
    log_line(&app_data_dir(&app), &format!("ipc: window_control {action}"));
    let w = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let is_max = || w.is_maximized().unwrap_or(false);
    match action.as_str() {
        "minimize" => {
            w.minimize().map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "ok": true }))
        }
        "toggle-maximize" => {
            let on = is_max();
            if on {
                w.unmaximize().map_err(|e| e.to_string())?;
            } else {
                w.maximize().map_err(|e| e.to_string())?;
            }
            Ok(serde_json::json!({ "ok": true, "maximized": !on }))
        }
        "close" => {
            w.close().map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "ok": true }))
        }
        "state" => Ok(serde_json::json!({ "ok": true, "maximized": is_max() })),
        "drag" => {
            w.start_dragging().map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "ok": true }))
        }
        other => Err(format!("unknown window action: {other}")),
    }
}

/// Shell state for the chrome menu bar: shell version, dev mode, and the dsh
/// update status mirrored from the manager.
#[tauri::command]
fn get_shell_state(app: AppHandle, state: State<'_, ServerState>) -> serde_json::Value {
    let upd = state.update.lock().unwrap();
    // liveUrl：当前 dsh web 完整地址（含 token）。launcher 页用它做导航兜底——
    // WebView2 冷启动时首次 server-url 的 navigate 可能丢（黑屏根因），页面
    // 自己轮询跳转不受窗口初始化时序影响。
    let live_url = LIVE_DSH_URL.lock().unwrap().clone();
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "liveUrl": live_url,
        "devMode": dev_mode(&runtime_dir(&app)),
        "gpu": gpu_accel(&runtime_dir(&app)),
        "titlebarContract": titlebar_contract(&runtime_dir(&app)),
        "preinstalled": preinstalled_versions(&runtime_dir(&app)),
        "update": {
            "current": upd.current,
            "latest": upd.latest,
            "updateAvailable": upd.update_available,
            "next": upd.next,
            "nextAvailable": upd.next_available,
        },
    })
}

/// Chrome menu bar checkbox: toggle dev mode (see toggle_dev_mode_impl).
#[tauri::command]
fn toggle_dev_mode(app: AppHandle) -> Result<serde_json::Value, String> {
    toggle_dev_mode_impl(&app)
}

/// IPC: 切换顶栏契约（壳菜单 checkbox）。刷新页面生效。
#[tauri::command]
fn toggle_titlebar_contract(app: AppHandle) -> Result<serde_json::Value, String> {
    toggle_titlebar_contract_impl(&app)
}

/// Toggle GPU acceleration (see toggle_gpu_accel_impl).
#[tauri::command]
fn toggle_gpu_accel(app: AppHandle) -> Result<serde_json::Value, String> {
    toggle_gpu_accel_impl(&app)
}

/// Chrome menu bar entry: open (or focus) the proxy settings window.
#[tauri::command]
fn open_settings(app: AppHandle) -> Result<(), String> {
    open_settings_window(&app);
    Ok(())
}

/// 壳健康状态（chrome 故障条幅轮询用）：最近故障摘要 + manager 真实存活 +
/// 最近一次退出的退出码/证据目录。见 shell_status_json。
#[tauri::command]
fn get_shell_status(app: AppHandle, state: State<'_, ServerState>) -> serde_json::Value {
    shell_status_json(&app, &state)
}

/// 安全网：把 web profile 的 bundle 列表回退到 dsh 自带的模板两层，并备份原 manifest。
///
/// 0.1.6-alpha.2 起插件管理交给 dsh 的 Web 侧边栏 Plugins 页，壳内不再有插件管理
/// UI；但那个页面本身要 dsh 能起来才能用。第三方插件把 dsh 启动搞崩时，用户需要
/// 一个不依赖 dsh 的逃生口（上游 Electron 桌面端同样保留"Host 起不来也能停用
/// 第三方 bundle"的能力）。备份失败即中止，绝不在没有备份的情况下改动用户文件。
#[tauri::command]
fn disable_third_party_plugins(app: AppHandle) -> Result<serde_json::Value, String> {
    let runtime = runtime_dir(&app);
    let path = profile_manifest_path(&runtime);
    let current = web_profile_bundles(&runtime);
    let removed: Vec<String> = current
        .iter()
        .filter(|b| !WEB_PROFILE_TEMPLATE.contains(&b.as_str()))
        .cloned()
        .collect();
    if removed.is_empty() {
        return Ok(serde_json::json!({ "ok": true, "changed": false, "removed": [] }));
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup = path.with_file_name(format!("package.json.bak-disable-plugins-{stamp}"));
    std::fs::copy(&path, &backup).map_err(|e| format!("备份 profile manifest 失败：{e}"))?;
    let template: Vec<String> = WEB_PROFILE_TEMPLATE.iter().map(|s| s.to_string()).collect();
    write_web_profile_bundles(&runtime, &template)?;
    // 区分"随壳自带的预装插件"与"用户自己装的"：前者停用后仍留在 runtime 里，
    // 后者是用户资产，界面据此给出不同的提示措辞。
    let shipped = preinstalled_names(&runtime);
    let shell_shipped: Vec<&String> = removed.iter().filter(|n| shipped.contains(n)).collect();
    let user_installed: Vec<&String> = removed.iter().filter(|n| !shipped.contains(n)).collect();
    Ok(serde_json::json!({
        "ok": true,
        "changed": true,
        "removed": removed,
        "shellShipped": shell_shipped,
        "userInstalled": user_installed,
        "backup": backup.to_string_lossy(),
    }))
}

pub fn run() {
    // ── GPU 加速开关：窗口创建前按 dsh.json webview.gpu 注入 WebView2 参数 ──
    // WebView2 的浏览器参数在创建 environment 时读取，必须在此（Builder 构建
    // 窗口之前）设置进程级环境变量；子进程继承，不影响用户全局环境。
    // 默认开启（设置页等复杂 SPA 需要 GPU 渲染流畅）；关闭 = 软件渲染，
    // 供排查"大模型执行中黑屏"类 GPU 问题（原用户级 --disable-gpu 的用途）。
    #[cfg(windows)]
    {
        let cfg: tauri::Context<tauri::Wry> = tauri::generate_context!();
        let ident = cfg.config().identifier.clone();
        let home = std::env::var_os("APPDATA").map(std::path::PathBuf::from);
        if let Some(home) = home {
            let runtime = home.join(&ident).join("runtime");
            let gpu = gpu_accel(&runtime);
            let var = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
            if gpu {
                std::env::remove_var(var);
            } else {
                std::env::set_var(var, "--disable-gpu");
            }
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        // 窗口状态记忆（位置/大小/最大化）：上次最大化关闭、下次启动还原；
        // dev/正式各自独立存储（app data 按 identifier 隔离）。
        .plugin(tauri_plugin_window_state::Builder::default()
            // settings / plugins 是工具窗：不参与窗口状态记忆（记忆恢复会在
            // 创建时覆盖 builder 的 .center()，表现为"弹窗先闪一下居中、又跳回
            // 上次的左边位置"）。主窗口仍保留位置/大小/最大化记忆。
            .with_denylist(&["settings", "confirm"])
            .build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Toast click / external activation: remember the session to
            // reopen, then bring the existing window forward. Never spawn a
            // second manager behind the same runtime.
            let last = LAST_SESSION.lock().unwrap().clone();
            let data = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            log_line(&data, &format!("activated: pending-open={last:?}"));
            eprintln!("[dsh-desktop] activated: pending-open={last:?}");
            *PENDING_OPEN.lock().unwrap() = last;
            activate_window(app);
        }))
        .manage(ServerState {
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            update: Mutex::new(UpdateStatus::default()),
            shell_update: Mutex::new(ShellUpdateStatus::default()),
            update_item: Mutex::new(None),
            dev_item: Mutex::new(None),
            gpu_item: Mutex::new(None),
            op: Mutex::new(OpStatus::default()),
            proxy: Mutex::new(ProxyState::default()),
            last_error: Mutex::new(None),
            guard: Mutex::new(ManagerGuard::default()),
            shell_started_at: manager_guard::now_unix(),
            hang_dump: Mutex::new(HangDump::Idle),
        })
        // Belt-and-suspenders for the taskbar icon: re-apply the bundled icon
        // on every page load (window existence/creation timing is not relied
        // on; see WindowConfig having no icon field in Tauri v2).
        .on_page_load(|webview, payload| {
            if webview.label() == "main" {
                let loaded = payload.url().to_string();
                *LAST_MAIN_LOADED.lock().unwrap() = Some(loaded.clone());
                // 本地启动页加载完成 = 权威的 LAUNCHER_URL（setup 时可能拿到
                // about:blank，见那里的注释）。故障后回退导航依赖它。
                if is_shell_local_url(payload.url()) {
                    *LAUNCHER_URL.lock().unwrap() = Some(loaded.clone());
                }
                let data = webview
                    .app_handle()
                    .path()
                    .app_data_dir()
                    .unwrap_or_else(|_| std::path::PathBuf::from("."));
                log_line(&data, &format!("main page load: {loaded}"));
                inject_shell_chrome(webview.app_handle());
            }
            if let Some(w) = webview.app_handle().get_webview_window("main") {
                if let Some(icon) = w.app_handle().default_window_icon() {
                    let _ = w.set_icon(icon.clone());
                }
                // 导航守卫（原 on_navigation 是 builder-only API，运行时窗口
                // 不可用）。目标：用户 back/forward 或右键跳到旧 --port 0 的
                // 死端口页时，把 webview 拉回当前 live 的 dsh 端口。Tauri 2
                // 没有运行时导航拦截，用两条可用路径：
                //  1) on_page_load：加载到 dsh 端口但 origin 不是 live → 跳回；
                //  2) 注入 pageshow/popstate 监听：bfcache 恢复不触发
                //     on_page_load，但一定触发 pageshow——覆盖"back 到死端口
                //     且从 bfcache 恢复"（原症状的直接成因）。
                // 判断按 origin（host+port），不影响 live 端口内的路由。
                let live = LIVE_DSH_URL.lock().unwrap().clone();
                let url = payload.url().to_string();
                if let Some(live_url) = live {
                    let is_dsh_like =
                        url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:");
                    let same_origin = |u: &str| {
                        tauri::Url::parse(u).ok().map(|x| x.origin().ascii_serialization())
                    };
                    if is_dsh_like && same_origin(&url) != same_origin(&live_url) {
                        if let Ok(u) = tauri::Url::parse(&live_url) {
                            let _ = w.navigate(u);
                        }
                    }
                    // Bfcache 恢复兜底（Rust 侧 on_page_load 拦不到）：
                    // 用 JSON 字面量安全注入，避免手拼字符串转义问题。
                    let live_json = serde_json::to_string(&live_url).unwrap_or_else(|_| "\"\"".into());
                    let js = format!(
                        "(()=>{{const live=JSON.parse({live_json});const fix=()=>{{const h=location.hostname;if((h==='127.0.0.1'||h==='localhost')&&location.origin!==new URL(live).origin)location.replace(live)}};window.addEventListener('pageshow',fix);window.addEventListener('popstate',fix)}})()"
                    );
                    let _ = w.eval(&js);
                }
            }
        })
        .setup(|app| {
            // ── 品牌统一数据迁移（必须最先、在任何服务启动前）────────
            // identifier 已统一为 dsh.smoothly.desktop；老版本（dev.dsh.desktop
            // 系）已装用户的旧数据目录在此整体迁入新目录，否则升级即"数据丢失"。
            migrate_legacy_data(app.handle());
            // ── 导航兜底守护线程：WebView2 冷启动时首次 server-url 的
            // navigate 会丢失（黑屏根因；launcher JS 轮询依赖 capability/
            // 时序不可靠）。Rust 侧每 2s 检查：主窗口仍在本地页（tauri:）
            // 且已有 live dsh URL → 强制导航；已到 dsh 页则不动。幂等、
            // 持续到成功，重启服务后的新 URL 也会被自动推入。
            {
                let nav_app = app.handle().clone();
                let nav_data_dir = app
                    .path()
                    .app_data_dir()
                    .unwrap_or_else(|_| std::path::PathBuf::from("."));
                std::thread::spawn(move || {
                    let mut last_nav = std::time::Instant::now()
                        .checked_sub(std::time::Duration::from_secs(60))
                        .unwrap_or(std::time::Instant::now());
                    // 有界退避：任何"页面起不来"的原因都不该变成 3s 无限重载
                    // （2026-09-20 cookie-431 事故实测 535 次 nav-fallback，
                    // 页面永远停在错误页且持续刷网络/CPU）。
                    let mut attempts: u32 = 0;
                    let mut gave_up_logged = false;
                    loop {
                        std::thread::sleep(std::time::Duration::from_millis(1500));
                        let live = LIVE_DSH_URL.lock().unwrap().clone();
                        let Some(live) = live else { continue };
                        // 以"页面真正可用"（桥收到 /alive）为准：已 alive → 成功，撒手。
                        // on_page_load/URL 层都可能"空转"（navigate 生效但 WebView 未
                        // 渲染），只有 client JS 回连才证明渲染完成。
                        if CLIENT_READY.load(std::sync::atomic::Ordering::SeqCst) {
                            // 页面已就绪：重置退避，下次故障重新从 3s 起步。
                            attempts = 0;
                            gave_up_logged = false;
                            continue;
                        }
                        let Some(w) = nav_app.get_webview_window("main") else { continue };
                        let interval = nav_fallback_interval_secs(attempts);
                        if last_nav.elapsed().as_secs() < interval {
                            continue;
                        }
                        if attempts >= NAV_FALLBACK_MAX_ATTEMPTS && !gave_up_logged {
                            gave_up_logged = true;
                            log_line(
                                &nav_data_dir,
                                &format!(
                                    "nav-fallback: giving up fast retries after {attempts} attempts (still retrying every {interval}s)"
                                ),
                            );
                        }
                        if let Ok(u) = tauri::Url::parse(&live) {
                            let _ = w.navigate(u);
                            last_nav = std::time::Instant::now();
                            attempts = attempts.saturating_add(1);
                            // 诊断：导航兜底每次实际 navigate 都留痕（session.log）
                            log_line(&nav_data_dir, &format!("nav-fallback: navigate -> {live}"));
                        }
                    }
                });
            }
            // ── process-level toast activator (Windows): makes Action Center
            // clicks relaunch the exe (`-ToastActivated`), which
            // single-instance then forwards home. Must happen before the
            // first toast can be shown.
            #[cfg(target_os = "windows")]
            {
                let data = app
                    .path()
                    .app_data_dir()
                    .unwrap_or_else(|_| std::path::PathBuf::from("."));
                // 后台线程注册：原来在 setup 主线程同步 spawn 多个 reg.exe，
                // 阻塞了 WebView 首帧（启动黑屏几秒）且闪 cmd 窗。注册必须在
                // 第一次 toast 前完成即可——后台线程毫秒级跑完，远早于用户
                // 触发任何通知。
                // identifier/productName 来自（合并后的）tauri.conf：开发版
                // （tauri.dev.conf.json）有独立 identity，与正式版互不抢注册。
                let identifier = app.config().identifier.clone();
                let product_name = app.package_info().name.clone();
                std::thread::spawn(move || match register_toast_activator(&identifier, &product_name) {
                    Ok(()) => {
                        log_line(&data, "activator registered");
                        eprintln!("[dsh-desktop] activator registered");
                    }
                    Err(e) => {
                        log_line(&data, &format!("activator register FAILED: {e}"));
                        eprintln!("[dsh-desktop] activator register FAILED: {e}");
                    }
                });
            }
            // ── window icon (taskbar): force the bundled icon explicitly — the
            // tray already uses it; this guards against OS icon-cache staleness.
            if let Some(w) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon() {
                    let _ = w.set_icon(icon.clone());
                }
                // 任务栏/Alt-Tab 标题跟随 productName（开发版区别于正式版）。
                let _ = w.set_title(app.package_info().name.as_str());
                // Capture the launcher URL for post-restart reconnection (the
                // page itself is replaced by the dsh page on the first boot).
                // Guard: at setup time the webview has not navigated yet, so
                // `w.url()` can be `about:blank` — capturing that made the
                // crash fallback navigate to a black about:blank (2026-09-09
                // real-machine verification). Only a real tauri:// page counts;
                // on_page_load updates it again with the loaded URL.
                if let Ok(u) = w.url() {
                    if is_shell_local_url(&u) {
                        *LAUNCHER_URL.lock().unwrap() = Some(u.to_string());
                    }
                }
            }
            // ── tray menu ────────────────────────────────────────────────
            let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "刷新页面", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "重启", true, None::<&str>)?;
            let proxy_settings = MenuItem::with_id(app, "proxy-settings", "代理设置…", true, None::<&str>)?;
            let check_update = MenuItem::with_id(app, "check-update", "检查更新…", true, None::<&str>)?;
            let dev = CheckMenuItem::with_id(app, "dev-mode", "开发者模式", true, dev_mode(&runtime_dir(app.handle())), None::<&str>)?;
            let gpu = CheckMenuItem::with_id(app, "gpu-accel", "GPU 加速", true, gpu_accel(&runtime_dir(app.handle())), None::<&str>)?;
            let data = MenuItem::with_id(app, "data", "打开数据目录", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&show, &refresh, &restart, &proxy_settings, &check_update, &dev, &gpu, &data, &quit],
            )?;
            // Keep the check-update item handle: its text flips to "有更新 vX…"
            // when the manager reports an available update. Same for the dev
            // checkbox, so the tray state mirrors dsh.json across restarts.
            let state = app.state::<ServerState>();
            *state.update_item.lock().unwrap() = Some(check_update.clone());
            *state.dev_item.lock().unwrap() = Some(dev.clone());
            *state.gpu_item.lock().unwrap() = Some(gpu.clone());

            let _tray = tauri::tray::TrayIconBuilder::with_id("dsh-tray")
                .icon(app.default_window_icon().expect("app icon").clone())
                .tooltip(app.package_info().name.clone())
                .menu(&menu)
                // Left click shows no menu (only right-click does); left
                // double-click restores the window below.
                .show_menu_on_left_click(false)
                // Double-click on the tray icon brings the window back
                // (any state: hidden/minimized/behind). Single click keeps
                // the classic right-click menu behaviour.
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::DoubleClick {
                        button: tauri::tray::MouseButton::Left,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        activate_window(app);
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        activate_window(app);
                    }
                    "refresh" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.reload();
                        }
                    }
                    "restart" => {
                        let _ = restart_server(app.clone(), app.state::<ServerState>());
                    }
                    "proxy-settings" => {
                        open_settings_window(app);
                    }
                    "check-update" => {
                        // One item, two roles: with an update pending it becomes
                        // the one-click "更新" action; otherwise it re-checks.
                        let available = app
                            .state::<ServerState>()
                            .update
                            .lock()
                            .unwrap()
                            .update_available;
                        let cmd = if available { "update-dsh" } else { "check-update" };
                        send_manager(
                            &mut app.state::<ServerState>().stdin.lock().unwrap(),
                            cmd,
                        );
                    }
                    "dev-mode" => {
                        if let Err(e) = toggle_dev_mode_impl(app) {
                            show_toast(app, "开发者模式".into(), format!("切换失败：{e}"));
                        }
                    }
                    "gpu-accel" => {
                        if let Err(e) = toggle_gpu_accel_impl(app) {
                            show_toast(app, "GPU 加速".into(), format!("切换失败：{e}"));
                        }
                    }
                    "data" => {
                        let _ = open_data_dir(app.clone());
                    }
                    "quit" => {
                        let _ = quit_app(app.clone(), app.state::<ServerState>());
                    }
                    _ => {}
                })
                .build(app)?;

            // ── 关窗=隐藏到托盘（真正的托盘语义）；只有菜单"退出"才真正退出。
// 点击 toast 由 notify-rust 进程内激活回调驱动 activate_window()，对
// 隐藏/最小化/置后/置前任意状态都能恢复并置前。窗口重新获得焦点时，
// 把暂存的"通知会话"交给页面打开（托盘/任务栏手动回来也适用）。──────
            if let Some(w) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                w.on_window_event(move |event| match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        // 托盘语义：关窗=隐藏（不真关、不进任务栏）。
                        // 点击 toast 时由进程内激活回调 show() 恢复，不再依赖
                        // 系统 SW_RESTORE（它对隐藏窗口无效）。
                        // Linux/GNOME 默认没有托盘图标（需 AppIndicator 扩展），
                        // 隐藏会让窗口"消失且无法找回"——退化为最小化
                        // （任务栏可见，双击/托盘/激活都能恢复）。
                        api.prevent_close();
                        // Windows：首次隐藏前确认一次（S5）；确认过就直接隐藏。
                        // 我们自己的菜单 ☓ / Alt+F4 / 任务栏关闭都走同一个事件，
                        // 所以三者的"首次确认"行为一致。
                        #[cfg(not(target_os = "linux"))]
                        {
                            if close_needs_confirmation(close_confirmed(&handle), false) {
                                let _ = request_confirmation(&handle, CLOSE_HIDE_ACTION, String::new());
                            } else if let Some(w) = handle.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        }
                        #[cfg(target_os = "linux")]
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.minimize();
                        }
                    }
                    tauri::WindowEvent::Focused(true) => {
                        if let Some(sid) = FOCUS_OPEN.lock().unwrap().take() {
                            *PENDING_OPEN.lock().unwrap() = Some(sid.clone());
                            let data = handle
                                .path()
                                .app_data_dir()
                                .unwrap_or_else(|_| std::path::PathBuf::from("."));
                            log_line(&data, &format!("focus-open: {sid}"));
                            eprintln!("[dsh-desktop] focus-open: {sid}");
                        }
                    }
                    _ => {}
                });
            }

            // ── notifications: receive events from the injected client and
            // raise NATIVE toasts from Rust (no remote-IPC permission needed;
            // WebView2 has no HTML5 Notification support). Also writes every
            // event to <data>/dsh-desktop-session.log for diagnosis.
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            {
                let app = app.handle().clone();
                let data_dir = data_dir.clone();
                app.clone().listen("desktop-notification", move |event| {
                    let payload = event.payload();
                    log_line(&data_dir, &format!("notification: {payload}"));
                    eprintln!("[dsh-desktop] notification: {payload}");
                    let (title, body) = serde_json::from_str::<serde_json::Value>(payload)
                        .map(|v| {
                            (
                                v.get("title").and_then(|x| x.as_str()).unwrap_or("dsh").to_string(),
                                v.get("body").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                            )
                        })
                        .unwrap_or_else(|_| ("dsh".into(), payload.to_string()));
                    use tauri_plugin_notification::NotificationExt;
                    let mut b = app.notification().builder().title(title);
                    if !body.is_empty() {
                        b = b.body(body);
                    }
                    let _ = b.show();
                });
            }
            {
                let data_dir = data_dir.clone();
                app.listen("dsh-client-ready", move |event| {
                    log_line(&data_dir, &format!("client-ready: {}", event.payload()));
                    eprintln!("[dsh-desktop] client-ready: {}", event.payload());
                });
            }

            // ── 服务树 Job Object（Windows）：壳进程死亡 → 系统整树清理 ────
            // 必须在 manager 首次 spawn 之前创建；assign 在 start_server 里做。
            // 失败只记日志：启动期孤儿清理仍是兜底。
            #[cfg(windows)]
            {
                let data = app
                    .path()
                    .app_data_dir()
                    .unwrap_or_else(|_| std::path::PathBuf::from("."));
                match job_object::create_kill_on_close_job() {
                    Ok(handle) => {
                        SERVICE_JOB.store(handle, std::sync::atomic::Ordering::SeqCst);
                        log_line(&data, "service job object active (kill-on-close)");
                        eprintln!("[dsh-desktop] service job object active");
                        // S4b：完成端口逐进程通知——manager 自己被杀时，壳仍能
                        // 记录 dsh web 等后代进程的启动/退出（含异常退出码）。
                        let log_data = data.clone();
                        match job_object::watch_job(handle, move |msg| {
                            log_line(&log_data, msg);
                            eprintln!("[dsh-desktop] {msg}");
                        }) {
                            Ok(()) => {
                                log_line(&data, "service job completion port active");
                                eprintln!("[dsh-desktop] service job completion port active");
                            }
                            Err(e) => {
                                log_line(&data, &format!("service job watcher FAILED: {e}"));
                                eprintln!("[dsh-desktop] service job watcher FAILED: {e}");
                            }
                        }
                    }
                    Err(e) => {
                        log_line(&data, &format!("service job object FAILED: {e}"));
                        eprintln!("[dsh-desktop] service job object FAILED: {e}");
                    }
                }
            }

            // 清理上次异常退出残留的 dsh 服务树（孤儿防驻留）：壳被强杀/
            // 崩溃时 manager/web 的 node 树无父死子清机制会残留（多个 dsh
            // web 并存干扰导航、占端口）。按本身份 runtime 路径精确清理
            // （dev/正式各自只清自己；taskkill /T /F 连树）；幂等。
            // 2026-09-07 修复：从 setup 主线程移入后台线程——PowerShell
            // 全进程扫描冷启动可达 5-6 秒（WMI 冷 + Defender 扫 powershell.exe），
            // 阻塞主线程会让 WebView2 首帧延迟 → 启动页前黑屏（10:29 启动
            // backup→bridge 间隔 6s 实锤）。清理完成置 STARTUP_CLEANUP_DONE；
            // start_server 通过 wait_for_startup_cleanup() 保证新树不被误杀。
            #[cfg(windows)]
            {
                let c_app = app.handle().clone();
                std::thread::spawn(move || {
                    cleanup_stale_service_tree(&c_app);
                    STARTUP_CLEANUP_DONE.store(true, std::sync::atomic::Ordering::SeqCst);
                });
            }
            #[cfg(not(windows))]
            STARTUP_CLEANUP_DONE.store(true, std::sync::atomic::Ordering::SeqCst);
            // loopback notification bridge (see start_bridge)
            start_bridge(app.handle().clone());
            // 陈旧 dsh 鉴权 cookie 清理（cookie-431 修复）：单一后台 janitor 线程，
            // 启动即清一次。必须在后台线程执行——Windows 上 cookies() 会死锁在
            // 同步 command / 事件处理器里（见 prune_stale_auth_cookies 的注释）。
            spawn_auth_cookie_janitor(app.handle());
            request_auth_cookie_prune();
            // dsh web 挂起看护（只 dump 不重启，见 start_hang_watchdog）
            start_hang_watchdog(app.handle());

            // ── boot the service once the launcher page can listen ────────
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                if let Err(e) = start_server(&handle) {
                    eprintln!("[dsh-desktop] start failed: {e}");
                    *handle.state::<ServerState>().last_error.lock().unwrap() =
                        Some(format!("服务启动失败：{e}"));
                    // Never fail silently: surface the error and show Retry.
                    let _ = handle.emit("server-log", format!("启动失败: {e}"));
                    let _ = handle.emit("server-down", ());
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            restart_server,
            get_pending_action,
            resolve_pending_action,
            open_data_dir,
            open_evidence_dir,
            quit_app,
            get_update_status,
            get_shell_update_status,
            check_shell_update,
            check_update,
            update_now,
            refresh_page,
            restart_dsh,
            get_proxy_config,
            set_proxy_config,
            test_proxy,
            window_control,
            get_shell_state,
            toggle_dev_mode,
            toggle_gpu_accel,
            toggle_titlebar_contract,
            open_settings,
            get_shell_status,
            disable_third_party_plugins,
            check_legacy_install,
            cleanup_legacy_install,
            cleanup_caches
        ])
        .run(tauri::generate_context!())
        .expect("error while running DSH Smoothly Desktop");
}