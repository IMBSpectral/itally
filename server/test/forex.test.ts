import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'
import { backupCompany, restoreCompany } from '../src/backup'
import { forexLineErrors, formatForex, formatRate, parseForex, parseRate, rateKindFor, splitForex, toBase, toForex } from '../src/engine/forex'

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
const D = (dollars: number) => Math.round(dollars * 100) // cents
const X = (rate: number) => Math.round(rate * 10000)

test('the engine: amounts at a rate and back, typed rates and amounts, bills sharing a foreign amount', () => {
  assert.equal(toBase(D(100), X(83.25), 2), R(8325))
  assert.equal(toBase(-D(0.01), X(83.25), 2), -R(0.83))
  assert.equal(toForex(R(8325), X(83.25), 2), D(100))
  assert.equal(toBase(1000, X(0.55), 0), R(550)) // ¥1,000 at ₹0.55
  assert.equal(toBase(9e13, X(83.25), 2), 7_492_500_000_000_000) // exact although forex × rate passes 2^53 on the way
  assert.equal(parseRate('83.2575'), 832575)
  assert.equal(parseRate('83.25751'), null)
  assert.equal(parseRate('0'), null)
  assert.equal(formatRate(832500), '83.25')
  assert.equal(formatRate(832575), '83.2575')
  assert.equal(formatRate(830000), '83.00')
  assert.equal(parseForex('1,200.5', 2), 120050)
  assert.equal(parseForex('1.234', 2), null)
  assert.equal(formatForex(-120050, { symbol: '$', decimals: 2 }), '$1,200.50')
  assert.equal(formatForex(5000, { symbol: 'USD', decimals: 0 }), 'USD 5,000')
  assert.deepEqual(splitForex(D(100), R(8300), [{ amount: R(2766) }, { amount: R(5534) }]), [3333, 6667])
  assert.deepEqual(splitForex(null, R(10), [{ amount: R(10) }]), [null])
  assert.deepEqual([rateKindFor('Payment'), rateKindFor('Receipt'), rateKindFor('Journal')], ['selling', 'buying', 'standard'])
  // an invoice priced in rupees: ₹10,001 at ₹83.25 is $120.13 (₹10,000.82); within half a cent's worth, so it stands
  const usd = { id: 1, symbol: '$', name: 'US Dollar', decimals: 2, decimalName: null }
  assert.equal(toForex(R(10001), X(83.25), 2), 12013)
  assert.deepEqual(forexLineErrors({ amount: R(10001), forex: 12013, forexRate: X(83.25) }, usd, 'Line 1'), [])
  assert.equal(forexLineErrors({ amount: R(10002), forex: 12013, forexRate: X(83.25) }, usd, 'Line 1').length, 1)
  assert.deepEqual(forexLineErrors({ amount: R(50), forex: 0 }, usd, 'Line 1'), []) // a forex adjustment
  assert.match(forexLineErrors({ amount: R(50), forex: 1 }, undefined, 'Line 1')[0], /kept in rupees/)
})

test('multi-currency books: a sale in dollars, a part receipt at another rate, the gain at the standard rate, its adjustment, a realised gain, backup', async () => {
  const c = await call('POST', '/companies', { name: `Forex Co ${Date.now()}`, booksBegin: '2026-04-01' })
  const at = `/companies/${c.id}`
  assert.equal((await call('GET', `${at}/features`)).features.multiCurrency, false)
  await call('PUT', `${at}/features`, { multiCurrency: true })
  assert.equal((await raw('POST', `${at}/currencies`, { symbol: '₹', name: 'Rupee' })).status, 422)
  const usd = (await call('POST', `${at}/currencies`, { symbol: '$', name: 'US Dollar', decimals: 2, decimalName: 'cent' })).id
  assert.equal((await raw('POST', `${at}/currencies`, { symbol: '$', name: 'Other Dollar' })).status, 422)
  await call('PUT', `${at}/rates`, { date: '2026-04-01', rates: [{ currencyId: usd, standard: X(83), selling: X(83.5), buying: X(82.5) }] })
  await call('PUT', `${at}/rates`, { date: '2026-06-30', rates: [{ currencyId: usd, standard: X(85), selling: null, buying: null }] })
  const may = await call('GET', `${at}/rates?date=2026-05-15`)
  assert.deepEqual(may[0].rates, { date: '2026-04-01', standard: X(83), selling: X(83.5), buying: X(82.5) })

  const groups: { id: number; name: string }[] = await call('GET', `${at}/groups`)
  const g = (n: string) => groups.find((x) => x.name === n)!.id
  const L = async (name: string, group: string, extra: object = {}) => (await call('POST', `${at}/ledgers`, { name, groupId: g(group), ...extra })).id as number
  assert.equal((await raw('POST', `${at}/ledgers`, { name: 'Odd', groupId: g('Indirect Incomes'), currencyId: usd })).status, 422)
  const client = await L('US Client', 'Sundry Debtors', { currencyId: usd })
  const eefc = await L('EEFC Account', 'Bank Accounts', { currencyId: usd, opening: R(83000), openingForex: D(1000) })
  const sales = await L('Export Sales', 'Sales Accounts')
  const gain = await L('Forex Gain/Loss', 'Indirect Incomes')
  assert.equal((await call('GET', `${at}/ledgers/${eefc}`)).openingForex, D(1000))

  const sale = (e: object) => ({ type: 'Sales', date: '2026-04-20', entries: [
    { ledgerId: client, amount: R(82500), bills: [{ type: 'New Ref', name: 'INV1', amount: R(82500) }], ...e }, { ledgerId: sales, amount: -R(82500) }] })
  const noForex = await raw('POST', `${at}/vouchers`, sale({}))
  assert.equal(noForex.status, 422)
  assert.match(noForex.body.errors[0], /kept in US Dollar; give the amount in \$/)
  assert.match((await raw('POST', `${at}/vouchers`, sale({ forex: D(1000), forexRate: X(83) }))).body.errors[0], /\$1,000.00 at 83.00 is ₹83000.00, not ₹82500.00/)
  assert.equal((await raw('POST', `${at}/vouchers`, { ...sale({ forex: D(1000), forexRate: X(82.5) }), entries: [...sale({}).entries.slice(1), { ledgerId: sales, amount: R(1), forex: 100, forexRate: 10000 }] })).status, 422)
  await call('POST', `${at}/vouchers`, sale({ forex: D(1000), forexRate: X(82.5) }))
  // $600 received at ₹84 into the dollar account
  await call('POST', `${at}/vouchers`, { type: 'Receipt', date: '2026-05-10', entries: [
    { ledgerId: client, amount: -R(50400), forex: -D(600), forexRate: X(84), bills: [{ type: 'Agst Ref', name: 'INV1', amount: -R(50400) }] },
    { ledgerId: eefc, amount: R(50400), forex: D(600), forexRate: X(84) }] })
  // a dollar ledger can't change its currency once it has vouchers, and a used currency can't go
  assert.equal((await raw('PUT', `${at}/ledgers/${client}`, { name: 'US Client', groupId: g('Sundry Debtors'), currencyId: null })).status, 422)
  assert.equal((await raw('DELETE', `${at}/currencies/${usd}`)).status, 422)

  const out = await call('GET', `${at}/ledgers/${client}/outstanding?from=2026-04-01&to=2026-05-31`)
  assert.deepEqual(out.bills.map((b: { name: string; pending: number; forex: number }) => [b.name, b.pending, b.forex]), [['INV1', R(32100), D(400)]])

  const st = await call('GET', `${at}/ledgers/${client}/statement?from=2026-04-01&to=2026-05-31`)
  assert.deepEqual([st.currency.symbol, st.openingForex, st.closingForex, st.closing], ['$', 0, D(400), R(32100)])
  assert.deepEqual(st.lines.map((l: { forex: number; forexRate: number; forexBalance: number }) => [l.forex, l.forexRate, l.forexBalance]),
    [[D(1000), X(82.5), D(1000)], [-D(600), X(84), D(400)]])

  // valued at ₹85 on 30 June: the client's $400 (₹32,100) is worth ₹34,000; the account's $1,600 (₹1,33,400) ₹1,36,000
  const fx = await call('GET', `${at}/reports/forex-gain-loss?asOf=2026-06-30`)
  const row = (r: typeof fx, name: string) => r.ledgers.find((l: { ledger: string }) => l.ledger === name)
  assert.deepEqual([row(fx, 'US Client').forex, row(fx, 'US Client').book, row(fx, 'US Client').value, row(fx, 'US Client').difference], [D(400), R(32100), R(34000), R(1900)])
  assert.deepEqual(row(fx, 'US Client').bills, [{ name: 'INV1', forex: D(400), book: R(32100), value: R(34000), difference: R(1900), settled: false }])
  assert.equal(row(fx, 'EEFC Account').difference, R(2600))
  assert.deepEqual([fx.total, fx.missingRates], [R(4500), []])
  // before any standard rate there is nothing to value
  assert.equal((await call('GET', `${at}/reports/forex-gain-loss?asOf=2026-03-31`)).total, 0)

  // a Journal can't move a bank's dollars, only adjust its rupees
  assert.equal((await raw('POST', `${at}/vouchers`, { type: 'Journal', date: '2026-06-30', entries: [
    { ledgerId: eefc, amount: R(85), forex: D(1), forexRate: X(85) }, { ledgerId: gain, amount: -R(85) }] })).status, 422)
  const adj = await call('POST', `${at}/forex/adjust`, { date: '2026-06-30', ledgerId: gain })
  assert.equal(adj.type, 'Journal')
  assert.deepEqual(adj.entries.map((e: { ledger: string; amount: number; forex: number | null; bills: { type: string; name: string }[] | null }) =>
    [e.ledger, e.amount, e.forex, e.bills?.map((b) => `${b.type} ${b.name}`) ?? null]),
    [['EEFC Account', R(2600), 0, null], ['US Client', R(1900), 0, ['Agst Ref INV1']], ['Forex Gain/Loss', -R(4500), null, null]])
  assert.equal((await call('GET', `${at}/reports/forex-gain-loss?asOf=2026-06-30`)).total, 0)
  assert.equal((await raw('POST', `${at}/forex/adjust`, { date: '2026-06-30', ledgerId: gain })).status, 422)

  // the last $400 comes in at ₹86: the bill is settled in dollars, ₹400 more than its value at ₹85 (realised)
  await call('POST', `${at}/vouchers`, { type: 'Receipt', date: '2026-07-15', entries: [
    { ledgerId: client, amount: -R(34400), forex: -D(400), forexRate: X(86), bills: [{ type: 'Agst Ref', name: 'INV1', amount: -R(34400) }] },
    { ledgerId: eefc, amount: R(34400), forex: D(400), forexRate: X(86) }] })
  const july = await call('GET', `${at}/reports/forex-gain-loss?asOf=2026-07-31`)
  assert.deepEqual(row(july, 'US Client').bills, [{ name: 'INV1', forex: 0, book: -R(400), value: 0, difference: R(400), settled: true }])
  assert.equal(row(july, 'EEFC Account').difference, -R(400))

  // a backup carries currencies, rates, ledgers' currencies and every foreign amount
  const restored = (await restoreCompany((await backupCompany(c.id)).file)).id
  const again = await call('GET', `/companies/${restored}/reports/forex-gain-loss?asOf=2026-07-31`)
  const plain = (r: typeof fx) => r.ledgers.map(({ ledgerId: _, currencyId: __, ...l }: { ledgerId: number; currencyId: number }) => l)
  assert.deepEqual(plain(again), plain(july))
  assert.equal((await call('GET', `/companies/${restored}/rates?date=2026-06-30`))[0].rates.standard, X(85))
})
