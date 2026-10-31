import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'
import { alterVoucher, createCompany, createLedger, getVoucher, loadGroups, postVoucher, setCompanyGst } from '../src/books'
import { createStockItem, createUnit, defaultGodown } from '../src/inventory'
import { createStockCategory, createVoucherType, getFeatures, setFeatures } from '../src/vouchertypes'
import { backupCompany, restoreCompany } from '../src/backup'
import { formatDocNo, fyLabel, numberingProblems } from '../src/engine/numbering'

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
const get = async (path: string) => (await fetch(base + path)).json()
const rule = { numbering: 'auto' as const, prefix: 'EXP/', suffix: '/{FY}', width: 4, startNumber: 1, restartYearly: true }

test('numbering: prefix, zero fill, suffix and the financial year', () => {
  assert.equal(formatDocNo(rule, 7, '2026-07-05', '2026-04-01'), 'EXP/0007/26-27')
  assert.equal(formatDocNo(rule, 7, '2027-02-05', '2026-04-01'), 'EXP/0007/26-27', 'February is still the 2026-27 year')
  assert.equal(fyLabel('2026-05-01', '2026-01-01'), '2026', 'a calendar-year company')
  assert.deepEqual(numberingProblems({ ...rule, suffix: '' }), ['Numbers that restart each year need {FY} in the prefix or suffix, or two years would share a number'])
  assert.deepEqual(numberingProblems({ ...rule, prefix: 'A<B' }), ['Prefix and suffix may hold letters, digits, / - _ . # and {FY}'])
})

test('voucher types number their own series; the predefined type keeps a series without gaps; hand numbers must be unique', async () => {
  const companyId = await createCompany({ name: `Vch types ${Date.now()}`, booksBegin: '2026-04-01' })
  const groups = await loadGroups(pool, companyId)
  const g = (n: string) => [...groups.values()].find((x) => x.name === n)!.id
  const cash = (await pool.query(`SELECT id FROM ledgers WHERE company_id = $1 AND name = 'Cash'`, [companyId])).rows[0].id
  const sales = await createLedger(companyId, { name: 'Sales', groupId: g('Sales Accounts') })
  const sale = (date: string, extra: object = {}) =>
    postVoucher(companyId, { type: 'Sales', date, entries: [{ ledgerId: cash, amount: R(100) }, { ledgerId: sales, amount: -R(100) }], ...extra })

  const plain1 = await sale('2026-04-02')
  assert.equal(plain1.docNo, '1')
  const exp = await createVoucherType(companyId, { name: 'Sales - Export', baseType: 'Sales', ...rule })
  await assert.rejects(createVoucherType(companyId, { name: 'sales', baseType: 'Sales', ...rule }), /predefined voucher type/)
  await assert.rejects(createVoucherType(companyId, { name: 'Sales - export', baseType: 'Sales', ...rule }), /already used/)
  assert.equal((await sale('2026-04-03', { voucherTypeId: exp })).docNo, 'EXP/0001/26-27')
  assert.equal((await sale('2026-05-03', { voucherTypeId: exp })).docNo, 'EXP/0002/26-27')
  assert.equal((await sale('2027-04-03', { voucherTypeId: exp })).docNo, 'EXP/0001/27-28', 'a new year starts again')
  // the plain series goes on from 1 to 2, not to the internal 5
  const plain2 = await sale('2026-06-01')
  assert.deepEqual([plain2.number, plain2.docNo], [5, '2'])
  await assert.rejects(postVoucher(companyId, { type: 'Receipt', date: '2026-06-01', voucherTypeId: exp, entries: [{ ledgerId: cash, amount: 1 }, { ledgerId: sales, amount: -1 }] }),
    /Sales - Export is a Sales voucher type, not Receipt/)

  // numbered by hand: the number is required and unique within the type
  const pos = await createVoucherType(companyId, { name: 'Counter Sale', baseType: 'Sales', ...rule, numbering: 'manual', prefix: '', suffix: '', restartYearly: false })
  await assert.rejects(sale('2026-06-02', { voucherTypeId: pos }), /numbered by hand: type the voucher number/)
  const c1 = await sale('2026-06-02', { voucherTypeId: pos, docNo: 'CS-17' })
  assert.equal(c1.docNo, 'CS-17')
  await assert.rejects(sale('2026-06-03', { voucherTypeId: pos, docNo: 'cs-17' }), /Sales No. cs-17 is already used/)
  await assert.rejects(sale('2026-06-03', { voucherTypeId: pos, docNo: '2' }), /Sales No. 2 is already used/, 'a plain voucher shows 2')
  // altered: the voucher type stays; a hand number can be corrected
  await alterVoucher(companyId, c1.id, { type: 'Sales', date: '2026-06-02', docNo: 'CS-18', entries: [{ ledgerId: cash, amount: R(200) }, { ledgerId: sales, amount: -R(200) }] })
  const v = await getVoucher(pool, companyId, c1.id)
  assert.deepEqual([v.docNo, v.voucherType], ['CS-18', 'Counter Sale'])

  // the Day Book and the Edit Log name vouchers by the number shown
  const book = await get(`/companies/${companyId}/vouchers?from=2026-04-01&to=2027-04-30`)
  assert.deepEqual(book.map((x: { docNo: string }) => x.docNo), ['1', 'EXP/0001/26-27', 'EXP/0002/26-27', '2', 'CS-18', 'EXP/0001/27-28'])
  const log = (await pool.query(`SELECT label FROM edit_log WHERE entity = 'voucher' AND entity_id = $1 ORDER BY id`, [c1.id])).rows.map((r) => r.label)
  assert.deepEqual(log, ['Sales No. CS-17', 'Sales No. CS-18'])

  // a backup keeps the voucher types, their counters and every number
  const restored = await restoreCompany((await backupCompany(companyId)).file)
  const again = await get(`/companies/${restored.id}/vouchers?from=2026-04-01&to=2027-04-30`)
  assert.deepEqual(again.map((x: { docNo: string }) => x.docNo), book.map((x: { docNo: string }) => x.docNo))
  const types = await get(`/companies/${restored.id}/voucher-types`)
  const expAgain = types.find((t: { name: string }) => t.name === 'Sales - Export').id
  const next = await postVoucher(restored.id, { type: 'Sales', date: '2026-07-01', voucherTypeId: expAgain, entries: [
    { ledgerId: (await pool.query(`SELECT id FROM ledgers WHERE company_id = $1 AND name = 'Cash'`, [restored.id])).rows[0].id, amount: 1 },
    { ledgerId: (await pool.query(`SELECT id FROM ledgers WHERE company_id = $1 AND name = 'Sales'`, [restored.id])).rows[0].id, amount: -1 }] })
  assert.equal(next.docNo, 'EXP/0003/26-27', 'the counter came across')
})

test('GSTR-1 reports invoice numbers as shown, and documents issued per series', async () => {
  const companyId = await createCompany({ name: `Vch GST ${Date.now()}`, booksBegin: '2026-04-01' })
  await setCompanyGst(companyId, { gstin: '27AAPFU0939F1ZV' })
  const groups = await loadGroups(pool, companyId)
  const g = (n: string) => [...groups.values()].find((x) => x.name === n)!.id
  const services = await createLedger(companyId, { name: 'Consulting', groupId: g('Sales Accounts'), gstRate: 1800, hsn: '998311' })
  const igst = await createLedger(companyId, { name: 'IGST', groupId: g('Duties & Taxes'), gstTaxType: 'IGST' })
  const buyer = await createLedger(companyId, { name: 'Bengaluru Co', groupId: g('Sundry Debtors'), gstin: '29AAGCB7383J1Z4', billwise: false })
  const inv = await createVoucherType(companyId, { name: 'Tax Invoice', baseType: 'Sales', numbering: 'auto', prefix: 'INV/{FY}/', suffix: '', width: 3, startNumber: 1, restartYearly: true })
  const sale = (voucherTypeId?: number) => postVoucher(companyId, { type: 'Sales', date: '2026-07-05', voucherTypeId,
    entries: [{ ledgerId: buyer, amount: R(1180) }, { ledgerId: services, amount: -R(1000) }, { ledgerId: igst, amount: -R(180) }] })
  await sale(inv)
  await sale(inv)
  await sale()
  const q = `/companies/${companyId}/reports/gstr1?from=2026-07-01&to=2026-07-31`
  const r = await get(q)
  assert.deepEqual(r.b2b.map((x: { docNo: string }) => x.docNo), ['INV/26-27/001', 'INV/26-27/002', '1'])
  assert.deepEqual(r.docs.map((d: { series: string | null; from: string; to: string; total: number }) => [d.series, d.from, d.to, d.total]), [
    [null, '1', '1', 1], ['Tax Invoice', 'INV/26-27/001', 'INV/26-27/002', 2],
  ])
  const file = await get(`/companies/${companyId}/reports/gstr1.json?from=2026-07-01&to=2026-07-31`)
  assert.deepEqual(file.b2b[0].inv.map((i: { inum: string }) => i.inum), ['INV/26-27/001', 'INV/26-27/002', '1'])
  assert.deepEqual(file.doc_issue.doc_det, [{ doc_num: 1, docs: [
    { num: 1, from: '1', to: '1', totnum: 1, cancel: 0, net_issue: 1 },
    { num: 2, from: 'INV/26-27/001', to: 'INV/26-27/002', totnum: 2, cancel: 0, net_issue: 2 }] }])
})

test('F11 features default on and switch off; stock categories, the category summary and Stock Query', async () => {
  const companyId = await createCompany({ name: `Features ${Date.now()}`, booksBegin: '2026-04-01' })
  assert.equal((await getFeatures(companyId)).inventory, true)
  await setFeatures(companyId, { costCentres: false, interest: false })
  const f = await getFeatures(companyId)
  assert.deepEqual([f.costCentres, f.interest, f.billwise], [false, false, true])
  await assert.rejects(setFeatures(companyId, { spaceTravel: true }), /Unknown feature spaceTravel/)

  const groups = await loadGroups(pool, companyId)
  const g = (n: string) => [...groups.values()].find((x) => x.name === n)!.id
  const nos = await createUnit(companyId, { symbol: 'Nos' })
  const brand = await createStockCategory(companyId, { name: 'Acme' })
  const premium = await createStockCategory(companyId, { name: 'Acme Premium', parentId: brand })
  await assert.rejects(createStockCategory(companyId, { name: 'acme' }), /already used/)
  const a = await createStockItem(companyId, { name: 'Kettle', unitId: nos, openingQty: 10000, openingValue: R(5000), categoryId: brand })
  await createStockItem(companyId, { name: 'Toaster', unitId: nos, openingQty: 2000, openingValue: R(4000), categoryId: premium })
  await createStockItem(companyId, { name: 'Loose Cable', unitId: nos, openingQty: 5000, openingValue: R(250) })
  const main = await defaultGodown(pool, companyId)
  const sales = await createLedger(companyId, { name: 'Sales', groupId: g('Sales Accounts') })
  const shop = await createLedger(companyId, { name: 'Corner Shop', groupId: g('Sundry Debtors'), billwise: false })
  await postVoucher(companyId, { type: 'Sales', date: '2026-05-02', entries: [{ ledgerId: shop, amount: R(1400) }, { ledgerId: sales, amount: -R(1400) }],
    inventory: [{ itemId: a, godownId: main, qty: -2000, rate: R(700), amount: -R(1400) }] })
  await postVoucher(companyId, { type: 'Sales Order', date: '2026-05-03', partyId: shop, entries: [],
    inventory: [{ itemId: a, godownId: main, qty: -3000, rate: R(700), amount: -R(2100) }] })

  const at = `/companies/${companyId}`
  const top = await get(`${at}/reports/stock-category-summary?from=2026-04-01&to=2027-03-31`)
  assert.deepEqual(top.lines.map((l: { kind: string; name: string; closingValue: number }) => [l.kind, l.name, l.closingValue]), [
    ['category', 'Acme', R(4000) + R(4000)], ['item', 'Loose Cable', R(250)],
  ])
  const inside = await get(`${at}/reports/stock-category-summary?from=2026-04-01&to=2027-03-31&categoryId=${brand}`)
  assert.deepEqual(inside.lines.map((l: { kind: string; name: string }) => [l.kind, l.name]), [['category', 'Acme Premium'], ['item', 'Kettle']])

  const sq = await get(`${at}/stock-items/${a}/query?from=2026-04-01&to=2027-03-31`)
  assert.equal(sq.item.closingQty, 8000)
  assert.equal(sq.category, 'Acme')
  assert.deepEqual(sq.godowns.map((x: { qty: string | number }) => Number(x.qty)), [8000])
  assert.deepEqual(sq.sales.map((s: { party: string; qty: string | number; rate: number }) => [s.party, Number(s.qty), Number(s.rate)]), [['Corner Shop', 2000, R(700)]])
  assert.equal(sq.salesOrders, 3000)

  const restored = await restoreCompany((await backupCompany(companyId)).file)
  assert.equal((await getFeatures(restored.id)).costCentres, false)
  const again = await get(`/companies/${restored.id}/reports/stock-category-summary?from=2026-04-01&to=2027-03-31`)
  assert.deepEqual(again.lines.map((l: { name: string; closingValue: number }) => [l.name, l.closingValue]), top.lines.map((l: { name: string; closingValue: number }) => [l.name, l.closingValue]))
})
