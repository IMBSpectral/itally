/**
 * Stock Ageing, Movement Analysis and Reorder Status. Quantities are thousandths, values paise.
 */
import type { Paise } from './money'

export interface Inward {
  date: string // YYYY-MM-DD; the opening stock comes in on the day the books begin
  qty: number // > 0
  amount: Paise
}

export interface AgeBucket {
  label: string
  qty: number
  value: Paise
}

/** Default age brackets in days, as Tally's: 0–45, 45–90, 90–180 and over 180. */
export const AGE_BRACKETS = [45, 90, 180]

const DAY = 86_400_000

/**
 * The stock in hand is taken to be what came in last (first in, first out), so it is spread over
 * the latest inward lines and aged from each line's date to `asOf`, valued at that line's cost.
 * Given the item's closing value (as the Stock Summary has it), the brackets share that instead,
 * in proportion to quantity, so the report agrees with the stock valuation.
 */
export function ageStock(inwards: Inward[], closingQty: number, asOf: string, brackets = AGE_BRACKETS, closingValue?: Paise): AgeBucket[] {
  const labels = [...brackets.map((b, i) => `${i ? brackets[i - 1] : 0}-${b} days`), `Over ${brackets[brackets.length - 1]} days`]
  const out = labels.map((label) => ({ label, qty: 0, value: 0 }))
  let left = closingQty
  const latestFirst = [...inwards].sort((a, b) => b.date.localeCompare(a.date))
  for (const x of latestFirst) {
    if (left <= 0) break
    const qty = Math.min(left, x.qty)
    left -= qty
    const age = Math.round((Date.parse(asOf) - Date.parse(x.date)) / DAY)
    let i = brackets.findIndex((b) => age < b)
    if (i < 0) i = brackets.length
    out[i].qty += qty
    out[i].value += Math.round((x.amount * qty) / x.qty)
  }
  if (closingValue !== undefined && closingQty > 0) {
    let given = 0
    const last = out.map((b) => b.qty > 0).lastIndexOf(true)
    out.forEach((b, i) => {
      b.value = i === last ? closingValue - given : Math.round((closingValue * b.qty) / closingQty)
      given += b.value
    })
  }
  return out
}

export interface ReorderInput {
  closingQty: number
  reorderLevel: number
  minOrderQty: number | null
  purchaseOrders: number // still to be received
  salesOrders: number // still to be delivered
}

export interface ReorderStatus {
  available: number // in hand + on order - committed to customers
  shortfall: number // how far below the reorder level, 0 if not
  toOrder: number // the shortfall, raised to the minimum order quantity
}

/** Reorder Status: what is in hand and on order, less what customers have ordered, against the reorder level. */
export function reorderStatus(x: ReorderInput): ReorderStatus {
  const available = x.closingQty + x.purchaseOrders - x.salesOrders
  const shortfall = Math.max(x.reorderLevel - available, 0)
  const toOrder = shortfall === 0 ? 0 : Math.max(shortfall, x.minOrderQty ?? 0)
  return { available, shortfall, toOrder }
}
