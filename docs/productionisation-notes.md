# Productionisation — steps

This prototype is self-contained: it calls the Ricardo UK-Air API directly for both the station list
and the hourly readings, so no Defra service has to be running or modified for it to work. The
back-end work this document used to describe is therefore not a prerequisite for the prototype, only
for a production implementation.

What remains is front-end, product and platform work.

1. **Decide where the API call belongs.** The prototype holds Ricardo credentials itself, which is
   acceptable for a spike but not for production. A production implementation would more likely put
   the call behind a back-end service, so credentials live in one place and the response can be
   cached across replicas.

2. **Fix the date parameters in `aqie-back-end`.** `pollutant-helpers.js` sends `start-date-time` /
   `end-date-time` to `pollutant_measurement_datas`. Those are not in the API's OpenAPI spec, and
   unknown parameters are ignored silently, so the service falls back to `latest-measurement` and
   receives roughly 33 hours whenever it believes it is requesting a range. The documented names are
   `start-date` / `end-date`, format `YYYY-MM-DD`. This is a live defect independent of this
   prototype.

3. **Handle the 10,000-row cap before offering longer ranges.** Results are capped at 10,000 rows,
   `page=2` is always empty, and exceeding the cap truncates the series with no error. Hourly
   pollutants stay under it for about 416 days, but SO₂ returns 15-minute rows and hits the cap in
   roughly 104 days. Anything beyond 7 days needs either chunked requests or an explicit
   "results truncated" state. The client already logs a warning when a response is exactly at the cap.

4. **Extend beyond 24 hours and 7 days.** These two were scoped as critical for decommissioning;
   month and year views were dropped from this prototype. The API supports them (a year of NO₂ is
   8,770 rows), so this is mainly chart and aggregation work — long ranges want daily means rather
   than hourly points, and the no-JavaScript data tables need pagination.

5. **Widen station coverage.** Only AURN is used (213 current sites). Non-AURN metadata exists
   upstream but its coverage is unverified. Confirm it before relying on it, or areas covered only by
   local networks will show a distant station.

6. **Port to the CDP front-end stack.** This is a GOV.UK Prototype Kit app (Express/Nunjucks); a
   production service would use `cdp-node-frontend-template` (Hapi). The chart module, pollutant
   reference data, summary calculations and accessible table fallbacks all port directly; the
   routing and templating do not.

7. **Add tests.** This repo has none — it is a spike. A production version needs coverage of the
   period-to-date-range mapping, the window trimming, the closed-station filter, the `-9999`
   sentinel handling, and the hourly-interval filter that separates SO₂'s 15-minute rows from its
   hourly ones.

8. **Share the cache.** The station list and bearer token are cached in-process, so each replica
   warms independently. If the call moves behind a back-end service, a shared cache such as Redis
   becomes available.
