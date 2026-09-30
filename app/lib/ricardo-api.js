//
// Server-side client for the Ricardo UK-Air API, which is the prototype's only
// data source. Station metadata comes from /site_meta_datas and hourly readings
// from /pollutant_measurement_datas.
//
// All calls run on the Express server, never the browser: the API needs a
// bearer token that must not reach the client.
//

const { describeError } = require('./describe-error')
const {
  proxyUrl,
  proxySource,
  proxyRedacted,
  probeProxyTunnels
} = require('./proxy')

// Some callers configure these URLs with a trailing "?", which would otherwise
// survive into the query string as an empty parameter.
function endpoint(value, fallback) {
  return String(value || fallback).replace(/\?$/, '')
}

const HOST = 'https://api-ukair.defra.gov.uk'
const LOGIN_URL = endpoint(
  process.env.RICARDO_API_LOGIN_URL,
  `${HOST}/api/login_check`
)
const STATIONS_URL = endpoint(
  process.env.RICARDO_API_ALL_DATA_URL,
  `${HOST}/api/site_meta_datas`
)
const MEASUREMENTS_URL = endpoint(
  process.env.RICARDO_API_SITE_ID_URL,
  `${HOST}/api/pollutant_measurement_datas`
)

const TIMEOUT_MS = Number(process.env.RICARDO_TIMEOUT_MS) || 20000
const PROBE_TIMEOUT_MS = 8000
const HTTPS_PORT = 443
const UNAUTHORISED = 401

const MS_PER_HOUR = 3600000
const MS_PER_DAY = 86400000
const HOURS_PER_DAY = 24
const MINUTES_PER_HOUR = 60

// The API caps any result set at 10,000 rows and page=2 is always empty, so a
// response of exactly this length has been truncated rather than completed.
const ROW_CAP = 10000

const STATION_CACHE_MS = 6 * MS_PER_HOUR
// Tokens are JWTs with a longer life than this; re-logging in early is cheaper
// than parsing and trusting the expiry claim.
const TOKEN_LIFETIME_MS = 50 * 60 * 1000

// Ricardo's request code for each canonical pollutant: PM10 and PM2.5 are
// rejected under their display names and must be asked for as GE10 and PM25.
const REQUEST_CODE = {
  PM25: 'PM25',
  PM10: 'GE10',
  NO2: 'NO2',
  O3: 'O3',
  SO2: 'SO2'
}

// Only the two windows the prototype serves. Both are well inside ROW_CAP.
const PERIODS = { '24h': 1, '7d': 7 }
const DEFAULT_PERIOD = '24h'

// Names arrive display-ready, with HTML entities and subscript markup.
function cleanName(value) {
  return String(value || '')
    .replaceAll(/<\/?sub>/gi, '')
    .replaceAll('&amp;', '&')
    .trim()
}

function toCanonical(name) {
  const key = cleanName(name).replaceAll(/\s/g, '').toLowerCase()
  if (key.startsWith('nitrogendioxide')) {
    return 'NO2'
  }
  if (key.startsWith('ozone')) {
    return 'O3'
  }
  if (key.startsWith('sulphurdioxide')) {
    return 'SO2'
  }
  if (key.startsWith('pm2.5')) {
    return 'PM25'
  }
  if (key.startsWith('pm10')) {
    return 'PM10'
  }
  return null
}

let cachedToken = null
let tokenExpiresAt = 0

async function login() {
  let response
  try {
    response = await fetch(LOGIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: process.env.RICARDO_API_EMAIL,
        password: process.env.RICARDO_API_PASSWORD
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (error) {
    throw new Error(
      `Could not reach the Ricardo API at ${LOGIN_URL}: ${describeError(error)}`
    )
  }

  const body = await response.json().catch(() => null)
  if (!response.ok || !body?.token) {
    // A trailing "#" in RICARDO_API_PASSWORD is treated as a comment by
    // `node --env-file` and truncated, which surfaces here as bad credentials.
    throw new Error(
      `Ricardo API login failed (HTTP ${response.status}): ${body?.message || 'no token returned'}. ` +
      'If the password ends with "#", quote it in .env.'
    )
  }
  return body.token
}

async function getToken() {
  if (!cachedToken || Date.now() >= tokenExpiresAt) {
    cachedToken = await login()
    tokenExpiresAt = Date.now() + TOKEN_LIFETIME_MS
  }
  return cachedToken
}

async function request(url, params) {
  const target = new URL(url)
  for (const [key, value] of Object.entries(params)) {
    if (value != null) {
      target.searchParams.set(key, String(value))
    }
  }

  const send = async () =>
    fetch(target, {
      headers: {
        Authorization: `Bearer ${await getToken()}`,
        Accept: 'application/ld+json'
      },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })

  let response
  try {
    response = await send()
    if (response.status === UNAUTHORISED) {
      cachedToken = null
      response = await send()
    }
  } catch (error) {
    throw new Error(
      `Could not reach the Ricardo API at ${target.pathname}: ${describeError(error)}`
    )
  }

  const body = await response.json().catch(() => null)
  if (!response.ok) {
    // Unknown parameters are ignored silently, but invalid values come back as
    // constraint violations, which name the parameter at fault.
    const detail =
      body?.violations
        ?.map((violation) => `${violation.propertyPath}: ${violation.message}`)
        .join('; ') ||
      body?.detail ||
      `HTTP ${response.status}`
    const error = new Error(
      `Ricardo API rejected ${target.pathname}: ${detail}`
    )
    error.status = response.status
    throw error
  }
  return body
}

function members(body) {
  return body?.member || body?.['hydra:member'] || []
}

function toStation(raw) {
  const pollutants = []
  for (const entry of Object.values(raw?.pollutantsMetaData || {})) {
    const code = toCanonical(entry?.name)
    if (
      code &&
      entry?.measurementStatus === 'current' &&
      !pollutants.includes(code)
    ) {
      pollutants.push(code)
    }
  }

  return {
    siteId: raw?.siteId,
    // Kept because it is the code the public UK-AIR site uses, so it is what
    // people recognise and search for.
    localSiteId: raw?.localSiteId,
    name: cleanName(raw?.siteName),
    area: cleanName(raw?.governmentRegion || raw?.areaType),
    latitude: Number.parseFloat(raw?.latitude),
    longitude: Number.parseFloat(raw?.longitude),
    pollutants
  }
}

let stationCache = null
let stationCachedAt = 0

async function getStations() {
  if (stationCache && Date.now() - stationCachedAt < STATION_CACHE_MS) {
    return stationCache
  }

  const body = await request(STATIONS_URL, { 'with-pollutants': 'true' })
  stationCache = members(body)
    .filter((raw) => raw?.stationStatus === 'current')
    .map(toStation)
    .filter((station) => station.siteId && station.pollutants.length)
    .sort((a, b) => a.name.localeCompare(b.name))
  stationCachedAt = Date.now()
  return stationCache
}

async function getStationById(siteId) {
  const stations = await getStations()
  return (
    stations.find(
      (station) => station.siteId === siteId || station.localSiteId === siteId
    ) || null
  )
}

function toYmd(date) {
  return date.toISOString().slice(0, 10)
}

// Some pollutants return 15-minute rows alongside the hourly ones (SO2 gives
// four per hour). data-type does not separate them, so the interval does.
function isHourly(row) {
  const minutes =
    (Date.parse(row?.endDateTime) - Date.parse(row?.startDateTime)) /
    (MINUTES_PER_HOUR * 1000)
  return minutes === MINUTES_PER_HOUR
}

// -9999 and -99 mark hours where the instrument produced no reading. Charting
// them as values drags every average far negative, so they become gaps.
function toReading(raw) {
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : null
}

async function fetchSeries(siteId, code, from, to) {
  let body
  try {
    body = await request(MEASUREMENTS_URL, {
      'station-id': siteId,
      'pollutant-name': REQUEST_CODE[code],
      // Documented as start-date/end-date. The *-date-time forms used elsewhere
      // are not in the spec and are ignored, which silently returns ~33 hours.
      'start-date': toYmd(from),
      'end-date': toYmd(to)
    })
  } catch (error) {
    // One pollutant failing should not empty the whole page.
    console.warn(`No ${code} for ${siteId}: ${error.message}`)
    return [code, []]
  }

  const rows = members(body)
  if (rows.length === ROW_CAP) {
    console.warn(
      `${code} for ${siteId} hit the ${ROW_CAP}-row cap, so the series is truncated`
    )
  }

  const points = rows
    .filter((row) => isHourly(row))
    .map((row) => ({
      time: new Date(row.endDateTime).toISOString(),
      value: toReading(row.value)
    }))
    .sort((a, b) => a.time.localeCompare(b.time))

  return [code, points]
}

async function getHistory(siteId, period = DEFAULT_PERIOD) {
  const days = PERIODS[period] || PERIODS[DEFAULT_PERIOD]
  const station = await getStationById(siteId)
  const codes = station?.pollutants?.length
    ? station.pollutants
    : Object.keys(REQUEST_CODE)

  // Whole days are requested because the API takes dates, then the series is
  // trimmed back to the exact window below.
  const now = new Date()
  const results = await Promise.all(
    codes.map((code) =>
      fetchSeries(
        siteId,
        code,
        new Date(now.getTime() - days * MS_PER_DAY),
        now
      )
    )
  )

  const latest = results
    .flatMap(([, points]) => points.map((point) => point.time))
    .reduce((newest, time) => (time > newest ? time : newest), '')

  if (!latest) {
    return {
      siteId,
      period,
      resolution: 'hourly',
      from: null,
      to: null,
      pollutants: {}
    }
  }

  // Anchored on the most recent reading rather than the clock, so a station
  // that stopped publishing shows a gap rather than a window of empty hours.
  const to = Date.parse(latest)
  const from = to - (days * HOURS_PER_DAY - 1) * MS_PER_HOUR

  const pollutants = {}
  for (const [code, points] of results) {
    const trimmed = points.filter((point) => Date.parse(point.time) >= from)
    if (trimmed.length) {
      pollutants[code] = trimmed
    }
  }

  return {
    siteId,
    period,
    resolution: 'hourly',
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    pollutants
  }
}

async function probe(name, run) {
  try {
    return { name, ok: await run(), detail: 'OK' }
  } catch (error) {
    return { name, ok: false, detail: describeError(error) }
  }
}

async function checkConnectivity() {
  const [checks, tunnels] = await Promise.all([
    Promise.all([
      probe('Ricardo UK-Air API', async () => {
        await getToken()
        return true
      }),
      probe('Postcode lookup', async () => {
        const response = await fetch(
          'https://api.postcodes.io/postcodes/SW1A1AA',
          { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }
        )
        return response.ok
      })
    ]),
    // Both calls now leave the platform, so squid can block either.
    probeProxyTunnels(`${new URL(LOGIN_URL).hostname}:${HTTPS_PORT}`)
  ])

  return {
    ok: checks.every((check) => check.ok),
    apiUrl: new URL(LOGIN_URL).origin,
    // Value withheld: proxy URLs can carry credentials.
    proxyConfigured: Boolean(proxyUrl),
    proxySource,
    proxy: proxyRedacted,
    checks,
    tunnels
  }
}

module.exports = {
  getStations,
  getStationById,
  getHistory,
  checkConnectivity,
  PERIODS
}
