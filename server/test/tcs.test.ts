import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'
import { backupCompany, restoreCompany } from '../src/backup'
import { dueThroughYear, STANDARD_NATURES, type TdsNature } from '../src/engine/tds'
import { allowedDays } from '../src/msme'

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

test('the engine: TCS natures, the motor vehicle limit, 206CC without PAN, MSME days allowed', () => {
  const car: TdsNature = { id: 1, ...STANDARD_NATURES.find((n) => n.section === '206C(1F)')! }
  const line = (amount: number, i: number) => ({ voucherId: i, date: '2026-04-01', partyId: 1, natureId: 1, amount: R(amount), deducted: 0 })
  assert.deepEqual(dueThroughYear(car, 'Individual/HUF', true, [line(900000, 1), line(1200000, 2)]).map((d) => d.due / 100), [0, 12000])
  const scrap: TdsNature = { id: 2, ...STANDARD_NATURES.find((n) => n.collectionCode === 'E')! }
  assert.equal(dueThroughYear(scrap, 'Company', false, [line(10000, 1)])[0].rate, 500) // 5% without PAN
  assert.equal(allowedDays(null), 15)
  assert.equal(allowedDays(30), 30)
  assert.equal(allowedDays(90), 45)
})

test('TCS on sales, Forms 27EQ and 27Q, challan reconciliation, MSME Form 1, backup', async () => {
  const c = await call('POST', '/companies', { name: `TCS Co ${Date.now()}`, booksBegin: '2026-04-01' })
  const at = `/companies/${c.id}`
  assert.equal((await call('GET', `${at}/features`)).features.tcs, false)
  await call('PUT', `${at}/features`, { tds: true, tcs: true })
  await call('PUT', `${at}/tds`, { tan: 'MUMR12345B', responsible: 'R. Shah' })
  const natures: { id: number; name: string; kind: string; section: string; collectionCode: string | null }[] = await call('GET', `${at}/tds-natures`)
  assert.equal(natures.filter((n) => n.kind === 'TCS').length, STANDARD_NATURES.filter((n) => n.kind === 'TCS').length)
  const scrap = natures.find((n) => n.collectionCode === 'E')!.id
  const nonRes = natures.find((n) => n.section === '195')!.id
  const contract = natures.find((n) => n.section === '194C')!.id
  // a TCS section is 206C; a nature of goods can't change kind once it is on a ledger
  assert.equal((await raw('POST', `${at}/tds-natures`, { name: 'Odd', kind: 'TCS', section: '194C', rateIndividual: 100, rateOther: 100, rateNoPan: 500, thresholdSingle: null, thresholdAnnual: null })).status, 422)

  const groups: { id: number; name: string }[] = await call('GET', `${at}/groups`)
  const g = (n: string) => groups.find((x) => x.name === n)!.id
  const L = async (name: string, group: string, extra: object = {}) => (await call('POST', `${at}/ledgers`, { name, groupId: g(group), billwise: false, ...extra })).id as number
  const sales = await L('Scrap Sales', 'Sales Accounts', { tdsNatureId: scrap })
  const tcsL = await L('TCS on Scrap', 'Duties & Taxes', { tdsNatureId: scrap })
  const igst = await L('Output IGST', 'Duties & Taxes')
  const buyer = await L('Metal Buyers Ltd', 'Sundry Debtors', { deducteeType: 'Company', pan: 'AAACM1234K' })
  const bank = await L('HDFC', 'Bank Accounts')
  // natures go on ledgers of the right kind
  assert.equal((await raw('POST', `${at}/ledgers`, { name: 'Wrong 1', groupId: g('Sales Accounts'), tdsNatureId: contract })).status, 422)
  assert.equal((await raw('POST', `${at}/ledgers`, { name: 'Wrong 2', groupId: g('Indirect Expenses'), tdsNatureId: scrap })).status, 422)
  assert.equal((await raw('PUT', `${at}/tds-natures/${scrap}`, { ...natures.find((n) => n.id === scrap), kind: 'TDS', section: '194C', rateIndividual: 100, rateOther: 100, rateNoPan: 500,
    thresholdSingle: null, thresholdAnnual: null })).status, 422)

  // TCS is due on what the buyer is charged, GST included: 1% of 1,18,000
  const s = await call('POST', `${at}/tds/suggest`, { date: '2026-05-10', entries: [{ ledgerId: buyer, amount: R(118000) }, { ledgerId: sales, amount: -R(100000) }, { ledgerId: igst, amount: -R(18000) }] })
  assert.equal(s.length, 1)
  assert.equal(s[0].kind, 'TCS')
  assert.equal(s[0].assessable, R(118000))
  assert.equal(s[0].due, R(1180))
  assert.equal(s[0].ledgerId, tcsL)
  // with the TCS on the voucher the consideration stays the same
  const s2 = await call('POST', `${at}/tds/suggest`, { date: '2026-05-10', entries: [{ ledgerId: buyer, amount: R(119180) }, { ledgerId: sales, amount: -R(100000) }, { ledgerId: igst, amount: -R(18000) }, { ledgerId: tcsL, amount: -R(1180) }] })
  assert.equal(s2[0].due, R(1180))
  await call('POST', `${at}/vouchers`, { type: 'Sales', date: '2026-05-10', entries: [
    { ledgerId: buyer, amount: R(119180) }, { ledgerId: sales, amount: -R(100000) }, { ledgerId: igst, amount: -R(18000) }, { ledgerId: tcsL, amount: -R(1180) }] })
  // a second sale without the TCS: short
  await call('POST', `${at}/vouchers`, { type: 'Sales', date: '2026-06-02', entries: [{ ledgerId: buyer, amount: R(50000) }, { ledgerId: sales, amount: -R(50000) }] })
  const comp = await call('GET', `${at}/reports/tds-computation?kind=TCS&from=2026-04-01&to=2027-03-31`)
  assert.deepEqual(comp.lines.map((l: { amount: number; due: number; deducted: number }) => [l.amount, l.due, l.deducted]), [[R(118000), R(1180), R(1180)], [R(50000), R(500), 0]])
  assert.match(comp.lines[1].problems[0], /TCS short by 500/)
  assert.equal((await call('GET', `${at}/reports/tds-computation?from=2026-04-01&to=2027-03-31`)).lines.length, 0) // not TDS

  // paid to the government on 7 June
  const pay = (await call('POST', `${at}/vouchers`, { type: 'Payment', date: '2026-06-07', entries: [{ ledgerId: tcsL, amount: R(1180) }, { ledgerId: bank, amount: -R(1180) }] })).id
  let out = await call('GET', `${at}/reports/tds-outstandings?kind=TCS&from=2026-04-01&to=2027-03-31`)
  assert.deepEqual(out.natures.map((n: { deducted: number; paid: number; payable: number }) => [n.deducted, n.paid, n.payable]), [[R(1180), R(1180), 0]])
  assert.equal(out.unpaidChallans, 1)

  // TDS on a non-resident (Form 27Q, not 26Q)
  const fees = await L('Foreign Consultancy', 'Indirect Expenses', { tdsNatureId: nonRes })
  const tds195 = await L('TDS u/s 195', 'Duties & Taxes', { tdsNatureId: nonRes })
  const consultant = await L('US Consultant Inc', 'Sundry Creditors', { deducteeType: 'Company', country: 'USA' })
  await call('POST', `${at}/vouchers`, { type: 'Journal', date: '2026-05-20', entries: [{ ledgerId: fees, amount: R(100000) }, { ledgerId: consultant, amount: -R(80000) }, { ledgerId: tds195, amount: -R(20000) }] })
  const pay195 = (await call('POST', `${at}/vouchers`, { type: 'Payment', date: '2026-06-05', entries: [{ ledgerId: tds195, amount: R(20000) }, { ledgerId: bank, amount: -R(20000) }] })).id

  // challans for both payments at once; a bad one saves neither
  assert.equal((await raw('PUT', `${at}/tds-challans`, [{ voucherId: pay, challan: { bsrCode: '0510002', challanNo: '00042', challanDate: '2026-06-07' } },
    { voucherId: pay195, challan: { bsrCode: '12', challanNo: '00043', challanDate: '2026-06-05' } }])).status, 422)
  await call('PUT', `${at}/tds-challans`, [{ voucherId: pay, challan: { bsrCode: '0510002', challanNo: '00042', challanDate: '2026-06-07' } },
    { voucherId: pay195, challan: { bsrCode: '0510002', challanNo: '00043', challanDate: '2026-06-05' } }])
  out = await call('GET', `${at}/reports/tds-outstandings?kind=TCS&from=2026-04-01&to=2027-03-31`)
  assert.equal(out.unpaidChallans, 0)

  const eq = await call('GET', `${at}/reports/form-27eq?fy=2026-04-01&quarter=1`)
  assert.equal(eq.form, '27EQ')
  assert.deepEqual(eq.deductions.map((d: { collectionCode: string; amount: number; tds: number; challan: { challanNo: string } | null }) => [d.collectionCode, d.amount, d.tds, d.challan?.challanNo]),
    [['E', R(118000), R(1180), '00042']])
  assert.deepEqual(eq.problems, [])
  const csv = await raw('GET', `${at}/reports/form-27eq?fy=2026-04-01&quarter=1&format=csv`)
  assert.match(csv.body as string, /^Collectee code,PAN of collectee/)
  assert.match(csv.body as string, /01,AAACM1234K,Metal Buyers Ltd,E,10\/05\/2026,118000\.00,1180\.00,1\.00/)
  const q27 = await call('GET', `${at}/reports/form-27q?fy=2026-04-01&quarter=1`)
  assert.deepEqual(q27.deductions.map((d: { name: string; country: string; tds: number }) => [d.name, d.country, d.tds]), [['US Consultant Inc', 'USA', R(20000)]])
  assert.ok(q27.problems.some((p: string) => /no PAN/.test(p)))
  assert.equal((await call('GET', `${at}/reports/form-26q?fy=2026-04-01&quarter=1`)).deductions.length, 0)

  const reco = await call('GET', `${at}/reports/challan-reconciliation?from=2026-04-01&to=2027-03-31`)
  assert.deepEqual(reco.payments.map((p: { kind: string; amount: number; allocated: number; unallocated: number; deductions: number }) => [p.kind, p.amount, p.allocated, p.unallocated, p.deductions]),
    [['TDS', R(20000), R(20000), 0, 1], ['TCS', R(1180), R(1180), 0, 1]])
  assert.equal(reco.unmatched, 0)

  // MSME: a micro supplier with no agreed credit period has 15 days
  const micro = await call('POST', `${at}/ledgers`, { name: 'Micro Parts', groupId: g('Sundry Creditors'), pan: 'ABCPM1234K' }).then((r) => r.id)
  const medium = await L('Medium Mills', 'Sundry Creditors', { billwise: true })
  const purchases = await L('Purchases', 'Purchase Accounts')
  assert.equal((await raw('PUT', `${at}/msme`, [{ ledgerId: micro, msme: { type: 'Micro', udyamNo: 'UDYAM-MH-1', activity: 'Manufacturing' } }])).status, 422)
  assert.equal((await raw('PUT', `${at}/msme`, [{ ledgerId: purchases, msme: { type: 'Small', activity: 'Trading' } }])).status, 422)
  await call('PUT', `${at}/msme`, [{ ledgerId: micro, msme: { type: 'Micro', udyamNo: 'udyam-mh-01-0012345', activity: 'Manufacturing' } }, { ledgerId: medium, msme: { type: 'Medium', activity: 'Trading' } }])
  const parties: { ledgerId: number; type: string | null; udyamNo: string | null }[] = await call('GET', `${at}/msme`)
  assert.equal(parties.find((p) => p.ledgerId === micro)!.udyamNo, 'UDYAM-MH-01-0012345')
  assert.ok(parties.some((p) => p.ledgerId === buyer && p.type === null))
  const buy = (date: string, party: number, amount: number, bill: string) =>
    call('POST', `${at}/vouchers`, { type: 'Purchase', date, entries: [{ ledgerId: purchases, amount: R(amount) }, { ledgerId: party, amount: -R(amount), bills: [{ type: 'New Ref', name: bill, amount: -R(amount) }] }] })
  await buy('2026-08-01', micro, 50000, 'MP-1')
  await buy('2026-09-20', micro, 10000, 'MP-2')
  await buy('2026-07-01', medium, 70000, 'MM-1')
  const f1 = await call('GET', `${at}/reports/msme-form1?fy=2026-04-01&half=1`)
  assert.deepEqual(f1.lines.map((l: { bill: string; dueDate: string; daysOverdue: number; amount: number }) => [l.bill, l.dueDate, l.daysOverdue, l.amount]), [['MP-1', '2026-08-16', 45, R(50000)]])
  assert.deepEqual(f1.suppliers.map((s: { supplier: string; amount: number }) => [s.supplier, s.amount]), [['Micro Parts', R(50000)]])
  assert.deepEqual(f1.problems, [])
  assert.equal((await raw('GET', `${at}/reports/msme-form1?fy=2026-04-01&half=3`)).status, 422)
  // interest on late payment (section 16): at three times a 6.50% bank rate, monthly rests; a part payment stops it on what it paid
  await call('POST', `${at}/vouchers`, { type: 'Payment', date: '2026-09-10', entries: [
    { ledgerId: micro, amount: R(20000), bills: [{ type: 'Agst Ref', name: 'MP-1', amount: R(20000) }] }, { ledgerId: (await L('Bank', 'Bank Accounts')), amount: -R(20000) }] })
  const mi = await call('GET', `${at}/reports/msme-interest?asOf=2026-09-30&bankRate=650`)
  const compound = (amount: number, days: number) => Math.round(R(amount) * ((1 + 0.195 / 12) ** (days / (365 / 12)) - 1))
  assert.deepEqual(mi.lines.map((l: { bill: string; unpaid: number; interest: number }) => [l.bill, l.unpaid, l.interest]), [['MP-1', R(30000), compound(20000, 25) + compound(30000, 45)]])
  assert.equal(mi.rate, 1950)
  assert.equal((await raw('GET', `${at}/reports/msme-interest?asOf=2026-09-30`)).status, 400)
  // a party's own TDS rates: a certificate needs its number and a PAN; a treaty rate is for a party abroad
  const pr = { ledgerId: micro, natureId: null, kind: 'certificate', rate: 100, validFrom: '2026-04-01', validTo: '2027-03-31', limit: R(500000) }
  assert.equal((await raw('POST', `${at}/tds/party-rates`, pr)).status, 422)
  await call('POST', `${at}/tds/party-rates`, { ...pr, certificateNo: 'LDC0001' })
  assert.equal((await raw('POST', `${at}/tds/party-rates`, { ...pr, kind: 'dtaa' })).status, 422)
  assert.deepEqual((await call('GET', `${at}/tds/party-rates`)).map((x: { party: string; certificateNo: string; limit: number }) => [x.party, x.certificateNo, x.limit]), [['Micro Parts', 'LDC0001', R(500000)]])

  // backup keeps the TCS natures, collections and MSME details
  const { file } = await backupCompany(c.id)
  const restored = await restoreCompany(file)
  const rat = `/companies/${restored.id}`
  const eq2 = await call('GET', `${rat}/reports/form-27eq?fy=2026-04-01&quarter=1`)
  assert.deepEqual(eq2.deductions.map((d: { collectionCode: string; tds: number; challan: { challanNo: string } | null }) => [d.collectionCode, d.tds, d.challan?.challanNo]), [['E', R(1180), '00042']])
  assert.deepEqual((await call('GET', `${rat}/reports/msme-form1?fy=2026-04-01&half=1`)).suppliers.map((s: { udyamNo: string }) => s.udyamNo), ['UDYAM-MH-01-0012345'])
})
