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

test('inventory over HTTP: masters, an item invoice, Stock Summary and Stock Item Vouchers', async () => {
  const c = (await call('POST', '/companies', { name: `Stock API ${Date.now()}`, booksBegin: '2026-04-01' })).body.id
  const at = (p: string) => `/companies/${c}${p}`
  const groups = (await call('GET', at('/groups'))).body as { id: number; name: string }[]
  const g = (n: string) => groups.find((x) => x.name === n)!.id
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, at(path), body)
    assert.ok(r.status < 300, `${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`)
    return r.body
  }

  const kg = (await ok('POST', '/units', { symbol: 'Kg', decimals: 2 })).id
  const grains = (await ok('POST', '/stock-groups', { name: 'Grains' })).id
  const rice = (await ok('POST', '/stock-items', { name: 'Rice', groupId: grains, unitId: kg, openingQty: 100000, openingValue: 400000 })).id
  const [main] = await ok('GET', '/godowns')
  assert.deepEqual([main.name, main.isDefault], ['Main Location', true])
  const back = (await ok('POST', '/godowns', { name: 'Back Store', parentId: main.id })).id
  await ok('POST', '/ledgers', { name: 'Capital', groupId: g('Capital Account'), opening: -400000 })
  const sales = (await ok('POST', '/ledgers', { name: 'Sales', groupId: g('Sales Accounts') })).id
  const bistro = (await ok('POST', '/ledgers', { name: 'Bistro', groupId: g('Sundry Debtors'), billwise: false })).id

  const v = await ok('POST', '/vouchers', {
    type: 'Sales', date: '2026-04-20',
    entries: [{ ledgerId: bistro, amount: 180000 }, { ledgerId: sales, amount: -180000 }],
    inventory: [
      { itemId: rice, godownId: main.id, qty: -20000, rate: 6000, amount: -120000 },
      { itemId: rice, godownId: back, qty: -10000, rate: 6000, amount: -60000 },
    ],
  })
  const got = await ok('GET', `/vouchers/${v.id}`)
  assert.equal(got.inventory.length, 2)

  const ss = await ok('GET', '/reports/stock-summary')
  assert.deepEqual(ss.lines.map((l: { kind: string; name: string }) => [l.kind, l.name]), [['group', 'Grains']])
  assert.deepEqual([ss.total.openingValue, ss.total.outValue, ss.total.closingValue], [400000, 120000, 280000])
  const inGroup = await ok('GET', `/reports/stock-summary?groupId=${grains}`)
  assert.deepEqual(inGroup.lines[0].godowns, [{ godown: 'Back Store', qty: -10000 }, { godown: 'Main Location', qty: 80000 }])

  const sv = await ok('GET', `/stock-items/${rice}/vouchers`)
  assert.deepEqual(sv.lines.map((l: { balance: number }) => l.balance), [80000, 70000])

  // the Trial Balance and Current Assets carry the stock line, which opens the Stock Summary
  const ca = await ok('GET', `/reports/group-summary?groupId=${g('Current Assets')}`)
  assert.equal(ca.lines.find((l: { name: string }) => l.name === 'Stock-in-Hand').closing, 280000)
  const sih = await ok('GET', `/reports/group-summary?groupId=${g('Stock-in-Hand')}`)
  const stock = sih.lines.find((l: { kind: string }) => l.kind === 'stock')
  assert.deepEqual([stock.id, stock.closing], [-1, 280000])
  assert.ok(!(await ok('GET', '/ledgers')).some((l: { id: number }) => l.id < 0))

  assert.equal((await call('DELETE', at(`/stock-items/${rice}`))).status, 422)
  assert.equal((await call('DELETE', at(`/godowns/${main.id}`))).status, 422)
  assert.equal((await call('POST', at('/stock-items'), { name: 'Rice', unitId: kg })).status, 422)
  assert.equal((await call('POST', at('/vouchers'), {
    type: 'Sales', date: '2026-04-21', entries: [{ ledgerId: bistro, amount: 100 }, { ledgerId: sales, amount: -100 }],
    inventory: [{ itemId: rice, godownId: main.id, qty: 1000, rate: 100, amount: 100 }],
  })).status, 422)
})
