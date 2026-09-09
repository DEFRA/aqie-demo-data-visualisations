//
// CDP routes all outbound traffic through a squid proxy. Node's global fetch
// ignores the standard *_PROXY environment variables, so the dispatcher has to
// be set explicitly or every outbound call fails with an opaque "fetch failed".
//

const { EnvHttpProxyAgent, setGlobalDispatcher } = require('undici')

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

module.exports = {
  proxyUrl: proxyUrl || null,
  // Scheme only: proxy URLs can carry credentials.
  proxyScheme: proxyUrl ? new URL(proxyUrl).protocol.replace(':', '') : null
}
