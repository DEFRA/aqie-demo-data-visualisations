//
// Summary metrics derived from the same 24-hour hourly series that feeds the
// charts, so the table and graphs always agree.
//

const { LEGAL_LIMITS } = require('../data/legal-limits')

const EXPECTED_HOURS_24H = 24
const PERCENT = 100

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function computeSummary(series24h, canonicalCode) {
  const points = Array.isArray(series24h) ? series24h : []
  const valid = points.filter((point) => point?.value != null)

  const average24h = valid.length
    ? Math.round(mean(valid.map((point) => point.value)))
    : null

  const dataCapturePct = Math.min(
    PERCENT,
    Math.round((PERCENT * valid.length) / EXPECTED_HOURS_24H)
  )

  const limit = LEGAL_LIMITS[canonicalCode]
    ? LEGAL_LIMITS[canonicalCode].hourly
    : null

  const exceedances =
    limit == null ? null : valid.filter((point) => point.value > limit).length

  return { average24h, dataCapturePct, exceedances, limit }
}

module.exports = { computeSummary }
