//
// For guidance on how to create filters see:
// https://prototype-kit.service.gov.uk/docs/filters
//

const govukPrototypeKit = require('govuk-prototype-kit')
const addFilter = govukPrototypeKit.views.addFilter

// The feed publishes in UTC and the backend aggregates daily rows to a bare
// date, so both are shown in UTC rather than silently shifted to local time.
const DATE_ONLY_LENGTH = 10

const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'long',
  year: 'numeric'
})

addFilter('readingTime', (value) => {
  if (!value) {
    return ''
  }
  const raw = String(value)
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) {
    return raw
  }
  return raw.length <= DATE_ONLY_LENGTH
    ? dateFormat.format(date)
    : dateTimeFormat.format(date)
})
