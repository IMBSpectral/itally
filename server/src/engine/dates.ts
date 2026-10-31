/**
 * Tally-style short date entry. Typing "14" means the 14th of the current month, "14-10" or
 * "14-Oct" picks the year that keeps the date inside the financial year, and full forms like
 * "14.10.26" or "14/10/2026" work too. ISO "2026-10-14" passes through.
 */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function iso(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return dt.toISOString().slice(0, 10)
}

function month(token: string): number | null {
  if (/^\d{1,2}$/.test(token)) return Number(token)
  const i = MONTHS.indexOf(token.slice(0, 3).toLowerCase())
  return token.length >= 3 && i >= 0 ? i + 1 : null
}

/**
 * @param text   what the user typed
 * @param ref    the date to resolve against (yyyy-mm-dd), usually the voucher's current date
 * @param fyStart start of the financial year (yyyy-mm-dd), e.g. 2026-04-01
 * @returns yyyy-mm-dd, or null if it isn't a real date
 */
export function parseShortDate(text: string, ref: string, fyStart: string): string | null {
  const t = text.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const [y, m, d] = t.split('-').map(Number)
    return iso(y, m, d)
  }
  const parts = t.split(/[-/. ]+/).filter(Boolean)
  if (parts.length === 0 || parts.length > 3 || !/^\d{1,2}$/.test(parts[0])) return null
  const d = Number(parts[0])
  const [ry, rm] = ref.split('-').map(Number)

  if (parts.length === 1) return iso(ry, rm, d)

  const m = month(parts[1])
  if (m === null || m < 1 || m > 12) return null

  if (parts.length === 2) {
    // the year that puts this month inside the financial year containing `ref`
    const fm = Number(fyStart.split('-')[1])
    const fyYear = rm >= fm ? ry : ry - 1 // calendar year in which that financial year starts
    return iso(m >= fm ? fyYear : fyYear + 1, m, d)
  }

  const yText = parts[2]
  if (!/^\d{2}$|^\d{4}$/.test(yText)) return null
  const y = yText.length === 2 ? 2000 + Number(yText) : Number(yText)
  return iso(y, m, d)
}
