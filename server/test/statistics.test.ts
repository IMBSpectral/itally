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

async function books() {
  const c = await call('POST', '/companies', { name: `Stats ${Date.now()}-${Math.random()}`, booksBegin: '2026-04-01' })
  const at = `/companies/${c.id}`
  const groups: { id: number; name: string }[] = await call('GET', `${at}/groups`)
  const g = (n: string) => groups.find((x) => x.name === n)!.id
  const ledgers: { id: number; name: string }[] = await call('GET', `${at}/ledgers`)
  const cash = ledgers.find((l) => l.name === 'Cash')!.id
  const L = async (name: string, group: string, opening = 0) => (await call('POST', `${at}/ledgers`, { name, groupId: g(group), opening, billwise: false })).id as number
  const ids = {
    cash,
    bank: await L('HDFC', 'Bank Accounts', R(40000)),
    capital: await L('Owner', 'Capital Account', -R(40000)),
    sales: await L('Sales', 'Sales Accounts'),
    purchases: await L('Purchases', 'Purchase Accounts'),
    rent: await L('Rent', 'Indirect Expenses'),
    acme: await L('Acme', 'Sundry Debtors'),
    beta: await L('Beta', 'Sundry Debtors'),
    supplier: await L('Supplier', 'Sundry Creditors'),
  }
  const V = (type: string, date: string, entries: [number, number][], extra: object = {}) =>
    call('POST', `${at}/vouchers`, { type, date, entries: entries.map(([ledgerId, amount]) => ({ ledgerId, amount })), ...extra })
  return { at, g, V, ...ids }
}

test('statistics count vouchers by type (own types apart, cancelled and optional aside) and masters by kind', async () => {
  const s = await books()
  const exp = (await call('POST', `${s.at}/voucher-types`, { name: 'Sales - Export', baseType: 'Sales', prefix: 'E', width: 0, startNumber: 1, restartYearly: false, numbering: 'auto', suffix: '' })).id
  await s.V('Sales', '2026-04-02', [[s.cash, R(100)], [s.sales, -R(100)]])
  await s.V('Sales', '2026-04-03', [[s.cash, R(200)], [s.sales, -R(200)]])
  await s.V('Sales', '2026-04-04', [[s.acme, R(300)], [s.sales, -R(300)]], { voucherTypeId: exp })
  await s.V('Payment', '2026-04-05', [[s.rent, R(50)], [s.cash, -R(50)]], { optional: true })
  const cancelled = await s.V('Payment', '2026-04-06', [[s.rent, R(60)], [s.cash, -R(60)]])
  await call('POST', `${s.at}/vouchers/${cancelled.id}/cancel`)
  await s.V('Receipt', '2026-06-01', [[s.cash, R(10)], [s.acme, -R(10)]]) // outside the period

  const st = await call('GET', `${s.at}/reports/statistics?from=2026-04-01&to=2026-04-30`)
  const row = (name: string) => st.vouchers.find((v: { name: string }) => v.name === name)
  assert.deepEqual(row('Sales'), { type: 'Sales', voucherTypeId: null, name: 'Sales', count: 2, cancelled: 0, optional: 0 })
  assert.deepEqual(row('Sales - Export'), { type: 'Sales', voucherTypeId: exp, name: 'Sales - Export', count: 1, cancelled: 0, optional: 0 })
  assert.deepEqual(row('Payment'), { type: 'Payment', voucherTypeId: null, name: 'Payment', count: 0, cancelled: 1, optional: 1 })
  assert.equal(row('Receipt').count, 0)
  // every predefined type is listed, the company's own type right after Sales
  const names = st.vouchers.map((v: { name: string }) => v.name)
  assert.equal(names.indexOf('Sales - Export'), names.indexOf('Sales') + 1)
  assert.equal(names.length, 26)
  assert.equal(st.total, 3)
  const masters = Object.fromEntries(st.masters.map((m: { name: string; count: number }) => [m.name, m.count]))
  assert.equal(masters.Ledgers, 10) // Cash, Profit & Loss A/c and the eight above
  assert.equal(masters['Voucher Types'], 26)
  assert.equal(masters['Stock Items'], 0)
})

test('the dashboard: cash and bank, receivables and payables, sales month by month, the largest balances', async () => {
  const s = await books()
  await s.V('Sales', '2026-04-02', [[s.acme, R(5000)], [s.sales, -R(5000)]])
  await s.V('Sales', '2026-04-20', [[s.beta, R(8000)], [s.sales, -R(8000)]])
  await s.V('Sales', '2026-05-03', [[s.cash, R(2000)], [s.sales, -R(2000)]])
  await s.V('Purchase', '2026-05-04', [[s.purchases, R(6000)], [s.supplier, -R(6000)]])
  await s.V('Receipt', '2026-05-10', [[s.bank, R(1000)], [s.acme, -R(1000)]])
  await s.V('Payment', '2026-05-11', [[s.rent, R(500)], [s.cash, -R(500)]])

  const d = await call('GET', `${s.at}/reports/dashboard?from=2026-04-01&to=2026-06-30`)
  assert.equal(d.cash, R(1500))
  assert.equal(d.bank, R(41000))
  assert.equal(d.receivables, R(12000))
  assert.equal(d.payables, R(6000))
  assert.equal(d.sales, R(15000))
  assert.equal(d.purchases, R(6000))
  assert.equal(d.netProfit, R(15000 - 6000 - 500))
  assert.equal(d.vouchers, 6)
  assert.deepEqual(d.months, [{ month: '2026-04', sales: R(13000), purchases: 0 }, { month: '2026-05', sales: R(2000), purchases: R(6000) }, { month: '2026-06', sales: 0, purchases: 0 }])
  assert.deepEqual(d.topDebtors.map((x: { name: string; amount: number }) => [x.name, x.amount]), [['Beta', R(8000)], ['Acme', R(4000)]])
  assert.deepEqual(d.topCreditors.map((x: { name: string; amount: number }) => [x.name, x.amount]), [['Supplier', R(6000)]])
})

test('Income & Expenditure A/c is off until switched on in F11', async () => {
  const s = await books()
  const f = await call('GET', `${s.at}/features`)
  assert.equal(f.features.incomeExpenditure, false)
  assert.equal(f.features.inventory, true)
  await call('PUT', `${s.at}/features`, { incomeExpenditure: true })
  assert.equal((await call('GET', `${s.at}/features`)).features.incomeExpenditure, true)
})
