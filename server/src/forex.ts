/**
 * Multi-currency: currency masters, rates of exchange, ledgers kept in a foreign currency, and the
 * forex gain or loss (Tally's "Unadjusted Forex Gain/Loss"): what a ledger's foreign balance is
 * worth at the standard rate on a date against the rupees in the books. A bill-wise ledger is
 * valued bill by bill, so a bill settled in full in the currency but at another rate shows its
 * realised gain or loss, and an open bill its unrealised one. The adjustment is a Journal of
 * rupees only (a foreign amount of 0) against a gain or loss ledger.
 */
import { pool, withTx, type Tx } from './db'
import { postVoucher, ValidationError, type LedgerInput } from './books'
import { primaryOf, type GroupNode } from './engine/groups'
import { currencyProblems, pickRate, revalue, toBase, type Currency, type RatesOn } from './engine/forex'
import type { BillInput, EntryInput } from './engine/voucher'

type Db = Tx | typeof pool

const CURRENCY_COLUMNS = `id, symbol, name, decimals, decimal_name "decimalName"`

export async function loadCurrencies(db: Db, companyId: number) {
  const { rows } = await db.query<Currency>(`SELECT ${CURRENCY_COLUMNS} FROM currencies WHERE company_id = $1`, [companyId])
  return new Map(rows.map((c) => [c.id, c]))
}

export async function listCurrencies(db: Db, companyId: number): Promise<(Currency & { used: number })[]> {
  return (await db.query(
    `SELECT ${CURRENCY_COLUMNS}, (SELECT count(*)::int FROM ledgers l WHERE l.currency_id = c.id) used
       FROM currencies c WHERE company_id = $1 ORDER BY lower(name)`,
    [companyId],
  )).rows
}

type CurrencyInput = Omit<Currency, 'id'>
const currencyValues = (c: CurrencyInput) => [c.symbol.trim(), c.name.trim(), c.decimals, c.decimalName?.trim() || null]
const currencyTaken = (c: CurrencyInput) => (err: { code?: string }) => {
  if (err.code === '23505') throw new ValidationError([`A currency ${c.symbol.trim()} or ${c.name.trim()} already exists`])
  throw err
}
export async function createCurrency(companyId: number, c: CurrencyInput) {
  const errors = currencyProblems(c)
  if (errors.length) throw new ValidationError(errors)
  return (await pool
    .query<{ id: number }>(`INSERT INTO currencies (company_id, symbol, name, decimals, decimal_name) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [companyId, ...currencyValues(c)])
    .catch(currencyTaken(c))).rows[0].id
}
export async function alterCurrency(companyId: number, id: number, c: CurrencyInput) {
  const errors = currencyProblems(c)
  if (errors.length) throw new ValidationError(errors)
  return withTx(async (tx) => {
    const cur = (await tx.query<{ decimals: number }>(`SELECT decimals FROM currencies WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, companyId])).rows[0]
    if (!cur) throw new ValidationError([`Unknown currency ${id}`])
    // the foreign amounts already booked are in the old smallest unit
    if (cur.decimals !== c.decimals && (await inUse(tx, id))) throw new ValidationError(['Ledgers are kept in this currency; its decimal places stay'])
    await tx
      .query(`UPDATE currencies SET symbol = $3, name = $4, decimals = $5, decimal_name = $6 WHERE id = $1 AND company_id = $2`, [id, companyId, ...currencyValues(c)])
      .catch(currencyTaken(c))
  })
}
const inUse = async (db: Db, id: number) => !!(await db.query(`SELECT 1 FROM ledgers WHERE currency_id = $1 LIMIT 1`, [id])).rowCount
export async function deleteCurrency(companyId: number, id: number) {
  return withTx(async (tx) => {
    const c = (await tx.query<{ name: string }>(`SELECT name FROM currencies WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, companyId])).rows[0]
    if (!c) throw new ValidationError([`Unknown currency ${id}`])
    if (await inUse(tx, id)) throw new ValidationError([`Ledgers are kept in ${c.name}; change them first`])
    await tx.query(`DELETE FROM currencies WHERE id = $1`, [id])
  })
}

export interface CurrencyRates extends Currency {
  rates: RatesOn | null // in force on the date asked
}
/** Each currency with the rates in force on a date (set on it or the latest before it). */
export async function ratesOn(db: Db, companyId: number, date: string): Promise<CurrencyRates[]> {
  const { rows } = await db.query(
    `SELECT c.id, c.symbol, c.name, c.decimals, c.decimal_name "decimalName",
            CASE WHEN r.date IS NULL THEN NULL ELSE json_build_object('date', to_char(r.date, 'YYYY-MM-DD'), 'standard', r.standard::float8,
                 'selling', r.selling::float8, 'buying', r.buying::float8) END rates
       FROM currencies c
       LEFT JOIN LATERAL (SELECT * FROM exchange_rates x WHERE x.currency_id = c.id AND x.date <= $2 ORDER BY x.date DESC LIMIT 1) r ON true
      WHERE c.company_id = $1 ORDER BY lower(c.name)`,
    [companyId, date],
  )
  return rows
}

export interface RateInput {
  currencyId: number
  standard: number | null
  selling: number | null
  buying: number | null
}
/** Rates of Exchange for a date; a currency with no rate given has none set on that date. */
export async function setRates(companyId: number, date: string, rates: RateInput[]) {
  const errors: string[] = []
  for (const r of rates)
    for (const v of [r.standard, r.selling, r.buying])
      if (v !== null && (!Number.isSafeInteger(v) || v <= 0)) errors.push('A rate of exchange is a positive number of rupees')
  if (errors.length) throw new ValidationError([...new Set(errors)])
  await withTx(async (tx) => {
    const own = await loadCurrencies(tx, companyId)
    for (const r of rates) {
      if (!own.has(r.currencyId)) throw new ValidationError([`Unknown currency ${r.currencyId}`])
      if (r.standard === null && r.selling === null && r.buying === null)
        await tx.query(`DELETE FROM exchange_rates WHERE currency_id = $1 AND date = $2`, [r.currencyId, date])
      else
        await tx.query(
          `INSERT INTO exchange_rates (currency_id, date, standard, selling, buying) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (currency_id, date) DO UPDATE SET standard = $3, selling = $4, buying = $5`,
          [r.currencyId, date, r.standard, r.selling, r.buying],
        )
    }
  })
}

/**
 * A ledger's currency: one of the company's, only on a balance-sheet ledger (a party, a bank account,
 * a loan), and fixed once the ledger has vouchers, whose amounts were booked in it.
 */
export async function checkLedgerCurrency(db: Db, companyId: number, groups: Map<number, GroupNode>, input: LedgerInput, id?: number) {
  const errors: string[] = []
  const currencyId = input.currencyId ?? null
  if (currencyId !== null) {
    if (!(await db.query(`SELECT 1 FROM currencies WHERE id = $1 AND company_id = $2`, [currencyId, companyId])).rowCount) errors.push(`Unknown currency ${currencyId}`)
    else if (['Income', 'Expenses'].includes(primaryOf(groups, input.groupId).nature))
      errors.push('Only a balance sheet ledger (a party, a bank account, a loan) is kept in a foreign currency')
    const of = input.openingForex ?? 0
    if (!Number.isSafeInteger(of)) errors.push('The opening balance in the currency has too many decimals')
    else if (of !== 0 && (input.opening ?? 0) !== 0 && Math.sign(of) !== Math.sign(input.opening ?? 0))
      errors.push('The opening balance in the currency and in rupees must be on the same side')
  }
  if (id !== undefined) {
    const cur = (await db.query<{ currencyId: number | null }>(`SELECT currency_id "currencyId" FROM ledgers WHERE id = $1`, [id])).rows[0]
    if (cur && cur.currencyId !== currencyId && (await db.query(`SELECT 1 FROM entries WHERE ledger_id = $1 LIMIT 1`, [id])).rowCount)
      errors.push('This ledger has vouchers; the currency it is kept in stays')
  }
  if (errors.length) throw new ValidationError(errors)
}

export interface BillRevaluation {
  name: string
  forex: number
  book: number
  value: number
  difference: number
  settled: boolean // nothing left in the currency: the difference is realised
}
export interface LedgerRevaluation {
  ledgerId: number
  ledger: string
  currencyId: number
  symbol: string
  decimals: number
  forex: number
  book: number
  rate: number | null
  value: number | null
  difference: number
  bills: BillRevaluation[]
  onAccount: number // the part of the difference not on a bill
}

/**
 * Forex gain or loss on a date: each foreign-currency ledger's balance in the currency at the
 * standard rate, against its rupees. + is a gain on the ledger's side of the books needing a debit
 * (an asset worth more, a liability that shrank), - a loss.
 */
export async function forexGainLoss(db: Db, companyId: number, asOf: string) {
  const currencies = new Map((await ratesOn(db, companyId, asOf)).map((c) => [c.id, c]))
  const { rows } = await db.query<{ id: number; name: string; currencyId: number; billwise: boolean; book: number; forex: number }>(
    `SELECT l.id, l.name, l.currency_id "currencyId", l.billwise,
            (l.opening + COALESCE(s.amount, 0))::float8 book, (l.opening_forex + COALESCE(s.forex, 0))::float8 forex
       FROM ledgers l
       LEFT JOIN (SELECT e.ledger_id, sum(e.amount) amount, sum(COALESCE(e.forex, 0)) forex
                    FROM entries e JOIN vouchers v ON v.id = e.voucher_id
                   WHERE v.company_id = $1 AND v.date <= $2 GROUP BY e.ledger_id) s ON s.ledger_id = l.id
      WHERE l.company_id = $1 AND l.currency_id IS NOT NULL ORDER BY lower(l.name)`,
    [companyId, asOf],
  )
  const billRows = (await db.query<{ ledgerId: number; name: string; book: number; forex: number }>(
    `SELECT a.ledger_id "ledgerId", min(a.name) "name", sum(a.amount)::float8 book, sum(a.forex)::float8 forex
       FROM bill_allocations a JOIN entries e ON e.id = a.entry_id JOIN vouchers v ON v.id = e.voucher_id JOIN ledgers l ON l.id = a.ledger_id
      WHERE v.company_id = $1 AND v.date <= $2 AND a.name IS NOT NULL AND l.currency_id IS NOT NULL
      GROUP BY a.ledger_id, lower(a.name)
      -- a bill opened before its ledger kept a currency has no foreign amount to value
     HAVING bool_and(a.forex IS NOT NULL) AND (sum(a.amount) <> 0 OR sum(a.forex) <> 0)
      ORDER BY min(v.date), min(a.name)`,
    [companyId, asOf],
  )).rows
  const ledgers: LedgerRevaluation[] = rows.map((l) => {
    const c = currencies.get(l.currencyId)!
    const rate = pickRate(c.rates, 'standard')
    const r = revalue(l.forex, l.book, rate, c.decimals)
    const bills: BillRevaluation[] = rate === null || !l.billwise ? [] : billRows.filter((b) => b.ledgerId === l.id).flatMap((b) => {
      const value = toBase(b.forex, rate, c.decimals)
      return value === b.book ? [] : [{ name: b.name, forex: b.forex, book: b.book, value, difference: value - b.book, settled: b.forex === 0 }]
    })
    const onAccount = r.difference - bills.reduce((t, b) => t + b.difference, 0)
    return { ledgerId: l.id, ledger: l.name, currencyId: c.id, symbol: c.symbol, decimals: c.decimals, ...r, bills, onAccount }
  })
  return {
    asOf,
    ledgers,
    total: ledgers.reduce((t, l) => t + l.difference, 0),
    // a currency used by ledgers with no rate on the date can't be valued
    missingRates: [...new Set(ledgers.filter((l) => l.rate === null).map((l) => l.symbol))],
  }
}

/**
 * Book the forex gain or loss on a date: one Journal taking each ledger to its value at the
 * standard rate (bill by bill on a bill-wise ledger), against the gain or loss ledger.
 */
export async function adjustForex(companyId: number, date: string, gainLossLedgerId: number) {
  const fx = await forexGainLoss(pool, companyId, date)
  const target = (await pool.query<{ name: string; currencyId: number | null; groupId: number | null }>(
    `SELECT name, currency_id "currencyId", group_id "groupId" FROM ledgers WHERE id = $1 AND company_id = $2`,
    [gainLossLedgerId, companyId],
  )).rows[0]
  if (!target) throw new ValidationError([`Unknown ledger ${gainLossLedgerId}`])
  if (target.currencyId !== null) throw new ValidationError([`${target.name} is kept in a foreign currency; book the gain or loss to a rupee ledger`])
  const entries: EntryInput[] = fx.ledgers.filter((l) => l.difference !== 0).map((l) => {
    const bills: BillInput[] = l.bills.map((b) => ({ type: 'Agst Ref', name: b.name, amount: b.difference }))
    if (bills.length && l.onAccount) bills.push({ type: 'On Account', amount: l.onAccount })
    return { ledgerId: l.ledgerId, amount: l.difference, forex: 0, ...(bills.length ? { bills } : {}) }
  })
  if (!entries.length) throw new ValidationError([`There is no forex gain or loss to adjust on ${date}`])
  const total = fx.total
  if (total !== 0) entries.push({ ledgerId: gainLossLedgerId, amount: -total })
  const sym = [...new Set(fx.ledgers.filter((l) => l.difference).map((l) => l.symbol))].join(', ')
  return postVoucher(companyId, {
    type: 'Journal',
    date,
    narration: `Forex gain/loss on ${sym} balances at the standard rates of ${date.split('-').reverse().join('-')}`,
    entries,
  })
}
