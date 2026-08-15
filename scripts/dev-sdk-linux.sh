#!/usr/bin/env bash
# Build a no-root Linux dev SDK so `cargo check` works in this sandbox/CI-like
# env (no system packages, no sudo). Downloads the GTK/WebKit dev closure from
# the distro archive and extracts it under $HOME/sdk, then prints the env vars
# needed for cargo. Ubuntu 24.04 (noble) only.
#
# Usage: bash scripts/dev-sdk-linux.sh   (then export the printed vars)
set -eu

SDK="$HOME/sdk"
mkdir -p "$SDK/debs"

if ! command -v cargo >/dev/null 2>&1; then
  echo "== installing rustup (user-local, no root) =="
  curl -sSf https://sh.rustup.rs -o "$SDK/rustup-init.sh"
  sh "$SDK/rustup-init.sh" -y --profile minimal --default-toolchain stable
fi

ROOTS="libwebkit2gtk-4.1-dev libgtk-3-dev libappindicator3-dev librsvg2-dev libjavascriptcoregtk-4.1-dev"

echo "== resolving dev dependency closure =="
apt-cache depends --recurse --no-recommends --no-suggests --no-conflicts \
  --no-breaks --no-replaces --no-enhances $ROOTS 2>/dev/null \
  | grep -oE "^  [A-Za-z0-9+.-]+: [a-z0-9+.-]+" | awk '{print $2}' | sort -u \
  > "$SDK/deps.txt"

echo "== downloading $(wc -l < "$SDK/deps.txt") packages =="
( cd "$SDK/debs" && xargs -a "$SDK/deps.txt" apt-get download )

# X11 proto .pc files live in a separate meta package
apt-cache search --names-only '^x11proto-dev$' 2>/dev/null | awk '{print $1}' \
  | xargs -r -I{} sh -c 'cd "$SDK/debs" && apt-get download {}'

echo "== extracting =="
for f in "$SDK"/debs/*.deb; do dpkg -x "$f" "$SDK/sdk" 2>/dev/null || true; done

echo
echo "== export these, then run: cargo check --manifest-path src-tauri/Cargo.toml =="
echo "export PATH=\"\$HOME/.cargo/bin:\$PATH\""
echo "export PKG_CONFIG_PATH=\"$SDK/sdk/usr/lib/x86_64-linux-gnu/pkgconfig:$SDK/sdk/usr/share/pkgconfig\""
echo "export PKG_CONFIG_SYSROOT_DIR=\"$SDK/sdk\""