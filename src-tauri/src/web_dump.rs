//! dsh web hang forensics: probe the live URL, then dump the stuck process.
//!
//! A hung `dsh web` keeps its socket and process alive — the one failure mode
//! where a post-mortem dump is physically possible (a killed process has no
//! address space left; see `manager_guard.rs`). The manager's own watchdog used
//! `rundll32 comsvcs.dll,MiniDump` for this and on this machine it hung for the
//! full 20 s `spawnSync` timeout and produced nothing (6/6 attempts on
//! 2026-09-05), which also stretched each restart cycle and turned one hang into
//! a restart storm. This module calls `MiniDumpWriteDump` directly from the
//! shell: no extra process, no LOLBin, and every failure reports the OS error.
//!
//! **Dump only** (decision D1): the shell never kills or restarts here. The
//! manager's watchdog owns recovery, the shell owns the scene.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// Probe the live dsh URL. Any HTTP status counts as alive (a 401/404 still
/// proves the server's event loop answers); only connect failure, timeout or an
/// empty response counts as a miss.
pub(crate) fn probe_url(url: &str, timeout: Duration) -> bool {
    let Ok(parsed) = tauri::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let Some(port) = parsed.port_or_known_default() else {
        return false;
    };
    let Ok(addr) = std::net::ToSocketAddrs::to_socket_addrs(&(host, port)) else {
        return false;
    };
    let Some(addr) = addr.into_iter().next() else {
        return false;
    };
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(&addr, timeout) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let request = format!(
        "GET / HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n"
    );
    use std::io::{Read as _, Write as _};
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    match stream.read(&mut buf) {
        Ok(n) => n > 0 && buf.starts_with(b"HTTP/"),
        Err(_) => false,
    }
}

/// PID listening on the URL's port — that is the `dsh web` node process. Uses
/// `Get-NetTCPConnection` (same-user queries need no admin) and falls back to
/// the runtime-path matcher when the cmdlet is unavailable.
pub(crate) fn dsh_web_pid_for_url(url: &str, runtime: &Path) -> Option<u32> {
    // Parse on every platform (a malformed URL must never resolve to a PID);
    // only the Windows path needs the port.
    let parsed = tauri::Url::parse(url).ok()?;
    #[cfg(windows)]
    {
        let port = parsed.port_or_known_default()?;
        let script = format!(
            "(Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)"
        );
        for line in crate::powershell_lines(&script) {
            if let Ok(pid) = line.trim().parse::<u32>() {
                if pid > 0 {
                    return Some(pid);
                }
            }
        }
    }
    #[cfg(not(windows))]
    let _ = parsed;
    // Fallback: the newest node.exe whose command line carries this runtime and
    // is not the manager itself.
    let marker = runtime.to_string_lossy().replace('/', "\\");
    let mut candidates: Vec<u32> = crate::manager_guard::orphan_service_node_pids(&marker)
        .into_iter()
        .filter(|o| !o.cmdline.contains("server-manager.mjs"))
        .filter_map(|o| o.pid.trim().parse::<u32>().ok())
        .collect();
    candidates.sort_unstable();
    candidates.pop()
}

/// Full-memory minidump of `pid`. The target must still be alive; a process
/// killed before the call cannot be dumped (physical limit, documented in
/// `manager_guard.rs`). Returns the dump size in bytes.
#[cfg(windows)]
pub(crate) fn dump_process(pid: u32, path: &Path) -> Result<u64, String> {
    use windows::Win32::Foundation::{CloseHandle, GENERIC_WRITE};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_NONE,
    };
    use windows::Win32::System::Diagnostics::Debug::{MiniDumpWithFullMemory, MiniDumpWriteDump};
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};

    let wide: Vec<u16> = std::os::windows::ffi::OsStrExt::encode_wide(path.as_os_str())
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        // PROCESS_VM_READ is enough for same-user processes (verified: a
        // non-elevated shell can read explorer's modules); no SeDebugPrivilege.
        let process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid)
            .map_err(|e| format!("OpenProcess(pid={pid}): {e}"))?;
        let file = match CreateFileW(
            windows::core::PCWSTR(wide.as_ptr()),
            GENERIC_WRITE.0,
            FILE_SHARE_NONE,
            None,
            CREATE_ALWAYS,
            FILE_ATTRIBUTE_NORMAL,
            None,
        ) {
            Ok(f) => f,
            Err(e) => {
                let _ = CloseHandle(process);
                return Err(format!("CreateFileW({}): {e}", path.display()));
            }
        };
        let result = MiniDumpWriteDump(
            process,
            pid,
            file,
            MiniDumpWithFullMemory,
            None,
            None,
            None,
        );
        let _ = CloseHandle(file);
        let _ = CloseHandle(process);
        result.map_err(|e| format!("MiniDumpWriteDump(pid={pid}): {e}"))?;
    }
    std::fs::metadata(path)
        .map(|m| m.len())
        .map_err(|e| format!("dump stat {}: {e}", path.display()))
}

#[cfg(not(windows))]
pub(crate) fn dump_process(_pid: u32, _path: &Path) -> Result<u64, String> {
    Err("process dump is windows-only".into())
}

/// Keep only the newest `keep` files in `dir` whose name starts with `prefix`
/// (full-memory dumps are large; the newest few are enough for diagnosis).
/// Returns how many were removed.
pub(crate) fn prune_dumps(dir: &Path, prefix: &str, keep: usize) -> usize {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut files: Vec<PathBuf> = rd
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .filter(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy().starts_with(prefix))
                .unwrap_or(false)
        })
        .collect();
    files.sort();
    if files.len() <= keep {
        return 0;
    }
    let mut removed = 0;
    for f in &files[..files.len() - keep] {
        if std::fs::remove_file(f).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_base(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-web-dump-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn probe_rejects_unparseable_and_dead_urls() {
        assert!(!probe_url("not a url", Duration::from_millis(200)));
        assert!(!probe_url("http://127.0.0.1:1/", Duration::from_millis(300)));
    }

    #[test]
    fn prune_keeps_the_newest_dumps() {
        let dir = tmp_base("prune");
        for i in 1..=5 {
            std::fs::write(dir.join(format!("dshweb-hang-{i:02}.dmp")), b"x").unwrap();
        }
        std::fs::write(dir.join("report.keep.json"), b"{}").unwrap();
        assert_eq!(prune_dumps(&dir, "dshweb-hang-", 2), 3);
        let left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(left.contains(&"dshweb-hang-04.dmp".to_string()));
        assert!(left.contains(&"dshweb-hang-05.dmp".to_string()));
        assert!(left.contains(&"report.keep.json".to_string()));
        assert_eq!(prune_dumps(&dir, "dshweb-hang-", 2), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dump_process_reports_errors_instead_of_panicking() {
        let dir = tmp_base("dump");
        let out = dir.join("nope.dmp");
        // An impossible PID must fail with a message, never panic.
        let err = dump_process(u32::MAX, &out).unwrap_err();
        assert!(!err.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
