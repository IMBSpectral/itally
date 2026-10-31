import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'
import { backupCompany, restoreCompany } from '../src/backup'
import { stockPositions } from '../src/inventory'

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
const raw = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  return { status: res.status, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text }
}
const call = async (method: string, path: string, body?: unknown) => {
  const r = await raw(method, path, body)
  if (r.status >= 400) throw new Error(`${method} ${path} ${r.status} ${JSON.stringify(r.body)}`)
  return r.body
}
const R = (rupees: number) => Math.round(rupees * 100)
const Q = (n: number) => n * 1000

test('manufacturing and job work: BOM, cost estimation, Manufacturing Journal, rejections, material out and in, third-party godowns, backup', async () => {
  const c = await call('POST', '/companies', { name: `Mfg ${Date.now()}`, booksBegin: '2026-04-01' })
  const at = (p: string) => `/companies/${c.id}${p}`
  await call('PUT', at('/features'), { jobWork: true })
  const groups: { id: number; name: string }[] = await call('GET', at('/groups'))
  const g = (n: string) => groups.find((x) => x.name === n)!.id
  const ledger = async (name: string, group: string) => (await call('POST', at('/ledgers'), { name, groupId: g(group) })).id as number
  const debtor = await ledger('Furniture Mart', 'Sundry Debtors')
  const supplier = await ledger('Timber Co', 'Sundry Creditors')
  const carpenter = await ledger('Carpenter Ravi', 'Sundry Creditors')
  const principal = await ledger('Principal Ltd', 'Sundry Debtors')
  const nos = (await call('POST', at('/units'), { symbol: 'Nos', name: 'Numbers', decimals: 0 })).id
  const godowns: { id: number; isDefault: boolean }[] = await call('GET', at('/godowns'))
  const main = godowns.find((x) => x.isDefault)!.id
  const item = async (name: string, qty = 0, value = 0) => (await call('POST', at('/stock-items'), { name, unitId: nos, openingQty: Q(qty), openingValue: R(value), openingGodownId: main })).id as number
  const wood = await item('Wood Plank', 100, 5000)
  const nails = await item('Nails', 1000, 1000)
  const table = await item('Table')

  // bill of materials: a table is 4 planks and 20 nails
  await call('PUT', at(`/stock-items/${table}/bom`), { makesQty: Q(1), components: [{ itemId: wood, qty: Q(4) }, { itemId: nails, qty: Q(20) }] })
  assert.equal((await raw('PUT', at(`/stock-items/${wood}/bom`), { makesQty: Q(1), components: [{ itemId: table, qty: Q(1) }] })).status, 422) // a cycle
  const est = await call('GET', at(`/reports/cost-estimation?item=${table}&qty=${Q(10)}&asOf=2026-04-30`))
  assert.deepEqual(est.lines.map((l: { item: string; qty: number; amount: number }) => [l.item, l.qty, l.amount]), [['Wood Plank', Q(40), R(2000)], ['Nails', Q(200), R(200)]])
  assert.equal(est.perUnit, R(220))

  // Manufacturing Journal: 10 tables from 40 planks and 200 nails, ₹300 of labour
  const mj = await call('POST', at('/vouchers'), {
    type: 'Manufacturing Journal', date: '2026-04-10', entries: [], additionalCost: R(300),
    inventory: [
      { itemId: wood, godownId: main, qty: -Q(40), rate: 0, amount: 0 },
      { itemId: nails, godownId: main, qty: -Q(200), rate: 0, amount: 0 },
      { itemId: table, godownId: main, qty: Q(10), rate: 0, amount: 0 },
    ],
  })
  const got = await call('GET', at(`/vouchers/${mj.id}`))
  assert.equal(got.additionalCost, R(300))
  assert.deepEqual(got.inventory.map((l: { amount: number }) => l.amount), [-R(2000), -R(200), R(2500)])
  const pos = async (asOf: string) => new Map((await stockPositions(pool, c.id, '2026-04-01', asOf)).map((p) => [p.id, p]))
  let p = await pos('2026-04-10')
  assert.equal(p.get(table)!.closingValue, R(2500))
  assert.equal(p.get(wood)!.closingQty, Q(60))
  assert.equal((await raw('POST', at('/vouchers'), { type: 'Stock Journal', date: '2026-04-10', entries: [], additionalCost: R(1), inventory: [{ itemId: wood, godownId: main, qty: Q(1), rate: 0, amount: 0 }] })).status, 422)

  // rejections: a customer sends a table back; planks go back to the supplier
  assert.equal((await raw('POST', at('/vouchers'), { type: 'Rejections In', date: '2026-04-12', entries: [], inventory: [{ itemId: table, godownId: main, qty: Q(1), rate: R(250), amount: R(250) }] })).status, 422)
  await call('POST', at('/vouchers'), { type: 'Rejections In', date: '2026-04-12', entries: [], partyId: debtor, inventory: [{ itemId: table, godownId: main, qty: Q(1), rate: R(250), amount: R(250) }] })
  assert.equal((await raw('POST', at('/vouchers'), { type: 'Rejections Out', date: '2026-04-12', entries: [], partyId: supplier, inventory: [{ itemId: wood, godownId: main, qty: Q(10), rate: R(50), amount: R(500) }] })).status, 422) // goes out
  await call('POST', at('/vouchers'), { type: 'Rejections Out', date: '2026-04-12', entries: [], partyId: supplier, inventory: [{ itemId: wood, godownId: main, qty: -Q(10), rate: R(50), amount: -R(500) }] })

  // job work out: order 5 tables from the carpenter, send 20 planks, get the tables back with ₹500 of charges
  const atCarpenter = (await call('POST', at('/godowns'), { name: 'With Carpenter', thirdParty: 'ours' })).id
  const order = await call('POST', at('/vouchers'), { type: 'Job Work Out Order', date: '2026-04-15', entries: [], partyId: carpenter, inventory: [{ itemId: table, godownId: main, qty: Q(5), rate: R(300), amount: R(1500) }] })
  await call('POST', at('/vouchers'), {
    type: 'Material Out', date: '2026-04-15', entries: [], partyId: carpenter,
    inventory: [{ itemId: wood, godownId: main, qty: -Q(20), rate: 0, amount: 0 }, { itemId: wood, godownId: atCarpenter, qty: Q(20), rate: 0, amount: 0 }],
  })
  let jw = await call('GET', at('/reports/job-work?asOf=2026-04-20'))
  assert.deepEqual(jw.withJobWorkers.map((s: { item: string; qty: number; value: number }) => [s.item, s.qty, s.value]), [['Wood Plank', Q(20), R(1000)]])
  assert.equal(jw.outOrders[0].pending, Q(5))
  assert.equal((await raw('PUT', at(`/godowns/${atCarpenter}`), { name: 'With Carpenter', thirdParty: null })).status, 422) // in use
  p = await pos('2026-04-15')
  assert.equal(p.get(wood)!.closingQty, Q(50)) // still ours: 60 - 10 returned, 20 of them at the carpenter's

  await call('POST', at('/vouchers'), {
    type: 'Material In', date: '2026-04-20', entries: [], partyId: carpenter, additionalCost: R(500),
    inventory: [{ itemId: table, godownId: main, qty: Q(5), rate: 0, amount: 0, orderId: order.id }, { itemId: wood, godownId: atCarpenter, qty: -Q(20), rate: 0, amount: 0 }],
  })
  jw = await call('GET', at('/reports/job-work?asOf=2026-04-30'))
  assert.equal(jw.withJobWorkers.length, 0)
  assert.equal(jw.outOrders[0].pending, 0)
  p = await pos('2026-04-30')
  assert.equal(p.get(table)!.closingQty, Q(16))
  assert.equal(p.get(table)!.closingValue, R(2500 + 250 + 1500)) // the five made by the carpenter cost the planks and the charges
  assert.equal(p.get(wood)!.closingQty, Q(30))

  // job work in: a principal's planks with us are not our stock
  const theirs = (await call('POST', at('/godowns'), { name: 'Principal Stock', thirdParty: 'theirs' })).id
  await call('POST', at('/vouchers'), { type: 'Material In', date: '2026-04-25', entries: [], partyId: principal, inventory: [{ itemId: wood, godownId: theirs, qty: Q(30), rate: 0, amount: 0 }] })
  p = await pos('2026-04-30')
  assert.equal(p.get(wood)!.closingQty, Q(30))
  jw = await call('GET', at('/reports/job-work?asOf=2026-04-30'))
  assert.deepEqual(jw.withUs.map((s: { godown: string; item: string; qty: number; value: number | null }) => [s.godown, s.item, s.qty, s.value]), [['Principal Stock', 'Wood Plank', Q(30), null]])

  // a backup brings it back
  const restored = (await restoreCompany((await backupCompany(c.id)).file)).id
  const ra = (path: string) => `/companies/${restored}${path}`
  const items2: { id: number; name: string }[] = await call('GET', ra('/stock-items'))
  const table2 = items2.find((i) => i.name === 'Table')!.id
  assert.equal((await call('GET', ra(`/stock-items/${table2}/bom`))).components.length, 2)
  const jw2 = await call('GET', ra('/reports/job-work?asOf=2026-04-30'))
  assert.equal(jw2.withUs[0].qty, Q(30))
  const p2 = new Map((await stockPositions(pool, restored, '2026-04-01', '2026-04-30')).map((x) => [x.name, x]))
  assert.equal(p2.get('Table')!.closingValue, R(4250))
  const g2: { name: string; thirdParty: string | null }[] = await call('GET', ra('/godowns'))
  assert.equal(g2.find((x) => x.name === 'With Carpenter')!.thirdParty, 'ours')
})

test('several bills of materials per item; by-products take their share of the cost, scrap comes off it', async () => {
  const c = await call('POST', '/companies', { name: `Mfg2 ${Date.now()}`, booksBegin: '2026-04-01' })
  const at = (p: string) => `/companies/${c.id}${p}`
  const kg = (await call('POST', at('/units'), { symbol: 'Kg', name: 'Kilograms', decimals: 3 })).id
  const main = (await call('GET', at('/godowns'))).find((x: { isDefault: boolean }) => x.isDefault).id
  const item = async (name: string, qty = 0, value = 0) => (await call('POST', at('/stock-items'), { name, unitId: kg, openingQty: Q(qty), openingValue: R(value), openingGodownId: main })).id as number
  const milk = await item('Milk', 1000, 50000)
  const cream = await item('Cream', 100, 20000)
  const ghee = await item('Ghee')
  const buttermilk = await item('Buttermilk')
  const waste = await item('Milk Solids Waste')

  // ghee two ways: from milk, or from cream; the milk route gives buttermilk and waste
  await call('PUT', at(`/stock-items/${ghee}/bom`), { name: 'From milk', makesQty: Q(1), components: [{ itemId: milk, qty: Q(20) }],
    byProducts: [{ itemId: buttermilk, qty: Q(15), costShare: 1000 }], scrap: [{ itemId: waste, qty: Q(2) }] })
  await call('PUT', at(`/stock-items/${ghee}/bom`), { name: 'From cream', makesQty: Q(1), components: [{ itemId: cream, qty: Q(2.5) }] })
  assert.deepEqual(await call('GET', at(`/stock-items/${ghee}/boms`)), ['From milk', 'From cream'])
  assert.equal((await call('GET', at(`/stock-items/${ghee}/bom?name=from%20cream`))).components[0].qty, Q(2.5))
  const milkBom = await call('GET', at(`/stock-items/${ghee}/bom`))
  assert.deepEqual([milkBom.name, milkBom.byProducts[0].costShare, milkBom.scrap[0].qty], ['From milk', 1000, Q(2)])
  assert.equal((await raw('PUT', at(`/stock-items/${ghee}/bom`), { name: 'Bad', makesQty: Q(1), components: [{ itemId: milk, qty: Q(1) }],
    byProducts: [{ itemId: buttermilk, qty: Q(1), costShare: 6000 }, { itemId: waste, qty: Q(1), costShare: 5000 }] })).status, 422)

  // 10 kg of ghee from 200 kg of milk (₹10,000): 2 kg of waste sold as scrap at ₹50 (₹100 off the cost),
  // buttermilk takes 10% of the rest (₹990), the ghee the remaining ₹8,910
  const mj = await call('POST', at('/vouchers'), {
    type: 'Manufacturing Journal', date: '2026-04-10', entries: [],
    inventory: [
      { itemId: milk, godownId: main, qty: -Q(200), rate: 0, amount: 0 },
      { itemId: ghee, godownId: main, qty: Q(10), rate: 0, amount: 0 },
      { itemId: buttermilk, godownId: main, qty: Q(150), rate: 0, amount: 0, role: 'by-product', costShare: 1000 },
      { itemId: waste, godownId: main, qty: Q(2), rate: R(50), amount: R(100), role: 'scrap' },
    ],
  })
  const got = await call('GET', at(`/vouchers/${mj.id}`))
  assert.deepEqual(got.inventory.map((l: { amount: number; role: string | null; costShare: number | null }) => [l.amount, l.role, l.costShare]),
    [[-R(10000), null, null], [R(8910), null, null], [R(990), 'by-product', 1000], [R(100), 'scrap', null]])
  // shares over 100% or scrap worth more than the cost are refused
  const bad = await raw('POST', at('/vouchers'), { type: 'Manufacturing Journal', date: '2026-04-11', entries: [], inventory: [
    { itemId: milk, godownId: main, qty: -Q(10), rate: 0, amount: 0 }, { itemId: ghee, godownId: main, qty: Q(1), rate: 0, amount: 0 },
    { itemId: waste, godownId: main, qty: Q(1), rate: R(5000), amount: R(5000), role: 'scrap' }] })
  assert.equal(bad.status, 422)
  assert.match(JSON.stringify(bad.body), /scrap is valued at more than the cost/)
})
