import { test } from 'node:test'
import assert from 'node:assert/strict'
import { act2025, dueThroughYear, returnSheet, type TdsNature } from '../src/engine/tds'

const R = (rupees: number) => Math.round(rupees * 100)
const professional: TdsNature = { id: 1, name: 'Professional fees', kind: 'TDS', section: '194J', collectionCode: null, rateIndividual: 1000, rateOther: 1000, rateNoPan: 2000,
  thresholdSingle: null, thresholdAnnual: null, excessOnly: false }
const line = (date: string, amount: number) => ({ voucherId: 1, date, partyId: 9, natureId: 1, amount: R(amount), deducted: 0 })

test('a section 197 certificate: its rate up to the amount it covers and within its dates, the normal rate after', () => {
  const cert = { kind: 'certificate' as const, rate: 200, certificateNo: 'LDC123456', validFrom: '2026-04-01', validTo: '2026-12-31', limit: R(100000) }
  const due = dueThroughYear(professional, 'Company', true, [line('2026-05-01', 60000), line('2026-06-01', 60000), line('2027-01-15', 10000)], [cert])
  // ₹60,000 at 2%; then ₹40,000 at 2% and ₹20,000 at 10%; after the certificate ends, 10%
  assert.deepEqual(due.map((d) => [d.due, d.rate, d.special ?? null, d.certificateNo ?? null]),
    [[R(1200), 200, 'certificate', 'LDC123456'], [R(800 + 2000), 200, 'certificate', 'LDC123456'], [R(1000), 1000, null, null]])
  // a nil certificate
  assert.equal(dueThroughYear(professional, 'Company', true, [line('2026-05-01', 50000)], [{ ...cert, rate: 0 }])[0].due, 0)
})

test('a treaty (DTAA) rate on all of it; the return sheet carries the reason and the certificate', () => {
  const dtaa = { kind: 'dtaa' as const, rate: 1000, certificateNo: null, validFrom: '2026-04-01', validTo: '2027-03-31', limit: null }
  const due = dueThroughYear({ ...professional, rateOther: 2000 }, 'Company', true, [line('2026-05-01', 500000)], [dtaa])
  assert.deepEqual([due[0].due, due[0].special], [R(50000), 'dtaa'])
  const deduction = { deducteeCode: '01', pan: 'AAACL1234C', name: 'L Co', section: '194J', collectionCode: null, country: 'USA', date: '2026-05-01', amount: R(500000), tds: R(50000),
    rate: 1000, challan: null }
  const s27 = returnSheet({ form: '27Q', deductions: [{ ...deduction, special: 'dtaa' }] })
  assert.deepEqual(s27.head.slice(-3), ['Reason for lower/higher deduction', 'Certificate number', 'Rate as per (IT Act / DTAA)'])
  assert.deepEqual(s27.rows[0].slice(-3), ['', '', 'DTAA'])
  const s26 = returnSheet({ form: '26Q', deductions: [{ ...deduction, country: null, reason: 'A', certificateNo: 'LDC123456', special: 'certificate' }] })
  assert.deepEqual(s26.rows[0].slice(-2), ['A', 'LDC123456'])
})

test('the Income-tax Act 2025: the section and payment code of each nature, on returns from tax year 2026-27', () => {
  assert.deepEqual(act2025({ section: '194C' }, '02'), { section: '393(1) Sl. 6(i).D(a)', code: '1023' })
  assert.deepEqual(act2025({ section: '194C' }, '01'), { section: '393(1) Sl. 6(i).D(b)', code: '1024' })
  assert.equal(act2025({ section: '194J', name: 'Fees for Technical Services' })?.code, '1026')
  assert.equal(act2025({ section: '194J', name: 'Fees for Professional Services' })?.code, '1027')
  assert.equal(act2025({ section: '194I', name: 'Rent - Plant and Machinery' })?.code, '1008')
  assert.equal(act2025({ section: '206C(1)', collectionCode: 'E' })?.code, '1073')
  const d = { deducteeCode: '01', pan: 'AAACL1234C', name: 'L Co', section: '194C', collectionCode: null, country: null, date: '2026-05-01', amount: R(100000), tds: R(2000),
    rate: 200, challan: null, nature: 'Payment to Contractors' }
  const later = returnSheet({ form: '26Q', fyStart: '2026-04-01', deductions: [d] })
  assert.deepEqual([later.head.slice(-2), later.rows[0].slice(-2)], [['Section (Income-tax Act 2025)', 'Payment code'], ['393(1) Sl. 6(i).D(b)', '1024']])
  assert.equal(returnSheet({ form: '26Q', fyStart: '2025-04-01', deductions: [d] }).head.includes('Payment code'), false)
})
