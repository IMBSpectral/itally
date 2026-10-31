import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gstBreakup, suggestedTaxes, type GstContext, type GstLedger } from '../src/engine/gst'
import { gstr1, gstr1Json, gstr3b, gstr3bLate, type GstVoucher } from '../src/engine/gst-returns'
import { einvoiceJson } from '../src/engine/edocs'

const R = (rupees: number) => Math.round(rupees * 100)

function ctx(): GstContext {
  const ledgers: GstLedger[] = [
    { id: 1, name: 'Sales', group: 'Sales Accounts' },
    { id: 2, name: 'Mumbai Traders', group: 'Sundry Debtors', gstin: '27AAPFU0939F1ZV', state: 'Maharashtra' },
    { id: 3, name: 'Purchases', group: 'Purchase Accounts' },
    { id: 4, name: 'Pune Supplier', group: 'Sundry Creditors', gstin: '27AAPFU0939F1ZV', state: 'Maharashtra' },
    { id: 10, name: 'CGST', group: 'Duties & Taxes', taxType: 'CGST' },
    { id: 11, name: 'SGST', group: 'Duties & Taxes', taxType: 'SGST' },
    { id: 12, name: 'IGST', group: 'Duties & Taxes', taxType: 'IGST' },
    { id: 13, name: 'Cess', group: 'Duties & Taxes', taxType: 'Cess' },
  ]
  return {
    companyGstin: '27AAPFU0939F1ZV',
    companyState: 'Maharashtra',
    ledgers: new Map(ledgers.map((l) => [l.id, l])),
    // an aerated drink: 28% GST and 12% compensation cess
    items: new Map([[100, { id: 100, hsn: '22021010', rate: 2800, cessRate: 1200, unit: 'Nos', uqc: 'NOS' }]]),
  }
}
const sale = (cess: number) => ({
  type: 'Sales' as const, date: '2026-07-01',
  entries: [{ ledgerId: 2, amount: R(1280) + cess }, { ledgerId: 1, amount: -R(1000) }, { ledgerId: 10, amount: -R(140) }, { ledgerId: 11, amount: -R(140) },
    ...(cess ? [{ ledgerId: 13, amount: -cess }] : [])],
  inventory: [{ itemId: 100, godownId: 1, qty: -100000, rate: R(10), amount: -R(1000) }],
})

test('cess on an invoice: worked out per line, suggested on the Cess ledger, a wrong amount flagged', () => {
  const c = ctx()
  const b = gstBreakup(sale(R(120)), c)!
  assert.deepEqual(b.lines.map((l) => [l.cgst, l.sgst, l.cess, l.cessRate]), [[R(140), R(140), R(120), 1200]])
  assert.equal(b.charged.cess, R(120))
  assert.deepEqual(b.problems, [])
  const noTax = sale(0)
  assert.deepEqual(suggestedTaxes({ ...noTax, entries: noTax.entries.filter((e) => e.ledgerId < 10) }, c),
    [{ ledgerId: 10, amount: R(140) }, { ledgerId: 11, amount: R(140) }, { ledgerId: 13, amount: R(120) }])
  assert.deepEqual(gstBreakup(sale(0), c)!.problems, ['The cess charged differs from the cess rate on the items'])
})

test('cess in GSTR-1, its portal file, GSTR-3B and the e-Invoice', () => {
  const c = ctx()
  const v: GstVoucher = { id: 1, type: 'Sales', number: 1, date: '2026-07-01', gst: gstBreakup(sale(R(120)), c)! }
  const purchase: GstVoucher = {
    id: 2, type: 'Purchase', number: 1, date: '2026-07-02',
    gst: gstBreakup({
      type: 'Purchase', date: '2026-07-02',
      entries: [{ ledgerId: 4, amount: -R(640) }, { ledgerId: 3, amount: R(500) }, { ledgerId: 10, amount: R(70) }, { ledgerId: 11, amount: R(70) }, { ledgerId: 13, amount: R(60) }],
      inventory: [{ itemId: 100, godownId: 1, qty: 50000, rate: R(10), amount: R(500) }],
    }, c)!,
  }
  const r1 = gstr1([v, purchase])
  assert.equal(r1.b2b[0].cess, R(120))
  const json = gstr1Json(r1, '27AAPFU0939F1ZV', '072026')
  assert.equal(json.b2b[0].inv[0].itms[0].itm_det.csamt, 120)
  assert.equal(json.hsn.hsn_b2b[0].csamt, 120)
  const r3 = gstr3b([v, purchase])
  assert.deepEqual(r3.cess, { outward: R(120), itc: R(60), reversed: 0, payable: R(120), credit: R(60), cash: R(60), carryForward: 0 })
  assert.equal(r3.outward.cess, R(120))

  const lines = v.gst.lines.map((l) => ({ ...l, description: 'Cola 300 ml', isService: false }))
  const party = { gstin: '27AAPFU0939F1ZV', legalName: 'A', address: 'Line 1\nMumbai', pincode: '400001', stateCode: '27' }
  const e = einvoiceJson({ type: 'Sales', number: 'S1', date: '2026-07-01', seller: party, buyer: party, interstate: false, invoiceValue: R(1400), lines } as never)
  assert.deepEqual([e.ItemList[0].CesAmt, e.ItemList[0].CesRt, e.ItemList[0].TotItemVal, e.ValDtls.CesVal, e.ValDtls.RndOffAmt], [120, 12, 1400, 120, 0])
})

test('GSTR-3B 5.1: interest on tax paid late in cash, late fee per day with its caps', () => {
  const cash = { igst: R(10000), cgst: R(1000), sgst: R(1000), cess: 0 }
  const onTime = gstr3bLate('2026-07', '2026-08-20', cash, false, 0)
  assert.deepEqual([onTime.dueDate, onTime.daysLate, onTime.interest.igst, onTime.lateFee.cgst], ['2026-08-20', 0, 0, 0])
  const late = gstr3bLate('2026-07', '2026-08-30', cash, false, 0)
  // ₹10,000 × 18% × 10/365 = ₹49.32; ₹25 a day each for CGST and SGST
  assert.deepEqual([late.daysLate, late.interest, late.lateFee], [10, { igst: 4932, cgst: 493, sgst: 493, cess: 0 }, { cgst: R(250), sgst: R(250) }])
  assert.deepEqual(gstr3bLate('2026-07', '2026-12-31', cash, false, 0).lateFee, { cgst: R(1000), sgst: R(1000) }) // capped up to ₹1.5 crore turnover
  assert.deepEqual(gstr3bLate('2026-07', '2026-12-31', cash, false, R(3_00_00_000)).lateFee, { cgst: R(2500), sgst: R(2500) })
  assert.deepEqual(gstr3bLate('2026-07', '2026-10-31', cash, true, 0).lateFee, { cgst: R(250), sgst: R(250) }) // a nil return
  assert.equal(gstr3bLate('2026-12', '2027-01-25', cash, true, 0).dueDate, '2027-01-20') // December's falls in January
})

test('an export carries its shipping bill to GSTR-1 (6A) and the e-Invoice; a bad port code is flagged', () => {
  const c = ctx()
  c.ledgers.set(5, { id: 5, name: 'Dubai Buyer', group: 'Sundry Debtors', country: 'United Arab Emirates' })
  const v = (port: string) => ({
    type: 'Sales' as const, date: '2026-07-01', shippingBill: { port, no: '1234567', date: '2026-07-03' },
    entries: [{ ledgerId: 5, amount: R(1000) }, { ledgerId: 1, amount: -R(1000) }],
    inventory: [{ itemId: 100, godownId: 1, qty: -100000, rate: R(10), amount: -R(1000) }],
  })
  const b = gstBreakup(v('innsa1'), c)!
  assert.deepEqual([b.export, b.shippingBill, b.problems], ['WOPAY', { port: 'INNSA1', no: '1234567', date: '2026-07-03' }, []])
  const json = gstr1Json(gstr1([{ id: 1, type: 'Sales', number: 7, date: '2026-07-01', gst: b }]), '27AAPFU0939F1ZV', '072026')
  assert.deepEqual(json.exp[0].inv[0], { inum: '7', idt: '01-07-2026', val: 1000, sbpcode: 'INNSA1', sbnum: '1234567', sbdt: '03-07-2026', itms: [{ txval: 1000, rt: 28, iamt: 0, csamt: 0 }] })
  assert.deepEqual(gstBreakup(v('MUMBAI'), c)!.problems, ['"MUMBAI" is not a port code (six characters, as INNSA1)'])
  const party = { gstin: '27AAPFU0939F1ZV', legalName: 'A', address: 'Line 1\nMumbai', pincode: '400001', stateCode: '27', country: 'United Arab Emirates' }
  const e = einvoiceJson({ type: 'Sales', number: '7', date: '2026-07-01', seller: party, buyer: party, interstate: true, export: 'WOPAY', shippingBill: b.shippingBill,
    invoiceValue: R(1000), lines: b.lines.map((l) => ({ ...l, description: 'Cola', isService: false })) } as never)
  assert.deepEqual([e.ExpDtls?.ShipBNo, e.ExpDtls?.ShipBDt, e.ExpDtls?.Port], ['1234567', '03/07/2026', 'INNSA1'])
})
