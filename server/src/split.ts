/**
 * Split Company Data, as Tally's: from one company, two new ones at a date. The first has the books
 * up to the day before; the second begins on the date, its opening balances, pending bills and
 * stock being the first's closing ones, with the vouchers from the date on. The company split is
 * left as it was. Both are made through the backup format, so everything a backup carries comes along.
 */
import { gunzipSync, gzipSync } from 'node:zlib'
import { pool } from './db'
import { getCompany, ledgerBalances, loadGroups, pendingBills, STOCK_ITEMS_LINE, ValidationError } from './books'
import { backupCompany, restoreCompany } from './backup'
import { stockPositions } from './inventory'
import { profitAndLoss } from './engine/reports'
import { primaryOf, isUnder } from './engine/groups'
import { fyStartOf } from './engine/numbering'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** As the app shows dates: 1-Sep-26 */
const dmy = (d: string) => `${Number(d.slice(8, 10))}-${MONTHS[Number(d.slice(5, 7)) - 1]}-${d.slice(2, 4)}`
const dayBefore = (d: string) => new Date(Date.parse(d) - 86_400_000).toISOString().slice(0, 10)

/** Keeps only what belongs to the vouchers kept (by their "type#number"). */
function keepVouchers(b: Json, keep: (v: { date: string }) => boolean) {
  b.vouchers = b.vouchers.filter(keep)
  const kept = new Set(b.vouchers.map((v: { type: string; number: number }) => `${v.type}#${v.number}`))
  const has = (k: string | null | undefined) => !!k && kept.has(k)
  b.inventory = (b.inventory ?? []).filter((i: { voucher: string }) => has(i.voucher)).map((i: Json) => ({ ...i, order: has(i.order) ? i.order : null, tracking: has(i.tracking) ? i.tracking : null }))
  for (const k of ['attendance', 'eDocuments', 'tdsChallans', 'gstChallans', 'auditMarks']) if (b[k]) b[k] = b[k].filter((x: { voucher: string }) => has(x.voucher))
}

export async function splitCompany(companyId: number, date: string) {
  const company = await getCompany(pool, companyId)
  if (!company) throw new ValidationError([`Unknown company ${companyId}`])
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date <= company.booksBegin) throw new ValidationError([`Split at a date after the books begin (${dmy(company.booksBegin)})`])
  const last = dayBefore(date)
  const { file } = await backupCompany(companyId)
  const original = JSON.parse(gunzipSync(file).toString('utf8'))

  // the first: everything up to the day before
  const first = structuredClone(original)
  first.company.name = `${company.name} (up to ${dmy(last)})`
  keepVouchers(first, (v) => v.date < date)

  // the second: from the date, with the first's closing position as its opening
  const second = structuredClone(original)
  second.company.name = `${company.name} (from ${dmy(date)})`
  second.company.booksBegin = date
  second.company.fyStart = fyStartOf(date, company.fyStart)
  keepVouchers(second, (v) => v.date >= date)
  second.editLog = []
  const groups = await loadGroups(pool, companyId)
  const balances = await ledgerBalances(pool, companyId, company.booksBegin, last)
  const byName = new Map(balances.filter((x) => x.id !== STOCK_ITEMS_LINE).map((x) => [x.name, x]))
  const profit = profitAndLoss(groups, balances).netProfit
  for (const l of second.ledgers as { name: string; group: string | null; opening: number }[]) {
    const bal = byName.get(l.name)
    if (!bal) continue
    if (bal.groupId === null) l.opening = bal.closing - profit // Profit & Loss A/c: the profit so far is a credit
    else if (['Income', 'Expenses'].includes(primaryOf(groups, bal.groupId).nature)) l.opening = 0
    else if (isUnder(groups, bal.groupId, ['Stock-in-Hand'])) l.opening = bal.stockValue ?? bal.closing
    else l.opening = bal.closing
  }
  second.stockValues = (second.stockValues ?? []).filter((s: { asOf: string }) => s.asOf >= date)
  const ledgerName = new Map(balances.map((x) => [x.id, x.name]))
  second.openingBills = (await pendingBills(pool, companyId, last)).map((p) => ({
    ledger: ledgerName.get(p.ledgerId) ?? p.ledger, name: p.name, billDate: p.billDate, dueDate: p.dueDate, amount: p.pending,
  }))
  // stock: each item's closing quantity and value, opening in the main godown
  const positions = new Map((await stockPositions(pool, companyId, company.booksBegin, last)).map((p) => [p.name, p]))
  const main = (second.godowns ?? []).find((g: { isDefault: boolean }) => g.isDefault)?.name ?? null
  for (const s of second.stockItems ?? []) {
    const p = positions.get(s.name)
    s.openingQty = p?.closingQty ?? 0
    s.openingValue = p?.closingValue ?? 0
    s.openingGodown = main
  }
  const a = await restoreCompany(gzipSync(JSON.stringify(first)))
  const b = await restoreCompany(gzipSync(JSON.stringify(second)))
  return { first: a, second: b }
}
