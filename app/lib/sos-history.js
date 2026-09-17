//
// Self-contained hourly-series source for the DEMO ONLY.
//
// In production this logic belongs in the aqie-back-end repo as a
// GET /measurements/history endpoint — see docs/productionisation-notes.md. It lives
// here so the demo stays within this repo without changing the back-end.
//
// It fetches the full hourly series from the public DEFRA SOS GetObservation
// feed (the same feed the back-end already calls) and decodes the SWE-encoded
// swe:values block into { time, value } points, aggregating to daily means for
// the longer timeframes.
//

const { XMLParser } = require('fast-xml-parser')
const { describeError } = require('./describe-error')

const SOS_BASE =
  process.env.SOS_URL ||
  'https://uk-air.defra.gov.uk/sos-ukair/service?service=AQD&version=1.0.0&request=GetObservation&temporalFilter=om:phenomenonTime,'

// A flat 30s per request was both too short and too rigid: the origin slows
// down as the range grows (a year is ~8,760 hourly records per pollutant, and
// on CDP every byte also crosses squid), and an abort was indistinguishable in
// the logs from a refusal. The whole fetch instead shares one deadline, which
// has to stay under CDP's 60s load-balancer timeout or the page is abandoned
// anyway. SOS_TIMEOUT_MS tunes it from cdp-app-config without a code change.
const TOTAL_BUDGET_MS = Number(process.env.SOS_TIMEOUT_MS) || 50000
// Retrying is only worth starting if a realistic attempt still fits the budget.
const MIN_RETRY_BUDGET_MS = 10000
const HTTP_SERVER_ERROR = 500
const MISSING_FOI = 'missingFOI'
const DEFAULT_TOKEN_SEPARATOR = ','
const DEFAULT_BLOCK_SEPARATOR = '@@'
const DECIMAL_PLACES = 2

// AQD SOS records are [StartTime, EndTime, Verification, Validity, Value].
// When field names are absent the timestamp sits 4 tokens from the record end.
const TIME_OFFSET_FROM_END = 4
const INVALID_VALUES = new Set([-9999, -99])

const PERIODS = {
  '24h': { amount: 24, unit: 'hours', resolution: 'hourly' },
  '7d': { amount: 7, unit: 'days', resolution: 'hourly' },
  month: { amount: 1, unit: 'months', resolution: 'daily' },
  year: { amount: 1, unit: 'years', resolution: 'daily' }
}
const DEFAULT_PERIOD = '24h'

const parser = new XMLParser({ ignoreAttributes: false })
const londonDayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
})

function toSosTimestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function buildRange(period) {
  const settings = PERIODS[period] || PERIODS[DEFAULT_PERIOD]
  const end = new Date()
  end.setUTCMinutes(0, 0, 0)
  const start = new Date(end)
  if (settings.unit === 'hours') {
    start.setUTCHours(start.getUTCHours() - settings.amount)
  } else if (settings.unit === 'days') {
    start.setUTCDate(start.getUTCDate() - settings.amount)
  } else if (settings.unit === 'months') {
    start.setUTCMonth(start.getUTCMonth() - settings.amount)
  } else {
    start.setUTCFullYear(start.getUTCFullYear() - settings.amount)
  }
  return {
    range: `${toSosTimestamp(start)}/${toSosTimestamp(end)}`,
    resolution: settings.resolution
  }
}

function fieldNames(dataArray) {
  const record = dataArray['swe:elementType']?.['swe:DataRecord']
  const field = record?.['swe:field']
  if (!field) {
    return []
  }
  const fields = Array.isArray(field) ? field : [field]
  return fields.map((f) => String(f?.['@_name'] ?? '').toLowerCase())
}

function resolveIndices(names, recordLength) {
  let valueIndex = names.indexOf('value')
  if (valueIndex < 0) {
    valueIndex = recordLength - 1
  }
  let timeIndex = names.indexOf('endtime')
  if (timeIndex < 0) {
    timeIndex = names.indexOf('starttime')
  }
  if (timeIndex < 0) {
    timeIndex = Math.max(0, recordLength - TIME_OFFSET_FROM_END)
  }
  return { valueIndex, timeIndex }
}

function cleanValue(raw) {
  const value = Number(raw)
  if (!Number.isFinite(value) || INVALID_VALUES.has(value) || value < 0) {
    return null
  }
  return Number(value.toFixed(DECIMAL_PLACES))
}

function decodeSweValues(dataArray) {
  const rawValues = dataArray?.['swe:values']
  if (!rawValues || typeof rawValues !== 'string') {
    return []
  }
  const encoding = dataArray['swe:encoding']?.['swe:TextEncoding'] ?? {}
  const tokenSeparator = encoding['@_tokenSeparator'] || DEFAULT_TOKEN_SEPARATOR
  const blockSeparator = encoding['@_blockSeparator'] || DEFAULT_BLOCK_SEPARATOR
  const names = fieldNames(dataArray)

  const records = rawValues
    .split(blockSeparator)
    .map((record) => record.split(tokenSeparator))
    .filter((tokens) => tokens.length > 1)
  if (records.length === 0) {
    return []
  }

  const recordLength = names.length || records[0].length
  const { valueIndex, timeIndex } = resolveIndices(names, recordLength)

  const series = []
  for (const tokens of records) {
    const value = cleanValue(tokens[valueIndex])
    const time = tokens[timeIndex]
    if (value === null || !time) {
      continue
    }
    series.push({ time, value })
  }
  return series
}

function extractDataArray(parsed) {
  const featureMember = parsed?.['gml:FeatureCollection']?.['gml:featureMember']
  if (!featureMember) {
    return null
  }
  const members = Array.isArray(featureMember) ? featureMember : [featureMember]
  for (const member of members) {
    const dataArray =
      member?.['om:OM_Observation']?.['om:result']?.['swe:DataArray']
    if (dataArray?.['swe:values']) {
      return dataArray
    }
  }
  return null
}

function aggregateDaily(series) {
  const byDay = new Map()
  for (const point of series) {
    const day = londonDayFormatter.format(new Date(point.time))
    const values = byDay.get(day) || []
    values.push(point.value)
    byDay.set(day, values)
  }
  const aggregated = []
  for (const [day, values] of byDay) {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    aggregated.push({
      time: `${day}T00:00:00.000Z`,
      value: Number(mean.toFixed(DECIMAL_PLACES))
    })
  }
  aggregated.sort((a, b) => new Date(a.time) - new Date(b.time))
  return aggregated
}

// Aborting without a reason surfaces as a bare "AbortError: This operation was
// aborted", which reads like a cancelled request rather than an origin that ran
// out of time. Passing the reason makes fetch reject with this instead. The
// phase matters more than the elapsed time: a stall before any response header
// is a tunnel or an origin that never answered, whereas headers followed by a
// truncated body is simply too much XML to move inside the budget.
function timeoutError(foi, timeoutMs, phase) {
  const error = new Error(
    `SOS did not respond within ${timeoutMs}ms for ${foi} (${phase})`
  )
  error.name = 'TimeoutError'
  return error
}

// A stalled or overloaded origin is worth one more go; a 4xx or a parse failure
// will fail the same way twice.
function isRetryable(error) {
  return error?.name === 'TimeoutError' || error?.status >= HTTP_SERVER_ERROR
}

async function requestXml(url, foi, timeoutMs) {
  const controller = new AbortController()
  const started = Date.now()
  let headersMs = null
  const timer = setTimeout(() => {
    const phase =
      headersMs === null
        ? 'no response headers'
        : `headers after ${headersMs}ms, body unfinished`
    controller.abort(timeoutError(foi, timeoutMs, phase))
  }, timeoutMs)
  try {
    const response = await fetch(url, {
      headers: { 'Cache-Control': 'no-cache' },
      signal: controller.signal
    })
    headersMs = Date.now() - started
    if (!response.ok) {
      const error = new Error(`SOS responded ${response.status} for ${foi}`)
      error.status = response.status
      throw error
    }
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

async function fetchSeriesForFoi(foi, range, resolution, deadline) {
  const url = `${SOS_BASE}${range}&featureOfInterest=${foi}`
  let xml
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw timeoutError(foi, TOTAL_BUDGET_MS, 'budget already spent')
    }
    try {
      xml = await requestXml(url, foi, remaining)
      break
    } catch (error) {
      if (!isRetryable(error) || deadline - Date.now() < MIN_RETRY_BUDGET_MS) {
        throw error
      }
      console.warn(`SOS retry for ${foi}: ${describeError(error)}`)
    }
  }

  const dataArray = extractDataArray(parser.parse(xml))
  if (!dataArray) {
    return []
  }
  const series = decodeSweValues(dataArray)
  return resolution === 'daily' ? aggregateDaily(series) : series
}

// Fetches the series for each usable FOI in parallel; a single pollutant failure
// degrades to an empty series rather than failing the whole request.
async function fetchHistory(foisByCode, period) {
  const { range, resolution } = buildRange(period)
  const entries = Object.entries(foisByCode).filter(
    ([, foi]) => foi && foi !== MISSING_FOI
  )

  const deadline = Date.now() + TOTAL_BUDGET_MS

  const settled = await Promise.all(
    entries.map(async ([code, foi]) => {
      const started = Date.now()
      try {
        const series = await fetchSeriesForFoi(foi, range, resolution, deadline)
        return { code, series, ok: true }
      } catch (error) {
        // Logged because a swallowed failure is indistinguishable from "no data".
        // The elapsed time separates the two CDP causes that otherwise look alike:
        // squid blocking the host fails fast, a slow origin runs to the deadline.
        console.error(
          `SOS history failed for ${code} (${foi}) after ${Date.now() - started}ms: ${describeError(error)}`
        )
        return { code, series: [], ok: false }
      }
    })
  )

  const pollutants = {}
  let failures = 0
  for (const { code, series, ok } of settled) {
    pollutants[code] = series
    if (!ok) {
      failures++
    }
  }
  return { pollutants, resolution, attempted: entries.length, failures }
}

module.exports = {
  fetchHistory,
  buildRange,
  decodeSweValues,
  aggregateDaily,
  extractDataArray,
  SOS_BASE
}
