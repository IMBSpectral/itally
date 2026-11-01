import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'

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

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: res.status === 204 ? null : await res.json() }
}

test('end to end: company, masters, vouchers, reports and ledger statement', async () => {
  const c = await call('POST', '/companies', { name: `API Co ${Date.now()}`, booksBegin: '2026-04-01' })
  assert.equal(c.status, 201)
  const id = c.body.id
  const groups = (await call('GET', `/companies/${id}/groups`)).body as { id: number; name: string }[]
  const g = (n: string) => groups.find((x) => x.name === n)!.id

  const mk = async (name: string, group: string, opening = 0) => {
    const r = await call('POST', `/companies/${id}/ledgers`, { name, groupId: g(group), opening })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    return r.body.id as number
  }
  const capital = await mk('Capital', 'Capital Account')
  const sales = await mk('Sales', 'Sales Accounts')
  const debtor = await mk('Ravi & Co', 'Sundry Debtors')
  const cash = ((await call('GET', `/companies/${id}/ledgers`)).body as { id: number; name: string }[]).find((l) => l.name === 'Cash')!.id
  await call('POST', `/companies/${id}/vouchers`, { type: 'Receipt', date: '2026-04-01', entries: [{ ledgerId: cash, amount: 1000000 }, { ledgerId: capital, amount: -1000000 }] })

  // duplicate name and invalid opening are refused with 422
  assert.equal((await call('POST', `/companies/${id}/ledgers`, { name: 'sales', groupId: g('Sales Accounts') })).status, 422)
  assert.equal((await call('POST', `/companies/${id}/ledgers`, { name: 'Rent', groupId: g('Indirect Expenses'), opening: 5 })).status, 422)

  const s = await call('POST', `/companies/${id}/vouchers`, {
    type: 'Sales',
    date: '2026-04-10',
    narration: 'Bill 1',
    entries: [{ ledgerId: debtor, amount: 250000 }, { ledgerId: sales, amount: -250000 }],
  })
  assert.equal(s.status, 201)
  assert.equal(s.body.number, 1)
  assert.equal(s.body.entries.length, 2)

  const bad = await call('POST', `/companies/${id}/vouchers`, {
    type: 'Sales',
    date: '2026-04-10',
    entries: [{ ledgerId: debtor, amount: 250000 }, { ledgerId: sales, amount: -200000 }],
  })
  assert.equal(bad.status, 422)
  assert.match(bad.body.errors.join(), /differ by 500/)
  assert.equal((await call('POST', `/companies/${id}/vouchers`, { type: 'Nope' })).status, 400)

  const r = await call('POST', `/companies/${id}/vouchers`, {
    type: 'Receipt',
    date: '2026-04-20',
    entries: [{ ledgerId: cash, amount: 100000 }, { ledgerId: debtor, amount: -100000 }],
  })

  const st = (await call('GET', `/companies/${id}/ledgers/${debtor}/statement`)).body
  assert.equal(st.opening, 0)
  assert.deepEqual(st.lines.map((l: { amount: number; balance: number; particulars: string }) => [l.amount, l.balance, l.particulars]), [
    [250000, 250000, 'Sales'],
    [-100000, 150000, 'Cash'],
  ])
  assert.equal(st.closing, 150000)

  const tb = (await call('GET', `/companies/${id}/reports/trial-balance`)).body
  assert.equal(tb.openingDifference, 0)
  assert.equal(tb.totalDr, tb.totalCr)
  assert.equal(tb.from, '2026-04-01')
  assert.equal(tb.to, '2027-03-31')
  const bs = (await call('GET', `/companies/${id}/reports/balance-sheet?to=2026-04-30`)).body
  assert.equal(bs.totalAssets, bs.totalLiabilities)
  assert.equal(bs.profitAndLoss.currentPeriod, 250000)

  // alter with version, then the day book shows the new amount
  const altered = await call('PUT', `/companies/${id}/vouchers/${r.body.id}`, {
    type: 'Receipt',
    date: '2026-04-21',
    version: 1,
    entries: [{ ledgerId: cash, amount: 150000 }, { ledgerId: debtor, amount: -150000 }],
  })
  assert.equal(altered.status, 200)
  assert.equal(altered.body.version, 2)
  const day = (await call('GET', `/companies/${id}/vouchers?type=Receipt`)).body
  assert.deepEqual(day.map((v: { date: string }) => v.date), ['2026-04-01', '2026-04-21'])

  const cancel = await call('POST', `/companies/${id}/vouchers/${r.body.id}/cancel`)
  assert.equal(cancel.body.cancelled, true)
  assert.equal((await call('GET', `/companies/${id}/ledgers/${debtor}/statement`)).body.closing, 250000)

  assert.equal((await call('GET', `/companies/${id}/reports/nope`)).status, 404)
  assert.equal((await call('GET', `/companies/${id}/reports/trial-balance?from=2026-05-01&to=2026-04-01`)).status, 422)
})

test('desktop mode: serves the built front end, with API paths still JSON', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const dir = await mkdtemp(path.join(tmpdir(), 'tally-static-'))
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>Books</title>')
  await writeFile(path.join(dir, 'app.js'), 'console.log(1)')
  const s = createApp(dir).listen(0)
  const at = `http://localhost:${(s.address() as AddressInfo).port}`
  try {
    assert.match(await (await fetch(at + '/')).text(), /Books/)
    assert.equal(await (await fetch(at + '/app.js')).text(), 'console.log(1)')
    assert.match(await (await fetch(at + '/some/screen')).text(), /Books/) // falls back to the app
    const api = await fetch(at + '/api/nope')
    assert.equal(api.status, 404)
    assert.deepEqual(await api.json(), { error: 'Not found' })
  } finally {
    s.close()
  }
})

test('settings: last company is remembered on the server; unknown keys and bad values are refused', async () => {
  assert.equal((await call('PUT', '/settings/lastCompany', { value: 7 })).status, 204)
  assert.deepEqual((await call('GET', '/settings/lastCompany')).body, { value: 7 })
  assert.equal((await call('PUT', '/settings/lastCompany', { value: null })).status, 204)
  assert.deepEqual((await call('GET', '/settings/lastCompany')).body, { value: null })
  assert.equal((await call('PUT', '/settings/lastCompany', { value: 'x' })).status, 400)
  assert.equal((await call('GET', '/settings/theme')).status, 400)
})

test('account books: cash/bank books, group summary, group vouchers, registers, monthly ledger', async () => {
  const c = (await call('POST', '/companies', { name: `Books Co ${Date.now()}`, booksBegin: '2026-04-01' })).body
  const groups = (await call('GET', `/companies/${c.id}/groups`)).body as { id: number; name: string }[]
  const g = (n: string) => groups.find((x) => x.name === n)!.id
  const mk = async (name: string, group: string, opening = 0) =>
    (await call('POST', `/companies/${c.id}/ledgers`, { name, groupId: g(group), opening })).body.id as number
  const capital = await mk('Capital', 'Capital Account', -100000)
  const bank = await mk('SBI', 'Bank Accounts', 80000)
  const sales = await mk('Sales', 'Sales Accounts')
  const asha = await mk('Asha', 'Sundry Debtors')
  const cash = ((await call('GET', `/companies/${c.id}/ledgers`)).body as { id: number; name: string }[]).find((l) => l.name === 'Cash')!.id
  await call('PUT', `/companies/${c.id}/ledgers/${cash}`, { name: 'Cash', groupId: g('Cash-in-Hand'), opening: 20000 })
  void capital
  const post = (type: string, date: string, entries: [number, number][]) =>
    call('POST', `/companies/${c.id}/vouchers`, { type, date, entries: entries.map(([ledgerId, amount]) => ({ ledgerId, amount })) })
  await post('Sales', '2026-04-05', [[asha, 5000], [sales, -5000]])
  await post('Sales', '2026-05-07', [[asha, 3000], [sales, -3000]])
  await post('Receipt', '2026-05-09', [[bank, 4000], [asha, -4000]])
  await post('Contra', '2026-05-10', [[cash, 1000], [bank, -1000]])

  const cb = (await call('GET', `/companies/${c.id}/reports/group-summary?cashBank=1`)).body
  assert.equal(cb.title, 'Cash/Bank Books')
  assert.deepEqual(cb.lines.map((l: { name: string; opening: number; debit: number; credit: number; closing: number }) => [l.name, l.opening, l.debit, l.credit, l.closing]), [
    ['Cash', 20000, 1000, 0, 21000],
    ['SBI', 80000, 4000, 1000, 83000],
  ])

  const ca = (await call('GET', `/companies/${c.id}/reports/group-summary?groupId=${g('Current Assets')}`)).body
  assert.deepEqual(ca.lines.map((l: { kind: string; name: string; closing: number }) => [l.kind, l.name, l.closing]), [
    ['group', 'Bank Accounts', 83000],
    ['group', 'Cash-in-Hand', 21000],
    ['group', 'Sundry Debtors', 4000],
  ])
  assert.equal(ca.total.closing, 108000)

  const gv = (await call('GET', `/companies/${c.id}/reports/group-vouchers?groupId=${g('Sundry Debtors')}`)).body
  assert.deepEqual(gv.lines.map((l: { amount: number; balance: number }) => [l.amount, l.balance]), [[5000, 5000], [3000, 8000], [-4000, 4000]])

  const reg = (await call('GET', `/companies/${c.id}/reports/register?type=Sales`)).body
  assert.equal(reg.months.length, 12)
  assert.deepEqual(reg.months.slice(0, 3).map((m: { month: string; count: number; total: number }) => [m.month, m.count, m.total]), [
    ['2026-04', 1, 5000], ['2026-05', 1, 3000], ['2026-06', 0, 0],
  ])

  const mon = (await call('GET', `/companies/${c.id}/ledgers/${bank}/monthly`)).body
  assert.equal(mon.opening, 80000)
  assert.deepEqual(mon.months.slice(0, 3).map((m: { debit: number; credit: number; closing: number }) => [m.debit, m.credit, m.closing]), [
    [0, 0, 80000], [4000, 1000, 83000], [0, 0, 83000],
  ])
  assert.equal(mon.closing, 83000)
})
