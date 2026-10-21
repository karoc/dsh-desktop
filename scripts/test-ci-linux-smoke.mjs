#!/usr/bin/env node
// Negative controls for scripts/ci-linux-smoke.sh — the CI gate must be able to
// FAIL. History: the linux-smoke canary spent months "green" at run level
// (continue-on-error) while its step deterministically failed on a fixed
// `sleep 18`; a canary nobody has watched fail is not a canary.
//
// These scenarios drive the real script end-to-end with a stub binary and a
// stubbed display/bus, so no deb, xvfb or WebKitGTK is needed:
//   silent app        ⇒ red (resources root line never appears)
//   bogus resources   ⇒ red (directory does not exist)
//   resources w/o node⇒ red (bundled node absent)
//   no URL event      ⇒ red
//   complete chain    ⇒ green
//   app dies early    ⇒ red (and it says so instead of waiting the full budget)
//   missing artifact  ⇒ red (no silent pass when the deb is gone)
//
// Run: node scripts/test-ci-linux-smoke.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const REPO = path.resolve(import.meta.dirname, "..");
const SMOKE = path.join(REPO, "scripts", "ci-linux-smoke.sh");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ci-linux-smoke-test-"));

// Fake wrappers so the script's `xvfb-run` / `dbus-run-session` calls are no-ops
// that just exec the real command.
const binDir = path.join(tmp, "bin");
fs.mkdirSync(binDir);
const wrap = (name, opts) =>
  fs.writeFileSync(
    path.join(binDir, name),
    `#!/usr/bin/env bash\n# stub: drop ${opts} option(s), then exec\nwhile [ "$1" = "-a" ] || [ "$1" = "--" ] || [ "$1" = "--auto-servernum" ]; do shift; done\nexec "$@"\n`,
    { mode: 0o755 },
  );
wrap("xvfb-run", "-a");
wrap("dbus-run-session", "--");

const home = path.join(tmp, "home");
fs.mkdirSync(home, { recursive: true });
const resOk = path.join(tmp, "resources");
fs.mkdirSync(path.join(resOk, "node", "linux-x64"), { recursive: true });
fs.writeFileSync(path.join(resOk, "node", "linux-x64", "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
const resNoNode = path.join(tmp, "resources-no-node");
fs.mkdirSync(resNoNode, { recursive: true });

const stub = (name, body) => {
  const p = path.join(tmp, `${name}.sh`);
  fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return p;
};
const keepalive = "sleep 120";

const scenarios = [
  {
    name: "complete chain ⇒ green",
    bin: stub("ok", `echo "[dsh-desktop] resources root: ${resOk}"; echo '[dsh-desktop manager] {"t":"url","url":"http://127.0.0.1:39999"}'; ${keepalive}`),
    expectExit: 0,
    expect: [/SMOKE PASS/],
  },
  {
    name: "silent app (old sleep-18 failure mode) ⇒ red",
    bin: stub("silent", keepalive),
    expectExit: 1,
    expect: [/resources root line never appeared/],
  },
  {
    name: "resources root that does not exist ⇒ red",
    bin: stub("bad-root", `echo "[dsh-desktop] resources root: ${path.join(tmp, "nope")}"; ${keepalive}`),
    expectExit: 1,
    expect: [/resources root does not exist/],
  },
  {
    name: "resources root without bundled node ⇒ red",
    bin: stub("no-node", `echo "[dsh-desktop] resources root: ${resNoNode}"; ${keepalive}`),
    expectExit: 1,
    expect: [/bundled node absent/],
  },
  {
    name: "no URL event ⇒ red",
    bin: stub("no-url", `echo "[dsh-desktop] resources root: ${resOk}"; ${keepalive}`),
    expectExit: 1,
    expect: [/URL event never appeared/],
  },
  {
    name: "app dies before printing ⇒ red, fast",
    bin: stub("dies", "exit 3"),
    expectExit: 1,
    expect: [/app process exited/],
    maxSeconds: 8,
  },
];

let failed = 0;
for (const s of scenarios) {
  const started = Date.now();
  const r = spawnSync("bash", [SMOKE], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: home,
      SMOKE_APP_BIN: s.bin,
      SMOKE_WAIT_SECONDS: "2",
      SMOKE_TIMEOUT_SECONDS: "10",
      SMOKE_POLL_SECONDS: "1",
      SMOKE_LOG: path.join(tmp, `${path.basename(s.bin)}.log`),
    },
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const secs = (Date.now() - started) / 1000;
  const problems = [];
  if (r.status !== s.expectExit) problems.push(`exit=${r.status} expected ${s.expectExit}`);
  for (const re of s.expect) if (!re.test(out)) problems.push(`missing output ${re}`);
  if (s.maxSeconds !== undefined && secs > s.maxSeconds) problems.push(`took ${secs}s (> ${s.maxSeconds}s)`);
  if (problems.length) {
    failed++;
    console.error(`[smoke-self-test] FAIL — ${s.name}: ${problems.join("; ")}`);
    console.error(out.split("\n").slice(-25).join("\n"));
  } else {
    console.log(`[smoke-self-test] PASS — ${s.name} (exit ${r.status}, ${secs.toFixed(1)}s)`);
  }
}

// No artifact and no stub ⇒ must not pass.
{
  const r = spawnSync("bash", [SMOKE], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: home,
      ARTIFACT_DIR: path.join(tmp, "does-not-exist"),
      SMOKE_WAIT_SECONDS: "2",
      SMOKE_TIMEOUT_SECONDS: "10",
    },
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (r.status === 1 && /artifact dir not found/.test(out)) {
    console.log("[smoke-self-test] PASS — missing artifact ⇒ red (exit 1)");
  } else {
    failed++;
    console.error(`[smoke-self-test] FAIL — missing artifact: exit=${r.status}`);
    console.error(out.split("\n").slice(-20).join("\n"));
  }
}

// A deb-less artifact directory must also fail instead of silently passing.
{
  const emptyArtifact = path.join(tmp, "empty-artifact");
  fs.mkdirSync(emptyArtifact);
  const r = spawnSync("bash", [SMOKE], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: home,
      ARTIFACT_DIR: emptyArtifact,
      SMOKE_WAIT_SECONDS: "2",
      SMOKE_TIMEOUT_SECONDS: "10",
    },
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (r.status === 1 && /no \.deb under/.test(out)) {
    console.log("[smoke-self-test] PASS — artifact without a deb ⇒ red (exit 1)");
  } else {
    failed++;
    console.error(`[smoke-self-test] FAIL — artifact without a deb: exit=${r.status}`);
    console.error(out.split("\n").slice(-20).join("\n"));
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
const total = scenarios.length + 2;
if (failed) {
  console.error(`[smoke-self-test] ${failed}/${total} scenarios FAILED`);
  process.exit(1);
}
console.log(`[smoke-self-test] all ${total} scenarios passed (gate can pass, every failure mode is red)`);
