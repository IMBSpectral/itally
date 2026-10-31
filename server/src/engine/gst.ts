/**
 * GST: states and their codes, GSTIN checks, and the tax breakup of an invoice. Pure functions,
 * shared by the server (stored with each voucher, used by the returns) and the invoice screen
 * (which fills in the tax lines). Rates are in hundredths of a percent (1800 = 18%), money in
 * paise, quantities in thousandths, as everywhere else.
 */
import type { VoucherInput, VoucherType, ShippingBill } from './voucher'
import type { InventoryLine } from './inventory'

/** GST state codes (the first two digits of a GSTIN and the "place of supply"). */
export const GST_STATES: { code: string; name: string }[] = [
  { code: '01', name: 'Jammu & Kashmir' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '03', name: 'Punjab' },
  { code: '04', name: 'Chandigarh' },
  { code: '05', name: 'Uttarakhand' },
  { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi' },
  { code: '08', name: 'Rajasthan' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '10', name: 'Bihar' },
  { code: '11', name: 'Sikkim' },
  { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' },
  { code: '14', name: 'Manipur' },
  { code: '15', name: 'Mizoram' },
  { code: '16', name: 'Tripura' },
  { code: '17', name: 'Meghalaya' },
  { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' },
  { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '24', name: 'Gujarat' },
  { code: '26', name: 'Dadra & Nagar Haveli and Daman & Diu' },
  { code: '27', name: 'Maharashtra' },
  { code: '29', name: 'Karnataka' },
  { code: '30', name: 'Goa' },
  { code: '31', name: 'Lakshadweep' },
  { code: '32', name: 'Kerala' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '34', name: 'Puducherry' },
  { code: '35', name: 'Andaman & Nicobar Islands' },
  { code: '36', name: 'Telangana' },
  { code: '37', name: 'Andhra Pradesh' },
  { code: '38', name: 'Ladakh' },
  { code: '97', name: 'Other Territory' },
]

const norm = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '')

/** State code for a state name (or a code); undefined when it isn't an Indian state. */
export function stateCode(state: string | null | undefined): string | undefined {
  if (!state) return undefined
  const s = state.trim()
  if (/^\d{2}$/.test(s)) return GST_STATES.some((x) => x.code === s) ? s : undefined
  return GST_STATES.find((x) => norm(x.name) === norm(s))?.code
}
export const stateName = (code: string | undefined) => GST_STATES.find((s) => s.code === code)?.name

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Why a GSTIN is wrong (format, state code or check digit), or null when it is valid. */
export function gstinError(gstin: string): string | null {
  const g = gstin.trim().toUpperCase()
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return `GSTIN "${gstin}" is not 15 characters in the GSTIN format`
  if (!stateCode(g.slice(0, 2))) return `GSTIN "${gstin}" starts with an unknown state code`
  // the 15th character is a mod-36 check over the first 14
  let factor = 2
  let sum = 0
  for (let i = 13; i >= 0; i--) {
    const a = factor * CHARS.indexOf(g[i])
    factor = factor === 2 ? 1 : 2
    sum += Math.floor(a / 36) + (a % 36)
  }
  if (CHARS[(36 - (sum % 36)) % 36] !== g[14]) return `GSTIN "${gstin}" has a wrong check digit`
  return null
}

export const TAX_TYPES = ['IGST', 'CGST', 'SGST', 'Cess'] as const
export type TaxType = (typeof TAX_TYPES)[number]
/** The rates GST uses, in hundredths of a percent. */
export const GST_RATES = [0, 10, 25, 150, 300, 500, 1200, 1800, 2800, 4000]

/** Outward supplies (GSTR-1) and inward ones (input tax credit); notes reduce them. */
export const GST_SIDE: Partial<Record<VoucherType, { side: 'outward' | 'inward'; sign: 1 | -1 }>> = {
  Sales: { side: 'outward', sign: 1 },
  'Credit Note': { side: 'outward', sign: -1 }, // goods returned by a customer
  Purchase: { side: 'inward', sign: 1 },
  'Debit Note': { side: 'inward', sign: -1 }, // goods returned to a supplier
}

/** Whether a supply bears GST: exempt, nil-rated and non-GST supplies are reported apart from taxable ones. */
export const TAXABILITY = ['Taxable', 'Exempt', 'Nil Rated', 'Non-GST'] as const
export type Taxability = (typeof TAXABILITY)[number]
/** How a line without tax is reported (GSTR-1 table 8): a taxable line at 0% counts as nil-rated. */
export type NoTax = 'nil' | 'exempt' | 'nongst'
const NO_TAX: Record<Taxability, NoTax | undefined> = { Taxable: undefined, Exempt: 'exempt', 'Nil Rated': 'nil', 'Non-GST': 'nongst' }

export interface GstLedger {
  id: number
  name: string
  group: string // the predefined group it falls under (Sales Accounts, Duties & Taxes, Sundry Debtors …)
  gstin?: string | null
  state?: string | null
  taxType?: TaxType | null
  rate?: number | null
  cessRate?: number | null // compensation cess, ad valorem
  hsn?: string | null
  country?: string | null // a party abroad makes the supply an export
  reverseCharge?: boolean // the buyer pays this ledger's GST (GTA, legal services, notified purchases)
  taxability?: Taxability | null // absent: taxable
}
export interface GstItem {
  id: number
  hsn?: string | null
  rate?: number | null
  cessRate?: number | null // compensation cess, ad valorem
  unit: string
  name?: string
  uqc?: string // the unit's GST code if it names one, else its symbol
  taxability?: Taxability | null // absent: taxable
}
export interface GstContext {
  companyGstin: string | null
  companyState: string | null
  ledgers: Map<number, GstLedger>
  items: Map<number, GstItem>
}

export interface GstLine {
  hsn: string
  rate: number
  uqc: string // unit
  qty: number
  taxable: number
  igst: number
  cgst: number
  sgst: number
  cess?: number // compensation cess on the line
  cessRate?: number
  rcm?: boolean // tax the buyer pays under reverse charge
  noTax?: NoTax // an exempt, nil-rated or non-GST supply (absent on taxable lines; one at 0% counts as nil-rated)
}
export interface Taxes {
  igst: number
  cgst: number
  sgst: number
  cess: number
}
/** What a voucher means for GST; stored with the voucher, so later rate changes don't rewrite past returns. */
export interface GstBreakup {
  side: 'outward' | 'inward' | 'adjustment'
  party: string | null
  gstin: string | null
  pos: string // place of supply (state code)
  interstate: boolean
  invoiceValue: number
  lines: GstLine[]
  charged: Taxes // as booked on the tax ledgers
  problems: string[] // reasons the voucher needs attention in the returns
  export?: 'WPAY' | 'WOPAY' // an export: with IGST paid, or without (under LUT)
  rcm?: { taxable: number; igst: number; cgst: number; sgst: number } // inward supplies taxed under reverse charge
  adjustment?: 'itc-reversal' | 'itc-reclaim' // a GST adjustment journal: the tax ledgers' amounts
  shippingBill?: ShippingBill // an export of goods
}

/** The portal's place-of-supply code for supplies outside India. */
export const OVERSEAS_POS = '96'
const isOverseas = (l: GstLedger | undefined) => !!l?.country?.trim() && !/^india$/i.test(l.country.trim())

const PARTY_GROUPS = ['Sundry Debtors', 'Sundry Creditors', 'Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c']
const ITEM_LEDGER_GROUPS = ['Sales Accounts', 'Purchase Accounts']

/** Tax on a taxable value: IGST across states, otherwise half each as CGST and SGST. */
export function taxOn(taxable: number, rate: number, interstate: boolean) {
  if (interstate) return { igst: Math.round((taxable * rate) / 10000), cgst: 0, sgst: 0 }
  const half = Math.round((taxable * rate) / 20000)
  return { igst: 0, cgst: half, sgst: half }
}

/** The party of an invoice: a debtor/creditor (or cash/bank) line, else the first line. */
export function partyOf(v: Pick<VoucherInput, 'entries'>, ledgers: Map<number, GstLedger>) {
  return v.entries.find((e) => PARTY_GROUPS.includes(ledgers.get(e.ledgerId)?.group ?? '')) ?? v.entries[0]
}

/** Place of supply: the party's state (or its GSTIN's), else the company's own. */
export function placeOfSupply(party: GstLedger | undefined, ctx: Pick<GstContext, 'companyState' | 'companyGstin'>) {
  return (
    stateCode(party?.state) ??
    (party?.gstin ? party.gstin.slice(0, 2) : undefined) ??
    stateCode(ctx.companyState) ??
    ctx.companyGstin?.slice(0, 2) ??
    ''
  )
}

/**
 * Taxable lines of an invoice: its items (HSN and rate from the item), or, without items, the
 * lines on ledgers that carry a GST rate (a services sales ledger, freight charged on).
 */
export function taxableLines(v: VoucherInput, ctx: GstContext, partyId: number) {
  const out: { hsn: string; rate: number | null; cessRate: number; uqc: string; qty: number; taxable: number; what: string; rcm: boolean; noTax?: NoTax }[] = []
  // an exempt, nil-rated or non-GST supply bears no tax whatever rate is set
  const kind = (t?: Taxability | null) => (t ? NO_TAX[t] : undefined)
  // items bought through a reverse-charge purchase ledger are taxed under reverse charge
  const itemsRcm = v.entries.some((e) => {
    const l = ctx.ledgers.get(e.ledgerId)
    return !!l?.reverseCharge && ITEM_LEDGER_GROUPS.includes(l.group)
  })
  for (const l of v.inventory ?? ([] as InventoryLine[])) {
    const it = ctx.items.get(l.itemId)
    const noTax = kind(it?.taxability)
    out.push({ hsn: it?.hsn ?? '', rate: noTax ? 0 : (it?.rate ?? null), cessRate: noTax ? 0 : (it?.cessRate ?? 0), uqc: it?.uqc ?? it?.unit ?? '', qty: Math.abs(l.qty), taxable: Math.abs(l.amount), what: `item ${l.itemId}`,
      rcm: itemsRcm, ...(noTax ? { noTax } : {}) })
  }
  for (const e of v.entries) {
    const l = ctx.ledgers.get(e.ledgerId)
    if (!l || e.ledgerId === partyId || l.taxType) continue
    const itemLedger = ITEM_LEDGER_GROUPS.includes(l.group)
    if (itemLedger && v.inventory?.length) continue // the items already carry this value
    const noTax = kind(l.taxability)
    if (itemLedger || l.rate != null || noTax)
      out.push({ hsn: l.hsn ?? '', rate: noTax ? 0 : (l.rate ?? null), cessRate: noTax ? 0 : (l.cessRate ?? 0), uqc: 'OTH', qty: 0, taxable: Math.abs(e.amount), what: l.name, rcm: !!l.reverseCharge && !noTax, ...(noTax ? { noTax } : {}) })
  }
  return out
}

/** A GST adjustment journal: the input tax credit it reverses or reclaims, as booked on the tax ledgers. */
function adjustmentBreakup(v: VoucherInput, ctx: GstContext): GstBreakup {
  const charged: Taxes = { igst: 0, cgst: 0, sgst: 0, cess: 0 }
  for (const e of v.entries) {
    const t = ctx.ledgers.get(e.ledgerId)?.taxType
    if (t) charged[t.toLowerCase() as keyof Taxes] += Math.abs(e.amount)
  }
  const problems = charged.igst || charged.cgst || charged.sgst || charged.cess ? [] : ['A GST adjustment needs a line on an IGST, CGST or SGST ledger']
  return { side: 'adjustment', adjustment: v.gstAdjustment!, party: null, gstin: null, pos: '', interstate: false, invoiceValue: 0, lines: [], charged, problems }
}

/** The GST breakup of a voucher, or null when GST doesn't apply (no GSTIN, or not an invoice). */
export function gstBreakup(v: VoucherInput, ctx: GstContext): GstBreakup | null {
  if (!ctx.companyGstin) return null
  if (v.type === 'Journal' && v.gstAdjustment) return adjustmentBreakup(v, ctx)
  // a reverse-charge expense (GTA freight, legal fees) is often booked as a Journal or Payment
  const rcmExpense = (v.type === 'Journal' || v.type === 'Payment') && v.entries.some((e) => ctx.ledgers.get(e.ledgerId)?.reverseCharge)
  const kind = GST_SIDE[v.type] ?? (rcmExpense ? { side: 'inward' as const, sign: 1 as const } : undefined)
  if (!kind) return null
  const party = partyOf(v, ctx.ledgers)
  const partyLedger = party ? ctx.ledgers.get(party.ledgerId) : undefined
  // a sale to a party abroad is an export: always inter-state, place of supply "other countries"
  const overseas = kind.side === 'outward' && isOverseas(partyLedger)
  const pos = overseas ? OVERSEAS_POS : placeOfSupply(partyLedger, ctx)
  const home = stateCode(ctx.companyState) ?? ctx.companyGstin.slice(0, 2)
  const interstate = overseas || pos !== home
  const problems: string[] = []

  const charged: Taxes = { igst: 0, cgst: 0, sgst: 0, cess: 0 }
  for (const e of v.entries) {
    const t = ctx.ledgers.get(e.ledgerId)?.taxType
    if (t) charged[t.toLowerCase() as keyof Taxes] += Math.abs(e.amount)
  }
  const raw = taxableLines(v, ctx, party?.ledgerId ?? -1)
  if (!raw.length && !charged.igst && !charged.cgst && !charged.sgst && !charged.cess) return null

  // an export without IGST is made under a letter of undertaking (LUT): zero-rated, no tax on the lines
  const wopay = overseas && !charged.igst
  const lines: GstLine[] = raw.map((r) => {
    if (r.rate === null) problems.push(`No GST rate on ${r.what.startsWith('item ') ? 'a stock item' : `ledger "${r.what}"`}`)
    if (!r.hsn && kind.side === 'outward' && r.noTax !== 'nongst') problems.push(`No HSN/SAC on ${r.what.startsWith('item ') ? 'a stock item' : `ledger "${r.what}"`}`)
    const rate = r.rate ?? 0
    const tax = wopay ? { igst: 0, cgst: 0, sgst: 0 } : taxOn(r.taxable, rate, interstate)
    const cess = wopay || !r.cessRate ? 0 : Math.round((r.taxable * r.cessRate) / 10000)
    const rcm = kind.side === 'inward' && r.rcm
    return {
      hsn: r.hsn, rate, uqc: r.uqc, qty: r.qty, taxable: r.taxable, ...tax, ...(cess ? { cess, cessRate: r.cessRate } : {}), ...(rcm ? { rcm } : {}),
      ...(r.noTax ? { noTax: r.noTax } : {}),
    }
  })

  // tax under reverse charge is the buyer's to pay: it isn't on the supplier's invoice
  const supplierLines = lines.filter((l) => !l.rcm)
  const computed = supplierLines.reduce((t, l) => ({ igst: t.igst + l.igst, cgst: t.cgst + l.cgst, sgst: t.sgst + l.sgst, cess: t.cess + (l.cess ?? 0) }),
    { igst: 0, cgst: 0, sgst: 0, cess: 0 })
  // a rupee either way is rounding; more than that is a wrong rate or tax ledger
  const off = (a: number, b: number) => Math.abs(a - b) > 100
  if (interstate && (charged.cgst || charged.sgst)) problems.push('CGST/SGST charged on an inter-state supply; it should be IGST')
  else if (!interstate && charged.igst) problems.push('IGST charged on a supply within the state; it should be CGST and SGST')
  else if (!supplierLines.length && (charged.igst || charged.cgst || charged.sgst))
    problems.push('Tax on a reverse charge purchase is paid by you, not charged on the invoice')
  else if (off(charged.igst, computed.igst) || off(charged.cgst, computed.cgst) || off(charged.sgst, computed.sgst))
    problems.push('The tax charged differs from the rate on the items')
  else if (off(charged.cess, computed.cess)) problems.push(computed.cess ? 'The cess charged differs from the cess rate on the items' : 'Cess charged on items that carry no cess rate')
  const rcmLines = lines.filter((l) => l.rcm)
  const rcm = rcmLines.length
    ? rcmLines.reduce((t, l) => ({ taxable: t.taxable + l.taxable, igst: t.igst + l.igst, cgst: t.cgst + l.cgst, sgst: t.sgst + l.sgst }), { taxable: 0, igst: 0, cgst: 0, sgst: 0 })
    : undefined
  const gstin = partyLedger?.gstin?.trim().toUpperCase() || null
  if (gstin && gstinError(gstin)) problems.push(gstinError(gstin)!)
  if (!pos) problems.push('No place of supply: set the company state or the party state')
  const sb = v.shippingBill
  if (overseas && sb?.no) {
    if (!/^IN[A-Z]{3}[A-Z0-9]$/i.test(sb.port.trim())) problems.push(`"${sb.port}" is not a port code (six characters, as INNSA1)`)
    if (!/^[0-9]{1,7}$/.test(sb.no.trim())) problems.push('A shipping bill number is up to seven digits')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sb.date ?? '')) problems.push('The shipping bill needs its date')
  }

  return {
    side: kind.side,
    party: partyLedger?.name ?? null,
    gstin,
    pos,
    interstate,
    invoiceValue: party ? Math.abs(party.amount) : 0,
    lines,
    charged,
    problems: [...new Set(problems)],
    ...(overseas ? { export: wopay ? ('WOPAY' as const) : ('WPAY' as const) } : {}),
    ...(overseas && v.shippingBill?.no ? { shippingBill: { port: v.shippingBill.port.trim().toUpperCase(), no: v.shippingBill.no.trim(), date: v.shippingBill.date } } : {}),
    ...(rcm ? { rcm } : {}),
  }
}

/**
 * The tax lines an invoice should carry, for the invoice screen: for each tax type the
 * company has a ledger for, the tax on the taxable lines.
 */
export function suggestedTaxes(v: VoucherInput, ctx: GstContext): { ledgerId: number; amount: number }[] {
  const b = gstBreakup({ ...v, entries: v.entries.filter((e) => !ctx.ledgers.get(e.ledgerId)?.taxType) }, ctx)
  if (!b || b.side === 'adjustment') return []
  // reverse charge tax isn't charged on the invoice; an export may go without tax (the user adds IGST to pay it)
  const due = b.lines.filter((l) => !l.rcm && !b.export)
    .reduce((t, l) => ({ IGST: t.IGST + l.igst, CGST: t.CGST + l.cgst, SGST: t.SGST + l.sgst, Cess: t.Cess + (l.cess ?? 0) }), { IGST: 0, CGST: 0, SGST: 0, Cess: 0 })
  const out: { ledgerId: number; amount: number }[] = []
  for (const type of ['IGST', 'CGST', 'SGST', 'Cess'] as const) {
    if (!due[type]) continue
    const ledger = [...ctx.ledgers.values()].find((l) => l.taxType === type)
    if (ledger) out.push({ ledgerId: ledger.id, amount: due[type] })
  }
  return out
}
