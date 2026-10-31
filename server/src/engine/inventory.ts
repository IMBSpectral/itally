import { isUnder, type GroupNode } from './groups'
import type { Paise } from './money'
import { isStockVoucher, type LedgerRef, type VoucherInput, type VoucherType } from './voucher'

/** Quantities are whole thousandths of a unit, so arithmetic is exact (2.5 kg = 2500). */
export type Milli = number

/** "1,250.5" -> 1250500. At most three decimals. */
export function toMilli(input: string | number): Milli {
  const s = String(input).replace(/,/g, '').trim()
  const m = /^(-)?(\d+)(?:\.(\d{1,3}))?$/.exec(s)
  if (!m) throw new Error(`Invalid quantity: ${input}`)
  const q = Number(m[2]) * 1000 + Number((m[3] ?? '').padEnd(3, '0'))
  if (!Number.isSafeInteger(q)) throw new Error(`Quantity too large: ${input}`)
  return m[1] && q !== 0 ? -q : q
}

/** 1250500 with 1 decimal -> "1,250.5". Indian grouping, sign kept. */
export function formatQty(q: Milli, decimals = 0): string {
  const neg = q < 0
  const abs = Math.abs(q)
  const whole = Math.floor(abs / 1000).toString()
  const last3 = whole.slice(-3)
  const rest = whole.slice(0, -3)
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3
  const frac = decimals ? '.' + String(abs % 1000).padStart(3, '0').slice(0, decimals) : ''
  return `${neg ? '-' : ''}${grouped}${frac}`
}

/** A compound unit as quantities see it: "Box of 12 Nos" is 12 Nos to the Box; quantities are kept in Nos. */
export interface Compound {
  perUnit: string // Box
  conversion: number // 12
  unit: string // Nos
}

/** 29 Nos in "Box of 12 Nos" -> "2 Box 5 Nos" (whole first units, the rest in the second unit). */
export function formatCompound(q: Milli, c: Compound, decimals = 0): string {
  const sign = q < 0 ? '-' : ''
  const abs = Math.abs(q)
  const per = c.conversion * 1000
  const whole = Math.floor(abs / per)
  const rest = abs - whole * per
  const parts = [whole ? `${formatQty(whole * 1000)} ${c.perUnit}` : '', rest || !whole ? `${formatQty(rest, decimals)} ${c.unit}` : '']
  return sign + parts.filter(Boolean).join(' ')
}

/** "2-5" (2 Box 5 Nos), "2" (2 Box) or "-5" style input for a compound unit -> thousandths of the second unit. */
export function parseCompound(input: string, c: Pick<Compound, 'conversion'>): Milli {
  const s = input.trim()
  const m = /^(\d[\d,]*)?(?:-(\d[\d,]*(?:\.\d{1,3})?))?$/.exec(s)
  if (!m || (!m[1] && !m[2])) throw new Error(`Invalid quantity: ${input} (whole first units, then - and the rest, like 2-5)`)
  const first = m[1] ? toMilli(m[1]) : 0
  const rest = m[2] ? toMilli(m[2]) : 0
  if (rest >= c.conversion * 1000) throw new Error(`Invalid quantity: ${input} (the rest must be under ${c.conversion})`)
  return first * c.conversion + rest
}

/** Value of a quantity at a rate per unit, rounded to the paisa. */
export const valueOf = (qty: Milli, rate: Paise) => Math.round((qty * rate) / 1000)

/**
 * Which way stock moves for each voucher type that carries items in one direction. An order's
 * lines carry the direction its goods will move, though the order itself moves nothing. A Stock
 * Journal moves both ways; Physical Stock moves by the difference from the count.
 */
export const STOCK_DIRECTION: Partial<Record<VoucherType, 1 | -1>> = {
  Purchase: 1,
  'Credit Note': 1, // goods returned by a customer come back in
  Sales: -1,
  'Debit Note': -1, // goods returned to a supplier go out
  'Sales Order': -1,
  'Purchase Order': 1,
  'Delivery Note': -1,
  'Receipt Note': 1,
  'Rejections In': 1, // goods a customer rejected, taken back
  'Rejections Out': -1, // goods returned to a supplier
  'Job Work In Order': -1, // the processed goods a principal is to get back
  'Job Work Out Order': 1, // the processed goods a job worker is to send us
}
/** Orders record what is due; their lines move no stock. */
export const ORDER_TYPES: readonly VoucherType[] = ['Sales Order', 'Purchase Order', 'Job Work In Order', 'Job Work Out Order']
/** Vouchers with a consumption (Source) and a production (Destination) list. */
export const TWO_WAY_TYPES: readonly VoucherType[] = ['Stock Journal', 'Manufacturing Journal', 'Material In', 'Material Out']
/** What a voucher makes takes the cost of what it consumes (and any additional cost). */
export const COSTED_TYPES: readonly VoucherType[] = ['Manufacturing Journal', 'Material In', 'Material Out']
/** Inventory vouchers with a party: orders, notes, rejections and job work. */
export const needsParty = (t: VoucherType) => (!!STOCK_DIRECTION[t] && isStockVoucher(t)) || t === 'Material In' || t === 'Material Out'
/** What each kind of line may be made against: the order it fulfils and the note it is invoiced against. */
export const LINKS: Partial<Record<VoucherType, { order: VoucherType; note?: VoucherType }>> = {
  'Delivery Note': { order: 'Sales Order' },
  Sales: { order: 'Sales Order', note: 'Delivery Note' },
  'Receipt Note': { order: 'Purchase Order' },
  Purchase: { order: 'Purchase Order', note: 'Receipt Note' },
  'Material In': { order: 'Job Work Out Order' },
  'Material Out': { order: 'Job Work In Order' },
}
/** Whether a line moves stock: not on an order, and not when its note already moved it. */
export const movesStock = (type: VoucherType, l: Pick<InventoryLine, 'trackingId'>) => !ORDER_TYPES.includes(type) && !l.trackingId
/** The ledger group an item invoice's goods are booked to. */
const TRADING_GROUP: Partial<Record<VoucherType, string>> = {
  Purchase: 'Purchase Accounts',
  'Debit Note': 'Purchase Accounts',
  Sales: 'Sales Accounts',
  'Credit Note': 'Sales Accounts',
}

export interface InventoryLine {
  itemId: number
  godownId: number
  qty: Milli // + in, - out
  rate: Paise // per unit
  amount: Paise // same sign as qty, or 0
  counted?: Milli | null // Physical Stock: the quantity counted (qty is then the difference from the books)
  orderId?: number | null // the Sales/Purchase Order this line fulfils
  trackingId?: number | null // the Delivery/Receipt Note this invoice line is billed against
  dueDate?: string | null // order lines: when the goods are due
  batch?: string | null // an item kept in batches: the batch the goods are of
  mfgDate?: string | null // the batch's date of manufacture (on the line bringing it in)
  expiryDate?: string | null // and its expiry
  role?: 'by-product' | 'scrap' | null // a Manufacturing Journal: made alongside the main product
  costShare?: number | null // a by-product's share of the cost, hundredths of a percent
}

export interface StockItemRef {
  id: number
  name: string
  decimals: number // of its unit
}

export interface InventoryContext {
  items: Map<number, StockItemRef>
  godowns: Set<number>
  ledgers: Map<number, LedgerRef>
  groups: Map<number, GroupNode>
}

/**
 * Rules for item lines. On an invoice (Sales / Purchase / Credit Note / Debit Note): stock moving
 * the right way, quantities the unit allows, and the items adding up to what the voucher books to
 * its Sales (or Purchase) ledgers. On an inventory voucher: at least one line, a party on orders
 * and notes, a count on every Physical Stock line. Whether an order or note a line is made against
 * exists and still has the quantity pending needs the database (books.ts checks it).
 */
export function validateInventory(v: VoucherInput & { inventory?: InventoryLine[] }, ctx: InventoryContext): string[] {
  const lines = v.inventory ?? []
  const stock = isStockVoucher(v.type)
  if (!lines.length) return stock ? [`A ${v.type} needs at least one stock item`] : []
  const dir = STOCK_DIRECTION[v.type]
  const physical = v.type === 'Physical Stock'
  if (!dir && !stock) return [`A ${v.type} voucher cannot carry stock items`]
  const errors: string[] = []
  const party = v.partyId != null ? ctx.ledgers.get(v.partyId) : undefined
  if (v.additionalCost && !['Manufacturing Journal', 'Material In'].includes(v.type)) errors.push(`A ${v.type} has no additional cost`)
  if (v.additionalCost != null && (!Number.isSafeInteger(v.additionalCost) || v.additionalCost < 0)) errors.push('The additional cost is a positive amount')
  if (needsParty(v.type)) {
    if (v.partyId == null) errors.push(`A ${v.type} needs a party`)
    else if (!party) errors.push(`Unknown party ledger ${v.partyId}`)
  } else if (v.partyId != null) errors.push(`A ${v.type} has no party`)
  const links = LINKS[v.type]
  const counted = new Set<string>()
  let total = 0
  lines.forEach((l, i) => {
    const at = `Item line ${i + 1}`
    const item = ctx.items.get(l.itemId)
    if (!item) return errors.push(`${at}: unknown stock item ${l.itemId}`)
    if (!ctx.godowns.has(l.godownId)) errors.push(`${at}: unknown godown ${l.godownId}`)
    const step = 10 ** (3 - item.decimals)
    if (physical) {
      if (l.counted == null || !Number.isSafeInteger(l.counted) || l.counted < 0) errors.push(`${at} (${item.name}): enter the quantity counted`)
      else if (l.counted % step !== 0) errors.push(`${at} (${item.name}): its unit allows ${item.decimals} decimal place${item.decimals === 1 ? '' : 's'}`)
      const key = `${l.itemId}@${l.godownId}`
      if (counted.has(key)) errors.push(`${at} (${item.name}): counted twice in the same godown`)
      counted.add(key)
    } else if (l.counted != null) errors.push(`${at} (${item.name}): only Physical Stock records a count`)
    if (l.orderId != null && !links) errors.push(`${at} (${item.name}): a ${v.type} is not made against an order`)
    if (l.trackingId != null && !links?.note) errors.push(`${at} (${item.name}): a ${v.type} is not made against a note`)
    if (l.orderId != null && l.trackingId != null) errors.push(`${at} (${item.name}): a line goes against an order or a note, not both`)
    if (l.dueDate != null && !ORDER_TYPES.includes(v.type)) errors.push(`${at} (${item.name}): only order lines have a due date`)
    if (!Number.isSafeInteger(l.qty) || (l.qty === 0 && !physical)) return errors.push(`${at} (${item.name}): quantity must not be zero`)
    if (dir && Math.sign(l.qty) !== dir) errors.push(`${at} (${item.name}): a ${v.type} moves stock ${dir > 0 ? 'in' : 'out'}`)
    if (l.qty % step !== 0)
      errors.push(`${at} (${item.name}): its unit allows ${item.decimals} decimal place${item.decimals === 1 ? '' : 's'}`)
    if (!Number.isSafeInteger(l.rate) || l.rate < 0) errors.push(`${at} (${item.name}): rate must be a positive amount`)
    if (!Number.isSafeInteger(l.amount) || (l.amount !== 0 && Math.sign(l.amount) !== Math.sign(l.qty)))
      errors.push(`${at} (${item.name}): amount must follow the quantity`)
    total += l.amount
  })
  if (errors.length || stock) return errors
  const group = TRADING_GROUP[v.type]!
  const booked = v.entries
    .filter((e) => {
      const l = ctx.ledgers.get(e.ledgerId)
      return l?.groupId != null && isUnder(ctx.groups, l.groupId, [group])
    })
    .reduce((t, e) => t + e.amount, 0)
  if (booked !== total)
    errors.push(`The items total ${Math.abs(total) / 100}, but the ${group} ledgers carry ${Math.abs(booked) / 100}`)
  return errors
}

/** One item's opening position and movements, as the database adds them up. */
export interface ItemMovement {
  openingQty: Milli
  openingValue: Paise
  inQty: Milli
  inValue: Paise
  outQty: Milli // positive
}

export interface ItemPosition extends ItemMovement {
  rate: Paise // average cost per unit
  outValue: Paise
  closingQty: Milli
  closingValue: Paise
}

/**
 * Average cost, TallyPrime's default: what is left (and what went out) is valued at the average
 * rate of the opening stock plus everything that came in during the period. With nothing to
 * average (no stock and nothing in), the fallback rate is used.
 */
export function averageCost(m: ItemMovement, fallbackRate: Paise = 0): ItemPosition {
  const qty = m.openingQty + m.inQty
  const rate = qty > 0 ? Math.round(((m.openingValue + m.inValue) * 1000) / qty) : fallbackRate
  const closingQty = m.openingQty + m.inQty - m.outQty
  // with nothing gone out the stock is worth exactly what it cost; the rounded rate is for what goes out
  const closingValue = m.outQty === 0 && qty > 0 ? m.openingValue + m.inValue : valueOf(closingQty, rate)
  return { ...m, rate, closingQty, closingValue, outValue: m.openingValue + m.inValue - closingValue }
}
