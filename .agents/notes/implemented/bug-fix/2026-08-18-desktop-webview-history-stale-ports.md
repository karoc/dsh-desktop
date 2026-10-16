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

### 2026-10-16 update — the guard must throttle itself (`nav_guard_decision`)

Path 1 above was written as "different origin ⇒ `navigate(live)`" with no dedup, which turns into a **tight loop whenever the live root is unreachable**: a *failed* navigation does not change the webview's URL, so `payload.url()` is still the dead port on the next event, the condition stays true, and the shell re-navigates at connection-refused speed. Measured: ~**160 `main page load` lines per second**, 25,708 lines in one incident, CPU pinned, and the whole webview starved — even the danger-action confirm window rendered blank (UIA showed only the system menu/min/max/close), so 「退出」 became unclickable. Trigger is mundane: dsh fails to start (fresh 「清理缓存」 removed `runtime/node_modules`, upgrade failure, port drift).

The decision is now a **pure function** `nav_guard_decision(current, live, last) -> NavGuard{Skip, ReachedLive, Navigate}` plus state `NAV_GUARD_LAST = (target, Instant, consecutive_attempts)`: a target is not re-issued inside the backoff window, and the window reuses `nav_fallback_interval_secs` (3/3/6/12/24/30s cap) so the guard and the fallback timer follow one curve. Landing on the live origin (`ReachedLive`) clears the state, so a later port drift starts again at 3s. Every guard navigation logs `nav-guard: navigate -> <url> (attempt N)`.

## Alternatives considered

(1) always serve dsh on a fixed port - rejected, port 0 is deliberate to avoid conflicts; (2) disable all context menus and history - too blunt, user still needs refresh via tray; (3) only use replaceState from JS - cannot affect cross-document bfcache entries from previous ports; (4) rebuild the window through `WebviewWindowBuilder::on_navigation` - rejected, would replace the existing window and its state. The guard + live tracking is the minimal, targeted, robust fix that keeps the existing UX.

For the 2026-10-16 throttling specifically: (5) a hard attempt cap ("give up after N") - rejected, it would permanently strand a window that simply outlived a slow dsh start, i.e. it trades a CPU storm for a black window; (6) delete path 1 and rely on the fallback timer alone - rejected, the timer cannot see bfcache restores (that is exactly why path 2 exists) and the original note's symptom would return; (7) throttle in the page via injected JS - rejected, in the storm the page is not loading at all, so there is no JS to run.

## Consequences

User back/forward and refreshes after a dsh-side restart or crash now reliably stay on (or snap to) a live server; the confusing "black + inaccessible after back" path is closed. The guard only acts on loopback dsh-looking URLs so launcher and settings windows are unaffected. The `eval`-injected listener is re-installed on every page load (fresh documents replace it, so no accumulation). A future enhancement could also disable the webview context menu's nav items.

The throttling costs one deliberate behaviour change: when the live root is unreachable the window may sit on the stale URL for up to the current window (3s early, 30s after repeated failures) instead of being re-navigated immediately — bounded CPU/logs in exchange for a short delay before self-healing. Guard decisions are covered by `nav_guard_tests` (same-origin, non-loopback, first navigate, window boundary 2999ms/3000ms, cap 29_999ms/30_000ms, target change) with the negative control `repeated_target_within_backoff_is_skipped`, which the pre-fix implementation fails. The sibling backoff for the fallback timer is recorded in [2026-09-20-webview2-cookie-431-prune.md](./2026-09-20-webview2-cookie-431-prune.md); only the timer path had it until now.

