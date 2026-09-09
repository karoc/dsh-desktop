//! Windows Job Object for the service tree.
//!
//! The shell creates one job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and
//! assigns the manager to it right after `CreateProcess`; every descendant
//! (dsh web, plugin helper nodes) inherits the job automatically. When the
//! shell process dies — graceful quit, crash, or `TerminateProcess` — Windows
//! closes the job handle and kills the whole tree, so no orphan `node.exe`
//! survives to fight the next launch for ports and files.
//!
//! `JOB_OBJECT_LIMIT_BREAKAWAY_OK` is set deliberately: children may still
//! break away if they ask (`CREATE_BREAKAWAY_FROM_JOB`), and nested job
//! assignment (dsh's own sandbox) keeps working. **No UI restrictions** are
//! set: an outer job that forbids nested assignment would break dsh's own
//! process handling, and Windows 8+ supports nested jobs.
//!
//! Failure is never fatal: if the job cannot be created or the manager cannot
//! be assigned (e.g. the shell itself already sits in a restrictive job), the
//! shell logs it and keeps running — startup orphan cleanup stays as the
//! fallback.

#![cfg(windows)]

/// Create the kill-on-close job. Returns the raw handle value, or an error
/// message. The caller must keep the value for the process lifetime (the job
/// stays alive while any handle to it is open).
#[cfg(windows)]
pub(crate) fn create_kill_on_close_job() -> Result<usize, String> {
    use std::ffi::c_void;
    use windows::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    };
    unsafe {
        let job = CreateJobObjectW(None, None).map_err(|e| format!("CreateJobObjectW: {e}"))?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .map_err(|e| format!("SetInformationJobObject: {e}"))?;
        Ok(job.0 as usize)
    }
}

/// Put `pid` (and every process it spawns later) into the job.
#[cfg(windows)]
pub(crate) fn assign(job: usize, pid: u32) -> Result<(), String> {
    use std::ffi::c_void;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::AssignProcessToJobObject;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};
    unsafe {
        let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
            .map_err(|e| format!("OpenProcess(pid={pid}): {e}"))?;
        let result = AssignProcessToJobObject(HANDLE(job as *mut c_void), process)
            .map_err(|e| format!("AssignProcessToJobObject(pid={pid}): {e}"));
        let _ = CloseHandle(process);
        result
    }
}

/// Associate an IO completion port with the job and spawn a watcher thread that
/// reports every process birth/exit inside the job.
///
/// This is the shell's own per-process record of the service tree: it keeps
/// working when the manager is the process that died (the manager's own log
/// stops there), and it names grandchildren the shell never spawned directly.
/// `log` receives one line per event; the port handle is kept alive by the
/// watcher thread for the rest of the process lifetime.
#[cfg(windows)]
pub(crate) fn watch_job(job: usize, log: impl Fn(&str) + Send + 'static) -> Result<(), String> {
    use std::ffi::c_void;
    use windows::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows::Win32::System::IO::{CreateIoCompletionPort, GetQueuedCompletionStatus, OVERLAPPED};
    use windows::Win32::System::JobObjects::{
        JobObjectAssociateCompletionPortInformation, SetInformationJobObject,
        JOBOBJECT_ASSOCIATE_COMPLETION_PORT,
    };
    unsafe {
        let port = CreateIoCompletionPort(INVALID_HANDLE_VALUE, None, 0, 0)
            .map_err(|e| format!("CreateIoCompletionPort: {e}"))?;
        let assoc = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
            // The completion key is unused: the message code (bytes) plus the
            // PID (lpOverlapped) carry everything we report.
            CompletionKey: std::ptr::null_mut(),
            CompletionPort: port,
        };
        if let Err(e) = SetInformationJobObject(
            HANDLE(job as *mut c_void),
            JobObjectAssociateCompletionPortInformation,
            &assoc as *const _ as *const c_void,
            std::mem::size_of::<JOBOBJECT_ASSOCIATE_COMPLETION_PORT>() as u32,
        ) {
            let _ = CloseHandle(port);
            return Err(format!("SetInformationJobObject(completion port): {e}"));
        }
        // HANDLE is a raw pointer (not Send), so hand the raw value to the
        // thread and rebuild it there.
        let port_raw = port.0 as usize;
        std::thread::spawn(move || {
            let port = HANDLE(port_raw as *mut c_void);
            loop {
                let mut bytes = 0u32;
                let mut key = 0usize;
                let mut overlapped: *mut OVERLAPPED = std::ptr::null_mut();
                let ok = GetQueuedCompletionStatus(
                    port,
                    &mut bytes,
                    &mut key,
                    &mut overlapped,
                    u32::MAX, // INFINITE
                );
                if ok.is_err() {
                    log(&format!("job: completion port read failed (err={ok:?})"));
                    break;
                }
                // For NEW/EXIT_PROCESS the PID rides in lpOverlapped itself.
                let pid = overlapped as usize;
                match bytes {
                    MSG_NEW_PROCESS => log(&format!("job: process started pid={pid}")),
                    MSG_EXIT_PROCESS => log(&format!("job: process exited pid={pid}")),
                    MSG_ABNORMAL_EXIT_PROCESS => {
                        log(&format!("job: process ABNORMAL exit pid={pid}"))
                    }
                    MSG_ACTIVE_PROCESS_ZERO => log("job: active process count reached zero"),
                    _ => {}
                }
            }
        });
        Ok(())
    }
}

// JOB_OBJECT_MSG_* live in Win32::System::SystemServices.
const MSG_NEW_PROCESS: u32 = 6;
const MSG_EXIT_PROCESS: u32 = 7;
const MSG_ABNORMAL_EXIT_PROCESS: u32 = 8;
const MSG_ACTIVE_PROCESS_ZERO: u32 = 4;
