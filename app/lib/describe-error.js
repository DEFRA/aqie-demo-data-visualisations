//
// fetch collapses every network failure into "fetch failed" and hides the real
// reason in error.cause, sometimes several links down or inside an
// AggregateError. Without unwrapping it, a proxy refusal, a TLS failure and a
// DNS failure all read identically in the logs and on the diagnostics banner.
//

const MAX_DEPTH = 6

function summarise(error) {
  const name = error.name || 'Error'
  const code = error.code ? ` [${error.code}]` : ''
  const message = error.message || '(no message)'
  return `${name}: ${message}${code}`
}

function describeError(error) {
  if (!error) {
    return 'Unknown error'
  }

  const parts = []
  const seen = new Set()
  let current = error

  while (current && parts.length < MAX_DEPTH && !seen.has(current)) {
    seen.add(current)
    parts.push(summarise(current))

    // AggregateError holds the real failures in .errors, not in .cause.
    if (Array.isArray(current.errors) && current.errors.length > 0) {
      parts.push(`(${current.errors.map(summarise).join('; ')})`)
      break
    }

    current = current.cause
  }

  return parts.join(' <- ')
}

module.exports = { describeError }
