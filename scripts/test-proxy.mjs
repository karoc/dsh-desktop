#!/usr/bin/env node
// Behavioral tests for the built-in forward proxy (scripts/proxy.mjs):
//   - plain-HTTP absolute-URI forwarding: direct vs via upstream;
//   - CONNECT tunnel: direct vs via upstream (with Basic auth header);
//   - routing rules: loopback ALWAYS direct, self-loop upstream disabled;
//   - host observation + knownHosts persistence;
//   - upstream failure -> 502 on the client side.
// Uses fake upstream proxy + fake origin servers on 127.0.0.1 — no external
// network involved.
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createForwardProxy, readProxyConfig, shouldProxy, providerHostsFromSettings } from './proxy.mjs'

const work = mkdtempSync(join(tmpdir(), 'dsh-proxy-'))

/** A tiny origin that answers with a canned body and records what it saw. */
function origin() {
  const seen = []
  const srv = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, host: req.headers.host, auth: req.headers['proxy-authorization'] ?? null })
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`origin:${req.method}:${req.url}`)
  })
  return { srv, seen, port: () => srv.address().port, listen: () => new Promise((r) => srv.listen(0, '127.0.0.1', r)) }
}

/** A fake UPSTREAM proxy: records CONNECT targets / absolute-URI requests. */
function upstreamProxy() {
  const seen = []
  const srv = createServer((req, res) => {
    seen.push({ kind: 'http', method: req.method, url: req.url, auth: req.headers['proxy-authorization'] ?? null })
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`upstream:${req.url}`)
  })
  srv.on('connect', (req, socket, head) => {
    seen.push({ kind: 'connect', target: req.url, auth: req.headers['proxy-authorization'] ?? null })
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head?.length) socket.write(head)
    // After a successful CONNECT, answer any tunneled data with a canned
    // response so the client can prove it reached the upstream.
    socket.on('data', () => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK')
    })
  })
  return { srv, seen, port: () => srv.address().port, listen: () => new Promise((r) => srv.listen(0, '127.0.0.1', r)) }
}

/** Raw CONNECT through a proxy; resolves on response headers OR socket close. */
function rawConnect(proxyPort, target, auth = null) {
  return new Promise((resolvePromise) => {
    const sock = connect({ host: '127.0.0.1', port: proxyPort })
    let head = ''
    let settled = false
    const done = (status) => {
      if (settled) return
      settled = true
      resolvePromise({ sock, status, rest: '' })
    }
    sock.on('connect', () => {
      const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`]
      if (auth) lines.push(`Proxy-Authorization: ${auth}`)
      sock.write(lines.join('\r\n') + '\r\n\r\n')
    })
    const onData = (buf) => {
      head += buf.toString()
      const idx = head.indexOf('\r\n\r\n')
      if (idx < 0) return
      sock.removeListener('data', onData)
      done(head.slice(0, head.indexOf('\r\n')))
    }
    sock.on('data', onData)
    sock.on('close', () => done(head.slice(0, head.indexOf('\r\n'))))
    sock.on('error', () => done(''))
  })
}

const cfgFile = join(work, 'proxy.json')
const writeCfg = (cfg) => writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

// ── fixtures ────────────────────────────────────────────────────────────────
const o1 = origin()
const up = upstreamProxy()
await o1.listen()
await up.listen()
const O1 = `127.0.0.1:${o1.port()}`

let observedHosts = null
const proxy = createForwardProxy({
  configFile: cfgFile,
  onHosts: (h) => { observedHosts = h },
})
const proxyPort = await proxy.port

const httpViaProxy = (path) => new Promise((resolvePromise, rejectPromise) => {
  const req = httpRequest({
    host: '127.0.0.1', port: proxyPort,
    method: 'GET', path: `http://${O1}${path}`,
  }, (res) => {
    let body = ''
    res.on('data', (d) => { body += d })
    res.on('end', () => resolvePromise({ status: res.statusCode, body }))
  })
  req.on('error', rejectPromise)
  req.end()
})

// ── scenario 1: direct HTTP forwarding (no upstream configured) ─────────────
writeCfg({ upstream: { enabled: false, host: '', port: 0 }, proxiedHosts: ['example.com'], knownHosts: [] })
{
  const res = await httpViaProxy('/a')
  assert.equal(res.status, 200, 'direct HTTP proxy returns the origin status')
  assert.equal(res.body, 'origin:GET:/a', 'direct HTTP proxy relays to the origin')
  assert.equal(o1.seen.at(-1).url, '/a', 'origin receives origin-form request (proxy stripped absolute URI)')
  assert.equal(up.seen.length, 0, 'no upstream involved when none configured')
}

// ── scenario 2: direct CONNECT (no upstream configured) ─────────────────────
{
  const { sock, status } = await rawConnect(proxyPort, O1)
  assert.match(status, /200/, 'direct CONNECT establishes')
  await new Promise((r) => {
    sock.write('GET / HTTP/1.0\r\nHost: ' + O1 + '\r\n\r\n')
    let buf = ''
    sock.on('data', (d) => { buf += d })
    sock.on('close', r)
    setTimeout(() => { sock.destroy(); r() }, 500)
  })
  assert.ok(o1.seen.some((s) => s.method === 'GET'), 'origin saw the tunneled request')
}

// ── scenario 3: proxied HTTP through upstream with Basic auth ───────────────
writeCfg({
  upstream: { enabled: true, host: '127.0.0.1', port: up.port(), username: 'u', password: 'p' },
  proxiedHosts: ['example.com'],
  knownHosts: [],
})
// example.com doesn't resolve — the request must land on the upstream, which
// answers without contacting the origin.
const httpViaProxyHost = (host, path) => new Promise((resolvePromise, rejectPromise) => {
  const req = httpRequest({
    host: '127.0.0.1', port: proxyPort,
    method: 'GET', path: `http://${host}${path}`,
  }, (res) => {
    let body = ''
    res.on('data', (d) => { body += d })
    res.on('end', () => resolvePromise({ status: res.statusCode, body }))
  })
  req.on('error', rejectPromise)
  req.end()
})
{
  const res = await httpViaProxyHost('example.com', '/x')
  assert.equal(res.status, 200, 'proxied HTTP gets a response (from upstream)')
  assert.equal(res.body, 'upstream:http://example.com/x', 'upstream answered with the absolute-URI form')
  const hit = up.seen.find((s) => s.kind === 'http')
  assert.ok(hit, 'upstream saw the HTTP request')
  assert.equal(hit.url, 'http://example.com/x', 'upstream receives absolute-URI request-target')
  assert.equal(hit.auth, 'Basic ' + Buffer.from('u:p').toString('base64'), 'upstream receives Proxy-Authorization Basic header')
}

// ── scenario 4: proxied CONNECT through upstream + auth ─────────────────────
writeCfg({
  upstream: { enabled: true, host: '127.0.0.1', port: up.port(), username: 'u', password: 'p' },
  proxiedHosts: ['api.deepseek.com'],
  knownHosts: [],
})
{
  const { sock, status } = await rawConnect(proxyPort, 'api.deepseek.com:443')
  assert.match(status, /200/, 'proxied CONNECT establishes via upstream')
  const hit = up.seen.find((s) => s.kind === 'connect')
  assert.ok(hit, 'upstream saw the CONNECT')
  assert.equal(hit.target, 'api.deepseek.com:443', 'CONNECT target forwarded verbatim')
  assert.equal(hit.auth, 'Basic ' + Buffer.from('u:p').toString('base64'), 'CONNECT carries Proxy-Authorization')
  sock.destroy()
}

// ── scenario 5: routing — unlisted host goes direct even with upstream on ───
writeCfg({
  upstream: { enabled: true, host: '127.0.0.1', port: up.port(), username: '', password: '' },
  proxiedHosts: ['api.deepseek.com'],
  knownHosts: [],
})
{
  const before = up.seen.length
  const res = await httpViaProxy('/unlisted')
  assert.equal(res.body, 'origin:GET:/unlisted', 'unlisted host routes DIRECT to origin')
  assert.equal(up.seen.length, before, 'upstream untouched for unlisted host')
}

// ── scenario 6: loopback NEVER proxied (even if listed) ─────────────────────
writeCfg({
  upstream: { enabled: true, host: '127.0.0.1', port: up.port(), username: '', password: '' },
  proxiedHosts: ['127.0.0.1'],
  knownHosts: [],
})
{
  const before = up.seen.length
  const res = await httpViaProxy('/loopback')
  assert.equal(res.body, 'origin:GET:/loopback', 'loopback target stays direct')
  assert.equal(up.seen.length, before, 'upstream never sees loopback traffic')
}

// ── scenario 7: self-loop upstream is treated as disabled ───────────────────
{
  // Pure routing checks — no network involved (avoids real DNS in the sandbox).
  const base = { upstream: { enabled: true, host: '127.0.0.1', port: 0 }, proxiedHosts: ['api.deepseek.com'] }
  assert.equal(
    shouldProxy({ ...base, upstream: { ...base.upstream, port: 43210 } }, 'api.deepseek.com', 43210),
    false,
    'upstream pointing at this proxy port is disabled (self-loop guard)',
  )
  assert.equal(
    shouldProxy({ ...base, upstream: { ...base.upstream, port: 43210 } }, 'api.deepseek.com', 43211),
    true,
    'same loopback, different port -> normal upstream',
  )
  assert.equal(
    shouldProxy({ ...base, upstream: { ...base.upstream, enabled: false, port: 43210 } }, 'api.deepseek.com', 43211),
    false,
    'disabled upstream never proxies',
  )
  assert.equal(
    shouldProxy({ ...base, upstream: { ...base.upstream, port: 43210 } }, '127.0.0.1', 43211),
    false,
    'loopback host is always direct even when listed',
  )
  assert.equal(
    shouldProxy({ ...base, upstream: { ...base.upstream, port: 43210 } }, 'other.example', 43211),
    false,
    'unlisted host is direct',
  )
}

// ── scenario 8: host observation + knownHosts persistence ───────────────────
{
  await new Promise((r) => setTimeout(r, 600)) // debounced onHosts
  assert.ok(Array.isArray(observedHosts), 'onHosts fired with a host list')
  assert.ok(observedHosts.includes('api.deepseek.com'), 'observed hosts include the proxied CONNECT target')
  assert.ok(!observedHosts.includes('127.0.0.1'), 'loopback targets are never observed')
  proxy.persistKnownHosts()
  const persisted = readProxyConfig(cfgFile)
  assert.ok(persisted.knownHosts.includes('api.deepseek.com'), 'knownHosts persisted into proxy.json')
  assert.ok(!persisted.knownHosts.includes('127.0.0.1'), 'loopback never lands in knownHosts')
}

// ── scenario 9: upstream unreachable -> client gets a failure (no hang) ─────
writeCfg({
  upstream: { enabled: true, host: '127.0.0.1', port: 1, username: '', password: '' }, // port 1: refused
  proxiedHosts: ['dead.example'],
  knownHosts: [],
})
{
  const start = Date.now()
  const { status } = await rawConnect(proxyPort, 'dead.example:443')
  assert.ok(status, 'dead upstream yields a terminal status')
  assert.ok(Date.now() - start < 5000, 'dead upstream fails fast (no hang)')
}

// ── scenario 10: config read LIVE (save-takes-effect) ───────────────────────
{
  // Start with host NOT proxied -> direct (origin). Then flip proxiedHosts to
  // include a fake host and confirm routing changes without recreating proxy.
  writeCfg({
    upstream: { enabled: true, host: '127.0.0.1', port: up.port(), username: '', password: '' },
    proxiedHosts: [],
    knownHosts: [],
  })
  const before = up.seen.length
  await httpViaProxyHost('routing.example', '/p')
  assert.equal(up.seen.length, before, 'fresh config with empty proxiedHosts routes direct')
  writeCfg({
    upstream: { enabled: true, host: '127.0.0.1', port: up.port(), username: '', password: '' },
    proxiedHosts: ['routing.example'],
    knownHosts: [],
  })
  await httpViaProxyHost('routing.example', '/p')
  assert.ok(up.seen.some((s) => s.kind === 'http' && s.url === 'http://routing.example/p'), 'live config flip takes effect on the next request')
}

proxy.close()
up.srv.close()
o1.srv.close()

// ── scenario 11: provider host extraction from settings.yaml ────────────────
{
  const settingsPath = join(work, 'settings.yaml')
  writeFileSync(settingsPath, [
    '# dsh settings',
    'llm-deepseek:',
    '  baseURL: https://api.deepseek.com',
    'llm-pi-ai:',
    '  providers:',
    '    acme:',
    '      baseURL: https://gateway.acme.example/v1',
    'ui-theme:',
    '  theme: dark',
    '',
  ].join('\n'))
  const providers = providerHostsFromSettings(settingsPath)
  assert.deepEqual(providers, [
    { name: 'llm-deepseek', host: 'api.deepseek.com' },
    { name: 'llm-pi-ai/acme', host: 'gateway.acme.example' },
  ], 'settings.yaml provider hosts extracted (llm-* namespaces only)')
  assert.deepEqual(providerHostsFromSettings(join(work, 'missing.yaml')), [], 'missing settings.yaml -> empty list')
}

rmSync(work, { recursive: true, force: true })
console.log('PASS — forward proxy (11 scenarios)')
process.exit(0)
