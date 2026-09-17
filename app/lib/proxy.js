//
// CDP routes all outbound traffic through a squid proxy. Node's global fetch
// ignores the standard *_PROXY environment variables, so the dispatcher has to
// be set explicitly or every outbound call fails with an opaque "fetch failed".
//

const { EnvHttpProxyAgent, setGlobalDispatcher } = require('undici')
const http = require('node:http')
const https = require('node:https')
const { describeError } = require('./describe-error')

const PROXY_ENV_VARS = [
  'CDP_HTTPS_PROXY',
  'CDP_HTTP_PROXY',
  'HTTPS_PROXY',
  'HTTP_PROXY'
]
const TUNNEL_PROBE_TIMEOUT_MS = 8000
const HTTP_OK = 200
const DEFAULT_PORTS = { 'https:': 443, 'http:': 80 }

const proxyUrl =
  process.env.CDP_HTTPS_PROXY ||
  process.env.CDP_HTTP_PROXY ||
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY

// On CDP the back-end is reached by bare service name (http://aqie-back-end),
// which no suffix rule below would match, so add its host explicitly.
function backEndHost() {
  try {
    return new URL(process.env.AQIE_BACK_END_URL).hostname
  } catch {
    return null
  }
}

// Internal traffic (the back-end) must bypass squid, which only brokers egress.
const noProxy = [
  process.env.NO_PROXY,
  'localhost,127.0.0.1,.cdp-int.defra.cloud',
  backEndHost()
]
  .filter(Boolean)
  .join(',')

if (proxyUrl) {
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      httpProxy: proxyUrl,
      httpsProxy: proxyUrl,
      noProxy,
      // undici 8 offers h2 in ALPN by default. When the proxy URL is https the
      // squid connection itself negotiates h2, and a CONNECT tunnel cannot be
      // opened over an h2 session, so every egress call fails with
      // ERR_HTTP2_ERROR. proxyTls covers the hop to squid, allowH2 the tunnel.
      proxyTls: { allowH2: false },
      allowH2: false
    })
  )
}

// Credentials must never reach a log line or the diagnostics page.
function redact(url) {
  const port = url.port || DEFAULT_PORTS[url.protocol]
  return `${url.protocol}//${url.hostname}:${port}`
}

// undici reports a refused tunnel only as "Proxy response (nnn) !== 200" and
// drops the response, so repeat the CONNECT by hand to read the status and any
// Location header. A squid deny_info block page is the usual reason for a 3xx.
function probeTunnel(name, rawUrl, target) {
  return new Promise((resolve) => {
    let url
    try {
      url = new URL(rawUrl)
    } catch {
      resolve({ name, ok: false, detail: 'not a valid URL' })
      return
    }

    const transport = url.protocol === 'https:' ? https : http
    const done = (result) => resolve({ name, proxy: redact(url), ...result })

    const request = transport.request({
      host: url.hostname,
      port: url.port || DEFAULT_PORTS[url.protocol],
      method: 'CONNECT',
      path: target,
      headers: { host: target },
      timeout: TUNNEL_PROBE_TIMEOUT_MS,
      // The hop to squid is plain HTTP over TLS; ALPN h2 breaks CONNECT.
      ALPNProtocols: ['http/1.1']
    })

    request.on('connect', (response, socket) => {
      socket.destroy()
      done({ ok: response.statusCode === HTTP_OK, detail: `CONNECT ${response.statusCode}` })
    })
    // Any non-2xx to a CONNECT arrives as a normal response.
    request.on('response', (response) => {
      const location = response.headers.location
      response.destroy()
      done({
        ok: false,
        detail: `CONNECT ${response.statusCode}${location ? ` -> ${location}` : ''}`
      })
    })
    request.on('timeout', () => {
      request.destroy()
      done({ ok: false, detail: `no response within ${TUNNEL_PROBE_TIMEOUT_MS}ms` })
    })
    request.on('error', (error) => done({ ok: false, detail: describeError(error) }))
    request.end()
  })
}

// Every candidate is probed, not just the one in use, so the logs show whether
// a different environment variable would have opened the tunnel.
async function probeProxyTunnels(target) {
  const seen = new Set()
  const probes = []
  for (const name of PROXY_ENV_VARS) {
    const value = process.env[name]
    if (value && !seen.has(value)) {
      seen.add(value)
      probes.push(probeTunnel(name, value, target))
    }
  }
  return Promise.all(probes)
}

module.exports = {
  proxyUrl: proxyUrl || null,
  // Scheme only: proxy URLs can carry credentials.
  proxyScheme: proxyUrl ? new URL(proxyUrl).protocol.replace(':', '') : null,
  probeProxyTunnels
}
