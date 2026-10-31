import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { alterLedger, alterVoucher, createCompany, createLedger, getLedger, getVoucher, ledgerBalances, loadGroups, pendingBills, postVoucher, postVouchers } from '../src/books'
import { draftVouchers } from '../src/cheques'
import { createStockItem, createUnit, defaultGodown, stockPositions } from '../src/inventory'
import { backupCompany, restoreCompany } from '../src/backup'

const R = (rupees: number) => rupees * 100
before(() => migrate(() => {}))
after(() => pool.end())

async function shop() {
  const companyId = await createCompany({ name: `Drafts ${Date.now()}-${Math.random()}`, booksBegin: '2026-04-01' })
  const groups = await loadGroups(pool, companyId)
  const g = (n: string) => [...groups.values()].find((x) => x.name === n)!.id
  const cash = (await pool.query(`SELECT id FROM ledgers WHERE company_id = $1 AND name = 'Cash'`, [companyId])).rows[0].id
  const rent = await createLedger(companyId, { name: 'Rent', groupId: g('Indirect Expenses') })
  const sales = await createLedger(companyId, { name: 'Sales', groupId: g('Sales Accounts') })
  const bistro = await createLedger(companyId, { name: 'Bistro', groupId: g('Sundry Debtors') })
  return { companyId, g, cash, rent, sales, bistro }
}
const balance = async (companyId: number, id: number) => (await ledgerBalances(pool, companyId, '2026-04-01', '2027-03-31')).find((b) => b.id === id)!.closing

test('an optional voucher is kept but stays out of the books until it is made regular', async () => {
  const s = await shop()
  const v = await postVoucher(s.companyId, {
    type: 'Sales', date: '2026-05-01', optional: true,
    entries: [{ ledgerId: s.bistro, amount: R(900), bills: [{ type: 'New Ref', name: 'Q-1', amount: R(900) }] }, { ledgerId: s.sales, amount: -R(900) }],
  })
  assert.equal(await balance(s.companyId, s.bistro), 0)
  assert.deepEqual(await pendingBills(pool, s.companyId, '2027-03-31', s.bistro), [], 'a draft starts no bill')
  const got = await getVoucher(pool, s.companyId, v.id)
  assert.equal(got.optional, true)
  assert.deepEqual(got.entries.map((e: { ledger: string; amount: number }) => [e.ledger, e.amount]), [['Bistro', R(900)], ['Sales', -R(900)]])
  assert.deepEqual((await draftVouchers(pool, s.companyId, 'optional', '2026-04-01', '2027-03-31')).map((x) => [x.id, x.amount]), [[v.id, R(900)]])
  // still checked like any voucher
  await assert.rejects(postVoucher(s.companyId, { type: 'Sales', date: '2026-05-01', optional: true, entries: [{ ledgerId: s.bistro, amount: R(1) }, { ledgerId: s.sales, amount: -R(2) }] }), /differ/)

  // made regular: it posts, and its bill starts
  await alterVoucher(s.companyId, v.id, {
    type: 'Sales', date: '2026-05-01',
    entries: [{ ledgerId: s.bistro, amount: R(900), bills: [{ type: 'New Ref', name: 'Q-1', amount: R(900) }] }, { ledgerId: s.sales, amount: -R(900) }],
  })
  assert.equal(await balance(s.companyId, s.bistro), R(900))
  assert.deepEqual((await pendingBills(pool, s.companyId, '2027-03-31', s.bistro)).map((b) => b.name), ['Q-1'])
  assert.equal((await getVoucher(pool, s.companyId, v.id)).optional, false)
  // and back to optional takes it out again
  await alterVoucher(s.companyId, v.id, { type: 'Sales', date: '2026-05-01', optional: true, entries: [{ ledgerId: s.bistro, amount: R(900) }, { ledgerId: s.sales, amount: -R(900) }] })
  assert.equal(await balance(s.companyId, s.bistro), 0)
})

test('memorandum vouchers, optional item invoices and imports stay out of the books too', async () => {
  const s = await shop()
  const memo = await postVoucher(s.companyId, { type: 'Memorandum', date: '2026-06-01', narration: 'advance to staff, to be settled', entries: [{ ledgerId: s.rent, amount: R(50) }, { ledgerId: s.cash, amount: -R(50) }] })
  assert.equal(await balance(s.companyId, s.cash), 0)
  assert.deepEqual((await draftVouchers(pool, s.companyId, 'memorandum', '2026-04-01', '2027-03-31')).map((x) => x.id), [memo.id])

  const kg = await createUnit(s.companyId, { symbol: 'Kg' })
  const rice = await createStockItem(s.companyId, { name: 'Rice', unitId: kg, openingQty: 10000, openingValue: R(400) })
  await postVoucher(s.companyId, {
    type: 'Sales', date: '2026-06-02', optional: true, entries: [{ ledgerId: s.bistro, amount: R(300) }, { ledgerId: s.sales, amount: -R(300) }],
    inventory: [{ itemId: rice, godownId: await defaultGodown(pool, s.companyId), qty: -5000, rate: R(60), amount: -R(300) }],
  })
  assert.equal((await stockPositions(pool, s.companyId, '2026-04-01', '2027-03-31'))[0].closingQty, 10000, 'no stock moves')

  const [r] = await postVouchers(s.companyId, [{ type: 'Payment', date: '2026-06-03', optional: true, entries: [{ ledgerId: s.rent, amount: R(70) }, { ledgerId: s.cash, amount: -R(70) }] }])
  assert.ok(r.ok)
  assert.equal(await balance(s.companyId, s.rent), 0)
  const { rows } = await pool.query(`SELECT data FROM edit_log WHERE company_id = $1 AND entity = 'voucher' ORDER BY id`, [s.companyId])
  assert.equal(rows.at(-1).data.optional, true)
  assert.equal(rows.at(-1).data.draft.entries[0].ledger, 'Rent')

  // a backup brings the drafts back against the new company's ledgers and items
  const restored = await restoreCompany((await backupCompany(s.companyId)).file)
  const [opt] = await draftVouchers(pool, restored.id, 'optional', '2026-06-02', '2026-06-02')
  const v = await getVoucher(pool, restored.id, opt.id)
  assert.deepEqual(v.inventory.map((l: { item: string; qty: number }) => [l.item, l.qty]), [['Rice', -5000]])
  const bistro = (await pool.query(`SELECT id FROM ledgers WHERE company_id = $1 AND name = 'Bistro'`, [restored.id])).rows[0].id
  assert.equal(v.entries[0].ledgerId, bistro)
  await alterVoucher(restored.id, v.id, { type: 'Sales', date: v.date, entries: v.entries.map(({ ledgerId, amount }: { ledgerId: number; amount: number }) => ({ ledgerId, amount })), inventory: v.inventory.map(({ item: _, ...l }: { item: string }) => l) })
  assert.equal((await stockPositions(pool, restored.id, '2026-04-01', '2027-03-31'))[0].closingQty, 5000)
})

test('ledger mailing details: PAN, PIN code and e-mail are checked; the PAN must match the GSTIN', async () => {
  const s = await shop()
  const base = { name: 'Agro Traders', groupId: s.g('Sundry Creditors') }
  await assert.rejects(createLedger(s.companyId, { ...base, pan: 'ABCDE1234' }), /is not a PAN/)
  await assert.rejects(createLedger(s.companyId, { ...base, pincode: '04001' }), /is not a PIN code/)
  await assert.rejects(createLedger(s.companyId, { ...base, email: 'agro@' }), /is not an e-mail/)
  await assert.rejects(createLedger(s.companyId, { ...base, gstin: '27AAPFU0939F1ZV', pan: 'ABCDE1234F' }), /does not match the GSTIN/)
  const id = await createLedger(s.companyId, {
    ...base, mailingName: 'Agro Traders Pvt Ltd', address: '12 Market Yard\nPune', pincode: '411037', phone: '020 2426 0000',
    email: 'accounts@agro.example', gstin: '27AAPFU0939F1ZV', pan: 'aapfu0939f',
  })
  const l = await getLedger(pool, s.companyId, id)
  assert.deepEqual([l.mailingName, l.address, l.pincode, l.pan, l.email], ['Agro Traders Pvt Ltd', '12 Market Yard\nPune', '411037', 'AAPFU0939F', 'accounts@agro.example'])
  // a foreign address keeps its own postal code
  await alterLedger(s.companyId, id, { ...base, country: 'Singapore', pincode: '049315' })
  assert.equal((await getLedger(pool, s.companyId, id)).pincode, '049315')
})
