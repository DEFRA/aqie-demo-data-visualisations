//
// UK/EU 1-hour legal limits in µg/m³. A null hourly limit means no hourly
// legal limit exists for that pollutant, so "hourly exceedances" does not apply.
//

const LEGAL_LIMITS = {
  NO2: { hourly: 200 },
  SO2: { hourly: 350 },
  PM25: { hourly: null },
  PM10: { hourly: null },
  O3: { hourly: null }
}

module.exports = { LEGAL_LIMITS }
