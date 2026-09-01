// Build script: Tauri glue + a compile-time UTC build date exposed to lib.rs
// as env!(DSH_BUILD_DATE) (used by the in-shell About dialog).
//
// The Y-M-D conversion is the standard civil_from_days algorithm (Howard
// Hinnant) — no chrono dependency for one date string.
fn main() {
    tauri_build::build();

    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86400) as i64;
    let z = days + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    println!("cargo:rustc-env=DSH_BUILD_DATE={y:04}-{m:02}-{d:02}");
}