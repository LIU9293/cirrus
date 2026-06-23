// Minimal, dependency-free 5-field cron support: "minute hour day-of-month
// month day-of-week". Each field accepts `*`, `*/n`, `a-b`, `a-b/n`, and
// comma lists of those or plain numbers. Day-of-week: 0 or 7 = Sunday.
// This covers everything the scheduling assistant is asked to emit; we match at
// minute resolution (the scheduler ticks once a minute).

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (after normalizing 7→0)
]

function parseField(raw: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>()
  for (const part of raw.split(',')) {
    const token = part.trim()
    if (!token) return null
    const [rangePart, stepPart] = token.split('/')
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step < 1) return null

    let lo: number
    let hi: number
    if (rangePart === '*') {
      lo = min
      hi = max
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-')
      lo = Number(a)
      hi = Number(b)
    } else {
      lo = Number(rangePart)
      hi = lo
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi || lo < min || hi > max) return null
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  return values.size ? values : null
}

export interface ParsedCron {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
}

/** Parse a 5-field cron expression, or return null if it's malformed. */
export function parseCron(expr: string): ParsedCron | null {
  const fields = String(expr ?? '').trim().split(/\s+/)
  if (fields.length !== 5) return null
  const sets = fields.map((f, i) => parseField(f, FIELD_RANGES[i][0], FIELD_RANGES[i][1]))
  if (sets.some((s) => s === null)) return null
  const [minute, hour, dom, month, dowRaw] = sets as Set<number>[]
  // Normalize day-of-week 7 → 0 (both mean Sunday).
  const dow = new Set<number>()
  for (const v of dowRaw) dow.add(v === 7 ? 0 : v)
  return { minute, hour, dom, month, dow }
}

export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null
}

/** Does `date` (a specific minute) match the cron expression? Standard cron
 *  semantics: when BOTH day-of-month and day-of-week are restricted (not `*`),
 *  the job runs if EITHER matches. */
export function cronMatches(parsed: ParsedCron, date: Date): boolean {
  if (!parsed.minute.has(date.getMinutes())) return false
  if (!parsed.hour.has(date.getHours())) return false
  if (!parsed.month.has(date.getMonth() + 1)) return false

  const domRestricted = parsed.dom.size !== 31
  const dowRestricted = parsed.dow.size !== 7
  const domHit = parsed.dom.has(date.getDate())
  const dowHit = parsed.dow.has(date.getDay())
  if (domRestricted && dowRestricted) return domHit || dowHit
  if (domRestricted) return domHit
  if (dowRestricted) return dowHit
  return true
}

/** The next minute (>= from + 1 min) at which the expression fires, scanning up
 *  to ~366 days ahead. Returns null if nothing matches in that window. */
export function nextCronRun(expr: string, from: Date = new Date()): Date | null {
  const parsed = parseCron(expr)
  if (!parsed) return null
  const cursor = new Date(from)
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  const limit = 366 * 24 * 60
  for (let i = 0; i < limit; i++) {
    if (cronMatches(parsed, cursor)) return new Date(cursor)
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  return null
}
