import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'
import { alterLedger, alterVoucher, createCompany, createLedger, loadGroups, postVoucher, setCompanyGst } from '../src/books'
import { createStockItem, createUnit, defaultGodown } from '../src/inventory'

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
const get = async (path: string) => {
  const res = await fetch(base + path)
  return { status: res.status, body: await res.json() }
}

async function gstCompany() {
  const companyId = await createCompany({ name: `GST Co ${Date.now()}-${Math.random()}`, booksBegin: '2026-04-01' })
  await setCompanyGst(companyId, { gstin: '27AAPFU0939F1ZV' }) // Maharashtra, from the GSTIN
  const groups = await loadGroups(pool, companyId)
  const g = (n: string) => [...groups.values()].find((x) => x.name === n)!.id
  const L = (name: string, group: string, extra: object = {}) => createLedger(companyId, { name, groupId: g(group), ...extra })
  const ids = {
    services: await L('Consulting Income', 'Sales Accounts', { gstRate: 1800, hsn: '998311' }),
    goods: await L('Sales', 'Sales Accounts'),
    purchases: await L('Purchases', 'Purchase Accounts'),
    cgst: await L('CGST', 'Duties & Taxes', { gstTaxType: 'CGST' }),
    sgst: await L('SGST', 'Duties & Taxes', { gstTaxType: 'SGST' }),
    igst: await L('IGST', 'Duties & Taxes', { gstTaxType: 'IGST' }),
    local: await L('Pune Traders', 'Sundry Debtors', { gstin: '27AAPFU0939F1ZV', state: 'Maharashtra', billwise: false }),
    karnataka: await L('Bengaluru Co', 'Sundry Debtors', { gstin: '29AAGCB7383J1Z4', billwise: false }),
    walkIn: await L('Goa Walk-in', 'Sundry Debtors', { state: 'Goa', billwise: false }),
    supplier: await L('Supplier', 'Sundry Creditors', { gstin: '29AAGCB7383J1Z4', billwise: false }),
  }
  const kg = await createUnit(companyId, { symbol: 'Kg', decimals: 2 })
  const rice = await createStockItem(companyId, { name: 'Rice', unitId: kg, hsn: '1006', gstRate: 500 })
  return { companyId, g, ...ids, rice, main: await defaultGodown(pool, companyId) }
}

test('a GST month: invoices carry their breakup, GSTR-1 sections, GSTR-3B set-off, the portal file', async () => {
  const s = await gstCompany()
  const at = `/companies/${s.companyId}`
  const july = '?from=2026-07-01&to=2026-07-31'
  // within Maharashtra, services at 18%: CGST 9% + SGST 9%
  await postVoucher(s.companyId, { type: 'Sales', date: '2026-07-02', entries: [
    { ledgerId: s.local, amount: R(11800) }, { ledgerId: s.services, amount: -R(10000) }, { ledgerId: s.cgst, amount: -R(900) }, { ledgerId: s.sgst, amount: -R(900) }] })
  // to Karnataka, 400 kg rice at 5%: IGST
  await postVoucher(s.companyId, { type: 'Sales', date: '2026-07-05', entries: [
    { ledgerId: s.karnataka, amount: R(21000) }, { ledgerId: s.goods, amount: -R(20000) }, { ledgerId: s.igst, amount: -R(1000) }],
    inventory: [{ itemId: s.rice, godownId: s.main, qty: -400000, rate: R(50), amount: -R(20000) }] })
  // an unregistered buyer in Goa above ₹1 lakh: B2C (Large)
  await postVoucher(s.companyId, { type: 'Sales', date: '2026-07-10', entries: [
    { ledgerId: s.walkIn, amount: R(141600) }, { ledgerId: s.services, amount: -R(120000) }, { ledgerId: s.igst, amount: -R(21600) }] })
  // the Karnataka buyer returns 40 kg
  await postVoucher(s.companyId, { type: 'Credit Note', date: '2026-07-20', entries: [
    { ledgerId: s.goods, amount: R(2000) }, { ledgerId: s.igst, amount: R(100) }, { ledgerId: s.karnataka, amount: -R(2100) }],
    inventory: [{ itemId: s.rice, godownId: s.main, qty: 40000, rate: R(50), amount: R(2000) }] })
  // a purchase from Karnataka with IGST credit of 3,000
  await postVoucher(s.companyId, { type: 'Purchase', date: '2026-07-03', entries: [
    { ledgerId: s.purchases, amount: R(60000) }, { ledgerId: s.igst, amount: R(3000) }, { ledgerId: s.supplier, amount: -R(63000) }],
    inventory: [{ itemId: s.rice, godownId: s.main, qty: 1200000, rate: R(50), amount: R(60000) }] })

  const r1 = (await get(`${at}/reports/gstr1${july}`)).body
  assert.deepEqual(r1.b2b.map((x: { party: string; igst: number; cgst: number }) => [x.party, x.igst, x.cgst]), [['Pune Traders', 0, R(900)], ['Bengaluru Co', R(1000), 0]])
  assert.deepEqual(r1.b2cl.map((x: { pos: string; value: number }) => [x.pos, x.value]), [['30', R(141600)]])
  assert.deepEqual(r1.cdnr.map((x: { number: number; igst: number }) => [x.number, x.igst]), [[1, R(100)]])
  assert.deepEqual(r1.hsn.b2b.map((h: { hsn: string; qty: number; taxable: number }) => [h.hsn, h.qty, h.taxable]), [['1006', 360000, R(18000)], ['998311', 0, R(10000)]])
  assert.deepEqual(r1.docs, [{ type: 'Sales', series: null, from: '1', to: '3', total: 3, cancelled: 0 }, { type: 'Credit Note', series: null, from: '1', to: '1', total: 1, cancelled: 0 }])
  assert.deepEqual(r1.attention, [])

  const r3 = (await get(`${at}/reports/gstr3b${july}`)).body
  assert.deepEqual(r3.outward, { taxable: R(148000), igst: R(22500), cgst: R(900), sgst: R(900), cess: 0 })
  assert.deepEqual(r3.itc, { igst: R(3000), cgst: 0, sgst: 0 })
  assert.deepEqual(r3.interstateUnregistered, [{ pos: '30', state: 'Goa', taxable: R(120000), igst: R(21600) }])
  assert.deepEqual(r3.setOff, [{ from: 'igst', to: 'igst', amount: R(3000) }])
  assert.deepEqual(r3.cash, { igst: R(19500), cgst: R(900), sgst: R(900) })

  const file = (await get(`${at}/reports/gstr1.json${july}`)).body
  assert.equal(file.fp, '072026')
  assert.deepEqual(file.b2b.map((x: { ctin: string }) => x.ctin), ['27AAPFU0939F1ZV', '29AAGCB7383J1Z4'])
  assert.deepEqual(file.b2b[1].inv[0], { inum: '2', idt: '05-07-2026', val: 21000, pos: '29', rchrg: 'N', inv_typ: 'R',
    itms: [{ num: 1, itm_det: { rt: 5, txval: 20000, iamt: 1000, camt: 0, samt: 0, csamt: 0 } }] })
  assert.equal(file.hsn.hsn_b2b[0].uqc, 'KGS')
  assert.equal((await get(`${at}/reports/gstr1.json?from=2026-07-01&to=2026-08-31`)).status, 422) // one month only
})

test('wrong tax is flagged, and a later rate change leaves posted invoices alone', async () => {
  const s = await gstCompany()
  // to Karnataka but charged CGST + SGST
  const v = await postVoucher(s.companyId, { type: 'Sales', date: '2026-08-01', entries: [
    { ledgerId: s.karnataka, amount: R(1180) }, { ledgerId: s.services, amount: -R(1000) }, { ledgerId: s.cgst, amount: -R(90) }, { ledgerId: s.sgst, amount: -R(90) }] })
  const r1 = (await get(`/companies/${s.companyId}/reports/gstr1?from=2026-08-01&to=2026-08-31`)).body
  assert.match(r1.attention[0].problems.join(), /should be IGST/)
  await alterVoucher(s.companyId, v.id, { type: 'Sales', date: '2026-08-01', entries: [
    { ledgerId: s.karnataka, amount: R(1180) }, { ledgerId: s.services, amount: -R(1000) }, { ledgerId: s.igst, amount: -R(180) }] })
  const groups = await loadGroups(pool, s.companyId)
  await alterLedger(s.companyId, s.services, { name: 'Consulting Income', groupId: [...groups.values()].find((x) => x.name === 'Sales Accounts')!.id, gstRate: 1200, hsn: '998311' })
  const again = (await get(`/companies/${s.companyId}/reports/gstr1?from=2026-08-01&to=2026-08-31`)).body
  assert.deepEqual(again.attention, [])
  assert.equal(again.b2b[0].rates[0].rate, 1800) // as posted
})

test('GST details are checked: GSTIN, state, tax ledgers, the company registration', async () => {
  const s = await gstCompany()
  await assert.rejects(createLedger(s.companyId, { name: 'Bad', groupId: s.g('Sundry Debtors'), gstin: '27AAPFU0939F1ZW' }), /check digit/)
  await assert.rejects(createLedger(s.companyId, { name: 'Bad2', groupId: s.g('Sundry Debtors'), state: 'Atlantis' }), /not a GST state/)
  await assert.rejects(createLedger(s.companyId, { name: 'Bad3', groupId: s.g('Sales Accounts'), gstTaxType: 'IGST' }), /Duties & Taxes/)
  await assert.rejects(setCompanyGst(s.companyId, { gstin: '27AAPFU0939F1ZV', state: 'Karnataka' }), /registered in Maharashtra/)
  const plain = await createCompany({ name: `No GST ${Date.now()}`, booksBegin: '2026-04-01' })
  assert.equal((await get(`/companies/${plain}/reports/gstr1`)).status, 422)
})

test('backup and restore carry GST: registration, ledger and item details, the posted breakups', async () => {
  const { backupCompany, restoreCompany } = await import('../src/backup')
  const s = await gstCompany()
  await postVoucher(s.companyId, { type: 'Sales', date: '2026-07-05', entries: [
    { ledgerId: s.karnataka, amount: R(21000) }, { ledgerId: s.goods, amount: -R(20000) }, { ledgerId: s.igst, amount: -R(1000) }],
    inventory: [{ itemId: s.rice, godownId: s.main, qty: -400000, rate: R(50), amount: -R(20000) }] })
  const restored = await restoreCompany((await backupCompany(s.companyId)).file)
  const r1 = async (id: number) => {
    const { from, to, ...rest } = (await get(`/companies/${id}/reports/gstr1?from=2026-07-01&to=2026-07-31`)).body
    return JSON.parse(JSON.stringify(rest, (k, v) => (k === 'voucherId' ? undefined : v)))
  }
  assert.deepEqual(await r1(restored.id), await r1(s.companyId))
  const ctx = (await get(`/companies/${restored.id}/gst-context`)).body
  assert.equal(ctx.companyGstin, '27AAPFU0939F1ZV')
  assert.deepEqual(ctx.ledgers.find((l: { name: string }) => l.name === 'IGST').taxType, 'IGST')
  assert.deepEqual(ctx.items.map((i: { hsn: string; rate: number }) => [i.hsn, i.rate]), [['1006', 500]])
})
