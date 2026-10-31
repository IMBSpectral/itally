/**
 * Foreign currency, as Tally keeps it. The books are in rupees (paise); an entry on a ledger kept
 * in a foreign currency also carries the foreign amount, in the currency's smallest unit (cents
 * for 2 decimals), and the rate it was booked at. Rates are rupees for one unit of the currency in
 * ten-thousandths of a rupee (₹83.2500 = 832500). Valuing what is still held (or owed) in the
 * currency at a later rate, against what the books say in rupees, is the forex gain or loss.
 */
import type { Paise } from './money'

export interface Currency {
  id: number
  symbol: string
  name: string
  decimals: number // 0 to 4
  decimalName: string | null
}

export interface RatesOn {
  date: string // the date the rates were set (on or before the date asked)
  standard: number | null
  selling: number | null
  buying: number | null
}

/** Which rate a voucher books at: the bank sells us the currency for a payment, buys it for a receipt. */
export type RateKind = 'standard' | 'selling' | 'buying'
export function rateKindFor(voucherType: string): RateKind {
  if (['Payment', 'Purchase', 'Debit Note'].includes(voucherType)) return 'selling'
  if (['Receipt', 'Sales', 'Credit Note'].includes(voucherType)) return 'buying'
  return 'standard'
}

/** The rate of a kind from rates in force; falls back to the standard rate (Tally's default). */
export function pickRate(r: RatesOn | null | undefined, kind: RateKind): number | null {
  if (!r) return null
  return r[kind] ?? r.standard ?? null
}

/** a / b rounded half away from zero, exact for amounts beyond 2^53 in the middle of the sum */
function divRound(a: bigint, b: bigint) {
  const neg = a < 0n !== b < 0n
  const x = a < 0n ? -a : a
  const y = b < 0n ? -b : b
  const q = (2n * x + y) / (2n * y)
  return Number(neg ? -q : q)
}

/** Rupees (paise) for a foreign amount at a rate: $100.00 (10000 cents) at 832500 = ₹8,325.00. */
export function toBase(forex: number, rate: number, decimals: number): Paise {
  return divRound(BigInt(forex) * BigInt(rate), 10n ** BigInt(decimals) * 100n)
}

/** The foreign amount that rupees come to at a rate. */
export function toForex(paise: Paise, rate: number, decimals: number): number {
  return divRound(BigInt(paise) * 10n ** BigInt(decimals) * 100n, BigInt(rate))
}

/** "83.25" -> 832500; at most 4 decimals; null when it isn't a positive rate. */
export function parseRate(s: string): number | null {
  const m = /^(\d{1,7})(?:\.(\d{1,4}))?$/.exec(s.replace(/,/g, '').trim())
  if (!m) return null
  const r = Number(m[1]) * 10000 + Number((m[2] ?? '').padEnd(4, '0'))
  return r > 0 ? r : null
}

/** 832500 -> "83.25" (at least 2 decimals, up to 4) */
export function formatRate(rate: number): string {
  const s = (rate / 10000).toFixed(4)
  return s.replace(/(\.\d\d\d?)0+$/, '$1').replace(/(\.\d\d)0$/, '$1')
}

/** A foreign amount as typed ("1,200.50") in the currency's smallest unit; null if it isn't one. */
export function parseForex(s: string, decimals: number): number | null {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s.replace(/,/g, '').trim())
  if (!m || (m[3]?.length ?? 0) > decimals) return null
  const v = Number(m[2]) * 10 ** decimals + Number((m[3] ?? '').padEnd(decimals, '0') || 0)
  if (!Number.isSafeInteger(v)) return null
  return m[1] && v ? -v : v
}

/** "$1,200.50" (Western grouping), without a sign; the caller shows Dr / Cr. */
export function formatForex(amount: number, c: Pick<Currency, 'symbol' | 'decimals'>): string {
  const abs = Math.abs(amount)
  const unit = 10 ** c.decimals
  const whole = Math.floor(abs / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = c.decimals ? '.' + (abs % unit).toString().padStart(c.decimals, '0') : ''
  return `${c.symbol}${c.symbol.length > 1 ? ' ' : ''}${whole}${frac}`
}

/** A currency master's own mistakes. */
export function currencyProblems(c: Omit<Currency, 'id'>): string[] {
  const errors: string[] = []
  const symbol = c.symbol.trim()
  if (!symbol || symbol.length > 5) errors.push('A currency symbol is 1 to 5 characters')
  if (/^(₹|rs\.?|inr)$/i.test(symbol)) errors.push('The rupee is the base currency of the books')
  if (!c.name.trim()) errors.push('Give the currency its formal name (US Dollar)')
  if (!Number.isInteger(c.decimals) || c.decimals < 0 || c.decimals > 4) errors.push('A currency has 0 to 4 decimal places')
  return errors
}

/**
 * A foreign-currency line: its foreign amount must come to the rupees at its rate. An amount of 0
 * (with no rate) is a forex adjustment: rupees only, such as a gain or loss.
 */
export function forexLineErrors(e: { amount: Paise; forex?: number | null; forexRate?: number | null }, c: Currency | undefined, at: string): string[] {
  if (!c) return e.forex != null ? [`${at}: the ledger is kept in rupees; it takes no foreign amount`] : []
  if (e.forex == null) return [`${at}: the ledger is kept in ${c.name}; give the amount in ${c.symbol}`]
  if (!Number.isSafeInteger(e.forex)) return [`${at}: the amount in ${c.symbol} has more than ${c.decimals} decimals`]
  if (e.forex === 0) return e.forexRate != null ? [`${at}: a forex adjustment has no rate`] : []
  if (!e.forexRate || !Number.isSafeInteger(e.forexRate) || e.forexRate <= 0) return [`${at}: give the rate of exchange for ${c.symbol}`]
  if (Math.sign(e.forex) !== Math.sign(e.amount)) return [`${at}: the amount in ${c.symbol} is on the other side`]
  // the foreign amount is exact to its smallest unit, so the rupees may be up to half of one unit away (an invoice priced in rupees)
  const base = toBase(e.forex, e.forexRate, c.decimals)
  if (Math.abs(base - e.amount) > Math.ceil(toBase(1, e.forexRate, c.decimals) / 2)) return [`${at}: ${formatForex(e.forex, c)} at ${formatRate(e.forexRate)} is ₹${(Math.abs(base) / 100).toFixed(2)}, not ₹${(Math.abs(e.amount) / 100).toFixed(2)}`]
  return []
}

/** Split an entry's foreign amount over its bills in proportion to their rupees; the last bill takes the remainder. */
export function splitForex(forex: number | null | undefined, amount: Paise, bills: { amount: Paise }[]): (number | null)[] {
  if (forex == null) return bills.map(() => null)
  let left = forex
  return bills.map((b, i) => {
    if (i === bills.length - 1 && bills.reduce((t, x) => t + x.amount, 0) === amount) return left
    const share = divRound(BigInt(forex) * BigInt(b.amount), BigInt(amount))
    left -= share
    return share
  })
}

export interface Revaluation {
  forex: number // the balance in the currency
  book: Paise // the balance in the books, rupees
  rate: number | null // the standard rate on the date
  value: Paise | null // the balance in the currency at that rate
  difference: Paise // value - book: + needs a debit (a gain on an asset, a smaller liability); - a loss
}

/** A balance in the currency valued at a rate, against its rupees. Without a rate there is nothing to adjust. */
export function revalue(forex: number, book: Paise, rate: number | null, decimals: number): Revaluation {
  if (rate === null) return { forex, book, rate, value: null, difference: 0 }
  const value = toBase(forex, rate, decimals)
  return { forex, book, rate, value, difference: value - book }
}
