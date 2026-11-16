#!/usr/bin/env bash
# 自动化入口（2026-11-17）：让 timer 跑一份**常驻 main 的专用 checkout**，而不是开发者的工作树。
#
# 为什么：本仓工作树 30 天内切了 500+ 次分支、并在 feature 分支上连续停过 15.5 天；而 timer 的
# ExecStart 直接指向工作树脚本 ⇒ 线上心跳长期跑旧代码（技能 §6.14 的两次实录：2026-10-24→10-30
# 的旧 dsh-doctor、2026-11-01→11-16 的旧 dsh-watch/dsh-adapt）。tree-guard 只能告警，治不了根。
#
# 用法（systemd unit）：
#   ExecStart=%h/dsh-automation/scripts/automation-runner.sh /usr/bin/node %h/dsh-automation/scripts/dsh-watch.mjs --issue
#   WorkingDirectory=%h/dsh-automation
# 一次性准备：
#   git clone git@github.com:karoc/dsh-desktop.git ~/dsh-automation && git -C ~/dsh-automation checkout main
#
# 语义：
#   * fetch 节流 300s（多个 10 分钟心跳共享一次 fetch）；节流窗口内只做本地 reset，仍与已知 origin/main 一致；
#   * fetch / reset 失败 **不上报失败**，只告警并沿用当前 checkout —— 自动化不能因为一次网络抖动停摆；
#     沿用旧代码这件事会写进日志，脚本自身的 tree-guard 也会独立告警（双保险）；
#   * checkout 不存在 ⇒ exit 3（拒绝在未知目录跑自动化）；
#   * 代理发现交给 run-with-proxy.sh（本机 ~/.dsh/bin/，可用 DSH_RUN_WITH_PROXY 覆盖；不存在就直接 exec）。
set -uo pipefail
DIR="${DSH_AUTOMATION_DIR:-$HOME/dsh-automation}"
THROTTLE="${DSH_AUTOMATION_FETCH_THROTTLE:-300}"
STAMP="$DIR/.automation-fetch-at"
PROXY="$HOME/.dsh/bin/run-with-proxy.sh"
[ -n "${DSH_RUN_WITH_PROXY:-}" ] && PROXY="$DSH_RUN_WITH_PROXY"
if [ ! -d "$DIR/.git" ]; then
  echo "[automation] $DIR 不存在或不是 git 仓库 —— 拒绝在未知目录跑自动化（先按注释里的 clone 一次）" >&2
  exit 3
fi
now=$(date +%s)
last=$(cat "$STAMP" 2>/dev/null || echo 0)
case "$last" in (*[!0-9]*|"") last=0 ;; esac
if [ $((now - last)) -ge "$THROTTLE" ]; then
  if git -C "$DIR" fetch -q --no-tags origin main 2>/dev/null; then
    echo "$now" > "$STAMP" 2>/dev/null || true
  else
    echo "[automation] git fetch origin main 失败，沿用已知的 origin/main（可能是旧代码）" >&2
  fi
fi
if ! git -C "$DIR" reset -q --hard origin/main 2>&1; then
  echo "[automation] reset --hard origin/main 失败，沿用当前 checkout（可能是旧代码）" >&2
fi
echo "[automation] checkout=$(git -C "$DIR" log --oneline -1)" >&2
if [ -x "$PROXY" ]; then exec "$PROXY" "$@"; fi
echo "[automation] 没找到 $PROXY —— 直接执行（不设代理）" >&2
exec "$@"
