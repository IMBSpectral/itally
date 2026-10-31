import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseShortDate } from '../src/engine/dates'

const FY = '2026-04-01'

test('day only: the day in the reference month', () => {
  assert.equal(parseShortDate('14', '2026-10-25', FY), '2026-10-14')
  assert.equal(parseShortDate('1', '2027-02-10', FY), '2027-02-01')
  assert.equal(parseShortDate('31', '2026-11-05', FY), null) // November has 30 days
})

test('day and month: the year that keeps it inside the financial year', () => {
  // reference in Oct 2026 -> FY 2026-27
  assert.equal(parseShortDate('1-4', '2026-10-25', FY), '2026-04-01')
  assert.equal(parseShortDate('15-3', '2026-10-25', FY), '2027-03-15')
  assert.equal(parseShortDate('14-oct', '2026-10-25', FY), '2026-10-14')
  assert.equal(parseShortDate('14 October', '2026-10-25', FY), '2026-10-14')
  // reference in Feb 2027 is still FY 2026-27
  assert.equal(parseShortDate('1/4', '2027-02-10', FY), '2026-04-01')
  assert.equal(parseShortDate('29-2', '2027-02-10', FY), null) // 2027 is not a leap year
  // a calendar-year company (FY starts in January)
  assert.equal(parseShortDate('5-12', '2026-06-01', '2026-01-01'), '2026-12-05')
})

test('full dates in common forms', () => {
  assert.equal(parseShortDate('14.10.26', '2026-04-01', FY), '2026-10-14')
  assert.equal(parseShortDate('14/10/2026', '2026-04-01', FY), '2026-10-14')
  assert.equal(parseShortDate('1-Apr-27', '2026-04-01', FY), '2027-04-01')
  assert.equal(parseShortDate('2026-10-14', '2026-04-01', FY), '2026-10-14')
})

test('rubbish is rejected', () => {
  for (const t of ['', 'abc', '14-13', '14-xyz', '1-2-3-4', '0', '14-10-123', '2026-02-30'])
    assert.equal(parseShortDate(t, '2026-10-25', FY), null, t)
})
