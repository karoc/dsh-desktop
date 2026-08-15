//! dsh Desktop — Tauri 2 shell for DeepSeek Harness.
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
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::{AppHandle, Emitter, Listener, Manager, State};

/// The spawned `server-manager` child (owns the dsh service tree).
struct ServerState {
    child: Mutex<Option<Child>>,
}

/// Kill the manager child and, on Windows, its whole process tree.
fn stop_child(state: &ServerState) {
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
        "bundled node not found; probed: {} — 资源缺失，请重新安装 dsh Desktop",
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
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Optional npm registry override (e.g. a China mirror) via env.
    if let Ok(registry) = std::env::var("DSH_DESKTOP_REGISTRY") {
        if !registry.trim().is_empty() {
            cmd.arg("--registry").arg(&registry);
        }
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn manager: {e}"))?;

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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(ServerState {
            child: Mutex::new(None),
        })
        .setup(|app| {
            // ── tray menu ────────────────────────────────────────────────
            let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "重启服务", true, None::<&str>)?;
            let data = MenuItem::with_id(app, "data", "打开数据目录", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &restart, &data, &quit])?;

            let _tray = tauri::tray::TrayIconBuilder::with_id("dsh-tray")
                .icon(app.default_window_icon().expect("app icon").clone())
                .tooltip("dsh Desktop")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "restart" => {
                        let _ = restart_server(app.clone(), app.state::<ServerState>());
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

            // ── close hides to tray; only the menu "退出" really quits ────
            if let Some(w) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                w.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = handle.get_webview_window("main").map(|w| w.hide());
                    }
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
                app.listen("desktop-notification", move |event| {
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
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running dsh Desktop");
}