import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { pool, withTx } from '../src/db'
import { migrate } from '../src/migrate'
import {
  alterLedger,
  alterVoucher,
  cancelVoucher,
  createCompany,
  createLedger,
  getLedger,
  getVoucher,
  loadGroups,
  pendingBills,
  postVoucher,
  postVouchers,
  setOpeningBills,
} from '../src/books'
import { ageingBucket, billsReport, overdueDays } from '../src/engine/bills'
import { validateBills } from '../src/engine/voucher'
import { handleXml } from '../src/xml/gateway'

const R = (rupees: number) => rupees * 100
before(() => migrate(() => {}))
after(() => pool.end())

async function setup() {
  const name = `Bills ${Date.now()}-${Math.random()}`
  const companyId = await createCompany({ name, booksBegin: '2026-04-01' })
  const groups = await loadGroups(pool, companyId)
  const g = (n: string) => [...groups.values()].find((x) => x.name === n)!.id
  const cash = (await pool.query(`SELECT id FROM ledgers WHERE company_id = $1 AND name = 'Cash'`, [companyId])).rows[0].id
  const ravi = await createLedger(companyId, { name: 'Ravi Stores', groupId: g('Sundry Debtors'), creditDays: 30 })
  const sales = await createLedger(companyId, { name: 'Sales', groupId: g('Sales Accounts') })
  const rent = await createLedger(companyId, { name: 'Rent', groupId: g('Indirect Expenses') })
  return { name, companyId, g, cash, ravi, sales, rent }
}
const pending = async (companyId: number, asOf = '2027-03-31') =>
  Object.fromEntries((await pendingBills(pool, companyId, asOf)).map((b) => [b.name, b]))

test('rules: bills only on bill-wise ledgers, named, and adding up to the entry', () => {
  const party = { id: 1, name: 'Ravi', groupId: 1, billwise: true }
  const plain = { id: 2, name: 'Rent', groupId: 2, billwise: false }
  assert.deepEqual(validateBills({ ledgerId: 1, amount: 500, bills: [{ type: 'New Ref', name: 'A', amount: 300 }, { type: 'On Account', amount: 200 }] }, party, 1), [])
  const has = (errs: string[], re: RegExp) => assert.ok(errs.some((e) => re.test(e)), errs.join(' | '))
  has(validateBills({ ledgerId: 2, amount: 500, bills: [{ type: 'New Ref', name: 'A', amount: 500 }] }, plain, 1), /doesn't keep bill-wise/)
  has(validateBills({ ledgerId: 1, amount: 500, bills: [{ type: 'New Ref', name: 'A', amount: 400 }] }, party, 1), /total 4, but the entry is 5/)
  has(validateBills({ ledgerId: 1, amount: 500, bills: [{ type: 'Agst Ref', amount: 500 }] }, party, 1), /needs a bill name/)
  has(validateBills({ ledgerId: 1, amount: 500, bills: [{ type: 'On Account', name: 'X', amount: 500 }] }, party, 1), /no bill name/)
  has(validateBills({ ledgerId: 1, amount: 500, bills: [{ type: 'New Ref', name: 'a', amount: 250 }, { type: 'New Ref', name: 'A', amount: 250 }] }, party, 1), /appears twice/)
  has(validateBills({ ledgerId: 1, amount: 500, bills: [{ type: 'Agst Ref', name: 'A', dueDate: '2026-05-01', amount: 500 }] }, party, 1), /due date goes only on a New Ref/)
})

test('ageing: overdue days and buckets from the due date', () => {
  assert.equal(overdueDays({ dueDate: '2026-05-01' }, '2026-04-20'), 0)
  assert.equal(overdueDays({ dueDate: '2026-05-01' }, '2026-06-15'), 45)
  assert.deepEqual([0, 1, 30, 31, 60, 61, 90, 91].map(ageingBucket), [
    'Not due', '1–30 days', '1–30 days', '31–60 days', '31–60 days', '61–90 days', '61–90 days', 'Over 90 days',
  ])
  const r = billsReport(
    [
      { ledgerId: 1, ledger: 'A', name: 'X', billDate: '2026-04-01', dueDate: '2026-05-01', pending: 1000 },
      { ledgerId: 1, ledger: 'A', name: 'Y', billDate: '2026-06-01', dueDate: '2026-07-01', pending: 500 },
      { ledgerId: 2, ledger: 'B', name: 'Z', billDate: '2026-04-05', dueDate: '2026-04-05', pending: -700 },
    ],
    'receivable',
    '2026-06-15',
  )
  assert.deepEqual(r.bills.map((b) => [b.name, b.overdueDays, b.bucket]), [['X', 45, '31–60 days'], ['Y', 0, 'Not due']])
  assert.equal(r.total, 1500)
  assert.equal(r.overdue, 1000)
  assert.equal(billsReport(r.bills.length ? [{ ledgerId: 2, ledger: 'B', name: 'Z', billDate: '2026-04-05', dueDate: '2026-04-05', pending: -700 }] : [], 'payable', '2026-06-15').total, 700)
})

test('party ledgers keep bills by default; others do not', async () => {
  const { companyId, ravi, rent } = await setup()
  assert.equal((await getLedger(pool, companyId, ravi)).billwise, true)
  assert.equal((await getLedger(pool, companyId, ravi)).creditDays, 30)
  assert.equal((await getLedger(pool, companyId, rent)).billwise, false)
})

test('a bill is raised, part-settled, and the rest is pending with its due date', async () => {
  const { companyId, cash, ravi, sales } = await setup()
  // INV-1 takes the ledger's 30-day credit period; INV-2 has its own due date
  await postVoucher(companyId, { type: 'Sales', date: '2026-04-10', entries: [
    { ledgerId: ravi, amount: R(10000), bills: [{ type: 'New Ref', name: 'INV-1', amount: R(10000) }] },
    { ledgerId: sales, amount: -R(10000) } ] })
  await postVoucher(companyId, { type: 'Sales', date: '2026-04-20', entries: [
    { ledgerId: ravi, amount: R(4000), bills: [{ type: 'New Ref', name: 'INV-2', dueDate: '2026-04-30', amount: R(4000) }] },
    { ledgerId: sales, amount: -R(4000) } ] })
  // receipt: 6,000 against INV-1 and 500 on account
  await postVoucher(companyId, { type: 'Receipt', date: '2026-05-05', entries: [
    { ledgerId: cash, amount: R(6500) },
    { ledgerId: ravi, amount: -R(6500), bills: [{ type: 'Agst Ref', name: 'INV-1', amount: -R(6000) }, { type: 'On Account', amount: -R(500) }] } ] })

  const p = await pending(companyId)
  assert.equal(p['INV-1'].pending, R(4000))
  assert.equal(p['INV-1'].billDate, '2026-04-10')
  assert.equal(p['INV-1'].dueDate, '2026-05-10') // 10 April + 30 days
  assert.equal(p['INV-2'].dueDate, '2026-04-30')
  // as of 15 May, INV-2 is 15 days overdue and INV-1 5 days
  const r = billsReport(await pendingBills(pool, companyId, '2026-05-15'), 'receivable', '2026-05-15')
  assert.deepEqual(r.bills.map((b) => [b.name, b.overdueDays]), [['INV-1', 5], ['INV-2', 15]])
  assert.equal(r.total, R(8000))
  // before the receipt, INV-1 was fully pending
  assert.equal((await pending(companyId, '2026-05-01'))['INV-1'].pending, R(10000))
})

test('references are checked: no settling unknown bills, no reusing a bill name', async () => {
  const { companyId, cash, ravi, sales } = await setup()
  await postVoucher(companyId, { type: 'Sales', date: '2026-04-10', entries: [
    { ledgerId: ravi, amount: R(100), bills: [{ type: 'New Ref', name: 'INV-9', amount: R(100) }] }, { ledgerId: sales, amount: -R(100) } ] })
  await assert.rejects(postVoucher(companyId, { type: 'Receipt', date: '2026-04-11', entries: [
    { ledgerId: cash, amount: R(50) }, { ledgerId: ravi, amount: -R(50), bills: [{ type: 'Agst Ref', name: 'INV-404', amount: -R(50) }] } ] }), /no bill "INV-404"/)
  await assert.rejects(postVoucher(companyId, { type: 'Sales', date: '2026-04-12', entries: [
    { ledgerId: ravi, amount: R(100), bills: [{ type: 'New Ref', name: 'inv-9', amount: R(100) }] }, { ledgerId: sales, amount: -R(100) } ] }), /already exists/)
  // and inside one batch: a bill raised earlier in the batch can be settled later in it
  const res = await postVouchers(companyId, [
    { type: 'Sales', date: '2026-04-13', entries: [{ ledgerId: ravi, amount: R(70), bills: [{ type: 'New Ref', name: 'B-1', amount: R(70) }] }, { ledgerId: sales, amount: -R(70) }] },
    { type: 'Receipt', date: '2026-04-14', entries: [{ ledgerId: cash, amount: R(70) }, { ledgerId: ravi, amount: -R(70), bills: [{ type: 'Agst Ref', name: 'B-1', amount: -R(70) }] }] },
    { type: 'Sales', date: '2026-04-15', entries: [{ ledgerId: ravi, amount: R(5), bills: [{ type: 'New Ref', name: 'B-1', amount: R(5) }] }, { ledgerId: sales, amount: -R(5) }] },
  ])
  assert.deepEqual(res.map((r) => r.ok), [true, true, false])
  assert.equal((await pending(companyId))['B-1'], undefined) // fully settled
})

test("alter and cancel: a voucher's own bills are replaced or removed with it", async () => {
  const { companyId, ravi, sales } = await setup()
  const v = await postVoucher(companyId, { type: 'Sales', date: '2026-04-10', entries: [
    { ledgerId: ravi, amount: R(100), bills: [{ type: 'New Ref', name: 'INV-A', amount: R(100) }] }, { ledgerId: sales, amount: -R(100) } ] })
  // re-saving with the same New Ref name is allowed (its own bill is replaced)
  await alterVoucher(companyId, v.id, { type: 'Sales', date: '2026-04-10', entries: [
    { ledgerId: ravi, amount: R(150), bills: [{ type: 'New Ref', name: 'INV-A', amount: R(150) }] }, { ledgerId: sales, amount: -R(150) } ] })
  assert.equal((await pending(companyId))['INV-A'].pending, R(150))
  const saved = await getVoucher(pool, companyId, v.id)
  assert.deepEqual(saved.entries[0].bills, [{ type: 'New Ref', name: 'INV-A', dueDate: null, amount: R(150) }])
  await cancelVoucher(companyId, v.id)
  assert.equal((await pending(companyId))['INV-A'], undefined)
})

test('opening bills make up the opening balance; the rest is on account', async () => {
  const { companyId, cash, ravi, g } = await setup()
  await alterLedger(companyId, ravi, { name: 'Ravi Stores', groupId: g('Sundry Debtors'), opening: R(5000), creditDays: 30 })
  await setOpeningBills(companyId, ravi, [{ name: 'OB-1', billDate: '2026-03-01', amount: R(3000) }])
  const p = await pending(companyId)
  assert.equal(p['OB-1'].pending, R(3000))
  assert.equal(p['OB-1'].dueDate, '2026-03-31')
  await postVoucher(companyId, { type: 'Receipt', date: '2026-04-02', entries: [
    { ledgerId: cash, amount: R(3000) }, { ledgerId: ravi, amount: -R(3000), bills: [{ type: 'Agst Ref', name: 'OB-1', amount: -R(3000) }] } ] })
  assert.equal((await pending(companyId))['OB-1'], undefined)
  // a ledger with bills can't stop keeping them
  await assert.rejects(alterLedger(companyId, ravi, { name: 'Ravi Stores', groupId: g('Sundry Debtors'), opening: R(5000), billwise: false }), /must keep maintaining bills/)
})

test('the database refuses allocations that do not add up, even bypassing the API', async () => {
  const { companyId, ravi, sales } = await setup()
  const v = await postVoucher(companyId, { type: 'Sales', date: '2026-04-10', entries: [{ ledgerId: ravi, amount: R(100) }, { ledgerId: sales, amount: -R(100) }] })
  const entry = (await pool.query(`SELECT id FROM entries WHERE voucher_id = $1 AND ledger_id = $2`, [v.id, ravi])).rows[0].id
  await assert.rejects(
    withTx((tx) => tx.query(`INSERT INTO bill_allocations (entry_id, ledger_id, ref_type, name, amount) VALUES ($1,$2,'New Ref','X',$3)`, [entry, ravi, R(60)])),
    /add up to/,
  )
})

test('Tally XML: BILLALLOCATIONS.LIST on a ledger line imports as bill-wise details', async () => {
  const { name, companyId } = await setup()
  const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>
    <REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${name}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>
    <REQUESTDATA><TALLYMESSAGE><VOUCHER VCHTYPE="Sales" ACTION="Create"><DATE>20260415</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Ravi Stores</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-2500.00</AMOUNT>
        <BILLALLOCATIONS.LIST><NAME>TX-77</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>-2500.00</AMOUNT></BILLALLOCATIONS.LIST>
      </ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>2500.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`
  const res = await handleXml(xml)
  assert.match(res, /<CREATED>1<\/CREATED>/, res)
  assert.equal((await pending(companyId))['TX-77'].pending, R(2500))
})

test('an invoice that was partly settled by another voucher can still be altered', async () => {
  const { companyId, cash, ravi, sales } = await setup()
  const inv = await postVoucher(companyId, { type: 'Sales', date: '2026-04-10', entries: [
    { ledgerId: ravi, amount: R(500), bills: [{ type: 'New Ref', name: 'S-2', amount: R(500) }] }, { ledgerId: sales, amount: -R(500) } ] })
  await postVoucher(companyId, { type: 'Receipt', date: '2026-04-12', entries: [
    { ledgerId: cash, amount: R(200) }, { ledgerId: ravi, amount: -R(200), bills: [{ type: 'Agst Ref', name: 'S-2', amount: -R(200) }] } ] })
  await alterVoucher(companyId, inv.id, { type: 'Sales', date: '2026-04-10', narration: 'corrected', entries: [
    { ledgerId: ravi, amount: R(600), bills: [{ type: 'New Ref', name: 'S-2', amount: R(600) }] }, { ledgerId: sales, amount: -R(600) } ] })
  assert.equal((await pending(companyId))['S-2'].pending, R(400))
})
