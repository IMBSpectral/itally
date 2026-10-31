/**
 * Voucher numbering of a voucher type: prefix + zero-filled number + suffix, where {FY} in the
 * prefix or suffix stands for the financial year of the voucher's date ("26-27").
 */
export interface NumberingRule {
  numbering: 'auto' | 'manual'
  prefix: string
  suffix: string
  width: number
  startNumber: number
  restartYearly: boolean
}

/** The start (YYYY-MM-DD) of the financial year a date falls in, for a company whose year starts on `fyStart`'s month and day. */
export function fyStartOf(date: string, fyStart: string) {
  const md = fyStart.slice(5)
  const y = Number(date.slice(0, 4))
  return date.slice(5) >= md ? `${y}-${md}` : `${y - 1}-${md}`
}

/** "26-27" for the year starting 1 April 2026; a calendar year is "2026". */
export function fyLabel(date: string, fyStart: string) {
  const start = fyStartOf(date, fyStart)
  const y = Number(start.slice(0, 4))
  return start.slice(5) === '01-01' ? String(y) : `${String(y).slice(2)}-${String(y + 1).slice(2)}`
}

const withYear = (s: string, date: string, fyStart: string) => s.replace(/\{FY\}/gi, fyLabel(date, fyStart))

export function formatDocNo(rule: Pick<NumberingRule, 'prefix' | 'suffix' | 'width'>, n: number, date: string, fyStart: string) {
  return `${withYear(rule.prefix, date, fyStart)}${String(n).padStart(rule.width, '0')}${withYear(rule.suffix, date, fyStart)}`
}

/** Problems with a voucher type's numbering, before it is saved. */
export function numberingProblems(r: NumberingRule): string[] {
  const out: string[] = []
  const tokens = (s: string) => s.replace(/\{FY\}/gi, '')
  if (/[^A-Za-z0-9/\-_.# ]/.test(tokens(r.prefix + r.suffix))) out.push('Prefix and suffix may hold letters, digits, / - _ . # and {FY}')
  if (!Number.isInteger(r.width) || r.width < 0 || r.width > 9) out.push('Width: 0 to 9 digits')
  if (!Number.isInteger(r.startNumber) || r.startNumber < 0) out.push('The starting number cannot be negative')
  if (r.restartYearly && r.numbering === 'auto' && !/\{FY\}/i.test(r.prefix + r.suffix))
    out.push('Numbers that restart each year need {FY} in the prefix or suffix, or two years would share a number')
  return out
}
