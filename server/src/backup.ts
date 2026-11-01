/**
 * Company backup and restore. A backup is one gzip-compressed JSON document that refers to
 * groups and ledgers by name (not database id), so it restores into any Spectral Tally
 * database: the PostgreSQL server or a desktop app's PGlite folder.
 *
 * Restoring runs in one transaction and goes through the same database rules as everyday
 * posting (balanced vouchers, bills adding up, ...), so a damaged or edited file cannot load
 * inconsistent books. The company's Edit Log travels with it.
 */
import { gunzipSync, gzipSync } from 'node:zlib'
import { pool, withTx, type Tx } from './db'
import { ValidationError } from './books'

export const BACKUP_FORMAT = 'spectral-tally-backup'
export const BACKUP_VERSION = 24 // 2 inventory, 3 GST, 4 users, 5 orders/notes/stock journals, 6 cost centres and interest, 7 cheques and post-dating, 8 mailing details and optional/memorandum vouchers, 9 reverse charge, GST adjustments and filed months, 10 reorder levels, 11 company mailing details, UQC, e-documents and mail settings, 12 voucher types, features, stock categories, 13 GST classifications and taxability, 14 TDS, 15 currencies and foreign amounts, 16 payroll, 17 bills of materials, third-party godowns, additional costs, 18 TCS natures and MSME details, 19 budgets, scenarios and reversing journals, 20 supplier invoice numbers, advances, composition, GST portal documents and challans, 21 POS voucher types and audit marks, 22 held post-dated vouchers, cost tracks, batches and cheque layouts, 23 further GST registrations and gateway payments, 24 cess rates, several bills of materials, by-products and scrap, loans, tax declarations, TDS party rates, security levels; older files still restore

interface Backup {
  format: typeof BACKUP_FORMAT
  version: number
  createdAt: string
  company: {
    name: string; booksBegin: string; fyStart: string; state: string | null; gstin: string | null
    mailingName?: string | null; address?: string | null; pincode?: string | null; phone?: string | null; email?: string | null // version 11
    features?: Record<string, boolean> // version 12
    tan?: string | null; tdsDeductorType?: string; tdsResponsible?: string | null // version 14
    gstType?: string; compositionRate?: number | null // version 20
  }
  groups: { name: string; parent: string | null; nature: string; affectsGrossProfit: boolean; isDefault: boolean }[]
  ledgers: {
    name: string; group: string | null; opening: number; gstin: string | null; state: string | null
    billwise: boolean; creditDays: number | null; isDefault: boolean
    gstTaxType?: string | null; gstRate?: number | null; hsn?: string | null // version 3
    costCentres?: boolean // version 6
    interestRate?: number | null; interestOn?: string // version 6
    mailingName?: string | null; address?: string | null; pincode?: string | null; country?: string | null
    phone?: string | null; email?: string | null; pan?: string | null // version 8
    reverseCharge?: boolean // version 9
    gstClassification?: string | null; taxability?: string | null // version 13
    tdsNature?: string | null; deducteeType?: string | null // version 14
    currency?: string | null; openingForex?: number // version 15: the currency's symbol
    cessRate?: number | null // version 24
  }[]
  currencies?: { symbol: string; name: string; decimals: number; decimalName: string | null
    rates: { date: string; standard: number | null; selling: number | null; buying: number | null }[] | null }[] // version 15
  tdsNatures?: { name: string; section: string; rateIndividual: number; rateOther: number; rateNoPan: number; thresholdSingle: number | null
    thresholdAnnual: number | null; excessOnly: boolean; kind?: string; collectionCode?: string | null }[] // version 14; 18: kind, collectionCode
  msme?: { ledger: string; type: string; udyamNo: string | null; activity: string }[] // version 18
  budgets?: { name: string; parent: string | null; from: string; to: string; lines: { kind: string; target: string; type: string; amount: number }[] }[] // version 19
  scenarios?: { name: string; includeActuals: boolean; include: string[] }[] // version 19
  gstPortalDocs?: { source: string; month: string; gstin: string; party: string | null; docType: string; docNo: string; docDate: string; pos: string | null; rcm: boolean
    taxable: number; igst: number; cgst: number; sgst: number; cess: number; value: number; imsAction: string; registration?: string | null }[] // version 20
  gstChallans?: { voucher: string; cpin: string; cin: string | null; depositDate: string }[] // version 20
  tdsChallans?: { voucher: string; bsrCode: string; challanNo: string; challanDate: string }[] // version 14
  gstClassifications?: { name: string; hsn: string | null; description: string | null; taxability: string; gstRate: number | null }[] // version 13
  gstFilings?: { month: string; filedAt: string }[] // version 9
  eDocuments?: { voucher: string; irn: string | null; ackNo: string | null; ackDate: string | null; signedQr: string | null; irnCancelled: boolean
    ewbNo: string | null; ewbDate: string | null; ewbValidUpto: string | null; transport: unknown }[] // version 11
  voucherTypes?: { name: string; baseType: string; abbreviation: string; numbering: string; prefix: string; suffix: string; width: number; startNumber: number
    restartYearly: boolean; printTitle: string | null; active: boolean; counters: { fyStart: string; last: number }[] | null; pos?: boolean
    gstRegistration?: string | null }[] // version 12; 21: pos; 23: gstRegistration
  auditMarks?: { voucher: string; status: string; version: number; auditor: string; at: string; note: string }[] // version 21
  chequeLayouts?: { ledger: string; layout: unknown }[] // version 22
  gstRegistrations?: { name: string; gstin: string; state: string }[] // version 23
  gatewayPayments?: { gateway: string; paymentId: string; date: string; amount: number; fee: number; tax: number; settlementId: string | null; settledOn: string | null
    reference: string | null; postedVoucher: string | null }[] // version 23
  stockCategories?: { name: string; parent: string | null }[] // version 12
  mail?: { host: string; port: number; secure: boolean; username: string | null; fromAddress: string; fromName: string | null } | null // version 11; never the password
  costCategories?: { name: string; isDefault: boolean }[] // version 6
  costCentres?: { name: string; category: string; parent: string | null; kind?: string }[] // version 6, parents first; 16: employee (group)
  employees?: ({ name: string } & Record<string, unknown>)[] // version 16: an employee's details, by cost centre name
  attendanceTypes?: { name: string; kind: string; unit: string }[] // version 16
  payHeads?: { ledger: string; payType: string; statutory: string | null; calculation: string; attendanceType: string | null; perDayDays: number | null;
    formula: { payHead: string; sign: number }[]; ceiling: number | null; slabs: unknown; rounding: string; roundTo: number; expenseLedger: string | null
    taxComponent?: string | null }[] // version 16; 24 the tax component
  salary?: { centre: string; effectiveFrom: string; lines: { payHead: string; rate: number | null }[] }[] // version 16
  attendance?: { voucher: string; employee: string; type: string; value: number }[] // version 16
  openingBills: { ledger: string; name: string; billDate: string; dueDate: string | null; amount: number }[]
  stockValues: { ledger: string; asOf: string; value: number }[]
  vouchers: {
    type: string; number: number; date: string; narration: string; cancelled: boolean; version: number
    gst?: unknown // version 3: the GST breakup as posted
    party?: string | null // version 5: the party of an order or note
    postDated?: boolean // version 7
    optional?: boolean; draft?: NamedDraft | null // version 8: an optional or memorandum voucher's lines, by name
    gstAdjustment?: string | null // version 9
    voucherType?: string | null; docNo?: string | null // version 12
    additionalCost?: number // version 17
    applicableUpto?: string | null // version 19
    refNo?: string | null; refDate?: string | null; advanceRate?: number | null // version 20
    held?: boolean; costTrack?: string | null // version 22
    entries: {
      ledger: string; amount: number; bankDate: string | null; bills: { type: string; name: string | null; dueDate: string | null; amount: number; forex?: number | null }[] | null
      costs?: { centre: string; amount: number }[] | null // version 6
      chequeNo?: string | null; chequeDate?: string | null // version 7
      forex?: number | null; forexRate?: number | null // version 15; bills carry their share as forex too
    }[]
  }[]
  counters: { type: string; last: number }[]
  users?: { username: string; passwordHash: string; role: string; level?: string | null }[] // version 4: security travels with the company; 24 its level
  securityLevels?: { name: string; baseRole: string; deniedVouchers: string[]; deniedReports: string[]; backDays: number | null }[] // version 24
  loans?: { employee: string; payHead: string; givenOn: string; amount: number; instalment: number; recoverFrom: string; note: string }[] // version 24
  declarations?: { employee: string; fyStart: string; rentPaid: number; metro: boolean; sec80c: number; sec80d: number; sec80ccd1b: number; sec24b: number; other: number }[] // version 24
  tdsPartyRates?: { party: string; nature: string | null; kind: string; rate: number; certificateNo: string | null; validFrom: string; validTo: string; limit: number | null }[] // version 24
  // version 2: inventory (absent in version 1 files)
  units?: { symbol: string; name: string; decimals: number; first?: string | null; second?: string | null; conversion?: number | null; uqc?: string | null }[] // version 8: compound parts; 11: UQC
  stockGroups?: { name: string; parent: string | null }[]
  godowns?: { name: string; parent: string | null; isDefault: boolean; thirdParty?: string | null }[] // 17: thirdParty
  boms?: { item: string; makesQty: number; components: { item: string; qty: number }[]
    name?: string; byProducts?: { item: string; qty: number; costShare: number | null }[]; scrap?: { item: string; qty: number }[] }[] // version 17; 24 names, by-products, scrap
  stockItems?: {
    name: string; group: string | null; unit: string; openingQty: number; openingValue: number; openingGodown: string | null
    hsn?: string | null; gstRate?: number | null // version 3
    reorderLevel?: number | null; minOrderQty?: number | null // version 10
    category?: string | null // version 12
    gstClassification?: string | null; taxability?: string | null // version 13
    batches?: boolean // version 22
    cessRate?: number | null // version 24
  }[]
  inventory?: {
    voucher: string; item: string; godown: string; qty: number; rate: number; amount: number // voucher = "type#number"
    movesStock?: boolean; counted?: number | null; order?: string | null; tracking?: string | null; dueDate?: string | null // version 5
    batch?: string | null; mfgDate?: string | null; expiryDate?: string | null // version 22
    role?: string | null; costShare?: number | null // version 24
  }[]
  editLog: { at: string; actor: string; entity: string; entityId: number; action: string; label: string; data: unknown }[]
}

/** A draft's lines with names in place of ids, so it restores into a company with new ids. */
interface NamedDraft {
  party?: string | null
  entries: { ledger: string; amount: number; bills?: unknown; chequeNo?: string | null; chequeDate?: string | null; costs?: { centre: string; amount: number }[] }[]
  inventory?: { item: string; godown: string; qty: number; rate: number; amount: number; counted?: number | null; dueDate?: string | null }[]
}
type IdDraft = {
  partyId?: number | null
  entries: { ledgerId: number; amount: number; bills?: unknown; chequeNo?: string | null; chequeDate?: string | null; costs?: { centreId: number; amount: number }[] }[]
  inventory?: { itemId: number; godownId: number; qty: number; rate: number; amount: number; counted?: number | null; dueDate?: string | null }[]
}
const nameOf = (m: Map<number, string>, id: number) => {
  const n = m.get(id)
  if (n === undefined) throw new Error(`An optional voucher refers to a master (id ${id}) that no longer exists`)
  return n
}

export async function backupCompany(companyId: number): Promise<{ name: string; file: Buffer }> {
  const q = async <T>(sql: string) => (await pool.query<T>(sql, [companyId])).rows
  const [company] = await q<Backup['company']>(
    `SELECT name, to_char(books_begin,'YYYY-MM-DD') "booksBegin", to_char(fy_start,'YYYY-MM-DD') "fyStart", state, gstin,
            mailing_name "mailingName", address, pincode, phone, email, features, tan, tds_deductor_type "tdsDeductorType", tds_responsible "tdsResponsible", gst_type "gstType", composition_rate "compositionRate"
       FROM companies WHERE id = $1`,
  )
  if (!company) throw new ValidationError([`Unknown company ${companyId}`])
  // parents before children, whatever order they were created or moved in
  const groups = await q<Backup['groups'][number] & { depth: number }>(
    `WITH RECURSIVE t AS (
       SELECT id, name, parent_id, nature, affects_gross_profit, is_default, 0 depth FROM groups WHERE company_id = $1 AND parent_id IS NULL
       UNION ALL SELECT g.id, g.name, g.parent_id, g.nature, g.affects_gross_profit, g.is_default, t.depth + 1
         FROM groups g JOIN t ON g.parent_id = t.id)
     SELECT t.name, p.name parent, t.nature, t.affects_gross_profit "affectsGrossProfit", t.is_default "isDefault", t.depth
       FROM t LEFT JOIN groups p ON p.id = t.parent_id ORDER BY t.depth, t.id`,
  )
  const backup: Backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    company,
    groups: groups.map(({ depth: _, ...g }) => g),
    ledgers: await q(
      `SELECT l.name, g.name "group", l.opening, l.gstin, l.state, l.billwise, l.credit_days "creditDays", l.is_default "isDefault",
              l.gst_tax_type "gstTaxType", l.gst_rate "gstRate", l.hsn, l.cost_centres "costCentres",
              l.interest_rate "interestRate", l.interest_on "interestOn",
              l.mailing_name "mailingName", l.address, l.pincode, l.country, l.phone, l.email, l.pan, l.reverse_charge "reverseCharge",
              (SELECT name FROM gst_classifications c WHERE c.id = l.gst_classification_id) "gstClassification", l.taxability,
              (SELECT name FROM tds_natures n WHERE n.id = l.tds_nature_id) "tdsNature", l.deductee_type "deducteeType",
              (SELECT symbol FROM currencies c WHERE c.id = l.currency_id) currency, l.opening_forex::float8 "openingForex", l.cess_rate "cessRate"
         FROM ledgers l LEFT JOIN groups g ON g.id = l.group_id WHERE l.company_id = $1 ORDER BY l.id`,
    ),
    eDocuments: await q(
      `SELECT v.type || '#' || v.number voucher, d.irn, d.ack_no "ackNo", d.ack_date "ackDate", d.signed_qr "signedQr", d.irn_cancelled "irnCancelled",
              d.ewb_no "ewbNo", d.ewb_date "ewbDate", d.ewb_valid_upto "ewbValidUpto", d.transport
         FROM e_documents d JOIN vouchers v ON v.id = d.voucher_id WHERE v.company_id = $1 ORDER BY v.id`,
    ),
    voucherTypes: await q(
      `SELECT name, base_type "baseType", abbreviation, numbering, prefix, suffix, width, start_number "startNumber", restart_yearly "restartYearly",
              print_title "printTitle", active, pos, (SELECT name FROM gst_registrations r WHERE r.id = t.gst_registration_id) "gstRegistration",
              (SELECT json_agg(json_build_object('fyStart', to_char(c.fy_start, 'YYYY-MM-DD'), 'last', c.last)) FROM voucher_type_counters c WHERE c.voucher_type_id = t.id) counters
         FROM voucher_types t WHERE company_id = $1 ORDER BY id`,
    ),
    currencies: await q(
      `SELECT symbol, name, decimals, decimal_name "decimalName",
              (SELECT json_agg(json_build_object('date', to_char(r.date, 'YYYY-MM-DD'), 'standard', r.standard, 'selling', r.selling, 'buying', r.buying) ORDER BY r.date)
                 FROM exchange_rates r WHERE r.currency_id = c.id) rates
         FROM currencies c WHERE company_id = $1 ORDER BY id`,
    ),
    tdsNatures: await q(
      `SELECT name, section, rate_individual "rateIndividual", rate_other "rateOther", rate_no_pan "rateNoPan", threshold_single::float8 "thresholdSingle",
              threshold_annual::float8 "thresholdAnnual", excess_only "excessOnly", kind, collection_code "collectionCode" FROM tds_natures WHERE company_id = $1 ORDER BY id`,
    ),
    budgets: await q(
      `SELECT b.name, p.name parent, to_char(b.from_date, 'YYYY-MM-DD') "from", to_char(b.to_date, 'YYYY-MM-DD') "to",
              COALESCE((SELECT json_agg(json_build_object(
                 'kind', CASE WHEN l.group_id IS NOT NULL THEN 'group' WHEN l.ledger_id IS NOT NULL THEN 'ledger' ELSE 'cost centre' END,
                 'target', COALESCE((SELECT name FROM groups WHERE id = l.group_id), (SELECT name FROM ledgers WHERE id = l.ledger_id), (SELECT name FROM cost_centres WHERE id = l.cost_centre_id)),
                 'type', l.type, 'amount', l.amount)) FROM budget_lines l WHERE l.budget_id = b.id), '[]') lines
         FROM budgets b LEFT JOIN budgets p ON p.id = b.parent_id WHERE b.company_id = $1 ORDER BY b.id`,
    ),
    scenarios: await q(`SELECT name, include_actuals "includeActuals", include FROM scenarios WHERE company_id = $1 ORDER BY id`),
    gstPortalDocs: await q(
      `SELECT source, month, gstin, party, doc_type "docType", doc_no "docNo", to_char(doc_date, 'YYYY-MM-DD') "docDate", pos, rcm, taxable::float8 taxable, igst::float8 igst,
              cgst::float8 cgst, sgst::float8 sgst, cess::float8 cess, value::float8 value, ims_action "imsAction",
              (SELECT name FROM gst_registrations r WHERE r.id = registration_id) registration FROM gst_portal_docs WHERE company_id = $1 ORDER BY id`,
    ),
    gstRegistrations: await q(`SELECT name, gstin, state FROM gst_registrations WHERE company_id = $1 ORDER BY id`),
    gatewayPayments: await q(
      `SELECT g.gateway, g.payment_id "paymentId", to_char(g.date, 'YYYY-MM-DD') date, g.amount::float8 amount, g.fee::float8 fee, g.tax::float8 tax, g.settlement_id "settlementId",
              to_char(g.settled_on, 'YYYY-MM-DD') "settledOn", g.reference, (SELECT v.type || '#' || v.number FROM vouchers v WHERE v.id = g.posted_voucher_id) "postedVoucher"
         FROM gateway_payments g WHERE g.company_id = $1 ORDER BY g.id`,
    ),
    chequeLayouts: await q(`SELECT l.name ledger, c.layout FROM cheque_layouts c JOIN ledgers l ON l.id = c.ledger_id WHERE l.company_id = $1 ORDER BY l.id`),
    auditMarks: await q(
      `SELECT v.type || '#' || v.number voucher, a.status, a.version, a.auditor, to_char(a.at, 'YYYY-MM-DD"T"HH24:MI:SS.USOF') "at", a.note
         FROM audit_marks a JOIN vouchers v ON v.id = a.voucher_id WHERE v.company_id = $1 ORDER BY v.id`,
    ),
    gstChallans: await q(
      `SELECT v.type || '#' || v.number voucher, c.cpin, c.cin, to_char(c.deposit_date, 'YYYY-MM-DD') "depositDate"
         FROM gst_challans c JOIN vouchers v ON v.id = c.voucher_id WHERE v.company_id = $1 ORDER BY v.id`,
    ),
    msme: await q(
      `SELECT l.name ledger, m.type, m.udyam_no "udyamNo", m.activity FROM party_msme m JOIN ledgers l ON l.id = m.ledger_id WHERE l.company_id = $1 ORDER BY l.id`,
    ),
    tdsChallans: await q(
      `SELECT v.type || '#' || v.number voucher, c.bsr_code "bsrCode", c.challan_no "challanNo", to_char(c.challan_date, 'YYYY-MM-DD') "challanDate"
         FROM tds_challans c JOIN vouchers v ON v.id = c.voucher_id WHERE v.company_id = $1 ORDER BY v.id`,
    ),
    gstClassifications: await q(
      `SELECT name, hsn, description, taxability, gst_rate "gstRate" FROM gst_classifications WHERE company_id = $1 ORDER BY id`,
    ),
    stockCategories: await q(
      `WITH RECURSIVE t AS (
         SELECT id, name, parent_id, 0 d FROM stock_categories WHERE company_id = $1 AND parent_id IS NULL
         UNION ALL SELECT c.id, c.name, c.parent_id, t.d + 1 FROM stock_categories c JOIN t ON c.parent_id = t.id)
       SELECT t.name, p.name parent FROM t LEFT JOIN stock_categories p ON p.id = t.parent_id ORDER BY t.d, t.id`,
    ),
    mail: (await q<NonNullable<Backup['mail']>>(
      `SELECT host, port, secure, username, from_address "fromAddress", from_name "fromName" FROM mail_settings WHERE company_id = $1`,
    ))[0] ?? null,
    gstFilings: await q(`SELECT month, to_char(filed_at, 'YYYY-MM-DD"T"HH24:MI:SS.USOF') "filedAt" FROM gst_filings WHERE company_id = $1 ORDER BY month`),
    costCategories: await q(`SELECT name, is_default "isDefault" FROM cost_categories WHERE company_id = $1 ORDER BY id`),
    costCentres: await q(
      `WITH RECURSIVE t AS (SELECT id, name, category_id, parent_id, 0 d FROM cost_centres WHERE company_id = $1 AND parent_id IS NULL
         UNION ALL SELECT c.id, c.name, c.category_id, c.parent_id, t.d + 1 FROM cost_centres c JOIN t ON c.parent_id = t.id)
       SELECT t.name, k.name category, p.name parent, (SELECT kind FROM cost_centres WHERE id = t.id) kind FROM t JOIN cost_categories k ON k.id = t.category_id
         LEFT JOIN cost_centres p ON p.id = t.parent_id ORDER BY t.d, t.id`,
    ),
    employees: await q(
      `SELECT c.name, number, designation, department, location, gender, to_char(date_of_birth,'YYYY-MM-DD') "dateOfBirth",
              to_char(date_of_joining,'YYYY-MM-DD') "dateOfJoining", to_char(date_of_leaving,'YYYY-MM-DD') "dateOfLeaving", pan, uan, pf_number "pfNumber",
              esi_number "esiNumber", pran, bank_name "bankName", account_no "accountNo", ifsc, tax_regime "taxRegime"
         FROM employees e JOIN cost_centres c ON c.id = e.cost_centre_id WHERE c.company_id = $1 ORDER BY c.id`,
    ),
    attendanceTypes: await q(`SELECT name, kind, unit FROM attendance_types WHERE company_id = $1 ORDER BY id`),
    payHeads: await q(
      `SELECT l.name ledger, p.pay_type "payType", p.statutory, p.calculation, (SELECT name FROM attendance_types WHERE id = p.attendance_type_id) "attendanceType",
              p.per_day_days "perDayDays", COALESCE((SELECT json_agg(json_build_object('payHead', f.name, 'sign', (t ->> 'sign')::int))
                FROM jsonb_array_elements(p.formula) t JOIN ledgers f ON f.id = (t ->> 'payHeadId')::int), '[]') formula,
              p.ceiling::float8 ceiling, p.slabs, p.rounding, p.round_to "roundTo", (SELECT name FROM ledgers WHERE id = p.expense_ledger_id) "expenseLedger",
              p.tax_component "taxComponent"
         FROM pay_heads p JOIN ledgers l ON l.id = p.ledger_id WHERE l.company_id = $1 ORDER BY l.id`,
    ),
    salary: await q(
      `SELECT c.name centre, to_char(s.effective_from,'YYYY-MM-DD') "effectiveFrom",
              COALESCE((SELECT json_agg(json_build_object('payHead', f.name, 'rate', (t ->> 'rate')::bigint))
                FROM jsonb_array_elements(s.lines) WITH ORDINALITY x(t, n) JOIN ledgers f ON f.id = (t ->> 'payHeadId')::int), '[]') lines
         FROM salary_details s JOIN cost_centres c ON c.id = s.cost_centre_id WHERE c.company_id = $1 ORDER BY s.id`,
    ),
    attendance: await q(
      `SELECT v.type || '#' || v.number voucher, c.name employee, t.name type, a.value::float8 value
         FROM attendance_entries a JOIN vouchers v ON v.id = a.voucher_id JOIN cost_centres c ON c.id = a.employee_id JOIN attendance_types t ON t.id = a.attendance_type_id
        WHERE v.company_id = $1 ORDER BY a.voucher_id, a.line`,
    ),
    openingBills: await q(
      `SELECT l.name ledger, ob.name, to_char(ob.bill_date,'YYYY-MM-DD') "billDate", to_char(ob.due_date,'YYYY-MM-DD') "dueDate", ob.amount
         FROM opening_bills ob JOIN ledgers l ON l.id = ob.ledger_id WHERE l.company_id = $1 ORDER BY ob.id`,
    ),
    stockValues: await q(
      `SELECT l.name ledger, to_char(s.as_of,'YYYY-MM-DD') "asOf", s.value FROM stock_values s JOIN ledgers l ON l.id = s.ledger_id
        WHERE l.company_id = $1 ORDER BY s.as_of`,
    ),
    vouchers: await q(
      `SELECT v.type, v.number, to_char(v.date,'YYYY-MM-DD') date, v.narration, v.cancelled, v.version, v.gst,
              (SELECT name FROM ledgers WHERE id = v.party_ledger_id) party, v.post_dated "postDated", v.optional, v.draft, v.gst_adjustment "gstAdjustment",
              (SELECT name FROM voucher_types WHERE id = v.voucher_type_id) "voucherType", v.doc_no "docNo", v.additional_cost::float8 "additionalCost", to_char(v.applicable_upto, 'YYYY-MM-DD') "applicableUpto", v.ref_no "refNo", to_char(v.ref_date, 'YYYY-MM-DD') "refDate", v.advance_rate "advanceRate", v.held, v.cost_track "costTrack",
              COALESCE((SELECT json_agg(json_build_object('ledger', l.name, 'amount', e.amount, 'bankDate', to_char(e.bank_date,'YYYY-MM-DD'),
                         'chequeNo', e.instrument_no, 'chequeDate', to_char(e.instrument_date,'YYYY-MM-DD'), 'forex', e.forex, 'forexRate', e.forex_rate,
                         'bills', (SELECT json_agg(json_build_object('type', a.ref_type, 'name', a.name, 'dueDate', to_char(a.due_date,'YYYY-MM-DD'),
                                    'amount', a.amount, 'forex', a.forex) ORDER BY a.id) FROM bill_allocations a WHERE a.entry_id = e.id),
                         'costs', (SELECT json_agg(json_build_object('centre', cc.name, 'amount', ca.amount) ORDER BY ca.id)
                                    FROM cost_allocations ca JOIN cost_centres cc ON cc.id = ca.cost_centre_id WHERE ca.entry_id = e.id)) ORDER BY e.line)
                         FROM entries e JOIN ledgers l ON l.id = e.ledger_id WHERE e.voucher_id = v.id), '[]') entries
         FROM vouchers v WHERE v.company_id = $1 ORDER BY v.date, v.id`,
    ),
    counters: await q(`SELECT type, last FROM voucher_counters WHERE company_id = $1`),
    users: await q(`SELECT username, password_hash "passwordHash", role, (SELECT name FROM security_levels s WHERE s.id = u.level_id) level FROM users u WHERE company_id = $1 ORDER BY id`),
    securityLevels: await q(`SELECT name, base_role "baseRole", denied_vouchers "deniedVouchers", denied_reports "deniedReports", back_days "backDays" FROM security_levels
      WHERE company_id = $1 ORDER BY id`),
    loans: await q(`SELECT c.name employee, l.name "payHead", to_char(x.given_on, 'YYYY-MM-DD') "givenOn", x.amount::float8 amount, x.instalment::float8 instalment,
      to_char(x.recover_from, 'YYYY-MM-DD') "recoverFrom", x.note FROM employee_loans x JOIN cost_centres c ON c.id = x.employee_id JOIN ledgers l ON l.id = x.pay_head_id
      WHERE x.company_id = $1 ORDER BY x.id`),
    declarations: await q(`SELECT c.name employee, to_char(d.fy_start, 'YYYY-MM-DD') "fyStart", d.rent_paid::float8 "rentPaid", d.metro, d.sec80c::float8 sec80c, d.sec80d::float8 sec80d,
      d.sec80ccd1b::float8 sec80ccd1b, d.sec24b::float8 sec24b, d.other::float8 other FROM tax_declarations d JOIN cost_centres c ON c.id = d.employee_id WHERE c.company_id = $1`),
    tdsPartyRates: await q(`SELECT l.name party, n.name nature, r.kind, r.rate, r.certificate_no "certificateNo", to_char(r.valid_from, 'YYYY-MM-DD') "validFrom",
      to_char(r.valid_to, 'YYYY-MM-DD') "validTo", r.amount_limit::float8 "limit" FROM tds_party_rates r JOIN ledgers l ON l.id = r.ledger_id LEFT JOIN tds_natures n ON n.id = r.nature_id
      WHERE r.company_id = $1 ORDER BY r.id`),
    units: await q(
      `SELECT u.symbol, u.name, u.decimals, f.symbol "first", s.symbol "second", u.conversion, u.uqc
         FROM units u LEFT JOIN units f ON f.id = u.first_unit_id LEFT JOIN units s ON s.id = u.second_unit_id
        WHERE u.company_id = $1 ORDER BY u.second_unit_id IS NOT NULL, u.id`,
    ),
    stockGroups: await q(
      `WITH RECURSIVE t AS (SELECT id, name, parent_id, 0 d FROM stock_groups WHERE company_id = $1 AND parent_id IS NULL
         UNION ALL SELECT g.id, g.name, g.parent_id, t.d + 1 FROM stock_groups g JOIN t ON g.parent_id = t.id)
       SELECT t.name, p.name parent FROM t LEFT JOIN stock_groups p ON p.id = t.parent_id ORDER BY t.d, t.id`,
    ),
    godowns: await q(
      `WITH RECURSIVE t AS (SELECT id, name, parent_id, is_default, 0 d FROM godowns WHERE company_id = $1 AND parent_id IS NULL
         UNION ALL SELECT g.id, g.name, g.parent_id, g.is_default, t.d + 1 FROM godowns g JOIN t ON g.parent_id = t.id)
       SELECT t.name, p.name parent, t.is_default "isDefault", (SELECT third_party FROM godowns WHERE id = t.id) "thirdParty" FROM t LEFT JOIN godowns p ON p.id = t.parent_id ORDER BY t.d, t.id`,
    ),
    boms: await q(
      `SELECT s.name item, b.name, b.makes_qty::float8 "makesQty",
              COALESCE((SELECT json_agg(json_build_object('item', c.name, 'qty', (x ->> 'qty')::bigint)) FROM jsonb_array_elements(b.components) x
                JOIN stock_items c ON c.id = (x ->> 'itemId')::int), '[]') components,
              COALESCE((SELECT json_agg(json_build_object('item', c.name, 'qty', (x ->> 'qty')::bigint, 'costShare', (x ->> 'costShare')::int)) FROM jsonb_array_elements(b.by_products) x
                JOIN stock_items c ON c.id = (x ->> 'itemId')::int), '[]') "byProducts",
              COALESCE((SELECT json_agg(json_build_object('item', c.name, 'qty', (x ->> 'qty')::bigint)) FROM jsonb_array_elements(b.scrap) x
                JOIN stock_items c ON c.id = (x ->> 'itemId')::int), '[]') scrap
         FROM boms b JOIN stock_items s ON s.id = b.item_id WHERE s.company_id = $1 ORDER BY s.id, b.id`,
    ),
    stockItems: await q(
      `SELECT s.name, g.name "group", u.symbol unit, s.opening_qty "openingQty", s.opening_value "openingValue", gd.name "openingGodown",
              s.hsn, s.gst_rate "gstRate", s.reorder_level "reorderLevel", s.min_order_qty "minOrderQty",
              (SELECT name FROM stock_categories c WHERE c.id = s.category_id) category,
              (SELECT name FROM gst_classifications c WHERE c.id = s.gst_classification_id) "gstClassification", s.taxability, s.batches, s.cess_rate "cessRate"
         FROM stock_items s JOIN units u ON u.id = s.unit_id LEFT JOIN stock_groups g ON g.id = s.group_id
         LEFT JOIN godowns gd ON gd.id = s.opening_godown_id WHERE s.company_id = $1 ORDER BY s.id`,
    ),
    inventory: await q(
      `SELECT v.type || '#' || v.number voucher, s.name item, g.name godown, i.qty, i.rate, i.amount, i.moves_stock "movesStock",
              i.counted, (SELECT o.type || '#' || o.number FROM vouchers o WHERE o.id = i.order_id) "order",
              (SELECT t.type || '#' || t.number FROM vouchers t WHERE t.id = i.tracking_id) tracking, to_char(i.due_date,'YYYY-MM-DD') "dueDate",
              i.batch, to_char(i.mfg_date,'YYYY-MM-DD') "mfgDate", to_char(i.expiry_date,'YYYY-MM-DD') "expiryDate", i.role, i.cost_share "costShare"
         FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id JOIN stock_items s ON s.id = i.item_id
         JOIN godowns g ON g.id = i.godown_id WHERE v.company_id = $1 ORDER BY v.id, i.line`,
    ),
    editLog: await q(
      `SELECT to_char(at, 'YYYY-MM-DD"T"HH24:MI:SS.USOF') "at", actor, entity, entity_id "entityId", action, label, data
         FROM edit_log WHERE company_id = $1 ORDER BY id`,
    ),
  }
  // drafts carry ids; write them by name
  const names = async (sql: string) => new Map((await q<{ id: number; name: string }>(sql)).map((r) => [r.id, r.name]))
  const ledgerName = await names(`SELECT id, name FROM ledgers WHERE company_id = $1`)
  const centreName = await names(`SELECT id, name FROM cost_centres WHERE company_id = $1`)
  const itemName = await names(`SELECT id, name FROM stock_items WHERE company_id = $1`)
  const godownName = await names(`SELECT id, name FROM godowns WHERE company_id = $1`)
  for (const v of backup.vouchers) {
    const d = v.draft as unknown as IdDraft | null
    if (!d) continue
    v.draft = {
      party: d.partyId != null ? nameOf(ledgerName, d.partyId) : null,
      entries: d.entries.map(({ ledgerId, costs, ...e }) => ({
        ...e, ledger: nameOf(ledgerName, ledgerId), ...(costs ? { costs: costs.map((c) => ({ centre: nameOf(centreName, c.centreId), amount: c.amount })) } : {}),
      })),
      ...(d.inventory ? { inventory: d.inventory.map(({ itemId, godownId, ...l }) => ({ ...l, item: nameOf(itemName, itemId), godown: nameOf(godownName, godownId) })) } : {}),
    }
  }
  return { name: company.name, file: gzipSync(JSON.stringify(backup)) }
}

function readBackup(file: Buffer): Backup {
  let json: unknown
  try {
    const text = (file[0] === 0x1f && file[1] === 0x8b ? gunzipSync(file) : file).toString('utf8')
    json = JSON.parse(text)
  } catch {
    throw new ValidationError(['This is not a Books backup file'])
  }
  const b = json as Backup
  if (b?.format !== BACKUP_FORMAT) throw new ValidationError(['This is not a Books backup file'])
  if (b.version > BACKUP_VERSION) throw new ValidationError([`This backup is from a newer version (${b.version}); update the app first`])
  return b
}

/** Insert many rows with one statement per chunk; returns the RETURNING rows in order. */
async function insertMany<R>(tx: Tx, head: string, rows: unknown[][], tail = '', chunk = 1000): Promise<R[]> {
  const out: R[] = []
  for (let at = 0; at < rows.length; at += chunk) {
    const part = rows.slice(at, at + chunk)
    const width = part[0].length
    const values = part.map((_, i) => `(${Array.from({ length: width }, (_, j) => `$${i * width + j + 1}`).join(',')})`)
    out.push(...(await tx.query<R>(`${head} VALUES ${values.join(',')} ${tail}`, part.flat())).rows)
  }
  return out
}

/** Restore a backup as a new company (renamed if the name is taken). Returns its id and name. */
export async function restoreCompany(file: Buffer): Promise<{ id: number; name: string }> {
  const b = readBackup(file)
  return withTx(async (tx) => {
    await tx.query(`SELECT set_config('app.actor', $1, true)`, [`restore from backup of ${b.createdAt.slice(0, 10)}`])
    let name = b.company.name
    for (let n = 1; (await tx.query(`SELECT 1 FROM companies WHERE lower(name) = lower($1)`, [name])).rowCount; n++)
      name = `${b.company.name} (restored${n > 1 ? ` ${n}` : ''})`
    const { rows } = await tx.query<{ id: number }>(
      `INSERT INTO companies (name, books_begin, fy_start, state, gstin, mailing_name, address, pincode, phone, email, features, tan, tds_deductor_type, tds_responsible,
                             gst_type, composition_rate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [name, b.company.booksBegin, b.company.fyStart, b.company.state, b.company.gstin, b.company.mailingName ?? null, b.company.address ?? null,
        b.company.pincode ?? null, b.company.phone ?? null, b.company.email ?? null, JSON.stringify(b.company.features ?? {}),
        b.company.tan ?? null, b.company.tdsDeductorType ?? 'Others', b.company.tdsResponsible ?? null, b.company.gstType ?? 'Regular', b.company.compositionRate ?? null],
    )
    const companyId = rows[0].id
    const fail = (msg: string) => {
      throw new ValidationError([`The backup is damaged: ${msg}`])
    }

    // the company's earlier history first, so the trail reads in order
    if (b.editLog.length)
      await insertMany(
        tx,
        `INSERT INTO edit_log (company_id, at, actor, entity, entity_id, action, label, data)`,
        b.editLog.map((e) => [companyId, e.at, e.actor, e.entity, e.entityId, e.action, e.label, JSON.stringify(e.data)]),
      )

    const groupId = new Map<string, number>()
    for (const g of b.groups) {
      const parent = g.parent === null ? null : (groupId.get(g.parent) ?? fail(`group "${g.parent}" is missing`))
      const r = await tx.query<{ id: number }>(
        `INSERT INTO groups (company_id, name, parent_id, nature, affects_gross_profit, is_default) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [companyId, g.name, parent, g.nature, g.affectsGrossProfit, g.isDefault],
      )
      groupId.set(g.name, r.rows[0].id)
    }

    // GST classifications come before the ledgers and items that pick them
    const classificationId = new Map<string, number>()
    for (const c of b.gstClassifications ?? [])
      classificationId.set(c.name, (await tx.query<{ id: number }>(
        `INSERT INTO gst_classifications (company_id, name, hsn, description, taxability, gst_rate) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [companyId, c.name, c.hsn, c.description, c.taxability, c.gstRate],
      )).rows[0].id)
    const natureId = new Map<string, number>()
    for (const n of b.tdsNatures ?? [])
      natureId.set(n.name, (await tx.query<{ id: number }>(
        `INSERT INTO tds_natures (company_id, name, section, rate_individual, rate_other, rate_no_pan, threshold_single, threshold_annual, excess_only, kind, collection_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [companyId, n.name, n.section, n.rateIndividual, n.rateOther, n.rateNoPan, n.thresholdSingle, n.thresholdAnnual, n.excessOnly, n.kind ?? 'TDS', n.collectionCode ?? null],
      )).rows[0].id)
    const currencyId = new Map<string, number>()
    for (const c of b.currencies ?? []) {
      const id = (await tx.query<{ id: number }>(`INSERT INTO currencies (company_id, symbol, name, decimals, decimal_name) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [companyId, c.symbol, c.name, c.decimals, c.decimalName])).rows[0].id
      currencyId.set(c.symbol, id)
      for (const r of c.rates ?? [])
        await tx.query(`INSERT INTO exchange_rates (currency_id, date, standard, selling, buying) VALUES ($1,$2,$3,$4,$5)`, [id, r.date, r.standard, r.selling, r.buying])
    }
    const currency = (s: string | null | undefined) => (s ? (currencyId.get(s) ?? fail(`currency "${s}" is missing`)) : null)
    const tdsNature = (n: string | null | undefined) => (n ? (natureId.get(n) ?? fail(`nature of payment "${n}" is missing`)) : null)
    const classification = (n: string | null | undefined) => (n ? (classificationId.get(n) ?? fail(`GST classification "${n}" is missing`)) : null)

    const made = await insertMany<{ id: number; name: string }>(
      tx,
      `INSERT INTO ledgers (company_id, name, group_id, opening, gstin, state, billwise, credit_days, is_default, gst_tax_type, gst_rate, hsn, cost_centres, interest_rate, interest_on,
        mailing_name, address, pincode, country, phone, email, pan, reverse_charge, gst_classification_id, taxability, tds_nature_id, deductee_type, currency_id, opening_forex)`,
      b.ledgers.map((l) => [
        companyId, l.name, l.group === null ? null : (groupId.get(l.group) ?? fail(`group "${l.group}" is missing`)),
        l.opening, l.gstin, l.state, l.billwise, l.creditDays, l.isDefault, l.gstTaxType ?? null, l.gstRate ?? null, l.hsn ?? null, l.costCentres ?? false,
        l.interestRate ?? null, l.interestOn ?? 'balance',
        l.mailingName ?? null, l.address ?? null, l.pincode ?? null, l.country ?? null, l.phone ?? null, l.email ?? null, l.pan ?? null,
        l.reverseCharge ?? false, classification(l.gstClassification), l.taxability ?? null, tdsNature(l.tdsNature), l.deducteeType ?? null,
        currency(l.currency), l.openingForex ?? 0,
      ]),
      'RETURNING id, name',
    )
    const ledgerId = new Map(made.map((r) => [r.name, r.id]))
    for (const l of b.ledgers) if (l.cessRate) await tx.query(`UPDATE ledgers SET cess_rate = $2 WHERE id = $1`, [ledgerId.get(l.name), l.cessRate])
    const led = (n: string) => ledgerId.get(n) ?? fail(`ledger "${n}" is missing`)
    for (const c of b.chequeLayouts ?? [])
      await tx.query(`INSERT INTO cheque_layouts (ledger_id, layout) VALUES ($1,$2)`, [led(c.ledger), JSON.stringify(c.layout)])
    for (const m of b.msme ?? [])
      await tx.query(`INSERT INTO party_msme (ledger_id, type, udyam_no, activity) VALUES ($1,$2,$3,$4)`, [led(m.ledger), m.type, m.udyamNo, m.activity])

    // cost masters (before version 6 there were none; every company has Primary Cost Category)
    const categoryId = new Map<string, number>()
    for (const k of b.costCategories?.length ? b.costCategories : [{ name: 'Primary Cost Category', isDefault: true }]) {
      const r = await tx.query<{ id: number }>(`INSERT INTO cost_categories (company_id, name, is_default) VALUES ($1,$2,$3) RETURNING id`, [companyId, k.name, k.isDefault])
      categoryId.set(k.name, r.rows[0].id)
    }
    const centreId = new Map<string, number>()
    for (const c of b.costCentres ?? []) {
      const r = await tx.query<{ id: number }>(`INSERT INTO cost_centres (company_id, name, category_id, parent_id, kind) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [
        companyId, c.name, categoryId.get(c.category) ?? fail(`cost category "${c.category}" is missing`),
        c.parent === null ? null : (centreId.get(c.parent) ?? fail(`cost centre "${c.parent}" is missing`)), c.kind ?? 'centre',
      ])
      centreId.set(c.name, r.rows[0].id)
    }
    const centre = (n: string) => centreId.get(n) ?? fail(`cost centre "${n}" is missing`)
    for (const e of b.employees ?? [])
      await tx.query(
        `INSERT INTO employees (cost_centre_id, number, designation, department, location, gender, date_of_birth, date_of_joining, date_of_leaving, pan, uan, pf_number,
           esi_number, pran, bank_name, account_no, ifsc, tax_regime) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [centre(e.name), ...['number', 'designation', 'department', 'location', 'gender', 'dateOfBirth', 'dateOfJoining', 'dateOfLeaving', 'pan', 'uan', 'pfNumber',
          'esiNumber', 'pran', 'bankName', 'accountNo', 'ifsc', 'taxRegime'].map((k) => e[k] ?? null)],
      )
    const attendanceTypeId = new Map<string, number>()
    for (const t of b.attendanceTypes ?? [])
      attendanceTypeId.set(t.name, (await tx.query<{ id: number }>(`INSERT INTO attendance_types (company_id, name, kind, unit) VALUES ($1,$2,$3,$4) RETURNING id`,
        [companyId, t.name, t.kind, t.unit])).rows[0].id)
    const attType = (n: string) => attendanceTypeId.get(n) ?? fail(`attendance type "${n}" is missing`)
    for (const p of b.payHeads ?? [])
      await tx.query(
        `INSERT INTO pay_heads (ledger_id, pay_type, statutory, calculation, attendance_type_id, per_day_days, formula, ceiling, slabs, rounding, round_to, expense_ledger_id,
           tax_component) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [led(p.ledger), p.payType, p.statutory, p.calculation, p.attendanceType ? attType(p.attendanceType) : null, p.perDayDays,
          JSON.stringify(p.formula.map((f) => ({ payHeadId: led(f.payHead), sign: f.sign }))), p.ceiling, JSON.stringify(p.slabs), p.rounding, p.roundTo,
          p.expenseLedger ? led(p.expenseLedger) : null, p.taxComponent ?? null],
      )
    for (const s of b.salary ?? [])
      await tx.query(`INSERT INTO salary_details (cost_centre_id, effective_from, lines) VALUES ($1,$2,$3)`,
        [centre(s.centre), s.effectiveFrom, JSON.stringify(s.lines.map((l) => ({ payHeadId: led(l.payHead), rate: l.rate })))])

    if (b.openingBills.length)
      await insertMany(tx, `INSERT INTO opening_bills (ledger_id, name, bill_date, due_date, amount)`,
        b.openingBills.map((o) => [led(o.ledger), o.name, o.billDate, o.dueDate, o.amount]))
    if (b.stockValues.length)
      await insertMany(tx, `INSERT INTO stock_values (ledger_id, as_of, value)`, b.stockValues.map((s) => [led(s.ledger), s.asOf, s.value]))
    // inventory masters (a version 1 file has none; every company still gets Main Location)
    const godowns = b.godowns?.length ? b.godowns : [{ name: 'Main Location', parent: null, isDefault: true }]
    const godownId = new Map<string, number>()
    for (const gd of godowns) {
      const r = await tx.query<{ id: number }>(`INSERT INTO godowns (company_id, name, parent_id, is_default, third_party) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [
        companyId, gd.name, gd.parent === null ? null : (godownId.get(gd.parent) ?? fail(`godown "${gd.parent}" is missing`)), gd.isDefault,
        ('thirdParty' in gd ? gd.thirdParty : null) ?? null,
      ])
      godownId.set(gd.name, r.rows[0].id)
    }
    const unitId = new Map<string, number>()
    // simple units first: a compound unit refers to two of them
    for (const u of [...(b.units ?? [])].sort((x, y) => Number(!!x.second) - Number(!!y.second)))
      unitId.set(u.symbol, (await tx.query<{ id: number }>(
        `INSERT INTO units (company_id, symbol, name, decimals, first_unit_id, second_unit_id, conversion, uqc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [companyId, u.symbol, u.name, u.decimals,
          u.first ? (unitId.get(u.first) ?? fail(`unit "${u.first}" is missing`)) : null,
          u.second ? (unitId.get(u.second) ?? fail(`unit "${u.second}" is missing`)) : null, u.conversion ?? null, u.uqc ?? null])).rows[0].id)
    const stockGroupId = new Map<string, number>()
    for (const sg of b.stockGroups ?? [])
      stockGroupId.set(sg.name, (await tx.query<{ id: number }>(`INSERT INTO stock_groups (company_id, name, parent_id) VALUES ($1,$2,$3) RETURNING id`, [
        companyId, sg.name, sg.parent === null ? null : (stockGroupId.get(sg.parent) ?? fail(`stock group "${sg.parent}" is missing`)),
      ])).rows[0].id)
    const stockCategoryId = new Map<string, number>()
    for (const c of b.stockCategories ?? [])
      stockCategoryId.set(c.name, (await tx.query<{ id: number }>(`INSERT INTO stock_categories (company_id, name, parent_id) VALUES ($1,$2,$3) RETURNING id`, [
        companyId, c.name, c.parent === null ? null : (stockCategoryId.get(c.parent) ?? fail(`stock category "${c.parent}" is missing`)),
      ])).rows[0].id)
    const itemId = new Map<string, number>()
    for (const it of b.stockItems ?? [])
      itemId.set(it.name, (await tx.query<{ id: number }>(
        `INSERT INTO stock_items (company_id, name, group_id, unit_id, opening_qty, opening_value, opening_godown_id, hsn, gst_rate, reorder_level, min_order_qty)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [companyId, it.name, it.group === null ? null : (stockGroupId.get(it.group) ?? fail(`stock group "${it.group}" is missing`)),
          unitId.get(it.unit) ?? fail(`unit "${it.unit}" is missing`), it.openingQty, it.openingValue,
          it.openingGodown === null ? null : (godownId.get(it.openingGodown) ?? fail(`godown "${it.openingGodown}" is missing`)),
          it.hsn ?? null, it.gstRate ?? null, it.reorderLevel ?? null, it.minOrderQty ?? null],
      )).rows[0].id)
    for (const it of b.stockItems ?? [])
      if (it.category || it.gstClassification || it.taxability)
        await tx.query(`UPDATE stock_items SET category_id = $2, gst_classification_id = $3, taxability = $4 WHERE id = $1`, [
          itemId.get(it.name), it.category ? (stockCategoryId.get(it.category) ?? fail(`stock category "${it.category}" is missing`)) : null,
          classification(it.gstClassification), it.taxability ?? null,
        ])
    for (const it of b.stockItems ?? []) if (it.batches) await tx.query(`UPDATE stock_items SET batches = true WHERE id = $1`, [itemId.get(it.name)])
    for (const it of b.stockItems ?? []) if (it.cessRate) await tx.query(`UPDATE stock_items SET cess_rate = $2 WHERE id = $1`, [itemId.get(it.name), it.cessRate])
    for (const bom of b.boms ?? [])
      await tx.query(`INSERT INTO boms (item_id, name, makes_qty, components, by_products, scrap) VALUES ($1,$2,$3,$4,$5,$6)`, [
        itemId.get(bom.item) ?? fail(`stock item "${bom.item}" is missing`), bom.name ?? 'Main', bom.makesQty,
        JSON.stringify(bom.components.map((c) => ({ itemId: itemId.get(c.item) ?? fail(`stock item "${c.item}" is missing`), qty: c.qty }))),
        JSON.stringify((bom.byProducts ?? []).map((c) => ({ itemId: itemId.get(c.item) ?? fail(`stock item "${c.item}" is missing`), qty: c.qty, costShare: c.costShare }))),
        JSON.stringify((bom.scrap ?? []).map((c) => ({ itemId: itemId.get(c.item) ?? fail(`stock item "${c.item}" is missing`), qty: c.qty })))])
    const registrationId = new Map<string, number>()
    for (const r of b.gstRegistrations ?? [])
      registrationId.set(r.name, (await tx.query<{ id: number }>(`INSERT INTO gst_registrations (company_id, name, gstin, state) VALUES ($1,$2,$3,$4) RETURNING id`,
        [companyId, r.name, r.gstin, r.state])).rows[0].id)
    const voucherTypeId = new Map<string, number>()
    for (const t of b.voucherTypes ?? []) {
      const id = (await tx.query<{ id: number }>(
        `INSERT INTO voucher_types (company_id, name, base_type, abbreviation, numbering, prefix, suffix, width, start_number, restart_yearly, print_title, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [companyId, t.name, t.baseType, t.abbreviation, t.numbering, t.prefix, t.suffix, t.width, t.startNumber, t.restartYearly, t.printTitle, t.active],
      )).rows[0].id
      voucherTypeId.set(t.name, id)
      if (t.pos) await tx.query(`UPDATE voucher_types SET pos = true WHERE id = $1`, [id])
      if (t.gstRegistration)
        await tx.query(`UPDATE voucher_types SET gst_registration_id = $2 WHERE id = $1`, [id, registrationId.get(t.gstRegistration) ?? fail(`GST registration "${t.gstRegistration}" is missing`)])
      for (const c of t.counters ?? []) await tx.query(`INSERT INTO voucher_type_counters (voucher_type_id, fy_start, last) VALUES ($1,$2,$3)`, [id, c.fyStart, c.last])
    }

    for (const f of b.gstFilings ?? []) await tx.query(`INSERT INTO gst_filings (company_id, month, filed_at) VALUES ($1,$2,$3)`, [companyId, f.month, f.filedAt])
    const levelId = new Map<string, number>()
    for (const l of b.securityLevels ?? [])
      levelId.set(l.name, (await tx.query<{ id: number }>(`INSERT INTO security_levels (company_id, name, base_role, denied_vouchers, denied_reports, back_days) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [companyId, l.name, l.baseRole, l.deniedVouchers, l.deniedReports, l.backDays])).rows[0].id)
    for (const u of b.users ?? [])
      await tx.query(`INSERT INTO users (company_id, username, password_hash, role, level_id) VALUES ($1,$2,$3,$4,$5)`, [companyId, u.username, u.passwordHash, u.role,
        u.level ? (levelId.get(u.level) ?? fail(`security level "${u.level}" is missing`)) : null])
    for (const x of b.loans ?? [])
      await tx.query(`INSERT INTO employee_loans (company_id, employee_id, pay_head_id, given_on, amount, instalment, recover_from, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [companyId, centre(x.employee), led(x.payHead), x.givenOn, x.amount, x.instalment, x.recoverFrom, x.note])
    for (const d of b.declarations ?? [])
      await tx.query(`INSERT INTO tax_declarations (employee_id, fy_start, rent_paid, metro, sec80c, sec80d, sec80ccd1b, sec24b, other) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [centre(d.employee), d.fyStart, d.rentPaid, d.metro, d.sec80c, d.sec80d, d.sec80ccd1b, d.sec24b, d.other])
    for (const r of b.tdsPartyRates ?? [])
      await tx.query(`INSERT INTO tds_party_rates (company_id, ledger_id, nature_id, kind, rate, certificate_no, valid_from, valid_to, amount_limit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [companyId, led(r.party), tdsNature(r.nature), r.kind, r.rate, r.certificateNo, r.validFrom, r.validTo, r.limit])

    // a draft's names back to this company's ids
    const draftIds = (d: NamedDraft): IdDraft => ({
      ...(d.party ? { partyId: led(d.party) } : {}),
      entries: d.entries.map(({ ledger, costs, ...e }) => ({
        ...e, ledgerId: led(ledger), ...(costs ? { costs: costs.map((c) => ({ centreId: centreId.get(c.centre) ?? fail(`cost centre "${c.centre}" is missing`), amount: c.amount })) } : {}),
      })),
      ...(d.inventory ? { inventory: d.inventory.map(({ item, godown, ...l }) => ({
        ...l, itemId: itemId.get(item) ?? fail(`stock item "${item}" is missing`), godownId: godownId.get(godown) ?? fail(`godown "${godown}" is missing`),
      })) } : {}),
    })

    if (b.counters.length)
      await insertMany(tx, `INSERT INTO voucher_counters (company_id, type, last)`, b.counters.map((c) => [companyId, c.type, c.last]))

    if (b.vouchers.length) {
      const vs = await insertMany<{ id: number; type: string; number: number }>(
        tx,
        `INSERT INTO vouchers (company_id, type, number, date, narration, cancelled, version, gst, party_ledger_id, post_dated, optional, draft, gst_adjustment,
                               voucher_type_id, doc_no, additional_cost, applicable_upto, ref_no, ref_date, advance_rate, held, cost_track)`,
        b.vouchers.map((v) => [companyId, v.type, v.number, v.date, v.narration, v.cancelled, v.version, v.gst ?? null, v.party ? led(v.party) : null,
          v.postDated ?? false, v.optional ?? false, v.draft ? draftIds(v.draft) : null, v.gstAdjustment ?? null,
          v.voucherType ? (voucherTypeId.get(v.voucherType) ?? fail(`voucher type "${v.voucherType}" is missing`)) : null, v.docNo ?? null, v.additionalCost ?? 0, v.applicableUpto ?? null,
          v.refNo ?? null, v.refDate ?? null, v.advanceRate ?? null, v.held ?? false, v.costTrack ?? null]),
        'RETURNING id, type, number',
      )
      const vid = new Map(vs.map((r) => [`${r.type}#${r.number}`, r.id]))
      const entryRows = b.vouchers.flatMap((v) =>
        v.entries.map((e, line) => [vid.get(`${v.type}#${v.number}`)!, line + 1, led(e.ledger), e.amount, e.bankDate, e.chequeNo ?? null, e.chequeDate ?? null,
          e.forex ?? null, e.forex ? e.forexRate : null]),
      )
      const entries = await insertMany<{ id: number; voucher_id: number; line: number }>(
        tx,
        `INSERT INTO entries (voucher_id, line, ledger_id, amount, bank_date, instrument_no, instrument_date, forex, forex_rate)`,
        entryRows,
        'RETURNING id, voucher_id, line',
        2000,
      )
      const eid = new Map(entries.map((r) => [`${r.voucher_id}#${r.line}`, r.id]))
      const bills = b.vouchers.flatMap((v) =>
        v.entries.flatMap((e, line) =>
          (e.bills ?? []).map((x) => [eid.get(`${vid.get(`${v.type}#${v.number}`)}#${line + 1}`)!, led(e.ledger), x.type, x.name, x.dueDate, x.amount, x.forex ?? null]),
        ),
      )
      if (bills.length)
        await insertMany(tx, `INSERT INTO bill_allocations (entry_id, ledger_id, ref_type, name, due_date, amount, forex)`, bills, '', 2000)
      const costs = b.vouchers.flatMap((v) =>
        v.entries.flatMap((e, line) =>
          (e.costs ?? []).map((c) => [eid.get(`${vid.get(`${v.type}#${v.number}`)}#${line + 1}`)!, centreId.get(c.centre) ?? fail(`cost centre "${c.centre}" is missing`), c.amount]),
        ),
      )
      if (costs.length) await insertMany(tx, `INSERT INTO cost_allocations (entry_id, cost_centre_id, amount)`, costs, '', 3000)
    }
    if (b.inventory?.length) {
      const vid = new Map((await tx.query<{ k: string; id: number }>(`SELECT type || '#' || number k, id FROM vouchers WHERE company_id = $1`, [companyId])).rows.map((r) => [r.k, r.id]))
      const lineNo = new Map<string, number>()
      await insertMany(
        tx,
        `INSERT INTO inventory_entries (voucher_id, line, item_id, godown_id, qty, rate, amount, moves_stock, counted, order_id, tracking_id, due_date, batch, mfg_date, expiry_date,
          role, cost_share)`,
        b.inventory.map((l) => {
          const n = (lineNo.get(l.voucher) ?? 0) + 1
          lineNo.set(l.voucher, n)
          const ref = (k: string | null | undefined) => (k ? vid.get(k) ?? fail(`voucher ${k} is missing`) : null)
          return [vid.get(l.voucher) ?? fail(`voucher ${l.voucher} is missing`), n, itemId.get(l.item) ?? fail(`stock item "${l.item}" is missing`),
            godownId.get(l.godown) ?? fail(`godown "${l.godown}" is missing`), l.qty, l.rate, l.amount,
            l.movesStock ?? true, l.counted ?? null, ref(l.order), ref(l.tracking), l.dueDate ?? null, l.batch ?? null, l.mfgDate ?? null, l.expiryDate ?? null,
            l.role ?? null, l.costShare ?? null]
        }),
        '',
        2000,
      )
    }
    if (b.attendance?.length) {
      const vid = new Map((await tx.query<{ k: string; id: number }>(`SELECT type || '#' || number k, id FROM vouchers WHERE company_id = $1`, [companyId])).rows.map((r) => [r.k, r.id]))
      const lineNo = new Map<string, number>()
      await insertMany(
        tx,
        `INSERT INTO attendance_entries (voucher_id, line, employee_id, attendance_type_id, value)`,
        b.attendance.map((a) => {
          const n = (lineNo.get(a.voucher) ?? 0) + 1
          lineNo.set(a.voucher, n)
          return [vid.get(a.voucher) ?? fail(`voucher ${a.voucher} is missing`), n, centreId.get(a.employee) ?? fail(`employee "${a.employee}" is missing`), attendanceTypeId.get(a.type) ?? fail(`attendance type "${a.type}" is missing`), a.value]
        }),
        '',
        2000,
      )
    }
    if (b.budgets?.length) {
      const ids = async (table: string) => new Map((await tx.query<{ id: number; name: string }>(`SELECT id, name FROM ${table} WHERE company_id = $1`, [companyId])).rows.map((r) => [r.name, r.id]))
      const targets: Record<string, Map<string, number>> = { group: await ids('groups'), ledger: await ids('ledgers'), 'cost centre': await ids('cost_centres') }
      const budgetId = new Map<string, number>()
      for (const bu of b.budgets) // parents come first: they were made first
        budgetId.set(bu.name, (await tx.query<{ id: number }>(`INSERT INTO budgets (company_id, name, parent_id, from_date, to_date) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [companyId, bu.name, bu.parent ? (budgetId.get(bu.parent) ?? fail(`budget "${bu.parent}" is missing`)) : null, bu.from, bu.to])).rows[0].id)
      for (const bu of b.budgets)
        for (const l of bu.lines) {
          const id = targets[l.kind]?.get(l.target) ?? fail(`${l.kind} "${l.target}" of budget "${bu.name}" is missing`)
          await tx.query(`INSERT INTO budget_lines (budget_id, group_id, ledger_id, cost_centre_id, type, amount) VALUES ($1,$2,$3,$4,$5,$6)`,
            [budgetId.get(bu.name), l.kind === 'group' ? id : null, l.kind === 'ledger' ? id : null, l.kind === 'cost centre' ? id : null, l.type, l.amount])
        }
    }
    for (const d of b.gstPortalDocs ?? [])
      await tx.query(
        `INSERT INTO gst_portal_docs (company_id, source, month, gstin, party, doc_type, doc_no, doc_date, pos, rcm, taxable, igst, cgst, sgst, cess, value, ims_action, registration_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [companyId, d.source, d.month, d.gstin, d.party, d.docType, d.docNo, d.docDate, d.pos, d.rcm, d.taxable, d.igst, d.cgst, d.sgst, d.cess, d.value, d.imsAction,
          d.registration ? (registrationId.get(d.registration) ?? fail(`GST registration "${d.registration}" is missing`)) : null],
      )
    for (const s of b.scenarios ?? [])
      await tx.query(`INSERT INTO scenarios (company_id, name, include_actuals, include) VALUES ($1,$2,$3,$4)`, [companyId, s.name, s.includeActuals, s.include])
    if (b.eDocuments?.length || b.mail || b.tdsChallans?.length || b.gstChallans?.length || b.auditMarks?.length || b.gatewayPayments?.length) {
      const vid = new Map((await tx.query<{ k: string; id: number }>(`SELECT type || '#' || number k, id FROM vouchers WHERE company_id = $1`, [companyId])).rows.map((r) => [r.k, r.id]))
      for (const d of b.eDocuments ?? [])
        await tx.query(
          `INSERT INTO e_documents (voucher_id, irn, ack_no, ack_date, signed_qr, irn_cancelled, ewb_no, ewb_date, ewb_valid_upto, transport) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [vid.get(d.voucher) ?? fail(`voucher ${d.voucher} is missing`), d.irn, d.ackNo, d.ackDate, d.signedQr, d.irnCancelled, d.ewbNo, d.ewbDate, d.ewbValidUpto,
            d.transport === null || d.transport === undefined ? null : JSON.stringify(d.transport)],
        )
      for (const g of b.gatewayPayments ?? [])
        await tx.query(
          `INSERT INTO gateway_payments (company_id, gateway, payment_id, date, amount, fee, tax, settlement_id, settled_on, reference, posted_voucher_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [companyId, g.gateway, g.paymentId, g.date, g.amount, g.fee, g.tax, g.settlementId, g.settledOn, g.reference, g.postedVoucher ? (vid.get(g.postedVoucher) ?? null) : null],
        )
      for (const a of b.auditMarks ?? [])
        await tx.query(`INSERT INTO audit_marks (voucher_id, status, version, auditor, at, note) VALUES ($1,$2,$3,$4,$5,$6)`,
          [vid.get(a.voucher) ?? fail(`voucher ${a.voucher} is missing`), a.status, a.version, a.auditor, a.at, a.note])
      for (const c of b.gstChallans ?? [])
        await tx.query(`INSERT INTO gst_challans (voucher_id, cpin, cin, deposit_date) VALUES ($1,$2,$3,$4)`,
          [vid.get(c.voucher) ?? fail(`voucher ${c.voucher} is missing`), c.cpin, c.cin, c.depositDate])
      for (const c of b.tdsChallans ?? [])
        await tx.query(`INSERT INTO tds_challans (voucher_id, bsr_code, challan_no, challan_date) VALUES ($1,$2,$3,$4)`,
          [vid.get(c.voucher) ?? fail(`voucher ${c.voucher} is missing`), c.bsrCode, c.challanNo, c.challanDate])
      if (b.mail)
        await tx.query(`INSERT INTO mail_settings (company_id, host, port, secure, username, from_address, from_name) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [companyId, b.mail.host, b.mail.port, b.mail.secure, b.mail.username, b.mail.fromAddress, b.mail.fromName])
    }
    // every database rule runs now, before the company becomes visible
    await tx.query('SET CONSTRAINTS ALL IMMEDIATE')
    return { id: companyId, name }
  })
}
