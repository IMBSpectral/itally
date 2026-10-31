import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'
import { alterVoucher, createCompany, createLedger, loadGroups, postVoucher, setCompanyGst } from '../src/books'

const R = (rupees: number) => Math.round(rupees * 100)
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
const call = async (method: string, path: string) => {
  const res = await fetch(base + path, { method })
  return { status: res.status, body: res.status === 204 ? null : await res.json() }
}

async function gstCompany() {
  const companyId = await createCompany({ name: `GST+ ${Date.now()}-${Math.random()}`, booksBegin: '2026-04-01' })
  await setCompanyGst(companyId, { gstin: '27AAPFU0939F1ZV' }) // Maharashtra
  const groups = await loadGroups(pool, companyId)
  const g = (n: string) => [...groups.values()].find((x) => x.name === n)!.id
  const L = (name: string, group: string, extra: object = {}) => createLedger(companyId, { name, groupId: g(group), ...extra })
  return {
    companyId, g,
    services: await L('Consulting Income', 'Sales Accounts', { gstRate: 1800, hsn: '998311' }),
    cgst: await L('CGST', 'Duties & Taxes', { gstTaxType: 'CGST' }),
    sgst: await L('SGST', 'Duties & Taxes', { gstTaxType: 'SGST' }),
    igst: await L('IGST', 'Duties & Taxes', { gstTaxType: 'IGST' }),
    karnataka: await L('Bengaluru Co', 'Sundry Debtors', { gstin: '29AAGCB7383J1Z4', billwise: false }),
    us: await L('Acme Inc', 'Sundry Debtors', { country: 'United States', billwise: false }),
    goa: await L('Goa Walk-in', 'Sundry Debtors', { state: 'Goa', billwise: false }),
    freight: await L('Freight (GTA)', 'Indirect Expenses', { gstRate: 500, hsn: '996511', reverseCharge: true }),
    transporter: await L('Road Carriers', 'Sundry Creditors', { state: 'Maharashtra', billwise: false }),
    rent: await L('Office Rent', 'Indirect Expenses'),
    supplier: await L('Supplier', 'Sundry Creditors', { gstin: '29AAGCB7383J1Z4', billwise: false }),
    purchases: await L('Purchases', 'Purchase Accounts', { gstRate: 1800, hsn: '8471' }),
  }
}
type Co = Awaited<ReturnType<typeof gstCompany>>
const sale = (s: Co, party: number, date: string, taxable: number, tax: { ledgerId: number; amount: number }[] = []) =>
  postVoucher(s.companyId, {
    type: 'Sales', date,
    entries: [{ ledgerId: party, amount: taxable + tax.reduce((t, x) => t + x.amount, 0) }, { ledgerId: s.services, amount: -taxable }, ...tax.map((x) => ({ ...x, amount: -x.amount }))],
  })

test('exports go to 6A and 3.1(b); unregistered notes against exports and B2C (Large) invoices to 9B', async () => {
  const s = await gstCompany()
  const at = `/companies/${s.companyId}`
  // an export under LUT (no IGST) and one with IGST paid
  await sale(s, s.us, '2026-08-03', R(100000))
  await sale(s, s.us, '2026-08-04', R(50000), [{ ledgerId: s.igst, amount: R(9000) }])
  // a B2C (Large) invoice to Goa and a credit note to the same walk-in customer
  await sale(s, s.goa, '2026-08-05', R(200000), [{ ledgerId: s.igst, amount: R(36000) }])
  await postVoucher(s.companyId, {
    type: 'Credit Note', date: '2026-08-20',
    entries: [{ ledgerId: s.goa, amount: -R(118000) }, { ledgerId: s.services, amount: R(100000) }, { ledgerId: s.igst, amount: R(18000) }],
  })
  await postVoucher(s.companyId, {
    type: 'Credit Note', date: '2026-08-21', entries: [{ ledgerId: s.us, amount: -R(10000) }, { ledgerId: s.services, amount: R(10000) }],
  })

  const { body: r1 } = await call('GET', `${at}/reports/gstr1?from=2026-08-01&to=2026-08-31`)
  assert.deepEqual(r1.exp.map((x: { number: number; expType: string; pos: string; igst: number }) => [x.expType, x.pos, x.igst]), [['WOPAY', '96', 0], ['WPAY', '96', R(9000)]])
  assert.deepEqual(r1.b2cl.length, 1)
  assert.deepEqual(r1.cdnur.map((x: { noteType: string; taxable: number }) => [x.noteType, x.taxable]), [['B2CL', R(100000)], ['EXPWOP', R(10000)]])
  assert.deepEqual(r1.b2cs, [], 'nothing left for B2C (Small)')
  assert.equal(r1.attention.length, 0, 'an LUT export is not a wrong-tax invoice')

  const { body: r3 } = await call('GET', `${at}/reports/gstr3b?from=2026-08-01&to=2026-08-31`)
  assert.deepEqual([r3.zeroRated.taxable, r3.zeroRated.igst], [R(150000) - R(10000), R(9000)])
  assert.equal(r3.outward.taxable, R(100000), 'the Goa sale less its note')
  assert.deepEqual(r3.interstateUnregistered.map((u: { pos: string }) => u.pos), ['30'], 'exports are not inter-state supplies to the unregistered')

  const { body: file } = await call('GET', `${at}/reports/gstr1.json?from=2026-08-01&to=2026-08-31`)
  assert.deepEqual(file.exp.map((x: { exp_typ: string; inv: unknown[] }) => [x.exp_typ, x.inv.length]), [['WPAY', 1], ['WOPAY', 1]])
  assert.deepEqual(file.cdnur.map((x: { typ: string }) => x.typ), ['B2CL', 'EXPWOP'])
})

test('reverse charge: 3.1(d) and 4(A)(3), paid in cash; ITC reversed and reclaimed by GST adjustment journals', async () => {
  const s = await gstCompany()
  const at = `/companies/${s.companyId}`
  await sale(s, s.karnataka, '2026-09-02', R(100000), [{ ledgerId: s.igst, amount: R(18000) }])
  // a purchase with IGST credit of 9,000
  await postVoucher(s.companyId, { type: 'Purchase', date: '2026-09-03', entries: [
    { ledgerId: s.purchases, amount: R(50000) }, { ledgerId: s.igst, amount: R(9000) }, { ledgerId: s.supplier, amount: -R(59000) }] })
  // GTA freight: the transporter charges no tax; we owe 5% under reverse charge (within the state: 2.5% + 2.5%)
  const gta = await postVoucher(s.companyId, { type: 'Journal', date: '2026-09-04', entries: [{ ledgerId: s.freight, amount: R(10000) }, { ledgerId: s.transporter, amount: -R(10000) }] })
  assert.deepEqual((await pool.query(`SELECT gst FROM vouchers WHERE id = $1`, [gta.id])).rows[0].gst.rcm, { taxable: R(10000), igst: 0, cgst: R(250), sgst: R(250) })
  // reverse 1,000 of IGST credit (say, used for personal purposes), and reclaim 400 later
  await postVoucher(s.companyId, { type: 'Journal', date: '2026-09-20', gstAdjustment: 'itc-reversal', entries: [{ ledgerId: s.rent, amount: R(1000) }, { ledgerId: s.igst, amount: -R(1000) }] })
  await postVoucher(s.companyId, { type: 'Journal', date: '2026-09-25', gstAdjustment: 'itc-reclaim', entries: [{ ledgerId: s.igst, amount: R(400) }, { ledgerId: s.rent, amount: -R(400) }] })
  await assert.rejects(postVoucher(s.companyId, { type: 'Payment', date: '2026-09-25', gstAdjustment: 'itc-reversal', entries: [{ ledgerId: s.rent, amount: 1 }, { ledgerId: s.transporter, amount: -1 }] }), /made with a Journal/)
  await assert.rejects(createLedger(s.companyId, { name: 'X', groupId: s.g('Sundry Debtors'), reverseCharge: true }), /purchase or expense ledger/)

  const { body: r3 } = await call('GET', `${at}/reports/gstr3b?from=2026-09-01&to=2026-09-30`)
  assert.deepEqual([r3.rcmInward.taxable, r3.rcmInward.cgst, r3.rcmInward.sgst], [R(10000), R(250), R(250)])
  assert.deepEqual(r3.itcRcm, { igst: 0, cgst: R(250), sgst: R(250) })
  assert.deepEqual(r3.reversed.igst, R(1000))
  assert.deepEqual(r3.reclaimed.igst, R(400))
  assert.deepEqual(r3.netItc, { igst: R(9000) - R(1000) + R(400), cgst: R(250), sgst: R(250) })
  // outward IGST 18,000 less all the credit (IGST 8,400, then the reverse charge CGST and SGST credit of 250
  // each, which Rule 88A sets against IGST once CGST and SGST are covered) = 9,100 in cash; the reverse
  // charge tax itself (250 + 250) can't come from credit and is paid in cash too
  assert.deepEqual(r3.cash, { igst: R(9100), cgst: R(250), sgst: R(250) })
  assert.equal(r3.attention, 0)
})

test('amendments: an invoice of a filed month altered later is reported in the month of the change', async () => {
  const s = await gstCompany()
  const at = `/companies/${s.companyId}`
  const inv = await sale(s, s.karnataka, '2026-07-10', R(10000), [{ ledgerId: s.igst, amount: R(1800) }])
  assert.equal((await call('PUT', `${at}/gst/filings/2026-07`)).status, 204)
  assert.equal((await call('GET', `${at}/reports/gstr1?from=2026-07-01&to=2026-07-31`)).body.filed, true)
  // the price is corrected after July was filed; the alteration lands in today's month
  await alterVoucher(s.companyId, inv.id, {
    type: 'Sales', date: '2026-07-10',
    entries: [{ ledgerId: s.karnataka, amount: R(12980) }, { ledgerId: s.services, amount: -R(11000) }, { ledgerId: s.igst, amount: -R(1980) }],
  })
  const today = new Date().toISOString().slice(0, 10)
  const month = today.slice(0, 7)
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10)
  const { body: r1 } = await call('GET', `${at}/reports/gstr1?from=${month}-01&to=${last}`)
  if (month > '2026-07') {
    assert.deepEqual(r1.b2ba.map((x: { originalNumber: number; originalDate: string; taxable: number; igst: number }) => [x.originalNumber, x.originalDate, x.taxable, x.igst]),
      [[String(inv.number), '2026-07-10', R(11000), R(1980)]], 'the number the filed return carried, as shown')
    const { body: file } = await call('GET', `${at}/reports/gstr1.json?from=${month}-01&to=${last}`)
    assert.equal(file.b2ba[0].inv[0].oinum, String(inv.number))
  }
  // an unfiled month reports changes as they stand, with no amendment
  assert.deepEqual((await call('GET', `${at}/reports/gstr1?from=2026-07-01&to=2026-07-31`)).body.b2ba, [])
  assert.equal((await call('DELETE', `${at}/gst/filings/2026-07`)).status, 204)
  assert.deepEqual((await call('GET', `${at}/reports/gstr1?from=${month}-01&to=${last}`)).body.b2ba, [])
})
