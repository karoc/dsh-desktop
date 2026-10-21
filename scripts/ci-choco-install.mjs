#!/usr/bin/env node
// Bounded-retry wrapper around the ONE Chocolatey install in build.yml (7zip).
//
// Why this file exists (2026-10-22): the windows job downloaded 7-Zip from the
// community feed on every run (`choco install 7zip -y --no-progress`). When that
// feed hiccuped — run 39282899675 logged
//   Failed to fetch results from V2 feed at 'https://community.chocolatey.org/api/v2/...'
//   Response status code does not indicate success: 499
//   Chocolatey installed 0/1 packages. 1 packages failed.
// — the step exited 1 and took the whole windows job (and therefore `release`)
// down with it. A transient third-party HTTP error must not decide our release;
// but swallowing the error would be worse (a missing 7-Zip means the NSIS
// layout assertion silently stops running). So: bounded retries, loud about
// every reason, and a hard failure once the budget is spent.
//
// Two things keep the dependency small:
//   1. If 7-Zip is ALREADY on the runner (C:\Program Files\7-Zip\7z.exe — the
//      same path the assertion step uses), Choco is never contacted.
//   2. `--no-progress --limit-output` keeps the V2 feed round-trip as small and
//      as machine-parseable as possible.
//
// Testability: the choco binary is injectable (DSH_CHOCO_ARGV / DSH_CHOCO_BIN),
// the 7-Zip candidate list is injectable (DSH_7Z_CANDIDATES) and the retry
// delay is injectable (DSH_CHOCO_RETRY_DELAY_MS), so `--self-test` proves both
// directions locally (2 failures then success ⇒ green; 3 failures ⇒ red).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const PKG = "7zip";
const ATTEMPTS = intEnv("DSH_CHOCO_ATTEMPTS", 3, 1, 10);
const DELAY_MS = intEnv("DSH_CHOCO_RETRY_DELAY_MS", 25_000, 0, 300_000);
const TAIL_LINES = 12;

function intEnv(name, dflt, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    console.error(`[ci-choco] invalid ${name}=${raw} (expected ${min}..${max})`);
    process.exit(2);
  }
  return Math.trunc(n);
}

function defaultCandidates() {
  if (process.platform !== "win32") return [];
  return [
    String.raw`C:\Program Files\7-Zip\7z.exe`,
    String.raw`C:\Program Files (x86)\7-Zip\7z.exe`,
  ];
}

function candidates() {
  const raw = process.env.DSH_7Z_CANDIDATES;
  const list = raw === undefined ? defaultCandidates() : raw.split(path.delimiter);
  return list.map((s) => s.trim()).filter(Boolean);
}

function find7z() {
  for (const c of candidates()) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* not there — keep probing */
    }
  }
  return null;
}

function chocoArgv() {
  // DSH_CHOCO_ARGV is a JSON array ([exe, ...baseArgs]) so the self-test can
  // point at `node stub.mjs` on any platform without shell quoting games.
  if (process.env.DSH_CHOCO_ARGV) {
    let parsed;
    try {
      parsed = JSON.parse(process.env.DSH_CHOCO_ARGV);
    } catch (e) {
      console.error(`[ci-choco] invalid DSH_CHOCO_ARGV: ${e.message}`);
      process.exit(2);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      console.error("[ci-choco] DSH_CHOCO_ARGV must be a non-empty JSON array");
      process.exit(2);
    }
    return { cmd: String(parsed[0]), base: parsed.slice(1).map(String) };
  }
  return { cmd: process.env.DSH_CHOCO_BIN || "choco", base: [] };
}

function tail(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n").filter((l) => l !== "");
  const out = lines.slice(-TAIL_LINES);
  return out.map((l) => `  | ${l}`).join("\n");
}

// Turn Chocolatey's output into one human reason. Prefer the most specific
// line so a future reader of the CI log sees WHY, not just "exit 1".
function classifyFailure(output) {
  const text = String(output || "");
  const patterns = [
    /Failed to fetch results from V2 feed at '[^']*'[^\n]*/,
    /Unable to connect to source '[^']*'[^\n]*/,
    /Response status code does not indicate success: [^\n]*/,
    /The remote server returned an error: [^\n]*/,
    /Unable to resolve dependency[^\n]*/,
    /The package was not found with the source\(s\) listed[^\n]*/,
    /installed 0\/\d+ packages[^\n]*/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0].trim();
  }
  return null;
}

function tryInstallOnce(n) {
  const { cmd, base } = chocoArgv();
  const args = [...base, "install", PKG, "-y", "--no-progress", "--limit-output"];
  console.log(`[ci-choco] attempt ${n}/${ATTEMPTS}: ${cmd} ${args.slice(base.length).join(" ")}`);
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    // Hard cap so a hung feed cannot eat the job's whole budget.
    timeout: 180_000,
  });
  const output = `${r.stdout || ""}${r.stderr || ""}`;
  if (r.error) {
    return { ok: false, reason: `could not run ${cmd}: ${r.error.message}`, output };
  }
  if (r.status !== 0) {
    const cls = classifyFailure(output);
    return {
      ok: false,
      reason: cls ? `${cls} (exit ${r.status})` : `choco exited ${r.status}`,
      output,
    };
  }
  const found = find7z();
  if (!found) {
    return {
      ok: false,
      reason: `choco exited 0 but 7z.exe is not at any probe location (${candidates().join(" ; ")})`,
      output,
    };
  }
  return { ok: true, found, output };
}

function sleepMs(ms) {
  if (ms <= 0) return;
  // Synchronous sleep without spawning anything (no `sleep`/`timeout` on win32).
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function main() {
  const preinstalled = find7z();
  if (preinstalled) {
    console.log(`[ci-choco] 7-Zip already present at ${preinstalled} — skipping Chocolatey entirely`);
    return 0;
  }
  console.log(`[ci-choco] 7-Zip absent; installing ${PKG} from Chocolatey (max ${ATTEMPTS} attempts, ${DELAY_MS}ms apart)`);
  let lastReason = "no attempt ran";
  for (let n = 1; n <= ATTEMPTS; n++) {
    const r = tryInstallOnce(n);
    if (r.ok) {
      console.log(`[ci-choco] PASS: ${PKG} installed (attempt ${n}/${ATTEMPTS}) → ${r.found}`);
      return 0;
    }
    lastReason = r.reason;
    console.error(`[ci-choco] attempt ${n}/${ATTEMPTS} FAILED: ${r.reason}`);
    if (r.output) console.error(tail(r.output));
    if (n < ATTEMPTS) {
      console.error(`[ci-choco] retrying in ${DELAY_MS}ms (attempt ${n + 1}/${ATTEMPTS}) — transient feed errors are the expected cause`);
      sleepMs(DELAY_MS);
    }
  }
  console.error(
    `[ci-choco] FAIL: could not install ${PKG} after ${ATTEMPTS} attempts (last reason: ${lastReason}). ` +
      "不吞错：这一步红，windows 作业就红；否则缺 7-Zip 时 NSIS 布局断言会静默失效。",
  );
  return 1;
}

// ── self-test: proves the retry logic can fail (negative control) ──────────
// Four scenarios, each a real child process of THIS file:
//   1. fail, fail, success ⇒ exit 0 (retry actually retries)
//   2. fail × 3            ⇒ exit 1 (budget exhaustion is loud)
//   3. success on 1st      ⇒ exit 0 and exactly 1 choco invocation (no retry loop overshoot)
//   4. 7-Zip already there ⇒ exit 0 and choco never invoked (external feed not touched)
function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "choco-selftest-"));
  const state = path.join(tmp, "calls.txt");
  const sevenZ = path.join(tmp, "fake-7z.exe");
  const stub = path.join(tmp, "choco-stub.mjs");
  fs.writeFileSync(
    stub,
    `import fs from "node:fs";\n` +
      `const state = process.env.STUB_STATE, n = (fs.existsSync(state) ? Number(fs.readFileSync(state, "utf8")) : 0) + 1;\n` +
      `fs.writeFileSync(state, String(n));\n` +
      `const failTimes = Number(process.env.STUB_FAIL_TIMES || 0);\n` +
      `if (n <= failTimes) {\n` +
      `  console.error("Unable to connect to source 'https://community.chocolatey.org/api/v2/':");\n` +
      `  console.error(" Failed to fetch results from V2 feed at 'https://community.chocolatey.org/api/v2/Packages()' with following message : Response status code does not indicate success: 499 (<none>).");\n` +
      `  console.error("Chocolatey installed 0/1 packages. 1 packages failed.");\n` +
      `  process.exit(1);\n` +
      `}\n` +
      `fs.writeFileSync(process.env.STUB_TOUCH_7Z, "stub 7z");\n` +
      `console.log("The install of 7zip was successful.");\n`,
  );

  const scenarios = [
    { name: "2 failures then success ⇒ green", failTimes: 2, existing7z: false, expectExit: 0, expectCalls: 3 },
    { name: "3 failures ⇒ red", failTimes: 3, existing7z: false, expectExit: 1, expectCalls: 3 },
    { name: "success on first try ⇒ green, 1 call", failTimes: 0, existing7z: false, expectExit: 0, expectCalls: 1 },
    { name: "7-Zip preinstalled ⇒ green, 0 calls", failTimes: 9, existing7z: true, expectExit: 0, expectCalls: 0 },
  ];

  let failed = 0;
  for (const s of scenarios) {
    fs.rmSync(state, { force: true });
    fs.rmSync(sevenZ, { force: true });
    if (s.existing7z) fs.writeFileSync(sevenZ, "already here");
    const env = {
      ...process.env,
      DSH_CHOCO_ARGV: JSON.stringify([process.execPath, stub]),
      DSH_CHOCO_ATTEMPTS: "3",
      DSH_CHOCO_RETRY_DELAY_MS: "0",
      DSH_7Z_CANDIDATES: sevenZ,
      STUB_STATE: state,
      STUB_FAIL_TIMES: String(s.failTimes),
      STUB_TOUCH_7Z: sevenZ,
    };
    const r = spawnSync(process.execPath, [process.argv[1]], { encoding: "utf8", env });
    const calls = fs.existsSync(state) ? Number(fs.readFileSync(state, "utf8")) : 0;
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    const problems = [];
    if (r.status !== s.expectExit) problems.push(`exit=${r.status} expected ${s.expectExit}`);
    if (calls !== s.expectCalls) problems.push(`choco calls=${calls} expected ${s.expectCalls}`);
    if (s.expectExit === 1 && !/FAIL: could not install 7zip after 3 attempts/.test(out)) {
      problems.push("missing loud final failure line");
    }
    if (s.expectExit === 0 && !/PASS: 7zip installed|skipping Chocolatey/.test(out)) {
      problems.push("missing success line");
    }
    if (!s.existing7z && s.failTimes >= 1 && s.expectExit === 0 && !/attempt 1\/3 FAILED/.test(out)) {
      problems.push("first-attempt failure was not reported");
    }
    if (problems.length) {
      failed++;
      console.error(`[ci-choco self-test] FAIL — ${s.name}: ${problems.join("; ")}`);
      console.error(`${out.split("\n").slice(-20).join("\n")}`);
    } else {
      console.log(`[ci-choco self-test] PASS — ${s.name} (exit ${r.status}, choco calls ${calls})`);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed) {
    console.error(`[ci-choco self-test] ${failed}/${scenarios.length} scenarios FAILED`);
    return 1;
  }
  console.log(`[ci-choco self-test] all ${scenarios.length} scenarios passed (retry can pass, exhaustion can fail)`);
  return 0;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  process.exit(runSelfTest());
} else {
  process.exit(main());
}
