#!/usr/bin/env node
// DSH Desktop — built-in local forward proxy (shell code; never touches dsh).
//
// Runs inside the manager process and is the SINGLE egress point for every
// outbound request the shell starts: dsh model fetch (undici), web search,
// npm install/update, pnpm plugin ops, git, and child CLIs. The manager points
// everything at it via HTTP(S)_PROXY=http://127.0.0.1:<port> +
// NODE_USE_ENV_PROXY=1 + NO_PROXY=127.0.0.1,localhost,::1 (set on the manager's
// own env, so every child inherits the choke point).
//
// Routing is per-host and read LIVE from <runtime>/proxy.json on every
// request, so toggling a host in the settings panel takes effect immediately
// (no dsh restart needed):
//   {
//     "upstream": { "enabled": bool, "host": "", "port": 0,
//                   "username": "", "password": "" },
//     "proxiedHosts": ["api.deepseek.com", ...],   // hosts that go upstream
//     "knownHosts":  ["api.deepseek.com", ...]     // observed, for the UI
//   }
// Default: everything connects DIRECT. Only hosts in `proxiedHosts` (with
// `upstream.enabled`) are forwarded to the upstream proxy, optionally with
// Basic auth (Proxy-Authorization).
//
// Hard safety rules:
//   * loopback targets are ALWAYS direct (never sent to an upstream proxy);
//   * an upstream pointing back at this very proxy is treated as disabled
//     (self-loop guard);
//   * the proxy itself uses raw net/http (never undici's env-proxy), so it can
//     never route its own outbound connections back through itself.

import { createServer, request as httpRequest } from 'node:http'
import { connect as tcpConnect } from 'node:net'
import { readFileSync, writeFileSync } from 'node:fs'

const LOOPBACK = /^(127\.0\.0\.1|localhost|::1|0\.0\.0\.0)$/i

/** Fresh default proxy config (factory so callers never share a mutable copy). */
export function defaultProxyConfig() {
  return {
    upstream: { enabled: false, host: '', port: 0, username: '', password: '' },
    proxiedHosts: [],
    knownHosts: [],
  }
}

/** Read <configFile> (proxy.json), tolerant of a missing/corrupt file. */
export function readProxyConfig(configFile) {
  try {
    const raw = JSON.parse(readFileSync(configFile, 'utf8'))
    return {
      ...defaultProxyConfig(),
      ...(raw ?? {}),
      upstream: { ...defaultProxyConfig().upstream, ...(raw?.upstream ?? {}) },
    }
  } catch {
    return defaultProxyConfig()
  }
}

/**
 * Best-effort extraction of model provider hosts from a dsh settings.yaml
 * (llm-deepseek.baseURL / llm-pi-ai.providers.<n>.baseURL / any other llm-*
 * namespace). Returns [{name, host, displayName?}]: `name` is the dsh
 * namespace (or `ns/provider`), `displayName` the friendly name when known
 * (llm-pi-ai providers carry a `displayName` field; llm-deepseek is fixed to
 * "DeepSeek"). Empty when unreadable — the proxy's observed-host list still
 * populates the settings UI.
 * @param {string} settingsPath
 * @returns {Array<{name: string, host: string, displayName?: string}>}
 */
export function providerHostsFromSettings(settingsPath) {
  const out = []
  let text
  try {
    text = readFileSync(settingsPath, 'utf8')
  } catch {
    return out
  }
  const push = (baseUrl, name, displayName) => {
    try {
      const host = new URL(String(baseUrl).trim()).hostname
      if (host) out.push({ name, ...(displayName ? { displayName } : {}), host })
    } catch { /* malformed baseURL — skip */ }
  }
  // Lightweight two-level walk: a 2-space `providers:` key opens the provider
  // map (llm-pi-ai), whose entries sit at 4 spaces (with an optional
  // `displayName` at 6 spaces); other llm-* namespaces put baseURL directly
  // at 2 spaces (llm-deepseek).
  let ns = null
  let inProviders = false
  let provider = null
  let displayName = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').replace(/\s+$/, '')
    const top = line.match(/^([A-Za-z0-9_.-]+):\s*$/)
    if (top) { ns = top[1]; inProviders = false; provider = null; displayName = null; continue }
    if (!ns?.startsWith('llm-')) continue
    const two = line.match(/^\s{2}([A-Za-z0-9_.-]+):\s*$/)
    if (two) {
      inProviders = two[1] === 'providers'
      provider = inProviders ? null : two[1]
      displayName = null
      continue
    }
    if (inProviders) {
      const four = line.match(/^\s{4}([A-Za-z0-9_.-]+):\s*$/)
      if (four) { provider = four[1]; displayName = null; continue }
      const dn = line.match(/^\s{6}displayName:\s*(.+)$/)
      if (dn) displayName = String(dn[1]).trim().replace(/^['"]|['"]$/g, '')
    }
    const b = line.match(/^\s*baseURL:\s*(.+)$/)
    if (b) {
      const name = provider ? `${ns}/${provider}` : ns
      const disp = displayName || (ns === 'llm-deepseek' ? 'DeepSeek' : null)
      push(b[1], name, disp)
    }
  }
  return out
}

/**
 * Pure routing decision: should `host` go through the upstream proxy?
 * Loopback targets are ALWAYS direct; an upstream pointing back at this very
 * proxy (same loopback + same port) is treated as disabled (self-loop guard).
 * @param {object} cfg - parsed proxy.json config
 * @param {string} host - lowercased target host
 * @param {number} [selfPort] - this proxy's listening port
 */
export function shouldProxy(cfg, host, selfPort) {
  const h = String(host ?? '').toLowerCase()
  if (LOOPBACK.test(h)) return false
  const u = cfg?.upstream
  const selfRef = u?.host && LOOPBACK.test(u.host.toLowerCase()) && Number(u.port) === selfPort
  return Boolean(u?.enabled) && !selfRef && (cfg?.proxiedHosts ?? []).includes(h)
}

/**
 * Start a forward proxy bound to 127.0.0.1:<random>.
 * @param {{ configFile: string, onHosts?: (hosts: string[]) => void,
 *           log?: (line: string) => void }} opts
 * @returns {{
 *   port: Promise<number>,
 *   hosts: () => string[],
 *   config: () => object,
 *   persistKnownHosts: () => void,
 *   close: () => void,
 * }}
 */
export function createForwardProxy({ configFile, onHosts, log = () => {} }) {
  const seenHosts = new Set()
  let notifyTimer = null

  const markHost = (host) => {
    const h = String(host ?? '').trim().toLowerCase()
    if (!h || LOOPBACK.test(h)) return
    if (seenHosts.has(h)) return
    seenHosts.add(h)
    clearTimeout(notifyTimer)
    notifyTimer = setTimeout(() => onHosts?.([...seenHosts].sort()), 400)
  }

  const config = () => readProxyConfig(configFile)

  const upstreamAuth = (cfg) => {
    const u = cfg.upstream
    if (u?.username) {
      return 'Basic ' + Buffer.from(`${u.username}:${u.password ?? ''}`).toString('base64')
    }
    return null
  }

  /** Decide the route for one target host. @returns {{via: 'upstream'|'direct', cfg}} */
  const routeFor = (host, selfPort) => {
    const cfg = config()
    return { via: shouldProxy(cfg, host, selfPort) ? 'upstream' : 'direct', cfg }
  }

  /** Bidirectional relay between two sockets; errors/close tear both down. */
  const pipeTunnel = (a, b) => {
    a.on('error', () => { try { b.destroy() } catch {} })
    b.on('error', () => { try { a.destroy() } catch {} })
    a.pipe(b)
    b.pipe(a)
    const cleanup = () => { try { a.destroy() } catch {}; try { b.destroy() } catch {} }
    a.on('close', cleanup)
    b.on('close', cleanup)
  }

  const server = createServer((req, res) => {
    // Plain-HTTP forward-proxy request: request-target is an absolute URI
    // ("GET http://host:port/path HTTP/1.1") — this is what undici sends for
    // http:// targets.
    let u
    try {
      u = new URL(req.url)
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end('proxy: bad request-target')
      return
    }
    const host = u.hostname.toLowerCase()
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
    if (!host || !port) {
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end('proxy: missing host')
      return
    }
    markHost(host)
    const { via, cfg } = routeFor(host, server.address()?.port)

    const headers = { ...req.headers }
    delete headers['proxy-connection']
    delete headers['connection']
    if (via === 'upstream') {
      const auth = upstreamAuth(cfg)
      if (auth) headers['proxy-authorization'] = auth
      const up = httpRequest(
        { host: cfg.upstream.host, port: Number(cfg.upstream.port), method: req.method, path: req.url, headers },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers)
          upRes.pipe(res)
        },
      )
      up.on('error', (e) => {
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end(`proxy: upstream error: ${e.message}`)
      })
      req.pipe(up)
    } else {
      const up = httpRequest(
        { host, port, method: req.method, path: u.pathname + u.search, headers },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers)
          upRes.pipe(res)
        },
      )
      up.on('error', (e) => {
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end(`proxy: origin error: ${e.message}`)
      })
      req.pipe(up)
    }
  })

  server.on('connect', (req, clientSocket, head) => {
    // CONNECT host:port — the HTTPS tunnel every model request rides.
    const [hostRaw, portRaw] = String(req.url ?? '').split(':')
    const host = (hostRaw ?? '').toLowerCase()
    const port = Number(portRaw) || 443
    if (!host || !port) {
      clientSocket.destroy()
      return
    }
    markHost(host)
    const { via, cfg } = routeFor(host, server.address()?.port)

    // On connect failure, answer the client with a clean 502 (never leave it
    // hanging on a silently closed socket).
    const rejectClient = (reason) => {
      const msg = String(reason?.message ?? reason).slice(0, 200).replace(/[\r\n]+/g, ' ')
      try {
        clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`)
      } catch { /* socket already gone */ }
      try { clientSocket.destroy() } catch {}
    }

    if (via === 'upstream') {
      const auth = upstreamAuth(cfg)
      const upstream = tcpConnect({ host: cfg.upstream.host, port: Number(cfg.upstream.port) })
      upstream.on('error', rejectClient)
      upstream.on('connect', () => {
        const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`]
        if (auth) lines.push(`Proxy-Authorization: ${auth}`)
        upstream.write(lines.join('\r\n') + '\r\n\r\n')
        let buf = Buffer.alloc(0)
        const onData = (chunk) => {
          buf = Buffer.concat([buf, chunk])
          const end = buf.indexOf('\r\n\r\n')
          if (end < 0) return
          const headEnd = end + 4
          const statusLine = buf.slice(0, buf.indexOf('\r\n')).toString()
          upstream.removeListener('data', onData)
          const rest = buf.slice(headEnd)
          if (!/^HTTP\/1\.[01]\s+2\d\d/.test(statusLine)) {
            clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\n\r\n${statusLine}`)
            clientSocket.destroy()
            upstream.destroy()
            return
          }
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head?.length) upstream.write(head)
          if (rest.length) clientSocket.write(rest)
          pipeTunnel(clientSocket, upstream)
        }
        upstream.on('data', onData)
      })
    } else {
      const origin = tcpConnect({ host, port })
      origin.on('error', rejectClient)
      origin.on('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head?.length) origin.write(head)
        pipeTunnel(clientSocket, origin)
      })
    }
  })

  const port = new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })

  return {
    port,
    hosts: () => [...seenHosts].sort(),
    config,
    /** Merge observed hosts into proxy.json's knownHosts (UI candidate list). */
    persistKnownHosts: () => {
      try {
        const cfg = config()
        const merged = [...new Set([...(cfg.knownHosts ?? []), ...seenHosts])].sort()
        writeFileSync(configFile, JSON.stringify({ ...cfg, knownHosts: merged }, null, 2) + '\n')
      } catch (e) {
        log(`proxy: persist known hosts failed: ${e.message}`)
      }
    },
    close: () => {
      clearTimeout(notifyTimer)
      server.close()
    },
  }
}
