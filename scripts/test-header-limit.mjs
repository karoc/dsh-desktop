#!/usr/bin/env node
// Contract test for the "cookie-431" failure class (2026-09-20 incident):
// Node's http server enforces `maxHeaderSize` (default 16384 B) on the
// **request line + headers**; a request whose Cookie header grew past the
// budget is answered with `431 Request Header Fields Too Large` before any
// handler runs. dsh web issues one auth cookie per dsh-web port, so an embedder
// that restarts `dsh web --port 0` grows that header monotonically; the client
// plugin batch URL (~2.85 KB, the only >1 KB URL on the page) is the first
// victim, which makes every client plugin fail to import.
//
// This test pins both halves of the fix contract:
//   1. default budget: a 2830-byte request line + 13.6 KB cookie → 431,
//      while the same cookie with a 69-byte request line → 200
//      (i.e. the long URL dies first — the exact observed asymmetry);
//   2. `--max-http-header-size=65536` (what the manager now injects for the
//      dsh web child) → the same long request → 200.
//
// Pure Node, no network beyond loopback, ~1s. Runs in `npm test`.
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import net from 'node:net'

const SERVER_SRC = `
const http = require('node:http')
const srv = http.createServer((req, res) => { res.writeHead(200, {'content-type':'text/plain'}); res.end('ok') })
srv.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: srv.address().port, maxHeaderSize: http.maxHeaderSize }) + '\\n')
})
`

/** Start a loopback server (optionally with extra node args) and wait for its port. */
function startServer(extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...extraArgs, '-e', SERVER_SRC], { stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    const timer = setTimeout(() => reject(new Error('server did not report its port')), 10_000)
    child.stdout.on('data', (chunk) => {
      buf += String(chunk)
      const line = buf.split('\n')[0]
      if (!line) return
      try {
        const info = JSON.parse(line)
        clearTimeout(timer)
        resolve({ child, ...info })
      } catch {
        /* keep buffering */
      }
    })
    child.on('error', reject)
  })
}

/** Send one raw HTTP/1.1 request; return the status code (0 when no response). */
function rawGet(port, path, cookieBytes) {
  return new Promise((resolve, reject) => {
    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Connection: close',
    ]
    if (cookieBytes > 0) lines.push(`Cookie: pad=${'A'.repeat(cookieBytes)}`)
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
      sock.write(lines.join('\r\n') + '\r\n\r\n')
    })
    let data = ''
    sock.setTimeout(10_000, () => sock.destroy(new Error('timeout')))
    sock.on('data', (chunk) => { data += String(chunk) })
    sock.on('error', reject)
    sock.on('close', () => {
      const m = data.match(/^HTTP\/1\.1 (\d{3})/)
      resolve(m ? Number(m[1]) : 0)
    })
  })
}

const LONG_PATH = '/plugins/??' + 'x'.repeat(2818) // 2830-byte request line, like the real batch URL
const SHORT_PATH = '/plugins/??@deepseek-ai/dsh-client-modules/client.js'
const BIG_COOKIE = 13_600 // ≈60 accumulated 226-byte dsh-auth cookies

const dflt = await startServer()
assert.equal(dflt.maxHeaderSize, 16_384, 'default http.maxHeaderSize is 16 KiB')

const longDefault = await rawGet(dflt.port, LONG_PATH, BIG_COOKIE)
const shortDefault = await rawGet(dflt.port, SHORT_PATH, BIG_COOKIE)
assert.equal(longDefault, 431, 'default budget: long URL + 13.6 KB cookie → 431')
assert.equal(shortDefault, 200, 'default budget: same cookie + short URL still passes (long URL dies first)')

const raised = await startServer(['--max-http-header-size=65536'])
assert.equal(raised.maxHeaderSize, 65_536, '--max-http-header-size=65536 raises the budget')
const longRaised = await rawGet(raised.port, LONG_PATH, BIG_COOKIE)
assert.equal(longRaised, 200, 'raised budget: the same long request passes')

dflt.child.kill()
raised.child.kill()

console.log('PASS — header budget contract (long-URL-first 431 + --max-http-header-size fix)')
