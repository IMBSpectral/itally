import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'
import { createCompany, createLedger, loadGroups, postVoucher } from '../src/books'
import { alterStockItem, createGodown, createStockItem, createUnit, defaultGodown } from '../src/inventory'
import { ageStock, reorderStatus } from '../src/engine/stock-analysis'
import { backupCompany, restoreCompany } from '../src/backup'

const R = (rupees: number) => rupees * 100
const Q = (units: number) => units * 1000
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
const get = async (path: string) => {
  const res = await fetch(base + path)
  assert.equal(res.status, 200, path)
  return res.json()
}

test('ageing takes the stock in hand from the latest receipts; reorder raises the shortfall to the minimum order', () => {
  const inwards = [{ date: '2026-04-01', qty: Q(100), amount: R(4000) }, { date: '2026-08-01', qty: Q(50), amount: R(2500) }]
  assert.deepEqual(ageStock(inwards, Q(130), '2026-10-31').map((b) => [b.label, b.qty, b.value]), [
    ['0-45 days', 0, 0], ['45-90 days', 0, 0], ['90-180 days', Q(50), R(2500)], ['Over 180 days', Q(80), R(3200)],
  ])
  assert.deepEqual(ageStock(inwards, Q(20), '2026-08-15', [30]).map((b) => b.qty), [Q(20), 0])
  // at the item's valuation (130 kg at the average cost of ₹43.33), shared by quantity
  assert.deepEqual(ageStock(inwards, Q(130), '2026-10-31', undefined, 563290).map((b) => b.value), [0, 0, 216650, 346640])
  assert.deepEqual(reorderStatus({ closingQty: Q(130), reorderLevel: Q(200), minOrderQty: Q(100), purchaseOrders: Q(30), salesOrders: Q(40) }),
    { available: Q(120), shortfall: Q(80), toOrder: Q(100) })
  assert.deepEqual(reorderStatus({ closingQty: Q(300), reorderLevel: Q(200), minOrderQty: Q(100), purchaseOrders: 0, salesOrders: 0 }), { available: Q(300), shortfall: 0, toOrder: 0 })
})

test('stock ageing, movement analysis and reorder status from the books', async () => {
  const companyId = await createCompany({ name: `Stock analysis ${Date.now()}`, booksBegin: '2026-04-01' })
  const groups = await loadGroups(pool, companyId)
  const g = (n: string) => [...groups.values()].find((x) => x.name === n)!.id
  const kg = await createUnit(companyId, { symbol: 'Kg' })
  const rice = await createStockItem(companyId, { name: 'Rice', unitId: kg, openingQty: Q(100), openingValue: R(4000) })
  await createStockItem(companyId, { name: 'Flour', unitId: kg })
  const main = await defaultGodown(pool, companyId)
  const store = await createGodown(companyId, { name: 'Back Store' })
  const sales = await createLedger(companyId, { name: 'Sales', groupId: g('Sales Accounts') })
  const purchases = await createLedger(companyId, { name: 'Purchases', groupId: g('Purchase Accounts') })
  const bistro = await createLedger(companyId, { name: 'Bistro', groupId: g('Sundry Debtors'), billwise: false })
  const cafe = await createLedger(companyId, { name: 'Cafe', groupId: g('Sundry Debtors'), billwise: false })
  const mill = await createLedger(companyId, { name: 'Mill', groupId: g('Sundry Creditors'), billwise: false })
  await postVoucher(companyId, {
    type: 'Purchase', date: '2026-08-01', entries: [{ ledgerId: mill, amount: -R(2500) }, { ledgerId: purchases, amount: R(2500) }],
    inventory: [{ itemId: rice, godownId: main, qty: Q(50), rate: R(50), amount: R(2500) }],
  })
  await postVoucher(companyId, {
    type: 'Sales', date: '2026-09-01', entries: [{ ledgerId: bistro, amount: R(1200) }, { ledgerId: sales, amount: -R(1200) }],
    inventory: [{ itemId: rice, godownId: main, qty: -Q(20), rate: R(60), amount: -R(1200) }],
  })
  // a transfer to the back store is neither a receipt nor an issue
  await postVoucher(companyId, {
    type: 'Stock Journal', date: '2026-10-20', entries: [],
    inventory: [{ itemId: rice, godownId: main, qty: -Q(10), rate: R(40), amount: -R(400) }, { itemId: rice, godownId: store, qty: Q(10), rate: R(40), amount: R(400) }],
  })
  await postVoucher(companyId, { type: 'Purchase Order', date: '2026-10-21', partyId: mill, entries: [], inventory: [{ itemId: rice, godownId: main, qty: Q(30), rate: R(50), amount: R(1500) }] })
  await postVoucher(companyId, { type: 'Sales Order', date: '2026-10-22', partyId: cafe, entries: [], inventory: [{ itemId: rice, godownId: main, qty: -Q(40), rate: R(60), amount: -R(2400) }] })
  await alterStockItem(companyId, rice, { name: 'Rice', unitId: kg, openingQty: Q(100), openingValue: R(4000), reorderLevel: Q(200), minOrderQty: Q(100) })
  await assert.rejects(alterStockItem(companyId, rice, { name: 'Rice', unitId: kg, reorderLevel: 1500 }), /decimal places/)

  const at = `/companies/${companyId}`
  const q = '?from=2026-04-01&to=2026-10-31'
  const ageing = await get(`${at}/reports/stock-ageing${q}`)
  assert.deepEqual(ageing.labels, ['0-45 days', '45-90 days', '90-180 days', 'Over 180 days'])
  assert.deepEqual(ageing.lines.map((l: { name: string; buckets: { qty: number }[] }) => [l.name, l.buckets.map((b) => b.qty)]), [['Rice', [0, 0, Q(50), Q(80)]]])
  const cv = ageing.lines[0].closingValue
  assert.deepEqual(ageing.totals, [0, 0, Math.round((cv * 50) / 130), cv - Math.round((cv * 50) / 130)], 'the closing value at average cost, shared by quantity')
  assert.deepEqual((await get(`${at}/reports/stock-ageing${q}&brackets=100,30`)).labels, ['0-30 days', '30-100 days', 'Over 100 days'])

  const all = await get(`${at}/reports/movement${q}`)
  assert.deepEqual(all.items.map((i: { name: string; inQty: number; outQty: number; inRate: number; outRate: number }) => [i.name, i.inQty, i.outQty, i.inRate, i.outRate]),
    [['Rice', Q(50), Q(20), R(50), R(60)]], 'orders and the godown transfer are not movement')
  const one = await get(`${at}/reports/movement${q}&itemId=${rice}`)
  assert.deepEqual(one.inward, [{ party: 'Mill', qty: Q(50), value: R(2500), rate: R(50) }])
  assert.deepEqual(one.outward, [{ party: 'Bistro', qty: Q(20), value: R(1200), rate: R(60) }])

  const reorder = await get(`${at}/reports/reorder${q}`)
  assert.deepEqual(reorder.lines.map((l: Record<string, unknown>) => [l.name, l.closingQty, l.purchaseOrders, l.salesOrders, l.available, l.shortfall, l.toOrder]),
    [['Rice', Q(130), Q(30), Q(40), Q(120), Q(80), Q(100)]], 'only items with a reorder level')
  const restored = await restoreCompany((await backupCompany(companyId)).file)
  const again = await get(`/companies/${restored.id}/reports/reorder${q}`)
  assert.deepEqual(again.lines.map(({ id: _, ...l }: { id: number }) => l), reorder.lines.map(({ id: _, ...l }: { id: number }) => l), 'reorder levels survive a backup')
})
