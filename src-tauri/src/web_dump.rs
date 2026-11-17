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

use crate::retention;
use std::path::Path;
use std::time::{Duration, SystemTime};

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

/// 清理历史挂起 dump：**份数 + 时间 + 总量**三档保留（策略单一定义在 `retention`）。
///
/// 返回**实际**结果（删除失败不计 —— 不假成功），供调用方如实记日志。
/// 目录读不到 ⇒ 全 0：保留策略是尽力而为的清理，它自己失败绝不能影响 dump 主流程。
pub(crate) fn prune_dumps(dir: &Path, prefix: &str) -> retention::RetentionOutcome {
    retention::prune(dir, prefix, &retention::HANG_DUMP_POLICY, SystemTime::now())
}


/// 忙卡顿判定阈值：单核 CPU 占用 ≥ 10% 视为「进程仍在推进，只是忙不过来」。
/// 与 manager 的 `STALL_MIN_BUSY_RATIO`（#290）保持同一口径：忙卡顿不该被当成死锁，
/// 壳侧因此不在此时抓 dump（几百 MB，且 CPU 采样会被 dump 的挂起污染）。
pub(crate) const BUSY_STALL_MIN_RATIO: f64 = 0.1;

/// 一次 CPU 采样窗口：进程在 `wall_ms` 内消耗了 `cpu_ms` 的处理器时间（多核可 > wall）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CpuWindow {
    pub(crate) cpu_ms: u64,
    pub(crate) wall_ms: u64,
}

impl CpuWindow {
    /// 单核占用比；窗口为 0（或非法）时返回 None，调用方按「采样失败」处理。
    pub(crate) fn ratio(&self) -> Option<f64> {
        if self.wall_ms == 0 {
            return None;
        }
        Some(self.cpu_ms as f64 / self.wall_ms as f64)
    }
}

/// 壳内挂起看护在 dump 前的决策输入（纯数据，可跨平台单测）。
#[derive(Debug, Clone, Copy)]
pub(crate) struct HangFacts {
    /// 当前连续 miss 数。
    pub(crate) misses: u32,
    /// 触发阈值（HANG_MISS_LIMIT）。
    pub(crate) miss_limit: u32,
    /// 当前 URL 是否已经抓过（HangDump 状态机）。
    pub(crate) already_dumped: bool,
    /// 两次 GetProcessTimes 的差值；None = 采样失败/平台不支持。
    pub(crate) cpu: Option<CpuWindow>,
    /// 忙卡顿闸门是否启用（验证/取证可用 DSH_HANG_BUSY_GATE=off 关闭）。
    pub(crate) busy_gate: bool,
}

/// 决策结果。`SkipBusy` 的调用方必须**清零 miss**（视为慢而非死），且不得标记
/// 「已 dump 过」——之后真死锁仍要能抓 dump。
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum HangAction {
    /// 还没到阈值：继续观察。
    Wait,
    /// 该 URL 已经抓过：不重复抓（现有 HangDump 安全边界）。
    SkipAlreadyDumped,
    /// 抓 dump（idle 挂起 / 采样失败时保持原行为）。
    Dump,
    /// CPU 忙：不抓 dump，清零 miss 继续等。
    SkipBusy { ratio: f64 },
}

/// 「是否抓 dump」的唯一判定（纯函数，无 IO）。顺序即安全边界：
/// ① 已抓过 ⇒ 不重复；② 未到阈值 ⇒ 等；③ 闸门关闭 ⇒ 抓（负向对照）；
/// ④ 采样不可用 ⇒ 抓（fail-open，保持现状）；⑤ 忙 ⇒ 跳过；⑥ 空闲 ⇒ 抓。
pub(crate) fn decide_hang_action(facts: &HangFacts) -> HangAction {
    if facts.already_dumped {
        return HangAction::SkipAlreadyDumped;
    }
    if facts.misses < facts.miss_limit {
        return HangAction::Wait;
    }
    if !facts.busy_gate {
        return HangAction::Dump;
    }
    let Some(ratio) = facts.cpu.and_then(|window| window.ratio()) else {
        return HangAction::Dump;
    };
    if ratio >= BUSY_STALL_MIN_RATIO {
        HangAction::SkipBusy { ratio }
    } else {
        HangAction::Dump
    }
}

/// 忙卡顿闸门是否启用：`DSH_HANG_BUSY_GATE=off|0|false` 时关闭（仅用于
/// verify-hang-dump.ps1 的负向对照与事后取证；生产不设置）。
pub(crate) fn busy_gate_enabled() -> bool {
    match std::env::var("DSH_HANG_BUSY_GATE") {
        Ok(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            !(normalized == "off" || normalized == "0" || normalized == "false")
        }
        Err(_) => true,
    }
}

/// 对目标进程采样两次 CPU 时间（kernel+user），返回窗口；打开失败/权限不足/
/// 平台不支持 ⇒ None（调用方 fail-open 照抓 dump）。
#[cfg(windows)]
pub(crate) fn sample_cpu_window(pid: u32, window: Duration) -> Option<CpuWindow> {
    let first = process_cpu_ms(pid)?;
    std::thread::sleep(window);
    let second = process_cpu_ms(pid)?;
    Some(CpuWindow {
        cpu_ms: second.saturating_sub(first),
        wall_ms: u64::try_from(window.as_millis()).unwrap_or(u64::MAX),
    })
}

#[cfg(windows)]
fn process_cpu_ms(pid: u32) -> Option<u64> {
    use windows::Win32::Foundation::{CloseHandle, FILETIME};
    use windows::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let ok = GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user).is_ok();
        let _ = CloseHandle(process);
        if !ok {
            return None;
        }
        // FILETIME 单位 100ns；kernel+user 即累计处理器时间。
        let ticks = filetime_ticks(&kernel)?.saturating_add(filetime_ticks(&user)?);
        Some(ticks / 10_000)
    }
}

#[cfg(windows)]
fn filetime_ticks(value: &windows::Win32::Foundation::FILETIME) -> Option<u64> {
    Some(((u64::from(value.dwHighDateTime)) << 32) | u64::from(value.dwLowDateTime))
}

#[cfg(not(windows))]
pub(crate) fn sample_cpu_window(_pid: u32, _window: Duration) -> Option<CpuWindow> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

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

    fn hang_facts(misses: u32, cpu: Option<CpuWindow>) -> HangFacts {
        HangFacts {
            misses,
            miss_limit: 3,
            already_dumped: false,
            cpu,
            busy_gate: true,
        }
    }

    #[test]
    fn hang_decision_waits_before_the_miss_threshold() {
        // 即使明显忙，没到阈值也不该做任何决定。
        let facts = hang_facts(2, Some(CpuWindow { cpu_ms: 6200, wall_ms: 10000 }));
        assert_eq!(decide_hang_action(&facts), HangAction::Wait);
    }

    #[test]
    fn hang_decision_skips_a_busy_stall_without_dumping() {
        // 62% 单核：忙卡顿（插件页同步扫盘形态）⇒ 不 dump，调用方清零 miss。
        let facts = hang_facts(3, Some(CpuWindow { cpu_ms: 6200, wall_ms: 10000 }));
        match decide_hang_action(&facts) {
            HangAction::SkipBusy { ratio } => assert!((ratio - 0.62).abs() < 1e-9, "ratio={ratio}"),
            other => panic!("expected SkipBusy, got {other:?}"),
        }
    }

    #[test]
    fn hang_decision_dumps_an_idle_stall() {
        // 死锁/被挂起：CPU≈0 ⇒ 仍按原路径抓 dump（真挂起现场不能丢）。
        assert_eq!(
            decide_hang_action(&hang_facts(3, Some(CpuWindow { cpu_ms: 0, wall_ms: 10000 }))),
            HangAction::Dump
        );
        assert_eq!(
            decide_hang_action(&hang_facts(3, Some(CpuWindow { cpu_ms: 990, wall_ms: 10000 }))),
            HangAction::Dump
        );
    }

    #[test]
    fn hang_decision_boundary_is_ten_percent_of_one_core() {
        // 恰好 10% 算忙（与 manager 的 STALL_MIN_BUSY_RATIO 一致）；999/10000 ⇒ 空闲。
        assert!(matches!(
            decide_hang_action(&hang_facts(3, Some(CpuWindow { cpu_ms: 1000, wall_ms: 10000 }))),
            HangAction::SkipBusy { .. }
        ));
        assert_eq!(
            decide_hang_action(&hang_facts(3, Some(CpuWindow { cpu_ms: 999, wall_ms: 10000 }))),
            HangAction::Dump
        );
    }

    #[test]
    fn hang_decision_fails_open_when_cpu_is_unavailable() {
        // 进程已退出/无权限/平台不支持 ⇒ 保持现状（抓），不能因为采样失败就永不抓。
        assert_eq!(decide_hang_action(&hang_facts(3, None)), HangAction::Dump);
        assert_eq!(
            decide_hang_action(&hang_facts(3, Some(CpuWindow { cpu_ms: 5000, wall_ms: 0 }))),
            HangAction::Dump
        );
    }

    #[test]
    fn hang_decision_never_redumps_the_same_url() {
        let facts = HangFacts {
            misses: 3,
            miss_limit: 3,
            already_dumped: true,
            cpu: Some(CpuWindow { cpu_ms: 0, wall_ms: 10000 }),
            busy_gate: true,
        };
        assert_eq!(decide_hang_action(&facts), HangAction::SkipAlreadyDumped);
    }

    #[test]
    fn hang_decision_gate_off_restores_the_old_behaviour() {
        // 负向对照：闸门关闭（DSH_HANG_BUSY_GATE=off）时，忙也必须抓 —— 证明忙路径
        // 的 -skip 不是恒真断言。
        let facts = HangFacts {
            misses: 3,
            miss_limit: 3,
            already_dumped: false,
            cpu: Some(CpuWindow { cpu_ms: 6200, wall_ms: 10000 }),
            busy_gate: false,
        };
        assert_eq!(decide_hang_action(&facts), HangAction::Dump);
    }

    #[test]
    fn hang_decision_treats_multicore_busy_as_busy() {
        let facts = hang_facts(3, Some(CpuWindow { cpu_ms: 9000, wall_ms: 5000 }));
        assert!(matches!(decide_hang_action(&facts), HangAction::SkipBusy { .. }));
    }

    #[test]
    fn hang_decision_is_not_constant() {
        // 纯函数层面的负向对照：忙与空闲必须给出不同结论，否则后面的真实门禁
        // （busy 不 dump / idle 仍 dump）就失去意义。
        let busy = decide_hang_action(&hang_facts(3, Some(CpuWindow { cpu_ms: 6200, wall_ms: 10000 })));
        let idle = decide_hang_action(&hang_facts(3, Some(CpuWindow { cpu_ms: 0, wall_ms: 10000 })));
        assert_ne!(busy, idle);
        assert!(BUSY_STALL_MIN_RATIO > 0.0 && BUSY_STALL_MIN_RATIO < 1.0);
    }

    #[test]
    fn prune_keeps_the_newest_dumps() {
        let dir = tmp_base("prune");
        for i in 1..=5 {
            std::fs::write(dir.join(format!("dshweb-hang-{i:02}.dmp")), b"x").unwrap();
        }
        std::fs::write(dir.join("report.keep.json"), b"{}").unwrap();
        // 策略 = 保留最新 2 份（份数维度）：01/02/03 被删，04/05 留下。
        assert_eq!(prune_dumps(&dir, "dshweb-hang-").removed, 3);
        let left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(!left.contains(&"dshweb-hang-03.dmp".to_string()));
        assert!(left.contains(&"dshweb-hang-04.dmp".to_string()));
        assert!(left.contains(&"dshweb-hang-05.dmp".to_string()));
        assert!(!left.contains(&"dshweb-hang-01.dmp".to_string()));
        assert!(left.contains(&"report.keep.json".to_string()));
        assert_eq!(prune_dumps(&dir, "dshweb-hang-").removed, 0);
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
