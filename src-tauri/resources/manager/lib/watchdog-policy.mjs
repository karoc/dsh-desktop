/**
 * dsh web liveness-restart policy — the manager watchdog's *decision* arithmetic,
 * kept pure so it can be unit-tested and so no threshold is hard-coded in the
 * supervisor loop.
 * @module watchdog-policy
 */

/**
 * Why this module exists
 * ---------------------
 * The supervisor probes the reported dsh web URL every WATCHDOG_TICK_MS with a
 * short (~1.5s) timeout. dsh web can stall its event loop synchronously for
 * seconds without dying: a first Plugins-page open in dsh 0.2.2 runs three Remote
 * sweeps (pluginManager/listBundles, pluginManager/listPlugins,
 * pluginInventory/list), and each sweep re-reads every Loader entry's locale
 * dictionaries with synchronous readdirSync + ESM resolveSync + readFileSync
 * (@deepseek-ai/dsh-app-boot metaOf/readPluginMeta/dictionariesOf, no cache;
 * upstream 0.2.2-rc.1 -> rc.3 verified unchanged). Measured on Windows: 2.9-12s
 * busy, so the old "3 x 1.5s miss => dump + restart" rule turned a self-healing
 * stall into a restart that dropped the user's session.
 *
 * Two dials, one place:
 *   1. a longer miss count / no-response window right after startup (plugin
 *      loading, index building — the 2026-09-05 restart-storm shape);
 *   2. a steady-state threshold that stays where it was, plus the *patient
 *      re-probe* window (PRE_DUMP_PATIENCE_MS) the manager applies before the
 *      destructive dump+restart path so a bounded stall can be told apart from a
 *      dead process.
 */

/** Cadence of the manager's liveness probe. */
export const WATCHDOG_TICK_MS = 3000

/**
 * After the URL is armed the supervisor keeps its silent warm-up: misses are not
 * counted at all for this long (plugin bootstrap / first page build), matching the
 * pre-existing 2026-09-05 restart-storm fix.
 */
export const STARTUP_MUTE_MS = 30_000

/**
 * Startup window after the dsh web URL is armed, during which a slow child is
 * expected: plugins load, indexes build, first-session state is built.
 */
export const STARTUP_GRACE_MS = 120_000

/** Within the startup window: this many consecutive misses ... */
export const STARTUP_MISS_LIMIT = 5
/** ... AND at least this long without a single answered probe are required. */
export const STARTUP_MIN_WINDOW_MS = 15_000

/** Outside the startup window the historical threshold is kept: 3 misses ... */
export const STEADY_MISS_LIMIT = 3
/** ... covering at least this long (3 ticks x WATCHDOG_TICK_MS). */
export const STEADY_MIN_WINDOW_MS = 9_000

/**
 * Before the destructive path (shell dump + kill + restart), the manager re-probes
 * with this *patient* timeout: a service that answers again — however slowly — is
 * declared stalled, not dead. A genuinely dead child just pays this extra window;
 * the restart safety boundary is unchanged.
 */
export const PRE_DUMP_PATIENCE_MS = 15_000

/**
 * Thresholds that apply for a given time since the dsh web URL was armed.
 * @param {number} elapsedSinceStartMs - milliseconds since the reported URL was armed.
 * @returns {{ phase: 'startup' | 'steady', missLimit: number, minWindowMs: number }}
 */
export function watchdogThresholds(elapsedSinceStartMs) {
  const startup = Number.isFinite(elapsedSinceStartMs) && elapsedSinceStartMs >= 0 && elapsedSinceStartMs < STARTUP_GRACE_MS
  return startup
    ? { phase: 'startup', missLimit: STARTUP_MISS_LIMIT, minWindowMs: STARTUP_MIN_WINDOW_MS }
    : { phase: 'steady', missLimit: STEADY_MISS_LIMIT, minWindowMs: STEADY_MIN_WINDOW_MS }
}

/**
 * Decide whether the miss streak justifies the recovery path.
 * Both conditions must hold: enough consecutive misses AND a long enough
 * no-response window (a burst of fast transport errors is not a hang).
 * @param {object} facts
 * @param {number} facts.elapsedSinceStartMs - milliseconds since the URL was armed.
 * @param {number} facts.consecutiveMisses - unanswered probes in the current streak.
 * @param {number} [facts.missIntervalMs] - probe cadence, used to derive the window.
 * @param {number} [facts.missWindowMs] - explicit window when the caller measured it.
 * @returns {{ restart: boolean, phase: 'startup' | 'steady', missLimit: number, minWindowMs: number, windowMs: number, reason: string }}
 */
export function decideWatchdogRestart({ elapsedSinceStartMs, consecutiveMisses, missIntervalMs = WATCHDOG_TICK_MS, missWindowMs }) {
  const misses = Number.isFinite(consecutiveMisses) && consecutiveMisses > 0 ? Math.floor(consecutiveMisses) : 0
  const { phase, missLimit, minWindowMs } = watchdogThresholds(elapsedSinceStartMs)
  const windowMs = Number.isFinite(missWindowMs)
    ? Math.max(0, missWindowMs)
    : misses * (Number.isFinite(missIntervalMs) ? Math.max(0, missIntervalMs) : WATCHDOG_TICK_MS)
  const missesReached = misses >= missLimit
  const windowReached = windowMs >= minWindowMs
  const restart = missesReached && windowReached
  let reason
  if (!missesReached) reason = phase + ': ' + misses + '/' + missLimit + ' miss(es), window ' + windowMs + 'ms'
  else if (!windowReached) reason = phase + ': window ' + windowMs + 'ms < ' + minWindowMs + 'ms despite ' + misses + ' miss(es)'
  else reason = phase + ': ' + misses + ' miss(es) over ' + windowMs + 'ms (threshold ' + missLimit + '/' + minWindowMs + 'ms)'
  return { restart, phase, missLimit, minWindowMs, windowMs, reason }
}
