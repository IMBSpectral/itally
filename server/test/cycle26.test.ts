import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'
import { backupCompany, restoreCompany } from '../src/backup'
import { setToday } from '../src/engine/clock'

let server: Server
let base = ''
before(async () => {
  await migrate(() => {})
  server = createApp().listen(0)
  base = `http://localhost:${(server.address() as AddressInfo).port}/api`
})
after(async () => {
  setToday(null)
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
const Q = (n: number) => n * 1000

test('post-dated vouchers wait for their day; batches; cost tracking; cheque layouts; backup', async () => {
  setToday('2026-10-28')
  const c = await call('POST', '/companies', { name: `C26 ${Date.now()}`, booksBegin: '2026-04-01' })
  const at = (p: string) => `/companies/${c.id}${p}`
  const groups: { id: number; name: string }[] = await call('GET', at('/groups'))
  const g = (n: string) => groups.find((x) => x.name === n)!.id
  const L = async (name: string, group: string, extra: object = {}) => (await call('POST', at('/ledgers'), { name, groupId: g(group), billwise: false, ...extra })).id as number
  const bank = await L('HDFC', 'Bank Accounts', { opening: R(50000) })
  await L('Capital', 'Capital Account', { opening: -R(50000) })
  const rent = await L('Rent', 'Indirect Expenses')
  const sales = await L('Sales', 'Sales Accounts')
  const purchases = await L('Purchases', 'Purchase Accounts')
  const pharma = await L('Pharma Co', 'Sundry Creditors')
  const clinic = await L('Clinic', 'Sundry Debtors')
  const balance = async (id: number) => ((await call('GET', at('/ledgers?from=2026-04-01&to=2027-03-31'))) as { id: number; closing: number }[]).find((l) => l.id === id)!.closing

  // post-dated: a cheque payment for 15 November, entered on 28 October, stays out of the books
  const pd = await call('POST', at('/vouchers'), { type: 'Payment', date: '2026-11-15', postDated: true, entries: [{ ledgerId: rent, amount: R(8000) }, { ledgerId: bank, amount: -R(8000), chequeNo: '000451' }] })
  let v = await call('GET', at(`/vouchers/${pd.id}`))
  assert.deepEqual([v.held, v.postDated, v.entries.length], [true, true, 2])
  assert.equal(await balance(bank), R(50000))
  const listed = await call('GET', at('/reports/post-dated'))
  assert.deepEqual(listed.vouchers.map((x: { amount: number; held: boolean }) => [x.amount, x.held]), [[R(8000), true]])
  // marked post-dated but dated today or earlier: posted at once
  const now = await call('POST', at('/vouchers'), { type: 'Payment', date: '2026-10-20', postDated: true, entries: [{ ledgerId: rent, amount: R(100) }, { ledgerId: bank, amount: -R(100) }] })
  assert.equal((await call('GET', at(`/vouchers/${now.id}`))).held, false)
  assert.equal(await balance(bank), R(49900))
  // the day comes: the next request posts it
  setToday('2026-11-15')
  assert.equal(await balance(bank), R(41900))
  v = await call('GET', at(`/vouchers/${pd.id}`))
  assert.deepEqual([v.held, v.entries.find((e: { ledgerId: number }) => e.ledgerId === bank).chequeNo], [false, '000451'])
  const log = await call('GET', at(`/edit-log?entity=voucher&entityId=${pd.id}`))
  assert.ok(JSON.stringify(log).includes('post-dated voucher, posted on its date'))
  setToday('2026-10-28')
  // a post-dated voucher altered back into the future is held again
  v = await call('GET', at(`/vouchers/${pd.id}`))
  await call('PUT', at(`/vouchers/${pd.id}`), { type: 'Payment', date: '2026-12-01', postDated: true, version: v.version, entries: [{ ledgerId: rent, amount: R(8000) }, { ledgerId: bank, amount: -R(8000) }] })
  assert.equal(await balance(bank), R(49900))

  // batches: the opening stock is batch "Opening Stock"; a purchase brings B1 with its dates
  const strip = (await call('POST', at('/units'), { symbol: 'Strip', name: 'Strips', decimals: 0 })).id
  const main = (await call('GET', at('/godowns'))).find((x: { isDefault: boolean }) => x.isDefault).id
  const med = (await call('POST', at('/stock-items'), { name: 'Paracetamol', unitId: strip, openingQty: Q(100), openingValue: R(1000), openingGodownId: main, batches: true })).id
  assert.equal((await call('GET', at('/stock-items'))).find((s: { id: number }) => s.id === med).batches, true)
  await call('POST', at('/vouchers'), { type: 'Purchase', date: '2026-05-01', entries: [{ ledgerId: purchases, amount: R(600) }, { ledgerId: pharma, amount: -R(600) }],
    inventory: [{ itemId: med, godownId: main, qty: Q(50), rate: R(12), amount: R(600), batch: 'B1', mfgDate: '2026-04-01', expiryDate: '2027-03-31' }] })
  const sell = (qty: number, batch?: string, date = '2026-06-01') =>
    raw('POST', at('/vouchers'), { type: 'Sales', date, entries: [{ ledgerId: clinic, amount: R(20 * qty) }, { ledgerId: sales, amount: -R(20 * qty) }],
      inventory: [{ itemId: med, godownId: main, qty: -Q(qty), rate: R(20), amount: -R(20 * qty), ...(batch ? { batch } : {}) }] })
  assert.equal((await sell(30, 'B1')).status, 201)
  const over = await sell(30, 'b1')
  assert.equal(over.status, 422)
  assert.match(over.body.errors.join(), /batch "b1" has 20 in that godown, not 30/)
  assert.match((await sell(5)).body.errors.join(), /kept in batches; name the batch/)
  assert.match((await sell(5, 'B9')).body.errors.join(), /no batch "B9"/)
  assert.match((await sell(5, 'B1', '2026-04-15')).body.errors.join(), /no batch "B1"/) // not yet bought on that date
  assert.equal((await sell(10, 'Opening Stock')).status, 201)
  const batches = await call('GET', at('/reports/batches?asOf=2026-12-31'))
  assert.deepEqual(batches.batches.map((b: { batch: string; qty: number; expiryDate: string | null; daysLeft: number | null }) => [b.batch, b.qty, b.expiryDate, b.daysLeft]),
    [['B1', Q(20), '2027-03-31', 90], ['Opening Stock', Q(90), null, null]])

  // cost tracking: a job's purchases and sales
  await call('POST', at('/vouchers'), { type: 'Payment', date: '2026-07-01', costTrack: 'JOB-7', entries: [{ ledgerId: rent, amount: R(1000) }, { ledgerId: bank, amount: -R(1000) }] })
  await call('POST', at('/vouchers'), { type: 'Receipt', date: '2026-07-05', costTrack: 'JOB-7', entries: [{ ledgerId: bank, amount: R(1500) }, { ledgerId: sales, amount: -R(1500) }] })
  const tracks = await call('GET', at('/reports/cost-tracks?from=2026-04-01&to=2027-03-31'))
  assert.deepEqual(tracks.tracks.map((t: { track: string; sales: number; costs: number; margin: number; vouchers: number }) => [t.track, t.sales, t.costs, t.margin, t.vouchers]),
    [['JOB-7', R(1500), R(1000), R(500), 2]])

  // a bank's cheque layout
  const layout = { width: 203, height: 92, date: { top: 8, left: 150 }, payee: { top: 21, left: 20 }, words: { top: 30, left: 32, width: 115 }, figures: { top: 38, left: 160 }, sign: { top: 62, left: 150 }, crossing: true, dateBox: 5.2 }
  assert.equal(await call('GET', at(`/ledgers/${bank}/cheque-layout`)), null)
  await call('PUT', at(`/ledgers/${bank}/cheque-layout`), layout)
  assert.deepEqual(await call('GET', at(`/ledgers/${bank}/cheque-layout`)), layout)
  assert.equal((await raw('PUT', at(`/ledgers/${bank}/cheque-layout`), { ...layout, width: 999 })).status, 400)

  // backup keeps the held voucher held, the batches, the track and the layout
  const { file } = await backupCompany(c.id)
  const r = await restoreCompany(file)
  const rat = (p: string) => `/companies/${r.id}${p}`
  const held = (await call('GET', rat('/reports/post-dated'))).vouchers
  assert.deepEqual(held.map((x: { held: boolean; amount: number }) => [x.held, x.amount]), [[true, R(8000)]])
  assert.deepEqual((await call('GET', rat('/reports/batches?asOf=2026-12-31'))).batches.map((b: { batch: string; qty: number }) => [b.batch, b.qty]), [['B1', Q(20)], ['Opening Stock', Q(90)]])
  assert.equal((await call('GET', rat('/reports/cost-tracks?from=2026-04-01&to=2027-03-31'))).tracks[0].margin, R(500))
  const rbank = ((await call('GET', rat('/ledgers?from=2026-04-01&to=2027-03-31'))) as { id: number; name: string }[]).find((l) => l.name === 'HDFC')!.id
  assert.deepEqual(await call('GET', rat(`/ledgers/${rbank}/cheque-layout`)), layout)
})
