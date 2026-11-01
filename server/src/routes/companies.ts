import express, { Router, type Request } from 'express'
import { z } from 'zod'
import { pool } from '../db'
import {
  alterGroup,
  alterLedger,
  alterVoucher,
  cancelVoucher,
  createCompany,
  createGroup,
  createLedger,
  deleteGroup,
  deleteLedger,
  deleteVoucher,
  fyEnd,
  getCompany,
  getLedger,
  getVoucher,
  ledgerBalances,
  setCompanyDetails,
  loadGroups,
  loadLedgers,
  pendingBills,
  postVoucher,
  setOpeningBills,
  setStockValue,
  ValidationError, releaseHeld } from '../books'
import { balanceSheet, profitAndLoss, trialBalance } from '../engine/reports'
import { BILL_TYPES, VOUCHER_TYPES } from '../engine/voucher'
import { TAX_TYPES, TAXABILITY } from '../engine/gst'
import { isUnder, primaryOf } from '../engine/groups'
import { billsReport, overdueDays } from '../engine/bills'
import { addBookRoutes } from './books-reports'
import { addBankRoutes } from './bank'
import { addEditLogRoutes } from './editlog'
import { addInventoryRoutes } from './inventory'
import { addGstRoutes } from './gst'
import { addTdsRoutes } from './tds'
import { addForexRoutes } from './forex'
import { addPayrollRoutes } from './payroll'
import { addManufacturingRoutes } from './manufacturing'
import { addMsmeRoutes } from './msme'
import { importSheet } from '../import'
import { splitCompany } from '../split'
import { getConfig, setConfig } from '../config'
import { costTracks, orderAnalysis, posRegister, setAudit, tallyAudit } from '../registers'
import { batchSummary } from '../inventory'
import { gatewayReconciliation, gateways, importGatewayReport, postSettlement } from '../gateway'
import { today } from '../engine/clock'
import { addBudgetRoutes } from './budgets'
import { scenarioView } from '../budgets'
import { DEDUCTEE_TYPES } from '../engine/tds'
import { addEDocRoutes } from './edocs'
import { addIntelligenceRoutes } from './intelligence'
import { addMailRoutes } from './mail'
import { addVoucherTypeRoutes } from './vouchertypes'
import { addCostCentreRoutes } from './costcentres'
import { addSecurityRoutes, guard } from './security'
import { backupCompany, restoreCompany } from '../backup'

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use yyyy-mm-dd')
const paise = z.number().int()

const companyBody = z.object({
  name: z.string().trim().min(1),
  booksBegin: date,
  fyStart: date.optional(),
  state: z.string().optional(),
  gstin: z.string().optional(),
})
const groupBody = z.object({ name: z.string().trim().min(1), parentId: z.number().int() })
const ledgerBody = z.object({
  name: z.string().trim().min(1),
  groupId: z.number().int(),
  opening: paise.optional(),
  gstin: z.string().nullish().transform((v) => v || undefined),
  state: z.string().nullish().transform((v) => v || undefined),
  billwise: z.boolean().optional(),
  creditDays: z.number().int().nullish(),
  gstTaxType: z.enum(TAX_TYPES).nullish(),
  gstRate: z.number().int().nullish(),
  cessRate: z.number().int().nullish(),
  hsn: z.string().nullish(),
  gstClassificationId: z.number().int().positive().nullish(),
  taxability: z.enum(TAXABILITY).nullish(),
  tdsNatureId: z.number().int().positive().nullish(),
  deducteeType: z.enum(DEDUCTEE_TYPES).nullish(),
  currencyId: z.number().int().positive().nullish(),
  openingForex: z.number().int().optional(),
  costCentres: z.boolean().optional(),
  interestRate: z.number().int().nullish(),
  interestOn: z.enum(['balance', 'bills']).optional(),
  mailingName: z.string().nullish(),
  address: z.string().nullish(),
  pincode: z.string().nullish(),
  country: z.string().nullish(),
  phone: z.string().nullish(),
  email: z.string().nullish(),
  pan: z.string().nullish(),
  reverseCharge: z.boolean().optional(),
})
const billBody = z.object({
  type: z.enum(BILL_TYPES),
  name: z.string().nullish().transform((v) => v || undefined),
  dueDate: date.nullish().transform((v) => v || undefined),
  amount: paise,
})
const voucherBody = z.object({
  type: z.enum(VOUCHER_TYPES),
  date,
  narration: z.string().optional(),
  entries: z.array(
    z.object({
      ledgerId: z.number().int(),
      amount: paise,
      bills: z.array(billBody).nullish().transform((v) => v || undefined),
      costs: z.array(z.object({ centreId: z.number().int(), amount: paise })).nullish().transform((v) => v || undefined),
      chequeNo: z.string().nullish(),
      chequeDate: date.nullish(),
      forex: z.number().int().nullish(),
      forexRate: z.number().int().nullish(),
    }),
  ),
  inventory: z
    .array(
      z.object({
        itemId: z.number().int(),
        godownId: z.number().int(),
        qty: z.number().int(),
        rate: z.number().int(),
        amount: paise,
        counted: z.number().int().nullish(),
        orderId: z.number().int().nullish(),
        trackingId: z.number().int().nullish(),
        dueDate: date.nullish(),
        batch: z.string().nullish(),
        mfgDate: date.nullish(),
        expiryDate: date.nullish(),
        role: z.enum(['by-product', 'scrap']).nullish(),
        costShare: z.number().int().min(0).max(10000).nullish(),
      }),
    )
    .nullish()
    .transform((v) => v || undefined),
  partyId: z.number().int().nullish(),
  postDated: z.boolean().optional(),
  optional: z.boolean().optional(),
  gstAdjustment: z.enum(['itc-reversal', 'itc-reclaim']).nullish(),
  voucherTypeId: z.number().int().nullish(),
  docNo: z.string().max(30).nullish(),
  attendance: z.array(z.object({ employeeId: z.number().int(), typeId: z.number().int(), value: z.number().int() })).nullish().transform((v) => v || undefined),
  additionalCost: z.number().int().nullish().transform((v) => v ?? undefined),
  applicableUpto: date.nullish(),
  refNo: z.string().nullish(),
  refDate: date.nullish(),
  advanceRate: z.number().int().nullish(),
  costTrack: z.string().nullish(),
  shippingBill: z.object({ port: z.string().max(10), no: z.string().max(20), date: date.or(z.literal('')) }).nullish(),
  version: z.number().int().optional(),
})
const openingBillsBody = z.array(
  z.object({ name: z.string().trim().min(1), billDate: date, dueDate: date.nullish(), amount: paise }),
)
const stockBody = z.object({ ledgerId: z.number().int(), asOf: date, value: paise })

export const companiesRouter = Router()

companiesRouter.get('/', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, to_char(books_begin,'YYYY-MM-DD') "booksBegin", to_char(fy_start,'YYYY-MM-DD') "fyStart",
            EXISTS (SELECT 1 FROM users u WHERE u.company_id = companies.id) secured
       FROM companies ORDER BY name`,
  )
  res.json(rows)
})

/** Restore a backup file (raw bytes, gzip or JSON) as a new company. */
companiesRouter.post('/restore', express.raw({ type: () => true, limit: '500mb' }), async (req, res) => {
  const r = await restoreCompany(Buffer.isBuffer(req.body) ? req.body : Buffer.from([]))
  res.status(201).json(await getCompany(pool, r.id))
})

companiesRouter.post('/', async (req, res) => {
  const id = await createCompany(companyBody.parse(req.body))
  res.status(201).json(await getCompany(pool, id))
})

// everything below is scoped to one company
const company = Router({ mergeParams: true })
companiesRouter.use('/:companyId', company)

const cid = (req: Request) => Number(req.params.companyId)
// every company route checks security first (a company without users stays open)
company.use(guard(cid))
// post-dated vouchers are posted when their day comes: looked at once a day per company
const releasedOn = new Map<number, string>()
company.use(async (req, _res, next) => {
  const id = cid(req)
  if (Number.isInteger(id) && releasedOn.get(id) !== today()) {
    releasedOn.set(id, today())
    const r = await releaseHeld(id)
    if (r.failed.length) console.warn(`company ${id}: post-dated vouchers not posted:`, r.failed)
  }
  next()
})
addSecurityRoutes(company, cid)

/** Report period from the query string; defaults to the current financial year. */
async function period(req: Request) {
  const c = await getCompany(pool, cid(req))
  if (!c) throw new ValidationError([`Unknown company ${req.params.companyId}`])
  const from = date.optional().parse(req.query.from) ?? c.fyStart
  const to = date.optional().parse(req.query.to) ?? fyEnd(c.fyStart)
  if (to < from) throw new ValidationError(['The period ends before it starts'])
  return { from, to }
}

company.get('/', async (req, res) => {
  const c = await getCompany(pool, cid(req))
  if (!c) return res.status(404).json({ error: 'Not found' })
  res.json(c)
})

/** The company's mailing details (Alt+K, Company Details). */
company.put('/details', async (req, res) => {
  const s = z.string().nullish()
  await setCompanyDetails(cid(req), z.object({ mailingName: s, address: s, pincode: s, phone: s, email: s }).parse(req.body))
  res.status(204).end()
})

/** Download the whole company as one backup file. */
company.get('/backup', async (req, res) => {
  const { name, file } = await backupCompany(cid(req))
  const stamp = new Date().toISOString().slice(0, 10)
  const safe = name.replace(/[^A-Za-z0-9 ._-]+/g, '').trim() || 'company'
  res.setHeader('content-type', 'application/gzip')
  res.setHeader('content-disposition', `attachment; filename="${safe} ${stamp}.tallybackup"`)
  res.send(file)
})

company.get('/groups', async (req, res) => {
  const groups = await loadGroups(pool, cid(req))
  res.json([...groups.values()])
})

company.post('/groups', async (req, res) => {
  res.status(201).json({ id: await createGroup(cid(req), groupBody.parse(req.body)) })
})

company.put('/groups/:id', async (req, res) => {
  await alterGroup(cid(req), Number(req.params.id), groupBody.parse(req.body))
  res.status(204).end()
})

company.delete('/groups/:id', async (req, res) => {
  await deleteGroup(cid(req), Number(req.params.id))
  res.status(204).end()
})

/** Ledgers with their group and closing balance at the end of the period. */
company.get('/ledgers', async (req, res) => {
  const { from, to } = await period(req)
  const groups = await loadGroups(pool, cid(req))
  const balances = await ledgerBalances(pool, cid(req), from, to)
  const refs = await loadLedgers(pool, cid(req))
  res.json(
    balances.filter((b) => b.id > 0).map((b) => ({
      billwise: refs.get(b.id)?.billwise ?? false,
      costCentres: refs.get(b.id)?.costCentres ?? false,
      interestRate: refs.get(b.id)?.interestRate ?? null,
      currencyId: refs.get(b.id)?.currencyId ?? null,
      country: refs.get(b.id)?.country ?? null,
      id: b.id,
      name: b.name,
      groupId: b.groupId,
      group: b.groupId === null ? null : groups.get(b.groupId)!.name,
      primaryGroup: b.groupId === null ? null : primaryOf(groups, b.groupId).name,
      opening: b.opening,
      closing: b.stockValue ?? b.closing,
    })),
  )
})

company.post('/ledgers', async (req, res) => {
  res.status(201).json({ id: await createLedger(cid(req), ledgerBody.parse(req.body)) })
})

company.get('/ledgers/:id', async (req, res) => {
  const l = await getLedger(pool, cid(req), Number(req.params.id))
  if (!l) return res.status(404).json({ error: 'Not found' })
  res.json(l)
})

company.put('/ledgers/:id', async (req, res) => {
  const body = ledgerBody.extend({ groupId: z.number().int().nullable() }).parse(req.body)
  // the primary Profit & Loss A/c has no group; alterLedger only reads groupId for grouped ledgers
  await alterLedger(cid(req), Number(req.params.id), { ...body, groupId: body.groupId ?? 0 })
  res.status(204).end()
})

company.delete('/ledgers/:id', async (req, res) => {
  await deleteLedger(cid(req), Number(req.params.id))
  res.status(204).end()
})

company.post('/stock-values', async (req, res) => {
  const b = stockBody.parse(req.body)
  await setStockValue(cid(req), b.ledgerId, b.asOf, b.value)
  res.status(204).end()
})

/** Ledger statement (Tally's ledger vouchers report): opening, each entry with running balance, closing. */
company.get('/ledgers/:ledgerId/statement', async (req, res) => {
  const { from, to } = await period(req)
  const ledgerId = Number(req.params.ledgerId)
  const b = (await ledgerBalances(pool, cid(req), from, to)).find((x) => x.id === ledgerId)
  if (!b) return res.status(404).json({ error: 'Not found' })
  const { rows } = await pool.query(
    `SELECT v.id "voucherId", v.type, v.number, COALESCE(v.doc_no, v.number::text) "docNo",
            (SELECT name FROM voucher_types WHERE id = v.voucher_type_id) "voucherType", to_char(v.date,'YYYY-MM-DD') date, v.narration, e.amount,
            e.forex::float8 forex, e.forex_rate::float8 "forexRate",
            (SELECT string_agg(l2.name, ', ' ORDER BY e2.line) FROM entries e2 JOIN ledgers l2 ON l2.id = e2.ledger_id
              WHERE e2.voucher_id = v.id AND e2.ledger_id <> $2) particulars
       FROM entries e JOIN vouchers v ON v.id = e.voucher_id
      WHERE e.ledger_id = $2 AND v.company_id = $1 AND v.date BETWEEN $3 AND $4
      ORDER BY v.date, v.id, e.line`,
    [cid(req), ledgerId, from, to],
  )
  let running = b.opening
  const lines = rows.map((r) => ({ ...r, balance: (running += r.amount) }))
  // a foreign-currency ledger also runs its balance in the currency
  const fx = (await pool.query<{ currencyId: number; symbol: string; decimals: number; opening: number }>(
    `SELECT c.id "currencyId", c.symbol, c.decimals, (l.opening_forex + COALESCE((SELECT sum(COALESCE(e.forex, 0)) FROM entries e JOIN vouchers v ON v.id = e.voucher_id
            WHERE e.ledger_id = l.id AND v.date < $2), 0))::float8 opening
       FROM ledgers l JOIN currencies c ON c.id = l.currency_id WHERE l.id = $1`,
    [ledgerId, from],
  )).rows[0]
  let forex = fx?.opening ?? 0
  const forexLines = fx ? lines.map((l) => ({ ...l, forexBalance: (forex += l.forex ?? 0) })) : lines
  res.json({
    ledger: { id: b.id, name: b.name }, from, to, opening: b.opening, lines: forexLines, closing: running,
    ...(fx ? { currency: { id: fx.currencyId, symbol: fx.symbol, decimals: fx.decimals }, openingForex: fx.opening, closingForex: forex } : {}),
  })
})

/** Day book: vouchers in the period, optionally one type, with their entries. */
company.get('/vouchers', async (req, res) => {
  const { from, to } = await period(req)
  const type = z.enum(VOUCHER_TYPES).optional().parse(req.query.type)
  const { rows } = await pool.query(
    `SELECT v.id, v.type, v.number, COALESCE(v.doc_no, v.number::text) "docNo", (SELECT name FROM voucher_types WHERE id = v.voucher_type_id) "voucherType",
            to_char(v.date,'YYYY-MM-DD') date, v.narration, v.cancelled, v.version, v.post_dated "postDated", v.optional,
            (SELECT name FROM ledgers WHERE id = v.party_ledger_id) party,
            (SELECT SUM(abs(i.amount)) FROM inventory_entries i WHERE i.voucher_id = v.id)::bigint "stockValue",
            -- an optional or memorandum voucher shows the lines it was entered with
            CASE WHEN v.draft IS NOT NULL THEN COALESCE((v.draft -> 'entries')::json, '[]')
                 ELSE COALESCE(json_agg(json_build_object('ledgerId', e.ledger_id, 'ledger', l.name, 'amount', e.amount)
                     ORDER BY e.line) FILTER (WHERE e.id IS NOT NULL), '[]') END entries
       FROM vouchers v LEFT JOIN entries e ON e.voucher_id = v.id LEFT JOIN ledgers l ON l.id = e.ledger_id
      WHERE v.company_id = $1 AND v.date BETWEEN $2 AND $3 AND ($4::text IS NULL OR v.type = $4)
      GROUP BY v.id ORDER BY v.date, v.id`,
    [cid(req), from, to, type ?? null],
  )
  res.json(rows)
})

company.post('/vouchers', async (req, res) => {
  const { version: _, ...v } = voucherBody.parse(req.body)
  const r = await postVoucher(cid(req), v)
  res.status(201).json(await getVoucher(pool, cid(req), r.id))
})

/** The number the next voucher of a type will get (a default bill reference; not reserved). */
company.get('/vouchers/next-number', async (req, res) => {
  const type = z.enum(VOUCHER_TYPES).parse(req.query.type)
  const { rows } = await pool.query(`SELECT last FROM voucher_counters WHERE company_id = $1 AND type = $2`, [cid(req), type])
  res.json({ number: (rows[0]?.last ?? 0) + 1 })
})

company.get('/vouchers/:id', async (req, res) => {
  const v = await getVoucher(pool, cid(req), Number(req.params.id))
  if (!v) return res.status(404).json({ error: 'Not found' })
  res.json(v)
})

company.put('/vouchers/:id', async (req, res) => {
  const { version, ...v } = voucherBody.parse(req.body)
  await alterVoucher(cid(req), Number(req.params.id), v, version)
  res.json(await getVoucher(pool, cid(req), Number(req.params.id)))
})

company.post('/vouchers/:id/cancel', async (req, res) => {
  await cancelVoucher(cid(req), Number(req.params.id))
  res.json(await getVoucher(pool, cid(req), Number(req.params.id)))
})

company.delete('/vouchers/:id', async (req, res) => {
  await deleteVoucher(cid(req), Number(req.params.id))
  res.status(204).end()
})

company.put('/ledgers/:id/opening-bills', async (req, res) => {
  await setOpeningBills(cid(req), Number(req.params.id), openingBillsBody.parse(req.body))
  res.status(204).end()
})

/** One ledger's pending bills, On Account remainder and closing balance (Ledger Outstandings). */
company.get('/ledgers/:id/outstanding', async (req, res) => {
  const { from, to } = await period(req)
  const ledgerId = Number(req.params.id)
  const exclude = req.query.excludeVoucher ? Number(req.query.excludeVoucher) : undefined
  const b = (await ledgerBalances(pool, cid(req), from, to)).find((x) => x.id === ledgerId)
  if (!b) return res.status(404).json({ error: 'Not found' })
  const bills = (await pendingBills(pool, cid(req), to, ledgerId, exclude)).map((x) => ({ ...x, overdueDays: overdueDays(x, to) }))
  const billed = bills.reduce((t, x) => t + x.pending, 0)
  res.json({ ledger: { id: b.id, name: b.name }, asOf: to, bills, onAccount: b.closing - billed, closing: b.closing })
})

/** Bills receivable or payable, oldest first, with ageing (Outstandings / Overdue). */
company.get('/reports/bills', async (req, res) => {
  const { to } = await period(req)
  const side = z.enum(['receivable', 'payable']).parse(req.query.side ?? 'receivable')
  const report = billsReport(await pendingBills(pool, cid(req), to), side, to)
  if (req.query.overdue === '1') report.bills = report.bills.filter((b) => b.overdueDays > 0)
  res.json(report)
})

/** Group Outstandings: each party ledger under a group, with what is billed, overdue and on account. */
company.get('/reports/group-outstandings', async (req, res) => {
  const { from, to } = await period(req)
  const groups = await loadGroups(pool, cid(req))
  const groupId = req.query.groupId
    ? Number(req.query.groupId)
    : [...groups.values()].find((g) => g.name === 'Sundry Debtors')!.id
  const group = groups.get(groupId)
  if (!group) return res.status(404).json({ error: 'Unknown group' })
  const balances = (await ledgerBalances(pool, cid(req), from, to)).filter(
    (b) => b.groupId !== null && isUnder(groups, b.groupId, [group.name]),
  )
  const bills = await pendingBills(pool, cid(req), to)
  const ledgers = balances
    .filter((b) => b.closing !== 0 || bills.some((x) => x.ledgerId === b.id))
    .map((b) => {
      const mine = bills.filter((x) => x.ledgerId === b.id)
      const billed = mine.reduce((t, x) => t + x.pending, 0)
      const overdue = mine.filter((x) => overdueDays(x, to) > 0).reduce((t, x) => t + x.pending, 0)
      return { id: b.id, name: b.name, closing: b.closing, billed, overdue, onAccount: b.closing - billed }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  res.json({ group: { id: group.id, name: group.name }, asOf: to, ledgers, total: ledgers.reduce((t, l) => t + l.closing, 0) })
})

addBookRoutes(company, cid, period)
addBankRoutes(company, cid, period)
addEditLogRoutes(company, cid)
addInventoryRoutes(company, cid, period)
addGstRoutes(company, cid, period)
addTdsRoutes(company, cid, period)
addForexRoutes(company, cid, period)
addPayrollRoutes(company, cid, period)
addManufacturingRoutes(company, cid)
addMsmeRoutes(company, cid)

/** Import from Excel: { file: the .xlsx or .csv as base64 } of ledgers, stock items or vouchers. */
company.post('/import/:kind', async (req, res) => {
  const kind = z.enum(['ledgers', 'stock-items', 'vouchers']).parse(req.params.kind)
  const { file } = z.object({ file: z.string().min(1) }).parse(req.body)
  res.json(await importSheet(cid(req), kind, Buffer.from(file, 'base64')))
})
/** Split Company Data at { date }: two new companies, up to the day before and from the date. */
company.post('/split', async (req, res) => {
  res.status(201).json(await splitCompany(cid(req), z.object({ date }).parse(req.body).date))
})
/** Tally Audit: the period's vouchers with their audit status; PUT [{ voucherId, status: Audited | Under Observation | null, note }] marks them. */
company.get('/reports/tally-audit', async (req, res) => {
  const p = await period(req)
  res.json({ ...p, ...(await tallyAudit(cid(req), p)) })
})
company.put('/audit', async (req, res) => {
  const items = z.array(z.object({ voucherId: z.number().int(), status: z.enum(['Audited', 'Under Observation']).nullable(), note: z.string().optional() })).parse(req.body)
  await setAudit(cid(req), (res.locals.user as { username?: string } | undefined)?.username ?? 'local user', items)
  res.status(204).end()
})
company.get('/reports/pos-register', async (req, res) => {
  const p = await period(req)
  res.json({ ...p, ...(await posRegister(cid(req), p)) })
})
/** ?type=Sales Order|Purchase Order&by=item|party */
company.get('/reports/order-analysis', async (req, res) => {
  const q = z.object({ type: z.enum(['Sales Order', 'Purchase Order']), by: z.enum(['item', 'party']).default('item') }).parse(req.query)
  res.json(await orderAnalysis(cid(req), q.type, await period(req), q.by))
})
/** Batches: each batch of the items kept in batches, by godown, with expiry, as on ?asOf= (&item=) */
company.get('/reports/batches', async (req, res) => {
  const q = z.object({ asOf: date.optional(), item: z.coerce.number().int().optional() }).parse(req.query)
  res.json({ asOf: q.asOf ?? today(), batches: await batchSummary(pool, cid(req), q.asOf ?? today(), q.item) })
})
/** Cost Tracking: the period's costs and sales of each cost track. */
company.get('/reports/cost-tracks', async (req, res) => {
  const p = await period(req)
  res.json({ ...p, tracks: await costTracks(cid(req), p) })
})
/** A bank's cheque layout (positions in mm on its leaf); null for the standard CTS-2010 one. */
company.get('/ledgers/:id/cheque-layout', async (req, res) => {
  const { rows } = await pool.query(`SELECT c.layout FROM cheque_layouts c JOIN ledgers l ON l.id = c.ledger_id WHERE c.ledger_id = $1 AND l.company_id = $2`, [Number(req.params.id), cid(req)])
  res.json(rows[0]?.layout ?? null)
})
company.put('/ledgers/:id/cheque-layout', async (req, res) => {
  const mm = z.number().min(0).max(300)
  const spot = z.object({ top: mm, left: mm })
  const layout = z.object({ width: mm, height: mm, date: spot, payee: spot, words: spot.extend({ width: mm }), figures: spot, sign: spot, crossing: z.boolean(), dateBox: z.number().min(2).max(12) }).nullable().parse(req.body)
  const id = Number(req.params.id)
  if (!(await pool.query(`SELECT 1 FROM ledgers WHERE id = $1 AND company_id = $2`, [id, cid(req)])).rowCount) throw new ValidationError([`Unknown ledger ${id}`])
  if (!layout) await pool.query(`DELETE FROM cheque_layouts WHERE ledger_id = $1`, [id])
  else await pool.query(`INSERT INTO cheque_layouts (ledger_id, layout) VALUES ($1, $2) ON CONFLICT (ledger_id) DO UPDATE SET layout = $2`, [id, JSON.stringify(layout)])
  res.status(204).end()
})
/** Payment gateway reconciliation: upload a settlement report ({ file: base64 .csv/.xlsx }), see it against the books, post a settlement. */
company.get('/gateways', async (req, res) => res.json(await gateways(cid(req))))
company.post('/gateways/:gateway/report', async (req, res) => {
  const { file } = z.object({ file: z.string().min(1) }).parse(req.body)
  res.json(await importGatewayReport(cid(req), String(req.params.gateway), Buffer.from(file, 'base64')))
})
company.get('/reports/gateway', async (req, res) => {
  const q = z.object({ gateway: z.string().min(1), ledger: z.coerce.number().int().positive() }).parse(req.query)
  const p = await period(req)
  res.json({ ...p, gateway: q.gateway, ...(await gatewayReconciliation(cid(req), q.gateway, q.ledger, p)) })
})
company.post('/gateways/:gateway/settlements/:settlement/post', async (req, res) => {
  const b = z.object({ gatewayLedgerId: z.number().int(), bankLedgerId: z.number().int(), feeLedgerId: z.number().int(), taxLedgerId: z.number().int().nullish() }).parse(req.body)
  res.status(201).json(await postSettlement(cid(req), String(req.params.gateway), String(req.params.settlement), b))
})
/** F12 Configuration */
company.get('/config', async (req, res) => res.json(await getConfig(cid(req))))
company.put('/config', async (req, res) => {
  await setConfig(cid(req), z.record(z.unknown()).parse(req.body))
  res.json(await getConfig(cid(req)))
})
addBudgetRoutes(company, cid, period)
addEDocRoutes(company, cid, period)
addIntelligenceRoutes(company, cid)
addMailRoutes(company, cid)
addVoucherTypeRoutes(company, cid, period)
addCostCentreRoutes(company, cid, period)

company.get('/reports/:report', async (req, res) => {
  const { from, to } = await period(req)
  const groups = await loadGroups(pool, cid(req))
  // ?scenario=: the books as a scenario sees them
  const scenarioId = req.query.scenario ? Number(req.query.scenario) : null
  const scenario = scenarioId ? await scenarioView(pool, cid(req), scenarioId, to) : null
  const balances = await ledgerBalances(pool, cid(req), from, to, scenario)
  const build = {
    'trial-balance': trialBalance,
    'profit-loss': profitAndLoss,
    'balance-sheet': balanceSheet,
  }[req.params.report]
  if (!build) return res.status(404).json({ error: 'Unknown report' })
  res.json({ from, to, ...(scenario ? { scenario: scenario.name } : {}), ...build(groups, balances) })
})
