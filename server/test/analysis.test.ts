import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'

let server: Server
let base = ''
before(async () => {
  await migrate(() => {})
  server = createApp().listen(0)
  base = `http://localhost:${(server.address() as AddressInfo).port}/api`
})
after(async () => {
  server.close()
  await pool.end()
})
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  const json = res.status === 204 ? null : await res.json()
  if (res.status >= 400) throw new Error(`${method} ${path} ${res.status} ${JSON.stringify(json)}`)
  return json
}
const R = (rupees: number) => Math.round(rupees * 100)

test('cash flow, funds flow and ratio analysis agree with the books', async () => {
  const c = await call('POST', '/companies', { name: `Analysis ${Date.now()}`, booksBegin: '2026-04-01' })
  const at = `/companies/${c.id}`
  const groups: { id: number; name: string }[] = await call('GET', `${at}/groups`)
  const g = (n: string) => groups.find((x) => x.name === n)!.id
  const ledgers: { id: number; name: string }[] = await call('GET', `${at}/ledgers`)
  const cash = ledgers.find((l) => l.name === 'Cash')!.id
  await call('PUT', `${at}/ledgers/${cash}`, { name: 'Cash', groupId: g('Cash-in-Hand'), opening: R(200000) })
  const L = async (name: string, group: string, opening = 0) => (await call('POST', `${at}/ledgers`, { name, groupId: g(group), opening, billwise: false })).id as number
  const bank = await L('HDFC', 'Bank Accounts', R(100000))
  const capital = await L('Owner', 'Capital Account', -R(300000))
  const sales = await L('Sales', 'Sales Accounts')
  const purchases = await L('Purchases', 'Purchase Accounts')
  const supplier = await L('Supplier', 'Sundry Creditors')
  const customer = await L('Customer', 'Sundry Debtors')
  const loan = await L('Term Loan', 'Secured Loans')
  const machinery = await L('Machinery', 'Fixed Assets')
  const discount = await L('Discount Allowed', 'Indirect Expenses')
  assert.ok(capital)
  const V = (type: string, date: string, entries: [number, number][]) => call('POST', `${at}/vouchers`, { type, date, entries: entries.map(([ledgerId, amount]) => ({ ledgerId, amount })) })
  // April: a cash sale, a credit purchase, cash into the bank, a loan into the bank
  await V('Sales', '2026-04-05', [[cash, R(50000)], [sales, -R(50000)]])
  await V('Purchase', '2026-04-06', [[purchases, R(20000)], [supplier, -R(20000)]])
  await V('Contra', '2026-04-07', [[bank, R(30000)], [cash, -R(30000)]])
  await V('Receipt', '2026-04-08', [[bank, R(100000)], [loan, -R(100000)]])
  // May: machinery from the bank, the supplier paid in cash, a credit sale settled less a discount
  await V('Payment', '2026-05-02', [[machinery, R(80000)], [bank, -R(80000)]])
  await V('Payment', '2026-05-03', [[supplier, R(15000)], [cash, -R(15000)]])
  await V('Sales', '2026-05-04', [[customer, R(10000)], [sales, -R(10000)]])
  await V('Receipt', '2026-05-05', [[cash, R(9500)], [discount, R(500)], [customer, -R(10000)]])

  const q = '?from=2026-04-01&to=2026-05-31'
  const cf = await call('GET', `${at}/reports/cash-flow${q}`)
  assert.equal(cf.opening, R(300000))
  assert.deepEqual(cf.months.map((m: { month: string; inflow: number; outflow: number; net: number }) => [m.month, m.inflow, m.outflow, m.net]), [
    ['2026-04', R(150000), 0, R(150000)],
    ['2026-05', R(10000), R(95500), -R(85500)],
  ])
  assert.deepEqual(cf.groups.map((x: { name: string; inflow: number; outflow: number }) => [x.name, x.inflow, x.outflow]), [
    ['Current Assets', R(10000), 0],
    ['Current Liabilities', 0, R(15000)],
    ['Fixed Assets', 0, R(80000)],
    ['Indirect Expenses', 0, R(500)],
    ['Loans (Liability)', R(100000), 0],
    ['Sales Accounts', R(50000), 0],
  ])
  assert.equal(cf.closing, R(364500), 'cash 2,14,500 and bank 1,50,000')

  const ff = await call('GET', `${at}/reports/funds-flow${q}`)
  assert.deepEqual(ff.sources.map((x: { name: string; amount: number }) => [x.name, x.amount]), [['Net Profit', R(39500)], ['Loans (Liability)', R(100000)]])
  assert.deepEqual(ff.applications.map((x: { name: string; amount: number }) => [x.name, x.amount]), [['Fixed Assets', R(80000)]])
  assert.equal(ff.increase, R(59500))
  assert.equal(ff.workingCapital.closing - ff.workingCapital.opening, ff.increase, 'sources less applications = the change in working capital')
  assert.deepEqual(ff.workingCapital.lines.map((x: { name: string; increase: number }) => [x.name, x.increase]), [
    ['Bank Accounts', R(50000)],
    ['Cash-in-Hand', R(14500)],
    ['Sundry Creditors', -R(5000)],
  ])

  const r = await call('GET', `${at}/reports/ratios${q}`)
  assert.equal(r.workingCapital, R(359500))
  assert.equal(r.days, 61)
  assert.equal(r.currentRatio, 364500 / 5000)
  assert.equal(r.capital, R(339500), 'capital plus the profit')
  assert.equal(r.debtEquity, 100000 / 339500)
  assert.equal(Math.round(r.grossProfitPct * 100), 6667)
  assert.equal(Math.round(r.netProfitPct * 100), 6583)
  assert.equal(r.inventoryTurnover, null, 'no stock: no turnover')
  assert.equal(r.receivableDays, 0)
})

test('funds flow balances when closing stock is valued apart from the books', async () => {
  const { makeCompany } = await import('./fixture')
  const { fundsFlow, ratios } = await import('../src/engine/analysis')
  const co = makeCompany()
  co.ledger('Stock', 'Stock-in-Hand', R(1000))
  co.ledger('Capital', 'Capital Account', -R(1000))
  co.ledger('Purchases', 'Purchase Accounts')
  co.ledger('Supplier', 'Sundry Creditors')
  co.post({ type: 'Purchase', date: '2026-04-02', entries: [{ ledgerId: co.id('Purchases'), amount: R(5000) }, { ledgerId: co.id('Supplier'), amount: -R(5000) }] })
  co.setStockValue('Stock', R(3000))
  const ff = fundsFlow(co.groups, co.balances())
  assert.deepEqual(ff.applications.map((x) => [x.name, x.amount]), [['Net Loss', R(3000)]])
  assert.equal(ff.increase, -R(3000))
  assert.equal(ff.workingCapital.closing - ff.workingCapital.opening, ff.increase)
  const r = ratios(co.groups, co.balances(), 365)
  assert.equal(r.closingStock, R(3000))
  assert.equal(r.quickRatio, 0, 'nothing current but the stock')
})
