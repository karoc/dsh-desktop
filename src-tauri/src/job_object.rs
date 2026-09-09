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

#[cfg(not(windows))]
pub(crate) fn create_kill_on_close_job() -> Result<usize, String> {
    Err("job objects are windows-only".into())
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

#[cfg(not(windows))]
pub(crate) fn assign(_job: usize, _pid: u32) -> Result<(), String> {
    Err("job objects are windows-only".into())
}
