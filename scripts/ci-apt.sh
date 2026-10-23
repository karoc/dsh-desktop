#!/usr/bin/env bash
# scripts/ci-apt.sh — CI 里唯一的 apt 安装入口（check / rust-coverage / linux / linux-smoke）。
#
# 为什么存在（2026-10-24）：同一条 `apt-get install` 在 GitHub runner 上实测跨度
# 21s ~ 27m20s —— 下载源（azure.archive.ubuntu.com）偶发逐个包"卡"住，而 apt 没有
# 总时长上限：
#   · run 40024960026 的 check job：apt 步 21:12:19→21:39:39 = 27m20s（63.7 MB 用了 27 分钟）
#   · run 40029539904 的 linux-smoke job：apt 步 21:59:50→22:16:53 = 17m03s
#   · 同一 run 40029539904 的 check job：同一条命令 21:50:03→21:50:24 = 21s
# PR 因此常卡在 check=pending，发布日 6h 预算被吃掉 8%+。本脚本做三件事：
#   ① 缓存 apt 的 .deb 归档（workflow 用 actions/cache 把 $2 目录持久化）：命中时
#      apt 直接从本地归档安装，不再走网络下载 —— 慢源对"已缓存版本"完全无影响；
#   ② `--no-install-recommends`（构建档）：推荐包与编译无关，实测 Ubuntu 24.04(noble) 上少装 52 个包；
#      smoke 档**故意保留 recommends**（headless WebKit 依赖 xvfb 推荐的 mesa/GL 与
#      portal 组件；它是真门禁，不拿它做体积优化，见下方 profile 注释）；
#   ③ 有界重试（默认 3 次）：apt 偶发 5xx 可恢复，但预算耗尽必须让 job 红 ——
#      **没有** `|| true` / skip / continue-on-error。
#
# 用法（CI）：sudo bash scripts/ci-apt.sh <tauri|smoke> [缓存目录]
# 用法（本地自检，不需要 root/网络）：bash scripts/ci-apt.sh --self-test
#
# 测试注入（只有自检用）：DSH_APT_GET_BIN / DSH_APT_ATTEMPTS /
# DSH_APT_RETRY_DELAY_SECONDS / DSH_APT_ARCHIVES_DIR / DSH_APT_SKIP_ROOT_CHECK。
set -uo pipefail

ATTEMPTS="${DSH_APT_ATTEMPTS:-3}"
RETRY_DELAY="${DSH_APT_RETRY_DELAY_SECONDS:-15}"
ARCHIVES_DIR="${DSH_APT_ARCHIVES_DIR:-/var/cache/apt/archives}"
APT_GET="${DSH_APT_GET_BIN:-apt-get}"

say() { printf '[ci-apt] %s\n' "$*"; }
die() {
  printf '[ci-apt] ERROR: %s\n' "$*" >&2
  exit 1
}

validate_int() {
  local name="$1" value="$2" min="$3" max="$4"
  case "$value" in
    '' | *[!0-9]*) die "invalid $name='$value' (expected integer $min..$max)" ;;
  esac
  if [ "$value" -lt "$min" ] || [ "$value" -gt "$max" ]; then
    die "invalid $name=$value (expected $min..$max)"
  fi
}

validate_int DSH_APT_ATTEMPTS "$ATTEMPTS" 1 10
validate_int DSH_APT_RETRY_DELAY_SECONDS "$RETRY_DELAY" 0 600

# ── apt 缓存（.deb 归档）────────────────────────────────────────────────────
# actions/cache 在 runner 身份下读写 $CACHE_DIR；apt 自己的归档目录属 root。
# 所以这里显式做两段拷贝：安装前把缓存放进归档目录（apt 命中即不再下载），
# 安装后把归档目录回写到缓存目录（只保留本次实际用到的版本，缓存不会无限长）。
import_cache() {
  local cache_dir="$1"
  [ -n "$cache_dir" ] || { say "no cache dir given — cold install"; return 0; }
  mkdir -p "$ARCHIVES_DIR" || die "cannot create archives dir $ARCHIVES_DIR"
  shopt -s nullglob
  local debs=("$cache_dir"/*.deb)
  if [ ${#debs[@]} -eq 0 ]; then
    say "cache miss/empty ($cache_dir) — cold install"
    return 0
  fi
  say "restored ${#debs[@]} cached .deb from $cache_dir"
  cp -f "${debs[@]}" "$ARCHIVES_DIR"/ || die "cannot import cached .deb into $ARCHIVES_DIR"
}

export_cache() {
  local cache_dir="$1"
  [ -n "$cache_dir" ] || return 0
  mkdir -p "$cache_dir" || die "cannot create cache dir $cache_dir"
  # 先清掉旧版本，避免缓存随发布版本无限膨胀；本次安装或导入的 .deb 再写回。
  find "$cache_dir" -maxdepth 1 -type f -name '*.deb' -delete \
    || die "cannot prune stale cache under $cache_dir"
  shopt -s nullglob
  local debs=("$ARCHIVES_DIR"/*.deb)
  if [ ${#debs[@]} -eq 0 ]; then
    say "no .deb in $ARCHIVES_DIR to cache (packages already on the runner image)"
    return 0
  fi
  cp -f "${debs[@]}" "$cache_dir"/ || die "cannot export .deb to $cache_dir"
  say "saved ${#debs[@]} .deb to cache ($cache_dir)"
}

# ── 有界重试 ────────────────────────────────────────────────────────────────
retry() {
  local desc="$1"
  shift
  local attempt
  for attempt in $(seq 1 "$ATTEMPTS"); do
    say "$desc (attempt $attempt/$ATTEMPTS)"
    if "$@"; then
      return 0
    fi
    if [ "$attempt" -lt "$ATTEMPTS" ]; then
      say "$desc failed; retrying in ${RETRY_DELAY}s" >&2
      sleep "$RETRY_DELAY"
    fi
  done
  printf '[ci-apt] ERROR: %s failed after %d attempts\n' "$desc" "$ATTEMPTS" >&2
  return 1
}

# ── profile：包列表与安装策略的唯一来源 ────────────────────────────────────
# tauri：编译/打包 Tauri（check / rust-coverage / linux）。推荐包与 cargo 编译无关。
# smoke：跑已打包二进制（linux-smoke）。**保留 recommends**：xvfb 推荐的 mesa/GL 与
#        portal 组件是 headless WebKit 的既有工作环境，删它们等于用"体积优化"赌一个
#        真门禁；这个 profile 只靠缓存消掉下载等待。
use_profile() {
  case "$1" in
    tauri)
      PACKAGES=(libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf)
      INSTALL_FLAGS=(--no-install-recommends)
      ;;
    smoke)
      PACKAGES=(xvfb dbus libwebkit2gtk-4.1-0 libappindicator3-1 librsvg2-2 libgtk-3-0)
      INSTALL_FLAGS=()
      ;;
    *)
      printf 'usage: ci-apt.sh <tauri|smoke> [cache-dir]\n' >&2
      printf '       ci-apt.sh --self-test\n' >&2
      exit 2
      ;;
  esac
}

# ── 自检（不碰网络/root）：证明重试与缓存两条路径真的会按预期工作 ────────────
self_test() {
  local tmp
  tmp=$(mktemp -d) || die "mktemp failed"
  trap 'rm -rf "$tmp"' EXIT
  local stub="$tmp/apt-get"
  cat > "$stub" <<'STUB'
#!/usr/bin/env bash
set -u
cmd="${1:-}"
shift || true
state="${STUB_STATE:?}"
mkdir -p "$state"
count_file="$state/$cmd.count"
n=0
[ -f "$count_file" ] && n=$(cat "$count_file")
n=$((n + 1))
printf '%s\n' "$n" > "$count_file"
printf '%s %s\n' "$cmd" "$*" >> "$state/calls.log"
if [ "$cmd" = "install" ]; then
  find "$STUB_ARCHIVES" -maxdepth 1 -type f -name '*.deb' -printf '%f\n' 2>/dev/null \
    > "$state/archives-at-install.txt"
fi
name="STUB_FAIL_${cmd^^}_TIMES"
limit="${!name:-0}"
if [ "$n" -le "$limit" ]; then
  echo "stub: $cmd failing on attempt $n (limit $limit)" >&2
  exit 100
fi
exit 0
STUB
  chmod +x "$stub"

  local failures=0 rc=0
  pass() { printf 'PASS  %s\n' "$*"; }
  fail() {
    printf 'FAIL  %s\n' "$*" >&2
    failures=$((failures + 1))
  }
  # 每个用例重置 stub 计数与归档目录；CACHE_DIR 按用例传入。
  run_case() {
    local cache_dir="$1" attempts="$2" fail_update="$3" fail_install="$4"
    rm -rf "$tmp/state"
    mkdir -p "$tmp/state"
    rc=0
    env \
      DSH_APT_GET_BIN="$stub" \
      DSH_APT_ATTEMPTS="$attempts" \
      DSH_APT_RETRY_DELAY_SECONDS=0 \
      DSH_APT_ARCHIVES_DIR="$tmp/archives" \
      DSH_APT_SKIP_ROOT_CHECK=1 \
      STUB_STATE="$tmp/state" \
      STUB_ARCHIVES="$tmp/archives" \
      STUB_FAIL_UPDATE_TIMES="$fail_update" \
      STUB_FAIL_INSTALL_TIMES="$fail_install" \
      bash "$0" tauri "$cache_dir" >> "$tmp/run.log" 2>&1
    rc=$?
  }
  calls() { cat "$tmp/state/$1.count" 2>/dev/null || echo 0; }

  rm -rf "$tmp/archives"; mkdir -p "$tmp/archives"
  # 1) 首次成功：update/install 各一次，退出 0
  run_case "" 3 0 0
  if [ "$rc" -eq 0 ] && [ "$(calls update)" -eq 1 ] && [ "$(calls install)" -eq 1 ]; then
    pass "首次成功：各调用 1 次"
  else
    fail "首次成功用例 (rc=$rc update=$(calls update) install=$(calls install))"
  fi

  rm -rf "$tmp/archives"; mkdir -p "$tmp/archives"
  # 2) 瞬时故障：install 前 2 次失败，第 3 次成功 ⇒ 绿，且确实重试了
  run_case "" 3 0 2
  if [ "$rc" -eq 0 ] && [ "$(calls install)" -eq 3 ]; then
    pass "瞬时故障恢复：install 3 次后成功"
  else
    fail "瞬时故障用例 (rc=$rc install=$(calls install))"
  fi

  rm -rf "$tmp/archives"; mkdir -p "$tmp/archives"
  # 3) 预算耗尽：install 永远失败 ⇒ 必须红，且严格重试 3 次（有界）
  run_case "" 3 0 9
  if [ "$rc" -ne 0 ] && [ "$(calls install)" -eq 3 ]; then
    pass "重试预算耗尽：红 + 恰好 3 次"
  else
    fail "预算耗尽用例 (rc=$rc install=$(calls install))"
  fi

  # 4) 缓存命中：缓存里的 .deb 必须在 install 之前进入归档目录；安装后再回写缓存
  rm -rf "$tmp/archives" "$tmp/seed"; mkdir -p "$tmp/archives" "$tmp/seed"
  : > "$tmp/seed/seed_1.0_amd64.deb"
  : > "$tmp/archives/extra_2.0_amd64.deb"
  run_case "$tmp/seed" 3 0 0
  if [ "$rc" -eq 0 ] \
    && grep -qx 'seed_1.0_amd64.deb' "$tmp/state/archives-at-install.txt" \
    && [ -f "$tmp/seed/extra_2.0_amd64.deb" ] \
    && [ -f "$tmp/seed/seed_1.0_amd64.deb" ]; then
    pass "缓存命中：install 前已导入，install 后回写（含新 .deb）"
  else
    fail "缓存用例 (rc=$rc; at-install=$(tr '\n' ' ' < "$tmp/state/archives-at-install.txt" 2>/dev/null))"
  fi

  if [ "$failures" -ne 0 ]; then
    printf '[ci-apt] SELF-TEST FAILED (%d case(s))\n' "$failures" >&2
    tail -40 "$tmp/run.log" >&2 || true
    exit 1
  fi
  echo "[ci-apt] SELF-TEST PASSED (4 cases)"
  exit 0
}

main() {
  case "${1:-}" in
    --self-test) self_test ;;
    tauri | smoke) ;;
    *)
      printf 'usage: ci-apt.sh <tauri|smoke> [cache-dir]\n' >&2
      printf '       ci-apt.sh --self-test\n' >&2
      exit 2
      ;;
  esac
  local profile="$1" cache_dir="${2:-}"
  use_profile "$profile"
  if [ "$(id -u)" -ne 0 ] && [ "${DSH_APT_SKIP_ROOT_CHECK:-}" != "1" ]; then
    die "must run as root (sudo bash scripts/ci-apt.sh $profile ...)"
  fi
  export DEBIAN_FRONTEND=noninteractive
  local apt_opts=(-o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)

  say "profile=$profile packages=(${PACKAGES[*]}) recommends=$([ ${#INSTALL_FLAGS[@]} -eq 0 ] && echo kept || echo skipped)"
  import_cache "$cache_dir"
  retry "apt-get update" "$APT_GET" update "${apt_opts[@]}" \
    || die "apt-get update failed after $ATTEMPTS attempts"
  retry "apt-get install" "$APT_GET" install -y "${INSTALL_FLAGS[@]}" "${apt_opts[@]}" "${PACKAGES[@]}" \
    || die "apt-get install failed after $ATTEMPTS attempts"
  export_cache "$cache_dir"
  say "done (profile=$profile)"
}

main "$@"
