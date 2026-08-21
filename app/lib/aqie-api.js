//
// Server-side client for the aqie-back-end. All calls run on the Express
// server (never the browser) so there is no CORS and the API shape stays
// controlled. Base URL comes from AQIE_BACKEND_URL.
//

const { fetchHistory } = require('./sos-history')

const BASE = process.env.AQIE_BACKEND_URL || 'http://localhost:3001'

const STATIONS_TIMEOUT_MS = 5000
const MISSING_FOI = 'missingFOI'

async function fetchJson(path, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${BASE}${path}`, {
      signal: controller.signal
    })
    if (!response.ok) {
      throw new Error(`Backend responded ${response.status} for ${path}`)
    }
    return await response.json()
  } catch (error) {
    throw new Error(`Could not reach the air quality service: ${error.message}`)
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

  const { pollutants, resolution } = await fetchHistory(fois, period)
  return { siteId, period, resolution, pollutants }
}

module.exports = { getStations, getStationById, getLatest, getHistory, BASE }
