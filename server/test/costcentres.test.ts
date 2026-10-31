import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { alterLedger, alterVoucher, cancelVoucher, createCompany, createLedger, getVoucher, loadGroups, postVoucher, postVouchers } from '../src/books'
import {
  alterCostCentre, categorySummary, centreBreakup, centresOf, createCostCategory, createCostCentre, deleteCostCategory, deleteCostCentre, listCostMasters,
} from '../src/costcentres'
import { backupCompany, restoreCompany } from '../src/backup'

const R = (rupees: number) => rupees * 100
before(() => migrate(() => {}))
after(() => pool.end())

async function office() {
  const companyId = await createCompany({ name: `Costs ${Date.now()}-${Math.random()}`, booksBegin: '2026-04-01' })
  const groups = await loadGroups(pool, companyId)
  const g = (n: string) => [...groups.values()].find((x) => x.name === n)!.id
  const cash = (await pool.query(`SELECT id FROM ledgers WHERE company_id = $1 AND name = 'Cash'`, [companyId])).rows[0].id
  const rent = await createLedger(companyId, { name: 'Rent', groupId: g('Indirect Expenses'), costCentres: true })
  const travel = await createLedger(companyId, { name: 'Travel', groupId: g('Indirect Expenses'), costCentres: true })
  const fees = await createLedger(companyId, { name: 'Consulting Fees', groupId: g('Indirect Incomes'), costCentres: true })
  const plain = await createLedger(companyId, { name: 'Postage', groupId: g('Indirect Expenses') })
  const projects = await createCostCategory(companyId, { name: 'Projects' })
  const mumbai = await createCostCentre(companyId, { name: 'Mumbai Office' })
  const sales = await createCostCentre(companyId, { name: 'Sales Team', parentId: mumbai })
  const pune = await createCostCentre(companyId, { name: 'Pune Office' })
  const alpha = await createCostCentre(companyId, { name: 'Project Alpha', categoryId: projects })
  return { companyId, g, cash, rent, travel, fees, plain, projects, mumbai, sales, pune, alpha }
}
type Office = Awaited<ReturnType<typeof office>>
const pay = (s: Office, ledgerId: number, amount: number, costs?: { centreId: number; amount: number }[], date = '2026-04-10') =>
  ({ type: 'Payment' as const, date, entries: [{ ledgerId, amount, ...(costs ? { costs } : {}) }, { ledgerId: s.cash, amount: -amount }] })

test('cost masters: Primary Cost Category, a tree of centres, and what can be deleted', async () => {
  const s = await office()
  const { categories, centres } = await listCostMasters(pool, s.companyId)
  assert.deepEqual(categories.map((c) => c.name), ['Primary Cost Category', 'Projects'])
  const primary = categories[0].id
  assert.deepEqual(centres.find((c) => c.name === 'Sales Team'), { id: s.sales, name: 'Sales Team', categoryId: primary, parentId: s.mumbai })
  await assert.rejects(createCostCentre(s.companyId, { name: 'Mumbai Office' }), /already used/)
  await assert.rejects(createCostCentre(s.companyId, { name: 'X', categoryId: s.projects, parentId: s.mumbai }), /same category/)
  await assert.rejects(alterCostCentre(s.companyId, s.mumbai, { name: 'Mumbai Office', parentId: s.sales }), /under itself/)
  await assert.rejects(alterCostCentre(s.companyId, s.mumbai, { name: 'Mumbai Office', categoryId: s.projects }), /sub-centres cannot change category/)
  await assert.rejects(deleteCostCategory(s.companyId, primary), /predefined/)
  await assert.rejects(deleteCostCategory(s.companyId, s.projects), /has cost centres/)
  await assert.rejects(deleteCostCentre(s.companyId, s.mumbai), /in use/)
  await deleteCostCentre(s.companyId, s.pune)
})

test('allocation rules: only where cost centres apply, known centres, the entry side, adding up', async () => {
  const s = await office()
  await assert.rejects(postVoucher(s.companyId, pay(s, s.plain, R(100), [{ centreId: s.mumbai, amount: R(100) }])), /cost centres don't apply/)
  await assert.rejects(postVoucher(s.companyId, pay(s, s.rent, R(100), [{ centreId: s.mumbai, amount: R(60) }])), /cost centres total 60, but the entry is 100/)
  await assert.rejects(postVoucher(s.companyId, pay(s, s.rent, R(100), [{ centreId: s.mumbai, amount: -R(100) }])), /on the entry's side/)
  await assert.rejects(postVoucher(s.companyId, pay(s, s.rent, R(100), [{ centreId: 999999, amount: R(100) }])), /unknown cost centre/)
  await assert.rejects(postVoucher(s.companyId, pay(s, s.rent, R(100), [{ centreId: s.mumbai, amount: R(50) }, { centreId: s.mumbai, amount: R(50) }])), /appears twice/)
  const other = await office()
  await assert.rejects(postVoucher(s.companyId, pay(s, s.rent, R(100), [{ centreId: other.mumbai, amount: R(100) }])), /unknown cost centre/)
  // allocation is optional: an entry may stay unsplit
  await postVoucher(s.companyId, pay(s, s.rent, R(100)))
})

test('reports: category summary with sub-centres rolled up, centre, ledger and group break-ups', async () => {
  const s = await office()
  const v = await postVoucher(s.companyId, pay(s, s.rent, R(1000), [{ centreId: s.mumbai, amount: R(600) }, { centreId: s.pune, amount: R(400) }]))
  await postVoucher(s.companyId, pay(s, s.travel, R(300), [{ centreId: s.sales, amount: R(200) }, { centreId: s.alpha, amount: R(100) }]))
  await postVoucher(s.companyId, {
    type: 'Receipt', date: '2026-04-12',
    entries: [{ ledgerId: s.cash, amount: R(500) }, { ledgerId: s.fees, amount: -R(500), costs: [{ centreId: s.alpha, amount: -R(500) }] }],
  })
  const sum = await categorySummary(s.companyId, '2026-04-01', '2027-03-31')
  const primary = sum.categories.find((c) => c.name === 'Primary Cost Category')!
  assert.deepEqual(primary.lines.map((l) => [l.name, l.depth, l.dr, l.cr]), [
    ['Mumbai Office', 0, R(800), 0], ['Sales Team', 1, R(200), 0], ['Pune Office', 0, R(400), 0],
  ])
  assert.deepEqual(primary.total, { dr: R(1200), cr: 0 }, 'a sub-centre counts once, inside its parent')
  assert.deepEqual(sum.categories.find((c) => c.name === 'Projects')!.lines.map((l) => [l.name, l.dr, l.cr]), [['Project Alpha', R(100), R(500)]])

  const mumbai = (await centreBreakup(s.companyId, s.mumbai, '2026-04-01', '2027-03-31'))!
  assert.deepEqual(mumbai.lines.map((l) => [l.name, l.dr]), [['Rent', R(600)], ['Travel', R(200)]])
  const rent = (await centresOf(s.companyId, { ledgerId: s.rent }, '2026-04-01', '2027-03-31'))!
  assert.deepEqual(rent.lines.map((l) => [l.name, l.dr]), [['Mumbai Office', R(600)], ['Pune Office', R(400)]])
  const expenses = (await centresOf(s.companyId, { groupId: s.g('Indirect Expenses') }, '2026-04-01', '2027-03-31'))!
  assert.deepEqual(expenses.total, { dr: R(1300), cr: 0 })

  // alteration replaces the split; cancelling takes it out of the reports
  await alterVoucher(s.companyId, v.id, pay(s, s.rent, R(1000), [{ centreId: s.pune, amount: R(1000) }]))
  assert.deepEqual((await getVoucher(pool, s.companyId, v.id)).entries[0].costs.map((c: { centre: string; amount: number }) => [c.centre, c.amount]), [['Pune Office', R(1000)]])
  await cancelVoucher(s.companyId, v.id)
  assert.equal((await centresOf(s.companyId, { ledgerId: s.rent }, '2026-04-01', '2027-03-31'))!.lines.length, 0)
  // a ledger with split entries keeps cost centres on
  await assert.rejects(alterLedger(s.companyId, s.travel, { name: 'Travel', groupId: s.g('Indirect Expenses'), costCentres: false }), /must stay applicable/)
})

test('batch imports, the Edit Log and backups carry the split', async () => {
  const s = await office()
  const r = await postVouchers(s.companyId, [pay(s, s.rent, R(900), [{ centreId: s.mumbai, amount: R(500) }, { centreId: s.alpha, amount: R(400) }])])
  assert.ok(r[0].ok)
  const { rows } = await pool.query(`SELECT data FROM edit_log WHERE company_id = $1 AND entity = 'voucher'`, [s.companyId])
  assert.deepEqual(rows[0].data.entries[0].costs, [{ centre: 'Mumbai Office', amount: R(500) }, { centre: 'Project Alpha', amount: R(400) }])

  const restored = await restoreCompany((await backupCompany(s.companyId)).file)
  const a = await categorySummary(s.companyId, '2026-04-01', '2027-03-31')
  const b = await categorySummary(restored.id, '2026-04-01', '2027-03-31')
  const shape = (x: typeof a) => x.categories.map((c) => [c.name, c.lines.map((l) => [l.name, l.depth, l.dr, l.cr])])
  assert.deepEqual(shape(b), shape(a))
  const rentRestored = (await pool.query(`SELECT cost_centres FROM ledgers WHERE company_id = $1 AND name = 'Rent'`, [restored.id])).rows[0]
  assert.equal(rentRestored.cost_centres, true)
})
