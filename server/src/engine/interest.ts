import type { Paise } from './money'

/**
 * Interest as Tally's "Interest Calculations" work it out: simple interest on a running amount,
 * day by day, at a yearly rate on a 365-day year. A voucher dated d changes the amount from d on,
 * so the period is cut into stretches of days with the same amount. Rates are hundredths of a
 * percent a year (1800 = 18% p.a.); a Dr amount earns interest receivable, a Cr amount payable.
 */
export interface Stretch {
  from: string // yyyy-mm-dd, first day
  to: string // last day
  days: number
  amount: Paise // + Dr, - Cr
  interest: Paise // same sign as the amount
}

const DAY = 86_400_000
const toDay = (iso: string) => Date.parse(iso + 'T00:00:00Z') / DAY
const toIso = (day: number) => new Date(day * DAY).toISOString().slice(0, 10)

/** Interest for `days` days on `amount` at `rate` (hundredths of a percent a year), to the paisa. */
export const interestFor = (amount: Paise, rate: number, days: number): Paise =>
  Math.round((amount * rate * days) / (10_000 * 365))

/**
 * Stretches of [from, to] with the amount standing on each day: `opening` as at the start of
 * `from`, then each change on its date. Changes before `from` must already be in `opening`.
 */
export function stretches(opening: Paise, changes: { date: string; amount: Paise }[], from: string, to: string, rate: number): Stretch[] {
  const out: Stretch[] = []
  const end = toDay(to)
  let day = toDay(from)
  let amount = opening
  const byDay = new Map<number, Paise>()
  for (const c of changes) {
    const d = toDay(c.date)
    if (d < day || d > end) continue
    byDay.set(d, (byDay.get(d) ?? 0) + c.amount)
  }
  const cuts = [...byDay.keys()].sort((a, b) => a - b)
  for (const cut of [...cuts, end + 1]) {
    if (cut > day) {
      const days = cut - day
      if (amount !== 0) out.push({ from: toIso(day), to: toIso(cut - 1), days, amount, interest: interestFor(amount, rate, days) })
      day = cut
    }
    amount += byDay.get(cut) ?? 0
  }
  return out
}

/** A bill as interest sees it: its amount from when it falls due, less what settles it, as it settles. */
export interface InterestBill {
  name: string
  dueDate: string
  amount: Paise // signed like the ledger (+ Dr)
  settlements: { date: string; amount: Paise }[] // signed like the settling entry (opposite to the bill)
}

/**
 * Interest on overdue bills: each bill earns from the day after it falls due on what is still
 * unpaid, within [from, to]. Settlements before that day only reduce the amount.
 */
export function billStretches(bills: InterestBill[], from: string, to: string, rate: number) {
  return bills
    .map((b) => {
      const start = toIso(Math.max(toDay(from), toDay(b.dueDate) + 1))
      if (start > to) return { name: b.name, dueDate: b.dueDate, stretches: [] as Stretch[], interest: 0 }
      const before = b.settlements.filter((s) => s.date < start).reduce((t, s) => t + s.amount, 0)
      const opening = b.amount + before
      // a bill can't run past zero into the other side
      const s = stretches(opening, b.settlements.filter((x) => x.date >= start), start, to, rate).filter((x) => Math.sign(x.amount) === Math.sign(b.amount))
      return { name: b.name, dueDate: b.dueDate, stretches: s, interest: s.reduce((t, x) => t + x.interest, 0) }
    })
    .filter((b) => b.stretches.length)
}
