//
// Server-side client for the aqie-back-end. All calls run on the Express
// server (never the browser) so there is no CORS and the API shape stays
// controlled. Base URL comes from AQIE_BACK_END_URL.
//

const { fetchHistory, SOS_BASE } = require('./sos-history')
const { proxyUrl, proxyScheme } = require('./proxy')
const { describeError } = require('./describe-error')

const BASE = process.env.AQIE_BACK_END_URL || 'http://localhost:3001'

const STATIONS_TIMEOUT_MS = 5000
const MISSING_FOI = 'missingFOI'
const PROBE_TIMEOUT_MS = 8000

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
    throw new Error(
      `Could not reach the air quality service at ${url}: ${describeError(error)}`
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
async function probe(name, url) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    return {
      name,
      url,
      ok: response.ok,
      detail: `HTTP ${response.status}`
    }
  } catch (error) {
    return {
      name,
      url,
      ok: false,
      detail: describeError(error)
    }
  }
}

async function checkConnectivity() {
  const sosHost = new URL(SOS_BASE).origin
  const checks = await Promise.all([
    probe('Air quality back end', `${BASE}/measurements`),
    probe('DEFRA SOS feed', sosHost),
    probe('Postcode lookup', 'https://api.postcodes.io/postcodes/SW1A1AA')
  ])
  return {
    ok: checks.every((check) => check.ok),
    backEndUrl: BASE,
    // Value withheld: proxy URLs can carry credentials.
    proxyConfigured: Boolean(proxyUrl),
    proxyScheme,
    checks
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
