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
use tauri::{AppHandle, Emitter, Manager, State};

/// The spawned `server-manager` child (owns the dsh service tree).
struct ServerState {
    child: Mutex<Option<Child>>,
}

/// Kill the manager child and, on Windows, its whole process tree.
fn stop_child(state: &ServerState) {
    if let Some(mut child) = state.child.lock().unwrap().take() {
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
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

/// Convenience: resolve `node.exe`/`node`, the manager script and friends from
/// bundled resources. Resource layout (kept in sync with tauri.conf.json):
/// `resources/node/<platform>/...`, `resources/manager/server-manager.mjs`,
/// `resources/patch/dsh-desktop.patch.yml`, `resources/plugin/dsh-client-notifications`.
fn resource_paths(app: &AppHandle) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let res = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource dir: {e}"))?;
    #[cfg(windows)]
    let node_exe = res.join("node/win32-x64/node.exe");
    #[cfg(target_os = "macos")]
    let node_exe = res.join("node/darwin-x64/node");
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    let node_exe = res.join("node/linux-x64/node");
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    let node_exe = res.join("node/linux-arm64/node");
    Ok((res, node_exe))
}

/// Spawn the server-manager under the bundled Node and stream its events.
fn start_server(app: &AppHandle) -> Result<(), String> {
    stop_child(&app.state::<ServerState>());

    let (res, node_exe) = resource_paths(app)?;
    if !node_exe.exists() {
        return Err(format!(
            "bundled node not found at {} (run `npm run bundle` to fetch it)",
            node_exe.display()
        ));
    }
    let manager = res.join("manager/server-manager.mjs");
    let patch = res.join("patch/dsh-desktop.patch.yml");
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("home dir: {e}"))?;

    let mut cmd = Command::new(&node_exe);
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
                let _ = handle.emit("server-log", line);
                eprintln!("[dsh-desktop manager] {line}");
            }
        });
    }

    let handle = app.clone();
    let pid = child.id();
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