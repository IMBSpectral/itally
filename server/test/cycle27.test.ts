import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'
import { backupCompany, restoreCompany } from '../src/backup'

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
const b64 = (s: string) => Buffer.from(s).toString('base64')

async function company(name: string, gstin: string, booksBegin = '2026-04-01') {
  const c = await call('POST', '/companies', { name: `${name} ${Date.now()}`, booksBegin })
  const at = (p: string) => `/companies/${c.id}${p}`
  await call('PUT', at('/gst'), { gstin })
  const groups: { id: number; name: string }[] = await call('GET', at('/groups'))
  const g = (n: string) => groups.find((x) => x.name === n)!.id
  const L = async (lname: string, group: string, extra: object = {}) => (await call('POST', at('/ledgers'), { name: lname, groupId: g(group), billwise: false, ...extra })).id as number
  return { c, at, L }
}

test('GST registrations (tax units): a branch in another state, its voucher type, its own returns; backup', async () => {
  const { c, at, L } = await company('Tax Units', '27AAPFU0939F1ZV')
  const services = await L('Consulting', 'Sales Accounts', { gstRate: 1800, hsn: '998311' })
  const igst = await L('IGST', 'Duties & Taxes', { gstTaxType: 'IGST' })
  const cgst = await L('CGST', 'Duties & Taxes', { gstTaxType: 'CGST' })
  const sgst = await L('SGST', 'Duties & Taxes', { gstTaxType: 'SGST' })
  const bengaluru = await L('Bengaluru Client', 'Sundry Debtors', { gstin: '29AAGCB7383J1Z4' })

  assert.equal((await raw('POST', at('/gst-registrations'), { name: 'Elsewhere', gstin: '29AAGCB7383J1Z4' })).status, 422) // another PAN
  const ka = (await call('POST', at('/gst-registrations'), { name: 'Karnataka branch', gstin: '29AAPFU0939F1ZR' })).id
  const regs = await call('GET', at('/gst-registrations'))
  assert.deepEqual(regs.map((r: { id: number; state: string }) => [r.id, r.state]), [[0, 'Maharashtra'], [ka, 'Karnataka']])
  const kaSales = (await call('POST', at('/voucher-types'), { name: 'Sales - Bengaluru', baseType: 'Sales', prefix: 'BLR/', gstRegistrationId: ka })).id

  // the same customer: from Mumbai it is inter-state (IGST), from the Bengaluru branch intra-state
  await call('POST', at('/vouchers'), { type: 'Sales', date: '2026-07-02', entries: [
    { ledgerId: bengaluru, amount: R(11800) }, { ledgerId: services, amount: -R(10000) }, { ledgerId: igst, amount: -R(1800) }] })
  await call('POST', at('/vouchers'), { type: 'Sales', voucherTypeId: kaSales, date: '2026-07-03', entries: [
    { ledgerId: bengaluru, amount: R(5900) }, { ledgerId: services, amount: -R(5000) }, { ledgerId: cgst, amount: -R(450) }, { ledgerId: sgst, amount: -R(450) }] })
  const july = '?from=2026-07-01&to=2026-07-31'
  const main = await call('GET', at(`/reports/gstr1${july}`))
  const branch = await call('GET', at(`/reports/gstr1${july}&registration=${ka}`))
  assert.deepEqual([main.gstin, main.b2b.length, main.b2b[0].igst], ['27AAPFU0939F1ZV', 1, R(1800)])
  assert.deepEqual([branch.gstin, branch.b2b.length, branch.b2b[0].cgst, branch.b2b[0].igst], ['29AAPFU0939F1ZR', 1, R(450), 0])
  assert.deepEqual((await call('GET', at(`/reports/gstr3b${july}&registration=${ka}`))).outward.sgst, R(450))
  assert.equal((await call('GET', at(`/reports/gstr1.json${july}&registration=${ka}`))).gstin, '29AAPFU0939F1ZR')
  // the branch's GSTR-2B: the file names its GSTIN, so it goes with that registration; GSTR-9 per registration
  const branch2b = { data: { gstin: '29AAPFU0939F1ZR', rtnprd: '072026', docdata: { b2b: [{ ctin: '29AAGCB7383J1Z4', trdnm: 'Local Supplier', inv: [
    { inum: 'K-1', typ: 'R', dt: '05-07-2026', val: 1180, pos: '29', rev: 'N', items: [{ num: 1, rt: 18, txval: 1000, igst: 0, cgst: 90, sgst: 90, cess: 0 }] }] }] } } }
  assert.deepEqual(await call('POST', at('/gst/portal/2b'), branch2b), { month: '2026-07', count: 1, registration: ka })
  assert.equal((await raw('POST', at('/gst/portal/2b'), { data: { ...branch2b.data, gstin: '07AAPFU0939F1ZX' } })).status, 422)
  assert.equal((await call('GET', at(`/reports/gstr2b-reconciliation?month=2026-07&registration=${ka}`))).rows.length, 1)
  assert.equal((await call('GET', at('/reports/gstr2b-reconciliation?month=2026-07'))).rows.length, 0)
  const nine = await call('GET', at(`/reports/gstr9?fy=2026-04-01&registration=${ka}`))
  assert.deepEqual([nine.gstin, nine.t4.b2b.taxable, nine.t8.as2b.cgst], ['29AAPFU0939F1ZR', R(5000), R(90)])
  assert.equal((await call('GET', at('/reports/gstr9?fy=2026-04-01'))).t4.b2b.taxable, R(10000))
  // a voucher type in use keeps its registration; a registration in use stays
  assert.equal((await raw('PUT', at(`/voucher-types/${kaSales}`), { name: 'Sales - Bengaluru', baseType: 'Sales', prefix: 'BLR/', gstRegistrationId: null })).status, 422)
  assert.equal((await raw('DELETE', at(`/gst-registrations/${ka}`))).status, 422)

  const { file } = await backupCompany(c.id)
  const r = await restoreCompany(file)
  const regs2 = await call('GET', `/companies/${r.id}/gst-registrations`)
  const branch2 = await call('GET', `/companies/${r.id}/reports/gstr1${july}&registration=${regs2[1].id}`)
  assert.deepEqual([branch2.gstin, branch2.b2b[0].cgst], ['29AAPFU0939F1ZR', R(450)])
})

test('TDS statements by the 2025 Act; Kerala Flood Cess', async () => {
  const { at } = await company('Forms', '27AAPFU0939F1ZV')
  assert.equal((await call('GET', at('/reports/form-140?fy=2026-04-01&quarter=1'))).title, 'Form 140 (was 26Q)')
  assert.equal((await call('GET', at('/reports/form-26q?fy=2026-04-01&quarter=1'))).title, 'Form 140 (was 26Q)')
  assert.equal((await call('GET', at('/reports/form-144?fy=2026-04-01&quarter=2'))).title, 'Form 144 (was 27Q)')
  assert.equal((await call('GET', at('/reports/form-143?fy=2026-04-01&quarter=3'))).title, 'Form 143 (was 27EQ)')
  assert.equal((await call('GET', at('/reports/form-26q?fy=2025-04-01&quarter=4'))).title, 'Form 26Q')
  assert.equal((await call('GET', at('/reports/kerala-flood-cess?from=2026-04-01&to=2027-03-31'))).applicable, false)

  const k = await company('Kochi Traders', '32AAPFU0939F1Z4', '2020-04-01')
  const sales = await k.L('Sales', 'Sales Accounts', { gstRate: 1800, hsn: '8471' })
  const cg = await k.L('CGST', 'Duties & Taxes', { gstTaxType: 'CGST' })
  const sg = await k.L('SGST', 'Duties & Taxes', { gstTaxType: 'SGST' })
  const ig = await k.L('IGST', 'Duties & Taxes', { gstTaxType: 'IGST' })
  const walkIn = await k.L('Walk-in Kochi', 'Sundry Debtors', { state: 'Kerala' })
  const chennai = await k.L('Chennai Buyer', 'Sundry Debtors', { state: 'Tamil Nadu' })
  await call('POST', k.at('/vouchers'), { type: 'Sales', date: '2020-06-10', entries: [{ ledgerId: walkIn, amount: R(11800) }, { ledgerId: sales, amount: -R(10000) }, { ledgerId: cg, amount: -R(900) }, { ledgerId: sg, amount: -R(900) }] })
  await call('POST', k.at('/vouchers'), { type: 'Sales', date: '2020-06-11', entries: [{ ledgerId: chennai, amount: R(11800) }, { ledgerId: sales, amount: -R(10000) }, { ledgerId: ig, amount: -R(1800) }] })
  const kfc = await call('GET', k.at('/reports/kerala-flood-cess?from=2020-04-01&to=2021-03-31'))
  assert.deepEqual([kfc.applicable, kfc.lines.length, kfc.total.taxable, kfc.total.cess], [true, 1, R(10000), R(100)])
  assert.equal((await call('GET', k.at('/reports/kerala-flood-cess?from=2022-04-01&to=2023-03-31'))).applicable, false)
})

test('payment gateway reconciliation: the settlement report against the receipts, a settlement posted; backup', async () => {
  const { c, at, L } = await company('Gateway Co', '27AAPFU0939F1ZV')
  const rzp = await L('Razorpay', 'Bank Accounts')
  const bank = await L('HDFC', 'Bank Accounts')
  const charges = await L('Gateway Charges', 'Indirect Expenses')
  const itc = await L('Input IGST', 'Duties & Taxes', { gstTaxType: 'IGST' })
  const customer = await L('Online Customers', 'Sundry Debtors')
  const receipt = (date: string, amount: number, narration = '') =>
    call('POST', at('/vouchers'), { type: 'Receipt', date, narration, entries: [{ ledgerId: rzp, amount: R(amount) }, { ledgerId: customer, amount: -R(amount) }] })
  await receipt('2026-06-01', 1000, 'order 17, pay_A')
  await receipt('2026-06-02', 500)
  await receipt('2026-06-03', 700)
  const report = 'payment_id,created_at,amount,fee,tax,settlement_id,settled_at,notes\n' +
    'pay_A,2026-06-01 10:15:00,1000,20,3.60,setl_1,2026-06-04,order 17\n' +
    'pay_B,02/06/2026,500,10,1.80,setl_1,2026-06-04,\n' +
    'pay_C,2026-06-05,250,5,0.90,,,\n' +
    ',2026-06-05,10,0,0,,,\n'
  assert.equal((await raw('POST', at('/gateways/Razorpay/report'), { file: b64('foo,bar\n1,2\n') })).status, 422)
  const up = await call('POST', at('/gateways/Razorpay/report'), { file: b64(report) })
  assert.deepEqual([up.kept, up.failed.map((f: { row: number }) => f.row)], [3, [5]])
  const reco = await call('GET', at(`/reports/gateway?gateway=razorpay&ledger=${rzp}&from=2026-06-01&to=2026-06-30`))
  assert.deepEqual(reco.payments.map((p: { paymentId: string; status: string }) => [p.paymentId, p.status]), [['pay_A', 'Matched'], ['pay_B', 'Matched'], ['pay_C', 'Not in books']])
  assert.deepEqual(reco.notInReport.map((r: { amount: number }) => r.amount), [R(700)])
  assert.deepEqual(reco.settlements.map((s: { settlementId: string; gross: number; fee: number; tax: number; net: number }) => [s.settlementId, s.gross, s.fee, s.tax, s.net]),
    [['setl_1', R(1500), R(30), R(5.4), R(1464.6)]])
  // posting the settlement: the net into the bank, the fee and its GST as expenses, the gross off Razorpay
  assert.equal((await raw('POST', at('/gateways/Razorpay/settlements/setl_1/post'), { gatewayLedgerId: rzp, bankLedgerId: bank, feeLedgerId: charges })).status, 422) // GST on the fee needs a ledger
  const v = await call('POST', at('/gateways/Razorpay/settlements/setl_1/post'), { gatewayLedgerId: rzp, bankLedgerId: bank, feeLedgerId: charges, taxLedgerId: itc })
  const posted = await call('GET', at(`/vouchers/${v.id}`))
  assert.deepEqual([posted.type, posted.date, posted.entries.map((e: { amount: number }) => e.amount)], ['Receipt', '2026-06-04', [R(1464.6), R(30), R(5.4), -R(1500)]])
  assert.equal((await raw('POST', at('/gateways/Razorpay/settlements/setl_1/post'), { gatewayLedgerId: rzp, bankLedgerId: bank, feeLedgerId: charges, taxLedgerId: itc })).status, 422)
  const after = await call('GET', at(`/reports/gateway?gateway=Razorpay&ledger=${rzp}&from=2026-06-01&to=2026-06-30`))
  assert.equal(after.settlements[0].postedVoucherId, v.id)
  assert.deepEqual(after.notInReport.map((r: { amount: number }) => r.amount), [R(700)]) // the settlement itself is not a payment

  const { file } = await backupCompany(c.id)
  const r = await restoreCompany(file)
  const rrzp = ((await call('GET', `/companies/${r.id}/ledgers?from=2026-04-01&to=2027-03-31`)) as { id: number; name: string }[]).find((l) => l.name === 'Razorpay')!.id
  const reco2 = await call('GET', `/companies/${r.id}/reports/gateway?gateway=Razorpay&ledger=${rrzp}&from=2026-06-01&to=2026-06-30`)
  assert.equal(reco2.payments.length, 3)
  assert.ok(reco2.settlements[0].postedVoucherId)
})
