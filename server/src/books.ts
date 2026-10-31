import { pool, runAs, withTx, type Tx } from './db'
import { today } from './engine/clock'
import { DEFAULT_GROUPS, DEFAULT_LEDGERS, PROFIT_AND_LOSS, primaryOf, isUnder, type GroupNode } from './engine/groups'
import type { LedgerBalance } from './engine/reports'
import type { PendingBill } from './engine/bills'
import { validateInventory } from './engine/inventory'
import { countToDifference, insertInventory, inventoryRefs, linkErrors, madeAgainst, stockTotals, batchErrors } from './inventory'
import { isDraft, isHeld, validateVoucher, type LedgerRef, type VoucherInput } from './engine/voucher'
import { checkLedgerTds } from './tds'
import { checkLedgerCurrency, loadCurrencies } from './forex'
import { splitForex } from './engine/forex'
import type { DeducteeType } from './engine/tds'
import { gstBreakup, gstinError, stateCode, stateName, type GstBreakup, type GstContext, type GstItem, type GstLedger, type Taxability, type TaxType } from './engine/gst'
import { formatDocNo, fyStartOf, type NumberingRule } from './engine/numbering'

/** A rule failure the caller can show to the user (HTTP 422). */
export class ValidationError extends Error {
  constructor(public errors: string[]) {
    super(errors.join('; '))
  }
}

type Db = Tx | typeof pool

// ------------------------------------------------------------------ companies

export interface CompanyInput {
  name: string
  booksBegin: string // yyyy-mm-dd
  fyStart?: string
  state?: string
  gstin?: string
}

/** Create a company with the default chart of groups and the Cash and Profit & Loss ledgers. */
export async function createCompany(input: CompanyInput) {
  return withTx(async (tx) => {
    const { rows } = await tx.query<{ id: number }>(
      `INSERT INTO companies (name, books_begin, fy_start, state, gstin) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [input.name, input.booksBegin, input.fyStart ?? input.booksBegin, input.state ?? null, input.gstin ?? null],
    )
    const companyId = rows[0].id
    const ids = new Map<string, number>()
    for (const g of DEFAULT_GROUPS) {
      const r = await tx.query<{ id: number }>(
        `INSERT INTO groups (company_id, name, parent_id, nature, affects_gross_profit, is_default)
         VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
        [companyId, g.name, g.parent ? ids.get(g.parent) : null, g.nature, g.affectsGrossProfit],
      )
      ids.set(g.name, r.rows[0].id)
    }
    for (const l of DEFAULT_LEDGERS)
      await tx.query(`INSERT INTO ledgers (company_id, name, group_id, is_default) VALUES ($1,$2,$3,true)`, [
        companyId,
        l.name,
        l.group ? ids.get(l.group) : null,
      ])
    await tx.query(`INSERT INTO godowns (company_id, name, is_default) VALUES ($1, 'Main Location', true)`, [companyId])
    await tx.query(`INSERT INTO cost_categories (company_id, name, is_default) VALUES ($1, 'Primary Cost Category', true)`, [companyId])
    return companyId
  })
}

export async function getCompany(db: Db, companyId: number) {
  const { rows } = await db.query(
    `SELECT id, name, to_char(books_begin,'YYYY-MM-DD') "booksBegin", to_char(fy_start,'YYYY-MM-DD') "fyStart",
            state, gstin, mailing_name "mailingName", address, pincode, phone, email, gst_type "gstType", composition_rate "compositionRate" FROM companies WHERE id = $1`,
    [companyId],
  )
  return rows[0] as
    | (CompanyDetails & { id: number; name: string; booksBegin: string; fyStart: string; state: string | null; gstin: string | null; gstType: 'Regular' | 'Composition'
        compositionRate: number | null })
    | undefined
}

/** The company's mailing details: the seller block of invoices, e-Invoices and e-Way Bills. */
export interface CompanyDetails {
  mailingName: string | null
  address: string | null
  pincode: string | null
  phone: string | null
  email: string | null
}
export async function setCompanyDetails(companyId: number, d: Partial<CompanyDetails>) {
  const clean = (s?: string | null) => s?.trim() || null
  const errors: string[] = []
  if (clean(d.pincode) && !/^[1-9][0-9]{5}$/.test(clean(d.pincode)!)) errors.push('An Indian PIN code has six digits')
  if (clean(d.email) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean(d.email)!)) errors.push(`"${d.email}" is not an e-mail address`)
  if (errors.length) throw new ValidationError(errors)
  await pool.query(`UPDATE companies SET mailing_name = $2, address = $3, pincode = $4, phone = $5, email = $6 WHERE id = $1`, [
    companyId, clean(d.mailingName), d.address?.split('\n').map((l) => l.trim()).filter(Boolean).join('\n') || null, clean(d.pincode), clean(d.phone), clean(d.email),
  ])
}

/** Last day of the financial year that starts on `fyStart` (2026-04-01 -> 2027-03-31). */
export function fyEnd(fyStart: string) {
  const d = new Date(fyStart + 'T00:00:00Z')
  d.setUTCFullYear(d.getUTCFullYear() + 1)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

// ------------------------------------------------------------------ masters

export async function loadGroups(db: Db, companyId: number) {
  const { rows } = await db.query(
    `SELECT id, name, parent_id "parentId", nature, affects_gross_profit "affectsGrossProfit"
       FROM groups WHERE company_id = $1 ORDER BY id`,
    [companyId],
  )
  return new Map<number, GroupNode>(rows.map((g: GroupNode) => [g.id, g]))
}

export async function loadLedgers(db: Db, companyId: number) {
  const { rows } = await db.query(
    `SELECT id, name, group_id "groupId", billwise, cost_centres "costCentres", interest_rate "interestRate", currency_id "currencyId", country FROM ledgers WHERE company_id = $1 ORDER BY id`,
    [companyId],
  )
  return new Map<number, LedgerRef>(rows.map((l: LedgerRef) => [l.id, l]))
}

export interface GroupInput {
  name: string
  parentId: number
}

/** A user group always sits under an existing group and inherits its nature. */
export async function createGroup(companyId: number, input: GroupInput) {
  const groups = await loadGroups(pool, companyId)
  const parent = groups.get(input.parentId)
  if (!parent) throw new ValidationError([`Unknown parent group ${input.parentId}`])
  const p = primaryOf(groups, parent.id)
  const { rows } = await pool
    .query<{ id: number }>(
      `INSERT INTO groups (company_id, name, parent_id, nature, affects_gross_profit) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [companyId, input.name.trim(), parent.id, p.nature, p.affectsGrossProfit],
    )
    .catch(uniqueName(input.name))
  return rows[0].id
}

export interface LedgerInput {
  name: string
  groupId: number
  opening?: number // paise, + Dr
  gstin?: string
  state?: string
  /** keep the balance bill by bill; defaults to yes under Sundry Debtors / Creditors */
  billwise?: boolean
  creditDays?: number | null
  /** for a tax ledger under Duties & Taxes: which GST it holds */
  gstTaxType?: TaxType | null
  /** GST rate (hundredths of a percent) and HSN/SAC for a taxable ledger (services sales, freight) */
  gstRate?: number | null
  /** compensation cess rate (hundredths of a percent) on a taxable ledger */
  cessRate?: number | null
  hsn?: string | null
  /** split this ledger's entries across cost centres */
  costCentres?: boolean
  /** interest calculation: yearly rate in hundredths of a percent (null = off), on the balance or on overdue bills */
  interestRate?: number | null
  interestOn?: 'balance' | 'bills'
  /** mailing details (Tally's ledger "Mailing Details" and PAN) */
  mailingName?: string | null
  address?: string | null
  pincode?: string | null
  country?: string | null
  phone?: string | null
  email?: string | null
  pan?: string | null
  /** GST on this purchase or expense ledger is paid by the buyer (reverse charge) */
  reverseCharge?: boolean
  /** a GST Classification: its HSN/SAC, rate and taxability replace the ledger's own */
  gstClassificationId?: number | null
  /** Exempt, Nil Rated or Non-GST supplies bear no tax; absent is taxable */
  taxability?: Taxability | null
  /** TDS: the nature of payment an expense ledger books (or a TDS ledger under Duties & Taxes holds) */
  tdsNatureId?: number | null
  /** TDS: a party ledger's deductee type; absent, no TDS is deducted from it */
  deducteeType?: DeducteeType | null
  /** kept in a foreign currency; its opening balance in that currency (smallest unit, + Dr) */
  currencyId?: number | null
  openingForex?: number
}

/** A ledger's GST, interest and mailing details: a valid GSTIN, a known state, a tax type only on a tax ledger, real rates, a valid PAN, PIN code and e-mail. */
function ledgerExtraErrors(groups: Map<number, GroupNode>, input: LedgerInput) {
  const errors: string[] = []
  const gstin = input.gstin?.trim()
  if (gstin) {
    const e = gstinError(gstin)
    if (e) errors.push(e)
  }
  if (input.state?.trim() && !stateCode(input.state)) errors.push(`"${input.state}" is not a GST state`)
  if (input.gstTaxType && !isUnder(groups, input.groupId, ['Duties & Taxes'])) errors.push('Only a ledger under Duties & Taxes can be a GST tax ledger')
  if (input.reverseCharge && (primaryOf(groups, input.groupId).nature !== 'Expenses'))
    errors.push('Reverse charge goes on a purchase or expense ledger')
  if (input.gstRate != null && (!Number.isInteger(input.gstRate) || input.gstRate < 0 || input.gstRate > 10000)) errors.push('GST rate must be between 0% and 100%')
  if (input.cessRate != null && (!Number.isInteger(input.cessRate) || input.cessRate < 0 || input.cessRate > 100000)) errors.push('Cess rate must be between 0% and 1000%')
  if (input.interestRate != null && (!Number.isInteger(input.interestRate) || input.interestRate <= 0 || input.interestRate > 100000))
    errors.push('Interest rate must be above 0% and at most 1000% a year')
  if (input.interestOn === 'bills' && input.interestRate && !billwiseFor(groups, input)) errors.push('Interest on bills needs bill-wise details on the ledger')
  const pan = input.pan?.trim().toUpperCase()
  if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) errors.push(`"${input.pan}" is not a PAN (five letters, four digits, a letter)`)
  const india = !input.country?.trim() || /^india$/i.test(input.country.trim())
  if (input.pincode?.trim() && india && !/^[1-9][0-9]{5}$/.test(input.pincode.trim())) errors.push(`"${input.pincode}" is not a PIN code`)
  if (input.email?.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email.trim())) errors.push(`"${input.email}" is not an e-mail address`)
  // a party's PAN is the middle of its GSTIN
  if (pan && gstin && gstin.length === 15 && gstin.toUpperCase().slice(2, 12) !== pan) errors.push('The PAN does not match the GSTIN')
  return errors
}
const ledgerExtraValues = (input: LedgerInput) => [
  input.gstin?.trim().toUpperCase() || null,
  input.state?.trim() ? (stateName(stateCode(input.state)) ?? null) : null,
  input.gstTaxType ?? null,
  input.gstRate ?? null,
  input.hsn?.trim() || null,
  !!input.costCentres,
  input.interestRate ?? null,
  input.interestOn ?? 'balance',
  input.mailingName?.trim() || null,
  input.address?.trim() || null,
  input.pincode?.trim() || null,
  input.country?.trim() || null,
  input.phone?.trim() || null,
  input.email?.trim() || null,
  input.pan?.trim().toUpperCase() || null,
  !!input.reverseCharge,
  input.gstClassificationId ?? null,
  input.taxability && input.taxability !== 'Taxable' ? input.taxability : null,
  input.tdsNatureId ?? null,
  input.deducteeType ?? null,
  input.currencyId ?? null,
  input.currencyId != null ? (input.openingForex ?? 0) : 0,
  input.cessRate || null,
]

/** A GST Classification picked on a ledger or stock item must be one of the company's. */
export async function checkClassification(db: Db, companyId: number, id: number | null | undefined) {
  if (id == null) return
  if (!(await db.query(`SELECT 1 FROM gst_classifications WHERE id = $1 AND company_id = $2`, [id, companyId])).rowCount)
    throw new ValidationError([`Unknown GST classification ${id}`])
}

const PARTY_GROUPS = ['Sundry Debtors', 'Sundry Creditors']
const billwiseFor = (groups: Map<number, GroupNode>, input: LedgerInput) =>
  input.billwise ?? isUnder(groups, input.groupId, PARTY_GROUPS)
function checkCreditDays(d: number | null | undefined) {
  if (d !== undefined && d !== null && (!Number.isInteger(d) || d < 0 || d > 3650))
    throw new ValidationError(['Credit period must be a whole number of days'])
}

export async function createLedger(companyId: number, input: LedgerInput) {
  const groups = await loadGroups(pool, companyId)
  if (!groups.has(input.groupId)) throw new ValidationError([`Unknown group ${input.groupId}`])
  const opening = input.opening ?? 0
  if (!Number.isSafeInteger(opening)) throw new ValidationError(['Opening balance must be whole paise'])
  if (opening !== 0 && ['Income', 'Expenses'].includes(primaryOf(groups, input.groupId).nature))
    throw new ValidationError(['Income and expense ledgers cannot carry an opening balance'])
  checkCreditDays(input.creditDays)
  const gstErrors = ledgerExtraErrors(groups, input)
  if (gstErrors.length) throw new ValidationError(gstErrors)
  await checkClassification(pool, companyId, input.gstClassificationId)
  await checkLedgerTds(pool, companyId, input.groupId, input.tdsNatureId, input.deducteeType)
  await checkLedgerCurrency(pool, companyId, groups, input)
  const { rows } = await pool
    .query<{ id: number }>(
      `INSERT INTO ledgers (company_id, name, group_id, opening, billwise, credit_days, gstin, state, gst_tax_type, gst_rate, hsn, cost_centres, interest_rate, interest_on,
                            mailing_name, address, pincode, country, phone, email, pan, reverse_charge, gst_classification_id, taxability, tds_nature_id, deductee_type,
                            currency_id, opening_forex, cess_rate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29) RETURNING id`,
      [companyId, input.name.trim(), input.groupId, opening, billwiseFor(groups, input), input.creditDays ?? null, ...ledgerExtraValues(input)],
    )
    .catch(uniqueName(input.name))
  return rows[0].id
}

export async function setStockValue(companyId: number, ledgerId: number, asOf: string, value: number) {
  const groups = await loadGroups(pool, companyId)
  const l = (await loadLedgers(pool, companyId)).get(ledgerId)
  if (!l || l.groupId === null || !isUnder(groups, l.groupId, ['Stock-in-Hand']))
    throw new ValidationError(['Closing stock can only be set on a Stock-in-Hand ledger'])
  await pool.query(
    `INSERT INTO stock_values (ledger_id, as_of, value) VALUES ($1,$2,$3)
     ON CONFLICT (ledger_id, as_of) DO UPDATE SET value = EXCLUDED.value`,
    [ledgerId, asOf, value],
  )
}

// ------------------------------------------------------------------ alter / delete masters

async function lockLedger(tx: Tx, companyId: number, id: number) {
  const { rows } = await tx.query<{ name: string; groupId: number | null; isDefault: boolean }>(
    `SELECT name, group_id "groupId", is_default "isDefault" FROM ledgers WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [id, companyId],
  )
  if (!rows[0]) throw new ValidationError([`Unknown ledger ${id}`])
  return rows[0]
}

const hasEntries = async (tx: Tx, ledgerId: number) =>
  (await tx.query(`SELECT 1 FROM entries WHERE ledger_id = $1 LIMIT 1`, [ledgerId])).rowCount! > 0

/**
 * Change a ledger's name, group, opening balance or party details. Refused when the move
 * would break a rule the books rely on (see the messages below).
 */
export async function alterLedger(companyId: number, id: number, input: LedgerInput) {
  return withTx(async (tx) => {
    const cur = await lockLedger(tx, companyId, id)
    const opening = input.opening ?? 0
    if (!Number.isSafeInteger(opening)) throw new ValidationError(['Opening balance must be whole paise'])
    const name = input.name.trim()

    if (cur.groupId === null) {
      // the primary Profit & Loss A/c: reports find it by name and it has no group
      if (name !== cur.name) throw new ValidationError([`${cur.name} cannot be renamed`])
      await tx.query(`UPDATE ledgers SET opening = $2 WHERE id = $1`, [id, opening])
      return
    }

    const groups = await loadGroups(tx, companyId)
    if (!groups.has(input.groupId)) throw new ValidationError([`Unknown group ${input.groupId}`])
    const errors: string[] = []
    if (opening !== 0 && ['Income', 'Expenses'].includes(primaryOf(groups, input.groupId).nature))
      errors.push('Income and expense ledgers cannot carry an opening balance')
    const toStock = isUnder(groups, input.groupId, ['Stock-in-Hand'])
    const fromStock = isUnder(groups, cur.groupId, ['Stock-in-Hand'])
    if (toStock && !fromStock && (await hasEntries(tx, id)))
      errors.push('A ledger with vouchers cannot move under Stock-in-Hand')
    if (fromStock && !toStock && (await tx.query(`SELECT 1 FROM stock_values WHERE ledger_id = $1 LIMIT 1`, [id])).rowCount)
      errors.push('This ledger has closing stock values; it must stay under Stock-in-Hand')
    const billwise = billwiseFor(groups, input)
    const hasBills = await tx.query(
      `SELECT 1 FROM bill_allocations WHERE ledger_id = $1 UNION ALL SELECT 1 FROM opening_bills WHERE ledger_id = $1 LIMIT 1`,
      [id],
    )
    if (!billwise && hasBills.rowCount) errors.push('This ledger has bill-wise details; it must keep maintaining bills')
    if (!input.costCentres && (await tx.query(`SELECT 1 FROM cost_allocations a JOIN entries e ON e.id = a.entry_id WHERE e.ledger_id = $1 LIMIT 1`, [id])).rowCount)
      errors.push('This ledger has entries split across cost centres; cost centres must stay applicable')
    checkCreditDays(input.creditDays)
    errors.push(...ledgerExtraErrors(groups, input))
    if (errors.length) throw new ValidationError(errors)
    await checkClassification(tx, companyId, input.gstClassificationId)
    await checkLedgerTds(tx, companyId, input.groupId, input.tdsNatureId, input.deducteeType)
    await checkLedgerCurrency(tx, companyId, groups, input, id)

    await tx
      .query(
        `UPDATE ledgers SET name = $2, group_id = $3, opening = $4, billwise = $5, credit_days = $6,
                gstin = $7, state = $8, gst_tax_type = $9, gst_rate = $10, hsn = $11, cost_centres = $12, interest_rate = $13, interest_on = $14,
                mailing_name = $15, address = $16, pincode = $17, country = $18, phone = $19, email = $20, pan = $21, reverse_charge = $22,
                gst_classification_id = $23, taxability = $24, tds_nature_id = $25, deductee_type = $26, currency_id = $27, opening_forex = $28, cess_rate = $29 WHERE id = $1`,
        [id, name, input.groupId, opening, billwise, input.creditDays ?? null, ...ledgerExtraValues(input)],
      )
      .catch(uniqueName(name))
  })
}

export async function deleteLedger(companyId: number, id: number) {
  return withTx(async (tx) => {
    const cur = await lockLedger(tx, companyId, id)
    if (cur.groupId === null) throw new ValidationError([`${cur.name} cannot be deleted`])
    if (await hasEntries(tx, id)) throw new ValidationError([`${cur.name} has vouchers and cannot be deleted`])
    await tx.query(`DELETE FROM ledgers WHERE id = $1`, [id]) // stock values and daily rows cascade
  })
}

async function lockGroup(tx: Tx, companyId: number, id: number) {
  const { rows } = await tx.query<{ name: string; isDefault: boolean }>(
    `SELECT name, is_default "isDefault" FROM groups WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [id, companyId],
  )
  if (!rows[0]) throw new ValidationError([`Unknown group ${id}`])
  if (rows[0].isDefault) throw new ValidationError([`${rows[0].name} is a predefined group and cannot be changed`])
  return rows[0]
}

/** Rename or move a user group; its nature (and that of everything beneath it) follows the new parent. */
export async function alterGroup(companyId: number, id: number, input: GroupInput) {
  return withTx(async (tx) => {
    await lockGroup(tx, companyId, id)
    const groups = await loadGroups(tx, companyId)
    const parent = groups.get(input.parentId)
    if (!parent) throw new ValidationError([`Unknown parent group ${input.parentId}`])
    if (isBelow(groups, parent.id, id))
      throw new ValidationError(['A group cannot sit under itself or one of its own sub-groups'])

    const p = primaryOf(groups, parent.id)
    const subtree = (
      await tx.query<{ id: number }>(
        `WITH RECURSIVE t AS (SELECT id FROM groups WHERE id = $1
                              UNION ALL SELECT g.id FROM groups g JOIN t ON g.parent_id = t.id)
         SELECT id FROM t`,
        [id],
      )
    ).rows.map((r) => r.id)
    const errors: string[] = []
    if (['Income', 'Expenses'].includes(p.nature)) {
      const { rows } = await tx.query(`SELECT name FROM ledgers WHERE group_id = ANY($1) AND opening <> 0 LIMIT 3`, [subtree])
      if (rows.length) errors.push(`Ledgers with opening balances can't move under ${p.name}: ${rows.map((r) => r.name).join(', ')}`)
    }
    if (isUnder(groups, parent.id, ['Stock-in-Hand'])) {
      const { rows } = await tx.query(
        `SELECT DISTINCT l.name FROM ledgers l JOIN entries e ON e.ledger_id = l.id WHERE l.group_id = ANY($1) LIMIT 3`,
        [subtree],
      )
      if (rows.length) errors.push(`Ledgers with vouchers can't move under Stock-in-Hand: ${rows.map((r) => r.name).join(', ')}`)
    }
    if (errors.length) throw new ValidationError(errors)

    await tx
      .query(`UPDATE groups SET name = $2, parent_id = $3 WHERE id = $1`, [id, input.name.trim(), parent.id])
      .catch(uniqueName(input.name))
    await tx.query(`UPDATE groups SET nature = $2, affects_gross_profit = $3 WHERE id = ANY($1)`, [
      subtree,
      p.nature,
      p.affectsGrossProfit,
    ])
  })
}

/** True if `id` is `ancestorId` or sits beneath it. */
function isBelow(groups: Map<number, GroupNode>, id: number, ancestorId: number) {
  for (let g = groups.get(id); g; g = g.parentId === null ? undefined : groups.get(g.parentId)) if (g.id === ancestorId) return true
  return false
}

export async function deleteGroup(companyId: number, id: number) {
  return withTx(async (tx) => {
    const g = await lockGroup(tx, companyId, id)
    const used =
      (await tx.query(`SELECT 1 FROM groups WHERE parent_id = $1 LIMIT 1`, [id])).rowCount! +
      (await tx.query(`SELECT 1 FROM ledgers WHERE group_id = $1 LIMIT 1`, [id])).rowCount!
    if (used) throw new ValidationError([`${g.name} still has groups or ledgers under it`])
    await tx.query(`DELETE FROM groups WHERE id = $1`, [id])
  })
}

export async function getLedger(db: Db, companyId: number, id: number) {
  const { rows } = await db.query(
    `SELECT id, name, group_id "groupId", opening, gstin, state, is_default "isDefault", billwise, credit_days "creditDays",
            gst_tax_type "gstTaxType", gst_rate "gstRate", cess_rate "cessRate", hsn, cost_centres "costCentres", interest_rate "interestRate", interest_on "interestOn",
            mailing_name "mailingName", address, pincode, country, phone, email, pan, reverse_charge "reverseCharge",
            gst_classification_id "gstClassificationId", COALESCE(taxability, 'Taxable') taxability,
            tds_nature_id "tdsNatureId", deductee_type "deducteeType", currency_id "currencyId", opening_forex::float8 "openingForex",
            COALESCE((SELECT json_agg(json_build_object('name', ob.name, 'billDate', to_char(ob.bill_date,'YYYY-MM-DD'),
                        'dueDate', to_char(ob.due_date,'YYYY-MM-DD'), 'amount', ob.amount) ORDER BY ob.bill_date, ob.id)
                        FROM opening_bills ob WHERE ob.ledger_id = ledgers.id), '[]') "openingBills"
       FROM ledgers WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  )
  return rows[0]
}

function uniqueName(name: string) {
  return (err: { code?: string }) => {
    if (err.code === '23505') throw new ValidationError([`The name "${name}" is already used`])
    throw err
  }
}

// ------------------------------------------------------------------ vouchers

async function validationContext(tx: Tx, companyId: number) {
  const company = await getCompany(tx, companyId)
  if (!company) throw new ValidationError([`Unknown company ${companyId}`])
  return {
    ledgers: await loadLedgers(tx, companyId),
    groups: await loadGroups(tx, companyId),
    booksBeginFrom: company.booksBegin,
    centres: new Map((await tx.query<{ id: number; name: string }>(`SELECT id, name FROM cost_centres WHERE company_id = $1`, [companyId])).rows.map((c) => [c.id, c.name])),
    currencies: await loadCurrencies(tx, companyId),
    employees: new Set((await tx.query<{ id: number }>(`SELECT id FROM cost_centres WHERE company_id = $1 AND kind = 'employee'`, [companyId])).rows.map((r) => r.id)),
    attendanceTypes: new Map((await tx.query<{ id: number; name: string }>(`SELECT id, name FROM attendance_types WHERE company_id = $1`, [companyId])).rows.map((r) => [r.id, r.name])),
    ...(await inventoryRefs(tx, companyId)),
    gst: await gstContext(tx, companyId, company),
    // a voucher type of a further GST registration taxes its vouchers from that registration's state
    typeRegistration: new Map((await tx.query<{ id: number; gstin: string; state: string }>(
      `SELECT t.id, r.gstin, r.state FROM voucher_types t JOIN gst_registrations r ON r.id = t.gst_registration_id WHERE t.company_id = $1`, [companyId],
    )).rows.map((r) => [r.id, { gstin: r.gstin, state: r.state }])),
  }
}

type Context = Awaited<ReturnType<typeof validationContext>>
/** A checked voucher with its GST breakup, ready to insert. */
type Draft = { entries: (VoucherInput['entries'][number] & { ledger: string })[]; inventory?: VoucherInput['inventory']; partyId?: number | null }
type Posting = VoucherInput & { gst: GstBreakup | null; draft: Draft | null; held: boolean }
/**
 * A checked voucher ready to insert: its GST breakup, or for an optional or memorandum voucher
 * its lines as a draft (with ledger names, for lists) and nothing for the books.
 */
function withGst(v: VoucherInput, ctx: Context, typeId = v.voucherTypeId): Posting {
  const reg = typeId ? ctx.typeRegistration.get(typeId) : undefined
  const gst = reg ? { ...ctx.gst, companyGstin: reg.gstin, companyState: reg.state } : ctx.gst
  if (!isDraft(v)) return { ...v, gst: gstBreakup(v, gst), draft: null, held: false }
  const draft: Draft = {
    entries: v.entries.map((e) => ({ ...e, ledger: ctx.ledgers.get(e.ledgerId)?.name ?? '' })),
    ...(v.inventory?.length ? { inventory: v.inventory } : {}),
    ...(v.partyId != null ? { partyId: v.partyId } : {}),
  }
  return { ...v, entries: [], inventory: undefined, gst: null, draft, held: isHeld(v) }
}

/** What GST needs to know about a company's ledgers and items. */
export async function gstContext(db: Db, companyId: number, company?: { gstin: string | null; state: string | null }): Promise<GstContext> {
  const c = company ?? (await getCompany(db, companyId))!
  const groups = await loadGroups(db, companyId)
  const ledgers = (await db.query<GstLedger & { groupId: number | null }>(
    `SELECT l.id, l.name, l.group_id "groupId", l.gstin, l.state, l.gst_tax_type "taxType", country, reverse_charge "reverseCharge",
            CASE WHEN c.id IS NULL THEN l.gst_rate ELSE c.gst_rate END "rate", CASE WHEN c.id IS NULL THEN l.hsn ELSE c.hsn END hsn,
            CASE WHEN c.id IS NULL THEN l.taxability ELSE c.taxability END taxability, COALESCE(c.cess_rate, l.cess_rate) "cessRate"
       FROM ledgers l LEFT JOIN gst_classifications c ON c.id = l.gst_classification_id WHERE l.company_id = $1`,
    [companyId],
  )).rows
  const items = (await db.query<GstItem>(
    `SELECT s.id, s.name, CASE WHEN c.id IS NULL THEN s.hsn ELSE c.hsn END hsn, CASE WHEN c.id IS NULL THEN s.gst_rate ELSE c.gst_rate END "rate",
            CASE WHEN c.id IS NULL THEN s.taxability ELSE c.taxability END taxability, COALESCE(c.cess_rate, s.cess_rate) "cessRate",
            COALESCE(su.symbol, u.symbol) unit, COALESCE(su.uqc, su.symbol, u.uqc, u.symbol) uqc
       FROM stock_items s JOIN units u ON u.id = s.unit_id LEFT JOIN units su ON su.id = u.second_unit_id
            LEFT JOIN gst_classifications c ON c.id = s.gst_classification_id WHERE s.company_id = $1`,
    [companyId],
  )).rows
  return {
    companyGstin: c.gstin,
    companyState: c.state,
    ledgers: new Map(ledgers.map(({ groupId, ...l }) => [l.id, { ...l, group: gstGroup(groups, groupId) }])),
    items: new Map(items.map((i) => [i.id, i])),
  }
}

/** The group GST cares about: the nearest of the predefined ones that matter, else the top group. */
const GST_GROUPS = ['Sales Accounts', 'Purchase Accounts', 'Duties & Taxes', 'Sundry Debtors', 'Sundry Creditors', 'Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c']
function gstGroup(groups: Map<number, GroupNode>, groupId: number | null) {
  let g = groupId === null ? undefined : groups.get(groupId)
  let top = ''
  for (; g; g = g.parentId === null ? undefined : groups.get(g.parentId)) {
    if (GST_GROUPS.includes(g.name)) return g.name
    top = g.name
  }
  return top
}

/** Set the company's GST registration: a valid GSTIN and its state (the GSTIN's own). */
export async function setCompanyGst(companyId: number, input: { gstin?: string | null; state?: string | null; gstType?: 'Regular' | 'Composition'; compositionRate?: number | null }) {
  const gstin = input.gstin?.trim().toUpperCase() || null
  const errors: string[] = []
  const bad = gstin ? gstinError(gstin) : null
  if (bad) errors.push(bad)
  if (input.state?.trim() && !stateCode(input.state)) errors.push(`"${input.state}" is not a GST state`)
  const code = stateCode(input.state) ?? (gstin && !bad ? gstin.slice(0, 2) : undefined)
  if (gstin && !bad && code && gstin.slice(0, 2) !== code)
    errors.push(`The GSTIN is registered in ${stateName(gstin.slice(0, 2))}, not ${stateName(code)}`)
  const composition = input.gstType === 'Composition'
  if (composition && (input.compositionRate == null || !Number.isInteger(input.compositionRate) || input.compositionRate <= 0 || input.compositionRate > 1000))
    errors.push('A composition dealer pays at a rate above 0% and up to 10% (1% for traders and manufacturers, 5% restaurants, 6% services)')
  if (errors.length) throw new ValidationError(errors)
  await pool.query(`UPDATE companies SET gstin = $2, state = $3 WHERE id = $1`, [companyId, gstin, stateName(code) ?? null])
  if (input.gstType)
    await pool.query(`UPDATE companies SET gst_type = $2, composition_rate = $3 WHERE id = $1`, [companyId, input.gstType, composition ? input.compositionRate : null])
}

/** Accounting rules, then (for item invoices) the inventory rules, and an Attendance voucher's employees and types. */
function checkVoucher(v: VoucherInput, ctx: Context) {
  const errors = validateVoucher(v, ctx)
  if (errors.length) return errors
  if (v.type === 'Attendance') {
    const seen = new Set<string>()
    for (const [i, a] of v.attendance!.entries()) {
      if (!ctx.employees.has(a.employeeId)) errors.push(`Line ${i + 1}: unknown employee ${a.employeeId}`)
      if (!ctx.attendanceTypes.has(a.typeId)) errors.push(`Line ${i + 1}: unknown attendance or production type ${a.typeId}`)
      const key = `${a.employeeId}/${a.typeId}`
      if (seen.has(key)) errors.push(`Line ${i + 1}: ${ctx.centres.get(a.employeeId)} has ${ctx.attendanceTypes.get(a.typeId)} twice`)
      seen.add(key)
    }
    return errors
  }
  return validateInventory(v, ctx)
}

async function insertAttendance(tx: Tx, voucherId: number, v: VoucherInput) {
  const lines = v.attendance!
  await tx.query(
    `INSERT INTO attendance_entries (voucher_id, line, employee_id, attendance_type_id, value) VALUES ${lines.map((_, i) => `($1,${i + 1},$${i * 3 + 2},$${i * 3 + 3},$${i * 3 + 4})`).join(',')}`,
    [voucherId, ...lines.flatMap((a) => [a.employeeId, a.typeId, a.value])],
  )
}

/** All of a voucher's entries in one multi-row INSERT, then their bill allocations. */
async function insertEntries(tx: Tx, voucherId: number, v: VoucherInput) {
  const params: unknown[] = []
  const values = v.entries.map((e, i) => {
    params.push(voucherId, i + 1, e.ledgerId, e.amount, e.chequeNo?.trim() || null, e.chequeDate ?? null, e.forex ?? null, e.forex ? e.forexRate : null)
    const b = i * 8
    return `(${Array.from({ length: 8 }, (_, c) => `$${b + c + 1}`).join(',')})`
  })
  const { rows } = await tx.query<{ id: number; line: number }>(
    `INSERT INTO entries (voucher_id, line, ledger_id, amount, instrument_no, instrument_date, forex, forex_rate) VALUES ${values.join(',')} RETURNING id, line`,
    params,
  )
  const idOfLine = new Map(rows.map((r) => [r.line, r.id]))
  await insertAllocations(tx, v.entries.map((e, i) => ({ entryId: idOfLine.get(i + 1)!, entry: e })))
}

/** Bill allocations and cost centre splits for entries that carry them, an INSERT for each. */
async function insertAllocations(tx: Tx, items: { entryId: number; entry: VoucherInput['entries'][number] }[]) {
  const costs = items.flatMap(({ entryId, entry }) => (entry.costs ?? []).map((c) => [entryId, c.centreId, c.amount]))
  for (let at = 0; at < costs.length; at += 3000) {
    const chunk = costs.slice(at, at + 3000)
    await tx.query(
      `INSERT INTO cost_allocations (entry_id, cost_centre_id, amount) VALUES ${chunk.map((_, j) => `($${j * 3 + 1},$${j * 3 + 2},$${j * 3 + 3})`).join(',')}`,
      chunk.flat(),
    )
  }
  const params: unknown[] = []
  const values: string[] = []
  for (const { entryId, entry } of items) {
    const forex = splitForex(entry.forex, entry.amount, entry.bills ?? [])
    for (const [i, b] of (entry.bills ?? []).entries()) {
      const k = params.length
      params.push(entryId, entry.ledgerId, b.type, b.type === 'On Account' ? null : b.name!.trim(), b.dueDate ?? null, b.amount, forex[i])
      values.push(`($${k + 1},$${k + 2},$${k + 3},$${k + 4},$${k + 5},$${k + 6},$${k + 7})`)
    }
  }
  if (values.length)
    await tx.query(
      `INSERT INTO bill_allocations (entry_id, ledger_id, ref_type, name, due_date, amount, forex) VALUES ${values.join(',')}`,
      params,
    )
}

/**
 * Which bill names each bill-wise ledger already has, so references can be checked:
 * a New Ref or Advance must start a new bill; an Agst Ref must name an existing one.
 * Within a batch, bills started by earlier vouchers count too.
 */
class BillNames {
  private names = new Map<number, Set<string>>()
  static async load(tx: Tx, ledgerIds: number[]) {
    const book = new BillNames()
    if (!ledgerIds.length) return book
    const { rows } = await tx.query<{ ledger_id: number; name: string }>(
      // only a New Ref, an Advance or an opening bill starts a bill; an Agst Ref just refers to one
      `SELECT ledger_id, lower(name) "name" FROM bill_allocations WHERE ledger_id = ANY($1) AND name IS NOT NULL AND ref_type <> 'Agst Ref'
       UNION SELECT ledger_id, lower(name) FROM opening_bills WHERE ledger_id = ANY($1)`,
      [ledgerIds],
    )
    for (const r of rows) book.set(r.ledger_id).add(r.name)
    return book
  }
  private set(ledgerId: number) {
    let s = this.names.get(ledgerId)
    if (!s) this.names.set(ledgerId, (s = new Set()))
    return s
  }
  /** Errors for this voucher's references; on success, its new bills are remembered. */
  check(v: VoucherInput, ledgers: Map<number, LedgerRef>): string[] {
    const errors: string[] = []
    const started: [number, string][] = []
    for (const e of v.entries)
      for (const b of e.bills ?? []) {
        if (b.type === 'On Account') continue
        const key = b.name!.trim().toLowerCase()
        const known = this.set(e.ledgerId).has(key)
        const who = ledgers.get(e.ledgerId)?.name ?? e.ledgerId
        if (b.type === 'Agst Ref' && !known) errors.push(`${who}: there is no bill "${b.name}" to settle`)
        if ((b.type === 'New Ref' || b.type === 'Advance') && known)
          errors.push(`${who}: bill "${b.name}" already exists; settle it with Agst Ref`)
        if (b.type !== 'Agst Ref') started.push([e.ledgerId, key])
      }
    if (!errors.length) for (const [l, k] of started) this.set(l).add(k)
    return errors
  }
}

const billLedgers = (vs: VoucherInput[]) => [
  ...new Set(vs.flatMap((v) => v.entries.filter((e) => e.bills?.length).map((e) => e.ledgerId))),
]

/**
 * The number users see for a voucher of one of the company's voucher types: the next in the
 * type's series (per financial year if it restarts), or the one typed for a type numbered by hand.
 * A predefined type's voucher has none (it shows its own number).
 */
async function docNumber(tx: Tx, companyId: number, v: Pick<VoucherInput, 'type' | 'date' | 'voucherTypeId' | 'docNo'>, self?: number) {
  if (!v.voucherTypeId) {
    // once the type's own voucher types have used numbers of its sequence, the predefined type
    // numbers on from its last shown number, so its series has no gaps
    const { rows } = await tx.query<{ next: number | null }>(
      `SELECT CASE WHEN EXISTS (SELECT 1 FROM vouchers WHERE company_id = $1 AND type = $2 AND voucher_type_id IS NOT NULL)
              THEN (SELECT COALESCE(MAX(CASE WHEN doc_no ~ '^[0-9]+$' THEN doc_no::int ELSE number END), 0) + 1
                      FROM vouchers WHERE company_id = $1 AND type = $2 AND voucher_type_id IS NULL) END "next"`,
      [companyId, v.type],
    )
    return { typeId: null, docNo: rows[0].next === null ? null : String(rows[0].next) }
  }
  const t = (await tx.query<NumberingRule & { name: string; baseType: string; active: boolean; fyStart: string }>(
    `SELECT t.name, t.base_type "baseType", t.active, t.numbering, t.prefix, t.suffix, t.width, t.start_number "startNumber", t.restart_yearly "restartYearly",
            to_char(c.fy_start, 'YYYY-MM-DD') "fyStart"
       FROM voucher_types t JOIN companies c ON c.id = t.company_id WHERE t.id = $1 AND t.company_id = $2`,
    [v.voucherTypeId, companyId],
  )).rows[0]
  if (!t) throw new ValidationError([`Unknown voucher type ${v.voucherTypeId}`])
  if (t.baseType !== v.type) throw new ValidationError([`${t.name} is a ${t.baseType} voucher type, not ${v.type}`])
  if (!t.active && self === undefined) throw new ValidationError([`The voucher type ${t.name} is not in use`])
  let docNo: string
  if (t.numbering === 'manual') {
    docNo = v.docNo?.trim() ?? ''
    if (!docNo) throw new ValidationError([`${t.name} is numbered by hand: type the voucher number`])
    if (docNo.length > 30) throw new ValidationError(['A voucher number has at most 30 characters'])
  } else {
    const fy = t.restartYearly ? fyStartOf(v.date, t.fyStart) : '1900-01-01'
    const { rows } = await tx.query<{ last: number }>(
      `INSERT INTO voucher_type_counters (voucher_type_id, fy_start, last) VALUES ($1,$2,$3)
       ON CONFLICT (voucher_type_id, fy_start) DO UPDATE SET last = voucher_type_counters.last + 1 RETURNING last`,
      [v.voucherTypeId, fy, t.startNumber],
    )
    docNo = formatDocNo(t, rows[0].last, v.date, t.fyStart)
  }
  // a number of digits alone must not repeat a voucher of the predefined type, which shows its own number
  if (/^\d+$/.test(docNo) && (await tx.query(
    `SELECT 1 FROM vouchers WHERE company_id = $1 AND type = $2 AND doc_no IS NULL AND number = $3 AND id IS DISTINCT FROM $4`,
    [companyId, v.type, Number(docNo), self ?? null],
  )).rowCount)
    throw new ValidationError([`${v.type} No. ${docNo} is already used`])
  return { typeId: v.voucherTypeId, docNo }
}

/** A repeated voucher number of a voucher type comes back as the unique index's error. */
const docNoTaken = (type: string, docNo: string | null) => (err: { code?: string; constraint?: string }) => {
  if (err.code === '23505' && (err.constraint === 'vouchers_doc_no' || /vouchers_doc_no/.test(String((err as Error).message))))
    throw new ValidationError([`${type} No. ${docNo} is already used`])
  throw err
}

/** Number and insert an already-validated voucher. */
async function insertVoucher(tx: Tx, companyId: number, v: Posting) {
  const doc = await docNumber(tx, companyId, v)
  const { rows: n } = await tx.query<{ last: number }>(
    `INSERT INTO voucher_counters (company_id, type, last) VALUES ($1,$2,1)
     ON CONFLICT (company_id, type) DO UPDATE SET last = voucher_counters.last + 1 RETURNING last`,
    [companyId, v.type],
  )
  const { rows } = await tx.query<{ id: number }>(
    `INSERT INTO vouchers (company_id, type, number, date, narration, gst, party_ledger_id, post_dated, optional, draft, gst_adjustment, voucher_type_id, doc_no, additional_cost,
                           applicable_upto, ref_no, ref_date, advance_rate, held, cost_track)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
    [companyId, v.type, n[0].last, v.date, v.narration ?? '', v.gst, v.partyId ?? null, !!v.postDated, !!v.optional, v.draft, v.gstAdjustment ?? null,
      doc.typeId, doc.docNo, v.additionalCost ?? 0, v.applicableUpto ?? null, v.refNo?.trim() || null, v.refDate ?? null, v.advanceRate ?? null, v.held,
      v.costTrack?.trim() || null],
  ).catch(docNoTaken(v.type, doc.docNo))
  if (v.entries.length) await insertEntries(tx, rows[0].id, v)
  if (v.inventory?.length) await insertInventory(tx, [{ voucherId: rows[0].id, type: v.type, lines: v.inventory }])
  if (v.attendance?.length) await insertAttendance(tx, rows[0].id, v)
  return { id: rows[0].id, number: n[0].last, docNo: doc.docNo ?? String(n[0].last) }
}

/**
 * Post-dated vouchers whose date has come: posted now, as Tally does on the day (each as an
 * alteration in the Edit Log). One that can no longer be posted (a bill or order it named has
 * changed since) stays held and is listed with its reasons.
 */
export async function releaseHeld(companyId: number) {
  const { rows } = await pool.query<{ id: number }>(`SELECT id FROM vouchers WHERE company_id = $1 AND held AND date <= $2 ORDER BY date, id`, [companyId, today()])
  const failed: { id: number; errors: string[] }[] = []
  for (const { id } of rows) {
    const v = await getVoucher(pool, companyId, id)
    try {
      await runAs('post-dated voucher, posted on its date', () => alterVoucher(companyId, id, v, v.version))
    } catch (err) {
      failed.push({ id, errors: err instanceof ValidationError ? err.errors : [String(err)] })
    }
  }
  return { released: rows.length - failed.length, failed }
}

/** Validate and post a voucher; numbering is per type. Returns { id, number }. */
export async function postVoucher(companyId: number, input: VoucherInput) {
  return withTx(async (tx) => {
    const ctx = await validationContext(tx, companyId)
    const v = await countToDifference(tx, companyId, input, ctx.booksBeginFrom)
    const errors = checkVoucher(v, ctx)
    // a draft starts no bills and delivers nothing: its references are checked once it is made regular
    if (!errors.length && !isDraft(v))
      errors.push(...(await BillNames.load(tx, billLedgers([v]))).check(v, ctx.ledgers), ...(await linkErrors(tx, companyId, v)), ...(await batchErrors(tx, companyId, v)))
    if (errors.length) throw new ValidationError(errors)
    return insertVoucher(tx, companyId, withGst(v, ctx))
  })
}

export type BatchResult = { ok: true; id: number; number: number } | { ok: false; errors: string[] }

const messagesOf = (err: unknown) =>
  err instanceof ValidationError ? err.errors : [err instanceof Error ? err.message : String(err)]

/**
 * Post many vouchers in one transaction (imports). The engine validates each one first.
 * The valid ones then go in set-wise: numbers reserved per type in one statement, all
 * vouchers in one INSERT, entries in large multi-row INSERTs, and the database's balance
 * check run once. If that bulk step fails, the batch is retried one savepoint per voucher,
 * so a bad voucher is still rolled back and reported on its own.
 */
export async function postVouchers(companyId: number, raw: VoucherInput[]): Promise<BatchResult[]> {
  return withTx(async (tx) => {
    const ctx = await validationContext(tx, companyId)
    const names = await BillNames.load(tx, billLedgers(raw))
    // counts and order/note links need the database; imports seldom carry them, so they go one by one
    const inputs: VoucherInput[] = []
    const linked: string[][] = []
    // a batch brought in earlier in the same import counts (kept as one list, read only for batch items)
    const earlier: VoucherInput[] = []
    for (const v of raw) {
      const x = await countToDifference(tx, companyId, v, ctx.booksBeginFrom)
      inputs.push(x)
      const errors = [...(await linkErrors(tx, companyId, x)), ...(isDraft(x) ? [] : await batchErrors(tx, companyId, x, undefined, earlier))]
      linked.push(errors)
      if (!errors.length && !isDraft(x) && x.inventory?.length) earlier.push(x)
    }
    const out: BatchResult[] = inputs.map((v, i) => {
      const errors = checkVoucher(v, ctx)
      if (!errors.length && !isDraft(v)) errors.push(...names.check(v, ctx.ledgers), ...linked[i])
      return errors.length ? { ok: false, errors } : (null as unknown as BatchResult)
    })
    const valid = inputs.map((v, i) => ({ v, i })).filter((x) => out[x.i] === null).map((x) => ({ v: withGst(x.v, ctx), i: x.i }))
    if (!valid.length) return out

    await tx.query('SAVEPOINT bulk')
    try {
      // the row triggers on vouchers and entries stand aside for the batch; close_voucher_batch then
      // applies their rules, daily totals and Edit Log to all of it at once (migrations 012, 013)
      await tx.query(`SELECT set_config('app.voucher_batch', 'on', true)`)
      const posted = await bulkInsert(tx, companyId, valid.map((x) => x.v))
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE')
      await tx.query('SELECT close_voucher_batch($1)', [posted.map((p) => p.id)])
      await tx.query(`SELECT set_config('app.voucher_batch', 'off', true)`)
      await tx.query('SET CONSTRAINTS ALL DEFERRED')
      await tx.query('RELEASE SAVEPOINT bulk')
      valid.forEach((x, k) => (out[x.i] = { ok: true, ...posted[k] }))
      return out
    } catch {
      await tx.query('ROLLBACK TO SAVEPOINT bulk') // also undoes the batch setting
      await tx.query(`SELECT set_config('app.voucher_batch', 'off', true)`)
    }

    // slow path: isolate the failure
    for (const { v, i } of valid) {
      await tx.query('SAVEPOINT vch')
      try {
        const r = await insertVoucher(tx, companyId, v)
        await tx.query('SET CONSTRAINTS ALL IMMEDIATE') // run the deferred balance check for this voucher now
        await tx.query('SET CONSTRAINTS ALL DEFERRED')
        await tx.query('RELEASE SAVEPOINT vch')
        out[i] = { ok: true, ...r }
      } catch (err) {
        await tx.query('ROLLBACK TO SAVEPOINT vch')
        out[i] = { ok: false, errors: messagesOf(err) }
      }
    }
    return out
  })
}

const ENTRY_ROWS_PER_INSERT = 2000 // 8 parameters each, well under Postgres's 65,535 limit

/** Insert validated vouchers set-wise; returns { id, number } in input order. */
async function bulkInsert(tx: Tx, companyId: number, vs: Posting[]) {
  // reserve a block of numbers per type
  const perType = new Map<string, number>()
  for (const v of vs) perType.set(v.type, (perType.get(v.type) ?? 0) + 1)
  const next = new Map<string, number>()
  for (const [type, count] of perType) {
    const { rows } = await tx.query<{ last: number }>(
      `INSERT INTO voucher_counters (company_id, type, last) VALUES ($1,$2,$3)
       ON CONFLICT (company_id, type) DO UPDATE SET last = voucher_counters.last + $3 RETURNING last`,
      [companyId, type, count],
    )
    next.set(type, rows[0].last - count + 1)
  }
  const numbers = vs.map((v) => {
    const n = next.get(v.type)!
    next.set(v.type, n + 1)
    return n
  })

  // vouchers: one INSERT; ids are matched back by (type, number), which is unique
  const params: unknown[] = [companyId]
  const values = vs.map((v, k) => {
    params.push(v.type, numbers[k], v.date, v.narration ?? '', v.gst, v.partyId ?? null, !!v.postDated, !!v.optional, v.draft, v.gstAdjustment ?? null, v.held, v.costTrack?.trim() || null)
    const b = 1 + k * 12
    return `($1,${Array.from({ length: 12 }, (_, c) => `$${b + c + 1}`).join(',')})`
  })
  const { rows } = await tx.query<{ id: number; type: string; number: number }>(
    `INSERT INTO vouchers (company_id, type, number, date, narration, gst, party_ledger_id, post_dated, optional, draft, gst_adjustment, held, cost_track)
     VALUES ${values.join(',')} RETURNING id, type, number`,
    params,
  )
  const idOf = new Map(rows.map((r) => [`${r.type}#${r.number}`, r.id]))
  const ids = vs.map((v, k) => idOf.get(`${v.type}#${numbers[k]}`)!)

  // entries: chunked multi-row INSERTs; ids come back for the bill allocations
  const all = vs.flatMap((v, k) =>
    v.entries.map((e, line) => [ids[k], line + 1, e.ledgerId, e.amount, e.chequeNo?.trim() || null, e.chequeDate ?? null, e.forex ?? null, e.forex ? e.forexRate : null]))
  const entryId = new Map<string, number>()
  for (let at = 0; at < all.length; at += ENTRY_ROWS_PER_INSERT) {
    const chunk = all.slice(at, at + ENTRY_ROWS_PER_INSERT)
    const { rows: made } = await tx.query<{ id: number; voucher_id: number; line: number }>(
      `INSERT INTO entries (voucher_id, line, ledger_id, amount, instrument_no, instrument_date, forex, forex_rate) VALUES ${chunk
        .map((_, j) => `(${Array.from({ length: 8 }, (_, c) => `$${j * 8 + c + 1}`).join(',')})`)
        .join(',')}
       RETURNING id, voucher_id, line`,
      chunk.flat(),
    )
    for (const r of made) entryId.set(`${r.voucher_id}#${r.line}`, r.id)
  }
  await insertInventory(tx, vs.flatMap((v, k) => (v.inventory?.length ? [{ voucherId: ids[k], type: v.type, lines: v.inventory }] : [])))
  await insertAllocations(
    tx,
    vs.flatMap((v, k) =>
      v.entries.flatMap((e, line) => (e.bills?.length || e.costs?.length ? [{ entryId: entryId.get(`${ids[k]}#${line + 1}`)!, entry: e }] : [])),
    ),
  )
  return vs.map((_, k) => ({ id: ids[k], number: numbers[k] }))
}

/** Create many ledgers in one transaction; each one stands or falls on its own. */
export async function createLedgers(companyId: number, inputs: LedgerInput[]): Promise<BatchResult[]> {
  return withTx(async (tx) => {
    const groups = await loadGroups(tx, companyId)
    const out: BatchResult[] = []
    for (const input of inputs) {
      const opening = input.opening ?? 0
      const errors: string[] = []
      if (!groups.has(input.groupId)) errors.push(`Unknown group ${input.groupId}`)
      else if (opening !== 0 && ['Income', 'Expenses'].includes(primaryOf(groups, input.groupId).nature))
        errors.push('Income and expense ledgers cannot carry an opening balance')
      if (!Number.isSafeInteger(opening)) errors.push('Opening balance must be whole paise')
      if (groups.has(input.groupId)) errors.push(...ledgerExtraErrors(groups, input))
      if (errors.length) {
        out.push({ ok: false, errors })
        continue
      }
      await tx.query('SAVEPOINT led')
      try {
        const { rows } = await tx
          .query<{ id: number }>(
            `INSERT INTO ledgers (company_id, name, group_id, opening, billwise, credit_days, gstin, state, gst_tax_type, gst_rate, hsn, cost_centres, interest_rate, interest_on,
                                  mailing_name, address, pincode, country, phone, email, pan, reverse_charge, gst_classification_id, taxability, tds_nature_id, deductee_type,
                                  currency_id, opening_forex, cess_rate)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29) RETURNING id`,
            [companyId, input.name.trim(), input.groupId, opening, billwiseFor(groups, input), input.creditDays ?? null, ...ledgerExtraValues(input)],
          )
          .catch(uniqueName(input.name))
        await tx.query('RELEASE SAVEPOINT led')
        out.push({ ok: true, id: rows[0].id, number: 0 })
      } catch (err) {
        await tx.query('ROLLBACK TO SAVEPOINT led')
        out.push({ ok: false, errors: messagesOf(err) })
      }
    }
    return out
  })
}

async function lockVoucher(tx: Tx, companyId: number, id: number, version?: number) {
  const { rows } = await tx.query<{ type: string; version: number; cancelled: boolean }>(
    `SELECT type, version, cancelled FROM vouchers WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [id, companyId],
  )
  if (!rows[0]) throw new ValidationError([`Unknown voucher ${id}`])
  if (version !== undefined && rows[0].version !== version)
    throw new ValidationError(['This voucher was changed by someone else; reload it and try again'])
  return rows[0]
}

/** Replace a voucher's date, narration and entries. The type and number stay. */
export async function alterVoucher(companyId: number, id: number, input: VoucherInput, version?: number) {
  return withTx(async (tx) => {
    const cur = await lockVoucher(tx, companyId, id, version)
    if (cur.type !== input.type) throw new ValidationError(['The voucher type cannot be changed'])
    const ctx = await validationContext(tx, companyId)
    const v = await countToDifference(tx, companyId, input, ctx.booksBeginFrom, id)
    const errors = checkVoucher(v, ctx)
    if (!errors.length && !isDraft(v)) errors.push(...(await linkErrors(tx, companyId, v, id)), ...(await batchErrors(tx, companyId, v, id)))
    if (!errors.length) errors.push(...(await keepsWhatWasMadeAgainst(tx, id, v)))
    if (!errors.length && isDraft(v) && (await madeAgainst(tx, id)).length)
      errors.push('Vouchers are made against this one, so it stays in the books')
    if (errors.length) throw new ValidationError(errors)
    // bank dates survive an alteration: kept for entries with the same ledger and amount
    const cleared = (
      await tx.query<{ ledger_id: number; amount: number; bank_date: string }>(
        `SELECT ledger_id, amount, to_char(bank_date,'YYYY-MM-DD') bank_date FROM entries WHERE voucher_id = $1 AND bank_date IS NOT NULL`,
        [id],
      )
    ).rows
    await tx.query(`DELETE FROM entries WHERE voucher_id = $1`, [id]) // its own bill allocations go with them
    await tx.query(`DELETE FROM inventory_entries WHERE voucher_id = $1`, [id])
    await tx.query(`DELETE FROM attendance_entries WHERE voucher_id = $1`, [id])
    const refErrors = isDraft(v) ? [] : (await BillNames.load(tx, billLedgers([v]))).check(v, ctx.ledgers)
    if (refErrors.length) throw new ValidationError(refErrors)
    // the voucher type stays; one numbered by hand may take a corrected number
    const kind = (await tx.query<{ typeId: number | null; docNo: string | null; manual: boolean }>(
      `SELECT v.voucher_type_id "typeId", v.doc_no "docNo", t.numbering = 'manual' manual FROM vouchers v LEFT JOIN voucher_types t ON t.id = v.voucher_type_id WHERE v.id = $1`,
      [id],
    )).rows[0]
    const p = withGst(v, ctx, kind.typeId)
    const docNo = kind.manual && input.docNo?.trim() && input.docNo.trim() !== kind.docNo
      ? (await docNumber(tx, companyId, { type: v.type, date: v.date, voucherTypeId: kind.typeId, docNo: input.docNo }, id)).docNo
      : kind.docNo
    await tx.query(
      `UPDATE vouchers SET date = $2, narration = $3, gst = $4, party_ledger_id = $5, post_dated = $6, optional = $7, draft = $8, gst_adjustment = $9,
              doc_no = $10, additional_cost = $11, applicable_upto = $12, ref_no = $13, ref_date = $14, advance_rate = $15, held = $16, cost_track = $17, cancelled = false,
              version = version + 1, updated_at = now() WHERE id = $1`,
      [id, v.date, v.narration ?? '', p.gst, v.partyId ?? null, !!v.postDated, !!v.optional, p.draft, v.gstAdjustment ?? null, docNo, v.additionalCost ?? 0, v.applicableUpto ?? null,
        v.refNo?.trim() || null, v.refDate ?? null, v.advanceRate ?? null, p.held, v.costTrack?.trim() || null],
    ).catch(docNoTaken(v.type, docNo))
    if (p.entries.length) await insertEntries(tx, id, p)
    if (p.inventory?.length) await insertInventory(tx, [{ voucherId: id, type: v.type, lines: p.inventory }])
    if (p.attendance?.length) await insertAttendance(tx, id, p)
    for (const c of cleared)
      if (c.bank_date >= v.date)
        await tx.query(
          `UPDATE entries SET bank_date = $4 WHERE id = (SELECT id FROM entries WHERE voucher_id = $1 AND ledger_id = $2
             AND amount = $3 AND bank_date IS NULL ORDER BY line LIMIT 1)`,
          [id, c.ledger_id, c.amount, c.bank_date],
        )
  })
}

/**
 * An order or note keeps at least what has been delivered or invoiced against it: an alteration
 * can't take an item below that or change the party.
 */
async function keepsWhatWasMadeAgainst(tx: Tx, id: number, v: VoucherInput) {
  const made = await madeAgainst(tx, id)
  if (!made.length) return []
  const errors: string[] = []
  const { rows } = await tx.query<{ party: number | null }>(`SELECT party_ledger_id party FROM vouchers WHERE id = $1`, [id])
  if (rows[0].party !== (v.partyId ?? null)) errors.push(`${made[0].against} is made against this voucher, so its party stays`)
  for (const m of made) {
    const kept = (v.inventory ?? []).filter((l) => l.itemId === m.itemId).reduce((t, l) => t + Math.abs(l.qty), 0)
    if (kept < m.qty) errors.push(`${m.item}: ${m.qty / 1000} has gone out against this voucher (${m.against}); it can't be less`)
  }
  return errors
}

/** An order or note that others are made against can't be cancelled or deleted. */
async function notMadeAgainst(tx: Tx, id: number, what: string) {
  const made = await madeAgainst(tx, id)
  if (made.length) throw new ValidationError([`${made[0].against} is made against this voucher; ${what} that first`])
}

/** Cancel keeps the number (no gaps in the series) but takes the voucher out of the books. */
export async function cancelVoucher(companyId: number, id: number) {
  return withTx(async (tx) => {
    await lockVoucher(tx, companyId, id)
    await notMadeAgainst(tx, id, 'cancel')
    await tx.query(`DELETE FROM entries WHERE voucher_id = $1`, [id])
    await tx.query(`DELETE FROM inventory_entries WHERE voucher_id = $1`, [id])
    await tx.query(`DELETE FROM attendance_entries WHERE voucher_id = $1`, [id])
    await tx.query(`UPDATE vouchers SET cancelled = true, version = version + 1, updated_at = now() WHERE id = $1`, [id])
  })
}

export async function deleteVoucher(companyId: number, id: number) {
  return withTx(async (tx) => {
    await lockVoucher(tx, companyId, id)
    await notMadeAgainst(tx, id, 'delete')
    await tx.query(`DELETE FROM vouchers WHERE id = $1`, [id])
  })
}

export async function getVoucher(db: Db, companyId: number, id: number) {
  const { rows } = await db.query(
    `SELECT v.id, v.type, v.number, COALESCE(v.doc_no, v.number::text) "docNo", v.voucher_type_id "voucherTypeId",
            (SELECT name FROM voucher_types WHERE id = v.voucher_type_id) "voucherType",
            (SELECT print_title FROM voucher_types WHERE id = v.voucher_type_id) "printTitle",
            to_char(v.date,'YYYY-MM-DD') date, v.narration, v.cancelled, v.version, v.post_dated "postDated",
            v.optional, v.draft, v.gst_adjustment "gstAdjustment", v.additional_cost::float8 "additionalCost", to_char(v.applicable_upto, 'YYYY-MM-DD') "applicableUpto", v.ref_no "refNo", to_char(v.ref_date, 'YYYY-MM-DD') "refDate",
            v.advance_rate "advanceRate", v.held, v.cost_track "costTrack", v.gst->'shippingBill' "shippingBill", v.party_ledger_id "partyId", (SELECT name FROM ledgers WHERE id = v.party_ledger_id) party,
            COALESCE(json_agg(json_build_object('ledgerId', e.ledger_id, 'ledger', l.name, 'amount', e.amount,
                     'chequeNo', e.instrument_no, 'chequeDate', to_char(e.instrument_date,'YYYY-MM-DD'), 'forex', e.forex, 'forexRate', e.forex_rate,
                     'bills', (SELECT json_agg(json_build_object('type', a.ref_type, 'name', a.name,
                                 'dueDate', to_char(a.due_date,'YYYY-MM-DD'), 'amount', a.amount) ORDER BY a.id)
                                 FROM bill_allocations a WHERE a.entry_id = e.id),
                     'costs', (SELECT json_agg(json_build_object('centreId', c.cost_centre_id, 'centre', cc.name, 'amount', c.amount) ORDER BY c.id)
                                 FROM cost_allocations c JOIN cost_centres cc ON cc.id = c.cost_centre_id WHERE c.entry_id = e.id))
                     ORDER BY e.line) FILTER (WHERE e.id IS NOT NULL), '[]') entries,
            COALESCE((SELECT json_agg(json_build_object('itemId', i.item_id, 'item', s.name, 'godownId', i.godown_id,
                        'qty', i.qty, 'rate', i.rate, 'amount', i.amount, 'counted', i.counted, 'orderId', i.order_id,
                        'trackingId', i.tracking_id, 'dueDate', to_char(i.due_date,'YYYY-MM-DD'), 'batch', i.batch,
                        'mfgDate', to_char(i.mfg_date,'YYYY-MM-DD'), 'expiryDate', to_char(i.expiry_date,'YYYY-MM-DD'), 'role', i.role, 'costShare', i.cost_share,
                        'against', (SELECT a.type || ' No. ' || COALESCE(a.doc_no, a.number::text) FROM vouchers a WHERE a.id = COALESCE(i.order_id, i.tracking_id))) ORDER BY i.line)
                        FROM inventory_entries i JOIN stock_items s ON s.id = i.item_id WHERE i.voucher_id = v.id), '[]') inventory,
            COALESCE((SELECT json_agg(json_build_object('employeeId', a.employee_id, 'employee', c.name, 'typeId', a.attendance_type_id, 'value', a.value) ORDER BY a.line)
                        FROM attendance_entries a JOIN cost_centres c ON c.id = a.employee_id WHERE a.voucher_id = v.id), '[]') attendance
       FROM vouchers v LEFT JOIN entries e ON e.voucher_id = v.id LEFT JOIN ledgers l ON l.id = e.ledger_id
      WHERE v.id = $1 AND v.company_id = $2 GROUP BY v.id`,
    [id, companyId],
  )
  const v = rows[0]
  if (!v?.draft) return v
  // an optional or memorandum voucher: its lines are the draft, with the item names looked up
  const { draft, ...rest } = v
  const items = new Map((await db.query<{ id: number; name: string }>(`SELECT id, name FROM stock_items WHERE company_id = $1`, [companyId])).rows.map((i) => [i.id, i.name]))
  return {
    ...rest,
    entries: draft.entries ?? [],
    inventory: (draft.inventory ?? []).map((l: { itemId: number }) => ({ ...l, item: items.get(l.itemId) ?? '' })),
  }
}

// ------------------------------------------------------------------ balances

/**
 * Ledger positions for the period [from, to], read from ledger_daily.
 * Balance-sheet ledgers carry their history in `opening`. Income and expense ledgers start the
 * period at zero, and their earlier movement (plus any change in stock valuation before
 * `from`) is carried in the Profit & Loss A/c opening, the way a year-end close would.
 */
/** A scenario's view of the books: with or without them, plus the lines of the vouchers it includes (see budgets.ts). */
export interface ScenarioView {
  includeActuals: boolean
  lines: { date: string; ledgerId: number; amount: number }[]
}

export async function ledgerBalances(db: Db, companyId: number, from: string, to: string, scenario?: ScenarioView | null): Promise<LedgerBalance[]> {
  const groups = await loadGroups(db, companyId)
  const { rows } = await db.query<{
    id: number
    name: string
    groupId: number | null
    opening: number
    pre: number
    mov: number
    stockOpen: number | null
    stockClose: number | null
  }>(
    `SELECT l.id, l.name, l.group_id "groupId", l.opening,
            COALESCE((SELECT SUM(dr - cr) FROM ledger_daily d WHERE d.ledger_id = l.id AND d.day < $2), 0)::bigint pre,
            COALESCE((SELECT SUM(dr - cr) FROM ledger_daily d WHERE d.ledger_id = l.id AND d.day BETWEEN $2 AND $3), 0)::bigint mov,
            (SELECT value FROM stock_values s WHERE s.ledger_id = l.id AND s.as_of < $2 ORDER BY as_of DESC LIMIT 1) "stockOpen",
            (SELECT value FROM stock_values s WHERE s.ledger_id = l.id AND s.as_of <= $3 ORDER BY as_of DESC LIMIT 1) "stockClose"
       FROM ledgers l WHERE l.company_id = $1 ORDER BY l.id`,
    [companyId, from, to],
  )
  if (scenario) {
    const byId = new Map(rows.map((r) => [r.id, r]))
    if (!scenario.includeActuals)
      for (const r of rows) Object.assign(r, { opening: 0, pre: 0, mov: 0, stockOpen: null, stockClose: null })
    for (const l of scenario.lines) {
      const r = byId.get(l.ledgerId)
      if (!r) continue
      if (l.date < from) r.pre = Number(r.pre) + l.amount
      else if (l.date <= to) r.mov = Number(r.mov) + l.amount
    }
  }
  let carried = 0 // Dr-positive amount to fold into P&L A/c opening
  const out: LedgerBalance[] = []
  for (const r of rows) {
    if (r.groupId !== null && isUnder(groups, r.groupId, ['Stock-in-Hand'])) {
      const open = r.stockOpen ?? r.opening
      carried += r.opening - open // a higher earlier valuation is earlier profit (a credit)
      out.push({ id: r.id, name: r.name, groupId: r.groupId, opening: open, closing: open + r.pre + r.mov, stockValue: r.stockClose ?? open })
      continue
    }
    const nature = r.groupId === null ? null : primaryOf(groups, r.groupId).nature
    if (nature === 'Income' || nature === 'Expenses') {
      carried += r.opening + r.pre
      out.push({ id: r.id, name: r.name, groupId: r.groupId, opening: 0, closing: r.mov })
      continue
    }
    const opening = r.opening + r.pre
    out.push({ id: r.id, name: r.name, groupId: r.groupId, opening, closing: opening + r.mov })
  }
  // Integrated inventory: the stock items' value is one Stock-in-Hand line. Its opening value at the
  // books' beginning is part of the opening balances (as in Tally); any change in valuation before
  // the period is earlier profit, carried in Profit & Loss A/c like the stock ledgers above.
  const stock = scenario && !scenario.includeActuals ? null : await stockTotals(db, companyId, from, to)
  const stockGroup = [...groups.values()].find((g) => g.name === 'Stock-in-Hand')
  if (stock && stockGroup) {
    carried += stock.booksBegin - stock.opening
    out.push({ id: STOCK_ITEMS_LINE, name: 'Stock Items (inventory)', groupId: stockGroup.id, opening: stock.opening, closing: stock.opening, stockValue: stock.closing })
  }
  const pl = out.find((b) => b.groupId === null && b.name === PROFIT_AND_LOSS)
  if (pl) {
    pl.opening += carried
    pl.closing += carried
  }
  return out
}

/** Id of the synthetic balance line that stands for all stock items (not a real ledger). */
export const STOCK_ITEMS_LINE = -1

// ------------------------------------------------------------------ bills (outstandings)

export interface OpeningBillInput {
  name: string
  billDate: string
  dueDate?: string | null
  amount: number // + Dr
}

/** Replace the bills that make up a bill-wise ledger's opening balance. */
export async function setOpeningBills(companyId: number, ledgerId: number, bills: OpeningBillInput[]) {
  return withTx(async (tx) => {
    const { rows } = await tx.query<{ billwise: boolean; name: string }>(
      `SELECT billwise, name FROM ledgers WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [ledgerId, companyId],
    )
    if (!rows[0]) throw new ValidationError([`Unknown ledger ${ledgerId}`])
    if (!rows[0].billwise) throw new ValidationError([`${rows[0].name} doesn't keep bill-wise details`])
    const seen = new Set<string>()
    const errors: string[] = []
    for (const b of bills) {
      const key = b.name.trim().toLowerCase()
      if (!key) errors.push('Every opening bill needs a name')
      else if (seen.has(key)) errors.push(`Opening bill "${b.name}" appears twice`)
      seen.add(key)
      if (!Number.isSafeInteger(b.amount) || b.amount === 0) errors.push(`Opening bill "${b.name}" needs a non-zero amount`)
    }
    if (errors.length) throw new ValidationError(errors)
    // a name a voucher already started would merge two different bills
    const clash = await tx.query<{ name: string }>(
      `SELECT DISTINCT name FROM bill_allocations WHERE ledger_id = $1 AND lower(name) = ANY($2) AND ref_type <> 'Agst Ref'`,
      [ledgerId, [...seen]],
    )
    if (clash.rows.length) throw new ValidationError(clash.rows.map((r) => `Bill "${r.name}" is already started by a voucher`))
    await tx.query(`DELETE FROM opening_bills WHERE ledger_id = $1`, [ledgerId])
    for (const b of bills)
      await tx.query(`INSERT INTO opening_bills (ledger_id, name, bill_date, due_date, amount) VALUES ($1,$2,$3,$4,$5)`, [
        ledgerId,
        b.name.trim(),
        b.billDate,
        b.dueDate ?? null,
        b.amount,
      ])
  })
}

/**
 * Every pending bill on `asOf`: opening bills plus voucher allocations up to that date,
 * netted per ledger and bill name. Due date is the New Ref's, else bill date + credit period.
 */
export async function pendingBills(
  db: Db,
  companyId: number,
  asOf: string,
  ledgerId?: number,
  excludeVoucherId?: number,
): Promise<PendingBill[]> {
  const { rows } = await db.query<PendingBill>(
    `WITH alloc AS (
       SELECT a.ledger_id, a.name, a.ref_type, a.due_date, a.amount, a.forex, v.date
         FROM bill_allocations a JOIN entries e ON e.id = a.entry_id JOIN vouchers v ON v.id = e.voucher_id
        WHERE v.company_id = $1 AND v.date <= $2 AND a.name IS NOT NULL
          AND ($3::int IS NULL OR a.ledger_id = $3) AND ($4::int IS NULL OR v.id <> $4)
       UNION ALL
       SELECT ob.ledger_id, ob.name, 'Opening', ob.due_date, ob.amount, NULL::bigint, ob.bill_date
         FROM opening_bills ob JOIN ledgers l ON l.id = ob.ledger_id
        WHERE l.company_id = $1 AND ($3::int IS NULL OR ob.ledger_id = $3)
     ), bills AS (
       SELECT ledger_id, min(name) "name",
              min(date) FILTER (WHERE ref_type <> 'Agst Ref') bill_date,
              min(due_date) FILTER (WHERE ref_type <> 'Agst Ref') due_date,
              sum(amount)::bigint pending, sum(forex)::float8 forex
         FROM alloc GROUP BY ledger_id, lower(name) HAVING sum(amount) <> 0
     )
     SELECT b.ledger_id "ledgerId", l.name "ledger", b.name,
            to_char(COALESCE(b.bill_date, $2::date), 'YYYY-MM-DD') "billDate",
            to_char(COALESCE(b.due_date, b.bill_date + COALESCE(l.credit_days, 0), $2::date), 'YYYY-MM-DD') "dueDate",
            b.pending, b.forex
       FROM bills b JOIN ledgers l ON l.id = b.ledger_id
      ORDER BY b.bill_date, l.name, b.name`,
    [companyId, asOf, ledgerId ?? null, excludeVoucherId ?? null],
  )
  return rows
}

// ------------------------------------------------------------------ bank reconciliation

export interface BankEntry {
  entryId: number
  voucherId: number
  type: string
  number: number
  date: string
  particulars: string
  narration: string
  amount: number
  bankDate: string | null
}

/**
 * A bank ledger's entries up to `asOf` that the bank had not reflected by then (no bank date,
 * or a bank date after `asOf`); with `all`, every entry of the period, cleared or not.
 */
export async function bankEntries(db: Db, companyId: number, ledgerId: number, from: string, asOf: string, all = false): Promise<BankEntry[]> {
  const { rows } = await db.query<BankEntry>(
    `SELECT e.id "entryId", v.id "voucherId", v.type, v.number, COALESCE(v.doc_no, v.number::text) "docNo", to_char(v.date,'YYYY-MM-DD') date, v.narration, e.amount,
            to_char(e.bank_date,'YYYY-MM-DD') "bankDate",
            COALESCE((SELECT string_agg(l2.name, ', ' ORDER BY e2.line) FROM entries e2 JOIN ledgers l2 ON l2.id = e2.ledger_id
                       WHERE e2.voucher_id = v.id AND e2.ledger_id <> e.ledger_id), '') particulars
       FROM entries e JOIN vouchers v ON v.id = e.voucher_id
      WHERE e.ledger_id = $2 AND v.company_id = $1 AND v.date <= $4
        AND (CASE WHEN $5::boolean THEN v.date >= $3 ELSE (e.bank_date IS NULL OR e.bank_date > $4) END)
      ORDER BY v.date, v.id, e.line`,
    [companyId, ledgerId, from, asOf, all],
  )
  return rows
}

/** Set (or clear, with null) bank dates. Only on the company's bank ledgers, never before the voucher date. */
export async function setBankDates(companyId: number, items: { entryId: number; bankDate: string | null }[]) {
  return withTx(async (tx) => {
    const groups = await loadGroups(tx, companyId)
    const errors: string[] = []
    for (const it of items) {
      const { rows } = await tx.query<{ group_id: number | null; date: string; name: string }>(
        `SELECT l.group_id, to_char(v.date,'YYYY-MM-DD') date, l.name FROM entries e JOIN vouchers v ON v.id = e.voucher_id
           JOIN ledgers l ON l.id = e.ledger_id WHERE e.id = $1 AND v.company_id = $2`,
        [it.entryId, companyId],
      )
      const r = rows[0]
      if (!r) errors.push(`Unknown entry ${it.entryId}`)
      else if (r.group_id === null || !isUnder(groups, r.group_id, ['Bank Accounts', 'Bank OD A/c']))
        errors.push(`${r.name} is not a bank ledger`)
      else if (it.bankDate !== null && it.bankDate < r.date)
        errors.push(`Bank date ${it.bankDate} is before the voucher date ${r.date}`)
      else await tx.query(`UPDATE entries SET bank_date = $2 WHERE id = $1`, [it.entryId, it.bankDate])
    }
    if (errors.length) throw new ValidationError(errors)
  })
}
