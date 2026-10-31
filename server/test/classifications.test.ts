import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'
import { createCompany, createLedger, loadGroups, postVoucher, setCompanyGst } from '../src/books'
import { alterClassification, createClassification, deleteClassification } from '../src/classifications'
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
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function company() {
  const companyId = await createCompany({ name: `Class Co ${Date.now()}-${Math.random()}`, booksBegin: '2026-04-01' })
  await setCompanyGst(companyId, { gstin: '27AAPFU0939F1ZV' })
  const groups = await loadGroups(pool, companyId)
  const g = (n: string) => [...groups.values()].find((x) => x.name === n)!.id
  const L = (name: string, group: string, extra: object = {}) => createLedger(companyId, { name, groupId: g(group), ...extra })
  const kg = await createUnit(companyId, { symbol: 'Kg', decimals: 2 })
  return {
    companyId, kg, main: await defaultGodown(pool, companyId),
    sales: await L('Sales', 'Sales Accounts'),
    cgst: await L('CGST', 'Duties & Taxes', { gstTaxType: 'CGST' }),
    sgst: await L('SGST', 'Duties & Taxes', { gstTaxType: 'SGST' }),
    igst: await L('IGST', 'Duties & Taxes', { gstTaxType: 'IGST' }),
    local: await L('Pune Traders', 'Sundry Debtors', { gstin: '27AAPFU0939F1ZV', state: 'Maharashtra', billwise: false }),
    karnataka: await L('Bengaluru Co', 'Sundry Debtors', { gstin: '29AAGCB7383J1Z4', billwise: false }),
    walkIn: await L('Walk-in', 'Sundry Debtors', { state: 'Maharashtra', billwise: false }),
    supplier: await L('Supplier', 'Sundry Creditors', { gstin: '29AAGCB7383J1Z4', billwise: false }),
    purchases: await L('Purchases', 'Purchase Accounts'),
    g,
  }
}

test('a GST classification gives its items their HSN and rate, and a change of rate reaches invoices entered after it', async () => {
  const s = await company()
  const grains = await createClassification(s.companyId, { name: 'Packaged grains', hsn: '1006', gstRate: 500 })
  await assert.rejects(createClassification(s.companyId, { name: 'packaged GRAINS', hsn: '1006', gstRate: 500 }), /already used/)
  await assert.rejects(createClassification(s.companyId, { name: 'Bad', hsn: '10A', gstRate: 500 }), /not an HSN/)
  await assert.rejects(createClassification(s.companyId, { name: 'No rate', hsn: '1006' }), /needs its GST rate/)
  await assert.rejects(createClassification(s.companyId, { name: 'Exempt with rate', taxability: 'Exempt', gstRate: 500 }), /has no GST rate/)
  // the item's own details give way to the classification's
  const rice = await createStockItem(s.companyId, { name: 'Rice', unitId: s.kg, hsn: '9999', gstRate: 1800, gstClassificationId: grains })
  const sale = (date: string, igst: number) =>
    postVoucher(s.companyId, { type: 'Sales', date, entries: [
      { ledgerId: s.karnataka, amount: R(10000) + igst }, { ledgerId: s.sales, amount: -R(10000) }, { ledgerId: s.igst, amount: -igst }],
      inventory: [{ itemId: rice, godownId: s.main, qty: -100000, rate: R(100), amount: -R(10000) }] })
  await sale('2026-07-02', R(500))
  await alterClassification(s.companyId, grains, { name: 'Packaged grains', hsn: '1006', gstRate: 1200 })
  await sale('2026-07-03', R(1200))
  const r1 = (await call('GET', `/companies/${s.companyId}/reports/gstr1?from=2026-07-01&to=2026-07-31`)).body
  assert.deepEqual(r1.attention, [])
  // the first invoice keeps the 5% it was posted with
  assert.deepEqual(r1.hsn.b2b.map((h: { hsn: string; rate: number; taxable: number }) => [h.hsn, h.rate, h.taxable]), [['1006', 500, R(10000)], ['1006', 1200, R(10000)]])

  // in use, it can't be deleted; the API lists how often it is used
  await assert.rejects(deleteClassification(s.companyId, grains), /used by stock items or ledgers/)
  const list = (await call('GET', `/companies/${s.companyId}/gst-classifications`)).body
  assert.deepEqual(list.map((c: { name: string; used: number; taxability: string }) => [c.name, c.used, c.taxability]), [['Packaged grains', 1, 'Taxable']])
  const other = await call('POST', `/companies/${s.companyId}/gst-classifications`, { name: 'Unused', hsn: '9983', gstRate: 1800 })
  assert.equal(other.status, 201)
  assert.equal((await call('DELETE', `/companies/${s.companyId}/gst-classifications/${other.body.id}`)).status, 204)
  // another company's classification can't be picked
  const elsewhere = await company()
  const theirs = await createClassification(elsewhere.companyId, { name: 'Theirs', hsn: '1006', gstRate: 500 })
  await assert.rejects(createStockItem(s.companyId, { name: 'Wheat', unitId: s.kg, gstClassificationId: theirs }), /Unknown GST classification/)
  const led = await call('POST', `/companies/${s.companyId}/ledgers`, { name: 'Odd', groupId: s.g('Sales Accounts'), gstClassificationId: theirs })
  assert.equal(led.status, 422)
  // the Edit Log keeps the classification's history
  const log = (await call('GET', `/companies/${s.companyId}/edit-log?entity=GST%20classification`)).body
  assert.deepEqual(log.map((e: { action: string }) => e.action).sort(), ['alter', 'create', 'create', 'delete'])
})

test('exempt, nil-rated and non-GST supplies are reported apart: GSTR-1 table 8, GSTR-3B 3.1(c), 3.1(e) and 5', async () => {
  const s = await company()
  const milk = await createStockItem(s.companyId, { name: 'Fresh milk', unitId: s.kg, hsn: '0401', taxability: 'Exempt' })
  const salt = await createClassification(s.companyId, { name: 'Salt', hsn: '2501', taxability: 'Nil Rated' })
  const saltItem = await createStockItem(s.companyId, { name: 'Salt', unitId: s.kg, gstClassificationId: salt })
  const petrol = await createStockItem(s.companyId, { name: 'Petrol', unitId: s.kg, taxability: 'Non-GST' })
  const oil = await createStockItem(s.companyId, { name: 'Oil', unitId: s.kg, hsn: '1508', gstRate: 500 })
  const line = (itemId: number, rupees: number) => ({ itemId, godownId: s.main, qty: -1000, rate: R(rupees), amount: -R(rupees) })
  // a mixed invoice to a registered buyer in the state: oil is taxed at 5%, milk exempt
  await postVoucher(s.companyId, { type: 'Sales', date: '2026-08-02', entries: [
    { ledgerId: s.local, amount: R(1650) }, { ledgerId: s.sales, amount: -R(1600) }, { ledgerId: s.cgst, amount: -R(25) }, { ledgerId: s.sgst, amount: -R(25) }],
    inventory: [line(oil, 1000), line(milk, 600)] })
  // only untaxed goods to an unregistered buyer: salt (nil), petrol (non-GST); and salt across the border to a registered one
  await postVoucher(s.companyId, { type: 'Sales', date: '2026-08-03', entries: [{ ledgerId: s.walkIn, amount: R(700) }, { ledgerId: s.sales, amount: -R(700) }],
    inventory: [line(saltItem, 300), line(petrol, 400)] })
  await postVoucher(s.companyId, { type: 'Sales', date: '2026-08-04', entries: [{ ledgerId: s.karnataka, amount: R(250) }, { ledgerId: s.sales, amount: -R(250) }],
    inventory: [line(saltItem, 250)] })
  // a nil-rated purchase from Karnataka
  await postVoucher(s.companyId, { type: 'Purchase', date: '2026-08-05', entries: [{ ledgerId: s.purchases, amount: R(900) }, { ledgerId: s.supplier, amount: -R(900) }],
    inventory: [{ itemId: saltItem, godownId: s.main, qty: 5000, rate: R(180), amount: R(900) }] })
  const aug = '?from=2026-08-01&to=2026-08-31'
  const r1 = (await call('GET', `/companies/${s.companyId}/reports/gstr1${aug}`)).body
  assert.deepEqual(r1.attention, [])
  // B2B shows the mixed invoice at 5% only; the salt-only invoices (and the milk) are in table 8
  assert.deepEqual(r1.b2b.map((x: { docNo: string; rates: { rate: number }[] }) => [x.docNo, x.rates.map((r) => r.rate)]), [['1', [500]]])
  assert.deepEqual(r1.b2cs, [])
  assert.deepEqual(r1.nilRows, [
    { supplyType: 'INTRB2B', nil: R(250), exempt: 0, nonGst: 0 },
    { supplyType: 'INTRAB2B', nil: 0, exempt: R(600), nonGst: 0 },
    { supplyType: 'INTRAB2C', nil: R(300), exempt: 0, nonGst: R(400) },
  ])
  // non-GST goods have no HSN line
  assert.deepEqual(r1.hsn.b2c.map((h: { hsn: string }) => h.hsn), ['2501'])
  const json = (await call('GET', `/companies/${s.companyId}/reports/gstr1.json${aug}`)).body
  assert.deepEqual(json.nil, { inv: [
    { sply_ty: 'INTRB2B', nil_amt: 250, expt_amt: 0, ngsup_amt: 0 },
    { sply_ty: 'INTRAB2B', nil_amt: 0, expt_amt: 600, ngsup_amt: 0 },
    { sply_ty: 'INTRAB2C', nil_amt: 300, expt_amt: 0, ngsup_amt: 400 },
  ] })

  const r3 = (await call('GET', `/companies/${s.companyId}/reports/gstr3b${aug}`)).body
  assert.equal(r3.outward.taxable, R(1000))
  assert.equal(r3.nilExempt.taxable, R(250 + 600 + 300))
  assert.equal(r3.nonGst.taxable, R(400))
  assert.deepEqual(r3.inwardExempt, { inter: R(900), intra: 0 })
  assert.deepEqual(r3.inwardNonGst, { inter: 0, intra: 0 })

  // a backup carries classifications and taxability
  const restored = (await restoreCompany((await backupCompany(s.companyId)).file)).id
  const classes = (await call('GET', `/companies/${restored}/gst-classifications`)).body
  assert.deepEqual(classes.map((c: { name: string; hsn: string; taxability: string; gstRate: number | null; used: number }) => [c.name, c.hsn, c.taxability, c.gstRate, c.used]),
    [['Salt', '2501', 'Nil Rated', null, 1]])
  const items = (await call('GET', `/companies/${restored}/stock-items`)).body
  assert.deepEqual(items.map((i: { name: string; taxability: string; gstClassificationId: number | null }) => [i.name, i.taxability, i.gstClassificationId !== null]).sort(),
    [['Fresh milk', 'Exempt', false], ['Oil', 'Taxable', false], ['Petrol', 'Non-GST', false], ['Salt', 'Taxable', true]])
  const r1b = (await call('GET', `/companies/${restored}/reports/gstr1${aug}`)).body
  assert.deepEqual(r1b.nilRows, r1.nilRows)
})
