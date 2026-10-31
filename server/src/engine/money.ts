/**
 * Amounts are integer paise. Sign convention everywhere: positive = Debit, negative = Credit.
 * Integers avoid float drift, so "Dr total == Cr total" is an exact comparison.
 */
export type Paise = number

/** Parse "1,23,456.78" / "1234.5" / "1234" into paise. Throws on more than 2 decimals. */
export function toPaise(input: string | number): Paise {
  const s = String(input).replace(/,/g, '').trim()
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s)
  if (!m) throw new Error(`Invalid amount: ${input}`)
  const p = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'))
  if (!Number.isSafeInteger(p)) throw new Error(`Amount too large: ${input}`)
  return m[1] && p !== 0 ? -p : p
}

/** Indian digit grouping: 1234567.8 -> "12,34,567.80". Always non-negative text; caller shows Dr/Cr. */
export function formatINR(paise: Paise): string {
  const abs = Math.abs(paise)
  const rupees = Math.floor(abs / 100).toString()
  const frac = (abs % 100).toString().padStart(2, '0')
  const last3 = rupees.slice(-3)
  const rest = rupees.slice(0, -3)
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3
  return `${grouped}.${frac}`
}

/** "12,34,567.80 Dr" / "500.00 Cr" / "" for zero, the way Tally prints balances. */
export function formatDrCr(paise: Paise): string {
  if (paise === 0) return ''
  return `${formatINR(paise)} ${paise > 0 ? 'Dr' : 'Cr'}`
}
