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

const SOS_BASE =
  process.env.SOS_URL ||
  'https://uk-air.defra.gov.uk/sos-ukair/service?service=AQD&version=1.0.0&request=GetObservation&temporalFilter=om:phenomenonTime,'

const REQUEST_TIMEOUT_MS = 30000
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

async function fetchSeriesForFoi(foi, range, resolution) {
  const url = `${SOS_BASE}${range}&featureOfInterest=${foi}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: { 'Cache-Control': 'no-cache' },
      signal: controller.signal
    })
    if (!response.ok) {
      throw new Error(`SOS responded ${response.status} for ${foi}`)
    }
    const dataArray = extractDataArray(parser.parse(await response.text()))
    if (!dataArray) {
      return []
    }
    const series = decodeSweValues(dataArray)
    return resolution === 'daily' ? aggregateDaily(series) : series
  } finally {
    clearTimeout(timer)
  }
}

// Fetches the series for each usable FOI in parallel; a single pollutant failure
// degrades to an empty series rather than failing the whole request.
async function fetchHistory(foisByCode, period) {
  const { range, resolution } = buildRange(period)
  const entries = Object.entries(foisByCode).filter(
    ([, foi]) => foi && foi !== MISSING_FOI
  )

  const settled = await Promise.all(
    entries.map(async ([code, foi]) => {
      try {
        const series = await fetchSeriesForFoi(foi, range, resolution)
        return { code, series, ok: true }
      } catch (error) {
        // Logged because a swallowed failure is indistinguishable from "no data"
        // (on CDP the usual cause is squid blocking the SOS host).
        console.error(
          `SOS history failed for ${code} (${foi}): ${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`
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
