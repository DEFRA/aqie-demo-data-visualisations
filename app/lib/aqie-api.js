//
// Server-side client for the aqie-back-end. All calls run on the Express
// server (never the browser) so there is no CORS and the API shape stays
// controlled. Base URL comes from AQIE_BACK_END_URL.
//

const { fetchHistory, diagnoseFoi, SOS_BASE } = require('./sos-history')
const { proxyUrl, probeProxyTunnels } = require('./proxy')

const BASE = process.env.AQIE_BACK_END_URL || 'http://localhost:3001'

const STATIONS_TIMEOUT_MS = 5000
const MISSING_FOI = 'missingFOI'
const PROBE_TIMEOUT_MS = 8000
const HTTPS_PORT = 443

async function fetchJson(path, timeoutMs) {
  const url = `${BASE}${path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      signal: controller.signal
    })
    if (!response.ok) {
      throw new Error(`Backend responded ${response.status} for ${path}`)
    }
    return await response.json()
  } catch (error) {
    const cause = error.cause?.code ? ` (${error.cause.code})` : ''
    throw new Error(
      `Could not reach the air quality service at ${url}: ${error.message}${cause}`
    )
  } finally {
    clearTimeout(timer)
  }
}

// Stations are sourced from /measurements (not /monitoringStations): only that
// collection keys stations by the localSiteID the history endpoint resolves FOIs
// against, and it already carries per-pollutant data. The two collections share
// no ids (UKA00315 vs MY1), so mixing them would break station lookups.
async function getStations() {
  const data = await fetchJson('/measurements', STATIONS_TIMEOUT_MS)
  return data.measurements || []
}

async function getStationById(siteId) {
  const stations = await getStations()
  return stations.find((station) => station.localSiteID === siteId) || null
}

async function getLatest(siteId) {
  return getStationById(siteId)
}

// The hourly series is fetched directly from the public DEFRA SOS feed and
// decoded server-side (see docs/productionisation-notes.md). FOIs come from the
// station's existing /measurements record, so the demo needs no back-end change.
async function getHistory(siteId, period = '24h') {
  const station = await getStationById(siteId)
  if (!station) {
    throw new Error(`Unknown monitoring site: ${siteId}`)
  }

  const fois = {}
  for (const [code, details] of Object.entries(station.pollutants || {})) {
    const foi = details?.featureOfInterest
    if (foi && foi !== MISSING_FOI) {
      fois[code] = foi
    }
  }

  if (Object.keys(fois).length === 0) {
    console.error(
      `No usable featureOfInterest ids in /measurements for ${siteId} — the back-end record has none, so no series can be fetched`
    )
  }

  const { pollutants, resolution } = await fetchHistory(fois, period)
  return { siteId, period, resolution, pollutants }
}

// The .cdp-int hosts are unreachable from a laptop, so connectivity can only be
// proven from inside the running container.
async function probe(name, url, { anyStatus = false } = {}) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    return {
      name,
      url,
      ok: anyStatus || response.ok,
      detail: `HTTP ${response.status}`
    }
  } catch (error) {
    return {
      name,
      url,
      ok: false,
      detail: `${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`
    }
  }
}

async function checkConnectivity() {
  const sos = new URL(SOS_BASE)
  const [checks, tunnels] = await Promise.all([
    Promise.all([
      probe('Air quality back end', `${BASE}/measurements`),
      // The site root is CDN-fronted, so it can answer while the servlet behind
      // it does not. Any status proves the servlet replied: with no parameters
      // it returns an exception report, which is still an answer.
      probe('DEFRA SOS service', `${sos.origin}${sos.pathname}`, {
        anyStatus: true
      }),
      probe('Postcode lookup', 'https://api.postcodes.io/postcodes/SW1A1AA')
    ]),
    // A reachable origin does not prove the tunnel the history fetch needs is
    // open: squid can drop CONNECT silently, which looks like a slow origin.
    probeProxyTunnels(`${sos.hostname}:${sos.port || HTTPS_PORT}`)
  ])
  return {
    ok: checks.every((check) => check.ok),
    backEndUrl: BASE,
    // Value withheld: proxy URLs can carry credentials.
    proxyConfigured: Boolean(proxyUrl),
    checks,
    tunnels
  }
}

function firstUsableFoi(station) {
  for (const [code, details] of Object.entries(station?.pollutants || {})) {
    const foi = details?.featureOfInterest
    if (foi && foi !== MISSING_FOI) {
      return { code, foi }
    }
  }
  return null
}

// One real SOS request plus the tunnel behind it, reported over HTTP because the
// CDP Portal terminal is not available for every service. The station id is only
// matched against the back-end's own records and the FOI comes from those
// records, so nothing here lets a caller choose the outbound host.
async function diagnoseSos(siteId) {
  const sos = new URL(SOS_BASE)
  const target = `${sos.hostname}:${sos.port || HTTPS_PORT}`
  const stations = await getStations()
  const candidates = siteId
    ? stations.filter((station) => station.localSiteID === siteId)
    : stations

  let found = null
  for (const station of candidates) {
    const usable = firstUsableFoi(station)
    if (usable) {
      found = { station: station.localSiteID, ...usable }
      break
    }
  }
  if (!found) {
    return {
      target,
      error: siteId
        ? `No usable featureOfInterest for ${siteId}`
        : 'No station in /measurements has a usable featureOfInterest'
    }
  }

  const [tunnels, request] = await Promise.all([
    probeProxyTunnels(target),
    diagnoseFoi(found.foi)
  ])
  return {
    target,
    // Value withheld: proxy URLs can carry credentials.
    proxyConfigured: Boolean(proxyUrl),
    station: found.station,
    pollutant: found.code,
    tunnels,
    request
  }
}

module.exports = {
  getStations,
  getStationById,
  getLatest,
  getHistory,
  checkConnectivity,
  diagnoseSos,
  BASE
}
