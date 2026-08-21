//
// Pollutant reference data: canonical codes, aliases for the raw back-end keys,
// display names, and non-colour-only chart encodings (colour + line style).
//

const CANONICAL = ['PM25', 'PM10', 'NO2', 'O3', 'SO2']

// The back-end stores measurements under raw parameter_ids (e.g. GE10, GR25).
// Map each to the canonical pollutant it represents.
const ALIAS = {
  GE10: 'PM10',
  GR10: 'PM10',
  PM10: 'PM10',
  PM25: 'PM25',
  GR25: 'PM25',
  NO2: 'NO2',
  O3: 'O3',
  SO2: 'SO2'
}

const NAME = {
  PM25: 'PM2.5',
  PM10: 'PM10',
  NO2: 'Nitrogen dioxide',
  O3: 'Ozone',
  SO2: 'Sulphur dioxide'
}

// GOV.UK Design System palette — each paired with a distinct line style below
// so pollutants are never distinguished by colour alone.
const COLOUR = {
  PM25: '#0b0c0c',
  PM10: '#28a197',
  NO2: '#801650',
  O3: '#1d70b8',
  SO2: '#f47738'
}

const LINE = {
  PM25: 'solid',
  PM10: 'dashed',
  NO2: 'solid',
  O3: 'dotted',
  SO2: 'dash-dot'
}

const UNIT = 'µg/m³'

function toCanonical(code) {
  return ALIAS[code] || null
}

function displayName(canonicalCode) {
  return NAME[canonicalCode] || canonicalCode
}

module.exports = {
  CANONICAL,
  ALIAS,
  NAME,
  COLOUR,
  LINE,
  UNIT,
  toCanonical,
  displayName
}
