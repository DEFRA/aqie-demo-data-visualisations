# Productionisation — steps

The demo fetches and decodes the hourly series itself (`app/lib/sos-history.js`) so it needs no
back-end change. To productionise, move that into `aqie-back-end`:

1. **Add `GET /measurements/history` to `aqie-back-end`**, following the existing Hapi plugin pattern
   in `src/api/pollutants/history/`: `index.js` (route), `controller.js` (validate query, resolve
   feature-of-interest ids from `measurements`, 200/404/502), `fetch-history.js` (build the temporal
   range, fetch per FOI, aggregate), `decode-swe-values.js` (decoder). Register it in
   `src/api/router.js`. Lift `decodeSweValues`, `buildRange` and the daily aggregation from
   `sos-history.js` — they were written to be liftable.

   ```
   GET /measurements/history?siteId=(required)&pollutant=(optional)&period=24h|7d|month|year (default 24h)
   200 → { siteId, period, resolution:'hourly'|'daily', pollutants: { <CODE>: [ { time, value } ] } }
   400 invalid query · 404 unknown site / no usable FOI · 502 all upstream requests failed (partial ok)
   ```

2. **Add tests**: decoder against a captured `swe:values` block, range building, aggregation,
   controller 200/404/502.
3. **Add caching** of upstream responses — the SOS origin has returned `504`s — plus retry/backoff and
   rate-limiting, and route outbound calls through the CDP platform proxy.
4. **Handle long ranges**: downsampling beyond daily means, and timezone normalisation at aggregation
   boundaries. Consider stored history/backfill instead of a live fetch per request.
5. **Point the front end at the endpoint**: reduce `getHistory()` in `app/lib/aqie-api.js` to one call
   (the response shape is already identical), then delete `app/lib/sos-history.js` and the
   `fast-xml-parser` dependency.

## Feed facts (verified live 2026-08-10) — needed for step 1

- Public, no credentials: `https://uk-air.defra.gov.uk/sos-ukair/service?service=AQD&version=1.0.0&request=GetObservation&temporalFilter=om:phenomenonTime,{START}/{END}&featureOfInterest={FOI}`
- Encoding: `blockSeparator="@@"`, `tokenSeparator=","`, `decimalSeparator="."`.
- Record fields: `StartTime, EndTime, Verification, Validity, Value` → value = last token, time = `EndTime`.
- FOIs are stored under **raw** parameter ids (`GE10`, `GR25`, `GR10`); canonicalise via the demo's `ALIAS` map.
