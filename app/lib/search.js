//
// Station search: geocode a postcode/outcode/place name via postcodes.io and
// rank the nearest monitoring stations by great-circle distance, or fall back
// to a case-insensitive station-name match.
//

const EARTH_RADIUS_KM = 6371
const GEOCODE_TIMEOUT_MS = 5000
const NEAREST_LIMIT = 5
const NAME_MATCH_LIMIT = 10

const POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i
const OUTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?$/i

async function fetchJson(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    return response.ok ? await response.json() : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function geocode(query) {
  if (POSTCODE_RE.test(query)) {
    const data = await fetchJson(
      `https://api.postcodes.io/postcodes/${encodeURIComponent(query)}`
    )
    if (data?.result) {
      return {
        lat: data.result.latitude,
        lng: data.result.longitude,
        label: data.result.postcode
      }
    }
  }
  if (OUTCODE_RE.test(query)) {
    const data = await fetchJson(
      `https://api.postcodes.io/outcodes/${encodeURIComponent(query)}`
    )
    if (data?.result) {
      return {
        lat: data.result.latitude,
        lng: data.result.longitude,
        label: data.result.outcode
      }
    }
  }
  return null
}

// Towns, villages and other settlements, from the OS Open Names data that
// postcodes.io exposes at /places. Same free, keyless service as the postcode
// lookup, so the demo needs no additional credentials.
async function geocodePlace(query) {
  const data = await fetchJson(
    `https://api.postcodes.io/places?q=${encodeURIComponent(query)}&limit=1`
  )
  const place = data?.result?.[0]
  if (!place) {
    return null
  }
  const county = place.county_unitary
  return {
    lat: place.latitude,
    lng: place.longitude,
    label: county ? `${place.name_1}, ${county}` : place.name_1
  }
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = toRadians(lat2 - lat1)
  const dLng = toRadians(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) ** 2
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Back-end stores coordinates as [lat, lng] (latitude first).
function stationLatLng(station) {
  const coordinates = station.location?.coordinates
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return null
  }
  return { lat: coordinates[0], lng: coordinates[1] }
}

function nearest(stations, lat, lng, limit) {
  return stations
    .map((station) => {
      const coords = stationLatLng(station)
      if (!coords) {
        return null
      }
      return {
        station,
        distanceKm: haversineKm(lat, lng, coords.lat, coords.lng)
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit)
}

function byName(stations, query) {
  const needle = query.toLowerCase()
  return stations
    .filter((station) => (station.name || '').toLowerCase().includes(needle))
    .slice(0, NAME_MATCH_LIMIT)
    .map((station) => ({ station, distanceKm: null }))
}

function locationResult(stations, place) {
  return {
    mode: 'location',
    label: place.label,
    results: nearest(stations, place.lat, place.lng, NEAREST_LIMIT)
  }
}

// Station names are matched before falling back to a place lookup, so a query
// like "Marylebone Road" still finds the station rather than the street.
async function findStations(stations, query) {
  const trimmed = query.trim()
  const postcode = await geocode(trimmed)
  if (postcode) {
    return locationResult(stations, postcode)
  }

  const named = byName(stations, trimmed)
  if (named.length) {
    return { mode: 'name', label: trimmed, results: named }
  }

  const place = await geocodePlace(trimmed)
  if (place) {
    return locationResult(stations, place)
  }

  return { mode: 'name', label: trimmed, results: [] }
}

module.exports = { findStations, geocode, geocodePlace, haversineKm, nearest }
