//
// Server-side client for the aqie-back-end. All calls run on the Express
// server (never the browser) so there is no CORS and the API shape stays
// controlled. Base URL comes from AQIE_BACK_END_URL.
//

const { fetchHistory, SOS_BASE } = require('./sos-history')
const { proxyUrl } = require('./proxy')

const BASE = process.env.AQIE_BACK_END_URL || 'http://localhost:3001'
const API_KEY = process.env.CDP_X_API_KEY

const STATIONS_TIMEOUT_MS = 5000
const MISSING_FOI = 'missingFOI'
const PROBE_TIMEOUT_MS = 8000

async function fetchJson(path, timeoutMs) {
  const url = `${BASE}${path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const headers = {
    'accept-encoding': 'identity'
  }
  
  // Only add API key for ephemeral gateway (external) access.
  // Used when running the demo locally but connecting to backend on CDP.
  const isEphemeralGateway = url.includes('ephemeral-protected.api')
  if (isEphemeralGateway && process.env.CDP_X_API_KEY) {
    headers['x-api-key'] = process.env.CDP_X_API_KEY
  }
  
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers
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
async function probe(url) {
  const started = Date.now()
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    return {
      url,
      ok: response.ok,
      status: response.status,
      ms: Date.now() - started
    }
  } catch (error) {
    return {
      url,
      ok: false,
      error: `${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`,
      ms: Date.now() - started
    }
  }
}

async function checkConnectivity() {
  const sosHost = new URL(SOS_BASE).origin
  const [health, measurements, sos, geocoder] = await Promise.all([
    probe(`${BASE}/health`),
    probe(`${BASE}/measurements`),
    probe(sosHost),
    probe('https://api.postcodes.io/postcodes/SW1A1AA')
  ])
  return {
    backEndUrl: BASE,
    // Value withheld: proxy URLs can carry credentials.
    proxyConfigured: Boolean(proxyUrl),
    checks: { health, measurements, sos, geocoder }
  }
}

module.exports = {
  getStations,
  getStationById,
  getLatest,
  getHistory,
  checkConnectivity,
  BASE
}
