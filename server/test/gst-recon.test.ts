import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'
import { backupCompany, restoreCompany } from '../src/backup'
import { parse2b } from '../src/gst-more'

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
const SUPPLIER = '29AAGCB7383J1Z4'

const twoB = {
  data: {
    gstin: '27AAPFU0939F1ZV', rtnprd: '102026',
    docdata: {
      b2b: [{ ctin: SUPPLIER, trdnm: 'Karnataka Supplier', inv: [
        { inum: 'INV-101', typ: 'R', dt: '03-10-2026', val: 118000, pos: '27', rev: 'N', items: [{ num: 1, rt: 18, txval: 100000, igst: 18000, cgst: 0, sgst: 0, cess: 0 }] },
        { inum: 'INV/102', typ: 'R', dt: '04-10-2026', val: 58000, pos: '27', rev: 'N', items: [{ num: 1, rt: 18, txval: 50000, igst: 8000, cgst: 0, sgst: 0, cess: 0 }] },
        { inum: 'INV-200', typ: 'R', dt: '06-10-2026', val: 11800, pos: '27', rev: 'N', items: [{ num: 1, rt: 18, txval: 10000, igst: 1800, cgst: 0, sgst: 0, cess: 0 }] },
      ] }],
    },
  },
}

test('GSTR-2B parsing', () => {
  const { month, docs } = parse2b(twoB)
  assert.equal(month, '2026-10')
  assert.deepEqual(docs.map((d) => [d.docNo, d.docDate, d.taxable, d.igst]), [['INV-101', '2026-10-03', R(100000), R(18000)], ['INV/102', '2026-10-04', R(50000), R(8000)], ['INV-200', '2026-10-06', R(10000), R(1800)]])
  assert.throws(() => parse2b({ data: { rtnprd: '102026' } }), /not a GSTR-2B/)
})

test('GST: 2B reconciliation with IMS, GSTR-1 reconciliation, advances, GSTR-9, challans, party GSTINs, composition, backup', async () => {
  const c = await call('POST', '/companies', { name: `GST Reco ${Date.now()}`, booksBegin: '2026-04-01' })
  const at = (p: string) => `/companies/${c.id}${p}`
  await call('PUT', at('/gst'), { gstin: '27AAPFU0939F1ZV' })
  const groups: { id: number; name: string }[] = await call('GET', at('/groups'))
  const g = (n: string) => groups.find((x) => x.name === n)!.id
  const L = async (name: string, group: string, extra: object = {}) => (await call('POST', at('/ledgers'), { name, groupId: g(group), billwise: false, ...extra })).id as number
  const purchases = await L('Purchases', 'Purchase Accounts', { gstRate: 1800, hsn: '8471' })
  const services = await L('Consulting Income', 'Sales Accounts', { gstRate: 1800, hsn: '998311' })
  const igst = await L('IGST', 'Duties & Taxes', { gstTaxType: 'IGST' })
  await L('CGST', 'Duties & Taxes', { gstTaxType: 'CGST' })
  await L('SGST', 'Duties & Taxes', { gstTaxType: 'SGST' })
  const supplier = await L('Karnataka Supplier', 'Sundry Creditors', { gstin: SUPPLIER })
  const customer = await L('Bengaluru Co', 'Sundry Debtors', { gstin: SUPPLIER })
  const advCustomer = await L('Advance Customer', 'Sundry Debtors', { gstin: SUPPLIER, billwise: true })
  const walkIn = await L('Walk-in', 'Sundry Debtors')
  const bank = await L('HDFC', 'Bank Accounts')

  const buy = (date: string, refNo: string, refDate: string, taxable: number, tax: number) =>
    call('POST', at('/vouchers'), { type: 'Purchase', date, refNo, refDate, entries: [{ ledgerId: purchases, amount: R(taxable) }, { ledgerId: igst, amount: R(tax) }, { ledgerId: supplier, amount: -R(taxable + tax) }] })
  const p1 = await buy('2026-10-05', 'INV-101', '2026-10-03', 100000, 18000)
  await buy('2026-10-06', 'INV-102', '2026-10-04', 50000, 9000)
  await buy('2026-10-08', 'INV-103', '2026-10-08', 20000, 3600)
  assert.equal((await call('GET', at(`/vouchers/${p1.id}`))).refNo, 'INV-101')
  assert.equal((await raw('POST', at('/vouchers'), { type: 'Payment', date: '2026-10-08', advanceRate: 1800, entries: [{ ledgerId: purchases, amount: R(1) }, { ledgerId: bank, amount: -R(1) }] })).status, 422)

  // GSTR-2B: matched, a tax mismatch (the number written differently), one the books lack, one the portal lacks
  assert.equal((await raw('POST', at('/gst/portal/2b'), { hello: 1 })).status, 422)
  assert.deepEqual(await call('POST', at('/gst/portal/2b'), twoB), { month: '2026-10', count: 3, registration: 0 })
  let reco = await call('GET', at('/reports/gstr2b-reconciliation?month=2026-10'))
  assert.deepEqual(reco.rows.map((r: { portal: { docNo: string }; status: string; differences: string[] }) => [r.portal.docNo, r.status, r.differences]),
    [['INV-101', 'Matched', []], ['INV/102', 'Mismatch', ['tax']], ['INV-200', 'Not in books', []]])
  assert.deepEqual(reco.notOnPortal.map((b: { docNo: string }) => b.docNo), ['INV-103'])
  assert.equal(reco.summary.pending, 3)
  // IMS: reject the invoice we never received; uploading again keeps the action
  const inv200 = reco.rows.find((r: { portal: { docNo: string } }) => r.portal.docNo === 'INV-200').id
  await call('PUT', at('/gst/ims'), [{ id: inv200, action: 'Rejected' }])
  await call('POST', at('/gst/portal/2b'), twoB)
  reco = await call('GET', at('/reports/gstr2b-reconciliation?month=2026-10'))
  assert.equal(reco.rows.find((r: { portal: { docNo: string } }) => r.portal.docNo === 'INV-200').imsAction, 'Rejected')
  assert.equal(reco.summary.acceptedTax.igst, R(26000))

  // an outward invoice, our GSTR-1 file uploaded back as filed: it matches; a later invoice is not in it
  await call('POST', at('/vouchers'), { type: 'Sales', date: '2026-10-10', entries: [{ ledgerId: customer, amount: R(11800) }, { ledgerId: services, amount: -R(10000) }, { ledgerId: igst, amount: -R(1800) }] })
  const file = await call('GET', at('/reports/gstr1.json?from=2026-10-01&to=2026-10-31'))
  await call('POST', at('/gst/portal/gstr1'), file)
  await call('POST', at('/vouchers'), { type: 'Sales', date: '2026-10-20', entries: [{ ledgerId: customer, amount: R(5900) }, { ledgerId: services, amount: -R(5000) }, { ledgerId: igst, amount: -R(900) }] })
  const r1 = await call('GET', at('/reports/gstr1-reconciliation?month=2026-10'))
  assert.equal(r1.summary.matched, 1)
  assert.deepEqual(r1.notOnPortal.map((b: { taxable: number }) => b.taxable), [R(5000)])

  // an advance for services in October, adjusted by the November invoice
  await call('POST', at('/vouchers'), { type: 'Receipt', date: '2026-10-15', advanceRate: 1800, entries: [
    { ledgerId: bank, amount: R(11800) }, { ledgerId: advCustomer, amount: -R(11800), bills: [{ type: 'Advance', name: 'ADV-1', amount: -R(11800) }] }] })
  let adv = await call('GET', at('/reports/gst-advances?from=2026-10-01&to=2026-10-31'))
  assert.deepEqual([adv.totals.received.taxable, adv.totals.received.igst], [R(10000), R(1800)])
  const b3oct = await call('GET', at('/reports/gstr3b?from=2026-10-01&to=2026-10-31'))
  assert.equal(b3oct.outward.igst, R(1800 + 900 + 1800)) // two invoices and the advance
  await call('POST', at('/vouchers'), { type: 'Sales', date: '2026-11-05', entries: [
    { ledgerId: advCustomer, amount: R(23600), bills: [{ type: 'Agst Ref', name: 'ADV-1', amount: R(11800) }, { type: 'New Ref', name: 'S-NOV', amount: R(11800) }] },
    { ledgerId: services, amount: -R(20000) }, { ledgerId: igst, amount: -R(3600) }] })
  adv = await call('GET', at('/reports/gst-advances?from=2026-11-01&to=2026-11-30'))
  assert.deepEqual([adv.totals.adjusted.taxable, adv.totals.net.igst], [R(10000), -R(1800)])
  assert.equal((await call('GET', at('/reports/gst-advances?from=2026-10-01&to=2026-10-31'))).received.length, 1) // received in October all the same

  // GST paid in November, its challan
  const pay = await call('POST', at('/vouchers'), { type: 'Payment', date: '2026-11-20', entries: [{ ledgerId: igst, amount: R(5000) }, { ledgerId: bank, amount: -R(5000) }] })
  let ch = await call('GET', at('/reports/gst-challans?from=2026-11-01&to=2026-11-30'))
  assert.deepEqual(ch.payments.map((x: { igst: number; challan: unknown }) => [x.igst, x.challan]), [[R(5000), null]])
  assert.equal((await raw('PUT', at('/gst-challans'), [{ voucherId: pay.id, challan: { cpin: '123', depositDate: '2026-11-20' } }])).status, 422)
  await call('PUT', at('/gst-challans'), [{ voucherId: pay.id, challan: { cpin: '26112700012345', cin: 'HDFC0001234567890', depositDate: '2026-11-20' } }])
  ch = await call('GET', at('/reports/gst-challans?from=2026-11-01&to=2026-11-30'))
  assert.equal(ch.withoutChallan, 0)

  // GSTR-9 for the year
  const g9 = await call('GET', at('/reports/gstr9?fy=2026-04-01'))
  assert.equal(g9.t4.b2b.taxable, R(10000 + 5000 + 20000))
  assert.equal(g9.t4.advances.taxable, 0) // received and adjusted within the year
  assert.equal(g9.t6.inputs.igst, R(18000 + 9000 + 3600))
  assert.equal(g9.t8.as2b.igst, R(26000))
  assert.equal(g9.t8.difference.igst, R(26000 - 30600))
  assert.ok(g9.t17.some((h: { hsn: string }) => h.hsn === '998311'))
  assert.ok(g9.t18.some((h: { hsn: string; taxable: number }) => h.hsn === '8471' && h.taxable === R(170000)))

  // party GSTINs updated together: the state and PAN follow the GSTIN
  assert.equal((await raw('PUT', at('/gst-parties'), [{ ledgerId: walkIn, gstin: '27AAPFU0939F1ZX', state: null }])).status, 422)
  await call('PUT', at('/gst-parties'), [{ ledgerId: walkIn, gstin: '27aapfu0939f1zv', state: null }])
  const walk = (await call('GET', at('/gst-parties'))).find((p: { ledgerId: number }) => p.ledgerId === walkIn)
  assert.deepEqual([walk.gstin, walk.state, walk.pan], ['27AAPFU0939F1ZV', 'Maharashtra', 'AAPFU0939F'])
  assert.equal((await raw('GET', at('/reports/cmp08?fy=2026-04-01&quarter=3'))).status, 422) // a regular dealer

  // backup keeps the supplier invoice numbers, the 2B with its IMS actions, advances and challans
  const { file: bk } = await backupCompany(c.id)
  const rc = await restoreCompany(bk)
  const rat = (p: string) => `/companies/${rc.id}${p}`
  const reco2 = await call('GET', rat('/reports/gstr2b-reconciliation?month=2026-10'))
  assert.deepEqual([reco2.summary.matched, reco2.summary.mismatched, reco2.summary.acceptedTax.igst], [1, 1, R(26000)])
  assert.equal((await call('GET', rat('/reports/gst-challans?from=2026-11-01&to=2026-11-30'))).withoutChallan, 0)
  assert.equal((await call('GET', rat('/reports/gst-advances?from=2026-10-01&to=2026-10-31'))).totals.received.igst, R(1800))

  // a composition dealer: CMP-08 at 1% of the quarter's turnover, GSTR-4 for the year
  const k = await call('POST', '/companies', { name: `Composition ${Date.now()}`, booksBegin: '2026-04-01' })
  const kat = (p: string) => `/companies/${k.id}${p}`
  assert.equal((await raw('PUT', kat('/gst'), { gstin: '27AAPFU0939F1ZV', gstType: 'Composition' })).status, 422) // needs a rate
  await call('PUT', kat('/gst'), { gstin: '27AAPFU0939F1ZV', gstType: 'Composition', compositionRate: 100 })
  const kg: { id: number; name: string }[] = await call('GET', kat('/groups'))
  const kl = async (name: string, group: string, extra: object = {}) => (await call('POST', kat('/ledgers'), { name, groupId: kg.find((x) => x.name === group)!.id, billwise: false, ...extra })).id as number
  const ksales = await kl('Sales', 'Sales Accounts', { taxability: 'Exempt' })
  const kcash = await kl('Walk-in Customer', 'Sundry Debtors', { state: 'Maharashtra' })
  await call('POST', kat('/vouchers'), { type: 'Sales', date: '2026-10-12', entries: [{ ledgerId: kcash, amount: R(100000) }, { ledgerId: ksales, amount: -R(100000) }] })
  const q3 = await call('GET', kat('/reports/cmp08?fy=2026-04-01&quarter=3'))
  assert.deepEqual([q3.turnover, q3.outward.cgst, q3.outward.sgst], [R(100000), R(500), R(500)])
  const g4 = await call('GET', kat('/reports/gstr4?fy=2026-04-01'))
  assert.deepEqual([g4.t6.turnover, g4.t6.cgst], [R(100000), R(500)])
})
