/** Thin client for the server's JSON API. Amounts are paise, + = Dr. */
import type { VoucherType } from '../server/src/engine/voucher'
import type { GstLedger, GstItem, Taxability, TaxType } from '../server/src/engine/gst'
import type { Gstr1, Gstr3b, Gstr3bLate } from '../server/src/engine/gst-returns'
import type { CashFlow, FundsFlow, Ratios } from '../server/src/engine/analysis'
import type { DeducteeType, ReturnSheetInput, TaxKind, TdsNature } from '../server/src/engine/tds'

export class ApiError extends Error {
  constructor(message: string, public errors: string[] = []) {
    super(message)
  }
}

/**
 * The session for a secured company. Kept for the tab (sessionStorage), so a reload stays
 * signed in; closing the company signs out.
 */
let token: string | null = null
const tokenKey = (c: number) => `tally-session-${c}`
export function setSession(companyId: number, t: string | null) {
  token = t
  try {
    if (t) sessionStorage.setItem(tokenKey(companyId), t)
    else sessionStorage.removeItem(tokenKey(companyId))
  } catch {
    // storage blocked: the session lasts until the page reloads
  }
}
export function storedSession(companyId: number) {
  try {
    return sessionStorage.getItem(tokenKey(companyId))
  } catch {
    return null
  }
}
export const authHeaders = (): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {})
/** Raised when the server wants a sign-in (a new session, or one that expired); the app asks for it. */
export const SIGN_IN_EVENT = 'tally-sign-in'

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 401 && !path.endsWith('/login')) window.dispatchEvent(new Event(SIGN_IN_EVENT))
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => ({ error: res.statusText }))
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, data.errors ?? (data.error ? [data.error] : []))
  return data as T
}

export interface Company {
  id: number
  name: string
  booksBegin: string
  fyStart: string
  secured?: boolean // has users and passwords
}
export type Role = 'Owner' | 'Accountant' | 'Data Entry' | 'Viewer'
export const ROLES: Role[] = ['Owner', 'Accountant', 'Data Entry', 'Viewer']
export interface User {
  id: number
  username: string
  role: Role
  levelId?: number | null // a security level of the company's own
}
/** A security level: a role less voucher types and reports, and a limit on back-dating. */
export interface SecurityLevel {
  id: number
  name: string
  baseRole: Exclude<Role, 'Owner'>
  deniedVouchers: string[]
  deniedReports: string[]
  backDays: number | null
}
export interface Group {
  id: number
  name: string
  parentId: number | null
  nature: string
}
export interface Ledger {
  id: number
  name: string
  groupId: number | null
  group: string | null
  primaryGroup: string | null
  opening: number
  closing: number
  billwise: boolean
  costCentres: boolean
  interestRate: number | null
  currencyId: number | null // kept in a foreign currency
  country?: string | null // a party abroad
}
export type BillType = 'New Ref' | 'Agst Ref' | 'Advance' | 'On Account'
export interface Bill {
  type: BillType
  name?: string | null
  dueDate?: string | null
  amount: number // signed like the entry
}
export interface Entry {
  ledgerId: number
  ledger?: string
  amount: number
  bills?: Bill[] | null
  costs?: Cost[] | null
  chequeNo?: string | null // a bank line's instrument number
  chequeDate?: string | null
  forex?: number | null // on a foreign-currency ledger: the amount in the currency (smallest unit, signed); 0 = a forex adjustment
  forexRate?: number | null // rupees per unit, in ten-thousandths
}
/** A share of an entry booked to a cost centre, signed like the entry. */
export interface Cost {
  centreId: number
  centre?: string
  amount: number
}
type Tax3 = { igst: number; cgst: number; sgst: number }
type TaxSum4 = Tax3 & { taxable: number }
export interface GstPortalDoc extends Tax3 {
  gstin: string
  party: string | null
  docType: 'Invoice' | 'Credit Note' | 'Debit Note'
  docNo: string
  docDate: string
  taxable: number
  value: number
}
export interface GstBooksDoc extends Tax3 {
  voucherId: number
  type: string
  docNo: string
  date: string
  gstin: string
  party: string | null
  taxable: number
}
export interface GstReco {
  month: string
  uploaded: boolean
  rows: { id: number; status: 'Matched' | 'Mismatch' | 'Not in books'; differences: string[]; portal: GstPortalDoc; books: GstBooksDoc | null; imsAction: 'Accepted' | 'Rejected' | 'Pending' }[]
  notOnPortal: GstBooksDoc[]
  summary: { matched: number; mismatched: number; notInBooks: number; notOnPortal: number; portalTax: Tax3; acceptedTax?: Tax3; pending?: number }
}
type AdvanceRow = TaxSum4 & { voucherId: number; docNo: string; date: string; party: string; bill: string; rate: number; unadjusted?: number; adjusted?: number }
export interface GstAdvances {
  received: AdvanceRow[]
  adjusted: AdvanceRow[]
  totals: { received: TaxSum4; adjusted: TaxSum4; net: TaxSum4 }
}
type HsnLine = TaxSum4 & { hsn: string; rate: number; uqc: string; qty: number }
export interface Gstr9 {
  gstin: string
  from: string
  to: string
  t4: { b2c: TaxSum4; b2b: TaxSum4; exportsWithTax: TaxSum4; advances: TaxSum4; creditNotes: TaxSum4; total: TaxSum4 }
  t5: { exportsWithoutTax: number; nilExempt: number; nonGst: number }
  t6: { inputs: Tax3; rcm: Tax3; reversed: Tax3; reclaimed: Tax3; availed: Tax3; net: Tax3 }
  t8: { as2b: Tax3; inputsAvailed: Tax3; difference: Tax3; uploaded2b: boolean }
  t9: { payable: Tax3; byItc: Tax3; cash: Tax3 }
  t17: HsnLine[]
  t18: HsnLine[]
  attention: number
}
export interface Cmp08 {
  quarter: number
  from: string
  to: string
  rate: number
  turnover: number
  outward: { cgst: number; sgst: number }
  rcm: Tax3
  payable: Tax3
}
export interface Gstr4 {
  from: string
  to: string
  t4a: (Tax3 & { gstin: string; party: string | null; taxable: number; rcm: boolean })[]
  t4b: (Tax3 & { gstin: string; party: string | null; taxable: number; rcm: boolean })[]
  t4c: TaxSum4
  t5: { quarter: number; turnover: number; cgst: number; sgst: number }[]
  t6: { rate: number; turnover: number; cgst: number; sgst: number }
}
export interface GstChallans {
  payments: (Tax3 & { voucherId: number; docNo: string; date: string; cess: number; total: number; challan: { cpin: string; cin: string | null; depositDate: string } | null })[]
  paid: Tax3
  due: Tax3
  difference: Tax3
  withoutChallan: number
}
export interface KeralaFloodCess {
  applicable: boolean
  reason?: string
  lines: { voucherId: number; date: string; docNo: string; party: string | null; gstRate: number; rate: number; taxable: number; cess: number }[]
  total: { taxable: number; cess: number }
}
export interface GatewayReco {
  gateway: string
  payments: { id: number; paymentId: string; date: string; amount: number; fee: number; tax: number; settlementId: string | null; settledOn: string | null; reference: string | null
    postedVoucherId: number | null; status: string; receipt: { voucherId: number; docNo: string; date: string; amount: number } | null }[]
  notInReport: { voucherId: number; docNo: string; date: string; amount: number; narration: string; party: string | null }[]
  settlements: { settlementId: string; settledOn: string | null; count: number; gross: number; fee: number; tax: number; net: number; postedVoucherId: number | null }[]
  summary: { matched: number; notInBooks: number; gross: number; fees: number }
}
export interface BatchRow {
  itemId: number
  item: string
  unit: string
  decimals: number
  godown: string
  batch: string
  qty: number
  mfgDate: string | null
  expiryDate: string | null
  firstIn: string | null
  daysLeft: number | null
}
export interface CostTrackRow {
  track: string
  sales: number
  costs: number
  margin: number
  goodsIn: number
  goodsOut: number
  vouchers: number
}
type Spot = { top: number; left: number }
export interface ChequeLayout {
  width: number
  height: number
  date: Spot
  payee: Spot
  words: Spot & { width: number }
  figures: Spot
  sign: Spot
  crossing: boolean
  dateBox: number
}
export interface AuditRow {
  voucherId: number
  type: string
  docNo: string
  date: string
  narration: string
  version: number
  amount: number
  createdBy: string | null
  createdAt: string | null
  alteredBy: string | null
  alteredAt: string | null
  alterations: number
  mark: { status: string; version: number; auditor: string; at: string; note: string } | null
  status: 'Not audited' | 'Audited' | 'Under Observation' | 'Altered after audit'
}
export interface TallyAudit extends Period {
  vouchers: AuditRow[]
  summary: { total: number; notAudited: number; audited: number; underObservation: number; alteredAfterAudit: number }
}
type PosMoney = { cash: number; bank: number; credit: number; total: number }
export interface PosRegister extends Period {
  vouchers: (PosMoney & { voucherId: number; voucherType: string; docNo: string; date: string; party: string | null })[]
  days: (PosMoney & { date: string; count: number })[]
  total: PosMoney & { count: number }
}
export interface OrderAnalysis extends Period {
  months: string[]
  rows: { key: string; unit: string | null; decimals: number; byMonth: Record<string, { qty: number; value: number }>; ordered: number; value: number; done: number; pending: number
    pendingValue: number; orders: number }[]
  total: { value: number; pendingValue: number; byMonth: Record<string, number> }
}
export interface AppConfig {
  voucherDate: 'today' | 'last'
  showBalances: boolean
  warnNegativeCash: boolean
  dayBookNarration: boolean
  lastVoucherDate?: string | null
}
export const CONFIG_DEFAULTS: AppConfig = { voucherDate: 'today', showBalances: true, warnNegativeCash: true, dayBookNarration: true }
export interface ImportResult {
  kind: 'ledgers' | 'stock-items' | 'vouchers'
  rows: number
  created: number
  failed: { row: number; label: string; errors: string[] }[]
}
export interface BudgetLineDef {
  kind: 'group' | 'ledger' | 'cost centre'
  targetId: number
  type: 'nett' | 'closing'
  amount: number
}
export interface BudgetDef {
  id: number
  name: string
  parentId: number | null
  from: string
  to: string
  lines: BudgetLineDef[]
}
export interface BudgetVariance {
  budget: { id: number; name: string; from: string; to: string }
  lines: (BudgetLineDef & { name: string; actual: number; variance: number })[]
}
export interface ScenarioDef {
  id: number
  name: string
  includeActuals: boolean
  include: ('Reversing Journal' | 'Optional' | 'Memorandum')[]
}
export interface ReversingJournals extends Period {
  vouchers: { id: number; date: string; docNo: string; applicableUpto: string; narration: string; effective: boolean; amount: number; particulars: string }[]
}
export interface CostMasters {
  categories: { id: number; name: string; isDefault: boolean }[]
  centres: { id: number; name: string; categoryId: number; parentId: number | null }[]
}
export interface CostSummary extends Period {
  categories: { id: number; name: string; lines: { id: number; name: string; parentId: number | null; depth: number; dr: number; cr: number }[]; total: { dr: number; cr: number } }[]
}
export interface CostBreakup extends Period {
  title: string
  lines: { id: number; name: string; category?: string; dr: number; cr: number }[]
  total: { dr: number; cr: number }
}
export interface PendingBill {
  ledgerId: number
  ledger: string
  name: string
  billDate: string
  dueDate: string
  pending: number // + Dr
  forex?: number | null // pending in the ledger's currency
  overdueDays: number
  bucket?: string
}
export interface LedgerOutstanding {
  ledger: { id: number; name: string }
  asOf: string
  bills: PendingBill[]
  onAccount: number
  closing: number
}
export interface BillsReport {
  asOf: string
  bills: PendingBill[]
  total: number
  overdue: number
  ageing: { bucket: string; amount: number }[]
}
export interface GroupOutstandings {
  group: { id: number; name: string }
  asOf: string
  ledgers: { id: number; name: string; closing: number; billed: number; overdue: number; onAccount: number }[]
  total: number
}
export interface Voucher {
  voucherTypeId?: number | null // one of the company's own voucher types
  voucherType?: string | null
  printTitle?: string | null // the voucher type's title on the printed document
  id: number
  type: VoucherType
  number: number
  docNo?: string // the number shown (a voucher type's series); else `number`
  date: string
  narration: string
  cancelled: boolean
  version: number
  entries: Entry[]
  inventory?: InventoryLine[]
  partyId?: number | null // orders and notes
  party?: string | null
  stockValue?: number | null // Day Book: what the items of an inventory voucher are worth
  postDated?: boolean
  optional?: boolean // kept, but out of the books (Optional and Memorandum vouchers)
  gstAdjustment?: 'itc-reversal' | 'itc-reclaim' | null // a Journal reversing or reclaiming input tax credit
  attendance?: { employeeId: number; employee?: string; typeId: number; value: number }[] // an Attendance voucher's lines
  additionalCost?: number // Manufacturing Journal / Material In: labour, power, job work charges
  applicableUpto?: string | null // a Reversing Journal: effective in scenarios up to this date
  refNo?: string | null // the supplier's invoice number
  refDate?: string | null
  advanceRate?: number | null // a Receipt in advance for services: its GST rate
  held?: boolean // post-dated and not yet due: out of the books until its date
  costTrack?: string | null
  shippingBill?: { port: string; no: string; date: string } | null // an export of goods
}
export interface ChequeLine {
  entryId: number
  voucherId: number
  type: VoucherType
  number: number
  docNo?: string // the number shown (a voucher type's series); else `number`
  date: string
  bankId: number
  bank: string
  party: string
  chequeNo: string | null
  chequeDate: string | null
  amount: number // - issued, + received
  bankDate: string | null
  status: 'cleared' | 'post-dated' | 'pending'
}
/** An item line on an invoice: qty in thousandths of the unit (+ in, - out), rate per unit and amount in paise. */
export interface InventoryLine {
  itemId: number
  item?: string
  godownId: number
  qty: number
  rate: number
  amount: number
  counted?: number | null // Physical Stock
  orderId?: number | null // the order this line fulfils
  trackingId?: number | null // the note this invoice line is billed against
  dueDate?: string | null // order lines
  against?: string | null // read back: "Sales Order No. 3"
  batch?: string | null // an item kept in batches
  mfgDate?: string | null
  expiryDate?: string | null
  role?: 'by-product' | 'scrap' | null // a Manufacturing Journal: made alongside the main product
  costShare?: number | null // a by-product's share of the cost, hundredths of a percent
}
export type PendingType = 'Sales Order' | 'Purchase Order' | 'Delivery Note' | 'Receipt Note'
/** An order or note's item with what is still to be delivered (or invoiced). Quantities in thousandths. */
export interface PendingLine {
  voucherId: number
  type: PendingType
  number: number
  docNo?: string // the number shown (a voucher type's series); else `number`
  date: string
  partyId: number | null
  party: string | null
  itemId: number
  item: string
  unit: string
  decimals: number
  godownId: number
  rate: number
  dueDate: string | null
  ordered: number
  done: number
  pending: number
  value: number
  overdueDays: number
}
export interface GodownSummary extends Period {
  godowns: { id: number; name: string; parentId: number | null; value: number; items: { id: number; name: string; unit: string; decimals: number; qty: number; rate: number; value: number }[] }[]
  total: number
}
export interface Period {
  from: string
  to: string
}

export interface LedgerBody {
  name: string
  groupId: number | null // null only for the primary Profit & Loss A/c
  opening: number
  gstin?: string | null
  state?: string | null
  billwise?: boolean
  creditDays?: number | null
  gstTaxType?: TaxType | null
  gstRate?: number | null // hundredths of a percent
  cessRate?: number | null // compensation cess, hundredths of a percent
  hsn?: string | null
  costCentres?: boolean
  interestRate?: number | null // hundredths of a percent a year
  interestOn?: 'balance' | 'bills'
  mailingName?: string | null
  address?: string | null
  pincode?: string | null
  country?: string | null
  phone?: string | null
  email?: string | null
  pan?: string | null
  reverseCharge?: boolean
  gstClassificationId?: number | null
  taxability?: Taxability
  tdsNatureId?: number | null
  deducteeType?: DeducteeType | null
  currencyId?: number | null
  openingForex?: number
}
export interface InterestStretch {
  from: string
  to: string
  days: number
  amount: number
  interest: number
  bill?: string
}
export interface LedgerInterest extends Period {
  id: number
  name: string
  rate: number
  on: 'balance' | 'bills'
  stretches: InterestStretch[]
  interest: number
}
export interface InterestSummary extends Period {
  title: string | null
  lines: { id: number; name: string; rate: number; on: 'balance' | 'bills'; interest: number }[]
  total: number
}

const q = (p: Period) => `?from=${p.from}&to=${p.to}`

export const api = {
  companies: () => call<Company[]>('GET', '/companies'),
  batches: (c: number, asOf: string, item?: number) => call<{ asOf: string; batches: BatchRow[] }>('GET', `/companies/${c}/reports/batches?asOf=${asOf}${item ? `&item=${item}` : ''}`),
  costTracks: (c: number, p: Period) => call<Period & { tracks: CostTrackRow[] }>('GET', `/companies/${c}/reports/cost-tracks${q(p)}`),
  chequeLayout: (c: number, ledgerId: number) => call<ChequeLayout | null>('GET', `/companies/${c}/ledgers/${ledgerId}/cheque-layout`),
  setChequeLayout: (c: number, ledgerId: number, layout: ChequeLayout | null) => call<void>('PUT', `/companies/${c}/ledgers/${ledgerId}/cheque-layout`, layout),
  tallyAudit: (c: number, p: Period) => call<TallyAudit>('GET', `/companies/${c}/reports/tally-audit${q(p)}`),
  setAudit: (c: number, items: { voucherId: number; status: 'Audited' | 'Under Observation' | null; note?: string }[]) => call<void>('PUT', `/companies/${c}/audit`, items),
  posRegister: (c: number, p: Period) => call<PosRegister>('GET', `/companies/${c}/reports/pos-register${q(p)}`),
  orderAnalysis: (c: number, type: 'Sales Order' | 'Purchase Order', p: Period, by: 'item' | 'party') =>
    call<OrderAnalysis>('GET', `/companies/${c}/reports/order-analysis${q(p)}&type=${encodeURIComponent(type)}&by=${by}`),
  config: (c: number) => call<AppConfig>('GET', `/companies/${c}/config`),
  setConfig: (c: number, cfg: Partial<AppConfig>) => call<AppConfig>('PUT', `/companies/${c}/config`, cfg),
  importSheet: (c: number, kind: ImportResult['kind'], file: string) => call<ImportResult>('POST', `/companies/${c}/import/${kind}`, { file }),
  splitCompany: (c: number, date: string) => call<{ first: { id: number; name: string }; second: { id: number; name: string } }>('POST', `/companies/${c}/split`, { date }),
  groupCompanies: () => call<{ id: number; name: string; members: { id: number; name: string }[] }[]>('GET', '/group-companies'),
  createGroupCompany: (g: { name: string; members: number[] }) => call<{ id: number }>('POST', '/group-companies', g),
  groupReport: (id: number, report: string, from: string, to: string) =>
    call<Record<string, unknown> & { name: string; members: { id: number; name: string }[] }>('GET', `/group-companies/${id}/reports/${report}?from=${from}&to=${to}`),
  me: (c: number) => call<{ secured: boolean; user: User | null }>('GET', `/companies/${c}/me`),
  login: (c: number, username: string, password: string) => call<{ token: string; user: User }>('POST', `/companies/${c}/login`, { username, password }),
  logout: (c: number) => call<void>('POST', `/companies/${c}/logout`),
  changePassword: (c: number, current: string, next: string) => call<void>('PUT', `/companies/${c}/me/password`, { current, next }),
  users: (c: number) => call<User[]>('GET', `/companies/${c}/users`),
  createUser: (c: number, body: { username: string; password: string; role: Role; levelId?: number | null }) => call<{ id: number }>('POST', `/companies/${c}/users`, body),
  alterUser: (c: number, id: number, body: { role: Role; password?: string | null; levelId?: number | null }) => call<void>('PUT', `/companies/${c}/users/${id}`, body),
  securityLevels: (c: number) => call<SecurityLevel[]>('GET', `/companies/${c}/users/levels`),
  createSecurityLevel: (c: number, b: Omit<SecurityLevel, 'id'>) => call<{ id: number }>('POST', `/companies/${c}/users/levels`, b),
  alterSecurityLevel: (c: number, id: number, b: Omit<SecurityLevel, 'id'>) => call<void>('PUT', `/companies/${c}/users/levels/${id}`, b),
  deleteSecurityLevel: (c: number, id: number) => call<void>('DELETE', `/companies/${c}/users/levels/${id}`),
  deleteUser: (c: number, id: number) => call<void>('DELETE', `/companies/${c}/users/${id}`),
  company: (c: number) =>
    call<Company & CompanyDetails & { gstin: string | null; state: string | null; gstType?: 'Regular' | 'Composition'; compositionRate?: number | null }>('GET', `/companies/${c}`),
  setCompanyDetails: (c: number, body: CompanyDetails) => call<void>('PUT', `/companies/${c}/details`, body),
  eDocuments: (c: number, p: Period) => call<EDocRegister>('GET', `/companies/${c}/e-documents${q(p)}`),
  eDocument: (c: number, voucherId: number) => call<EDocument>('GET', `/companies/${c}/vouchers/${voucherId}/e-document`),
  saveEDocument: (c: number, voucherId: number, body: Partial<EDocRecord>) => call<EDocRecord>('PUT', `/companies/${c}/vouchers/${voucherId}/e-document`, body),
  gspSettings: (c: number) => call<GspSettings | null>('GET', `/companies/${c}/gsp/settings`),
  setGspSettings: (c: number, b: GspSettingsInput) => call<void>('PUT', `/companies/${c}/gsp/settings`, b),
  gspTest: (c: number) => call<{ einvoice: string; eway: string }>('POST', `/companies/${c}/gsp/test`, {}),
  gspLog: (c: number) => call<{ id: number; at: string; system: string; action: string; ok: boolean; message: string; voucherId: number | null }[]>('GET', `/companies/${c}/gsp/log`),
  generateIrn: (c: number, id: number) => call<EDocRecord>('POST', `/companies/${c}/vouchers/${id}/irn`, {}),
  cancelIrn: (c: number, id: number, reason: string, remark: string) => call<EDocRecord>('POST', `/companies/${c}/vouchers/${id}/irn/cancel`, { reason, remark }),
  generateEwb: (c: number, id: number) => call<EDocRecord>('POST', `/companies/${c}/vouchers/${id}/ewb`, {}),
  cancelEwb: (c: number, id: number, reason: string, remark: string) => call<EDocRecord>('POST', `/companies/${c}/vouchers/${id}/ewb/cancel`, { reason, remark }),
  updateVehicle: (c: number, id: number, b: { vehicleNo: string; fromPlace: string; fromState: string; reason: string; remark: string }) =>
    call<EDocRecord>('POST', `/companies/${c}/vouchers/${id}/ewb/vehicle`, b),
  generateEDocs: (c: number, ids: number[], what: 'irn' | 'ewb') =>
    call<{ id: number; ok: boolean; errors?: string[] }[]>('POST', `/companies/${c}/e-documents/generate`, { ids, what }),
  eInvoiceFile: (c: number, ids: number[]) => call<unknown[]>('GET', `/companies/${c}/e-invoice.json?ids=${ids.join(',')}`),
  eWayBillFile: (c: number, ids: number[]) => call<unknown>('GET', `/companies/${c}/e-way-bill.json?ids=${ids.join(',')}`),
  mailSettings: (c: number) => call<MailSettings | null>('GET', `/companies/${c}/mail/settings`),
  setMailSettings: (c: number, body: Omit<MailSettings, 'hasPassword'> & { password?: string | null }) => call<void>('PUT', `/companies/${c}/mail/settings`, body),
  sendMail: (c: number, body: { to: string[]; cc?: string[]; subject: string; html: string; text?: string; voucherId?: number | null
    attachments?: { filename: string; content: string; contentType?: string }[] }) =>
    call<{ messageId: string; accepted: string[] }>('POST', `/companies/${c}/mail`, body),
  mailLog: (c: number) => call<MailLogRow[]>('GET', `/companies/${c}/mail/log`),
  setGst: (c: number, body: { gstin: string | null; state: string | null; gstType?: 'Regular' | 'Composition'; compositionRate?: number | null }) =>
    call<void>('PUT', `/companies/${c}/gst`, body),
  uploadPortal: (c: number, source: '2B' | 'GSTR-1', file: unknown) => call<{ month: string; count: number }>('POST', `/companies/${c}/gst/portal/${source === '2B' ? '2b' : 'gstr1'}`, file),
  gstr2bReco: (c: number, month: string, reg = 0) => call<GstReco>('GET', `/companies/${c}/reports/gstr2b-reconciliation?month=${month}&registration=${reg}`),
  gstr1Reco: (c: number, month: string, reg = 0) => call<GstReco>('GET', `/companies/${c}/reports/gstr1-reconciliation?month=${month}&registration=${reg}`),
  setIms: (c: number, items: { id: number; action: 'Accepted' | 'Rejected' | 'Pending' }[]) => call<void>('PUT', `/companies/${c}/gst/ims`, items),
  gstAdvances: (c: number, p: Period, reg = 0) => call<GstAdvances & Period>('GET', `/companies/${c}/reports/gst-advances${q(p)}&registration=${reg}`),
  gstr9: (c: number, fy: string, reg = 0) => call<Gstr9>('GET', `/companies/${c}/reports/gstr9?fy=${fy}&registration=${reg}`),
  cmp08: (c: number, fy: string, quarter: number) => call<Cmp08>('GET', `/companies/${c}/reports/cmp08?fy=${fy}&quarter=${quarter}`),
  gstr4: (c: number, fy: string) => call<Gstr4>('GET', `/companies/${c}/reports/gstr4?fy=${fy}`),
  gstChallans: (c: number, p: Period) => call<GstChallans & Period>('GET', `/companies/${c}/reports/gst-challans${q(p)}`),
  setGstChallans: (c: number, items: { voucherId: number; challan: { cpin: string; cin: string | null; depositDate: string } | null }[]) =>
    call<void>('PUT', `/companies/${c}/gst-challans`, items),
  gstParties: (c: number) => call<{ ledgerId: number; name: string; group: string; gstin: string | null; state: string | null; pan: string | null }[]>('GET', `/companies/${c}/gst-parties`),
  setGstParties: (c: number, items: { ledgerId: number; gstin: string | null; state: string | null }[]) => call<void>('PUT', `/companies/${c}/gst-parties`, items),
  gstContext: (c: number) =>
    call<{ companyGstin: string | null; companyState: string | null; ledgers: GstLedger[]; items: GstItem[] }>('GET', `/companies/${c}/gst-context`),
  gstr1: (c: number, p: Period, reg = 0) => call<Gstr1 & Period & { gstin: string; filed: boolean }>('GET', `/companies/${c}/reports/gstr1${q(p)}${reg ? `&registration=${reg}` : ''}`),
  setFiled: (c: number, month: string, filed: boolean) => call<void>(filed ? 'PUT' : 'DELETE', `/companies/${c}/gst/filings/${month}`),
  gstr3b: (c: number, p: Period, reg = 0, filedOn?: string) =>
    call<Gstr3b & Period & { gstin: string; late: Gstr3bLate }>('GET', `/companies/${c}/reports/gstr3b${q(p)}${reg ? `&registration=${reg}` : ''}${filedOn ? `&filedOn=${filedOn}` : ''}`),
  gstRegistrations: (c: number) => call<{ id: number; name: string; gstin: string | null; state: string | null; types: number }[]>('GET', `/companies/${c}/gst-registrations`),
  createGstRegistration: (c: number, r: { name: string; gstin: string }) => call<{ id: number }>('POST', `/companies/${c}/gst-registrations`, r),
  deleteGstRegistration: (c: number, id: number) => call<void>('DELETE', `/companies/${c}/gst-registrations/${id}`),
  keralaFloodCess: (c: number, p: Period) => call<KeralaFloodCess & Period>('GET', `/companies/${c}/reports/kerala-flood-cess${q(p)}`),
  gateways: (c: number) => call<{ gateway: string; payments: number }[]>('GET', `/companies/${c}/gateways`),
  uploadGatewayReport: (c: number, gateway: string, file: string) =>
    call<{ kept: number; failed: { row: number; errors: string[] }[] }>('POST', `/companies/${c}/gateways/${encodeURIComponent(gateway)}/report`, { file }),
  gatewayReco: (c: number, gateway: string, ledger: number, p: Period) =>
    call<GatewayReco & Period>('GET', `/companies/${c}/reports/gateway${q(p)}&gateway=${encodeURIComponent(gateway)}&ledger=${ledger}`),
  postSettlement: (c: number, gateway: string, settlement: string, b: { gatewayLedgerId: number; bankLedgerId: number; feeLedgerId: number; taxLedgerId?: number | null }) =>
    call<{ id: number }>('POST', `/companies/${c}/gateways/${encodeURIComponent(gateway)}/settlements/${encodeURIComponent(settlement)}/post`, b),
  /** the GSTR-1 file for the portal: fetched, then saved by the browser */
  gstr1File: async (c: number, p: Period, reg = 0) => {
    const res = await fetch(`/api/companies/${c}/reports/gstr1.json${q(p)}${reg ? `&registration=${reg}` : ''}`, { headers: authHeaders() })
    const data = await res.json().catch(() => ({ error: res.statusText }))
    if (!res.ok) throw new ApiError(data.error ?? res.statusText, data.errors ?? (data.error ? [data.error] : []))
    return data as { gstin: string; fp: string }
  },
  restore: async (file: ArrayBuffer) => {
    const res = await fetch('/api/companies/restore', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file })
    const data = await res.json().catch(() => ({ error: res.statusText }))
    if (!res.ok) throw new ApiError(data.error ?? res.statusText, data.errors ?? (data.error ? [data.error] : []))
    return data as Company
  },
  lastCompany: () => call<{ value: number | null }>('GET', '/settings/lastCompany').then((r) => r.value),
  setLastCompany: (id: number | null) => call<void>('PUT', '/settings/lastCompany', { value: id }),
  createCompany: (body: { name: string; booksBegin: string }) => call<Company>('POST', '/companies', body),
  groups: (c: number) => call<Group[]>('GET', `/companies/${c}/groups`),
  createGroup: (c: number, body: { name: string; parentId: number }) => call<{ id: number }>('POST', `/companies/${c}/groups`, body),
  ledgers: (c: number, p: Period) => call<Ledger[]>('GET', `/companies/${c}/ledgers${q(p)}`),
  alterGroup: (c: number, id: number, body: { name: string; parentId: number }) => call<void>('PUT', `/companies/${c}/groups/${id}`, body),
  deleteGroup: (c: number, id: number) => call<void>('DELETE', `/companies/${c}/groups/${id}`),
  createLedger: (c: number, body: LedgerBody) => call<{ id: number }>('POST', `/companies/${c}/ledgers`, body),
  ledger: (c: number, id: number) => call<LedgerBody & { id: number; isDefault: boolean; billwise: boolean; creditDays: number | null; openingBills: { name: string; billDate: string; dueDate: string | null; amount: number }[] }>('GET', `/companies/${c}/ledgers/${id}`),
  setOpeningBills: (c: number, id: number, bills: { name: string; billDate: string; dueDate?: string | null; amount: number }[]) =>
    call<void>('PUT', `/companies/${c}/ledgers/${id}/opening-bills`, bills),
  outstanding: (c: number, id: number, p: Period, excludeVoucher?: number) =>
    call<LedgerOutstanding>('GET', `/companies/${c}/ledgers/${id}/outstanding${q(p)}${excludeVoucher ? `&excludeVoucher=${excludeVoucher}` : ''}`),
  bills: (c: number, side: 'receivable' | 'payable', p: Period, overdue = false) =>
    call<BillsReport>('GET', `/companies/${c}/reports/bills${q(p)}&side=${side}${overdue ? '&overdue=1' : ''}`),
  groupOutstandings: (c: number, p: Period, groupId?: number) =>
    call<GroupOutstandings>('GET', `/companies/${c}/reports/group-outstandings${q(p)}${groupId ? `&groupId=${groupId}` : ''}`),
  nextNumber: (c: number, type: VoucherType) =>
    call<{ number: number }>('GET', `/companies/${c}/vouchers/next-number?type=${encodeURIComponent(type)}`).then((r) => r.number),
  alterLedger: (c: number, id: number, body: LedgerBody) => call<void>('PUT', `/companies/${c}/ledgers/${id}`, body),
  deleteLedger: (c: number, id: number) => call<void>('DELETE', `/companies/${c}/ledgers/${id}`),
  setStockValue: (c: number, body: { ledgerId: number; asOf: string; value: number }) =>
    call<void>('POST', `/companies/${c}/stock-values`, body),
  vouchers: (c: number, p: Period, type?: VoucherType) =>
    call<Voucher[]>('GET', `/companies/${c}/vouchers${q(p)}${type ? `&type=${encodeURIComponent(type)}` : ''}`),
  groupSummary: (c: number, p: Period, which: { groupId: number } | { cashBank: true }) =>
    call<GroupSummary>('GET', `/companies/${c}/reports/group-summary${q(p)}${'cashBank' in which ? '&cashBank=1' : `&groupId=${which.groupId}`}`),
  groupVouchers: (c: number, p: Period, groupId: number) => call<GroupVouchers>('GET', `/companies/${c}/reports/group-vouchers${q(p)}&groupId=${groupId}`),
  cashFlow: (c: number, p: Period) => call<CashFlow & Period>('GET', `/companies/${c}/reports/cash-flow${q(p)}`),
  fundsFlow: (c: number, p: Period) => call<FundsFlow & Period>('GET', `/companies/${c}/reports/funds-flow${q(p)}`),
  gstClassifications: (c: number) => call<GstClassification[]>('GET', `/companies/${c}/gst-classifications`),
  createGstClassification: (c: number, body: Omit<GstClassification, 'id' | 'used'>) => call<{ id: number }>('POST', `/companies/${c}/gst-classifications`, body),
  alterGstClassification: (c: number, id: number, body: Omit<GstClassification, 'id' | 'used'>) => call<void>('PUT', `/companies/${c}/gst-classifications/${id}`, body),
  deleteGstClassification: (c: number, id: number) => call<void>('DELETE', `/companies/${c}/gst-classifications/${id}`),
  voucherTypes: (c: number) => call<VoucherTypeDef[]>('GET', `/companies/${c}/voucher-types`),
  createVoucherType: (c: number, body: Omit<VoucherTypeDef, 'id' | 'used' | 'counters'>) => call<{ id: number }>('POST', `/companies/${c}/voucher-types`, body),
  alterVoucherType: (c: number, id: number, body: Omit<VoucherTypeDef, 'id' | 'used' | 'counters'>) => call<void>('PUT', `/companies/${c}/voucher-types/${id}`, body),
  features: (c: number) => call<{ features: Record<string, boolean>; labels: Record<string, string> }>('GET', `/companies/${c}/features`),
  setFeatures: (c: number, f: Record<string, boolean>) => call<void>('PUT', `/companies/${c}/features`, f),
  stockCategories: (c: number) => call<TreeNode[]>('GET', `/companies/${c}/stock-categories`),
  stockCategorySummary: (c: number, p: Period, categoryId?: number) =>
    call<StockCategorySummary>('GET', `/companies/${c}/reports/stock-category-summary${q(p)}${categoryId ? `&categoryId=${categoryId}` : ''}`),
  stockQuery: (c: number, p: Period, itemId: number) => call<StockQuery>('GET', `/companies/${c}/stock-items/${itemId}/query${q(p)}`),
  stockAgeing: (c: number, p: Period) => call<StockAgeing>('GET', `/companies/${c}/reports/stock-ageing${q(p)}`),
  movement: (c: number, p: Period) => call<Movement>('GET', `/companies/${c}/reports/movement${q(p)}`),
  itemMovement: (c: number, p: Period, itemId: number) => call<ItemMovement>('GET', `/companies/${c}/reports/movement${q(p)}&itemId=${itemId}`),
  reorder: (c: number, p: Period) => call<ReorderReport>('GET', `/companies/${c}/reports/reorder${q(p)}`),
  currencies: (c: number) => call<(Currency & { used: number })[]>('GET', `/companies/${c}/currencies`),
  createCurrency: (c: number, x: Omit<Currency, 'id'>) => call<{ id: number }>('POST', `/companies/${c}/currencies`, x),
  alterCurrency: (c: number, id: number, x: Omit<Currency, 'id'>) => call<void>('PUT', `/companies/${c}/currencies/${id}`, x),
  deleteCurrency: (c: number, id: number) => call<void>('DELETE', `/companies/${c}/currencies/${id}`),
  rates: (c: number, date: string) => call<(Currency & { rates: RatesOn | null })[]>('GET', `/companies/${c}/rates?date=${date}`),
  setRates: (c: number, date: string, rates: { currencyId: number; standard: number | null; selling: number | null; buying: number | null }[]) =>
    call<void>('PUT', `/companies/${c}/rates`, { date, rates }),
  forexGainLoss: (c: number, asOf: string) => call<ForexGainLoss>('GET', `/companies/${c}/reports/forex-gain-loss?asOf=${asOf}`),
  adjustForex: (c: number, date: string, ledgerId: number) => call<Voucher>('POST', `/companies/${c}/forex/adjust`, { date, ledgerId }),
  tdsSettings: (c: number) => call<TdsSettings>('GET', `/companies/${c}/tds`),
  setTdsSettings: (c: number, s: TdsSettings) => call<void>('PUT', `/companies/${c}/tds`, s),
  tdsNatures: (c: number) => call<(TdsNature & { used: number })[]>('GET', `/companies/${c}/tds-natures`),
  tdsPartyRates: (c: number) => call<TdsPartyRate[]>('GET', `/companies/${c}/tds/party-rates`),
  createTdsPartyRate: (c: number, b: { ledgerId: number; natureId: number | null; kind: 'certificate' | 'dtaa'; rate: number; certificateNo?: string | null; validFrom: string; validTo: string
    limit?: number | null }) => call<{ id: number }>('POST', `/companies/${c}/tds/party-rates`, b),
  deleteTdsPartyRate: (c: number, id: number) => call<void>('DELETE', `/companies/${c}/tds/party-rates/${id}`),
  createTdsNature: (c: number, n: Omit<TdsNature, 'id'>) => call<{ id: number }>('POST', `/companies/${c}/tds-natures`, n),
  alterTdsNature: (c: number, id: number, n: Omit<TdsNature, 'id'>) => call<void>('PUT', `/companies/${c}/tds-natures/${id}`, n),
  deleteTdsNature: (c: number, id: number) => call<void>('DELETE', `/companies/${c}/tds-natures/${id}`),
  tdsSuggest: (c: number, v: { id?: number; date: string; entries: { ledgerId: number; amount: number }[] }) =>
    call<TdsSuggestion[]>('POST', `/companies/${c}/tds/suggest`, v),
  tdsChallan: (c: number, voucherId: number) => call<TdsChallan | null>('GET', `/companies/${c}/vouchers/${voucherId}/tds-challan`),
  setTdsChallan: (c: number, voucherId: number, ch: TdsChallan | null) => call<void>('PUT', `/companies/${c}/vouchers/${voucherId}/tds-challan`, ch),
  tdsComputation: (c: number, p: Period, kind: TaxKind = 'TDS') => call<Period & { lines: TdsLine[] }>('GET', `/companies/${c}/reports/tds-computation${q(p)}&kind=${kind}`),
  tdsOutstandings: (c: number, p: Period, kind: TaxKind = 'TDS') => call<TdsOutstandings>('GET', `/companies/${c}/reports/tds-outstandings${q(p)}&kind=${kind}`),
  taxReturn: (c: number, form: ReturnForm, fy: string, quarter: number) => call<Form26Q>('GET', `/companies/${c}/reports/form-${form.toLowerCase()}?fy=${fy}&quarter=${quarter}`),
  challanReconciliation: (c: number, p: Period) => call<ChallanReconciliation>('GET', `/companies/${c}/reports/challan-reconciliation${q(p)}`),
  setTdsChallans: (c: number, items: { voucherId: number; challan: TdsChallan | null }[]) => call<void>('PUT', `/companies/${c}/tds-challans`, items),
  msmeParties: (c: number) => call<MsmeParty[]>('GET', `/companies/${c}/msme`),
  setMsme: (c: number, items: { ledgerId: number; msme: MsmeDetails | null }[]) => call<void>('PUT', `/companies/${c}/msme`, items),
  msmeForm1: (c: number, fy: string, half: number) => call<MsmeForm1>('GET', `/companies/${c}/reports/msme-form1?fy=${fy}&half=${half}`),
  msmeInterest: (c: number, asOf: string, bankRate: number) => call<MsmeInterest>('GET', `/companies/${c}/reports/msme-interest?asOf=${asOf}&bankRate=${bankRate}`),
  statistics: (c: number, p: Period) => call<Statistics>('GET', `/companies/${c}/reports/statistics${q(p)}`),
  dashboard: (c: number, p: Period) => call<Dashboard>('GET', `/companies/${c}/reports/dashboard${q(p)}`),
  ratios: (c: number, p: Period) => call<Ratios & Period>('GET', `/companies/${c}/reports/ratios${q(p)}`),
  register: (c: number, p: Period, type: VoucherType) =>
    call<Register>('GET', `/companies/${c}/reports/register${q(p)}&type=${encodeURIComponent(type)}`),
  reconciliation: (c: number, id: number, p: Period, all = false) =>
    call<Reconciliation>('GET', `/companies/${c}/ledgers/${id}/reconciliation${q(p)}${all ? '&all=1' : ''}`),
  setBankDates: (c: number, items: { entryId: number; bankDate: string | null }[]) => call<void>('PUT', `/companies/${c}/reconciliation`, items),
  importStatement: (c: number, id: number, p: Period, lines: { date: string; amount: number; description?: string }[]) =>
    call<{ matched: number; unmatched: { date: string; amount: number; description?: string }[] }>('POST', `/companies/${c}/ledgers/${id}/statement${q(p)}`, lines),
  editLog: (c: number) => call<EditLogRow[]>('GET', `/companies/${c}/edit-log`),
  editHistory: (c: number, entity: string, id: number) => call<EditLogVersion[]>('GET', `/companies/${c}/edit-log/${entity}/${id}`),
  ledgerMonthly: (c: number, id: number, p: Period) => call<LedgerMonthly>('GET', `/companies/${c}/ledgers/${id}/monthly${q(p)}`),
  payroll: (c: number) => call<PayrollMasters>('GET', `/companies/${c}/payroll`),
  createEmployeeGroup: (c: number, b: { name: string; categoryId?: number | null; parentId?: number | null }) => call<{ id: number }>('POST', `/companies/${c}/employee-groups`, b),
  alterEmployeeGroup: (c: number, id: number, b: { name: string; categoryId?: number | null; parentId?: number | null }) => call<void>('PUT', `/companies/${c}/employee-groups/${id}`, b),
  createEmployee: (c: number, b: Omit<EmployeeDef, 'id' | 'parentId' | 'categoryId'> & { groupId: number | null; categoryId: number | null }) => call<{ id: number }>('POST', `/companies/${c}/employees`, b),
  alterEmployee: (c: number, id: number, b: Omit<EmployeeDef, 'id' | 'parentId' | 'categoryId'> & { groupId: number | null; categoryId: number | null }) => call<void>('PUT', `/companies/${c}/employees/${id}`, b),
  deleteEmployee: (c: number, id: number) => call<void>('DELETE', `/companies/${c}/employees/${id}`),
  createAttendanceType: (c: number, b: Omit<AttendanceTypeDef, 'id'>) => call<{ id: number }>('POST', `/companies/${c}/attendance-types`, b),
  alterAttendanceType: (c: number, id: number, b: Omit<AttendanceTypeDef, 'id'>) => call<void>('PUT', `/companies/${c}/attendance-types/${id}`, b),
  deleteAttendanceType: (c: number, id: number) => call<void>('DELETE', `/companies/${c}/attendance-types/${id}`),
  createPayHead: (c: number, b: Omit<PayHeadDef, 'id'>) => call<{ id: number }>('POST', `/companies/${c}/pay-heads`, b),
  alterPayHead: (c: number, id: number, b: Omit<PayHeadDef, 'id'>) => call<void>('PUT', `/companies/${c}/pay-heads/${id}`, b),
  deletePayHead: (c: number, id: number) => call<void>('DELETE', `/companies/${c}/pay-heads/${id}`),
  setSalary: (c: number, id: number, effectiveFrom: string, lines: { payHeadId: number; rate: number | null }[]) =>
    call<void>('PUT', `/companies/${c}/salary/${id}`, { effectiveFrom, lines }),
  payrollFill: (c: number, b: { from: string; to: string; date: string; payableLedgerId: number; groupId?: number | null; voucherId?: number;
    values?: { employeeId: number; payHeadId: number; amount: number }[]; arrears?: { payHeadId: number; from: string; to: string } }) =>
    call<PayrollFill>('POST', `/companies/${c}/payroll/fill`, b),
  loans: (c: number, asOf?: string) => call<EmployeeLoan[]>('GET', `/companies/${c}/payroll/loans${asOf ? `?asOf=${asOf}` : ''}`),
  createLoan: (c: number, b: { employeeId: number; payHeadId: number; givenOn: string; amount: number; instalment: number; recoverFrom: string; note?: string }) =>
    call<{ id: number }>('POST', `/companies/${c}/payroll/loans`, b),
  deleteLoan: (c: number, id: number) => call<void>('DELETE', `/companies/${c}/payroll/loans/${id}`),
  declarations: (c: number, employeeId: number, fy: string) => call<TaxDeclarations | null>('GET', `/companies/${c}/employees/${employeeId}/declarations?fy=${fy}`),
  setDeclarations: (c: number, employeeId: number, fy: string, d: TaxDeclarations) => call<void>('PUT', `/companies/${c}/employees/${employeeId}/declarations?fy=${fy}`, d),
  payrollArrears: (c: number, p: Period, payHead?: number | null) =>
    call<PayrollArrears>('GET', `/companies/${c}/reports/payroll-arrears${q(p)}${payHead ? `&payHead=${payHead}` : ''}`),
  statutoryDues: (c: number, p: Period, kind: string) => call<StatutoryDues>('GET', `/companies/${c}/reports/statutory-dues${q(p)}&kind=${kind}`),
  paySheet: (c: number, p: Period, group?: number | null) => call<PaySheet>('GET', `/companies/${c}/reports/pay-sheet${q(p)}${group ? `&group=${group}` : ''}`),
  payslip: (c: number, id: number, p: Period) => call<Payslip>('GET', `/companies/${c}/reports/payslip/${id}${q(p)}`),
  attendanceSheet: (c: number, p: Period) =>
    call<{ columns: AttendanceTypeDef[]; rows: { employeeId: number; name: string; values: Record<number, number> }[] }>('GET', `/companies/${c}/reports/attendance-sheet${q(p)}`),
  payrollRegister: (c: number, p: Period) =>
    call<{ vouchers: { id: number; docNo: string; date: string; narration: string; cancelled: boolean; employees: number; earnings: number; deductions: number; employer: number; net: number }[] }>(
      'GET', `/companies/${c}/reports/payroll-register${q(p)}`),
  pfReport: (c: number, p: Period) => call<PfReport>('GET', `/companies/${c}/reports/pf${q(p)}`),
  esiReport: (c: number, p: Period) => call<EsiReport>('GET', `/companies/${c}/reports/esi${q(p)}`),
  ptReport: (c: number, p: Period) =>
    call<{ rows: { employeeId: number; name: string; month: string; gross: number; pt: number }[]; total: number }>('GET', `/companies/${c}/reports/professional-tax${q(p)}`),
  npsReport: (c: number, p: Period) =>
    call<{ rows: { employeeId: number; name: string; pran: string | null; employee: number; employer: number }[]; problems: string[] }>('GET', `/companies/${c}/reports/nps${q(p)}`),
  salaryTax: (c: number, fy: string, asOf: string) => call<SalaryTaxReport>('GET', `/companies/${c}/reports/salary-tax?fy=${fy}&asOf=${asOf}`),
  gratuity: (c: number, asOf: string) =>
    call<{ payHead: string | null; rows: { employeeId: number; name: string; joining: string; leaving: string | null; wages: number; years: number; eligible: boolean; amount: number; payable: number }[];
      total: number; provision: number }>('GET', `/companies/${c}/reports/gratuity?asOf=${asOf}`),
  voucher: (c: number, id: number) => call<Voucher>('GET', `/companies/${c}/vouchers/${id}`),
  postVoucher: (c: number, v: Omit<Voucher, 'id' | 'number' | 'cancelled' | 'version'>) =>
    call<Voucher>('POST', `/companies/${c}/vouchers`, v),
  alterVoucher: (c: number, id: number, v: Omit<Voucher, 'id' | 'number' | 'cancelled'>) =>
    call<Voucher>('PUT', `/companies/${c}/vouchers/${id}`, v),
  cancelVoucher: (c: number, id: number) => call<Voucher>('POST', `/companies/${c}/vouchers/${id}/cancel`),
  deleteVoucher: (c: number, id: number) => call<void>('DELETE', `/companies/${c}/vouchers/${id}`),
  statement: (c: number, ledgerId: number, p: Period) => call<Statement>('GET', `/companies/${c}/ledgers/${ledgerId}/statement${q(p)}`),
  units: (c: number) => call<Unit[]>('GET', `/companies/${c}/units`),
  stockGroups: (c: number) => call<TreeNode[]>('GET', `/companies/${c}/stock-groups`),
  godowns: (c: number) => call<(TreeNode & { isDefault: boolean; thirdParty: 'ours' | 'theirs' | null })[]>('GET', `/companies/${c}/godowns`),
  bom: (c: number, itemId: number, name?: string) => call<Bom | null>('GET', `/companies/${c}/stock-items/${itemId}/bom${name ? `?name=${encodeURIComponent(name)}` : ''}`),
  bomNames: (c: number, itemId: number) => call<string[]>('GET', `/companies/${c}/stock-items/${itemId}/boms`),
  setBom: (c: number, itemId: number, b: Bom) => call<void>('PUT', `/companies/${c}/stock-items/${itemId}/bom`, b),
  costEstimation: (c: number, itemId: number, qty: number, asOf: string) =>
    call<CostEstimation>('GET', `/companies/${c}/reports/cost-estimation?item=${itemId}&qty=${qty}&asOf=${asOf}`),
  jobWork: (c: number, asOf: string) => call<JobWorkReport>('GET', `/companies/${c}/reports/job-work?asOf=${asOf}`),
  stockItems: (c: number) => call<StockItem[]>('GET', `/companies/${c}/stock-items`),
  saveMaster: <B,>(c: number, kind: InventoryMaster, id: number | undefined, body: B) =>
    id ? call<void>('PUT', `/companies/${c}/${kind}/${id}`, body).then(() => ({ id })) : call<{ id: number }>('POST', `/companies/${c}/${kind}`, body),
  deleteMaster: (c: number, kind: InventoryMaster, id: number) => call<void>('DELETE', `/companies/${c}/${kind}/${id}`),
  stockSummary: (c: number, p: Period, groupId?: number) =>
    call<StockSummary>('GET', `/companies/${c}/reports/stock-summary${q(p)}${groupId ? `&groupId=${groupId}` : ''}`),
  stockItemVouchers: (c: number, id: number, p: Period) => call<StockItemVouchers>('GET', `/companies/${c}/stock-items/${id}/vouchers${q(p)}`),
  stockRates: (c: number, p: Period) => call<{ id: number; rate: number; closingQty: number }[]>('GET', `/companies/${c}/reports/stock-rates${q(p)}`),
  ledgerInterest: (c: number, id: number, p: Period) => call<LedgerInterest>('GET', `/companies/${c}/reports/interest/ledger/${id}${q(p)}`),
  bookInterest: (c: number, b: { ledgerId: number; from: string; to: string; interestLedgerId: number; date: string }) =>
    call<{ id: number; number: number }>('POST', `/companies/${c}/interest/book`, b),
  interestSummary: (c: number, p: Period, which: { side: 'receivable' | 'payable' } | { groupId: number }) =>
    call<InterestSummary>('GET', `/companies/${c}/reports/interest${q(p)}&${'side' in which ? `side=${which.side}` : `groupId=${which.groupId}`}`),
  cheques: (c: number, p: Period, bankId?: number) =>
    call<Period & { today: string; lines: ChequeLine[] }>('GET', `/companies/${c}/reports/cheques${q(p)}${bankId ? `&bankId=${bankId}` : ''}`),
  depositSlip: (c: number, bankId: number, p: Period) => call<Period & { lines: ChequeLine[]; total: number }>('GET', `/companies/${c}/ledgers/${bankId}/deposit-slip${q(p)}`),
  nextCheque: (c: number, bankId: number) => call<{ chequeNo: string | null }>('GET', `/companies/${c}/ledgers/${bankId}/next-cheque`).then((r) => r.chequeNo),
  postDated: (c: number) =>
    call<{ today: string; vouchers: { id: number; type: VoucherType; number: number; docNo?: string; date: string; narration: string; amount: number; entries: { ledger: string; amount: number }[] }[] }>(
      'GET', `/companies/${c}/reports/post-dated`),
  drafts: (c: number, kind: 'optional' | 'memorandum', p: Period) =>
    call<Period & { vouchers: { id: number; type: VoucherType; number: number; docNo?: string; date: string; narration: string; amount: number; entries: { ledger: string; amount: number }[] }[] }>(
      'GET', `/companies/${c}/reports/drafts${q(p)}&kind=${kind}`),
  cancelled: (c: number, p: Period) =>
    call<Period & { vouchers: { id: number; type: VoucherType; number: number; docNo?: string; date: string; narration: string; cancelledOn: string; by: string | null }[] }>(
      'GET', `/companies/${c}/reports/cancelled${q(p)}`),
  negativeLedgers: (c: number, p: Period) =>
    call<Period & { ledgers: { id: number; name: string; group: string; closing: number }[] }>('GET', `/companies/${c}/reports/negative-ledgers${q(p)}`),
  negativeStock: (c: number, p: Period) =>
    call<Period & { items: { id: number; name: string; unit: string; decimals: number; closingQty: number }[] }>('GET', `/companies/${c}/reports/negative-stock${q(p)}`),
  costMasters: (c: number) => call<CostMasters>('GET', `/companies/${c}/cost-masters`),
  saveCostMaster: (c: number, kind: 'cost-categories' | 'cost-centres', id: number | undefined, body: { name: string; categoryId?: number | null; parentId?: number | null }) =>
    id ? call<void>('PUT', `/companies/${c}/${kind}/${id}`, body).then(() => ({ id })) : call<{ id: number }>('POST', `/companies/${c}/${kind}`, body),
  deleteCostMaster: (c: number, kind: 'cost-categories' | 'cost-centres', id: number) => call<void>('DELETE', `/companies/${c}/${kind}/${id}`),
  costSummary: (c: number, p: Period) => call<CostSummary>('GET', `/companies/${c}/reports/cost-centres${q(p)}`),
  centreBreakup: (c: number, id: number, p: Period) =>
    call<{ centre: { id: number; name: string }; lines: CostBreakup['lines']; total: CostBreakup['total'] } & Period>('GET', `/companies/${c}/reports/cost-centres/${id}${q(p)}`),
  costBreakup: (c: number, which: { ledgerId: number } | { groupId: number }, p: Period) =>
    call<CostBreakup>('GET', `/companies/${c}/reports/cost-breakup${q(p)}&${'ledgerId' in which ? `ledgerId=${which.ledgerId}` : `groupId=${which.groupId}`}`),
  godownSummary: (c: number, p: Period) => call<GodownSummary>('GET', `/companies/${c}/reports/godown-summary${q(p)}`),
  pending: (c: number, type: PendingType, opts: { partyId?: number; asOf?: string; excludeVoucher?: number } = {}) =>
    call<{ type: PendingType; asOf: string; lines: PendingLine[] }>(
      'GET',
      `/companies/${c}/reports/pending?type=${encodeURIComponent(type)}${opts.partyId ? `&partyId=${opts.partyId}` : ''}${opts.asOf ? `&asOf=${opts.asOf}` : ''}${opts.excludeVoucher ? `&excludeVoucher=${opts.excludeVoucher}` : ''}`,
    ),
  report: <T,>(c: number, name: 'trial-balance' | 'profit-loss' | 'balance-sheet', p: Period, scenario?: number | null) =>
    call<T & { scenario?: string }>('GET', `/companies/${c}/reports/${name}${q(p)}${scenario ? `&scenario=${scenario}` : ''}`),
  budgets: (c: number) => call<{ id: number; name: string; parentId: number | null; parent: string | null; from: string; to: string; lines: number }[]>('GET', `/companies/${c}/budgets`),
  budget: (c: number, id: number) => call<BudgetDef>('GET', `/companies/${c}/budgets/${id}`),
  createBudget: (c: number, b: Omit<BudgetDef, 'id'>) => call<{ id: number }>('POST', `/companies/${c}/budgets`, b),
  alterBudget: (c: number, id: number, b: Omit<BudgetDef, 'id'>) => call<void>('PUT', `/companies/${c}/budgets/${id}`, b),
  deleteBudget: (c: number, id: number) => call<void>('DELETE', `/companies/${c}/budgets/${id}`),
  budgetVariance: (c: number, id: number, scenario?: number | null) =>
    call<BudgetVariance>('GET', `/companies/${c}/reports/budget-variance?budget=${id}${scenario ? `&scenario=${scenario}` : ''}`),
  scenarios: (c: number) => call<ScenarioDef[]>('GET', `/companies/${c}/scenarios`),
  createScenario: (c: number, s: Omit<ScenarioDef, 'id'>) => call<{ id: number }>('POST', `/companies/${c}/scenarios`, s),
  alterScenario: (c: number, id: number, s: Omit<ScenarioDef, 'id'>) => call<void>('PUT', `/companies/${c}/scenarios/${id}`, s),
  deleteScenario: (c: number, id: number) => call<void>('DELETE', `/companies/${c}/scenarios/${id}`),
  reversingJournals: (c: number, p: Period) => call<ReversingJournals>('GET', `/companies/${c}/reports/reversing-journals${q(p)}`),
}

export interface GroupSummary extends Period {
  title: string
  lines: { kind: 'group' | 'ledger' | 'stock'; id: number; name: string; opening: number; debit: number; credit: number; closing: number }[]
  total: { opening: number; debit: number; credit: number; closing: number }
}
export interface GroupVouchers extends Period {
  group: { id: number; name: string }
  opening: number
  closing: number
  lines: { voucherId: number; type: VoucherType; number: number; docNo?: string; date: string; ledger: string; amount: number; balance: number }[]
}
/** A stock item as the analysis reports name it: quantities in `unit`, a compound unit's first unit in `perUnit`. */
interface ItemRef {
  id: number
  name: string
  unit: string
  decimals: number
  perUnit?: string | null
  conversion?: number | null
}
export interface StockAgeing extends Period {
  labels: string[]
  lines: (ItemRef & { closingQty: number; closingValue: number; buckets: { label: string; qty: number; value: number }[] })[]
  totals: number[]
}
export interface Movement extends Period {
  items: (ItemRef & { inQty: number; inValue: number; inRate: number; outQty: number; outValue: number; outRate: number })[]
}
export interface ItemMovement extends Period {
  item: ItemRef
  inward: { party: string; qty: number; value: number; rate: number }[]
  outward: { party: string; qty: number; value: number; rate: number }[]
}
export interface ReorderReport extends Period {
  lines: (ItemRef & {
    closingQty: number; reorderLevel: number; minOrderQty: number | null; purchaseOrders: number; salesOrders: number
    available: number; shortfall: number; toOrder: number
  })[]
}
export interface Register extends Period {
  type: VoucherType
  months: { month: string; count: number; total: number }[]
}
export interface LedgerMonthly extends Period {
  ledger: { id: number; name: string }
  opening: number
  closing: number
  months: { month: string; debit: number; credit: number; closing: number }[]
}

export interface EditLogRow {
  id: number
  at: string
  actor: string
  entity: 'voucher' | 'ledger' | 'group' | 'company'
  entityId: number
  action: 'create' | 'alter' | 'cancel' | 'delete'
  label: string
  version: number | null
}
export interface EditLogVersion {
  id: number
  at: string
  actor: string
  action: EditLogRow['action']
  label: string
  data: Record<string, unknown>
}
export interface BankEntry {
  entryId: number
  voucherId: number
  type: VoucherType
  number: number
  docNo?: string // the number shown (a voucher type's series); else `number`
  date: string
  particulars: string
  narration: string
  amount: number
  bankDate: string | null
}
export interface Reconciliation {
  ledger: { id: number; name: string }
  asOf: string
  entries: BankEntry[]
  bookBalance: number
  notCredited: number
  notDebited: number
  bankBalance: number
}

export interface Statement {
  ledger: { id: number; name: string }
  opening: number
  closing: number
  lines: { voucherId: number; type: string; number: number; docNo?: string; voucherType?: string | null; date: string; narration: string; amount: number; balance: number; particulars: string
    forex?: number | null; forexRate?: number | null; forexBalance?: number }[]
  // a foreign-currency ledger
  currency?: { id: number; symbol: string; decimals: number }
  openingForex?: number
  closingForex?: number
}
export interface Currency {
  id: number
  symbol: string
  name: string
  decimals: number
  decimalName: string | null
}
export interface RatesOn {
  date: string
  standard: number | null
  selling: number | null
  buying: number | null
}
export interface ForexGainLoss {
  asOf: string
  ledgers: { ledgerId: number; ledger: string; currencyId: number; symbol: string; decimals: number; forex: number; book: number; rate: number | null; value: number | null
    difference: number; bills: { name: string; forex: number; book: number; value: number; difference: number; settled: boolean }[]; onAccount: number }[]
  total: number
  missingRates: string[]
}

export type InventoryMaster = 'units' | 'stock-groups' | 'godowns' | 'stock-items' | 'stock-categories'
export interface TdsSettings {
  tan: string | null
  deductorType: 'Government' | 'Others'
  responsible: string | null
}
export type ReturnForm = '26Q' | '27Q' | '27EQ'
export interface TdsSuggestion {
  natureId: number
  kind: TaxKind
  nature: string
  section: string
  partyId: number
  party: string
  amount: number
  assessable: number
  rate: number
  due: number
  ledgerId: number | null // the TDS ledger of the nature
  ledger: string | null
}
export interface TdsChallan {
  bsrCode: string
  challanNo: string
  challanDate: string
}
export interface TdsLine {
  voucherId: number
  kind: TaxKind
  collectionCode: string | null
  country: string | null
  type: VoucherType
  docNo: string
  date: string
  party: string
  pan: string | null
  deducteeType: DeducteeType
  nature: string
  section: string
  amount: number
  assessable: number
  rate: number
  due: number
  deducted: number
  short: number
  problems: string[]
}
export interface TdsPayment {
  voucherId: number
  kind: TaxKind
  date: string
  docNo: string
  natureId: number
  section: string
  amount: number
  challan: TdsChallan | null
}
export interface TdsOutstandings extends Period {
  natures: { natureId: number; nature: string; section: string; due: number; deducted: number; paid: number; payable: number }[]
  parties: TdsLine[]
  payments: TdsPayment[]
  unpaidChallans: number
}
export interface ChallanReconciliation extends Period {
  payments: (TdsPayment & { serial: number; allocated: number; unallocated: number; deductions: number })[]
  unmatched: number
}
export type MsmeType = 'Micro' | 'Small' | 'Medium'
export type MsmeActivity = 'Manufacturing' | 'Services' | 'Trading'
export interface MsmeDetails {
  type: MsmeType
  udyamNo: string | null
  activity: MsmeActivity
}
export interface MsmeParty {
  ledgerId: number
  name: string
  group: string
  pan: string | null
  type: MsmeType | null
  udyamNo: string | null
  activity: MsmeActivity | null
}
export interface MsmeForm1 {
  company: string
  fyStart: string
  half: number
  from: string
  to: string
  yearEnd: boolean
  lines: { ledgerId: number; supplier: string; pan: string | null; udyamNo: string | null; type: MsmeType; activity: MsmeActivity; bill: string; billDate: string; dueDate: string
    daysOverdue: number; amount: number }[]
  suppliers: { ledgerId: number; supplier: string; pan: string | null; udyamNo: string | null; type: MsmeType; amount: number; dueFrom: string; bills: number }[]
  total: number
  problems: string[]
}
export interface Form26Q extends ReturnSheetInput {
  title: string // Form 26Q, or from tax year 2026-27 Form 140 (and 27Q: 144, 27EQ: 143)
  deductor: { name: string; tan: string | null; type: string; responsible: string | null; address: string | null }
  fyStart: string
  quarter: number
  from: string
  to: string
  deductions: { deducteeCode: string; pan: string; name: string; section: string; collectionCode: string | null; country: string | null; date: string; amount: number; tds: number
    rate: number; docNo: string; voucherId: number
    challan: { serial: number; bsrCode: string | null; challanNo: string | null; challanDate: string } | null }[]
  challans: (TdsPayment & { serial: number })[]
  total: { amount: number; tds: number }
  problems: string[]
}
export interface Statistics extends Period {
  vouchers: { type: VoucherType; voucherTypeId: number | null; name: string; count: number; cancelled: number; optional: number }[]
  total: number
  masters: { name: string; count: number }[]
}
export interface Dashboard extends Period {
  cash: number
  bank: number
  receivables: number
  payables: number
  sales: number
  purchases: number
  grossProfit: number
  netProfit: number
  closingStock: number
  vouchers: number
  months: { month: string; sales: number; purchases: number }[]
  topDebtors: { id: number; name: string; amount: number }[]
  topCreditors: { id: number; name: string; amount: number }[]
}
/** An HSN/SAC with its rate and taxability, picked on stock items and ledgers. */
export interface GstClassification {
  id: number
  name: string
  hsn: string | null
  description: string | null
  taxability: Taxability
  gstRate: number | null
  used: number
}
export interface VoucherTypeDef {
  id: number
  name: string
  baseType: VoucherType
  abbreviation: string
  numbering: 'auto' | 'manual'
  prefix: string
  suffix: string
  width: number
  startNumber: number
  restartYearly: boolean
  printTitle: string | null
  active: boolean
  pos?: boolean
  gstRegistrationId?: number | null
  used: number
  /** The last number given, by the start of the year it counts in (1900-01-01 when it never restarts). */
  counters?: Record<string, number> | null
}
export interface StockCategorySummary extends Period {
  category: { id: number; name: string } | null
  lines: { kind: 'category' | 'item'; id: number; name: string; unit?: string; decimals?: number; closingQty?: number; openingValue: number; inValue: number; outValue: number; closingValue: number }[]
  total: { openingValue: number; inValue: number; outValue: number; closingValue: number }
}
interface StockMove {
  voucherId: number
  type: VoucherType
  docNo: string
  date: string
  qty: number | string
  rate: number | string
  party: string
}
export interface StockQuery extends Period {
  item: { id: number; name: string; unit: string; decimals: number; perUnit: string | null; conversion: number | null; closingQty: number; closingValue: number; rate: number }
  hsn: string | null
  gstRate: number | null
  group: string | null
  category: string | null
  reorderLevel: number | null
  godowns: { godown: string; qty: number | string }[]
  purchases: StockMove[]
  sales: StockMove[]
  purchaseOrders: number
  salesOrders: number
}
export interface CompanyDetails {
  mailingName: string | null
  address: string | null
  pincode: string | null
  phone: string | null
  email: string | null
}
export interface Transport {
  mode: '1' | '2' | '3' | '4'
  distance: number
  transporterId?: string | null
  transporterName?: string | null
  vehicleNo?: string | null
  vehicleType?: 'R' | 'O'
  docNo?: string | null
  docDate?: string | null
}
export interface EDocRecord {
  irn: string | null
  ackNo: string | null
  ackDate: string | null
  signedQr: string | null
  irnCancelled: boolean
  ewbNo: string | null
  ewbDate: string | null
  ewbValidUpto: string | null
  transport: Transport | null
}
export interface EDocStatus {
  einvoice: { needed: boolean; problems: string[]; irn: string | null; cancelled: boolean }
  eway: { needed: boolean; problems: string[]; ewbNo: string | null }
}
export interface EDocRegister extends Period {
  vouchers: (EDocStatus & { voucherId: number; type: VoucherType; number: string; date: string; party: string; value: number })[]
}
export interface EDocument extends EDocStatus {
  input: { type: VoucherType; number: string; date: string; seller: { legalName: string; gstin: string | null }; buyer: { legalName: string; gstin: string | null; email?: string | null }; invoiceValue: number }
  record: EDocRecord | null
  einvoiceJson: unknown | null
  ewayJson: unknown | null
}
export interface MailSettings {
  host: string
  port: number
  secure: boolean
  username: string | null
  fromAddress: string
  fromName: string | null
  hasPassword: boolean
}
export interface MailLogRow {
  id: number
  at: string
  recipient: string
  subject: string
  error: string | null
  voucherId: number | null
  voucher: string | null
}
export interface Unit {
  id: number
  symbol: string
  name: string
  decimals: number
  uqc: string | null
  firstUnitId: number | null // a compound unit ("Box of 12 Nos"): Box, 12, Nos
  conversion: number | null
  secondUnitId: number | null
}
export interface TreeNode {
  id: number
  name: string
  parentId: number | null
}
export interface StockItem {
  id: number
  name: string
  groupId: number | null
  group: string | null
  unitId: number
  unit: string
  decimals: number
  openingQty: number
  openingValue: number
  openingGodownId: number | null
  hsn: string | null
  gstRate: number | null
  cessRate?: number | null
  reorderLevel: number | null
  minOrderQty: number | null
  categoryId: number | null
  gstClassificationId?: number | null
  taxability?: Taxability
  perUnit: string | null // in a compound unit, its first unit (quantities are in `unit`, the second)
  conversion: number | null
  batches?: boolean // kept in batches
}
export interface StockLine {
  kind: 'group' | 'item'
  id: number
  name: string
  unit?: string
  decimals?: number
  openingQty?: number
  openingValue: number
  inQty?: number
  inValue: number
  outQty?: number
  outValue: number
  closingQty?: number
  closingValue: number
  rate?: number
  godowns?: { godown: string; qty: number }[]
  perUnit?: string | null // compound unit (items only)
  conversion?: number | null
}
export interface StockSummary extends Period {
  group: TreeNode | null
  lines: StockLine[]
  total: { openingValue: number; inValue: number; outValue: number; closingValue: number }
  negative: string[]
}
export interface StockItemVouchers extends Period {
  item: { id: number; name: string; unit: string; decimals: number; perUnit: string | null; conversion: number | null }
  position: StockLine & { openingQty: number; inQty: number; outQty: number; closingQty: number; rate: number }
  lines: { voucherId: number; type: VoucherType; number: number; docNo?: string; date: string; godown: string; qty: number; rate: number; amount: number; party: string; balance: number }[]
}

// ------------------------------------------------------------------ payroll

export type PayType = (typeof import('../server/src/engine/payroll').PAY_TYPES)[number]
export type Statutory = keyof typeof import('../server/src/engine/payroll').STATUTORY
export interface PaySlab {
  upTo: number | null
  rate: number
  value: number
}
export interface PayHeadDef {
  id: number
  name: string
  groupId: number
  payType: PayType
  statutory: Statutory | null
  calculation: 'user' | 'flat' | 'attendance' | 'production' | 'computed'
  attendanceTypeId: number | null
  perDayDays: number | null
  formula: { payHeadId: number; sign: 1 | -1 }[]
  ceiling: number | null
  slabs: PaySlab[]
  rounding: 'normal' | 'up' | 'down' | 'none'
  roundTo: number
  expenseLedgerId: number | null
  taxComponent?: 'basic' | 'hra' | null // Basic and HRA, for the old regime's HRA exemption
}
export interface EmployeeDef {
  id: number
  name: string
  categoryId: number
  parentId: number | null
  number?: string | null
  designation?: string | null
  department?: string | null
  location?: string | null
  gender?: 'Male' | 'Female' | 'Other' | null
  dateOfBirth?: string | null
  dateOfJoining: string
  dateOfLeaving?: string | null
  pan?: string | null
  uan?: string | null
  pfNumber?: string | null
  esiNumber?: string | null
  pran?: string | null
  bankName?: string | null
  accountNo?: string | null
  ifsc?: string | null
  taxRegime?: 'new' | 'old'
}
export interface AttendanceTypeDef {
  id: number
  name: string
  kind: 'attendance' | 'leave with pay' | 'leave without pay' | 'production'
  unit: string
}
export interface PayrollMasters {
  categories: { id: number; name: string }[]
  groups: { id: number; name: string; categoryId: number; parentId: number | null }[]
  employees: EmployeeDef[]
  attendanceTypes: AttendanceTypeDef[]
  payHeads: PayHeadDef[]
  salary: { centreId: number; effectiveFrom: string; lines: { payHeadId: number; rate: number | null }[] }[]
}
export interface PayrollFill {
  employees: { id: number; name: string; lines: { payHeadId: number; amount: number }[]; earnings: number; deductions: number; employer: number; net: number;
    payableDays: number; onRolls: number; errors: string[] }[]
  entries: Entry[]
  heads: { id: number; name: string; payType: PayType }[]
}
export interface PaySheet {
  from: string
  to: string
  columns: { id: number; name: string; payType: PayType; side: 'earning' | 'deduction' | 'employer'; statutory: Statutory | null }[]
  rows: { employeeId: number; name: string; number: string | null; amounts: Record<number, number>; earnings: number; deductions: number; employer: number; net: number }[]
  totals: Record<number, number>
  earnings: number
  deductions: number
  employer: number
  net: number
}
type PayLine = PaySheet['columns'][number] & { amount: number }
export interface Payslip {
  company: string
  employee: EmployeeDef
  group: string | null
  from: string
  to: string
  attendance: { name: string; unit: string; value: number }[]
  earnings: PayLine[]
  deductions: PayLine[]
  employer: PayLine[]
  totalEarnings: number
  totalDeductions: number
  net: number
}
export interface PfReport {
  from: string
  to: string
  rows: { employeeId: number; name: string; uan: string | null; gross: number; epfWages: number; epsWages: number; edliWages: number; epf: number; eps: number;
    epfEmployer: number; edli: number; admin: number; ncpDays: number }[]
  ecr: string
  problems: string[]
  totals: { epfWages: number; epf: number; eps: number; epfEmployer: number; edli: number; admin: number }
}
export interface EsiReport {
  rows: { employeeId: number; name: string; ipNumber: string | null; days: number; wages: number; employee: number; employer: number }[]
  problems: string[]
  totals: { wages: number; employee: number; employer: number }
}
export interface SalaryTaxReport {
  fyStart: string
  asOf: string
  rows: { employeeId: number; name: string; pan: string | null; regime: 'new' | 'old'; months: { month: string; date: string; taxable: number; tax: number }[];
    taxable: number; projected: number; standardDeduction: number; taxableIncome: number; tax: number; deducted: number; balance: number }[]
  problems: string[]
}

// ------------------------------------------------------------------ manufacturing and job work

export interface Bom {
  name?: string
  makesQty: number
  components: { itemId: number; qty: number }[]
  byProducts?: { itemId: number; qty: number; costShare: number | null }[] // costShare: hundredths of a percent of the cost
  scrap?: { itemId: number; qty: number }[]
}
export interface CostEstimation {
  item: string
  unit: string
  qty: number
  asOf: string
  lines: { level: number; itemId: number; item: string; unit: string; qty: number; rate: number; amount: number; made: boolean }[]
  total: number
  perUnit: number
  currentRate: number
}
type ThirdPartyStock = { godownId: number; godown: string; thirdParty: 'ours' | 'theirs'; itemId: number; item: string; unit: string; qty: number; value: number | null }
export interface JobWorkReport {
  asOf: string
  outOrders: PendingLine[]
  inOrders: PendingLine[]
  withJobWorkers: ThirdPartyStock[]
  withUs: ThirdPartyStock[]
}

/** A loan or advance to an employee, recovered through a Loans and Advances pay head. */
export interface EmployeeLoan {
  id: number
  employeeId: number
  employee: string
  payHeadId: number
  payHead: string
  givenOn: string
  amount: number
  instalment: number
  recoverFrom: string
  note: string
  recovered: number
  outstanding: number
}
/** The old regime's declarations of an employee for a year (paise). */
export interface TaxDeclarations {
  rentPaid: number
  metro: boolean
  sec80c: number
  sec80d: number
  sec80ccd1b: number
  sec24b: number
  other: number
}
export interface PayrollArrears {
  rows: { id: number; name: string; month: string; paid: number; due: number; arrears: number }[]
  employees: { id: number; name: string; due: number; paid: number; total: number }[]
  total: number
}
export interface StatutoryDues {
  kind: string
  dueDate: string
  lines: { ledgerId: number; name: string; statutory: string; booked: number; paid: number; due: number }[]
  total: number
  challan?: { ac1: number; ac2: number; ac10: number; ac21: number; ac22: number }
}

/** A party's own TDS rate: a section 197 certificate or a treaty (DTAA) rate. */
export interface TdsPartyRate {
  id: number
  ledgerId: number
  party: string
  natureId: number | null
  nature: string | null
  kind: 'certificate' | 'dtaa'
  rate: number
  certificateNo: string | null
  validFrom: string
  validTo: string
  limit: number | null
}
export interface MsmeInterest {
  asOf: string
  bankRate: number
  rate: number
  lines: { ledgerId: number; supplier: string; udyamNo: string | null; bill: string; billDate: string; dueDate: string; amount: number; unpaid: number; paidOn: string | null
    daysLate: number; interest: number }[]
  total: number
}

/** Access to the e-Invoice and e-Way Bill APIs (directly with NIC, or through a GSP). Secrets are only ever sent, never shown. */
export interface GspSettingsInput {
  environment: 'sandbox' | 'production'
  einvoiceBase: string
  ewayBase: string
  clientId: string
  clientSecret?: string
  einvoiceUser: string
  einvoicePassword?: string
  ewayUser?: string | null
  ewayPassword?: string | null
  publicKey: string
  ewayPublicKey?: string | null
  extraHeaders?: Record<string, string>
}
export type GspSettings = Omit<GspSettingsInput, 'clientSecret' | 'einvoicePassword' | 'ewayPassword'> & {
  clientSecretSet: boolean
  einvoicePasswordSet: boolean
  ewayPasswordSet: boolean
}
