//! Manager lifecycle guard — exit detection, forensics and evidence capture.
//!
//! The shell owns the only `Child` handle for `server-manager` (the manager in
//! turn owns the `dsh web` tree), so it is the only party that can learn *how*
//! the manager died: after a `TerminateProcess` the address space is gone and no
//! post-mortem dump is possible, but the handle holder still gets the exit code.
//!
//! Two independent detectors look for the death, because neither alone is
//! reliable:
//!   - the stdout reader hits EOF (fast, but a grandchild that inherited the
//!     pipe keeps it open, so EOF can be late or never);
//!   - a `try_wait` watchdog (authoritative, at the cost of a 2 s poll).
//!
//! Whichever fires first claims the report slot for its generation; the other
//! becomes a no-op. **No auto-restart** (decision D1, 2026-09-09): a restart
//! would overwrite the scene and hide the reproduction we are hunting. The guard
//! only detects, writes evidence to `<runtime>/reports/manager-crash-<ts>-gen<N>/`
//! and surfaces it — restarting stays a user action (`/restart`, tray, banner).
//!
//! Dump coverage is deliberately absent here: WER LocalDumps only fires on
//! crashes, never on `TerminateProcess`, and an in-shell `MiniDumpWriteDump`
//! helper is a separate card (it can only capture *live* hung processes).

use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// Set once the shell is intentionally quitting (tray 退出 / process exit).
/// Read by the guard so an intentional shutdown is never reported as a crash.
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

pub(crate) fn shutting_down() -> bool {
    SHUTTING_DOWN.load(Ordering::SeqCst)
}

pub(crate) fn mark_shutting_down() {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
}

/// Manager lifecycle phase. Purely informational (UI/diagnostics); detection
/// itself keys off `generation` + `intentional`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MgrPhase {
    Down,
    Starting,
    Running,
    Stopping,
}

impl MgrPhase {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            MgrPhase::Down => "down",
            MgrPhase::Starting => "starting",
            MgrPhase::Running => "running",
            MgrPhase::Stopping => "stopping",
        }
    }
}

/// One manager exit, recorded by whichever detector saw it first.
#[derive(Clone, Debug)]
pub(crate) struct ManagerExit {
    pub generation: u64,
    pub pid: u32,
    pub code: Option<i32>,
    /// `0x00000001` style, or `?` when the code is unknown.
    pub hex: String,
    /// Unix seconds when the exit was observed.
    pub at: u64,
    pub detected_by: String,
    pub evidence_dir: Option<String>,
}

/// Lifecycle bookkeeping shared by every manager spawn/stop.
#[derive(Debug)]
pub(crate) struct ManagerGuard {
    pub phase: MgrPhase,
    /// Bumped on every spawn *and* every intentional stop: a detector holding a
    /// stale generation must not report the next manager's exit.
    pub generation: u64,
    /// PID of the current (or last) manager, for evidence.
    pub pid: u32,
    /// Set by `stop_child`: this exit is expected, never report it.
    pub intentional: bool,
    /// Generation whose exit has already been handled (idempotence between the
    /// EOF reader and the watchdog racing each other).
    pub reported_generation: u64,
    pub last_exit: Option<ManagerExit>,
}

impl Default for ManagerGuard {
    fn default() -> Self {
        Self {
            phase: MgrPhase::Down,
            generation: 0,
            pid: 0,
            intentional: false,
            reported_generation: 0,
            last_exit: None,
        }
    }
}

/// How many crash evidence directories to keep (oldest pruned first).
pub(crate) const EVIDENCE_KEEP: usize = 5;
/// Tail size for logs copied into an evidence directory (manager.log has no
/// rotation, so never copy it whole).
const TAIL_LIMIT: u64 = 64 * 1024;
/// Cap for copied node diagnostic reports.
const NODE_REPORT_LIMIT: u64 = 8 * 1024 * 1024;

pub(crate) fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `0x00000001` style hex for a process exit code (`?` when unknown).
pub(crate) fn hex_code(code: Option<i32>) -> String {
    match code {
        Some(c) => format!("0x{:08X}", c as u32),
        None => "?".to_string(),
    }
}

/// Human summary of a manager exit code. `1` is deliberately described as
/// ambiguous: `taskkill /F` and the manager's own `process.exit(1)` both produce
/// it, and claiming a single cause would be a lie in the incident report.
pub(crate) fn describe_exit(code: Option<i32>) -> String {
    let Some(code) = code else {
        return "退出码未知（stdout 已关闭，但进程未确认退出）".to_string();
    };
    let hex = hex_code(Some(code));
    let known = match code {
        0 => Some("正常退出（不是壳请求的停止）"),
        1 => Some("被强制结束（taskkill /F）或启动期失败"),
        2 => Some("dsh web 异常退出（manager supervise 的约定退出码）"),
        _ => None,
    };
    if let Some(note) = known {
        return format!("退出码 {code}（{hex}）—— {note}");
    }
    let crash = match code as u32 {
        0xC000_0005 => "：访问冲突",
        0xC000_0374 => "：堆损坏",
        0xC000_0409 => "：fail-fast",
        0xC000_013A => "：被强制终止",
        _ => "",
    };
    format!("退出码 {code}（{hex}）{crash}")
}

/// Last `max` bytes of a file as lossy UTF-8, starting at a line boundary when
/// the file was truncated. Missing/unreadable files yield an empty string.
pub(crate) fn tail_bytes(path: &Path, max: usize) -> String {
    let Ok(mut f) = std::fs::File::open(path) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let truncated = len > max as u64;
    if truncated {
        use std::io::Seek as _;
        let _ = f.seek(std::io::SeekFrom::End(-(max as i64)));
    }
    let mut buf = Vec::with_capacity(max.min(1 << 20));
    let _ = f.take(max as u64).read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf).to_string();
    if truncated {
        // Started mid-file: drop the partial first line.
        return match text.find('\n') {
            Some(idx) => text[idx + 1..].to_string(),
            None => text,
        };
    }
    text
}

/// Keep the newest `keep` `manager-crash-*` directories under `reports`.
/// Returns how many were removed. Directory names embed a zero-padded unix
/// timestamp, so lexicographic order is chronological order.
pub(crate) fn prune_evidence_dirs(reports: &Path, keep: usize) -> usize {
    let Ok(rd) = std::fs::read_dir(reports) else {
        return 0;
    };
    let mut dirs: Vec<PathBuf> = rd
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy().starts_with("manager-crash-"))
                .unwrap_or(false)
        })
        .collect();
    dirs.sort();
    if dirs.len() <= keep {
        return 0;
    }
    let mut removed = 0;
    for d in &dirs[..dirs.len() - keep] {
        if std::fs::remove_dir_all(d).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// One `node.exe` whose command line points at this identity's runtime dir.
#[derive(Clone, Debug)]
pub(crate) struct OrphanNode {
    pub pid: String,
    pub created: String,
    pub cmdline: String,
}

/// Orphan service nodes of this identity: `node.exe` whose CommandLine contains
/// the runtime path at a component boundary (same matcher as startup cleanup —
/// a substring match would also hit `runtime-backup`). Windows only; empty
/// elsewhere.
#[cfg(windows)]
pub(crate) fn orphan_service_node_pids(marker: &str) -> Vec<OrphanNode> {
    // 前瞻：runtime 路径后必须是 \ / 引号 / 空白 / 行尾，排除相似目录名。
    let script = format!(
        r#"$m = [regex]::Escape('{marker}'); Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {{ $null -ne $_.CommandLine -and $_.CommandLine -match ($m + '(?=[\\"''\s]|$)') }} | ForEach-Object {{ "$($_.ProcessId)`t$($_.CreationDate.ToString('o'))`t$($_.CommandLine)" }}"#
    );
    crate::powershell_lines(&script)
        .into_iter()
        .filter_map(|l| {
            let mut it = l.splitn(3, '\t');
            let pid = it.next()?.to_string();
            let created = it.next().unwrap_or("").to_string();
            let cmdline = it.next().unwrap_or("").to_string();
            Some(OrphanNode { pid, created, cmdline })
        })
        .collect()
}

#[cfg(not(windows))]
pub(crate) fn orphan_service_node_pids(_marker: &str) -> Vec<OrphanNode> {
    Vec::new()
}

/// Everything the evidence collector needs from the shell.
pub(crate) struct EvidenceInput<'a> {
    pub runtime: &'a Path,
    pub data_dir: &'a Path,
    pub exit: &'a ManagerExit,
    pub shell_uptime_secs: u64,
    pub webview_url: Option<String>,
    pub version: &'a str,
}

/// Write one crash evidence directory and prune old ones. Returns the directory
/// that was written, or `None` when it could not even be created.
pub(crate) fn collect_evidence(input: &EvidenceInput<'_>) -> Option<PathBuf> {
    let reports = input.runtime.join("reports");
    let dir = reports.join(format!(
        "manager-crash-{}-gen{}",
        input.exit.at, input.exit.generation
    ));
    std::fs::create_dir_all(&dir).ok()?;

    let summary = serde_json::json!({
        "capturedAt": input.exit.at,
        "capturedAtIso": iso_utc(input.exit.at),
        "shellVersion": input.version,
        "shellUptimeSecs": input.shell_uptime_secs,
        "managerPid": input.exit.pid,
        "generation": input.exit.generation,
        "exitCode": input.exit.code,
        "exitCodeHex": input.exit.hex,
        "exitSummary": describe_exit(input.exit.code),
        "detectedBy": input.exit.detected_by,
        "webviewUrl": input.webview_url,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    });
    write_text(
        &dir.join("summary.json"),
        &serde_json::to_string_pretty(&summary).unwrap_or_default(),
    );

    // Logs (tails only — manager.log is never rotated).
    write_text(
        &dir.join("manager.log.tail"),
        &tail_bytes(&input.runtime.join("manager.log"), TAIL_LIMIT as usize),
    );
    write_text(
        &dir.join("shell-session.log.tail"),
        &tail_bytes(&input.data_dir.join("dsh-desktop-session.log"), TAIL_LIMIT as usize),
    );

    // Orphans: a TerminateProcess kill leaves the manager's children alive.
    let marker = input.runtime.to_string_lossy().replace('/', "\\");
    let orphans = orphan_service_node_pids(&marker);
    let mut orphan_txt = String::new();
    for o in &orphans {
        orphan_txt.push_str(&format!("pid={} created={} cmd={}\n", o.pid, o.created, o.cmdline));
    }
    if orphan_txt.is_empty() {
        orphan_txt.push_str("(no orphan node.exe referencing this runtime path)\n");
    }
    write_text(&dir.join("orphans.txt"), &orphan_txt);

    write_text(&dir.join("wer.txt"), &wer_report());
    copy_node_reports(input.runtime, &dir);
    prune_evidence_dirs(&reports, EVIDENCE_KEEP);
    Some(dir)
}

fn write_text(path: &Path, text: &str) {
    let _ = std::fs::write(path, text);
}

/// WER configuration + recent crash dumps. Records *why* no dump accompanied
/// this exit: WER only fires on crashes, never on `TerminateProcess`.
fn wer_report() -> String {
    let mut out = String::from("== WER LocalDumps (HKLM) ==\n");
    #[cfg(windows)]
    {
        let script = r#"$k='HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps'; if (Test-Path $k) { Get-ChildItem $k | ForEach-Object { $n=$_.PSChildName; $v=Get-ItemProperty $_.PSPath; "$n DumpFolder=$($v.DumpFolder) DumpType=$($v.DumpType) DumpCount=$($v.DumpCount)" } } else { '(not configured)' }"#;
        let lines = crate::powershell_lines(script);
        out.push_str(if lines.is_empty() { "(query failed)" } else { "" });
        out.push_str(&lines.join("\n"));
        out.push_str("\n== recent crash dumps (%LOCALAPPDATA%\\CrashDumps) ==\n");
        let script = r#"$d=Join-Path $env:LOCALAPPDATA 'CrashDumps'; if (Test-Path $d) { Get-ChildItem -Recurse -File $d -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 20 | ForEach-Object { "$($_.LastWriteTime.ToString('o')) $($_.Length) $($_.FullName)" } } else { '(no CrashDumps dir)' }"#;
        let lines = crate::powershell_lines(script);
        out.push_str(if lines.is_empty() { "(none)\n" } else { "" });
        out.push_str(&lines.join("\n"));
        out.push('\n');
    }
    #[cfg(not(windows))]
    out.push_str("(windows only)\n");
    out
}

/// Copy node diagnostic reports into the evidence dir. The manager already runs
/// the `dsh web` child with `--report-on-fatalerror --report-uncaught-exception
/// --report-dir=<runtime>/reports` (server-manager.mjs), so fatal V8/OOM deaths
/// leave `report.<date>.<pid>.<seq>.json` there. The shell itself never injects
/// `NODE_OPTIONS`: one unsupported flag would break every node process in the
/// tree, and this round deliberately avoids that blast radius.
fn copy_node_reports(runtime: &Path, dir: &Path) {
    let Ok(rd) = std::fs::read_dir(runtime.join("reports")) else {
        return;
    };
    let mut files: Vec<PathBuf> = rd
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .filter(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy().starts_with("report."))
                .unwrap_or(false)
        })
        .filter(|p| p.metadata().map(|m| m.len() <= NODE_REPORT_LIMIT).unwrap_or(false))
        .collect();
    files.sort();
    files.reverse(); // report.<date>.<pid>.<seq>.json sorts newest-last
    let dst = dir.join("node-reports");
    let mut copied = 0usize;
    for p in files {
        if std::fs::create_dir_all(&dst).is_err() {
            return;
        }
        let name = p.file_name().unwrap_or_default();
        if std::fs::copy(&p, dst.join(name)).is_ok() {
            copied += 1;
        }
        if copied >= 10 {
            break;
        }
    }
}

/// `1970-01-01T00:00:00Z` style UTC timestamp (no chrono dependency).
pub(crate) fn iso_utc(unix: u64) -> String {
    let days = (unix / 86_400) as i64;
    let secs = unix % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

/// Howard Hinnant's `civil_from_days` (proleptic Gregorian, days since epoch).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_base(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-manager-guard-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn hex_and_description_cover_known_codes() {
        assert_eq!(hex_code(Some(1)), "0x00000001");
        assert_eq!(hex_code(Some(2)), "0x00000002");
        assert_eq!(hex_code(Some(-1073741819)), "0xC0000005");
        assert_eq!(hex_code(None), "?");
        assert!(describe_exit(Some(2)).contains("dsh web"));
        assert!(describe_exit(Some(1)).contains("taskkill"));
        // 0xC0000005 as a signed i32
        assert!(describe_exit(Some(-1073741819)).contains("访问冲突"));
        assert!(describe_exit(None).contains("未知"));
    }

    #[test]
    fn iso_utc_matches_known_instants() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(1_788_912_000), "2026-09-09T00:00:00Z");
        assert_eq!(iso_utc(1_000_000_000), "2001-09-09T01:46:40Z");
    }

    #[test]
    fn tail_bytes_reads_the_end_at_a_line_boundary() {
        let dir = tmp_base("tail");
        let path = dir.join("log.txt");
        let mut body = String::new();
        for i in 0..200 {
            body.push_str(&format!("line-{i:03}\n"));
        }
        std::fs::write(&path, &body).unwrap();
        let tail = tail_bytes(&path, 64);
        assert!(tail.ends_with("line-199\n"), "tail keeps the last line: {tail:?}");
        assert!(tail.starts_with("line-19"), "tail starts at a line boundary: {tail:?}");
        assert!(tail.len() <= 64 + 8);
        // Whole-file read when it fits, and missing files are empty.
        assert_eq!(tail_bytes(&path, 1 << 20), body);
        assert_eq!(tail_bytes(&dir.join("nope.txt"), 16), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_keeps_only_the_newest_evidence_dirs() {
        let dir = tmp_base("prune");
        for i in 1..=7 {
            std::fs::create_dir_all(dir.join(format!("manager-crash-{:010}-gen1", i * 100))).unwrap();
        }
        std::fs::create_dir_all(dir.join("node")).unwrap(); // unrelated, must survive
        assert_eq!(prune_evidence_dirs(&dir, 5), 2);
        let left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(left.iter().filter(|n| n.starts_with("manager-crash-")).count(), 5);
        assert!(left.iter().any(|n| n == "node"));
        assert!(!left.iter().any(|n| n.contains("0000000100")));
        // Under the cap: no-op.
        assert_eq!(prune_evidence_dirs(&dir, 5), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn collect_evidence_writes_the_full_report() {
        let base = tmp_base("evidence");
        let runtime = base.join("runtime");
        let data = base.join("data");
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(runtime.join("manager.log"), "boot\nurl http://127.0.0.1:1234\n").unwrap();
        std::fs::write(data.join("dsh-desktop-session.log"), "session\n").unwrap();
        let exit = ManagerExit {
            generation: 3,
            pid: 4242,
            code: Some(1),
            hex: hex_code(Some(1)),
            at: 1_788_912_000,
            detected_by: "stdout-eof".into(),
            evidence_dir: None,
        };
        let input = EvidenceInput {
            runtime: &runtime,
            data_dir: &data,
            exit: &exit,
            shell_uptime_secs: 12,
            webview_url: Some("http://127.0.0.1:1234/".into()),
            version: "0.0.0-test",
        };
        let dir = collect_evidence(&input).expect("evidence dir");
        assert_eq!(dir.file_name().unwrap(), "manager-crash-1788912000-gen3");
        let summary: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("summary.json")).unwrap()).unwrap();
        assert_eq!(summary["exitCode"], 1);
        assert_eq!(summary["exitCodeHex"], "0x00000001");
        assert_eq!(summary["capturedAtIso"], "2026-09-09T00:00:00Z");
        assert_eq!(summary["managerPid"], 4242);
        assert!(std::fs::read_to_string(dir.join("manager.log.tail")).unwrap().contains("url http"));
        assert!(std::fs::read_to_string(dir.join("shell-session.log.tail")).unwrap().contains("session"));
        assert!(std::fs::read_to_string(dir.join("orphans.txt")).unwrap().contains("orphan"));
        assert!(std::fs::read_to_string(dir.join("wer.txt")).unwrap().contains("WER"));
        let _ = std::fs::remove_dir_all(&base);
    }
}
