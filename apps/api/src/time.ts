const DAY_MS = 24 * 60 * 60 * 1000
const SEARCH_MARGIN_MS = 36 * 60 * 60 * 1000

type DateParts = { year: number; month: number; day: number }

function formatDateParts(instant: number, timeZone: string): DateParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant)
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  return {
    year: Number(values['year']),
    month: Number(values['month']),
    day: Number(values['day']),
  }
}

export function dateInTimeZone(instant: number, timeZone: string): string {
  const { year, month, day } = formatDateParts(instant, timeZone)
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
}

export function validateCalendarDate(date: string): DateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) throw new RangeError('Date must use YYYY-MM-DD')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const check = new Date(Date.UTC(year, month - 1, day))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) {
    throw new RangeError('Date does not exist')
  }
  return { year, month, day }
}

/** Finds the first instant belonging to a local date, including DST-short/long days. */
export function startOfLocalDate(date: string, timeZone: string): number {
  const { year, month, day } = validateCalendarDate(date)
  const target = Date.UTC(year, month - 1, day)
  let low = target - SEARCH_MARGIN_MS
  let high = target + SEARCH_MARGIN_MS

  while (dateInTimeZone(low, timeZone) >= date) low -= DAY_MS
  while (dateInTimeZone(high, timeZone) < date) high += DAY_MS

  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2)
    if (dateInTimeZone(middle, timeZone) < date) low = middle
    else high = middle
  }

  if (dateInTimeZone(high, timeZone) !== date) {
    throw new RangeError(`The local date ${date} does not exist in ${timeZone}`)
  }
  return high
}

export function nextCalendarDate(date: string): string {
  const { year, month, day } = validateCalendarDate(date)
  const next = new Date(Date.UTC(year, month - 1, day + 1))
  return `${next.getUTCFullYear().toString().padStart(4, '0')}-${(next.getUTCMonth() + 1).toString().padStart(2, '0')}-${next.getUTCDate().toString().padStart(2, '0')}`
}

export function localDayWindow(date: string, timeZone: string): { from: string; to: string; durationMs: number } {
  const fromMs = startOfLocalDate(date, timeZone)
  const toMs = startOfLocalDate(nextCalendarDate(date), timeZone)
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), durationMs: toMs - fromMs }
}

export function utcMinuteBucket(isoTimestamp: string): string {
  const instant = new Date(isoTimestamp).getTime()
  return new Date(Math.floor(instant / 60_000) * 60_000).toISOString()
}
