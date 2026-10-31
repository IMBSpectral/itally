import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { alterVoucher, cancelVoucher, createCompany, createLedger, deleteVoucher, getVoucher, ledgerBalances, loadGroups, postVoucher } from '../src/books'
import { createGodown, createStockItem, createUnit, defaultGodown, pendingLines, stockPositions } from '../src/inventory'
import { backupCompany, restoreCompany } from '../src/backup'
import { profitAndLoss } from '../src/engine/reports'

const R = (rupees: number) => rupees * 100
const Q = (units: number) => units * 1000
before(() => migrate(() => {}))
after(() => pool.end())

async function shop() {
  const companyId = await createCompany({ name: `Orders ${Date.now()}-${Math.random()}`, booksBegin: '2026-04-01' })
  const groups = await loadGroups(pool, companyId)
  const g = (n: string) => [...groups.values()].find((x) => x.name === n)!.id
  const kg = await createUnit(companyId, { symbol: 'Kg' })
  const rice = await createStockItem(companyId, { name: 'Rice', unitId: kg, openingQty: Q(100), openingValue: R(4000) })
  const flour = await createStockItem(companyId, { name: 'Flour', unitId: kg })
  const main = await defaultGodown(pool, companyId)
  const store = await createGodown(companyId, { name: 'Back Store' })
  await createLedger(companyId, { name: 'Capital', groupId: g('Capital Account'), opening: -R(4000) })
  const sales = await createLedger(companyId, { name: 'Sales', groupId: g('Sales Accounts') })
  const purchases = await createLedger(companyId, { name: 'Purchases', groupId: g('Purchase Accounts') })
  const bistro = await createLedger(companyId, { name: 'Bistro', groupId: g('Sundry Debtors'), billwise: false })
  const cafe = await createLedger(companyId, { name: 'Cafe', groupId: g('Sundry Debtors'), billwise: false })
  const mill = await createLedger(companyId, { name: 'Mill', groupId: g('Sundry Creditors'), billwise: false })
  return { companyId, rice, flour, main, store, sales, purchases, bistro, cafe, mill }
}
type Shop = Awaited<ReturnType<typeof shop>>

const stock = async (s: Shop, to = '2027-03-31') =>
  Object.fromEntries((await stockPositions(pool, s.companyId, '2026-04-01', to)).map((p) => [p.name, p]))

const sale = (s: Shop, date: string, qty: number, amount: number, link: { trackingId?: number; orderId?: number } = {}, party = s.bistro) =>
  postVoucher(s.companyId, {
    type: 'Sales', date, entries: [{ ledgerId: party, amount }, { ledgerId: s.sales, amount: -amount }],
    inventory: [{ itemId: s.rice, godownId: s.main, qty: -qty, rate: Math.round((amount * 1000) / qty), amount: -amount, ...link }],
  })

test('order, delivery note, invoice: the goods go out once, and each step shows what is pending', async () => {
  const s = await shop()
  const order = await postVoucher(s.companyId, {
    type: 'Sales Order', date: '2026-04-02', partyId: s.bistro,
    inventory: [{ itemId: s.rice, godownId: s.main, qty: -Q(30), rate: R(60), amount: -R(1800), dueDate: '2026-04-10' }], entries: [],
  })
  assert.equal((await stock(s)).Rice.closingQty, Q(100), 'an order moves no stock')
  let [line] = await pendingLines(pool, s.companyId, { type: 'Sales Order' })
  assert.deepEqual([line.number, line.party, line.ordered, line.pending, line.rate, line.dueDate], [order.number, 'Bistro', Q(30), Q(30), R(60), '2026-04-10'])

  const note = await postVoucher(s.companyId, {
    type: 'Delivery Note', date: '2026-04-05', partyId: s.bistro, entries: [],
    inventory: [{ itemId: s.rice, godownId: s.main, qty: -Q(20), rate: R(60), amount: -R(1200), orderId: order.id }],
  })
  assert.equal((await stock(s)).Rice.closingQty, Q(80), 'the delivery note takes the goods out')
  ;[line] = await pendingLines(pool, s.companyId, { type: 'Sales Order' })
  assert.deepEqual([line.done, line.pending], [Q(20), Q(10)])
  ;[line] = await pendingLines(pool, s.companyId, { type: 'Delivery Note' })
  assert.deepEqual([line.number, line.pending], [note.number, Q(20)], 'not yet invoiced')

  await sale(s, '2026-04-08', Q(20), R(1200), { trackingId: note.id })
  const after = await stock(s)
  assert.equal(after.Rice.closingQty, Q(80), 'the invoice against the note moves nothing again')
  assert.equal(after.Rice.closingValue, R(3200))
  assert.deepEqual(await pendingLines(pool, s.companyId, { type: 'Delivery Note' }), [])
  const pl = profitAndLoss(await loadGroups(pool, s.companyId), await ledgerBalances(pool, s.companyId, '2026-04-01', '2027-03-31'))
  assert.equal(pl.grossProfit, R(1200) - R(800), 'sales less the cost of the 20 kg that went out')

  // what was made against them holds the order and note in place
  await assert.rejects(cancelVoucher(s.companyId, order.id), /Delivery Note No\. 1 is made against this voucher; cancel that first/)
  await assert.rejects(deleteVoucher(s.companyId, note.id), /Sales No\. 1 is made against this voucher; delete that first/)
  await assert.rejects(
    alterVoucher(s.companyId, order.id, { type: 'Sales Order', date: '2026-04-02', partyId: s.bistro, entries: [],
      inventory: [{ itemId: s.rice, godownId: s.main, qty: -Q(15), rate: R(60), amount: -R(900) }] }),
    /20 has gone out against this voucher/,
  )
  const v = await getVoucher(pool, s.companyId, note.id)
  assert.equal(v.party, 'Bistro')
  assert.equal(v.inventory[0].against, `Sales Order No. ${order.number}`)
})

test('links are checked: the right type, the same party, the item, and no more than is pending', async () => {
  const s = await shop()
  const order = await postVoucher(s.companyId, {
    type: 'Sales Order', date: '2026-04-02', partyId: s.bistro, entries: [],
    inventory: [{ itemId: s.rice, godownId: s.main, qty: -Q(10), rate: R(60), amount: -R(600) }],
  })
  const deliver = (qty: number, extra: Record<string, unknown> = {}, partyId = s.bistro, itemId = s.rice) =>
    postVoucher(s.companyId, { type: 'Delivery Note', date: '2026-04-03', partyId, entries: [],
      inventory: [{ itemId, godownId: s.main, qty: -qty, rate: R(60), amount: -qty * 60 / 10, orderId: order.id, ...extra }] })
  await assert.rejects(deliver(Q(11)), /has 10 pending, not 11/)
  await assert.rejects(deliver(Q(5), {}, s.cafe), /is for another party/)
  await assert.rejects(deliver(Q(5), {}, s.bistro, s.flour), /has no such item/)
  await assert.rejects(sale(s, '2026-04-03', Q(5), R(300), { trackingId: order.id }), /there is no Delivery Note/)
  await assert.rejects(
    postVoucher(s.companyId, { type: 'Delivery Note', date: '2026-04-03', entries: [], inventory: [{ itemId: s.rice, godownId: s.main, qty: -Q(1), rate: 0, amount: 0 }] }),
    /A Delivery Note needs a party/,
  )
  await assert.rejects(
    postVoucher(s.companyId, { type: 'Sales Order', date: '2026-04-03', partyId: s.bistro, entries: [{ ledgerId: s.bistro, amount: 1 }, { ledgerId: s.sales, amount: -1 }],
      inventory: [{ itemId: s.rice, godownId: s.main, qty: -Q(1), rate: 0, amount: 0 }] }),
    /A Sales Order has no ledger entries/,
  )
  await assert.rejects(postVoucher(s.companyId, { type: 'Stock Journal', date: '2026-04-03', entries: [], inventory: [] }), /needs at least one stock item/)
  // an invoice straight against the order (no note) delivers and moves the stock itself
  await sale(s, '2026-04-04', Q(4), R(240), { orderId: order.id })
  assert.equal((await stock(s)).Rice.closingQty, Q(96))
  const [line] = await pendingLines(pool, s.companyId, { type: 'Sales Order' })
  assert.equal(line.pending, Q(6))
})

test('receipt note brings goods in at its rate; the purchase invoiced against it does not count them twice', async () => {
  const s = await shop()
  const note = await postVoucher(s.companyId, {
    type: 'Receipt Note', date: '2026-04-03', partyId: s.mill, entries: [],
    inventory: [{ itemId: s.flour, godownId: s.main, qty: Q(50), rate: R(30), amount: R(1500) }],
  })
  await postVoucher(s.companyId, {
    type: 'Purchase', date: '2026-04-06', entries: [{ ledgerId: s.purchases, amount: R(1500) }, { ledgerId: s.mill, amount: -R(1500) }],
    inventory: [{ itemId: s.flour, godownId: s.main, qty: Q(50), rate: R(30), amount: R(1500), trackingId: note.id }],
  })
  const { Flour } = await stock(s)
  assert.deepEqual([Flour.closingQty, Flour.closingValue, Flour.rate], [Q(50), R(1500), R(30)])
  assert.deepEqual(await pendingLines(pool, s.companyId, { type: 'Receipt Note' }), [])
})

test('stock journal moves goods between godowns and turns materials into products', async () => {
  const s = await shop()
  await postVoucher(s.companyId, {
    type: 'Stock Journal', date: '2026-04-04', entries: [], narration: 'to the back store',
    inventory: [
      { itemId: s.rice, godownId: s.main, qty: -Q(40), rate: R(40), amount: -R(1600) },
      { itemId: s.rice, godownId: s.store, qty: Q(40), rate: R(40), amount: R(1600) },
    ],
  })
  // milling: 20 kg rice consumed in the back store, 18 kg flour produced at the rice's cost
  await postVoucher(s.companyId, {
    type: 'Stock Journal', date: '2026-04-05', entries: [],
    inventory: [
      { itemId: s.rice, godownId: s.store, qty: -Q(20), rate: R(40), amount: -R(800) },
      { itemId: s.flour, godownId: s.store, qty: Q(18), rate: 4444, amount: R(800) },
    ],
  })
  const p = await stock(s)
  assert.deepEqual([p.Rice.closingQty, p.Rice.rate], [Q(80), R(40)], 'a transfer at average cost leaves the average alone')
  assert.deepEqual([p.Flour.closingQty, p.Flour.closingValue], [Q(18), R(800)])
  const { rows } = await pool.query(
    `SELECT g.name, SUM(i.qty)::bigint qty FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id JOIN godowns g ON g.id = i.godown_id
      WHERE v.company_id = $1 AND i.item_id = $2 GROUP BY g.name ORDER BY g.name`,
    [s.companyId, s.rice],
  )
  assert.deepEqual(rows.map((r) => [r.name, Number(r.qty)]), [['Back Store', Q(20)], ['Main Location', -Q(40)]])
})

test('physical stock: the count sets the stock; shortages go out and excesses come in at average cost', async () => {
  const s = await shop()
  await sale(s, '2026-04-10', Q(10), R(600)) // books: 90 kg rice
  const count = await postVoucher(s.companyId, {
    type: 'Physical Stock', date: '2026-04-30', entries: [],
    inventory: [{ itemId: s.rice, godownId: s.main, qty: 0, rate: 0, amount: 0, counted: Q(85) }],
  })
  let v = await getVoucher(pool, s.companyId, count.id)
  assert.deepEqual([v.inventory[0].counted, v.inventory[0].qty, v.inventory[0].amount], [Q(85), -Q(5), -R(200)])
  assert.equal((await stock(s)).Rice.closingQty, Q(85))
  assert.equal((await stock(s, '2026-04-29')).Rice.closingQty, Q(90), 'before the count the books stand')

  // recounted higher: the difference is worked out again, now an excess at the average rate
  await alterVoucher(s.companyId, count.id, {
    type: 'Physical Stock', date: '2026-04-30', entries: [],
    inventory: [{ itemId: s.rice, godownId: s.main, qty: 0, rate: 0, amount: 0, counted: Q(92) }],
  })
  v = await getVoucher(pool, s.companyId, count.id)
  assert.deepEqual([v.inventory[0].qty, v.inventory[0].amount], [Q(2), R(80)])
  const p = await stock(s)
  assert.deepEqual([p.Rice.closingQty, p.Rice.rate], [Q(92), R(40)])

  // a count matching the books records the check and moves nothing
  const same = await postVoucher(s.companyId, {
    type: 'Physical Stock', date: '2026-05-01', entries: [], inventory: [{ itemId: s.rice, godownId: s.main, qty: 0, rate: 0, amount: 0, counted: Q(92) }],
  })
  assert.equal((await getVoucher(pool, s.companyId, same.id)).inventory[0].qty, 0)
  await assert.rejects(
    postVoucher(s.companyId, { type: 'Physical Stock', date: '2026-05-01', entries: [], inventory: [{ itemId: s.rice, godownId: s.main, qty: 0, rate: 0, amount: 0 }] }),
    /enter the quantity counted/,
  )
})

test('backups carry parties, links, counts and due dates', async () => {
  const s = await shop()
  const order = await postVoucher(s.companyId, {
    type: 'Sales Order', date: '2026-04-02', partyId: s.bistro, entries: [],
    inventory: [{ itemId: s.rice, godownId: s.main, qty: -Q(30), rate: R(60), amount: -R(1800), dueDate: '2026-04-10' }],
  })
  const note = await postVoucher(s.companyId, {
    type: 'Delivery Note', date: '2026-04-05', partyId: s.bistro, entries: [],
    inventory: [{ itemId: s.rice, godownId: s.main, qty: -Q(20), rate: R(60), amount: -R(1200), orderId: order.id }],
  })
  await sale(s, '2026-04-08', Q(20), R(1200), { trackingId: note.id })
  await postVoucher(s.companyId, { type: 'Physical Stock', date: '2026-04-30', entries: [], inventory: [{ itemId: s.rice, godownId: s.main, qty: 0, rate: 0, amount: 0, counted: Q(75) }] })

  const restored = await restoreCompany((await backupCompany(s.companyId)).file)
  const strip = (ls: Awaited<ReturnType<typeof pendingLines>>) => ls.map(({ voucherId: _v, itemId: _i, godownId: _g, partyId: _p, ...l }) => l)
  for (const type of ['Sales Order', 'Delivery Note'] as const)
    assert.deepEqual(strip(await pendingLines(pool, restored.id, { type, all: true })), strip(await pendingLines(pool, s.companyId, { type, all: true })))
  const [a, b] = await Promise.all([
    stockPositions(pool, s.companyId, '2026-04-01', '2027-03-31'),
    stockPositions(pool, restored.id, '2026-04-01', '2027-03-31'),
  ])
  assert.deepEqual(b.map(({ id: _, ...x }) => x), a.map(({ id: _, ...x }) => x))
  assert.equal(a.find((x) => x.name === 'Rice')!.closingQty, Q(75))
})
