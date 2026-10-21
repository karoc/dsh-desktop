#!/usr/bin/env bash
# CI linux smoke — boot the PACKAGED Linux app headless and assert the real
# chain: resources root resolves (with the bundled node) → manager spawns →
# a dsh web URL reaches the shell's protocol stream.
#
# Why this file exists (2026-10-22): the smoke used to live inline in build.yml
# with a FIXED `sleep 18` before the assertions. On the GitHub runner the
# WebKitGTK/GTK init takes long enough that the app had not printed anything at
# the 18s mark, so the step always reported
#     FAIL: resources root missing or node absent
# while the process was still alive (the runner log's
# "Terminate orphan process: … (dsh-desktop)" proves it). Because the job also
# carried `continue-on-error: true`, that deterministic red was invisible at the
# run level — i.e. it was a canary that proved nothing, on push AND on tags.
#
# The fix is a BOUNDED WAIT, not a byte-for-byte identical check with a longer
# sleep: poll until the expected line shows up (default 180s), fail loudly on
# timeout or if the app dies first, and print diagnostics so the next failure is
# diagnosable. Assertions are unchanged in strength — no skipping, no `|| true`,
# no continue-on-error.
#
# Usage (CI):      bash scripts/ci-linux-smoke.sh          # ARTIFACT_DIR=artifact
# Usage (manual):  ARTIFACT_DIR=/tmp/artifact bash scripts/ci-linux-smoke.sh
#
# Test hooks (used by scripts/test-ci-linux-smoke.mjs, never by CI):
#   SMOKE_APP_BIN       run this executable instead of extracting a deb
#   SMOKE_WAIT_SECONDS  shorten the bounded wait
set -uo pipefail

ARTIFACT_DIR="${ARTIFACT_DIR:-artifact}"
TOTAL_SECONDS="${SMOKE_TIMEOUT_SECONDS:-240}"
WAIT_SECONDS="${SMOKE_WAIT_SECONDS:-180}"
POLL_SECONDS="${SMOKE_POLL_SECONDS:-1}"
LOG="${SMOKE_LOG:-smoke.log}"

APP_PID=""
BIN=""

say() { printf '[linux-smoke] %s\n' "$*"; }
die() {
  printf '[linux-smoke] FAIL: %s\n' "$*" >&2
  dump_diagnostics
  exit 1
}

dump_diagnostics() {
  {
    echo "--- app processes (session $APP_PID) ---"
    if [ -n "$APP_PID" ]; then
      ps -o pid,ppid,stat,etime,pcpu,args -g "$APP_PID" 2>/dev/null || true
    fi
    echo "--- /dev/dri ---"
    ls -la /dev/dri 2>/dev/null || echo "(no /dev/dri — software rendering expected)"
    echo "--- xdg runtime dir ---"
    ls -ld "${XDG_RUNTIME_DIR:-<unset>}" 2>/dev/null || true
    echo "--- $LOG (head 30) ---"
    head -30 "$LOG" 2>/dev/null || echo "(no log)"
    echo "--- $LOG (tail 60) ---"
    tail -60 "$LOG" 2>/dev/null || echo "(no log)"
  } >&2
}

cleanup() {
  # Kill exactly the process group we started (setsid leader), never a pattern.
  if [ -n "$APP_PID" ]; then
    kill -TERM -"$APP_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 -"$APP_PID" 2>/dev/null || break
      sleep 1
    done
    kill -KILL -"$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ── locate the packaged app ────────────────────────────────────────────────
if [ -n "${SMOKE_APP_BIN:-}" ]; then
  BIN="$SMOKE_APP_BIN"
  say "test hook: using SMOKE_APP_BIN=$BIN (deb extraction skipped)"
else
  [ -d "$ARTIFACT_DIR" ] || die "artifact dir not found: $ARTIFACT_DIR (did download-artifact run?)"
  cd "$ARTIFACT_DIR" || die "cannot cd into $ARTIFACT_DIR"

  # Don't assume the artifact's internal layout: upload-artifact nests
  # multi-path artifacts under their common ancestor (deb/, appimage/) for one
  # path set and flattens them for another. Find the deb, then the binary.
  DEB=$(find . -type f -name '*.deb' 2>/dev/null | head -1)
  [ -n "$DEB" ] || die "no .deb under $ARTIFACT_DIR (artifact layout changed?)"
  say "deb: $DEB"
  rm -rf smoke
  dpkg-deb -x "$DEB" smoke/ || die "dpkg-deb -x failed for $DEB"

  # Locate the APP binary explicitly. A bare `find smoke -type f -perm -111`
  # matched the packaged Node toolchain first (e.g. .../corepack/shims/yarn.cmd)
  # and died inside `sh` with a syntax error — the canary never ran the app.
  BIN=$(find smoke/usr/bin -maxdepth 1 -type f -perm -111 2>/dev/null | head -1)
  if [ -z "$BIN" ]; then
    BIN=$(find smoke/usr/lib -maxdepth 3 -type f -perm -111 -not -path "*/resources/*" 2>/dev/null | head -1)
  fi
  if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
    echo "--- smoke/usr/bin ---"; ls -la smoke/usr/bin 2>/dev/null || true
    echo "--- smoke/usr/lib (dirs) ---"; find smoke/usr/lib -maxdepth 2 -type d 2>/dev/null | head -10 || true
    die "no app binary under smoke/usr/bin or smoke/usr/lib"
  fi
  say "binary: $BIN"
fi

# ── seed a stub @deepseek-ai/dsh so the manager never hits npm ─────────────
# The stub prints the URL line immediately, so the only thing that can make
# this smoke slow is the SHELL's own startup (webview init), which is exactly
# what the bounded wait below is about.
RT="$HOME/.local/share/dev.dsh.desktop/runtime"
mkdir -p "$RT/node_modules/@deepseek-ai/dsh/lib"
echo '{"name":"@deepseek-ai/dsh","version":"0.0.0-stub"}' > "$RT/node_modules/@deepseek-ai/dsh/package.json"
cat > "$RT/node_modules/@deepseek-ai/dsh/lib/bin.js" <<'EOF'
console.log('dsh web: http://127.0.0.1:39999')
setInterval(() => {}, 1000)
EOF

# WebKitGTK needs a writable XDG_RUNTIME_DIR; GitHub runners don't always set
# one, and a missing one makes the web process init slow rather than loud.
if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  XDG_RUNTIME_DIR="$PWD/xdg-runtime"
  mkdir -p "$XDG_RUNTIME_DIR"
  chmod 700 "$XDG_RUNTIME_DIR"
  export XDG_RUNTIME_DIR
fi

# Headless env: no GPU on the runner, so pin a software GL stack instead of
# letting EGL/ZINK probe devices that don't exist, and keep the two WebKitGTK
# switches that were already needed to keep the compositor off the DMABUF path.
HEADLESS_ENV=(
  DSH_DESKTOP_NO_UPDATE=1
  WEBKIT_DISABLE_DMABUF_RENDERER=1
  WEBKIT_DISABLE_COMPOSITING_MODE=1
  LIBGL_ALWAYS_SOFTWARE=1
  GALLIUM_DRIVER=llvmpipe
)

# A session bus is what GTK's accessibility/portal probes expect; without one
# they time out instead of failing fast. Use it when the runner has it.
LAUNCHER=()
if command -v dbus-run-session >/dev/null 2>&1; then
  LAUNCHER=(dbus-run-session --)
  say "launcher: dbus-run-session + xvfb-run"
else
  say "launcher: xvfb-run (no dbus-run-session on this runner)"
fi

: > "$LOG"
say "starting app (bounded wait ${WAIT_SECONDS}s, hard timeout ${TOTAL_SECONDS}s)"
# setsid → the whole tree (timeout → dbus → xvfb → app) shares one process group
# that cleanup() can kill precisely.
setsid env "${HEADLESS_ENV[@]}" timeout "$TOTAL_SECONDS" \
  "${LAUNCHER[@]}" xvfb-run -a "$BIN" >"$LOG" 2>&1 &
APP_PID=$!

# ── bounded wait helper ────────────────────────────────────────────────────
# Returns 0 on match, 1 on timeout, 2 if the app died before matching.
wait_for() {
  local pattern="$1" desc="$2" waited=0
  while :; do
    if grep -qE "$pattern" "$LOG" 2>/dev/null; then
      say "$desc appeared after ${waited}s"
      return 0
    fi
    if ! kill -0 "$APP_PID" 2>/dev/null; then
      say "app process exited after ${waited}s, before $desc"
      return 2
    fi
    if [ "$waited" -ge "$WAIT_SECONDS" ]; then
      say "timed out after ${waited}s waiting for $desc (app still alive)"
      return 1
    fi
    sleep "$POLL_SECONDS"
    waited=$((waited + POLL_SECONDS))
    if [ $((waited % 15)) -eq 0 ]; then
      say "still waiting for $desc … ${waited}s"
    fi
  done
}

say "waiting for the resources-root line"
if ! wait_for 'resources root: ' 'resources root line'; then
  die "resources root line never appeared within ${WAIT_SECONDS}s"
fi

ROOT=$(grep -oE 'resources root: .*' "$LOG" | head -1 | sed 's/^resources root: //')
say "ROOT=[$ROOT]"
[ -n "$ROOT" ] || die "resources root line present but empty"
[ -d "$ROOT" ] || die "resources root does not exist: $ROOT"
if [ -f "$ROOT/node/linux-x64/node" ]; then
  say "PASS: resources root resolves and bundled node exists"
else
  die "bundled node absent under resources root: $ROOT/node/linux-x64/node"
fi

say "waiting for the URL event"
if ! wait_for '"t":"url"|dsh web: http://' 'URL event'; then
  die "URL event never appeared within ${WAIT_SECONDS}s"
fi
say "PASS: URL reached the manager protocol stream"

say "SMOKE PASS"
exit 0
