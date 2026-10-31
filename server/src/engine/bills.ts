import type { Paise } from './money'

/** One pending bill as the database reports it (amount + = Dr, i.e. receivable). */
export interface PendingBill {
  ledgerId: number
  ledger: string
  name: string
  billDate: string // yyyy-mm-dd
  dueDate: string // yyyy-mm-dd (bill date + credit period when none was given)
  pending: Paise
  forex?: number | null // on a foreign-currency ledger: what is pending in the currency
}

export const AGEING_BUCKETS = ['Not due', '1–30 days', '31–60 days', '61–90 days', 'Over 90 days'] as const

const DAY = 86_400_000
const days = (from: string, to: string) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY)

/** Days past the due date on `asOf` (0 when not yet due). */
export function overdueDays(b: Pick<PendingBill, 'dueDate'>, asOf: string) {
  return Math.max(0, days(b.dueDate, asOf))
}

export function ageingBucket(overdue: number): (typeof AGEING_BUCKETS)[number] {
  if (overdue <= 0) return 'Not due'
  if (overdue <= 30) return '1–30 days'
  if (overdue <= 60) return '31–60 days'
  if (overdue <= 90) return '61–90 days'
  return 'Over 90 days'
}

export interface BillsReport {
  asOf: string
  bills: (PendingBill & { overdueDays: number; bucket: string })[]
  total: Paise
  overdue: Paise
  ageing: { bucket: string; amount: Paise }[]
}

/**
 * Receivables (bills with a debit balance) or payables (credit), oldest first, with how far
 * each is overdue and an ageing summary. Payable amounts are shown positive.
 */
export function billsReport(all: PendingBill[], side: 'receivable' | 'payable', asOf: string): BillsReport {
  const sign = side === 'receivable' ? 1 : -1
  const bills = all
    .filter((b) => Math.sign(b.pending) === sign)
    .map((b) => {
      const o = overdueDays(b, asOf)
      return { ...b, pending: b.pending * sign, overdueDays: o, bucket: ageingBucket(o) }
    })
    .sort((a, b) => a.billDate.localeCompare(b.billDate) || a.ledger.localeCompare(b.ledger) || a.name.localeCompare(b.name))
  const ageing = AGEING_BUCKETS.map((bucket) => ({
    bucket,
    amount: bills.filter((b) => b.bucket === bucket).reduce((t, b) => t + b.pending, 0),
  }))
  return {
    asOf,
    bills,
    total: bills.reduce((t, b) => t + b.pending, 0),
    overdue: bills.filter((b) => b.overdueDays > 0).reduce((t, b) => t + b.pending, 0),
    ageing,
  }
}
