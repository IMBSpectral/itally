import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_GROUPS } from '../src/engine/groups'
import { formatDrCr, formatINR, toPaise } from '../src/engine/money'
import { balanceSheet, profitAndLoss, trialBalance } from '../src/engine/reports'
import { validateVoucher, type VoucherInput } from '../src/engine/voucher'
import { makeCompany } from './fixture'

const R = (rupees: number) => rupees * 100

test('money: parse and Indian formatting', () => {
  assert.equal(toPaise('1,23,456.78'), 12345678)
  assert.equal(toPaise('1234.5'), 123450)
  assert.equal(toPaise(10), 1000)
  assert.equal(toPaise('-0'), 0)
  assert.throws(() => toPaise('1.234'))
  assert.throws(() => toPaise('abc'))
  assert.equal(formatINR(123456789), '12,34,567.89')
  assert.equal(formatINR(50000), '500.00')
  assert.equal(formatDrCr(-50000), '500.00 Cr')
  assert.equal(formatDrCr(0), '')
})

test('default chart: 15 primary + 13 sub-groups, every parent exists', () => {
  assert.equal(DEFAULT_GROUPS.length, 28)
  assert.equal(DEFAULT_GROUPS.filter((g) => g.parent === null).length, 15)
  const names = new Set(DEFAULT_GROUPS.map((g) => g.name))
  for (const g of DEFAULT_GROUPS) if (g.parent) assert.ok(names.has(g.parent), g.name)
})

function sampleCompany() {
  const c = makeCompany()
  c.ledger('Cash', 'Cash-in-Hand', R(100000))
  c.ledger('HDFC Bank', 'Bank Accounts')
  c.ledger('Opening Stock', 'Stock-in-Hand', R(20000))
  c.ledger('Proprietor Capital', 'Capital Account', -R(120000))
  c.ledger('Purchases', 'Purchase Accounts')
  c.ledger('Sales', 'Sales Accounts')
  c.ledger('Rent', 'Indirect Expenses')
  c.ledger('Interest Received', 'Indirect Incomes')
  c.ledger('Acme Suppliers', 'Sundry Creditors')
  c.ledger('Bharat Traders', 'Sundry Debtors')
  c.ledger('Profit & Loss A/c', null)
  return c
}

test('validation: balanced vouchers of each type pass', () => {
  const c = sampleCompany()
  const ctx = { ledgers: c.ledgers, groups: c.groups, booksBeginFrom: '2026-04-01' }
  const ok: VoucherInput[] = [
    { type: 'Purchase', date: '2026-04-05', entries: [{ ledgerId: c.id('Purchases'), amount: R(50000) }, { ledgerId: c.id('Acme Suppliers'), amount: -R(50000) }] },
    { type: 'Sales', date: '2026-04-10', entries: [{ ledgerId: c.id('Bharat Traders'), amount: R(80000) }, { ledgerId: c.id('Sales'), amount: -R(80000) }] },
    { type: 'Payment', date: '2026-04-30', entries: [{ ledgerId: c.id('Rent'), amount: R(5000) }, { ledgerId: c.id('Cash'), amount: -R(5000) }] },
    { type: 'Receipt', date: '2026-05-02', entries: [{ ledgerId: c.id('Cash'), amount: R(30000) }, { ledgerId: c.id('Bharat Traders'), amount: -R(30000) }] },
    { type: 'Contra', date: '2026-05-03', entries: [{ ledgerId: c.id('HDFC Bank'), amount: R(10000) }, { ledgerId: c.id('Cash'), amount: -R(10000) }] },
    { type: 'Journal', date: '2026-05-04', entries: [{ ledgerId: c.id('Rent'), amount: R(1) }, { ledgerId: c.id('Acme Suppliers'), amount: -R(1) }] },
  ]
  for (const v of ok) assert.deepEqual(validateVoucher(v, ctx), [], v.type)
})

test('validation: rejects unbalanced, one-sided, bad dates and type-rule breaks', () => {
  const c = sampleCompany()
  const ctx = { ledgers: c.ledgers, groups: c.groups, booksBeginFrom: '2026-04-01' }
  const v = (type: VoucherInput['type'], entries: [string, number][], date = '2026-04-10'): VoucherInput => ({
    type,
    date,
    entries: entries.map(([n, a]) => ({ ledgerId: c.id(n), amount: a })),
  })
  const has = (errs: string[], re: RegExp) => assert.ok(errs.some((e) => re.test(e)), errs.join(' | '))

  has(validateVoucher(v('Journal', [['Rent', 500], ['Acme Suppliers', -400]]), ctx), /totals differ by 1/)
  has(validateVoucher(v('Journal', [['Rent', 500], ['Acme Suppliers', 500]]), ctx), /one Debit and one Credit/)
  has(validateVoucher(v('Journal', [['Rent', 500]]), ctx), /at least two/)
  has(validateVoucher(v('Journal', [['Rent', 0], ['Acme Suppliers', 0]]), ctx), /non-zero/)
  has(validateVoucher(v('Journal', [['Rent', 1.5], ['Acme Suppliers', -1.5]]), ctx), /whole number/)
  has(validateVoucher(v('Payment', [['Rent', 500], ['Cash', -500]], '2026-03-31'), ctx), /before books beginning/)
  has(validateVoucher(v('Payment', [['Rent', 500], ['Cash', -500]], '2026-02-30'), ctx), /Invalid date/)
  has(validateVoucher(v('Contra', [['Rent', 500], ['Cash', -500]]), ctx), /only use Cash and Bank/)
  has(validateVoucher(v('Payment', [['Cash', 500], ['Rent', -500]]), ctx), /credited to a Cash or Bank/)
  has(validateVoucher(v('Receipt', [['Rent', 500], ['Cash', -500]]), ctx), /debited to a Cash or Bank/)
  has(validateVoucher(v('Journal', [['Rent', 500], ['Cash', -500]]), ctx), /cannot use Cash or Bank/)
  has(validateVoucher(v('Sales', [['Bharat Traders', 500], ['Interest Received', -500]]), ctx), /Sales Accounts/)
  has(validateVoucher(v('Purchase', [['Rent', 500], ['Acme Suppliers', -500]]), ctx), /Purchase Accounts/)
  has(validateVoucher(v('Journal', [['Opening Stock', 500], ['Acme Suppliers', -500]]), ctx), /stock valuation/)
  has(
    validateVoucher({ type: 'Journal', date: '2026-04-10', entries: [{ ledgerId: 999, amount: 1 }, { ledgerId: c.id('Rent'), amount: -1 }] }, ctx),
    /unknown ledger 999/,
  )
})

test('reports: trial balance, P&L and balance sheet agree on a worked example', () => {
  const c = sampleCompany()
  const e = (n: string, a: number) => ({ ledgerId: c.id(n), amount: R(a) })
  c.post({ type: 'Purchase', date: '2026-04-05', entries: [e('Purchases', 50000), e('Acme Suppliers', -50000)] })
  c.post({ type: 'Sales', date: '2026-04-10', entries: [e('Bharat Traders', 80000), e('Sales', -80000)] })
  c.post({ type: 'Payment', date: '2026-04-30', entries: [e('Rent', 5000), e('Cash', -5000)] })
  c.post({ type: 'Receipt', date: '2026-05-02', entries: [e('Cash', 30000), e('Bharat Traders', -30000)] })
  c.post({ type: 'Receipt', date: '2026-05-03', entries: [e('Cash', 1000), e('Interest Received', -1000)] })
  c.setStockValue('Opening Stock', R(25000))

  const tb = trialBalance(c.groups, c.balances())
  assert.equal(tb.totalDr, R(251000))
  assert.equal(tb.totalCr, R(251000))
  assert.equal(tb.openingDifference, 0)
  assert.equal(tb.rows.find((r) => r.name === 'Current Assets')!.closing, R(126000 + 50000 + 20000))

  const pl = profitAndLoss(c.groups, c.balances())
  assert.equal(pl.openingStock, R(20000))
  assert.equal(pl.closingStock, R(25000))
  assert.equal(pl.grossProfit, R(80000 + 25000 - 20000 - 50000))
  assert.equal(pl.netProfit, R(31000))

  const bs = balanceSheet(c.groups, c.balances())
  assert.equal(bs.totalAssets, R(201000))
  assert.equal(bs.totalLiabilities, R(201000))
  assert.equal(bs.profitAndLoss.currentPeriod, R(31000))
  assert.deepEqual(
    bs.assets.map((s) => [s.name, s.amount]),
    [['Current Assets', R(126000 + 50000 + 25000)]],
  )
})

test('reports: unequal opening balances show as a difference that still balances the sheet', () => {
  const c = makeCompany()
  c.ledger('Cash', 'Cash-in-Hand', R(1000)) // no matching credit
  c.ledger('Profit & Loss A/c', null)
  const tb = trialBalance(c.groups, c.balances())
  assert.equal(tb.openingDifference, R(1000))
  assert.equal(tb.totalDr - tb.totalCr, tb.openingDifference) // the TB is off by exactly the difference
  const bs = balanceSheet(c.groups, c.balances())
  assert.equal(bs.openingDifference, R(1000))
  assert.equal(bs.totalLiabilities, bs.totalAssets)
})
