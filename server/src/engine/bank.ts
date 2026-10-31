import type { Paise } from './money'

/** A bank-ledger entry still waiting for its bank date. Amount + = Dr = money into the bank. */
export interface OpenBankEntry {
  entryId: number
  date: string // voucher date, yyyy-mm-dd
  amount: Paise
}

/** One line of the bank's own statement. Amount + = credited by the bank (a deposit). */
export interface StatementLine {
  date: string
  amount: Paise
  description?: string
}

export interface Match {
  entryId: number
  bankDate: string
  line: number // index into the statement
}

const DAY = 86_400_000
const gap = (a: string, b: string) => Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / DAY

/**
 * Pair statement lines with open bank entries: same amount and direction, statement date on or
 * after the voucher date and within `windowDays` of it. The closest date wins, and each entry
 * and each line is used once. Unmatched lines are left for the user.
 */
export function matchStatement(open: OpenBankEntry[], lines: StatementLine[], windowDays = 7): { matches: Match[]; unmatched: number[] } {
  const taken = new Set<number>()
  const matches: Match[] = []
  const unmatched: number[] = []
  lines.forEach((l, i) => {
    let best: OpenBankEntry | undefined
    for (const e of open) {
      if (taken.has(e.entryId) || e.amount !== l.amount || l.date < e.date || gap(e.date, l.date) > windowDays) continue
      if (!best || gap(e.date, l.date) < gap(best.date, l.date)) best = e
    }
    if (best) {
      taken.add(best.entryId)
      matches.push({ entryId: best.entryId, bankDate: l.date, line: i })
    } else unmatched.push(i)
  })
  return { matches, unmatched }
}

/**
 * The reconciliation statement: book balance, then what the bank hasn't reflected yet.
 * Deposits the bank hasn't credited lower the bank's figure; cheques it hasn't paid raise it.
 */
export function reconcile(bookBalance: Paise, open: { amount: Paise }[]) {
  const notCredited = open.filter((e) => e.amount > 0).reduce((t, e) => t + e.amount, 0)
  const notDebited = open.filter((e) => e.amount < 0).reduce((t, e) => t - e.amount, 0)
  return { bookBalance, notCredited, notDebited, bankBalance: bookBalance - notCredited + notDebited }
}
