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
import { connect as tlsConnect } from 'node:tls'
import { readFileSync, writeFileSync } from 'node:fs'

const LOOPBACK = /^(127\.0\.0\.1|localhost|::1|0\.0\.0\.0)$/i

/** Upstream proxy protocol, defaulting to http (legacy configs have no field). */
function upstreamProtocol(cfg) {
  return String(cfg?.upstream?.protocol || 'http').toLowerCase()
}

/** Read exactly n bytes from a socket (SOCKS5 fixed-size frames). */
function readExactly(socket, n, timeoutMs = 10_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    let buf = Buffer.alloc(0)
    const timer = setTimeout(() => { cleanup(); rejectPromise(new Error('upstream handshake timeout')) }, timeoutMs)
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length >= n) { cleanup(); resolvePromise(buf) }
    }
    const onErr = (e) => { cleanup(); rejectPromise(e) }
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onErr)
    }
    socket.on('data', onData)
    socket.on('error', onErr)
  })
}

/** Read until a byte terminator (HTTP CONNECT response headers). */
function readUntil(socket, terminator, timeoutMs = 10_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    let buf = Buffer.alloc(0)
    const timer = setTimeout(() => { cleanup(); rejectPromise(new Error('upstream handshake timeout')) }, timeoutMs)
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const idx = buf.indexOf(terminator)
      if (idx >= 0) {
        cleanup()
        resolvePromise({ head: buf.slice(0, idx + terminator.length).toString(), rest: buf.slice(idx + terminator.length) })
      }
    }
    const onErr = (e) => { cleanup(); rejectPromise(e) }
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onErr)
    }
    socket.on('data', onData)
    socket.on('error', onErr)
  })
}

/**
 * SOCKS5 handshake against the upstream: greeting (with optional RFC1929
 * user/pass auth), then CONNECT to the target. Resolves once the tunnel is
 * ready (BND.ADDR consumed).
 */
async function socks5Handshake(socket, upstream, targetHost, targetPort) {
  const hasAuth = Boolean(upstream.username)
  const methods = hasAuth ? [0x00, 0x02] : [0x00]
  socket.write(Buffer.from([0x05, methods.length, ...methods]))
  const methodResp = await readExactly(socket, 2)
  if (methodResp[0] !== 0x05) throw new Error(`socks5: bad version ${methodResp[0]}`)
  const method = methodResp[1]
  if (method === 0xff) throw new Error('socks5: no acceptable auth method')
  if (method === 0x02) {
    const user = Buffer.from(upstream.username || '', 'utf8')
    const pass = Buffer.from(upstream.password || '', 'utf8')
    socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]))
    const authResp = await readExactly(socket, 2)
    if (authResp[0] !== 0x01 || authResp[1] !== 0x00) throw new Error('socks5: auth failed')
  } else if (method !== 0x00) {
    throw new Error(`socks5: unsupported auth method ${method}`)
  }
  const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(targetHost)
  let addrPart
  if (isIpv4) {
    addrPart = Buffer.concat([Buffer.from([0x01]), ...targetHost.split('.').map((o) => Buffer.from([Number(o) & 0xff]))])
  } else {
    const name = Buffer.from(targetHost, 'ascii')
    addrPart = Buffer.concat([Buffer.from([0x03, name.length]), name])
  }
  const portBuf = Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff])
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addrPart, portBuf]))
  const connResp = await readExactly(socket, 4)
  if (connResp[0] !== 0x05 || connResp[1] !== 0x00) {
    throw new Error(`socks5: CONNECT failed (code ${connResp[1]})`)
  }
  // Consume BND.ADDR/BND.PORT (variable length by atyp).
  const atyp = connResp[3]
  if (atyp === 0x03) {
    const lenByte = await readExactly(socket, 1)
    await readExactly(socket, 1 + lenByte[0] + 2)
  } else if (atyp === 0x01) {
    await readExactly(socket, 4 + 2)
  } else if (atyp === 0x04) {
    await readExactly(socket, 16 + 2)
  }
}

/**
 * Open a tunnel THROUGH the configured upstream proxy to target:port.
 * Returns { socket, rest } where `socket` is ready to pipe and `rest` holds
 * any bytes already read past the handshake (HTTP CONNECT responses).
 * Supports http / https / socks5 upstream protocols.
 * @returns {Promise<{socket: import('node:net').Socket, rest: Buffer}>}
 */
function openUpstreamTunnel(cfg, targetHost, targetPort, authHeader) {
  const u = cfg.upstream
  const protocol = upstreamProtocol(cfg)
  return new Promise((resolvePromise, rejectPromise) => {
    let socket = null
    const fail = (e) => { try { socket?.destroy() } catch {}; rejectPromise(e) }
    if (protocol === 'https') {
      socket = tlsConnect({ host: u.host, port: Number(u.port), servername: u.host })
    } else {
      socket = tcpConnect({ host: u.host, port: Number(u.port) })
    }
    socket.on('error', fail)
    socket.on('connect', async () => {
      try {
        if (protocol === 'socks5') {
          await socks5Handshake(socket, u, targetHost, targetPort)
          resolvePromise({ socket, rest: Buffer.alloc(0) })
        } else {
          const lines = [`CONNECT ${targetHost}:${targetPort} HTTP/1.1`, `Host: ${targetHost}:${targetPort}`]
          if (authHeader) lines.push(`Proxy-Authorization: ${authHeader}`)
          socket.write(lines.join('\r\n') + '\r\n\r\n')
          const { head, rest } = await readUntil(socket, '\r\n\r\n')
          if (!/^HTTP\/1\.[01]\s+2\d\d/.test(head)) {
            throw new Error(`upstream CONNECT rejected: ${head.split('\r\n')[0] || 'no status'}`)
          }
          resolvePromise({ socket, rest })
        }
      } catch (e) {
        fail(e)
      }
    })
  })
}

/** Fresh default proxy config (factory so callers never share a mutable copy). */
export function defaultProxyConfig() {
  return {
    upstream: { enabled: false, protocol: 'http', host: '', port: 0, username: '', password: '' },
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
    // baseURL may carry a trailing comma or be a comma-separated fallback list
    // (e.g. "https://api.xxx.com," or "a,b"). Node's URL parser would swallow
    // the comma INTO the hostname ("api.xxx.com,"), which then never matches
    // the real CONNECT target and silently breaks proxying — split and parse
    // each candidate instead.
    for (const candidate of String(baseUrl).split(',').map((s) => s.trim()).filter(Boolean)) {
      try {
        const host = new URL(candidate).hostname
        if (host) out.push({ name, ...(displayName ? { displayName } : {}), host })
      } catch { /* malformed candidate — skip */ }
    }
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
    // SOCKS5 upstreams only speak CONNECT (no absolute-URI HTTP): a plain
    // http:// target through one falls back to direct so the request still
    // works (rare combination; noted in the manager log).
    let useUpstream = via === 'upstream'
    if (useUpstream && upstreamProtocol(cfg) === 'socks5') {
      log(`socks5 upstream: http target ${host} falls back to direct`)
      useUpstream = false
    }
    if (useUpstream) {
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
      log(`connect ${host}:${port} failed: ${msg}`)
      try {
        clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`)
      } catch { /* socket already gone */ }
      try { clientSocket.destroy() } catch {}
    }

    if (via === 'upstream') {
      // Tunnel through the configured upstream (http / https / socks5).
      openUpstreamTunnel(cfg, host, port, upstreamAuth(cfg))
        .then(({ socket: tunnel, rest }) => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head?.length) tunnel.write(head)
          if (rest.length) clientSocket.write(rest)
          pipeTunnel(clientSocket, tunnel)
        })
        .catch(rejectClient)
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
