import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'
import { backupCompany, restoreCompany } from '../src/backup'

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

test('budgets and variance, reversing journals out of the books, scenarios on the reports, backup', async () => {
  const c = await call('POST', '/companies', { name: `Budget Co ${Date.now()}`, booksBegin: '2026-04-01' })
  const at = (p: string) => `/companies/${c.id}${p}`
  const groups: { id: number; name: string }[] = await call('GET', at('/groups'))
  const g = (n: string) => groups.find((x) => x.name === n)!.id
  const L = async (name: string, group: string, extra: object = {}) => (await call('POST', at('/ledgers'), { name, groupId: g(group), billwise: false, ...extra })).id as number
  const rent = await L('Rent', 'Indirect Expenses', { costCentres: true })
  const power = await L('Electricity', 'Indirect Expenses')
  const sales = await L('Sales', 'Sales Accounts')
  const bank = await L('HDFC', 'Bank Accounts', { opening: R(500000) })
  const payable = await L('Expenses Payable', 'Current Liabilities')
  const mumbai = (await call('POST', at('/cost-centres'), { name: 'Mumbai' })).id

  const v = (type: string, date: string, entries: object[], extra: object = {}) => call('POST', at('/vouchers'), { type, date, entries, ...extra })
  await v('Payment', '2026-04-05', [{ ledgerId: rent, amount: R(30000), costs: [{ centreId: mumbai, amount: R(30000) }] }, { ledgerId: bank, amount: -R(30000) }])
  await v('Payment', '2026-05-05', [{ ledgerId: rent, amount: R(30000), costs: [{ centreId: mumbai, amount: R(30000) }] }, { ledgerId: bank, amount: -R(30000) }])
  await v('Payment', '2026-05-10', [{ ledgerId: power, amount: R(8000) }, { ledgerId: bank, amount: -R(8000) }])
  await v('Receipt', '2026-05-20', [{ ledgerId: bank, amount: R(200000) }, { ledgerId: sales, amount: -R(200000) }])

  // a budget for the quarter on a ledger, a group, a cost centre and a closing balance
  const body = {
    name: 'Q1 2026', from: '2026-04-01', to: '2026-06-30', lines: [
      { kind: 'ledger', targetId: rent, type: 'nett', amount: R(90000) },
      { kind: 'group', targetId: g('Indirect Expenses'), type: 'nett', amount: R(100000) },
      { kind: 'cost centre', targetId: mumbai, type: 'nett', amount: R(75000) },
      { kind: 'ledger', targetId: bank, type: 'closing', amount: R(600000) },
      { kind: 'group', targetId: g('Sales Accounts'), type: 'nett', amount: -R(250000) },
    ],
  }
  assert.equal((await raw('POST', at('/budgets'), { ...body, to: '2026-03-01' })).status, 422)
  assert.equal((await raw('POST', at('/budgets'), { ...body, lines: [body.lines[0], body.lines[0]] })).status, 422)
  const q1 = (await call('POST', at('/budgets'), body)).id
  assert.equal((await raw('POST', at('/budgets'), body)).status, 422) // the name is taken
  const april = (await call('POST', at('/budgets'), { name: 'April', parentId: q1, from: '2026-04-01', to: '2026-04-30', lines: [{ kind: 'ledger', targetId: rent, type: 'nett', amount: R(30000) }] })).id
  assert.equal((await raw('PUT', at(`/budgets/${q1}`), { ...body, parentId: april })).status, 422) // under itself
  assert.equal((await raw('DELETE', at(`/budgets/${q1}`))).status, 422) // April is under it

  let bv = await call('GET', at(`/reports/budget-variance?budget=${q1}`))
  const row = (r: typeof bv, name: string) => r.lines.find((l: { name: string }) => l.name === name)
  assert.deepEqual([row(bv, 'Rent').actual, row(bv, 'Rent').variance], [R(60000), -R(30000)])
  assert.equal(row(bv, 'Indirect Expenses').actual, R(68000))
  assert.equal(row(bv, 'Mumbai').actual, R(60000))
  assert.equal(row(bv, 'HDFC').actual, R(632000)) // 5,00,000 - 68,000 + 2,00,000
  assert.deepEqual([row(bv, 'Sales Accounts').actual, row(bv, 'Sales Accounts').variance], [-R(200000), R(50000)])

  // a reversing journal: June's rent accrued, effective to 30 June, out of the books
  assert.equal((await raw('POST', at('/vouchers'), { type: 'Reversing Journal', date: '2026-06-30', entries: [{ ledgerId: rent, amount: R(30000) }, { ledgerId: payable, amount: -R(30000) }] })).status, 422)
  assert.equal((await raw('POST', at('/vouchers'), { type: 'Journal', date: '2026-06-30', applicableUpto: '2026-07-01', entries: [{ ledgerId: rent, amount: R(30000) }, { ledgerId: payable, amount: -R(30000) }] })).status, 422)
  const rj = await v('Reversing Journal', '2026-06-30', [{ ledgerId: rent, amount: R(30000) }, { ledgerId: payable, amount: -R(30000) }], { applicableUpto: '2026-07-31' })
  assert.equal((await call('GET', at(`/vouchers/${rj.id}`))).applicableUpto, '2026-07-31')
  // a provision as an optional voucher
  await v('Journal', '2026-06-30', [{ ledgerId: power, amount: R(4000) }, { ledgerId: payable, amount: -R(4000) }], { optional: true })
  const tb = async (to: string, scenario?: number) => {
    const r = await call('GET', at(`/reports/trial-balance?from=2026-04-01&to=${to}${scenario ? `&scenario=${scenario}` : ''}`))
    return { dr: r.totalDr ?? r.total?.dr, r }
  }
  const books = await call('GET', at('/reports/profit-loss?from=2026-04-01&to=2026-06-30'))

  // scenarios: the provisional books (actuals + reversing journals), and only the optional vouchers
  assert.equal((await raw('POST', at('/scenarios'), { name: 'Empty', includeActuals: false, include: [] })).status, 422)
  const provisional = (await call('POST', at('/scenarios'), { name: 'Provisional', includeActuals: true, include: ['Reversing Journal'] })).id
  const optionals = (await call('POST', at('/scenarios'), { name: 'Optionals only', includeActuals: false, include: ['Optional'] })).id
  const pl = (to: string, s?: number) => call('GET', at(`/reports/profit-loss?from=2026-04-01&to=${to}${s ? `&scenario=${s}` : ''}`))
  const withRj = await pl('2026-06-30', provisional)
  assert.equal(withRj.scenario, 'Provisional')
  assert.equal(JSON.stringify(withRj).includes('Provisional'), true)
  const netOf = (r: { netProfit?: number; net?: number }) => r.netProfit ?? r.net
  assert.equal(netOf(books)! - netOf(withRj)!, R(30000)) // the accrued rent comes off the profit
  // after its applicable-upto date the reversing journal has reversed
  assert.equal(netOf(await pl('2026-08-31', provisional)), netOf(await pl('2026-08-31')))
  const opt = await tb('2026-06-30', optionals)
  const plOpt = await pl('2026-06-30', optionals)
  assert.equal(netOf(plOpt), -R(4000))
  assert.ok(opt.r)
  // the budget seen under the provisional scenario counts the accrual
  bv = await call('GET', at(`/reports/budget-variance?budget=${q1}&scenario=${provisional}`))
  assert.equal(row(bv, 'Rent').actual, R(90000))
  // the books themselves never saw either voucher
  assert.equal(netOf(await pl('2026-06-30')), netOf(books))

  const reg = await call('GET', at('/reports/reversing-journals?from=2026-04-01&to=2026-06-30'))
  assert.deepEqual(reg.vouchers.map((x: { applicableUpto: string; amount: number; effective: boolean }) => [x.applicableUpto, x.amount, x.effective]), [['2026-07-31', R(30000), true]])

  // backup keeps budgets, scenarios and the reversing journal
  const { file } = await backupCompany(c.id)
  const restored = await restoreCompany(file)
  const rat = (p: string) => `/companies/${restored.id}${p}`
  const budgets: { id: number; name: string; parent: string | null }[] = await call('GET', rat('/budgets'))
  assert.deepEqual(budgets.map((b) => [b.name, b.parent]), [['April', 'Q1 2026'], ['Q1 2026', null]])
  const scen: { id: number; name: string }[] = await call('GET', rat('/scenarios'))
  const prov2 = scen.find((s) => s.name === 'Provisional')!.id
  const bv2 = await call('GET', rat(`/reports/budget-variance?budget=${budgets.find((b) => b.name === 'Q1 2026')!.id}&scenario=${prov2}`))
  assert.equal(row(bv2, 'Rent').actual, R(90000))
  assert.equal(row(bv2, 'Mumbai').actual, R(60000))
})
