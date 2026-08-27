//! DSH Desktop — Tauri 2 shell for DeepSeek Harness.
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
    /// Tray item whose text flips between "检查更新…" and "有更新 vX（点击更新）".
    update_item: Mutex<Option<MenuItem<tauri::Wry>>>,
    /// Tray checkbox mirroring the dsh.json devMode flag.
    dev_item: Mutex<Option<CheckMenuItem<tauri::Wry>>>,
    /// Latest plugin operation status reported by the manager.
    op: Mutex<OpStatus>,
    /// Cached per-preinstalled update state, mirrored from the manager's
    /// `preinstalled-updates` protocol line ({name: {installed, latest, …}}).
    preinstalled_updates: Mutex<serde_json::Value>,
    /// Proxy UI data mirrored from the manager's `proxy-hosts` /
    /// `proxy-providers` protocol lines (observed hosts + settings.yaml
    /// provider hosts, for the settings panel's checkbox list).
    proxy: Mutex<ProxyState>,
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
    /// Pre-release channel (npm `next` tag), e.g. 0.1.0-rc.8 when latest is rc.7.
    next: Option<String>,
    next_available: bool,
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
fn stop_child(state: &ServerState) {
    // Drop our stdin handle first: the manager sees EOF and stops reading.
    *state.stdin.lock().unwrap() = None;
    if let Some(mut child) = state.child.lock().unwrap().take() {
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
        let _ = child.wait();
    }
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
/// dev build `dev.dsh.desktop.dev`) gets a deterministic RFC-4122-shaped GUID
/// derived from it — two installs never clobber each other's toast
/// registration, and the value is stable across launches/upgrades.
#[cfg(target_os = "windows")]
fn toast_clsid(identifier: &str) -> String {
    if identifier == "dev.dsh.desktop" {
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

/// Preinstalled plugins with their package description, for the console UI.
fn preinstalled_details(runtime: &std::path::Path) -> Vec<serde_json::Value> {
    preinstalled_names(runtime)
        .into_iter()
        .map(|name| {
            let description = std::fs::read_to_string(
                runtime.join("node_modules").join(&name).join("package.json"),
            )
            .ok()
            .and_then(|raw| {
                serde_json::from_str::<serde_json::Value>(&raw)
                    .ok()
                    .and_then(|v| v.get("description").and_then(|d| d.as_str()).map(String::from))
            })
            .unwrap_or_default();
            serde_json::json!({ "name": name, "description": description })
        })
        .collect()
}

/// Parse {"name": "..."} from a bridge POST body.
fn body_name(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(String::from))
        .unwrap_or_default()
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
    let mut header = String::new();
    loop {
        header.clear();
        if reader.read_line(&mut header).is_err() || header == "\r\n" || header.is_empty() {
            break;
        }
        if let Some((k, v)) = header.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                content_length = v.trim().parse().unwrap_or(0);
            }
        }
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
        ("GET", "/plugins/list") => {
            let runtime = runtime_dir(app);
            let bundles = web_profile_bundles(&runtime);
            let preinstalled = preinstalled_details(&runtime);
            let upd = app.state::<ServerState>().update.lock().unwrap().clone();
            let op = app.state::<ServerState>().op.lock().unwrap().clone();
            let pre_updates = app.state::<ServerState>().preinstalled_updates.lock().unwrap().clone();
            let body = serde_json::json!({
                "bundles": bundles,
                "preinstalled": preinstalled,
                "preinstalledUpdates": pre_updates,
                "devMode": dev_mode(&runtime),
                "update": {
                    "current": upd.current,
                    "latest": upd.latest,
                    "updateAvailable": upd.update_available,
                    "next": upd.next,
                    "nextAvailable": upd.next_available,
                },
                "op": {
                    "op": op.op,
                    "spec": op.spec,
                    "done": op.done,
                    "ok": op.ok,
                    "nextAction": op.next_action,
                    "error": op.error,
                    "hint": op.hint,
                    "hintKey": op.hint_key,
                    "hintPlugins": op.hint_plugins,
                },
            })
            .to_string();
            ("200 OK", body)
        }
        ("POST", "/plugins/enable") => {
            let name = body_name(&body);
            let runtime = runtime_dir(app);
            if !preinstalled_names(&runtime).contains(&name) {
                let err = serde_json::json!({ "ok": false, "error": "not a preinstalled plugin" }).to_string();
                ("400 Bad Request", err)
            } else {
                let mut bundles = web_profile_bundles(&runtime);
                if !bundles.contains(&name) {
                    bundles.push(name.clone());
                }
                match write_web_profile_bundles(&runtime, &bundles) {
                    Ok(()) => {
                        let ok = serde_json::json!({ "ok": true, "name": name, "nextAction": "restart" }).to_string();
                        ("200 OK", ok)
                    }
                    Err(e) => {
                        let err = serde_json::json!({ "ok": false, "error": e }).to_string();
                        ("500 Internal Server Error", err)
                    }
                }
            }
        }
        ("POST", "/plugins/disable") => {
            let name = body_name(&body);
            let runtime = runtime_dir(app);
            if !preinstalled_names(&runtime).contains(&name) {
                let err = serde_json::json!({ "ok": false, "error": "not a preinstalled plugin" }).to_string();
                ("400 Bad Request", err)
            } else {
                let mut bundles = web_profile_bundles(&runtime);
                bundles.retain(|b| b != &name);
                match write_web_profile_bundles(&runtime, &bundles) {
                    Ok(()) => {
                        let ok = serde_json::json!({ "ok": true, "name": name, "nextAction": "restart" }).to_string();
                        ("200 OK", ok)
                    }
                    Err(e) => {
                        let err = serde_json::json!({ "ok": false, "error": e }).to_string();
                        ("500 Internal Server Error", err)
                    }
                }
            }
        }
        ("POST", "/plugins/install") => {
            let spec = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("spec").and_then(|n| n.as_str()).map(String::from))
                .unwrap_or_default();
            let valid = !spec.is_empty() && spec.len() <= 512 && !spec.contains(char::is_whitespace);
            if !valid {
                let err = serde_json::json!({ "ok": false, "error": "invalid plugin spec" }).to_string();
                ("400 Bad Request", err)
            } else {
                let line = serde_json::json!({ "cmd": "plugins-install", "spec": spec }).to_string();
                send_line(&mut app.state::<ServerState>().stdin.lock().unwrap(), &line);
                ("202 Accepted", serde_json::json!({ "ok": true }).to_string())
            }
        }
        ("POST", "/plugins/remove") => {
            let name = body_name(&body);
            let runtime = runtime_dir(app);
            let is_user = web_profile_bundles(&runtime).iter().any(|b| b == &name)
                && !preinstalled_names(&runtime).contains(&name)
                && !WEB_PROFILE_TEMPLATE.iter().any(|t| *t == name);
            if !is_user {
                let err = serde_json::json!({ "ok": false, "error": "not a user-installed plugin" }).to_string();
                ("400 Bad Request", err)
            } else {
                let line = serde_json::json!({ "cmd": "plugins-remove", "name": name }).to_string();
                send_line(&mut app.state::<ServerState>().stdin.lock().unwrap(), &line);
                ("202 Accepted", serde_json::json!({ "ok": true }).to_string())
            }
        }
        ("POST", "/plugins/update") => {
            let name = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(String::from))
                .unwrap_or_default();
            let line = if name.is_empty() {
                serde_json::json!({ "cmd": "plugins-update" }).to_string()
            } else {
                serde_json::json!({ "cmd": "plugins-update", "name": name }).to_string()
            };
            send_line(&mut app.state::<ServerState>().stdin.lock().unwrap(), &line);
            ("202 Accepted", serde_json::json!({ "ok": true }).to_string())
        }
        ("POST", "/plugins/check-preinstalled-updates") => {
            send_manager(
                &mut app.state::<ServerState>().stdin.lock().unwrap(),
                "preinstalled-check",
            );
            ("202 Accepted", serde_json::json!({ "ok": true }).to_string())
        }
        ("POST", "/plugins/update-preinstalled") => {
            let name = body_name(&body);
            let runtime = runtime_dir(app);
            if !preinstalled_names(&runtime).contains(&name) {
                let err = serde_json::json!({ "ok": false, "error": "not a preinstalled plugin" }).to_string();
                ("400 Bad Request", err)
            } else {
                let line = serde_json::json!({ "cmd": "preinstalled-update", "name": name }).to_string();
                send_line(&mut app.state::<ServerState>().stdin.lock().unwrap(), &line);
                ("202 Accepted", serde_json::json!({ "ok": true }).to_string())
            }
        }
        ("POST", "/plugins/reset-preinstalled") => {
            let name = body_name(&body);
            let runtime = runtime_dir(app);
            if !preinstalled_names(&runtime).contains(&name) {
                let err = serde_json::json!({ "ok": false, "error": "not a preinstalled plugin" }).to_string();
                ("400 Bad Request", err)
            } else {
                let line = serde_json::json!({ "cmd": "preinstalled-reset", "name": name }).to_string();
                send_line(&mut app.state::<ServerState>().stdin.lock().unwrap(), &line);
                ("202 Accepted", serde_json::json!({ "ok": true }).to_string())
            }
        }
        // ── shell chrome (custom title bar + menu bar; remote dsh page has
        // no __TAURI__, so window/menu actions ride the bridge) ────────────
        ("POST", "/window/minimize") => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.minimize();
            }
            ("200 OK", serde_json::json!({ "ok": true }).to_string())
        }
        ("POST", "/window/toggle-maximize") => {
            let maximized = app
                .get_webview_window("main")
                .and_then(|w| w.is_maximized().ok())
                .unwrap_or(false);
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
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.close();
            }
            ("200 OK", serde_json::json!({ "ok": true }).to_string())
        }
        ("POST", "/window/drag") => {
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
        ("POST", "/shell/dev-mode-toggle") => match toggle_dev_mode_impl(app) {
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
        ("POST", "/shell/about") => {
            let current = app
                .state::<ServerState>()
                .update
                .lock()
                .unwrap()
                .current
                .clone()
                .unwrap_or_else(|| "?".into());
            let dev = if is_dev_build(app) { "（开发版）" } else { "" };
            show_toast(
                app,
                app.package_info().name.clone(),
                format!("版本 {} · dsh 当前 {}{}", env!("CARGO_PKG_VERSION"), current, dev),
            );
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
        _ => ("404 Not Found", "not found".into()),
    };
    let resp = format!(
        "HTTP/1.1 {status}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, GET, OPTIONS\r\nAccess-Control-Allow-Headers: content-type\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{resp_body}",
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
        "bundled node not found; probed: {} — 资源缺失，请重新安装 DSH Desktop",
        bases
            .iter()
            .map(|b| b.display().to_string())
            .collect::<Vec<_>>()
            .join("; ")
    ))
}

/// Spawn the server-manager under the bundled Node and stream its events.
fn start_server(app: &AppHandle) -> Result<(), String> {
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
    {
        // Fresh manager: reset every mirrored state and the tray item text.
        // The manager re-reports `update-status`/`preinstalled-updates` after
        // boot; op-status is reset here so a stale "restart to apply" hint from
        // the previous manager never re-appears on the freshly loaded page.
        let state = app.state::<ServerState>();
        *state.stdin.lock().unwrap() = child.stdin.take();
        *state.update.lock().unwrap() = UpdateStatus::default();
        *state.op.lock().unwrap() = OpStatus::default();
        *state.preinstalled_updates.lock().unwrap() = serde_json::json!({});
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
                            let _ = handle.emit("server-url", url);
                            *LIVE_DSH_URL.lock().unwrap() = Some(url.to_string());
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
                        let next_available = ev.get("nextAvailable").and_then(|v| v.as_bool()).unwrap_or(false);
                        let state = handle.state::<ServerState>();
                        {
                            let mut upd = state.update.lock().unwrap();
                            upd.current = current.clone();
                            upd.latest = latest.clone();
                            upd.update_available = available;
                            upd.next = next.clone();
                            upd.next_available = next_available;
                        }
                        // Flip the tray item between "检查更新…" and "有更新 vX（点击更新）".
                        let guard = state.update_item.lock().unwrap();
                        if let Some(item) = guard.as_ref() {
                            let text = if available {
                                format!(
                                    "有更新 {}（当前 {}）→ 点击更新",
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
                                    "{} → {}，点托盘「有更新」可一键更新",
                                    current.as_deref().unwrap_or("?"),
                                    latest.as_deref().unwrap_or("?"),
                                ),
                            );
                        }
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
                    Some("preinstalled-updates") => {
                        let state = handle.state::<ServerState>();
                        let updates = ev.get("updates").cloned().unwrap_or(serde_json::json!({}));
                        *state.preinstalled_updates.lock().unwrap() = updates;
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
        // stdout EOF => manager exited (or the dsh child detached) => tell the
        // UI and go back to the launcher page so it re-arms for the next boot
        // (a restart) or shows the error + retry (a crash).
        let _ = handle.emit("server-down", ());
        *LIVE_DSH_URL.lock().unwrap() = None;
        // Back to the launcher so it re-arms for the next boot (a restart) or
        // shows the error + retry (a crash). Guard: only when we're actually on
        // a dsh loopback page, never away from a valid launcher URL.
        if let Some(cur) = handle.get_webview_window("main").and_then(|w| w.url().ok()) {
            let is_dsh = cur.scheme() == "http"
                && cur.host_str().map(|h| h == "127.0.0.1" || h == "localhost").unwrap_or(false);
            if is_dsh {
                if let Some(url) = LAUNCHER_URL.lock().unwrap().clone() {
                    if let Ok(u) = tauri::Url::parse(&url) {
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.navigate(u);
                        }
                    }
                }
            }
        }
    });

    // Manager's stderr: surface in the UI log AND our own stderr so that any
    // pre-protocol failure (e.g. node script crash) is never silent.
    if let Some(err) = child.stderr.take() {
        let handle = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let _ = handle.emit("server-log", line.clone());
                eprintln!("[dsh-desktop manager] {line}");
            }
        });
    }

    let handle = app.clone();
    let pid = child.id();
    eprintln!("[dsh-desktop] manager spawned (pid {pid})");
    let _ = handle.emit("server-log", format!("manager spawned (pid {pid})"));
    *app.state::<ServerState>().child.lock().unwrap() = Some(child);
    Ok(())
}

/// Restart the service (used by the tray and the launcher's retry button).
#[tauri::command]
fn restart_server(app: AppHandle, state: State<'_, ServerState>) -> Result<(), String> {
    stop_child(&state);
    start_server(&app)
}

/// Open the dsh data directory in the platform file manager.
#[tauri::command]
fn open_data_dir(app: AppHandle) -> Result<(), String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    std::fs::create_dir_all(&data).map_err(|e| format!("mkdir: {e}"))?;
    #[cfg(windows)]
    let res = Command::new("explorer").arg(&data).status();
    #[cfg(target_os = "macos")]
    let res = Command::new("open").arg(&data).status();
    #[cfg(target_os = "linux")]
    let res = Command::new("xdg-open").arg(&data).status();
    res.map(|_| ()).map_err(|e| format!("open dir: {e}"))
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
        .inner_size(640.0, 720.0)
        .min_inner_size(480.0, 560.0)
        .resizable(true)
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
        "window.__DSH_SHELL_VERSION__={};window.__DSH_PRODUCT_NAME__={}",
        serde_json::to_string(env!("CARGO_PKG_VERSION")).unwrap_or_else(|_| "\"\"".into()),
        serde_json::to_string(app.package_info().name.as_str())
            .unwrap_or_else(|_| "\"DSH Desktop\"".into())
    );
    let port = BRIDGE_PORT.load(std::sync::atomic::Ordering::SeqCst);
    if port > 0 {
        prefix.push_str(&format!(";window.__DSH_BRIDGE_PORT__={port}"));
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
    stop_child(&state);
    app.exit(0);
    Ok(())
}

/// Current dsh update status (launcher page banner / console).
#[tauri::command]
fn get_update_status(state: State<'_, ServerState>) -> serde_json::Value {
    let s = state.update.lock().unwrap();
    serde_json::json!({
        "current": s.current,
        "latest": s.latest,
        "updateAvailable": s.update_available,
        "next": s.next,
        "nextAvailable": s.next_available,
    })
}

/// Ask the manager to re-check the registry for a newer dsh.
#[tauri::command]
fn check_update(state: State<'_, ServerState>) -> Result<(), String> {
    send_manager(&mut state.stdin.lock().unwrap(), "check-update");
    Ok(())
}

/// One-click: install the newest dsh, then restart the service.
#[tauri::command]
fn update_now(state: State<'_, ServerState>) -> Result<(), String> {
    send_manager(&mut state.stdin.lock().unwrap(), "update-dsh");
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
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "devMode": dev_mode(&runtime_dir(&app)),
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

/// Chrome menu bar entry: open (or focus) the proxy settings window.
#[tauri::command]
fn open_settings(app: AppHandle) -> Result<(), String> {
    open_settings_window(&app);
    Ok(())
}

/// True for any build whose bundle identifier differs from the official one
/// (the side-by-side dev build from tauri.dev.conf.json). Used to label the
/// dev variant in user-visible strings so it can't be mistaken for the
/// official install.
fn is_dev_build(app: &AppHandle) -> bool {
    app.config().identifier != "dev.dsh.desktop"
}

/// Chrome menu bar entry: "关于 DSH Desktop" — native toast with the shell
/// version and the current dsh version.
#[tauri::command]
fn show_about(app: AppHandle, state: State<'_, ServerState>) -> Result<(), String> {
    let current = state
        .update
        .lock()
        .unwrap()
        .current
        .clone()
        .unwrap_or_else(|| "?".into());
    let dev = if is_dev_build(&app) { "（开发版）" } else { "" };
    show_toast(
        &app,
        app.package_info().name.clone(),
        format!("版本 {} · dsh 当前 {}{}", env!("CARGO_PKG_VERSION"), current, dev),
    );
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
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
            update_item: Mutex::new(None),
            dev_item: Mutex::new(None),
            op: Mutex::new(OpStatus::default()),
            preinstalled_updates: Mutex::new(serde_json::json!({})),
            proxy: Mutex::new(ProxyState::default()),
        })
        // Belt-and-suspenders for the taskbar icon: re-apply the bundled icon
        // on every page load (window existence/creation timing is not relied
        // on; see WindowConfig having no icon field in Tauri v2).
        .on_page_load(|webview, payload| {
            if webview.label() == "main" {
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
                if let Ok(u) = w.url() {
                    *LAUNCHER_URL.lock().unwrap() = Some(u.to_string());
                }
            }
            // ── tray menu ────────────────────────────────────────────────
            let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "刷新页面", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "重启", true, None::<&str>)?;
            let proxy_settings = MenuItem::with_id(app, "proxy-settings", "代理设置…", true, None::<&str>)?;
            let check_update = MenuItem::with_id(app, "check-update", "检查更新…", true, None::<&str>)?;
            let dev = CheckMenuItem::with_id(app, "dev-mode", "开发者模式", true, dev_mode(&runtime_dir(app.handle())), None::<&str>)?;
            let data = MenuItem::with_id(app, "data", "打开数据目录", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&show, &refresh, &restart, &proxy_settings, &check_update, &dev, &data, &quit],
            )?;
            // Keep the check-update item handle: its text flips to "有更新 vX…"
            // when the manager reports an available update. Same for the dev
            // checkbox, so the tray state mirrors dsh.json across restarts.
            let state = app.state::<ServerState>();
            *state.update_item.lock().unwrap() = Some(check_update.clone());
            *state.dev_item.lock().unwrap() = Some(dev.clone());

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
                        if let Some(w) = handle.get_webview_window("main") {
                            #[cfg(target_os = "linux")]
                            let _ = w.minimize();
                            #[cfg(not(target_os = "linux"))]
                            let _ = w.hide();
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

            // ── loopback notification bridge (see start_bridge) ────────────
            start_bridge(app.handle().clone());

            // ── boot the service once the launcher page can listen ────────
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                if let Err(e) = start_server(&handle) {
                    eprintln!("[dsh-desktop] start failed: {e}");
                    // Never fail silently: surface the error and show Retry.
                    let _ = handle.emit("server-log", format!("启动失败: {e}"));
                    let _ = handle.emit("server-down", ());
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            restart_server,
            open_data_dir,
            quit_app,
            get_update_status,
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
            open_settings,
            show_about
        ])
        .run(tauri::generate_context!())
        .expect("error while running DSH Desktop");
}