//
// Summary metrics derived from the same series that feeds the charts, so the
// table and the graph always describe the same window.
//

const { LEGAL_LIMITS } = require('../data/legal-limits')

const PERCENT = 100
const MS_PER_HOUR = 3600000

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

// The denominator comes from the window rather than the row count, so hours the
// feed omits entirely still count as missing.
function expectedHours(from, to, fallback) {
  const start = Date.parse(from)
  const end = Date.parse(to)
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return fallback
  }
  return Math.round((end - start) / MS_PER_HOUR) + 1
}

function hourlyCapture(points, valid, window) {
  const expected = expectedHours(window.from, window.to, points.length)
  if (expected <= 0) {
    return 0
  }
  return Math.min(PERCENT, Math.round((PERCENT * valid.length) / expected))
}

function computeSummary(series, canonicalCode, window = {}) {
  const points = Array.isArray(series) ? series : []
  const valid = points.filter((point) => point?.value != null)

  const average = valid.length
    ? Math.round(mean(valid.map((point) => point.value)))
    : null

  const limit = LEGAL_LIMITS[canonicalCode]
    ? LEGAL_LIMITS[canonicalCode].hourly
    : null

  return {
    average,
    dataCapturePct: hourlyCapture(points, valid, window),
    exceedances:
      limit == null
        ? null
        : valid.filter((point) => point.value > limit).length,
    limit
  }
}

module.exports = { computeSummary }
