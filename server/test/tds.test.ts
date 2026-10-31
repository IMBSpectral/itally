import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'
import { backupCompany, restoreCompany } from '../src/backup'
import { dueThroughYear, rateFor, STANDARD_NATURES, taxAt, type TdsNature } from '../src/engine/tds'

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

test('the engine: thresholds, the first crossing of the annual limit, 194Q on the excess, no PAN', () => {
  const c194: TdsNature = { id: 1, ...STANDARD_NATURES[0] }
  const line = (amount: number, i: number) => ({ voucherId: i, date: '2026-04-01', partyId: 1, natureId: 1, amount: R(amount), deducted: 0 })
  const due = dueThroughYear(c194, 'Individual/HUF', true, [20000, 25000, 60000, 10000, 5000].map(line))
  assert.deepEqual(due.map((d) => [d.assessable / 100, d.due / 100]), [[0, 0], [0, 0], [105000, 1050], [10000, 100], [5000, 50]])
  // a single payment above ₹30,000 is taxed even below the annual limit
  assert.deepEqual(dueThroughYear(c194, 'Company', true, [line(35000, 1)]).map((d) => d.due / 100), [700])
  const q: TdsNature = { id: 2, ...STANDARD_NATURES.find((n) => n.section === '194Q')! }
  assert.deepEqual(dueThroughYear(q, 'Company', true, [line(4000000, 1), line(2000000, 2), line(500000, 3)]).map((d) => d.assessable / 100), [0, 1000000, 500000])
  assert.equal(rateFor(c194, 'Company', false), 2000)
  assert.equal(rateFor(q, 'Company', false), 500)
  assert.equal(taxAt(R(12345), 100), R(123)) // to the rupee
})

test('TDS in the books: computation, short deduction, outstandings, Form 26Q matched to challans, the suggestion, backup', async () => {
  const c = await call('POST', '/companies', { name: `TDS Co ${Date.now()}`, booksBegin: '2026-04-01' })
  const at = `/companies/${c.id}`
  assert.equal((await call('GET', `${at}/features`)).features.tds, false)
  await call('PUT', `${at}/features`, { tds: true })
  assert.equal((await raw('PUT', `${at}/tds`, { tan: 'MUM12345B' })).status, 422)
  await call('PUT', `${at}/tds`, { tan: 'mumr12345b', responsible: 'R. Shah' })
  assert.equal((await call('GET', `${at}/tds`)).tan, 'MUMR12345B')
  const natures: { id: number; name: string; section: string }[] = await call('GET', `${at}/tds-natures`)
  assert.equal(natures.length, STANDARD_NATURES.length)
  const contract = natures.find((n) => n.section === '194C')!.id
  const prof = natures.find((n) => n.name === 'Fees for Professional Services')!.id
  const groups: { id: number; name: string }[] = await call('GET', `${at}/groups`)
  const g = (n: string) => groups.find((x) => x.name === n)!.id
  const L = async (name: string, group: string, extra: object = {}) => (await call('POST', `${at}/ledgers`, { name, groupId: g(group), billwise: false, ...extra })).id as number
  const contracts = await L('Contract Charges', 'Indirect Expenses', { tdsNatureId: contract })
  const tdsC = await L('TDS on Contracts', 'Duties & Taxes', { tdsNatureId: contract })
  const fees = await L('Legal Fees', 'Indirect Expenses', { tdsNatureId: prof })
  const tdsP = await L('TDS on Professional Fees', 'Duties & Taxes', { tdsNatureId: prof })
  const ram = await L('Ram Contractor', 'Sundry Creditors', { deducteeType: 'Individual/HUF', pan: 'ABCPR1234K' })
  const builder = await L('Builder Co', 'Sundry Creditors', { deducteeType: 'Company' })
  const lawyer = await L('Lawyer', 'Sundry Creditors', { deducteeType: 'Individual/HUF', pan: 'ABCPL1234K' })
  const bank = await L('HDFC', 'Bank Accounts')
  // a deductee type belongs on a party
  assert.equal((await raw('POST', `${at}/ledgers`, { name: 'Odd', groupId: g('Indirect Expenses'), deducteeType: 'Company' })).status, 422)

  const J = (date: string, party: number, expense: number, amount: number, tax = 0, tdsLedger = tdsC) =>
    call('POST', `${at}/vouchers`, { type: 'Journal', date, entries: [
      { ledgerId: expense, amount: R(amount) }, { ledgerId: party, amount: -R(amount - tax) }, ...(tax ? [{ ledgerId: tdsLedger, amount: -R(tax) }] : [])] })
  await J('2026-04-10', ram, contracts, 20000)
  await J('2026-05-05', ram, contracts, 25000)
  // what the voucher being entered should deduct: the year crosses ₹1 lakh, so all ₹1,05,000 is taxed
  const s = await call('POST', `${at}/tds/suggest`, { date: '2026-06-01', entries: [{ ledgerId: contracts, amount: R(60000) }, { ledgerId: ram, amount: -R(60000) }] })
  assert.deepEqual(s.map((x: { section: string; assessable: number; due: number; ledgerId: number }) => [x.section, x.assessable, x.due, x.ledgerId]), [['194C', R(105000), R(1050), tdsC]])
  await J('2026-06-01', ram, contracts, 60000, 1050)
  await J('2026-07-01', ram, contracts, 10000) // after the crossing: ₹100 due, nothing deducted
  // a company without a PAN: 20%; only 800 deducted
  await J('2026-06-02', builder, contracts, 40000, 800)
  await J('2026-05-20', lawyer, fees, 30000)
  await J('2026-06-10', lawyer, fees, 30000, 6000, tdsP)
  // TDS paid in July: one payment with its challan, one without
  const paid = await call('POST', `${at}/vouchers`, { type: 'Payment', date: '2026-07-07', entries: [{ ledgerId: tdsC, amount: R(1850) }, { ledgerId: bank, amount: -R(1850) }] })
  assert.equal((await raw('PUT', `${at}/vouchers/${paid.id}/tds-challan`, { bsrCode: '05103', challanNo: '00123', challanDate: '2026-07-07' })).status, 422)
  await call('PUT', `${at}/vouchers/${paid.id}/tds-challan`, { bsrCode: '0510308', challanNo: '00123', challanDate: '2026-07-07' })
  await call('POST', `${at}/vouchers`, { type: 'Payment', date: '2026-07-07', entries: [{ ledgerId: tdsP, amount: R(6000) }, { ledgerId: bank, amount: -R(6000) }] })

  const q1 = '?from=2026-04-01&to=2026-06-30'
  const comp = (await call('GET', `${at}/reports/tds-computation${q1}`)).lines
  const row = (party: string, date: string) => comp.find((l: { party: string; date: string }) => l.party === party && l.date === date)
  assert.deepEqual([row('Ram Contractor', '2026-06-01').due, row('Ram Contractor', '2026-06-01').problems], [R(1050), []])
  assert.equal(row('Ram Contractor', '2026-04-10').due, 0)
  assert.deepEqual([row('Builder Co', '2026-06-02').rate, row('Builder Co', '2026-06-02').due, row('Builder Co', '2026-06-02').short], [2000, R(8000), R(7200)])
  assert.deepEqual(row('Builder Co', '2026-06-02').problems, ['No PAN: the higher rate of section 206AA applies', 'TDS short by 7200.00'])
  assert.equal(row('Lawyer', '2026-06-10').due, R(6000))
  const july = (await call('GET', `${at}/reports/tds-computation?from=2026-07-01&to=2026-07-31`)).lines
  assert.deepEqual(july.map((l: { due: number; problems: string[] }) => [l.due, l.problems]), [[R(100), ['TDS short by 100.00']]])

  const out = await call('GET', `${at}/reports/tds-outstandings${q1}`)
  assert.deepEqual(out.natures.map((n: { section: string; due: number; deducted: number; paid: number; payable: number }) => [n.section, n.due, n.deducted, n.paid, n.payable]),
    [['194C', R(9050), R(1850), 0, R(1850)], ['194J', R(6000), R(6000), 0, R(6000)]])
  const outJuly = await call('GET', `${at}/reports/tds-outstandings?from=2026-07-01&to=2026-07-31`)
  assert.deepEqual(outJuly.natures.map((n: { section: string; paid: number; payable: number }) => [n.section, n.paid, n.payable]), [['194C', R(1850), 0], ['194J', R(6000), 0]])
  assert.equal(outJuly.unpaidChallans, 1)

  const f = await call('GET', `${at}/reports/form-26q?fy=2026-04-01&quarter=1`)
  assert.equal(f.deductor.tan, 'MUMR12345B')
  assert.deepEqual(f.deductions.map((d: { deducteeCode: string; pan: string; section: string; amount: number; tds: number; challan: { serial: number; bsrCode: string | null } | null }) =>
    [d.deducteeCode, d.pan, d.section, d.amount, d.tds, d.challan?.serial, d.challan?.bsrCode]), [
    ['02', 'ABCPR1234K', '194C', R(60000), R(1050), 1, '0510308'],
    ['01', 'PANNOTAVBL', '194C', R(40000), R(800), 1, '0510308'],
    ['02', 'ABCPL1234K', '194J', R(30000), R(6000), 2, null],
  ])
  assert.deepEqual(f.total, { amount: R(130000), tds: R(7850) })
  assert.deepEqual(f.problems, ['Payment 2 of 6000.00 has no challan details', 'Builder Co: no PAN'])
  const csv = await raw('GET', `${at}/reports/form-26q?fy=2026-04-01&quarter=1&format=csv`)
  assert.match(csv.body, /^Deductee code,PAN of deductee/)
  assert.match(csv.body, /02,ABCPR1234K,Ram Contractor,194C,01\/06\/2026,60000\.00,1050\.00,1\.00,01\/06\/2026,1,0510308,00123,07\/07\/2026/)

  // a backup carries the TAN, natures, ledgers' TDS settings and challans
  const restored = (await restoreCompany((await backupCompany(c.id)).file)).id
  const f2 = await call('GET', `/companies/${restored}/reports/form-26q?fy=2026-04-01&quarter=1`)
  const plain = (ds: { voucherId: number }[]) => ds.map(({ voucherId: _, ...d }) => d)
  assert.deepEqual(plain(f2.deductions), plain(f.deductions))
  assert.equal(f2.deductor.tan, 'MUMR12345B')
})
