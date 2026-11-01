import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'
import { backupCompany, restoreCompany } from '../src/backup'
import { computePay, gratuity, incomeTax, monthsLeftInYear, round, salaryTax, slabAmount } from '../src/engine/payroll'

let server: Server
let base = ''
before(async () => {
  await migrate(() => {})
  server = createApp().listen(0)
  base = `http://localhost:${(server.address() as AddressInfo).port}/api`
})
after(async () => {
  // close every connection before the pool, so no request is left running against a closed pool
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
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

test('the engine: tax on salary, slabs, rounding, gratuity', () => {
  assert.equal(incomeTax(1624200, 'new'), 129834)
  assert.equal(incomeTax(1200000, 'new'), 0) // the 87A rebate
  assert.equal(incomeTax(1210000, 'new'), 10400) // marginal relief: no more tax than the income above ₹12 lakh
  assert.equal(incomeTax(500000, 'old'), 0)
  assert.equal(incomeTax(600000, 'old'), 33800)
  assert.equal(salaryTax({ regime: 'new', ytdTaxable: 0, ytdTax: 0, monthsLeft: 12 }, R(141600)).month, R(10820))
  assert.equal(slabAmount(R(30000), [{ upTo: R(24999), rate: 0, value: 0 }, { upTo: null, rate: 0, value: R(200) }]), R(200))
  assert.equal(slabAmount(R(20000), [{ upTo: R(24999), rate: 0, value: 0 }, { upTo: null, rate: 0, value: R(200) }]), 0)
  assert.equal(round(9601, 'up', 100), 9700)
  assert.equal(round(124950, 'normal', 100), 125000)
  assert.equal(round(124950, 'down', 100), 124900)
  assert.deepEqual(gratuity('2020-04-01', '2026-04-30', R(100000)), { years: 6, eligible: true, amount: R(346154) })
  assert.deepEqual(gratuity('2022-04-01', '2026-11-15', R(26000)), { years: 5, eligible: false, amount: R(75000) }) // 4 years 7 months counts as 5, but not yet due
  assert.equal(monthsLeftInYear('2026-04-01'), 12)
  assert.equal(monthsLeftInYear('2027-03-01'), 1)
  // a computed head that names itself through another is caught
  const heads = new Map([
    [1, { id: 1, name: 'A', payType: 'Earnings for Employees', statutory: null, calculation: 'computed', attendanceTypeId: null, perDayDays: null, formula: [{ payHeadId: 2, sign: 1 }], ceiling: null, slabs: [{ upTo: null, rate: 10000, value: 0 }], rounding: 'normal', roundTo: 100 }],
    [2, { id: 2, name: 'B', payType: 'Earnings for Employees', statutory: null, calculation: 'computed', attendanceTypeId: null, perDayDays: null, formula: [{ payHeadId: 1, sign: 1 }], ceiling: null, slabs: [{ upTo: null, rate: 10000, value: 0 }], rounding: 'normal', roundTo: 100 }],
  ] as const)
  const pay = computePay(new Map(heads as never), new Map(), {
    id: 9, joining: '2026-01-01', leaving: null, regime: 'new', salary: [{ payHeadId: 1, rate: null }, { payHeadId: 2, rate: null }], attendance: new Map(), ytdTaxable: 0, ytdTax: 0, monthsLeft: 12,
  }, '2026-04-01', '2026-04-30')
  assert.match(pay.errors.join(), /computed on itself/)
})

test('payroll: masters, attendance, auto-fill, the voucher, the reports and a backup', async () => {
  const c = await call('POST', '/companies', { name: `Payroll ${Date.now()}`, booksBegin: '2026-04-01' })
  const at = (p: string) => `/companies/${c.id}${p}`
  await call('PUT', at('/features'), { payroll: true })
  const groups: { id: number; name: string }[] = await call('GET', at('/groups'))
  const g = (n: string) => groups.find((x) => x.name === n)!.id
  const ledger = async (name: string, group: string, extra = {}) => (await call('POST', at('/ledgers'), { name, groupId: g(group), ...extra })).id as number

  const present = (await call('POST', at('/attendance-types'), { name: 'Present', kind: 'attendance' })).id
  const lwp = (await call('POST', at('/attendance-types'), { name: 'Leave without pay', kind: 'leave without pay' })).id
  const pieces = (await call('POST', at('/attendance-types'), { name: 'Pieces', kind: 'production', unit: 'Nos' })).id
  assert.ok(present)

  const head = async (name: string, group: string, body: Record<string, unknown>) => (await call('POST', at('/pay-heads'), { name, groupId: g(group), ...body })).id as number
  const pct = (r: number) => [{ upTo: null, rate: Math.round(r * 100), value: 0 }]
  const basic = await head('Basic', 'Indirect Expenses', { payType: 'Earnings for Employees', calculation: 'attendance', attendanceTypeId: lwp })
  const hra = await head('HRA', 'Indirect Expenses', { payType: 'Earnings for Employees', calculation: 'computed', formula: [{ payHeadId: basic, sign: 1 }], slabs: pct(40) })
  const piece = await head('Piece Rate', 'Indirect Expenses', { payType: 'Earnings for Employees', calculation: 'production', attendanceTypeId: pieces })
  const conv = await head('Conveyance', 'Indirect Expenses', { payType: 'Earnings for Employees', calculation: 'flat' })
  const pfExpense = await ledger("Employer's PF Contribution", 'Indirect Expenses', { costCentres: true })
  const pf = await head('PF Employee', 'Current Liabilities', { payType: "Employees' Statutory Deductions", statutory: 'pf', calculation: 'computed', formula: [{ payHeadId: basic, sign: 1 }], slabs: pct(12) })
  const eps = await head('EPS Employer', 'Current Liabilities', {
    payType: "Employer's Statutory Contributions", statutory: 'eps', calculation: 'computed', formula: [{ payHeadId: basic, sign: 1 }], ceiling: R(15000), slabs: pct(8.33), expenseLedgerId: pfExpense,
  })
  const epf = await head('EPF Employer', 'Current Liabilities', {
    payType: "Employer's Statutory Contributions", statutory: 'epf-employer', calculation: 'computed', formula: [{ payHeadId: basic, sign: 1 }], slabs: pct(12), expenseLedgerId: pfExpense,
  })
  const esi = await head('ESI Employee', 'Current Liabilities', {
    payType: "Employees' Statutory Deductions", statutory: 'esi', calculation: 'computed', ceiling: R(21000), rounding: 'up',
    formula: [{ payHeadId: basic, sign: 1 }, { payHeadId: hra, sign: 1 }, { payHeadId: conv, sign: 1 }], slabs: pct(0.75),
  })
  const pt = await head('Professional Tax', 'Current Liabilities', {
    payType: "Employees' Statutory Deductions", statutory: 'pt', calculation: 'computed',
    formula: [basic, hra, piece, conv].map((payHeadId) => ({ payHeadId, sign: 1 })), slabs: [{ upTo: R(24999), rate: 0, value: 0 }, { upTo: null, rate: 0, value: R(200) }],
  })
  const tax = await head('Income Tax', 'Current Liabilities', { payType: "Employees' Statutory Deductions", statutory: 'income-tax', calculation: 'computed' })
  await head('Gratuity', 'Current Liabilities', { payType: 'Gratuity', calculation: 'user', formula: [{ payHeadId: basic, sign: 1 }] })
  const payable = await ledger('Salary Payable', 'Current Liabilities', { costCentres: true })

  // the rules a pay head keeps
  const bad = await raw('POST', at('/pay-heads'), { name: 'X', groupId: g('Current Liabilities'), payType: "Employer's Statutory Contributions", calculation: 'computed', formula: [{ payHeadId: basic, sign: 1 }], slabs: pct(1) })
  assert.equal(bad.status, 422)
  assert.match(bad.body.errors.join(), /expense ledger/)
  assert.equal((await raw('POST', at('/pay-heads'), { name: 'Y', groupId: g('Indirect Expenses'), payType: 'Earnings for Employees', calculation: 'production', attendanceTypeId: present })).status, 422)

  const staff = (await call('POST', at('/employee-groups'), { name: 'Staff' })).id
  const asha = (await call('POST', at('/employees'), { name: 'Asha', groupId: staff, dateOfJoining: '2020-04-01', pan: 'ABCPA1234K', uan: '100200300400', taxRegime: 'new' })).id
  const ravi = (await call('POST', at('/employees'), { name: 'Ravi', groupId: staff, dateOfJoining: '2026-04-10', uan: '100200300401', esiNumber: '1234567890' })).id
  assert.equal((await raw('POST', at('/employees'), { name: 'Bad', dateOfJoining: '2026-04-01', uan: '12' })).status, 422)
  assert.equal((await raw('POST', at('/employees'), { name: 'Odd', groupId: asha, dateOfJoining: '2026-04-01' })).status, 422) // not under an employee

  // the group's structure, and Asha's own
  const structure = (b: number, extra: { payHeadId: number; rate: number | null }[] = []) => [
    { payHeadId: basic, rate: R(b) }, { payHeadId: hra, rate: null }, { payHeadId: conv, rate: R(1600) }, ...extra,
    { payHeadId: pf, rate: null }, { payHeadId: eps, rate: null }, { payHeadId: epf, rate: null }, { payHeadId: esi, rate: null }, { payHeadId: pt, rate: null }, { payHeadId: tax, rate: null },
  ]
  await call('PUT', at(`/salary/${staff}`), { effectiveFrom: '2026-04-01', lines: structure(12000, [{ payHeadId: piece, rate: R(5) }]) })
  await call('PUT', at(`/salary/${asha}`), { effectiveFrom: '2026-04-01', lines: structure(100000) })

  // attendance: Ravi was away a day and made 100 pieces
  const bad2 = await raw('POST', at('/vouchers'), { type: 'Attendance', date: '2026-04-30', entries: [], attendance: [{ employeeId: ravi, typeId: lwp, value: 1000 }, { employeeId: ravi, typeId: lwp, value: 1000 }] })
  assert.equal(bad2.status, 422)
  const att = await call('POST', at('/vouchers'), { type: 'Attendance', date: '2026-04-30', entries: [], attendance: [{ employeeId: ravi, typeId: lwp, value: 1000 }, { employeeId: ravi, typeId: pieces, value: 100000 }] })
  assert.deepEqual((await call('GET', at(`/vouchers/${att.id}`))).attendance.map((a: { value: number }) => a.value), [1000, 100000])

  // auto-fill April
  const fill = await call('POST', at('/payroll/fill'), { from: '2026-04-01', to: '2026-04-30', date: '2026-04-30', payableLedgerId: payable })
  const pay = (id: number) => fill.employees.find((e: { id: number }) => e.id === id)
  const lineOf = (id: number, h: number) => pay(id).lines.find((l: { payHeadId: number }) => l.payHeadId === h)?.amount ?? 0
  assert.deepEqual(pay(asha).errors, [])
  assert.equal(lineOf(asha, basic), R(100000))
  assert.equal(lineOf(asha, hra), R(40000))
  assert.equal(lineOf(asha, pf), R(12000))
  assert.equal(lineOf(asha, eps), R(1250)) // 8.33% of the ₹15,000 ceiling
  assert.equal(lineOf(asha, epf), R(10750))
  assert.equal(lineOf(asha, esi), 0) // above the ESI wage limit
  assert.equal(lineOf(asha, pt), R(200))
  assert.equal(lineOf(asha, tax), R(10820))
  assert.equal(pay(asha).net, R(118580))
  assert.equal(lineOf(ravi, basic), R(8000)) // 21 days on the rolls less a day's leave without pay, of 30
  assert.equal(lineOf(ravi, hra), R(3200))
  assert.equal(lineOf(ravi, piece), R(500))
  assert.equal(lineOf(ravi, esi), R(96))
  assert.equal(lineOf(ravi, pt), 0)
  assert.equal(lineOf(ravi, eps), R(666))
  assert.equal(lineOf(ravi, epf), R(294))
  assert.equal(pay(ravi).net, R(12244))
  assert.equal(fill.entries.reduce((s: number, e: { amount: number }) => s + e.amount, 0), 0)

  const v = await call('POST', at('/vouchers'), { type: 'Payroll', date: '2026-04-30', narration: 'Salary for April', entries: fill.entries })
  assert.ok(v.id)

  const q = '?from=2026-04-01&to=2026-04-30'
  const sheet = await call('GET', at('/reports/pay-sheet' + q))
  assert.deepEqual(sheet.rows.map((r: { name: string; net: number }) => [r.name, r.net]), [['Asha', R(118580)], ['Ravi', R(12244)]])
  assert.equal(sheet.net, R(130824))
  assert.equal(sheet.employer, R(12960))
  const slip = await call('GET', at(`/reports/payslip/${ravi}` + q))
  assert.deepEqual(slip.earnings.map((l: { name: string; amount: number }) => [l.name, l.amount]), [['Basic', R(8000)], ['Conveyance', R(1600)], ['HRA', R(3200)], ['Piece Rate', R(500)]])
  assert.equal(slip.totalDeductions, R(1056))
  assert.deepEqual(slip.attendance.map((a: { name: string; value: number }) => [a.name, a.value]), [['Leave without pay', 1000], ['Pieces', 100000]])
  const reg = await call('GET', at('/reports/payroll-register' + q))
  assert.deepEqual(reg.vouchers.map((x: { employees: number; net: number }) => [x.employees, x.net]), [[2, R(130824)]])
  const sheetA = await call('GET', at('/reports/attendance-sheet' + q))
  assert.deepEqual(sheetA.rows.map((r: { name: string }) => r.name), ['Ravi'])

  const pfr = await call('GET', at('/reports/pf' + q))
  const ashaPf = pfr.rows.find((r: { name: string }) => r.name === 'Asha')
  assert.deepEqual([ashaPf.epfWages, ashaPf.epsWages, ashaPf.epf, ashaPf.eps, ashaPf.epfEmployer], [R(100000), R(15000), R(12000), R(1250), R(10750)])
  assert.equal(pfr.ecr.split('\n')[0], '100200300400#~#ASHA#~#141600#~#100000#~#15000#~#15000#~#12000#~#1250#~#10750#~#0#~#0')
  const ravPf = pfr.rows.find((r: { name: string }) => r.name === 'Ravi')
  assert.equal(ravPf.ncpDays, 1)
  const esir = await call('GET', at('/reports/esi' + q))
  assert.deepEqual(esir.rows.map((r: { name: string; days: number; wages: number; employee: number }) => [r.name, r.days, r.wages, r.employee]), [['Ravi', 20, R(12800), R(96)]])
  const ptr = await call('GET', at('/reports/professional-tax' + q))
  assert.deepEqual(ptr.rows.map((r: { name: string; gross: number; pt: number }) => [r.name, r.gross, r.pt]), [['Asha', R(141600), R(200)], ['Ravi', R(13300), 0]])
  const it = await call('GET', at('/reports/salary-tax?fy=2026-04-01&asOf=2026-04-30'))
  const ashaTax = it.rows.find((r: { name: string }) => r.name === 'Asha')
  assert.deepEqual([ashaTax.projected, ashaTax.taxableIncome, ashaTax.tax, ashaTax.deducted], [R(1699200), R(1624200), R(129834), R(10820)])
  const gr = await call('GET', at('/reports/gratuity?asOf=2026-04-30'))
  assert.deepEqual(gr.rows.map((r: { name: string; years: number; payable: number }) => [r.name, r.years, r.payable]), [['Asha', 6, R(346154)], ['Ravi', 0, 0]])

  // May: the year's tax so far is spread over the months left
  const may = await call('POST', at('/payroll/fill'), { from: '2026-05-01', to: '2026-05-31', date: '2026-05-31', payableLedgerId: payable, employeeIds: [asha] })
  assert.equal(may.employees[0].lines.find((l: { payHeadId: number }) => l.payHeadId === tax).amount, R(10819))

  // an employee with salary booked stays
  assert.equal((await raw('DELETE', at(`/employees/${asha}`))).status, 422)
  // and the cost centre reports see the salaries by employee
  const masters = await call('GET', at('/payroll'))
  assert.equal(masters.employees.length, 2)
  assert.equal(masters.payHeads.length, 11)

  // a backup brings it all back
  const restored = await restoreCompany((await backupCompany(c.id)).file)
  const sheet2 = await call('GET', `/companies/${restored.id}/reports/pay-sheet${q}`)
  assert.equal(sheet2.net, R(130824))
  const m2 = await call('GET', `/companies/${restored.id}/payroll`)
  assert.equal(m2.employees.find((e: { name: string }) => e.name === 'Asha').uan, '100200300400')
  assert.equal(m2.salary.length, 2)
  assert.equal(m2.payHeads.find((h: { name: string }) => h.name === 'EPS Employer').ceiling, R(15000))
  const ap = await call('GET', `/companies/${restored.id}/reports/attendance-sheet${q}`)
  assert.equal(ap.rows[0].values[m2.attendanceTypes.find((t: { name: string }) => t.name === 'Pieces').id], 100000)
})
