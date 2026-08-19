# Agent Note: desktop-webview-history-stale-ports

Status: implemented

## Problem

While using the dsh web UI inside DSH Desktop the painted content would go black. Native context-menu Back would surface a bfcached copy of the dsh root "no keys/workspaces" onboarding view; a subsequent refresh of that URL produced an inaccessible page. Refresh while on the "live" URL also failed to recover. The root was unmanaged webview history across `dsh web --port 0` restarts/crashes: shell only did `navigate(new_port_root)` without clearing prior entries or intercepting later navs, so bfcache + reloads of stale ports were possible.

## Decision

Tracked the currently live dsh web root URL in a static (`LIVE_DSH_URL`) and installed a navigation guard on the main webview. Any navigation (back/forward via context menu, bfcache restore, manual) to a 127.0.0.1 http URL whose origin is not the live one is snapped back to the live root; the marker is cleared when the manager reports down and we navigate to launcher.

The original draft used `WebviewWindow::on_navigation`, which is a **builder-only API** in Tauri 2 (it does not exist on a runtime window) and did not compile. The shipped guard uses the two runtime-safe paths:
1. `on_page_load`: a load landing on a dsh-like origin different from live → `navigate` back to the live root;
2. an injected `pageshow`/`popstate` listener (via `eval`, the live URL embedded as a JSON literal): bfcache restore does NOT fire `on_page_load` but ALWAYS fires `pageshow`, which covers "back to a dead port restored from bfcache" — the direct cause of the black-on-refresh symptom.
Comparison is by origin (host+port), so in-port routing inside the live dsh SPA is unaffected.

## Alternatives considered

(1) always serve dsh on a fixed port - rejected, port 0 is deliberate to avoid conflicts; (2) disable all context menus and history - too blunt, user still needs refresh via tray; (3) only use replaceState from JS - cannot affect cross-document bfcache entries from previous ports; (4) rebuild the window through `WebviewWindowBuilder::on_navigation` - rejected, would replace the existing window and its state. The guard + live tracking is the minimal, targeted, robust fix that keeps the existing UX.

## Consequences

User back/forward and refreshes after a dsh-side restart or crash now reliably stay on (or snap to) a live server; the confusing "black + inaccessible after back" path is closed. The guard only acts on loopback dsh-looking URLs so launcher and settings windows are unaffected. The `eval`-injected listener is re-installed on every page load (fresh documents replace it, so no accumulation). A future enhancement could also disable the webview context menu's nav items.

