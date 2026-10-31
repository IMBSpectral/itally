import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { cancelVoucher, createCompany, createLedger, getVoucher, loadGroups, postVoucher, postVouchers, setBankDates } from '../src/books'
import { cancelledVouchers, chequeRegister, depositSlip, negativeLedgers, negativeStock, nextChequeNo, postDatedVouchers } from '../src/cheques'
import { createStockItem, createUnit, defaultGodown } from '../src/inventory'
import { backupCompany, restoreCompany } from '../src/backup'

const R = (rupees: number) => rupees * 100
const TODAY = '2026-10-26'
before(() => migrate(() => {}))
after(() => pool.end())

async function office() {
  const companyId = await createCompany({ name: `Cheques ${Date.now()}-${Math.random()}`, booksBegin: '2026-04-01' })
  const groups = await loadGroups(pool, companyId)
  const g = (n: string) => [...groups.values()].find((x) => x.name === n)!.id
  const cash = (await pool.query(`SELECT id FROM ledgers WHERE company_id = $1 AND name = 'Cash'`, [companyId])).rows[0].id
  const hdfc = await createLedger(companyId, { name: 'HDFC Bank', groupId: g('Bank Accounts'), opening: R(500000) })
  const capital = await createLedger(companyId, { name: 'Capital', groupId: g('Capital Account'), opening: -R(500000) })
  const mill = await createLedger(companyId, { name: 'Mill', groupId: g('Sundry Creditors'), billwise: false })
  const bistro = await createLedger(companyId, { name: 'Bistro', groupId: g('Sundry Debtors'), billwise: false })
  return { companyId, g, cash, hdfc, capital, mill, bistro }
}
type Office = Awaited<ReturnType<typeof office>>
const pay = (s: Office, amount: number, chequeNo: string | null, extra: Record<string, unknown> = {}, date = '2026-10-01') => ({
  type: 'Payment' as const, date, entries: [{ ledgerId: s.mill, amount }, { ledgerId: s.hdfc, amount: -amount, chequeNo, ...extra }],
})

test('cheque details: only on bank lines; the register shows issued and received with their status', async () => {
  const s = await office()
  await assert.rejects(postVoucher(s.companyId, {
    type: 'Payment', date: '2026-10-01', entries: [{ ledgerId: s.mill, amount: R(10), chequeNo: '1' }, { ledgerId: s.cash, amount: -R(10) }],
  }), /cheque details go on a bank ledger/)
  await assert.rejects(postVoucher(s.companyId, pay(s, R(10), '1', { chequeDate: '2026-02-30' })), /invalid cheque date/)

  const a = await postVoucher(s.companyId, pay(s, R(25000), '000123'))
  await postVoucher(s.companyId, pay(s, R(8000), '000124', { chequeDate: '2026-12-15' })) // dated ahead: post-dated
  await postVoucher(s.companyId, {
    type: 'Receipt', date: '2026-10-05', entries: [{ ledgerId: s.hdfc, amount: R(12000), chequeNo: '554411', chequeDate: '2026-10-04' }, { ledgerId: s.bistro, amount: -R(12000) }],
  })
  const paid = await getVoucher(pool, s.companyId, a.id)
  await setBankDates(s.companyId, [{ entryId: (await pool.query(`SELECT id FROM entries WHERE voucher_id = $1 AND ledger_id = $2`, [a.id, s.hdfc])).rows[0].id, bankDate: '2026-10-03' }])
  assert.equal(paid.entries[1].chequeNo, '000123')

  const reg = await chequeRegister(pool, s.companyId, '2026-04-01', '2027-03-31', TODAY)
  assert.deepEqual(reg.map((c) => [c.chequeNo, c.party, c.amount, c.status]), [
    ['000123', 'Mill', -R(25000), 'cleared'],
    ['000124', 'Mill', -R(8000), 'post-dated'],
    ['554411', 'Bistro', R(12000), 'pending'],
  ])
  assert.equal(await nextChequeNo(pool, s.hdfc), '000125', 'the next leaf, leading zeros kept')
  assert.equal(await nextChequeNo(pool, s.cash), null)
  const slip = await depositSlip(pool, s.companyId, s.hdfc, '2026-04-01', '2027-03-31', TODAY)
  assert.deepEqual(slip.map((c) => c.chequeNo), ['554411'], 'only received instruments not yet cleared')
})

test('post-dated vouchers, cancelled vouchers, negative ledgers and negative stock', async () => {
  const s = await office()
  const pdc = await postVoucher(s.companyId, { ...pay(s, R(3000), '7', {}, '2027-01-15'), postDated: true })
  await postVoucher(s.companyId, { ...pay(s, R(1000), '8', {}, '2026-09-01'), postDated: true }) // its date has come: no longer listed
  const listed = await postDatedVouchers(pool, s.companyId, TODAY)
  assert.deepEqual(listed.map((v) => [v.id, v.date, v.amount]), [[pdc.id, '2027-01-15', R(3000)]])
  assert.equal((await getVoucher(pool, s.companyId, pdc.id)).postDated, true)

  const x = await postVoucher(s.companyId, { type: 'Payment', date: '2026-10-02', entries: [{ ledgerId: s.mill, amount: R(50) }, { ledgerId: s.cash, amount: -R(50) }] })
  await cancelVoucher(s.companyId, x.id)
  const cancelled = await cancelledVouchers(pool, s.companyId, '2026-04-01', '2027-03-31')
  assert.deepEqual(cancelled.map((v) => [v.id, v.by]), [[x.id, 'local user']])

  // cash paid out without any in: Cash stands in credit; Mill, paid more than owed, in debit
  await postVoucher(s.companyId, { type: 'Payment', date: '2026-10-02', entries: [{ ledgerId: s.mill, amount: R(60) }, { ledgerId: s.cash, amount: -R(60) }] })
  const neg = await negativeLedgers(pool, s.companyId, '2026-04-01', '2027-03-31')
  assert.deepEqual(neg.map((l) => l.name).sort(), ['Cash', 'Mill'])

  const kg = await createUnit(s.companyId, { symbol: 'Kg' })
  const rice = await createStockItem(s.companyId, { name: 'Rice', unitId: kg })
  const sales = await createLedger(s.companyId, { name: 'Sales', groupId: s.g('Sales Accounts') })
  await postVoucher(s.companyId, {
    type: 'Sales', date: '2026-10-03', entries: [{ ledgerId: s.bistro, amount: R(100) }, { ledgerId: sales, amount: -R(100) }],
    inventory: [{ itemId: rice, godownId: await defaultGodown(pool, s.companyId), qty: -2000, rate: R(50), amount: -R(100) }],
  })
  assert.deepEqual((await negativeStock(pool, s.companyId, '2026-04-01', '2027-03-31')).map((i) => [i.name, i.closingQty]), [['Rice', -2000]])
})

test('batch imports, the Edit Log and backups carry cheques and post-dating', async () => {
  const s = await office()
  const [r] = await postVouchers(s.companyId, [{ ...pay(s, R(700), '42', { chequeDate: '2026-10-09' }), postDated: true }])
  assert.ok(r.ok)
  const { rows } = await pool.query(`SELECT data FROM edit_log WHERE company_id = $1 AND entity = 'voucher'`, [s.companyId])
  assert.equal(rows[0].data.postDated, true)
  assert.deepEqual(rows[0].data.entries[1].cheque, { no: '42', date: '2026-10-09' })
  const restored = await restoreCompany((await backupCompany(s.companyId)).file)
  const [c] = await chequeRegister(pool, restored.id, '2026-04-01', '2027-03-31', TODAY)
  assert.deepEqual([c.chequeNo, c.chequeDate, c.amount], ['42', '2026-10-09', -R(700)])
  assert.equal((await pool.query(`SELECT post_dated FROM vouchers WHERE company_id = $1`, [restored.id])).rows[0].post_dated, true)
})
