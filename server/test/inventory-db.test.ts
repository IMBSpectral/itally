import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { pool, withTx } from '../src/db'
import { migrate } from '../src/migrate'
import { alterVoucher, cancelVoucher, createCompany, createLedger, ledgerBalances, loadGroups, postVoucher, postVouchers } from '../src/books'
import { alterUnit, createStockGroup, createStockItem, createUnit, defaultGodown, deleteStockItem, deleteGodown, stockPositions } from '../src/inventory'
import { balanceSheet, profitAndLoss, trialBalance } from '../src/engine/reports'

const R = (rupees: number) => rupees * 100
const Q = (units: number) => units * 1000
before(() => migrate(() => {}))
after(() => pool.end())

async function shop() {
  const companyId = await createCompany({ name: `Shop ${Date.now()}-${Math.random()}`, booksBegin: '2026-04-01' })
  const groups = await loadGroups(pool, companyId)
  const g = (n: string) => [...groups.values()].find((x) => x.name === n)!.id
  const kg = await createUnit(companyId, { symbol: 'Kg', decimals: 2 })
  const nos = await createUnit(companyId, { symbol: 'Nos' })
  const grains = await createStockGroup(companyId, { name: 'Grains' })
  const rice = await createStockItem(companyId, { name: 'Rice', groupId: grains, unitId: kg, openingQty: Q(100), openingValue: R(4000) })
  const bags = await createStockItem(companyId, { name: 'Bags', unitId: nos })
  const main = await defaultGodown(pool, companyId)
  await createLedger(companyId, { name: 'Capital', groupId: g('Capital Account'), opening: -R(4000) })
  const purchases = await createLedger(companyId, { name: 'Purchases', groupId: g('Purchase Accounts') })
  const sales = await createLedger(companyId, { name: 'Sales', groupId: g('Sales Accounts') })
  const supplier = await createLedger(companyId, { name: 'Agro Supplier', groupId: g('Sundry Creditors'), billwise: false })
  const customer = await createLedger(companyId, { name: 'Bistro', groupId: g('Sundry Debtors'), billwise: false })
  return { companyId, g, kg, nos, rice, bags, main, purchases, sales, supplier, customer }
}

async function books(companyId: number, from = '2026-04-01', to = '2027-03-31') {
  const groups = await loadGroups(pool, companyId)
  const b = await ledgerBalances(pool, companyId, from, to)
  return { tb: trialBalance(groups, b), pl: profitAndLoss(groups, b), bs: balanceSheet(groups, b) }
}

test('item invoices move stock, and average cost feeds the P&L and Balance Sheet', async () => {
  const s = await shop()
  await postVoucher(s.companyId, { type: 'Purchase', date: '2026-04-05', entries: [{ ledgerId: s.purchases, amount: R(2380) }, { ledgerId: s.supplier, amount: -R(2380) }],
    inventory: [
      { itemId: s.rice, godownId: s.main, qty: Q(50), rate: R(46), amount: R(2300) },
      { itemId: s.bags, godownId: s.main, qty: Q(20), rate: R(4), amount: R(80) },
    ] })
  await postVoucher(s.companyId, { type: 'Sales', date: '2026-04-20', entries: [{ ledgerId: s.customer, amount: R(7250) }, { ledgerId: s.sales, amount: -R(7250) }],
    inventory: [
      { itemId: s.rice, godownId: s.main, qty: -Q(120), rate: R(60), amount: -R(7200) },
      { itemId: s.bags, godownId: s.main, qty: -Q(10), rate: R(5), amount: -R(50) },
    ] })

  const pos = Object.fromEntries((await stockPositions(pool, s.companyId, '2026-04-01', '2027-03-31')).map((p) => [p.name, p]))
  assert.equal(pos.Rice.rate, R(42))
  assert.deepEqual([pos.Rice.closingQty, pos.Rice.closingValue], [Q(30), R(1260)])
  assert.deepEqual([pos.Bags.closingQty, pos.Bags.closingValue], [Q(10), R(40)])

  const { tb, pl, bs } = await books(s.companyId)
  assert.equal(pl.openingStock, R(4000))
  assert.equal(pl.closingStock, R(1300))
  assert.equal(pl.grossProfit, R(2170))
  assert.equal(bs.totalAssets, R(8550))
  assert.equal(bs.totalLiabilities, R(8550))
  assert.equal(tb.totalDr, tb.totalCr)
  assert.equal(tb.openingDifference, 0) // item opening values are opening balances, matched by capital
})

test('rules: items must match the sales ledger, move the right way, and fit the unit', async () => {
  const s = await shop()
  const sale = (inventory: { itemId: number; godownId: number; qty: number; rate: number; amount: number }[], amount: number) =>
    postVoucher(s.companyId, { type: 'Sales', date: '2026-04-20', entries: [{ ledgerId: s.customer, amount }, { ledgerId: s.sales, amount: -amount }], inventory })
  await assert.rejects(sale([{ itemId: s.rice, godownId: s.main, qty: -Q(1), rate: R(60), amount: -R(60) }], R(70)), /items total 60/)
  await assert.rejects(sale([{ itemId: s.rice, godownId: s.main, qty: Q(1), rate: R(60), amount: R(60) }], R(60)), /moves stock out/)
  await assert.rejects(sale([{ itemId: s.bags, godownId: s.main, qty: -1500, rate: R(5), amount: -R(7.5) }], R(7.5)), /allows 0 decimal/)
  await assert.rejects(postVoucher(s.companyId, { type: 'Journal', date: '2026-04-20', entries: [{ ledgerId: s.customer, amount: 1 }, { ledgerId: s.supplier, amount: -1 }],
    inventory: [{ itemId: s.rice, godownId: s.main, qty: Q(1), rate: 1, amount: 1 }] }), /cannot carry stock/)
})

test('cancel and alter change the stock with the voucher; items and godowns in use stay', async () => {
  const s = await shop()
  const v = await postVoucher(s.companyId, { type: 'Sales', date: '2026-04-20', entries: [{ ledgerId: s.customer, amount: R(600) }, { ledgerId: s.sales, amount: -R(600) }],
    inventory: [{ itemId: s.rice, godownId: s.main, qty: -Q(10), rate: R(60), amount: -R(600) }] })
  const riceQty = async () => (await stockPositions(pool, s.companyId, '2026-04-01', '2027-03-31')).find((p) => p.name === 'Rice')!.closingQty
  assert.equal(await riceQty(), Q(90))
  // 20.25 kg: a quantity that needs the unit's decimals
  await alterVoucher(s.companyId, v.id, { type: 'Sales', date: '2026-04-20', entries: [{ ledgerId: s.customer, amount: R(1215) }, { ledgerId: s.sales, amount: -R(1215) }],
    inventory: [{ itemId: s.rice, godownId: s.main, qty: -20250, rate: R(60), amount: -R(1215) }] })
  assert.equal(await riceQty(), 79750)
  await assert.rejects(deleteStockItem(s.companyId, s.rice), /has vouchers/)
  await assert.rejects(deleteGodown(s.companyId, s.main), /default location/)
  await assert.rejects(alterUnit(s.companyId, s.kg, { symbol: 'Kg', decimals: 0 }), /more decimal places/)
  await cancelVoucher(s.companyId, v.id)
  assert.equal(await riceQty(), Q(100))
  const log = (await pool.query(`SELECT action, data FROM edit_log WHERE company_id = $1 AND entity = 'voucher' ORDER BY id`, [s.companyId])).rows
  assert.deepEqual(log.map((r) => [r.action, r.data.inventory.length]), [['create', 1], ['alter', 1], ['cancel', 0]])
  assert.equal(log[1].data.inventory[0].qty, -20250)
})

test('bulk posting carries item lines; the database keeps items within their company', async () => {
  const s = await shop()
  const res = await postVouchers(s.companyId, Array.from({ length: 10 }, (_, i) => ({
    type: 'Sales' as const, date: '2026-05-01', entries: [{ ledgerId: s.customer, amount: R(60) }, { ledgerId: s.sales, amount: -R(60) }],
    inventory: [{ itemId: s.rice, godownId: s.main, qty: -Q(1), rate: R(60), amount: -R(60) + (i === 3 ? 1 : 0) }],
  })))
  assert.deepEqual(res.map((r) => r.ok), res.map((_, i) => i !== 3)) // the one whose items don't match its ledger is refused
  assert.equal((await stockPositions(pool, s.companyId, '2026-04-01', '2027-03-31')).find((p) => p.name === 'Rice')!.closingQty, Q(91))
  const other = await shop()
  await assert.rejects(withTx(async (tx) => {
    const v = await tx.query(`INSERT INTO vouchers (company_id, type, number, date) VALUES ($1,'Purchase',99,'2026-04-02') RETURNING id`, [s.companyId])
    await tx.query(`INSERT INTO entries (voucher_id, line, ledger_id, amount) VALUES ($1,1,$2,100),($1,2,$3,-100)`, [v.rows[0].id, s.purchases, s.supplier])
    await tx.query(`INSERT INTO inventory_entries (voucher_id, line, item_id, godown_id, qty, rate, amount) VALUES ($1,1,$2,$3,1000,100,100)`, [v.rows[0].id, other.rice, s.main])
  }), /another company/)
})

test('a later period opens at the value stock had when it began', async () => {
  const s = await shop()
  await postVoucher(s.companyId, { type: 'Sales', date: '2026-05-10', entries: [{ ledgerId: s.customer, amount: R(3000) }, { ledgerId: s.sales, amount: -R(3000) }],
    inventory: [{ itemId: s.rice, godownId: s.main, qty: -Q(50), rate: R(60), amount: -R(3000) }] })
  const q2 = await books(s.companyId, '2026-07-01', '2026-09-30')
  assert.equal(q2.pl.openingStock, R(2000)) // 50 kg left at ₹40
  assert.equal(q2.pl.closingStock, R(2000))
  assert.equal(q2.bs.totalAssets, q2.bs.totalLiabilities)
  assert.equal(q2.tb.openingDifference, 0)
})

test('backup and restore carry inventory: masters, item lines and the valuation', async () => {
  const { backupCompany, restoreCompany } = await import('../src/backup')
  const s = await shop()
  await postVoucher(s.companyId, { type: 'Purchase', date: '2026-04-05', entries: [{ ledgerId: s.purchases, amount: R(2380) }, { ledgerId: s.supplier, amount: -R(2380) }],
    inventory: [{ itemId: s.rice, godownId: s.main, qty: Q(50), rate: R(46), amount: R(2300) }, { itemId: s.bags, godownId: s.main, qty: Q(20), rate: R(4), amount: R(80) }] })
  const restored = await restoreCompany((await backupCompany(s.companyId)).file)
  const strip = (x: unknown) => JSON.parse(JSON.stringify(x, (k, v) => (['id', 'groupId', 'stockGroupId'].includes(k) ? undefined : v)))
  assert.deepEqual(strip(await stockPositions(pool, restored.id, '2026-04-01', '2027-03-31')), strip(await stockPositions(pool, s.companyId, '2026-04-01', '2027-03-31')))
  assert.deepEqual(strip((await books(restored.id)).pl), strip((await books(s.companyId)).pl))
  assert.equal((await pool.query(`SELECT count(*)::int n FROM godowns WHERE company_id = $1 AND is_default`, [restored.id])).rows[0].n, 1)
})

test('the Edit Log labels a unit by its symbol', async () => {
  const s = await shop()
  const bag = await createUnit(s.companyId, { symbol: 'Bag', name: '' })
  const { rows } = await pool.query(`SELECT label FROM edit_log WHERE company_id = $1 AND entity = 'unit' AND entity_id = $2`, [s.companyId, bag])
  assert.deepEqual(rows.map((r) => r.label), ['Bag'])
})
