import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'
import { createCompany, createLedger, loadGroups, postVoucher, setCompanyDetails, setCompanyGst } from '../src/books'
import { createStockItem, createUnit, defaultGodown } from '../src/inventory'
import { backupCompany, restoreCompany } from '../src/backup'

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
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, body: res.status === 204 ? null : await res.json() }
}
const IRN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
/** A signed QR code as the IRP issues it: a JWT whose payload's `data` is the invoice summary. */
const signedQr = (docNo: string, irn = IRN) => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'RS256' })}.${b64({ data: JSON.stringify({ SellerGstin: '27AAPFU0939F1ZV', DocNo: docNo, DocTyp: 'INV', Irn: irn, TotInvVal: 70800 }), iss: 'NIC' })}.c2lnbmF0dXJl`
}

async function shop() {
  const companyId = await createCompany({ name: `e-docs ${Date.now()}-${Math.random()}`, booksBegin: '2026-04-01' })
  await setCompanyGst(companyId, { gstin: '27AAPFU0939F1ZV' })
  const groups = await loadGroups(pool, companyId)
  const g = (n: string) => [...groups.values()].find((x) => x.name === n)!.id
  const nos = await createUnit(companyId, { symbol: 'Nos' })
  const crate = await createUnit(companyId, { symbol: 'Crate', uqc: 'CTN' })
  const L = (name: string, group: string, extra: object = {}) => createLedger(companyId, { name, groupId: g(group), billwise: false, ...extra })
  return {
    companyId,
    laptop: await createStockItem(companyId, { name: 'Laptop 14"', unitId: nos, hsn: '8471', gstRate: 1800 }),
    mangoes: await createStockItem(companyId, { name: 'Mangoes', unitId: crate, hsn: '0804', gstRate: 0 }),
    main: await defaultGodown(pool, companyId),
    sales: await L('Sales', 'Sales Accounts'),
    consulting: await L('Consulting', 'Sales Accounts', { gstRate: 1800, hsn: '998311' }),
    purchases: await L('Purchases', 'Purchase Accounts'),
    igst: await L('IGST', 'Duties & Taxes', { gstTaxType: 'IGST' }),
    buyer: await L('Bengaluru Traders', 'Sundry Debtors', {
      gstin: '29AAGCB7383J1Z4', mailingName: 'Bengaluru Traders Pvt Ltd', address: '12 MG Road\nShanthala Nagar\nBengaluru', pincode: '560001',
    }),
    us: await L('Acme Inc', 'Sundry Debtors', { country: 'United States', address: '1 Main St\nSpringfield', pincode: '' }),
    supplier: await L('Delhi Wholesale', 'Sundry Creditors', { gstin: '07AAACD1234F1Z9', address: 'Okhla Phase 2\nNew Delhi', pincode: '110020' }),
  }
}

test('e-Invoice and e-Way Bill: problems first, then the IRP and portal JSON, then what they gave back', async () => {
  const s = await shop()
  const at = `/companies/${s.companyId}`
  const sale = await postVoucher(s.companyId, {
    type: 'Sales', date: '2026-07-05',
    entries: [{ ledgerId: s.buyer, amount: R(70800) }, { ledgerId: s.sales, amount: -R(60000) }, { ledgerId: s.igst, amount: -R(10800) }],
    inventory: [{ itemId: s.laptop, godownId: s.main, qty: -2000, rate: R(30000), amount: -R(60000) }],
  })
  // no seller address yet, and no transport
  let doc = (await call('GET', `${at}/vouchers/${sale.id}/e-document`)).body
  assert.ok(doc.einvoice.needed && doc.eway.needed, 'a B2B invoice; goods above ₹50,000')
  assert.ok(doc.einvoice.problems.includes('Seller: no address (set the mailing details)'))
  assert.ok(doc.einvoice.problems.includes('Seller: the PIN code must be six digits'))
  assert.ok(doc.eway.problems.some((p: string) => p.startsWith('Enter the transport details')))
  assert.equal(doc.einvoiceJson, null)
  assert.equal((await call('GET', `${at}/e-invoice.json?ids=${sale.id}`)).status, 422)

  await setCompanyDetails(s.companyId, { mailingName: 'Unique Foods LLP', address: 'Plot 5, MIDC\nAndheri East\nMumbai', pincode: '400093', email: 'accounts@example.in' })
  await assert.rejects(setCompanyDetails(s.companyId, { pincode: '40009' }), /six digits/)
  assert.equal((await call('PUT', `${at}/vouchers/${sale.id}/e-document`, { transport: { mode: '1', distance: 0, vehicleNo: 'ka 01 ab 1234' } })).status, 200)
  doc = (await call('GET', `${at}/vouchers/${sale.id}/e-document`)).body
  assert.deepEqual([doc.einvoice.problems, doc.eway.problems], [[], []])
  const e = doc.einvoiceJson
  assert.deepEqual(e.TranDtls, { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' })
  assert.deepEqual(e.DocDtls, { Typ: 'INV', No: String(sale.number), Dt: '05/07/2026' })
  assert.deepEqual(e.SellerDtls, { Gstin: '27AAPFU0939F1ZV', LglNm: 'Unique Foods LLP', Addr1: 'Plot 5, MIDC', Addr2: 'Andheri East', Loc: 'Mumbai', Pin: 400093, Stcd: '27', Em: 'accounts@example.in' })
  assert.deepEqual(e.BuyerDtls, { Gstin: '29AAGCB7383J1Z4', LglNm: 'Bengaluru Traders Pvt Ltd', Pos: '29', Addr1: '12 MG Road', Addr2: 'Shanthala Nagar', Loc: 'Bengaluru', Pin: 560001, Stcd: '29' })
  assert.deepEqual(e.ItemList, [{ SlNo: '1', PrdDesc: 'Laptop 14"', IsServc: 'N', HsnCd: '8471', Qty: 2, Unit: 'NOS', UnitPrice: 30000, TotAmt: 60000, AssAmt: 60000,
    GstRt: 18, IgstAmt: 10800, CgstAmt: 0, SgstAmt: 0, TotItemVal: 70800 }])
  assert.deepEqual(e.ValDtls, { AssVal: 60000, IgstVal: 10800, CgstVal: 0, SgstVal: 0, RndOffAmt: 0, TotInvVal: 70800 })
  assert.deepEqual(e.EwbDtls, { TransMode: '1', Distance: 0, VehNo: 'KA01AB1234', VehType: 'R' }, 'Part B travels with the e-Invoice')
  const w = doc.ewayJson.billLists[0]
  assert.deepEqual([w.supplyType, w.subSupplyType, w.docType, w.fromGstin, w.toGstin, w.fromPincode, w.toStateCode, w.igstValue, w.totInvValue, w.vehicleNo],
    ['O', 1, 'INV', '27AAPFU0939F1ZV', '29AAGCB7383J1Z4', 400093, 29, 10800, 70800, 'KA01AB1234'])
  assert.deepEqual(w.itemList[0], { itemNo: 1, productName: 'Laptop 14"', productDesc: 'Laptop 14"', hsnCode: 8471, quantity: 2, qtyUnit: 'NOS', taxableAmount: 60000,
    sgstRate: 0, cgstRate: 0, igstRate: 18, cessRate: 0, cessNonAdvol: 0 })
  const file = await call('GET', `${at}/e-invoice.json?ids=${sale.id}`)
  assert.deepEqual([file.status, file.body.length], [200, 1])

  // the IRP's answer: the signed QR code alone carries the IRN
  assert.equal((await call('PUT', `${at}/vouchers/${sale.id}/e-document`, { signedQr: 'not-a-token' })).status, 422)
  assert.match((await call('PUT', `${at}/vouchers/${sale.id}/e-document`, { signedQr: signedQr('999') })).body.error ?? '', /document 999/)
  const saved = await call('PUT', `${at}/vouchers/${sale.id}/e-document`, { signedQr: signedQr(String(sale.number)), ackNo: '112010036563310', ackDate: '2026-07-05 12:41:00', ewbNo: '331001234567' })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.equal(saved.body.irn, IRN)
  const reg = (await call('GET', `${at}/e-documents?from=2026-07-01&to=2026-07-31`)).body.vouchers
  assert.deepEqual(reg.map((r: { number: string; einvoice: { irn: string }; eway: { ewbNo: string } }) => [r.number, r.einvoice.irn, r.eway.ewbNo]), [[String(sale.number), IRN, '331001234567']])

  // what was given back survives a backup
  const restored = await restoreCompany((await backupCompany(s.companyId)).file)
  const again = (await call('GET', `/companies/${restored.id}/e-documents?from=2026-07-01&to=2026-07-31`)).body.vouchers
  assert.equal(again[0].einvoice.irn, IRN)
  assert.equal((await call('GET', `/companies/${restored.id}`)).body.pincode, '400093')
})

test('an export of services under LUT, a purchase brought in by road, and a unit with its own UQC', async () => {
  const s = await shop()
  const at = `/companies/${s.companyId}`
  await setCompanyDetails(s.companyId, { address: 'Plot 5, MIDC\nMumbai', pincode: '400093' })
  const exp = await postVoucher(s.companyId, { type: 'Sales', date: '2026-08-01', entries: [{ ledgerId: s.us, amount: R(250000) }, { ledgerId: s.consulting, amount: -R(250000) }] })
  const doc = (await call('GET', `${at}/vouchers/${exp.id}/e-document`)).body
  assert.deepEqual(doc.einvoice.problems, [])
  assert.equal(doc.eway.needed, false, 'services move no goods')
  const e = doc.einvoiceJson
  assert.equal(e.TranDtls.SupTyp, 'EXPWOP')
  assert.deepEqual([e.BuyerDtls.Gstin, e.BuyerDtls.Pos, e.BuyerDtls.Pin, e.BuyerDtls.Stcd, e.BuyerDtls.Loc], ['URP', '96', 999999, '96', 'Springfield'])
  assert.deepEqual(e.ItemList[0], { SlNo: '1', PrdDesc: 'Consulting', IsServc: 'Y', HsnCd: '998311', UnitPrice: 250000, TotAmt: 250000, AssAmt: 250000, GstRt: 18,
    IgstAmt: 0, CgstAmt: 0, SgstAmt: 0, TotItemVal: 250000 })
  assert.deepEqual(e.ExpDtls, { CntCode: 'US' })

  const buy = await postVoucher(s.companyId, {
    type: 'Purchase', date: '2026-08-02',
    entries: [{ ledgerId: s.purchases, amount: R(60000) }, { ledgerId: s.supplier, amount: -R(60000) }],
    inventory: [{ itemId: s.mangoes, godownId: s.main, qty: 300000, rate: R(200), amount: R(60000) }],
  })
  await call('PUT', `${at}/vouchers/${buy.id}/e-document`, { transport: { mode: '1', distance: 1400, transporterId: '07AAACD1234F1Z9', transporterName: 'Delhi Roadways' } })
  const pdoc = (await call('GET', `${at}/vouchers/${buy.id}/e-document`)).body
  assert.ok(pdoc.einvoice.problems.includes('Only sales, credit notes and debit notes carry an e-Invoice'))
  const w = pdoc.ewayJson.billLists[0]
  assert.deepEqual([w.userGstin, w.supplyType, w.fromGstin, w.fromPincode, w.toGstin, w.toPincode, w.transDistance, w.transporterId, w.itemList[0].qtyUnit, w.itemList[0].quantity],
    ['27AAPFU0939F1ZV', 'I', '07AAACD1234F1Z9', 110020, '27AAPFU0939F1ZV', 400093, '1400', '07AAACD1234F1Z9', 'CTN', 300])
  assert.equal((await call('PUT', `${at}/vouchers/${buy.id}/e-document`, { transport: { mode: '1', distance: 10, vehicleNo: 'XYZ' } })).status, 200)
  assert.ok((await call('GET', `${at}/vouchers/${buy.id}/e-document`)).body.eway.problems.includes('"XYZ" is not a vehicle number (for example KA01AB1234)'))
  const bad = await call('GET', `${at}/e-way-bill.json?ids=${buy.id}`)
  assert.equal(bad.status, 422)
  await assert.rejects(createUnit(s.companyId, { symbol: 'Bale', uqc: 'XYZ' }), /not a GST unit quantity code/)
})
