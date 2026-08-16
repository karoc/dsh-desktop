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

use std::io::{BufRead, BufReader};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::{AppHandle, Emitter, Listener, Manager, State};

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
}

/// dsh update status, mirrored from the manager's `update-status` protocol line.
#[derive(Default, Clone)]
struct UpdateStatus {
    current: Option<String>,
    latest: Option<String>,
    update_available: bool,
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

/// Windows: register a PROCESS-LEVEL toast activator. The WinRT `Activated`
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
fn register_toast_activator(app_id: &str) -> Result<(), String> {
    use std::process::Command;
    // Stable CLSID for our activator; only the registry hook that makes
    // Windows launch this exe on toast click.
    const CLSID: &str = "{7C2F4B1A-9D3E-4A8F-B6C0-5E1D2A3B4C5D}";
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
        &format!(r"HKCU\Software\Classes\CLSID\{CLSID}\LocalServer32"),
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
        CLSID,
        "/f",
    ])
    .map_err(|e| format!("reg add CustomActivator: {e}"))?;
    ensure_shortcut_toast_activator(CLSID)?;
    Ok(())
}

/// Windows 11 resolves toast activation through the Start Menu shortcut's
/// `System.AppUserModel.ToastActivatorCLSID` property — the registry
/// CustomActivator keys alone are NOT enough (verified on 25H2: clicks were
/// silently dropped until this property was set). Set it (self-healing: runs
/// on every launch, so reinstall/shortcut-recreate is covered).
#[cfg(target_os = "windows")]
fn ensure_shortcut_toast_activator(clsid: &str) -> Result<(), String> {
    use windows::core::{GUID, HSTRING, Interface, PWSTR};
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER, IPersistFile, STGM_READWRITE};
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
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
    for name in ["DSH Desktop.lnk", "dsh Desktop.lnk"] {
        let p = base.join(name);
        if p.is_file() {
            lnk = Some(p);
            break;
        }
    }
    let lnk = lnk.ok_or_else(|| format!("start menu shortcut not found under {}", base.display()))?;
    let lnk_str = lnk.to_string_lossy().to_string();

    unsafe {
        let clsid_shelllink = GUID::from_u128(0x00021401_0000_0000_c000_000000000046);
        let link: IShellLinkW = CoCreateInstance(&clsid_shelllink, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| format!("CoCreate ShellLink: {e}"))?;
        let persist: IPersistFile = link.cast().map_err(|e| format!("cast IPersistFile: {e}"))?;
        persist
            .Load(&HSTRING::from(&lnk_str), STGM_READWRITE)
            .map_err(|e| format!("IShellLink Load: {e}"))?;
        let store: IPropertyStore = link.cast().map_err(|e| format!("cast IPropertyStore: {e}"))?;
        let mut wide: Vec<u16> = clsid.encode_utf16().chain(std::iter::once(0)).collect();
        let mut v = PROPVARIANT::default();
        (*v.Anonymous.Anonymous).vt = VT_LPWSTR;
        (*v.Anonymous.Anonymous).Anonymous.pwszVal = PWSTR(wide.as_mut_ptr());
        store
            .SetValue(&PKEY_AppUserModel_ToastActivatorCLSID, &v)
            .map_err(|e| format!("SetValue ToastActivatorCLSID: {e}"))?;
        store.Commit().map_err(|e| format!("IPropertyStore Commit: {e}"))?;
        persist
            .Save(&HSTRING::from(&lnk_str), true)
            .map_err(|e| format!("IShellLink Save: {e}"))?;
        Ok(())
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
    n.app_id("dev.dsh.desktop");
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
            send_manager(
                &mut app.state::<ServerState>().stdin.lock().unwrap(),
                "update-dsh",
            );
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
                    let _ = w.open_devtools();
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
                },
                "op": {
                    "op": op.op,
                    "spec": op.spec,
                    "done": op.done,
                    "ok": op.ok,
                    "nextAction": op.next_action,
                    "error": op.error,
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
        // Fresh manager: reset the update status and the tray item text. The
        // manager re-reports `update-status` right after boot.
        let state = app.state::<ServerState>();
        *state.stdin.lock().unwrap() = child.stdin.take();
        *state.update.lock().unwrap() = UpdateStatus::default();
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
        for line in lines.flatten() {
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
                        }
                    }
                    Some("log") => {
                        if let Some(line) = ev.get("line").and_then(|v| v.as_str()) {
                            let _ = handle.emit("server-log", line);
                        }
                    }
                    Some("update-status") => {
                        let current = ev.get("current").and_then(|v| v.as_str()).map(String::from);
                        let latest = ev.get("latest").and_then(|v| v.as_str()).map(String::from);
                        let available = ev.get("updateAvailable").and_then(|v| v.as_bool()).unwrap_or(false);
                        let state = handle.state::<ServerState>();
                        {
                            let mut upd = state.update.lock().unwrap();
                            upd.current = current.clone();
                            upd.latest = latest.clone();
                            upd.update_available = available;
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
                    }
                    Some("preinstalled-updates") => {
                        let state = handle.state::<ServerState>();
                        let updates = ev.get("updates").cloned().unwrap_or(serde_json::json!({}));
                        *state.preinstalled_updates.lock().unwrap() = updates;
                    }
                    _ => {}
                }
            }
        }
        // stdout EOF => manager exited (or the dsh child detached) => tell the UI.
        let _ = handle.emit("server-down", ());
    });

    // Manager's stderr: surface in the UI log AND our own stderr so that any
    // pre-protocol failure (e.g. node script crash) is never silent.
    if let Some(err) = child.stderr.take() {
        let handle = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().flatten() {
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
        })
        // Belt-and-suspenders for the taskbar icon: re-apply the bundled icon
        // on every page load (window existence/creation timing is not relied
        // on; see WindowConfig having no icon field in Tauri v2).
        .on_page_load(|webview, _payload| {
            if let Some(w) = webview.app_handle().get_webview_window("main") {
                if let Some(icon) = w.app_handle().default_window_icon() {
                    let _ = w.set_icon(icon.clone());
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
                std::thread::spawn(move || match register_toast_activator("dev.dsh.desktop") {
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
            }
            // ── tray menu ────────────────────────────────────────────────
            let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "刷新页面", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "重启", true, None::<&str>)?;
            let check_update = MenuItem::with_id(app, "check-update", "检查更新…", true, None::<&str>)?;
            let dev = CheckMenuItem::with_id(app, "dev-mode", "开发者模式", true, dev_mode(&runtime_dir(app.handle())), None::<&str>)?;
            let data = MenuItem::with_id(app, "data", "打开数据目录", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&show, &refresh, &restart, &check_update, &dev, &data, &quit],
            )?;
            // Keep the check-update item handle: its text flips to "有更新 vX…"
            // when the manager reports an available update. Same for the dev
            // checkbox, so the tray state mirrors dsh.json across restarts.
            let state = app.state::<ServerState>();
            *state.update_item.lock().unwrap() = Some(check_update.clone());
            *state.dev_item.lock().unwrap() = Some(dev.clone());

            let _tray = tauri::tray::TrayIconBuilder::with_id("dsh-tray")
                .icon(app.default_window_icon().expect("app icon").clone())
                .tooltip("DSH Desktop")
                .menu(&menu)
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
                        let runtime = runtime_dir(app);
                        let on = dev_mode(&runtime);
                        match set_dev_mode(&runtime, !on) {
                            Ok(()) => {
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
                            }
                            Err(e) => {
                                show_toast(app, "开发者模式".into(), format!("切换失败：{e}"));
                            }
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
                        api.prevent_close();
                        let _ = handle.get_webview_window("main").map(|w| w.hide());
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
            restart_dsh
        ])
        .run(tauri::generate_context!())
        .expect("error while running DSH Desktop");
}