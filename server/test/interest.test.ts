import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { alterLedger, createCompany, createLedger, loadGroups, postVoucher } from '../src/books'
import { bookInterest, interestSummary, ledgerInterest } from '../src/interest'
import { billStretches, interestFor, stretches } from '../src/engine/interest'

const R = (rupees: number) => rupees * 100
before(() => migrate(() => {}))
after(() => pool.end())

test('simple interest by the day on a 365-day year', () => {
  assert.equal(interestFor(R(100000), 1800, 30), 147945) // ₹1,00,000 at 18% for 30 days = ₹1,479.45
  assert.equal(interestFor(-R(100000), 1800, 365), -R(18000))
  // ₹10,000 Dr from 1 Apr; ₹4,000 paid on 11 Apr; nothing after: 10 days on 10,000, 20 days on 6,000
  const s = stretches(R(10000), [{ date: '2026-04-11', amount: -R(4000) }, { date: '2026-05-05', amount: 0 }], '2026-04-01', '2026-04-30', 1200)
  assert.deepEqual(s.map((x) => [x.from, x.to, x.days, x.amount, x.interest]), [
    ['2026-04-01', '2026-04-10', 10, R(10000), interestFor(R(10000), 1200, 10)],
    ['2026-04-11', '2026-04-30', 20, R(6000), interestFor(R(6000), 1200, 20)],
  ])
  // a bill earns only after it falls due, on what is still unpaid
  const [b] = billStretches([{ name: 'INV-1', dueDate: '2026-04-10', amount: R(5000), settlements: [{ date: '2026-04-21', amount: -R(5000) }] }], '2026-04-01', '2026-04-30', 3650)
  assert.deepEqual(b.stretches.map((x) => [x.from, x.to, x.days]), [['2026-04-11', '2026-04-20', 10]])
  assert.equal(b.interest, R(50)) // 36.5% for 10 days on 5,000 = 1% = ₹50
})

test('ledger interest on the balance and on overdue bills; receivable, payable and group views', async () => {
  const companyId = await createCompany({ name: `Interest ${Date.now()}`, booksBegin: '2026-04-01' })
  const groups = await loadGroups(pool, companyId)
  const g = (n: string) => [...groups.values()].find((x) => x.name === n)!.id
  const cash = (await pool.query(`SELECT id FROM ledgers WHERE company_id = $1 AND name = 'Cash'`, [companyId])).rows[0].id
  const sales = await createLedger(companyId, { name: 'Sales', groupId: g('Sales Accounts') })
  const loan = await createLedger(companyId, { name: 'Bank Loan', groupId: g('Loans (Liability)'), opening: -R(100000), interestRate: 1200 })
  const bistro = await createLedger(companyId, { name: 'Bistro', groupId: g('Sundry Debtors'), interestRate: 3650, interestOn: 'bills' })
  await createLedger(companyId, { name: 'Capital', groupId: g('Capital Account'), opening: R(100000) })
  await assert.rejects(createLedger(companyId, { name: 'X', groupId: g('Indirect Expenses'), interestRate: 1200, interestOn: 'bills' }), /needs bill-wise/)
  await assert.rejects(createLedger(companyId, { name: 'Y', groupId: g('Indirect Expenses'), interestRate: 0 }), /above 0%/)

  // the loan: 1,00,000 Cr from 1 Apr, 40,000 repaid on 1 May; April = 30 days, May = 31 days
  await postVoucher(companyId, { type: 'Payment', date: '2026-05-01', entries: [{ ledgerId: loan, amount: R(40000) }, { ledgerId: cash, amount: -R(40000) }] })
  const l = (await ledgerInterest(pool, companyId, loan, '2026-04-01', '2026-05-31'))!
  assert.deepEqual(l.stretches.map((s) => [s.days, s.amount]), [[30, -R(100000)], [31, -R(60000)]])
  assert.equal(l.interest, interestFor(-R(100000), 1200, 30) + interestFor(-R(60000), 1200, 31))

  // Bistro: a 5,000 bill due 10 Apr, paid 21 Apr: 10 overdue days at 36.5% = ₹50 receivable
  await postVoucher(companyId, { type: 'Sales', date: '2026-04-01', entries: [
    { ledgerId: bistro, amount: R(5000), bills: [{ type: 'New Ref', name: 'INV-1', dueDate: '2026-04-10', amount: R(5000) }] },
    { ledgerId: sales, amount: -R(5000) },
  ] })
  await postVoucher(companyId, { type: 'Receipt', date: '2026-04-21', entries: [
    { ledgerId: cash, amount: R(5000) },
    { ledgerId: bistro, amount: -R(5000), bills: [{ type: 'Agst Ref', name: 'INV-1', amount: -R(5000) }] },
  ] })
  const b = (await ledgerInterest(pool, companyId, bistro, '2026-04-01', '2026-05-31'))!
  assert.deepEqual(b.stretches.map((s) => [s.bill, s.from, s.to]), [['INV-1', '2026-04-11', '2026-04-20']])
  assert.equal(b.interest, R(50))

  const rec = (await interestSummary(companyId, '2026-04-01', '2026-05-31', { side: 'receivable' }))!
  assert.deepEqual(rec.lines.map((x) => [x.name, x.interest]), [['Bistro', R(50)]])
  const pay = (await interestSummary(companyId, '2026-04-01', '2026-05-31', { side: 'payable' }))!
  assert.deepEqual(pay.lines.map((x) => x.name), ['Bank Loan'])
  const debtors = (await interestSummary(companyId, '2026-04-01', '2026-05-31', { groupId: g('Sundry Debtors') }))!
  assert.equal(debtors.total, R(50))
  // booking it: a Journal debits Bistro (as a new bill) and credits Interest Received; the loan's goes to an expense
  const received = await createLedger(companyId, { name: 'Interest Received', groupId: g('Indirect Incomes') })
  const paid = await createLedger(companyId, { name: 'Interest Paid', groupId: g('Indirect Expenses') })
  await assert.rejects(bookInterest(companyId, { ledgerId: bistro, from: '2026-04-01', to: '2026-05-31', interestLedgerId: paid, date: '2026-05-31' }), /income ledger/)
  await bookInterest(companyId, { ledgerId: bistro, from: '2026-04-01', to: '2026-05-31', interestLedgerId: received, date: '2026-05-31' })
  const j = (await pool.query(`SELECT e.ledger_id, e.amount::float8 amount, (SELECT name FROM bill_allocations a WHERE a.entry_id = e.id) bill FROM entries e JOIN vouchers v ON v.id = e.voucher_id
                                WHERE v.company_id = $1 AND v.type = 'Journal' ORDER BY e.line`, [companyId])).rows
  assert.deepEqual(j.map((r) => [r.ledger_id, r.amount, r.bill]), [[bistro, R(50), 'Interest to 2026-05-31'], [received, -R(50), null]])
  const loanInterest = (await ledgerInterest(pool, companyId, loan, '2026-04-01', '2026-05-31'))!.interest
  await bookInterest(companyId, { ledgerId: loan, from: '2026-04-01', to: '2026-05-31', interestLedgerId: paid, date: '2026-05-31' })
  const p = (await pool.query(`SELECT SUM(amount)::float8 s FROM entries WHERE ledger_id = $1`, [paid])).rows[0].s
  assert.equal(p, -loanInterest)
  // switching interest off takes the ledger out
  await alterLedger(companyId, loan, { name: 'Bank Loan', groupId: g('Loans (Liability)'), opening: -R(100000) })
  assert.equal(await ledgerInterest(pool, companyId, loan, '2026-04-01', '2026-05-31'), null)
})
