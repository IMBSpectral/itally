import { today } from './clock'
import { CASH_BANK_GROUPS, isUnder, type GroupNode } from './groups'
import type { Paise } from './money'
import type { InventoryLine } from './inventory'
import { forexLineErrors, type Currency } from './forex'

/** Built-in voucher types: Tally's accounting vouchers (F4–F9, Credit/Debit Note) and its inventory vouchers. */
export const VOUCHER_TYPES = [
  'Contra',
  'Payment',
  'Receipt',
  'Journal',
  'Sales',
  'Purchase',
  'Credit Note',
  'Debit Note',
  'Sales Order',
  'Purchase Order',
  'Delivery Note',
  'Receipt Note',
  'Stock Journal',
  'Physical Stock',
  'Memorandum',
  'Payroll',
  'Attendance',
  'Manufacturing Journal',
  'Rejections In',
  'Rejections Out',
  'Material In',
  'Material Out',
  'Job Work In Order',
  'Job Work Out Order',
  'Reversing Journal',
] as const
export type VoucherType = (typeof VOUCHER_TYPES)[number]

/** Inventory vouchers: item lines only, no ledger entries (Tally's non-accounting vouchers). */
export const STOCK_VOUCHER_TYPES: readonly VoucherType[] = ['Sales Order', 'Purchase Order', 'Delivery Note', 'Receipt Note', 'Stock Journal', 'Physical Stock',
  'Manufacturing Journal', 'Rejections In', 'Rejections Out', 'Material In', 'Material Out', 'Job Work In Order', 'Job Work Out Order']
export const isStockVoucher = (t: VoucherType) => STOCK_VOUCHER_TYPES.includes(t)

/** How an entry on a bill-wise ledger splits across bills (Tally's bill-wise details). */
export const BILL_TYPES = ['New Ref', 'Agst Ref', 'Advance', 'On Account'] as const
export type BillType = (typeof BILL_TYPES)[number]

export interface BillInput {
  type: BillType
  name?: string // the bill's reference; none for On Account
  dueDate?: string // yyyy-mm-dd, New Ref only; defaults to the ledger's credit period
  amount: Paise // signed like the entry
}

export interface EntryInput {
  ledgerId: number
  amount: Paise // + Dr, - Cr
  bills?: BillInput[] // only on bill-wise ledgers; whatever isn't allocated counts as On Account
  costs?: CostInput[] // only on ledgers with cost centres; they add up to the entry
  chequeNo?: string | null // a bank entry's instrument (cheque / DD) number
  chequeDate?: string | null // the date on the instrument (yyyy-mm-dd); may differ from the voucher's
  forex?: number | null // on a foreign-currency ledger: the amount in the currency's smallest unit, signed like the entry; 0 = a forex adjustment
  forexRate?: number | null // rupees for one unit, in ten-thousandths of a rupee (forex × rate = amount)
}

/** A share of an entry booked to a cost centre, signed like the entry. */
export interface CostInput {
  centreId: number
  amount: Paise
}

export interface VoucherInput {
  type: VoucherType
  date: string // yyyy-mm-dd
  narration?: string
  entries: EntryInput[] // none on an inventory voucher
  inventory?: InventoryLine[] // item lines of an item invoice or an inventory voucher
  partyId?: number | null // the party of an order or note
  postDated?: boolean // Tally's Ctrl+T: listed as post-dated until its date arrives
  optional?: boolean // Tally's Ctrl+L: kept, but out of the books until made regular
  gstAdjustment?: 'itc-reversal' | 'itc-reclaim' | null // a Journal that reverses or reclaims input tax credit
  voucherTypeId?: number | null // a voucher type of the company's own ("Sales - Export"), numbered its own way
  docNo?: string | null // the number typed, for a voucher type numbered by hand
  attendance?: AttendanceInput[] // an Attendance voucher's lines: days or units per employee
  additionalCost?: number // a Manufacturing Journal or Material In: labour, power, job work charges added to what is made (paise)
  applicableUpto?: string | null // a Reversing Journal: the last date it is effective in a scenario
  refNo?: string | null // the supplier's invoice or note number (GSTR-2B matches on it)
  refDate?: string | null // and its date
  advanceRate?: number | null // a Receipt in advance for services: the GST rate it is taxed at (hundredths of a percent)
  costTrack?: string | null // item cost tracking: the job or consignment its costs and sales belong to
  shippingBill?: ShippingBill | null // an export of goods: the shipping bill it left on
}

/** An export's shipping bill: the port's code (INNSA1), its number and date. Kept with the voucher's GST breakup. */
export interface ShippingBill {
  port: string
  no: string
  date: string
}

/** An employee's attendance, leave or production of one type, in thousandths of its unit. */
export interface AttendanceInput {
  employeeId: number
  typeId: number
  value: number
}

/**
 * A post-dated voucher whose date has not come: as in Tally, kept out of the books until that day,
 * when the server posts it.
 */
export const isHeld = (v: Pick<VoucherInput, 'type' | 'optional' | 'postDated' | 'date'>) =>
  !!v.postDated && !v.optional && v.type !== 'Memorandum' && v.type !== 'Reversing Journal' && v.date > today()

/** Optional, Memorandum and Reversing Journal vouchers, and post-dated ones not yet due, are kept as entered and stay out of the books. */
export const isDraft = (v: Pick<VoucherInput, 'type' | 'optional' | 'postDated' | 'date'>) =>
  !!v.optional || v.type === 'Memorandum' || v.type === 'Reversing Journal' || isHeld(v)

export interface LedgerRef {
  id: number
  name: string
  groupId: number | null // null = primary ledger (Profit & Loss A/c)
  billwise?: boolean
  costCentres?: boolean // "cost centres are applicable"
  interestRate?: number | null // hundredths of a percent a year, when interest is calculated
  currencyId?: number | null // kept in a foreign currency
  country?: string | null // a party abroad
}

export interface ValidationContext {
  ledgers: Map<number, LedgerRef>
  groups: Map<number, GroupNode>
  booksBeginFrom: string // yyyy-mm-dd
  centres?: Map<number, string> // the company's cost centres, by id
  currencies?: Map<number, Currency> // the company's currencies, by id
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function validDate(s: string) {
  if (!ISO_DATE.test(s)) return false
  const d = new Date(s + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/**
 * Every rule a voucher must pass before it is posted. The database enforces Dr = Cr again
 * at commit, so an external import (XML gateway) can't bypass the balance rule either.
 * Returns human-readable errors; empty array = valid.
 */
export function validateVoucher(v: VoucherInput, ctx: ValidationContext): string[] {
  const errors: string[] = []
  if (!VOUCHER_TYPES.includes(v.type)) errors.push(`Unknown voucher type "${v.type}"`)
  if (!validDate(v.date)) errors.push(`Invalid date "${v.date}"`)
  else if (v.date < ctx.booksBeginFrom) errors.push(`Date ${v.date} is before books beginning ${ctx.booksBeginFrom}`)
  if (v.gstAdjustment != null && v.type !== 'Journal') errors.push('A GST adjustment is made with a Journal voucher')
  if (v.attendance?.length && v.type !== 'Attendance') errors.push('Only an Attendance voucher records attendance')
  if (v.type === 'Reversing Journal') {
    if (!v.applicableUpto || !validDate(v.applicableUpto)) errors.push('A Reversing Journal needs the date it is applicable up to')
    else if (v.applicableUpto < v.date) errors.push('A Reversing Journal is applicable up to a date on or after its own')
    if (v.optional) errors.push('A Reversing Journal is already out of the books; it cannot be optional')
  } else if (v.applicableUpto) errors.push('Only a Reversing Journal has an applicable-upto date')
  if (v.refDate != null && !validDate(v.refDate)) errors.push(`Invalid supplier invoice date "${v.refDate}"`)
  if (v.refNo != null && v.refNo.length > 16) errors.push('A supplier invoice number is at most 16 characters (as on the GST portal)')
  if (v.advanceRate != null) {
    if (v.type !== 'Receipt') errors.push('Only a Receipt is an advance taxed on receipt')
    if (!Number.isInteger(v.advanceRate) || v.advanceRate < 0 || v.advanceRate > 10000) errors.push('The GST rate of an advance is between 0% and 100%')
  }
  if (v.type === 'Attendance') {
    if (v.entries.length) errors.push('An Attendance voucher has no ledger entries')
    if (!v.attendance?.length) errors.push('Record the attendance or production of at least one employee')
    for (const [i, a] of (v.attendance ?? []).entries())
      if (!Number.isSafeInteger(a.value) || a.value === 0) errors.push(`Line ${i + 1}: give the days, hours or units`)
    if (v.optional) errors.push('An Attendance voucher cannot be optional')
    return errors
  }
  if (isStockVoucher(v.type)) {
    // the item lines are checked by validateInventory
    if (v.entries.length) errors.push(`A ${v.type} has no ledger entries`)
    return errors
  }

  if (v.entries.length < 2) errors.push('A voucher needs at least two ledger entries')
  let total = 0
  let dr = 0
  let cr = 0
  const known: LedgerRef[] = []
  for (const [i, e] of v.entries.entries()) {
    if (!Number.isSafeInteger(e.amount) || e.amount === 0) {
      errors.push(`Line ${i + 1}: amount must be a non-zero whole number of paise`)
      continue
    }
    const l = ctx.ledgers.get(e.ledgerId)
    if (!l) {
      errors.push(`Line ${i + 1}: unknown ledger ${e.ledgerId}`)
      continue
    }
    known.push(l)
    total += e.amount
    if (e.amount > 0) dr++
    else cr++
  }
  if (errors.length) return errors
  for (const [i, e] of v.entries.entries()) {
    const l = ctx.ledgers.get(e.ledgerId)!
    if (e.chequeNo != null || e.chequeDate != null) {
      const at = `Line ${i + 1} (${l.name})`
      if (l.groupId === null || !isUnder(ctx.groups, l.groupId, ['Bank Accounts', 'Bank OD A/c'])) errors.push(`${at}: cheque details go on a bank ledger`)
      if (e.chequeDate != null && !validDate(e.chequeDate)) errors.push(`${at}: invalid cheque date "${e.chequeDate}"`)
      if (e.chequeNo != null && (!e.chequeNo.trim() || e.chequeNo.length > 30)) errors.push(`${at}: a cheque number is 1 to 30 characters`)
    }
    errors.push(...validateBills(e, ctx.ledgers.get(e.ledgerId)!, i + 1))
    errors.push(...forexLineErrors(e, l.currencyId != null ? ctx.currencies?.get(l.currencyId) : undefined, `Line ${i + 1} (${l.name})`))
    errors.push(...validateCosts(e, ctx.ledgers.get(e.ledgerId)!, i + 1, ctx.centres ?? new Map()))
  }
  if (dr === 0 || cr === 0) errors.push('A voucher needs at least one Debit and one Credit entry')
  if (total !== 0) errors.push(`Debit and Credit totals differ by ${Math.abs(total) / 100}`)

  const under = (l: LedgerRef, names: string[]) => l.groupId !== null && isUnder(ctx.groups, l.groupId, names)
  const cashBank = (l: LedgerRef) => under(l, CASH_BANK_GROUPS)
  for (const l of known)
    if (under(l, ['Stock-in-Hand']))
      errors.push(`${l.name} is a Stock-in-Hand ledger; set closing stock through stock valuation, not a voucher`)
  const side = (sign: 1 | -1) =>
    v.entries.filter((e) => Math.sign(e.amount) === sign).map((e) => ctx.ledgers.get(e.ledgerId)!)

  switch (v.type) {
    case 'Contra':
      if (!known.every(cashBank)) errors.push('Contra vouchers can only use Cash and Bank ledgers')
      break
    case 'Payment':
      if (!side(-1).some(cashBank)) errors.push('A Payment must be credited to a Cash or Bank ledger')
      break
    case 'Receipt':
      if (!side(1).some(cashBank)) errors.push('A Receipt must be debited to a Cash or Bank ledger')
      break
    case 'Journal':
      // Tally's default: journals are for non-cash adjustments; a forex gain or loss on a foreign-currency bank account is one
      if (v.entries.some((e) => cashBank(ctx.ledgers.get(e.ledgerId)!) && e.forex !== 0))
        errors.push('Journal vouchers cannot use Cash or Bank ledgers; use Payment, Receipt or Contra')
      break
    case 'Sales':
    case 'Credit Note':
      if (!known.some((l) => under(l, ['Sales Accounts'])))
        errors.push(`A ${v.type} needs a ledger under Sales Accounts`)
      break
    case 'Purchase':
    case 'Debit Note':
      if (!known.some((l) => under(l, ['Purchase Accounts'])))
        errors.push(`A ${v.type} needs a ledger under Purchase Accounts`)
      break
  }
  return errors
}

/** Cost centre split of one entry: only where cost centres apply, known centres, each once, adding up. */
export function validateCosts(e: EntryInput, ledger: LedgerRef, line: number, centres: Map<number, string>): string[] {
  if (!e.costs?.length) return []
  const at = `Line ${line} (${ledger.name})`
  if (!ledger.costCentres) return [`${at}: cost centres don't apply to this ledger`]
  const errors: string[] = []
  const seen = new Set<number>()
  let total = 0
  for (const c of e.costs) {
    const name = centres.get(c.centreId)
    if (!name) errors.push(`${at}: unknown cost centre ${c.centreId}`)
    else if (seen.has(c.centreId)) errors.push(`${at}: cost centre "${name}" appears twice`)
    seen.add(c.centreId)
    if (!Number.isSafeInteger(c.amount) || c.amount === 0 || Math.sign(c.amount) !== Math.sign(e.amount))
      errors.push(`${at}: each cost centre takes a non-zero share on the entry's side`)
    total += c.amount
  }
  if (!errors.length && total !== e.amount)
    errors.push(`${at}: cost centres total ${Math.abs(total) / 100}, but the entry is ${Math.abs(e.amount) / 100}`)
  return errors
}

/** Bill-wise details of one entry: only on bill-wise ledgers, named where needed, adding up. */
export function validateBills(e: EntryInput, ledger: LedgerRef, line: number): string[] {
  if (!e.bills?.length) return []
  const errors: string[] = []
  const at = `Line ${line} (${ledger.name})`
  if (!ledger.billwise) return [`${at}: this ledger doesn't keep bill-wise details`]
  const seen = new Set<string>()
  let total = 0
  for (const b of e.bills) {
    if (!BILL_TYPES.includes(b.type)) {
      errors.push(`${at}: unknown bill type "${b.type}"`)
      continue
    }
    if (!Number.isSafeInteger(b.amount) || b.amount === 0) errors.push(`${at}: each bill needs a non-zero amount`)
    total += b.amount
    const name = b.name?.trim() ?? ''
    if (b.type === 'On Account') {
      if (name) errors.push(`${at}: an On Account amount has no bill name`)
    } else if (!name) errors.push(`${at}: a ${b.type} needs a bill name`)
    else if (seen.has(name.toLowerCase())) errors.push(`${at}: bill "${name}" appears twice`)
    else seen.add(name.toLowerCase())
    if (b.dueDate !== undefined && (b.type !== 'New Ref' || !validDate(b.dueDate)))
      errors.push(`${at}: a due date goes only on a New Ref, as yyyy-mm-dd`)
  }
  if (!errors.length && total !== e.amount)
    errors.push(`${at}: bill-wise amounts total ${Math.abs(total) / 100}, but the entry is ${Math.abs(e.amount) / 100}`)
  return errors
}
