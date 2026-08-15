#!/usr/bin/env bash
# dsh Desktop 一键诊断（Linux）。收集关键信息 + 无更新模式跑一次 manager。
set -u
echo "== dsh Desktop 诊断 =="

APP=""
for cand in /usr/lib/"dsh Desktop" "$HOME/.local/share/dev.dsh.desktop"; do
  if [ -d "$cand/resources" ]; then APP="$cand"; break; fi
done
if [ -z "$APP" ]; then echo "!! 未找到安装目录（尝试了 /usr/lib/dsh Desktop 等）"; exit 1; fi
echo "安装目录: $APP"
RES="$APP/resources"

for f in \
  "$RES/node/linux-x64/node" \
  "$RES/node/linux-x64/node_modules/npm/bin/npm-cli.js" \
  "$RES/manager/server-manager.mjs" \
  "$RES/patch/dsh-desktop.patch.yml" \
  "$RES/plugin/@dsh-desktop/client-notifications/client.js"; do
  if [ -f "$f" ]; then echo "OK   $f"; else echo "MISS $f"; fi
done

RT="$HOME/.local/share/dev.dsh.desktop/runtime"
echo
echo "运行时目录: $RT"
if [ -f "$RT/node_modules/@deepseek-ai/dsh/package.json" ]; then echo "  dsh 安装: 是"; else echo "  dsh 安装: 否"; fi
if [ -f "$RT/manager.log" ]; then echo "  manager.log 末尾:"; tail -15 "$RT/manager.log" | sed 's/^/    /'; else echo "  manager.log 不存在"; fi

echo
echo "== 无更新模式跑一次 manager（25 秒） =="
timeout 25 "$RES/node/linux-x64/node" "$RES/manager/server-manager.mjs" \
  --runtime-dir "$RT" --resource-dir "$RES" \
  --patch "$RES/patch/dsh-desktop.patch.yml" --cwd "$HOME" \
  --registry https://registry.npmmirror.com
echo
echo "诊断结束。把以上输出发给开发者。"