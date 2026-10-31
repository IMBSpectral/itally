import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { pool, withTx } from '../src/db'
import { migrate } from '../src/migrate'
import {
  alterVoucher,
  cancelVoucher,
  createCompany,
  createLedger,
  deleteVoucher,
  getVoucher,
  ledgerBalances,
  loadGroups,
  postVoucher,
  setStockValue,
  ValidationError,
} from '../src/books'
import { balanceSheet, profitAndLoss, trialBalance } from '../src/engine/reports'

const R = (rupees: number) => rupees * 100

before(() => migrate(() => {}))
after(() => pool.end())

async function setup(name = 'Test Co') {
  const companyId = await createCompany({ name: `${name} ${Date.now()}-${Math.random()}`, booksBegin: '2026-04-01' })
  const groups = await loadGroups(pool, companyId)
  const g = (n: string) => [...groups.values()].find((x) => x.name === n)!.id
  const { rows } = await pool.query(`SELECT id, name FROM ledgers WHERE company_id = $1`, [companyId])
  const ids = new Map<string, number>(rows.map((r) => [r.name, r.id]))
  const add = async (n: string, group: string, opening = 0) => ids.set(n, await createLedger(companyId, { name: n, groupId: g(group), opening }))
  await pool.query(`UPDATE ledgers SET opening = $2 WHERE company_id = $1 AND name = 'Cash'`, [companyId, R(100000)])
  await add('Opening Stock', 'Stock-in-Hand', R(20000))
  await add('Proprietor Capital', 'Capital Account', -R(120000))
  await add('Purchases', 'Purchase Accounts')
  await add('Sales', 'Sales Accounts')
  await add('Rent', 'Indirect Expenses')
  await add('Interest Received', 'Indirect Incomes')
  await add('Acme Suppliers', 'Sundry Creditors')
  await add('Bharat Traders', 'Sundry Debtors')
  await add('HDFC Bank', 'Bank Accounts')
  const e = (n: string, a: number) => ({ ledgerId: ids.get(n)!, amount: R(a) })
  return { companyId, groups, ids, e }
}

async function reports(companyId: number, from = '2026-04-01', to = '2027-03-31') {
  const groups = await loadGroups(pool, companyId)
  const b = await ledgerBalances(pool, companyId, from, to)
  return { tb: trialBalance(groups, b), pl: profitAndLoss(groups, b), bs: balanceSheet(groups, b), b }
}

test('company is created with 28 groups, Cash and Profit & Loss A/c', async () => {
  const companyId = await createCompany({ name: `Seed ${Date.now()}`, booksBegin: '2026-04-01' })
  const g = await pool.query(`SELECT count(*)::int n FROM groups WHERE company_id = $1`, [companyId])
  const l = await pool.query(`SELECT name FROM ledgers WHERE company_id = $1 ORDER BY name`, [companyId])
  assert.equal(g.rows[0].n, 28)
  assert.deepEqual(l.rows.map((r) => r.name), ['Cash', 'Profit & Loss A/c'])
})

test('posting the worked example produces the same reports as the pure engine', async () => {
  const { companyId, ids, e } = await setup()
  await postVoucher(companyId, { type: 'Purchase', date: '2026-04-05', entries: [e('Purchases', 50000), e('Acme Suppliers', -50000)] })
  await postVoucher(companyId, { type: 'Sales', date: '2026-04-10', entries: [e('Bharat Traders', 80000), e('Sales', -80000)] })
  await postVoucher(companyId, { type: 'Payment', date: '2026-04-30', entries: [e('Rent', 5000), e('Cash', -5000)] })
  await postVoucher(companyId, { type: 'Receipt', date: '2026-05-02', entries: [e('Cash', 30000), e('Bharat Traders', -30000)] })
  await postVoucher(companyId, { type: 'Receipt', date: '2026-05-03', entries: [e('Cash', 1000), e('Interest Received', -1000)] })
  await setStockValue(companyId, ids.get('Opening Stock')!, '2027-03-31', R(25000))

  const { tb, pl, bs } = await reports(companyId)
  assert.equal(tb.totalDr, R(251000))
  assert.equal(tb.totalCr, R(251000))
  assert.equal(pl.netProfit, R(31000))
  assert.equal(bs.totalAssets, R(201000))
  assert.equal(bs.totalLiabilities, R(201000))
})

test('the database refuses an unbalanced voucher even when the API is bypassed', async () => {
  const { companyId, ids } = await setup()
  await assert.rejects(
    withTx(async (tx) => {
      const v = await tx.query(`INSERT INTO vouchers (company_id, type, number, date) VALUES ($1,'Journal',999,'2026-04-02') RETURNING id`, [companyId])
      await tx.query(`INSERT INTO entries (voucher_id, line, ledger_id, amount) VALUES ($1,1,$2,100),($1,2,$3,-99)`, [
        v.rows[0].id,
        ids.get('Rent'),
        ids.get('Acme Suppliers'),
      ])
    }),
    /not balanced/,
  )
  const left = await pool.query(`SELECT count(*)::int n FROM vouchers WHERE company_id = $1`, [companyId])
  assert.equal(left.rows[0].n, 0)
})

test("the database refuses another company's ledger", async () => {
  const a = await setup('A')
  const b = await setup('B')
  await assert.rejects(
    postVoucher(a.companyId, {
      type: 'Journal',
      date: '2026-04-02',
      entries: [a.e('Rent', 10), { ledgerId: b.ids.get('Acme Suppliers')!, amount: -R(10) }],
    }),
    (err) => err instanceof ValidationError && /unknown ledger/.test(err.message),
  )
  // and directly in SQL, where the engine isn't involved
  await assert.rejects(
    withTx(async (tx) => {
      const v = await tx.query(`INSERT INTO vouchers (company_id, type, number, date) VALUES ($1,'Journal',1,'2026-04-02') RETURNING id`, [a.companyId])
      await tx.query(`INSERT INTO entries (voucher_id, line, ledger_id, amount) VALUES ($1,1,$2,100),($1,2,$3,-100)`, [
        v.rows[0].id,
        a.ids.get('Rent'),
        b.ids.get('Acme Suppliers'),
      ])
    }),
    /another company/,
  )
})

test('alter, cancel and delete keep the daily balances exact', async () => {
  const { companyId, ids, e } = await setup()
  const balance = async (n: string) => (await ledgerBalances(pool, companyId, '2026-04-01', '2027-03-31')).find((b) => b.id === ids.get(n))!.closing
  const v = await postVoucher(companyId, { type: 'Payment', date: '2026-04-10', entries: [e('Rent', 5000), e('Cash', -5000)] })
  assert.equal(await balance('Rent'), R(5000))

  // alter: new amount and a different date
  await alterVoucher(companyId, v.id, { type: 'Payment', date: '2026-06-01', entries: [e('Rent', 7000), e('Cash', -7000)] }, 1)
  assert.equal(await balance('Rent'), R(7000))
  assert.equal(await balance('Cash'), R(100000 - 7000))
  const daily = await pool.query(`SELECT to_char(day,'YYYY-MM-DD') AS "day", dr, cr FROM ledger_daily WHERE ledger_id = $1 AND (dr <> 0 OR cr <> 0)`, [ids.get('Rent')])
  assert.deepEqual(daily.rows, [{ day: '2026-06-01', dr: R(7000), cr: 0 }])

  // stale version is refused
  await assert.rejects(alterVoucher(companyId, v.id, { type: 'Payment', date: '2026-06-01', entries: [e('Rent', 1), e('Cash', -1)] }, 1), /changed by someone else/)

  await cancelVoucher(companyId, v.id)
  assert.equal(await balance('Rent'), 0)
  const cancelled = await getVoucher(pool, companyId, v.id)
  assert.equal(cancelled.cancelled, true)
  assert.equal(cancelled.number, 1)

  const w = await postVoucher(companyId, { type: 'Payment', date: '2026-04-12', entries: [e('Rent', 300), e('Cash', -300)] })
  assert.equal(w.number, 2) // cancelled number isn't reused
  await deleteVoucher(companyId, w.id)
  assert.equal(await balance('Rent'), 0)
  assert.equal(await balance('Cash'), R(100000))
})

test('parallel postings get distinct consecutive numbers', async () => {
  const { companyId, e } = await setup()
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      postVoucher(companyId, { type: 'Payment', date: '2026-04-15', entries: [e('Rent', i + 1), e('Cash', -(i + 1))] }),
    ),
  )
  assert.deepEqual(results.map((r) => r.number).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1))
  const { b } = await reports(companyId)
  assert.equal(b.find((x) => x.name === 'Rent')!.closing, R(210))
})

test('a later period carries earlier profit into Profit & Loss A/c and still balances', async () => {
  const { companyId, ids, e } = await setup()
  // Q1: a bank sale of 9,000 and stock up from 20,000 to 22,000 -> profit 11,000
  await postVoucher(companyId, { type: 'Sales', date: '2026-05-10', entries: [e('HDFC Bank', 9000), e('Sales', -9000)] })
  await setStockValue(companyId, ids.get('Opening Stock')!, '2026-06-30', R(22000))
  const q1 = await reports(companyId, '2026-04-01', '2026-06-30')
  assert.equal(q1.pl.netProfit, R(11000))

  // Q2: only rent of 2,000; stock stays at 22,000
  await postVoucher(companyId, { type: 'Payment', date: '2026-07-05', entries: [e('Rent', 2000), e('Cash', -2000)] })
  const q2 = await reports(companyId, '2026-07-01', '2026-09-30')
  assert.equal(q2.pl.openingStock, R(22000))
  assert.equal(q2.pl.netProfit, -R(2000))
  const pl = q2.b.find((x) => x.name === 'Profit & Loss A/c')!
  assert.equal(pl.opening, -R(11000)) // Q1 profit carried forward as a credit
  assert.equal(q2.bs.profitAndLoss.total, R(9000))
  assert.equal(q2.bs.totalAssets, q2.bs.totalLiabilities)
  assert.equal(q2.tb.totalDr, q2.tb.totalCr)
  assert.equal(q2.tb.openingDifference, 0)
})

test('batch posting: bad vouchers are reported on their own, good ones post with gap-free numbers', async () => {
  const { companyId, e } = await setup()
  const { postVouchers } = await import('../src/books')
  const results = await postVouchers(companyId, [
    { type: 'Payment', date: '2026-04-10', entries: [e('Rent', 100), e('Cash', -100)] },
    { type: 'Payment', date: '2026-04-11', entries: [e('Rent', 100), e('Cash', -99)] }, // unbalanced
    { type: 'Payment', date: '2026-04-12', entries: [e('Rent', 50), e('Cash', -50)] },
  ])
  assert.deepEqual(results.map((r) => r.ok), [true, false, true])
  assert.deepEqual(results.filter((r) => r.ok).map((r) => (r as { number: number }).number), [1, 2])
  assert.match((results[1] as { errors: string[] }).errors.join(), /differ by 1/)
  const { b } = await reports(companyId)
  assert.equal(b.find((x) => x.name === 'Rent')!.closing, R(150))
})

test('batch posting: a failure only the database catches falls back to per-voucher isolation', async () => {
  const { companyId, e } = await setup()
  const { postVouchers } = await import('../src/books')
  // a rule the engine doesn't know about, so the bulk insert itself fails
  await pool.query(`CREATE OR REPLACE FUNCTION test_boom() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.narration = 'boom' THEN RAISE EXCEPTION 'boom refused'; END IF; RETURN NEW; END $$`)
  await pool.query(`CREATE TRIGGER test_boom BEFORE INSERT ON vouchers FOR EACH ROW EXECUTE FUNCTION test_boom()`)
  try {
    const results = await postVouchers(companyId, [
      { type: 'Payment', date: '2026-04-10', narration: 'a', entries: [e('Rent', 100), e('Cash', -100)] },
      { type: 'Payment', date: '2026-04-11', narration: 'boom', entries: [e('Rent', 7), e('Cash', -7)] },
      { type: 'Payment', date: '2026-04-12', narration: 'c', entries: [e('Rent', 50), e('Cash', -50)] },
    ])
    assert.deepEqual(results.map((r) => r.ok), [true, false, true])
    assert.match((results[1] as { errors: string[] }).errors.join(), /boom refused/)
    const { b } = await reports(companyId)
    assert.equal(b.find((x) => x.name === 'Rent')!.closing, R(150))
  } finally {
    await pool.query(`DROP TRIGGER test_boom ON vouchers`)
    await pool.query(`DROP FUNCTION test_boom()`)
  }
})

test('a company with vouchers, bills and stock values can be deleted outright', async () => {
  const { companyId, ids, e } = await setup()
  await postVoucher(companyId, { type: 'Sales', date: '2026-04-10', entries: [
    { ...e('Bharat Traders', 500), bills: [{ type: 'New Ref', name: 'D-1', amount: R(500) }] }, e('Sales', -500) ] })
  await postVoucher(companyId, { type: 'Payment', date: '2026-04-11', entries: [e('Rent', 50), e('Cash', -50)] })
  await setStockValue(companyId, ids.get('Opening Stock')!, '2026-06-30', R(1))
  await pool.query(`DELETE FROM companies WHERE id = $1`, [companyId])
  for (const t of ['vouchers', 'ledgers', 'groups'])
    assert.equal((await pool.query(`SELECT count(*)::int n FROM ${t} WHERE company_id = $1`, [companyId])).rows[0].n, 0, t)
})

test('a ledger that is still in use cannot be removed, even in raw SQL', async () => {
  const { companyId, ids, e } = await setup()
  await postVoucher(companyId, { type: 'Payment', date: '2026-04-11', entries: [e('Rent', 50), e('Cash', -50)] })
  await assert.rejects(withTx((tx) => tx.query(`DELETE FROM ledgers WHERE id = $1`, [ids.get('Rent')])), /foreign key/)
})
