//! 产物保留策略（采用清单 A9）：**份数 + 时间 + 总量**三个维度。
//!
//! 为什么单独成模块：这套策略是**纯 std 的文件系统逻辑**，但 `web_dump.rs` 与 `lib.rs`
//! 都依赖 `tauri`（Linux 上要 gtk/webkit 开发包，本机装不了 ⇒ `cargo test` 跑不动）。
//! 把它抽成零依赖的独立文件后，`cargo test --lib`（CI 的 `check` job）能覆盖它，
//! 只有 rustc 的机器也能直接 `rustc --test src-tauri/src/retention.rs` 跑同一批断言 ——
//! 判据不再被"跑不动"掩盖。
//!
//! 三档规则（顺序固定，保证同样的输入永远得到同样的删除集合）：
//! 1. **时间**：`mtime` 早于 `now - max_age` 的删；`mtime` 读不到（元数据错误）**不删**
//!    （没有判断 = 不能删）。
//! 2. **份数**：按文件名（升序）只留最新 `keep_newest` 份 —— dump 文件名带单调时间戳，
//!    名字序 == 时间序，且不依赖 `mtime` 的可信度。
//! 3. **总量**：剩下的大小之和超过 `max_total_bytes` 时，从最旧的一份开始删到不超。
//!
//! 两个安全边界（都是"宁可留证据"）：
//! - **永不清空目录**：无论规则怎么叠加，最新的一份永远保留。取证目录被清空是不可逆的，
//!   而一份陈旧 dump 的代价只是磁盘。时钟跳变 / `mtime` 异常时这条边界是唯一兜底。
//! - 删除失败**不中断**其余删除，只如实少记一次（`removed` 是实际删掉的份数，不是"打算删"）。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// 保留最近几份挂起 dump（全内存 dump 体积大）。
pub(crate) const HANG_DUMP_KEEP: usize = 3;
/// 时间维度：超过 14 天的 dump 不再保留（README「dump / 备份」一节的实测口径）。
pub(crate) const HANG_DUMP_MAX_AGE_DAYS: u64 = 14;
/// 总量维度：所有 dump 加起来超过 1GiB 就从最旧的删起。
/// 本机实测单个全内存 dump 可到数百 MB（2026-09-17：`reports` 1381MB 里最新一份就占大头），
/// 3 份 × 数百 MB 已经接近 1GiB，再加时间维度就能同时挡住"份数少但单份巨大"的策略漏洞。
pub(crate) const HANG_DUMP_TOTAL_CAP_BYTES: u64 = 1024 * 1024 * 1024;

/// 挂起 dump 的保留策略（单一定义点：调用方只引用这一个常量，避免两处策略漂移）。
pub(crate) const HANG_DUMP_POLICY: RetentionPolicy = RetentionPolicy {
    keep_newest: HANG_DUMP_KEEP,
    max_age: Duration::from_secs(HANG_DUMP_MAX_AGE_DAYS * 24 * 60 * 60),
    max_total_bytes: HANG_DUMP_TOTAL_CAP_BYTES,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RetentionPolicy {
    /// 至少保留最新几份（0 按 1 处理 —— 「永不清空目录」不交给调用方决定）。
    pub keep_newest: usize,
    /// 早于 `now - max_age` 的删除。
    pub max_age: Duration,
    /// 存活文件大小之和的上限，超过则从最旧的删起。
    pub max_total_bytes: u64,
}

/// 一份候选文件的元数据（`mtime` 读不到时为 `None`，规则 1 会因此保留它）。
#[derive(Debug, Clone)]
pub(crate) struct Candidate {
    pub path: PathBuf,
    pub name: String,
    pub len: u64,
    pub mtime: Option<SystemTime>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct RetentionOutcome {
    /// 实际删除的份数（删除失败不计）。
    pub removed: usize,
    /// 实际释放的字节数（删除失败不计）。
    pub freed_bytes: u64,
    /// 规则算完、仍然保留的份数。
    pub kept: usize,
    /// 保留部分的大小之和。
    pub kept_bytes: u64,
}

/// 规则 1 的判据单独抽出来：`mtime` 读不到 ⇒ **保留**（没有判断不等于"很旧"）。
pub(crate) fn is_older_than(mtime: Option<SystemTime>, now: SystemTime, max_age: Duration) -> bool {
    match (mtime, now.checked_sub(max_age)) {
        (Some(mtime), Some(cutoff)) => mtime < cutoff,
        // `now` 早于 `max_age`（时钟还没走过这么久）⇒ 不可能有文件"更早"，不删。
        _ => false,
    }
}

/// 把"该删哪些"算出来（纯函数，不碰文件系统）。`candidates` 里的顺序不影响结果。
///
/// 返回 `(删除列表按从旧到新, 保留列表按从旧到新)`。
pub(crate) fn plan(
    candidates: &[Candidate],
    policy: &RetentionPolicy,
    now: SystemTime,
) -> (Vec<Candidate>, Vec<Candidate>) {
    let mut sorted: Vec<Candidate> = candidates.to_vec();
    // 文件名升序 = 从旧到新（dump 名里带单调时间戳）。同名不可能出现在同一目录。
    sorted.sort_by(|a, b| a.name.cmp(&b.name));

    let keep_newest = policy.keep_newest.max(1);
    let mut victims: Vec<Candidate> = Vec::new();

    // 规则 1：时间。先算出来，但"最新一份永不删"这条边界在最后统一保证。
    let mut age_victims: Vec<Candidate> = Vec::new();
    let mut rest: Vec<Candidate> = Vec::new();
    for c in sorted {
        if is_older_than(c.mtime, now, policy.max_age) {
            age_victims.push(c);
        } else {
            rest.push(c);
        }
    }
    victims.append(&mut age_victims);

    // 规则 2：份数。`rest` 已按从旧到新排序，只留尾部 keep_newest 份。
    if rest.len() > keep_newest {
        let cut = rest.len() - keep_newest;
        victims.extend(rest.drain(..cut));
    }

    // 规则 3：总量。从最旧的开始删到不超上限。
    let mut total: u64 = rest.iter().map(|c| c.len).sum();
    let mut drained: Vec<Candidate> = Vec::new();
    while total > policy.max_total_bytes && rest.len() > 1 {
        let oldest = rest.remove(0);
        total -= oldest.len;
        drained.push(oldest);
    }
    victims.extend(drained);

    // 安全边界：永不清空目录 —— 最新的一份必须留下。
    // （规则叠加后理论上仍可能把最新一份算进 victims：例如它的 mtime 也很旧。）
    if let Some(newest_name) = candidates.iter().map(|c| c.name.clone()).max() {
        let newest_is_a_victim = victims.iter().any(|v| v.name == newest_name);
        let newest_survives = rest.iter().any(|r| r.name == newest_name);
        if newest_is_a_victim && !newest_survives {
            victims.retain(|v| v.name != newest_name);
            if let Some(original) = candidates.iter().find(|c| c.name == newest_name) {
                rest.push(original.clone());
            }
        }
    }

    // 两个列表都按从旧到新返回（调用方据此从最旧开始删、日志/测试也可复现）。
    victims.sort_by(|a, b| a.name.cmp(&b.name));
    rest.sort_by(|a, b| a.name.cmp(&b.name));
    (victims, rest)
}

/// 扫目录 + 算规则 + 删除。只处理文件名以 `prefix` 开头的**普通文件**（子目录不动）。
///
/// 目录读不到 ⇒ 当作"没有候选"（`removed = 0`），不 panic —— 保留策略是尽力而为的清理，
/// 不能因为它自己失败而影响 dump 主流程。
pub(crate) fn prune(
    dir: &Path,
    prefix: &str,
    policy: &RetentionPolicy,
    now: SystemTime,
) -> RetentionOutcome {
    let Ok(entries) = fs::read_dir(dir) else {
        return RetentionOutcome::default();
    };
    let mut candidates: Vec<Candidate> = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        if !name.starts_with(prefix) {
            continue;
        }
        let meta = entry.metadata().ok();
        candidates.push(Candidate {
            path,
            name,
            len: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            mtime: meta.and_then(|m| m.modified().ok()),
        });
    }

    let (victims, kept) = plan(&candidates, policy, now);
    let mut outcome = RetentionOutcome {
        kept: kept.len(),
        kept_bytes: kept.iter().map(|c| c.len).sum(),
        ..RetentionOutcome::default()
    };
    for v in victims {
        // 删除失败（被占用 / 权限）只少记一次，不中断其余删除，也不假成功。
        if fs::remove_file(&v.path).is_ok() {
            outcome.removed += 1;
            outcome.freed_bytes += v.len;
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn cand(name: &str, len: u64, mtime: Option<SystemTime>) -> Candidate {
        Candidate {
            path: PathBuf::from(name),
            name: name.to_string(),
            len,
            mtime,
        }
    }

    fn names(list: &[Candidate]) -> Vec<String> {
        list.iter().map(|c| c.name.clone()).collect()
    }

    fn policy(keep: usize, max_age_days: u64, cap: u64) -> RetentionPolicy {
        RetentionPolicy {
            keep_newest: keep,
            max_age: Duration::from_secs(max_age_days * 24 * 60 * 60),
            max_total_bytes: cap,
        }
    }

    fn now() -> SystemTime {
        SystemTime::now()
    }

    fn tmp_base(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-retention-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(dir: &Path, name: &str, bytes: usize) {
        let mut f = fs::File::create(dir.join(name)).unwrap();
        f.write_all(&vec![b'x'; bytes]).unwrap();
    }

    // ── 规则 1：时间 ────────────────────────────────────────────────────────
    #[test]
    fn age_predicate_is_false_without_a_usable_mtime() {
        let n = now();
        assert!(!is_older_than(None, n, Duration::from_secs(14 * 86400)));
        // 15 天前 ⇒ 旧；13 天前 ⇒ 新。
        let old = n - Duration::from_secs(15 * 86400);
        let fresh = n - Duration::from_secs(13 * 86400);
        assert!(is_older_than(Some(old), n, Duration::from_secs(14 * 86400)));
        assert!(!is_older_than(
            Some(fresh),
            n,
            Duration::from_secs(14 * 86400)
        ));
        // now 早于 max_age（时钟还没走够这段）⇒ 不删。
        let tiny = SystemTime::UNIX_EPOCH + Duration::from_secs(60);
        assert!(!is_older_than(Some(tiny), tiny, Duration::from_secs(86400)));
    }

    #[test]
    fn age_removes_old_dumps_but_never_the_newest_one() {
        let n = now();
        let old = Some(n - Duration::from_secs(20 * 86400));
        // 三份都"很旧"：规则 1 想全删，安全边界只留最新一份。
        let all = vec![
            cand("dshweb-hang-1-01.dmp", 10, old),
            cand("dshweb-hang-2-02.dmp", 10, old),
            cand("dshweb-hang-3-03.dmp", 10, old),
        ];
        let (victims, kept) = plan(&all, &policy(3, 14, u64::MAX), n);
        assert_eq!(
            names(&victims),
            vec!["dshweb-hang-1-01.dmp", "dshweb-hang-2-02.dmp"]
        );
        assert_eq!(names(&kept), vec!["dshweb-hang-3-03.dmp"]);

        // 一份新 + 一份旧：旧的删、新的留。
        let mixed = vec![
            cand("dshweb-hang-1-01.dmp", 10, old),
            cand("dshweb-hang-2-02.dmp", 10, Some(n)),
        ];
        let (victims, kept) = plan(&mixed, &policy(3, 14, u64::MAX), n);
        assert_eq!(names(&victims), vec!["dshweb-hang-1-01.dmp"]);
        assert_eq!(names(&kept), vec!["dshweb-hang-2-02.dmp"]);
    }

    // ── 规则 2：份数 ────────────────────────────────────────────────────────
    #[test]
    fn count_keeps_only_the_newest_three() {
        let n = now();
        let all: Vec<Candidate> = (1..=5)
            .map(|i| cand(&format!("dshweb-hang-{i}-0{i}.dmp"), 100, Some(n)))
            .collect();
        let (victims, kept) = plan(&all, &policy(3, 14, u64::MAX), n);
        assert_eq!(
            names(&victims),
            vec!["dshweb-hang-1-01.dmp", "dshweb-hang-2-02.dmp"]
        );
        assert_eq!(
            names(&kept),
            vec![
                "dshweb-hang-3-03.dmp",
                "dshweb-hang-4-04.dmp",
                "dshweb-hang-5-05.dmp"
            ]
        );
        // 输入顺序不影响结果（幂等：同样的集合永远同样的结论）。
        let mut shuffled = all.clone();
        shuffled.reverse();
        let (victims2, kept2) = plan(&shuffled, &policy(3, 14, u64::MAX), n);
        assert_eq!(names(&victims2), names(&victims));
        assert_eq!(names(&kept2), names(&kept));
    }

    #[test]
    fn keep_newest_zero_still_keeps_one() {
        let n = now();
        let all = vec![
            cand("dshweb-hang-1-01.dmp", 10, Some(n)),
            cand("dshweb-hang-2-02.dmp", 10, Some(n)),
        ];
        let (victims, kept) = plan(&all, &policy(0, 14, u64::MAX), n);
        assert_eq!(names(&victims), vec!["dshweb-hang-1-01.dmp"]);
        assert_eq!(names(&kept), vec!["dshweb-hang-2-02.dmp"]);
    }

    // ── 规则 3：总量 ────────────────────────────────────────────────────────
    #[test]
    fn total_cap_removes_oldest_until_under_the_cap() {
        let n = now();
        let all: Vec<Candidate> = (1..=4)
            .map(|i| cand(&format!("dshweb-hang-{i}-0{i}.dmp"), 300, Some(n)))
            .collect();
        // 4 × 300MB = 1200MB > 1000MB 上限 ⇒ 删最旧的 1 份，剩 900MB。
        let (victims, kept) = plan(&all, &policy(10, 14, 1000), n);
        assert_eq!(names(&victims), vec!["dshweb-hang-1-01.dmp"]);
        assert_eq!(kept.iter().map(|c| c.len).sum::<u64>(), 900);

        // 上限再压到 500MB ⇒ 删到只剩最新一份（安全边界拦住"删空"）。
        let (victims, kept) = plan(&all, &policy(10, 14, 500), n);
        assert_eq!(kept.len(), 1);
        assert_eq!(names(&kept), vec!["dshweb-hang-4-04.dmp"]);
        assert_eq!(victims.len(), 3);
    }

    // ── 真实目录：扫描 + 前缀过滤 + 删除计数 ────────────────────────────────
    #[test]
    fn prune_scans_filters_and_deletes_for_real() {
        let dir = tmp_base("prune");
        for i in 1..=5 {
            write_file(&dir, &format!("dshweb-hang-{i}-0{i}.dmp"), 16);
        }
        // 非前缀文件与子目录都不参与。
        write_file(&dir, "report.keep.json", 8);
        fs::create_dir_all(dir.join("dshweb-hang-subdir")).unwrap();

        let outcome = prune(&dir, "dshweb-hang-", &policy(3, 14, u64::MAX), now());
        assert_eq!(outcome.removed, 2);
        assert_eq!(outcome.freed_bytes, 32);
        assert_eq!(outcome.kept, 3);
        assert_eq!(outcome.kept_bytes, 48);
        let left: Vec<String> = {
            let mut v: Vec<String> = fs::read_dir(&dir)
                .unwrap()
                .filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            v.sort();
            v
        };
        assert!(
            left.contains(&"report.keep.json".to_string()),
            "非前缀文件必须留下：{left:?}"
        );
        assert!(
            left.contains(&"dshweb-hang-subdir".to_string()),
            "子目录不能被当成文件删掉：{left:?}"
        );
        assert!(left.contains(&"dshweb-hang-5-05.dmp".to_string()));
        assert!(!left.contains(&"dshweb-hang-1-01.dmp".to_string()));
        // 再跑一次是幂等的：没有可删的，也不报错。
        let again = prune(&dir, "dshweb-hang-", &policy(3, 14, u64::MAX), now());
        assert_eq!(again.removed, 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_on_a_missing_directory_is_a_no_op() {
        let dir =
            std::env::temp_dir().join(format!("dsh-retention-missing-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let outcome = prune(&dir, "dshweb-hang-", &HANG_DUMP_POLICY, now());
        assert_eq!(outcome, RetentionOutcome::default());
    }

    #[test]
    fn hang_dump_policy_matches_the_documented_numbers() {
        // README / 看板 / 方案文档三处都写「3 份 + 14 天 + 总量 ≤1GB」—— 数字变了必须同步文档。
        assert_eq!(HANG_DUMP_POLICY.keep_newest, 3);
        assert_eq!(
            HANG_DUMP_POLICY.max_age,
            Duration::from_secs(14 * 24 * 60 * 60)
        );
        assert_eq!(HANG_DUMP_POLICY.max_total_bytes, 1024 * 1024 * 1024);
    }
}
