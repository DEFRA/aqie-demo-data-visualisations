//
// Builds the per-pollutant view model for the station page: canonicalises the
// raw back-end codes, orders them, attaches the chart series, and derives the
// summary metrics from the 24-hour series so the table and charts always agree.
//

const {
  CANONICAL,
  NAME,
  COLOUR,
  LINE,
  UNIT,
  toCanonical
} = require('../data/pollutants')
const { computeSummary } = require('./summary')

// Collapse raw-coded series (GE10, GR25, ...) onto canonical codes, keeping the
// longest series where more than one raw code maps to the same pollutant.
function indexByCanonical(pollutants) {
  const byCanonical = {}
  for (const [rawCode, series] of Object.entries(pollutants || {})) {
    const canonical = toCanonical(rawCode)
    if (!canonical) {
      continue
    }
    const points = Array.isArray(series) ? series : []
    if (
      !byCanonical[canonical] ||
      points.length > byCanonical[canonical].length
    ) {
      byCanonical[canonical] = points
    }
  }
  return byCanonical
}

function buildViewModel(history, history24) {
  const seriesByCanonical = indexByCanonical(history.pollutants)
  const series24ByCanonical = indexByCanonical(history24.pollutants)

  return CANONICAL.filter((code) => seriesByCanonical[code]).map((code) => ({
    code,
    name: NAME[code],
    unit: UNIT,
    colour: COLOUR[code],
    line: LINE[code],
    series: seriesByCanonical[code] || [],
    ...computeSummary(series24ByCanonical[code] || [], code)
  }))
}

module.exports = { buildViewModel }
