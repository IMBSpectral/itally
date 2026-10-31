import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gstBreakup, gstinError, stateCode, suggestedTaxes, taxOn, type GstContext, type GstLedger } from '../src/engine/gst'

const R = (rupees: number) => Math.round(rupees * 100)

test('GSTIN format, state code and check digit', () => {
  assert.equal(gstinError('27AAPFU0939F1ZV'), null)
  assert.equal(gstinError('29aagcb7383j1z4'), null) // case does not matter
  assert.match(gstinError('27AAPFU0939F1ZW')!, /check digit/)
  assert.match(gstinError('99AAPFU0939F1ZV')!, /state code/)
  assert.match(gstinError('27AAPFU0939F1Z')!, /format/)
  assert.equal(stateCode('Maharashtra'), '27')
  assert.equal(stateCode('andaman and nicobar islands'), '35')
  assert.equal(stateCode('29'), '29')
  assert.equal(stateCode('Atlantis'), undefined)
})

test('tax on a value: IGST across states, half CGST and half SGST within', () => {
  assert.deepEqual(taxOn(R(1000), 1800, true), { igst: R(180), cgst: 0, sgst: 0 })
  assert.deepEqual(taxOn(R(1000), 1800, false), { igst: 0, cgst: R(90), sgst: R(90) })
  assert.deepEqual(taxOn(R(333.33), 500, false), { igst: 0, cgst: 833, sgst: 833 }) // 8.33 each, rounded to the paisa
})

function ctx(): GstContext {
  const ledgers: GstLedger[] = [
    { id: 1, name: 'Sales', group: 'Sales Accounts', rate: 1800, hsn: '998314' },
    { id: 2, name: 'Mumbai Traders', group: 'Sundry Debtors', gstin: '27AAPFU0939F1ZV', state: 'Maharashtra' },
    { id: 3, name: 'Bengaluru Co', group: 'Sundry Debtors', gstin: '29AAGCB7383J1Z4' },
    { id: 4, name: 'Walk-in', group: 'Cash-in-Hand' },
    { id: 10, name: 'CGST', group: 'Duties & Taxes', taxType: 'CGST' },
    { id: 11, name: 'SGST', group: 'Duties & Taxes', taxType: 'SGST' },
    { id: 12, name: 'IGST', group: 'Duties & Taxes', taxType: 'IGST' },
    { id: 20, name: 'Goods Sales', group: 'Sales Accounts' },
  ]
  return {
    companyGstin: '27AAPFU0939F1ZV',
    companyState: 'Maharashtra',
    ledgers: new Map(ledgers.map((l) => [l.id, l])),
    items: new Map([[100, { id: 100, hsn: '1006', rate: 500, unit: 'Kg' }]]),
  }
}

test('a services invoice within the state: CGST + SGST, nothing to fix', () => {
  const b = gstBreakup(
    { type: 'Sales', date: '2026-07-01', entries: [{ ledgerId: 2, amount: R(1180) }, { ledgerId: 1, amount: -R(1000) }, { ledgerId: 10, amount: -R(90) }, { ledgerId: 11, amount: -R(90) }] },
    ctx(),
  )!
  assert.equal(b.interstate, false)
  assert.equal(b.pos, '27')
  assert.deepEqual(b.lines, [{ hsn: '998314', rate: 1800, uqc: 'OTH', qty: 0, taxable: R(1000), igst: 0, cgst: R(90), sgst: R(90) }])
  assert.deepEqual(b.charged, { igst: 0, cgst: R(90), sgst: R(90), cess: 0 })
  assert.deepEqual(b.problems, [])
  assert.equal(b.invoiceValue, R(1180))
})

test('an item invoice to another state: IGST, place of supply from the GSTIN, wrong tax flagged', () => {
  const c = ctx()
  const v = {
    type: 'Sales' as const,
    date: '2026-07-01',
    entries: [{ ledgerId: 3, amount: R(2100) }, { ledgerId: 20, amount: -R(2000) }, { ledgerId: 10, amount: -R(50) }, { ledgerId: 11, amount: -R(50) }],
    inventory: [{ itemId: 100, godownId: 1, qty: -40000, rate: R(50), amount: -R(2000) }],
  }
  const b = gstBreakup(v, c)!
  assert.equal(b.pos, '29')
  assert.equal(b.interstate, true)
  assert.deepEqual(b.lines.map((l) => [l.hsn, l.qty, l.taxable, l.igst]), [['1006', 40000, R(2000), R(100)]])
  assert.match(b.problems.join(), /should be IGST/)
  // what the invoice screen would put in instead
  assert.deepEqual(suggestedTaxes(v, c), [{ ledgerId: 12, amount: R(100) }])
})

test('no GST without a company GSTIN, or on vouchers that are not invoices', () => {
  const c = ctx()
  const sale = { type: 'Sales' as const, date: '2026-07-01', entries: [{ ledgerId: 4, amount: R(100) }, { ledgerId: 1, amount: -R(100) }] }
  assert.equal(gstBreakup(sale, { ...c, companyGstin: null }), null)
  assert.equal(gstBreakup({ ...sale, type: 'Receipt' }, c), null)
  const cash = gstBreakup(sale, c)! // a cash sale: the place of supply is the company's own state
  assert.deepEqual([cash.party, cash.gstin, cash.pos, cash.interstate], ['Walk-in', null, '27', false])
  assert.match(cash.problems.join(), /differs/) // 18% was due, none charged
})
