import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'
import { oldRegimeDeductions } from '../src/engine/payroll'

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

test('the old regime: the HRA exemption and Chapter VI-A within their limits', () => {
  const d = { rentPaid: R(300000), metro: false, sec80c: R(200000), sec80d: R(30000), sec80ccd1b: R(50000), sec24b: R(250000), other: 0 }
  // the least of HRA ₹2,40,000, rent less 10% of Basic ₹2,40,000 and 40% of Basic ₹2,40,000
  assert.deepEqual(oldRegimeDeductions(d, R(600000), R(240000)), { hraExempt: R(240000), chapterVIA: R(150000 + 30000 + 50000), homeLoan: R(200000), total: R(670000) })
  assert.equal(oldRegimeDeductions({ ...d, rentPaid: R(50000) }, R(600000), R(240000)).hraExempt, 0) // rent below 10% of Basic
  assert.equal(oldRegimeDeductions({ ...d, metro: true, rentPaid: R(500000) }, R(600000), R(400000)).hraExempt, R(300000)) // 50% of Basic in a metro
})

test('payroll: loans recovered in instalments, arrears of a back-dated revision, declarations, statutory dues', async () => {
  const c = await call('POST', '/companies', { name: `Payroll more ${Date.now()}`, booksBegin: '2026-04-01' })
  const at = (p: string) => `/companies/${c.id}${p}`
  await call('PUT', at('/features'), { payroll: true })
  const groups: { id: number; name: string }[] = await call('GET', at('/groups'))
  const g = (n: string) => groups.find((x) => x.name === n)!.id
  const ledger = async (name: string, group: string, extra = {}) => (await call('POST', at('/ledgers'), { name, groupId: g(group), ...extra })).id as number
  const head = async (name: string, group: string, body: Record<string, unknown>) => (await call('POST', at('/pay-heads'), { name, groupId: g(group), ...body })).id as number
  const pct = (r: number) => [{ upTo: null, rate: Math.round(r * 100), value: 0 }]
  const basic = await head('Basic', 'Indirect Expenses', { payType: 'Earnings for Employees', calculation: 'flat', taxComponent: 'basic' })
  const hra = await head('HRA', 'Indirect Expenses', { payType: 'Earnings for Employees', calculation: 'computed', formula: [{ payHeadId: basic, sign: 1 }], slabs: pct(40), taxComponent: 'hra' })
  const arrearsHead = await head('Salary Arrears', 'Indirect Expenses', { payType: 'Earnings for Employees', calculation: 'user' })
  const pfExpense = await ledger("Employer's PF", 'Indirect Expenses', { costCentres: true })
  const pf = await head('PF Employee', 'Current Liabilities', { payType: "Employees' Statutory Deductions", statutory: 'pf', calculation: 'computed', formula: [{ payHeadId: basic, sign: 1 }], slabs: pct(12) })
  await head('EPF Employer', 'Current Liabilities', {
    payType: "Employer's Statutory Contributions", statutory: 'epf-employer', calculation: 'computed', formula: [{ payHeadId: basic, sign: 1 }], slabs: pct(12), expenseLedgerId: pfExpense,
  })
  const tax = await head('Income Tax', 'Current Liabilities', { payType: "Employees' Statutory Deductions", statutory: 'income-tax', calculation: 'computed' })
  const loanHead = await head('Loan Recovery', 'Loans & Advances (Asset)', { payType: 'Loans and Advances', calculation: 'user' })
  const payable = await ledger('Salary Payable', 'Current Liabilities', { costCentres: true })
  const bank = await ledger('Bank', 'Bank Accounts')
  const meera = (await call('POST', at('/employees'), { name: 'Meera', dateOfJoining: '2025-04-01', uan: '100200300500', taxRegime: 'old' })).id
  const epfHead = (await call('GET', at('/payroll'))).payHeads.find((h: { name: string }) => h.name === 'EPF Employer').id
  const lines = [basic, hra, pf, epfHead, tax].map((payHeadId) => ({ payHeadId, rate: payHeadId === basic ? R(50000) : null }))
  await call('PUT', at(`/salary/${meera}`), { effectiveFrom: '2026-04-01', lines })

  // a loan of ₹30,000 given in April, ₹12,000 a month from May
  assert.equal((await raw('POST', at('/payroll/loans'), { employeeId: meera, payHeadId: basic, givenOn: '2026-04-05', amount: R(30000), instalment: R(12000), recoverFrom: '2026-05-01' })).status, 422)
  await call('POST', at('/payroll/loans'), { employeeId: meera, payHeadId: loanHead, givenOn: '2026-04-05', amount: R(30000), instalment: R(12000), recoverFrom: '2026-05-01' })

  const run = async (month: string, extra: object = {}) => {
    const to = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10)
    const fill = await call('POST', at('/payroll/fill'), { from: `${month}-01`, to, date: to, payableLedgerId: payable, ...extra })
    const e = fill.employees[0]
    assert.deepEqual(e.errors, [])
    await call('POST', at('/vouchers'), { type: 'Payroll', date: to, entries: fill.entries })
    return (h: number) => e.lines.find((l: { payHeadId: number }) => l.payHeadId === h)?.amount ?? 0
  }
  const april = await run('2026-04')
  assert.deepEqual([april(basic), april(hra), april(loanHead)], [R(50000), R(20000), 0])
  const taxNoDeclarations = april(tax)
  assert.ok(taxNoDeclarations > 0)

  // the dues to pay for April's PF, and the PF challan's accounts
  const q = '?from=2026-04-01&to=2026-04-30'
  const dues = await call('GET', at(`/reports/statutory-dues${q}&kind=pf`))
  assert.deepEqual([dues.total, dues.challan.ac1, dues.dueDate], [R(12000), R(12000), '2026-05-15'])
  await call('POST', at('/vouchers'), { type: 'Payment', date: '2026-05-10', entries: [...dues.lines.map((l: { ledgerId: number; due: number }) => ({ ledgerId: l.ledgerId, amount: l.due })), { ledgerId: bank, amount: -dues.total }] })
  assert.equal((await call('GET', at(`/reports/statutory-dues${q}&kind=pf`))).total, 0)

  // declarations for the year cut the tax under the old regime
  await call('PUT', at(`/employees/${meera}/declarations?fy=2026-04-01`), { rentPaid: R(240000), sec80c: R(150000), sec80d: R(25000) })
  assert.deepEqual((await call('GET', at(`/employees/${meera}/declarations?fy=2026-04-01`))).sec80c, R(150000))
  const may = await run('2026-05')
  assert.equal(may(loanHead), R(12000))
  assert.ok(may(tax) < taxNoDeclarations, `${may(tax)} < ${taxNoDeclarations}`)

  // a raise to ₹55,000 from April, decided in June: the arrears of April and May come with June's pay
  await call('PUT', at(`/salary/${meera}`), { effectiveFrom: '2026-04-01', lines: lines.map((l) => (l.payHeadId === basic ? { ...l, rate: R(55000) } : l)) })
  const arrears = await call('GET', at(`/reports/payroll-arrears?from=2026-04-01&to=2026-05-31&payHead=${arrearsHead}`))
  assert.deepEqual(arrears.rows.map((r: { month: string; arrears: number }) => [r.month, r.arrears]), [['2026-04', R(7000)], ['2026-05', R(7000)]])
  const june = await run('2026-06', { arrears: { payHeadId: arrearsHead, from: '2026-04-01', to: '2026-05-31' } })
  assert.deepEqual([june(basic), june(arrearsHead), june(loanHead)], [R(55000), R(14000), R(12000)])
  // paid: nothing more is due for those months
  assert.equal((await call('GET', at(`/reports/payroll-arrears?from=2026-04-01&to=2026-05-31&payHead=${arrearsHead}`))).total, 0)

  // July recovers what is left of the loan, and then it is repaid
  const july = await run('2026-07')
  assert.equal(july(loanHead), R(6000))
  const loans = await call('GET', at('/payroll/loans'))
  assert.deepEqual(loans.map((l: { recovered: number; outstanding: number }) => [l.recovered, l.outstanding]), [[R(30000), 0]])
  assert.equal((await run('2026-08'))(loanHead), 0)
})
