//
// For guidance on how to create routes see:
// https://prototype-kit.service.gov.uk/docs/create-routes
//

const govukPrototypeKit = require('govuk-prototype-kit')
const router = govukPrototypeKit.requests.setupRouter()

// Must load before any outbound call so the proxy dispatcher is in place.
require('./lib/proxy')

const { getStations, getStationById, getHistory } = require('./lib/aqie-api')
const { findStations } = require('./lib/search')
const { buildViewModel } = require('./lib/station-view')

const PERIODS = ['24h', '7d', 'month', 'year']
const LAYOUTS = ['small-multiples', 'combined']
const NOT_FOUND = 404

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

router.get('/stations', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim()
    if (!q) {
      return res.redirect('/')
    }
    const search = await findStations(await getStations(), q)
    res.render('stations', { q, search })
  } catch (error) {
    next(error)
  }
})

router.get('/station/:siteId', async (req, res, next) => {
  try {
    const period = pick(req.query.period, PERIODS, '24h')
    const layout = pick(req.query.layout, LAYOUTS, 'combined')
    const station = await getStationById(req.params.siteId)
    if (!station) {
      return res
        .status(NOT_FOUND)
        .render('station-not-found', { siteId: req.params.siteId })
    }

    const history = await getHistory(req.params.siteId, period)
    const history24 =
      period === '24h' ? history : await getHistory(req.params.siteId, '24h')
    const pollutants = buildViewModel(history, history24)

    res.render('station', {
      station,
      period,
      layout,
      pollutants,
      resolution: history.resolution,
      chartData: JSON.stringify({
        pollutants,
        period,
        resolution: history.resolution,
        unit: 'µg/m³'
      })
    })
  } catch (error) {
    next(error)
  }
})

router.get('/station/:siteId/data.json', async (req, res, next) => {
  try {
    const period = pick(req.query.period, PERIODS, '24h')
    res.json(await getHistory(req.params.siteId, period))
  } catch (error) {
    next(error)
  }
})
