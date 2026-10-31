import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'
import { alterVoucher, bankEntries, createCompany, createLedger, loadGroups, postVoucher, setBankDates } from '../src/books'
import { matchStatement, reconcile } from '../src/engine/bank'

const R = (rupees: number) => rupees * 100
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

test('statement matching: same amount and direction, closest date within the window, each used once', () => {
  const open = [
    { entryId: 1, date: '2026-04-01', amount: 500 },
    { entryId: 2, date: '2026-04-03', amount: 500 },
    { entryId: 3, date: '2026-04-05', amount: -200 },
  ]
  const r = matchStatement(open, [
    { date: '2026-04-04', amount: 500 }, // closest is entry 2
    { date: '2026-04-06', amount: 500 }, // then entry 1
    { date: '2026-04-06', amount: 200 }, // wrong direction for entry 3
    { date: '2026-04-30', amount: -200 }, // too late for entry 3
  ])
  assert.deepEqual(r.matches, [
    { entryId: 2, bankDate: '2026-04-04', line: 0 },
    { entryId: 1, bankDate: '2026-04-06', line: 1 },
  ])
  assert.deepEqual(r.unmatched, [2, 3])
  // the bank can't clear something before it was written
  assert.deepEqual(matchStatement([{ entryId: 9, date: '2026-04-10', amount: 100 }], [{ date: '2026-04-09', amount: 100 }]).matches, [])
})

test('reconciliation statement: book balance adjusted for what the bank has not reflected', () => {
  assert.deepEqual(reconcile(10000, [{ amount: 3000 }, { amount: -1200 }, { amount: -800 }]), {
    bookBalance: 10000, notCredited: 3000, notDebited: 2000, bankBalance: 9000,
  })
})

async function setup() {
  const companyId = await createCompany({ name: `Bank ${Date.now()}-${Math.random()}`, booksBegin: '2026-04-01' })
  const groups = await loadGroups(pool, companyId)
  const g = (n: string) => [...groups.values()].find((x) => x.name === n)!.id
  const bank = await createLedger(companyId, { name: 'ICICI', groupId: g('Bank Accounts'), opening: R(10000) })
  const capital = await createLedger(companyId, { name: 'Capital', groupId: g('Capital Account'), opening: -R(10000) })
  const rent = await createLedger(companyId, { name: 'Rent', groupId: g('Indirect Expenses') })
  const sales = await createLedger(companyId, { name: 'Sales', groupId: g('Sales Accounts') })
  void capital
  return { companyId, bank, rent, sales }
}

test('bank dates: only on bank ledgers, never before the voucher, kept through an alteration', async () => {
  const { companyId, bank, rent } = await setup()
  const v = await postVoucher(companyId, { type: 'Payment', date: '2026-04-10', entries: [{ ledgerId: rent, amount: R(700) }, { ledgerId: bank, amount: -R(700) }] })
  const [entry] = await bankEntries(pool, companyId, bank, '2026-04-01', '2027-03-31')
  const rentEntry = (await pool.query(`SELECT id FROM entries WHERE voucher_id = $1 AND ledger_id = $2`, [v.id, rent])).rows[0].id
  await assert.rejects(setBankDates(companyId, [{ entryId: rentEntry, bankDate: '2026-04-12' }]), /not a bank ledger/)
  await assert.rejects(setBankDates(companyId, [{ entryId: entry.entryId, bankDate: '2026-04-09' }]), /before the voucher date/)
  await setBankDates(companyId, [{ entryId: entry.entryId, bankDate: '2026-04-12' }])
  // narration-only alteration: the bank date stays
  await alterVoucher(companyId, v.id, { type: 'Payment', date: '2026-04-10', narration: 'April rent', entries: [{ ledgerId: rent, amount: R(700) }, { ledgerId: bank, amount: -R(700) }] })
  const all = await bankEntries(pool, companyId, bank, '2026-04-01', '2027-03-31', true)
  assert.equal(all[0].bankDate, '2026-04-12')
  assert.equal((await bankEntries(pool, companyId, bank, '2026-04-01', '2027-03-31')).length, 0)
  // as on 11 April the cheque was not yet cleared
  assert.equal((await bankEntries(pool, companyId, bank, '2026-04-01', '2026-04-11')).length, 1)
})

test('API: reconciliation statement and bank statement import', async () => {
  const { companyId, bank, rent, sales } = await setup()
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/companies/${companyId}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, body: res.status === 204 ? null : await res.json() }
  }
  await postVoucher(companyId, { type: 'Receipt', date: '2026-04-05', entries: [{ ledgerId: bank, amount: R(3000) }, { ledgerId: sales, amount: -R(3000) }] })
  await postVoucher(companyId, { type: 'Payment', date: '2026-04-06', entries: [{ ledgerId: rent, amount: R(1200) }, { ledgerId: bank, amount: -R(1200) }] })
  await postVoucher(companyId, { type: 'Payment', date: '2026-04-20', entries: [{ ledgerId: rent, amount: R(800) }, { ledgerId: bank, amount: -R(800) }] })

  const before = (await call('GET', `/ledgers/${bank}/reconciliation?to=2026-04-30`)).body
  assert.equal(before.bookBalance, R(11000))
  assert.equal(before.notCredited, R(3000))
  assert.equal(before.notDebited, R(2000))
  assert.equal(before.bankBalance, R(10000))

  // the bank's statement shows the deposit on the 7th and the first cheque on the 9th
  const imp = (await call('POST', `/ledgers/${bank}/statement?to=2026-04-30`, [
    { date: '2026-04-07', amount: R(3000), description: 'CLG DEP' },
    { date: '2026-04-09', amount: -R(1200), description: 'CHQ 000123' },
    { date: '2026-04-09', amount: -R(55), description: 'SMS CHARGES' },
  ])).body
  assert.equal(imp.matched, 2)
  assert.deepEqual(imp.unmatched.map((u: { description: string }) => u.description), ['SMS CHARGES'])

  const after = (await call('GET', `/ledgers/${bank}/reconciliation?to=2026-04-30`)).body
  assert.equal(after.entries.length, 1)
  assert.equal(after.notCredited, 0)
  assert.equal(after.notDebited, R(800))
  assert.equal(after.bankBalance, R(11800))

  // clearing one by hand, and undoing it
  const id = after.entries[0].entryId
  assert.equal((await call('PUT', '/reconciliation', [{ entryId: id, bankDate: '2026-04-25' }])).status, 204)
  assert.equal((await call('GET', `/ledgers/${bank}/reconciliation?to=2026-04-30`)).body.entries.length, 0)
  assert.equal((await call('PUT', '/reconciliation', [{ entryId: id, bankDate: null }])).status, 204)
  assert.equal((await call('GET', `/ledgers/${bank}/reconciliation?to=2026-04-30`)).body.entries.length, 1)
  assert.equal((await call('PUT', '/reconciliation', [{ entryId: id, bankDate: '2026-04-01' }])).status, 422)
})

test('bank CSV: finds the header, reads Indian dates and amounts, skips the rest', async () => {
  const { parseStatementCsv, statementDate } = await import('../src/engine/bankcsv')
  assert.equal(statementDate('05/04/2026'), '2026-04-05')
  assert.equal(statementDate('05-04-26'), '2026-04-05')
  assert.equal(statementDate('5-Apr-2026'), '2026-04-05')
  assert.equal(statementDate('05 Apr 26'), '2026-04-05')
  assert.equal(statementDate('31/02/2026'), null)
  const csv = [
    'ICICI Bank Statement,,,,',
    'Account: XXXX1234,,,,',
    'Txn Date,Narration,Withdrawal Amount (INR),Deposit Amount (INR),Balance',
    '07/04/2026,CLG DEP 4411,,"3,000.00","13,000.00"',
    '09/04/2026,"CHQ 000123, RENT",1200.00,,"11,800.00"',
    '09/04/2026,SMS CHARGES,55,,"11,745.00"',
    'Closing balance,,,,"11,745.00"',
  ].join('\n')
  const r = parseStatementCsv(csv)
  assert.deepEqual(r.lines, [
    { date: '2026-04-07', amount: 300000, description: 'CLG DEP 4411' },
    { date: '2026-04-09', amount: -120000, description: 'CHQ 000123, RENT' },
    { date: '2026-04-09', amount: -5500, description: 'SMS CHARGES' },
  ])
  assert.equal(r.skipped, 1)
  // single signed amount column
  assert.deepEqual(parseStatementCsv('Date,Description,Amount\n2026-04-07,Dep,1500\n2026-04-08,Fee,-20').lines.map((l) => l.amount), [150000, -2000])
  assert.throws(() => parseStatementCsv('a,b\n1,2'), /No header row/)
})
