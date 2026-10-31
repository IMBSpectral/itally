import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'
import { forexAmount, handleXml, itemQty } from '../src/xml/gateway'
import { importSheet } from '../src/import'

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
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  if (res.status >= 400) throw new Error(`${method} ${path} ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}
const R = (rupees: number) => Math.round(rupees * 100)
const Q = (n: number) => n * 1000

/** A company with the same masters each time: ledgers, a unit, a godown and an item kept in batches. */
async function books(name: string) {
  const c = await call('POST', '/companies', { name, booksBegin: '2026-04-01' })
  const at = (p: string) => `/companies/${c.id}${p}`
  const groups: { id: number; name: string }[] = await call('GET', at('/groups'))
  const g = (n: string) => groups.find((x) => x.name === n)!.id
  const L = async (name: string, group: string) => (await call('POST', at('/ledgers'), { name, groupId: g(group), billwise: false })).id as number
  const ids = {
    cash: await L('Cash Box', 'Cash-in-Hand'), sales: await L('Sales', 'Sales Accounts'), purchases: await L('Purchases', 'Purchase Accounts'),
    pharma: await L('Pharma Co', 'Sundry Creditors'), clinic: await L('Clinic', 'Sundry Debtors'), rent: await L('Rent', 'Indirect Expenses'),
  }
  const strip = (await call('POST', at('/units'), { symbol: 'Strip', name: 'Strips', decimals: 0 })).id
  const main = (await call('GET', at('/godowns'))).find((x: { isDefault: boolean }) => x.isDefault).id
  const med = (await call('POST', at('/stock-items'), { name: 'Paracetamol', unitId: strip, batches: true })).id
  return { c, at, ...ids, main, med }
}

test('Tally XML: a Day Book exported here imports into another company with its items, batches and flags', async () => {
  const stamp = Date.now()
  const a = await books(`C30 A ${stamp}`)
  await call('POST', a.at('/vouchers'), { type: 'Purchase', date: '2026-05-01', entries: [{ ledgerId: a.purchases, amount: R(600) }, { ledgerId: a.pharma, amount: -R(600) }],
    inventory: [{ itemId: a.med, godownId: a.main, qty: Q(50), rate: R(12), amount: R(600), batch: 'B1', mfgDate: '2026-04-01', expiryDate: '2027-03-31' }] })
  await call('POST', a.at('/vouchers'), { type: 'Sales', date: '2026-06-01', costTrack: 'JOB-9', entries: [{ ledgerId: a.clinic, amount: R(400) }, { ledgerId: a.sales, amount: -R(400) }],
    inventory: [{ itemId: a.med, godownId: a.main, qty: -Q(20), rate: R(20), amount: -R(400), batch: 'B1' }] })
  await call('POST', a.at('/vouchers'), { type: 'Payment', date: '2026-06-02', optional: true, entries: [{ ledgerId: a.rent, amount: R(100) }, { ledgerId: a.cash, amount: -R(100) }] })

  const day = await handleXml(`<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>Day Book</ID></HEADER><BODY><DESC><STATICVARIABLES>
    <SVCURRENTCOMPANY>${a.c.name}</SVCURRENTCOMPANY><SVFROMDATE>20260401</SVFROMDATE><SVTODATE>20270331</SVTODATE></STATICVARIABLES></DESC></BODY></ENVELOPE>`)
  assert.match(day, /<STOCKITEMNAME>Paracetamol<\/STOCKITEMNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><RATE>12.00\/Strip<\/RATE><AMOUNT>-600.00<\/AMOUNT><ACTUALQTY>50 Strip<\/ACTUALQTY>/)
  assert.match(day, /<BATCHNAME>B1<\/BATCHNAME><MFDON>20260401<\/MFDON><EXPIRYPERIOD>20270331<\/EXPIRYPERIOD>/)
  assert.match(day, /<ISOPTIONAL>Yes<\/ISOPTIONAL>/)
  assert.match(day, /<COSTTRACKNAME>JOB-9<\/COSTTRACKNAME>/)

  // the same file into a second company with the same masters
  const b = await books(`C30 B ${stamp}`)
  const messages = day.match(/<TALLYMESSAGE>[\s\S]*?<\/TALLYMESSAGE>/g)!
  assert.equal(messages.length, 3)
  const res = await handleXml(`<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>
    <REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${b.c.name}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>
    <REQUESTDATA>${messages.join('\n')}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`)
  assert.match(res, /<CREATED>3<\/CREATED>/, res)
  const batches = await call('GET', b.at('/reports/batches?asOf=2026-12-31'))
  assert.deepEqual(batches.batches.map((x: { batch: string; qty: number; expiryDate: string | null }) => [x.batch, x.qty, x.expiryDate]), [['B1', Q(30), '2027-03-31']])
  const tracks = await call('GET', b.at('/reports/cost-tracks?from=2026-04-01&to=2027-03-31'))
  assert.deepEqual(tracks.tracks.map((t: { track: string; sales: number }) => [t.track, t.sales]), [['JOB-9', R(400)]])
  const vouchers: { type: string; optional: boolean }[] = await call('GET', b.at('/vouchers?from=2026-04-01&to=2027-03-31'))
  assert.equal(vouchers.find((v) => v.type === 'Payment')?.optional, true)
})

test('Excel import: stock items kept in batches, and Sales and Purchase rows with items, batches and dates', async () => {
  const b = await books(`C30 X ${Date.now()}`)
  const items = await importSheet(b.c.id, 'stock-items', Buffer.from('Name,Unit,Batches\nCough Syrup,Strip,Yes\nBandage,Strip,No\n'))
  assert.deepEqual([items.created, items.failed], [2, []])
  const list: { name: string; batches: boolean }[] = await call('GET', b.at('/stock-items'))
  assert.deepEqual(list.filter((i) => i.name !== 'Paracetamol').map((i) => [i.name, i.batches]), [['Bandage', false], ['Cough Syrup', true]])

  const csv = [
    'Date,Voucher Type,Voucher No,Ledger,Debit,Credit,Item,Qty,Rate,Godown,Batch,Mfg Date,Expiry',
    '01-05-2026,Purchase,1,Purchases,600,,Paracetamol,50,12,,B7,01-04-2026,31-03-2027',
    ',,,Pharma Co,,600,,,,,,,',
    '02-05-2026,Sales,1,Clinic,300,,Paracetamol,15,20,,B7,,',
    ',,,Sales,,300,,,,,,,',
    '03-05-2026,Sales,2,Clinic,100,,Paracetamol,5,20,,,,',
    ',,,Sales,,100,,,,,,,',
    '04-05-2026,Payment,1,Rent,100,,Paracetamol,1,1,,,,',
    ',,,Cash Box,,100,,,,,,,',
  ].join('\n')
  const res = await importSheet(b.c.id, 'vouchers', Buffer.from(csv))
  assert.equal(res.created, 2)
  assert.deepEqual(res.failed.map((f) => [f.row, f.errors.join()]), [
    [6, 'Item line 1: Paracetamol is kept in batches; name the batch'],
    [8, 'Row 8: a Payment cannot carry stock items'],
  ])
  const batches = await call('GET', b.at('/reports/batches?asOf=2026-12-31'))
  assert.deepEqual(batches.batches.map((x: { batch: string; qty: number; mfgDate: string; expiryDate: string }) => [x.batch, x.qty, x.mfgDate, x.expiryDate]),
    [['B7', Q(35), '2026-04-01', '2027-03-31']])
})

test('Tally XML: foreign-currency lines, compound-unit quantities and reversing journals go out and come back', async () => {
  assert.deepEqual(forexAmount('-$ 1,000.00 @ ₹ 83.25/$ = -₹ 83250.00'), { forex: '-1000.00', rate: '83.25', rupees: '-83250.00' })
  assert.equal(forexAmount('-83250.00'), null)
  const box = { conversion: 10, first: 'Box', second: 'Nos' }
  assert.deepEqual([itemQty('2 Box 5 Nos', box), itemQty('3 Box', box), itemQty('25 Nos', box), itemQty('7 Nos')], [25000, 30000, 25000, 7000])

  const setup = async (name: string) => {
    const s = await books(name)
    await call('PUT', s.at('/features'), { multiCurrency: true })
    const usd = (await call('POST', s.at('/currencies'), { symbol: '$', name: 'US Dollar', decimals: 2, decimalName: 'cent' })).id
    const groups: { id: number; name: string }[] = await call('GET', s.at('/groups'))
    const us = (await call('POST', s.at('/ledgers'), { name: 'US Client', groupId: groups.find((x) => x.name === 'Sundry Debtors')!.id, billwise: false, currencyId: usd })).id
    const nos = (await call('POST', s.at('/units'), { symbol: 'Nos', name: 'Numbers', decimals: 0 })).id
    const boxU = (await call('POST', s.at('/units'), { symbol: 'Box', name: 'Boxes', decimals: 0 })).id
    const boxOf10 = (await call('POST', s.at('/units'), { symbol: '', firstUnitId: boxU, conversion: 10, secondUnitId: nos })).id
    const bolt = (await call('POST', s.at('/stock-items'), { name: 'Bolt', unitId: boxOf10, openingQty: Q(100), openingValue: R(1000), openingGodownId: s.main })).id
    return { ...s, us, bolt }
  }
  const stamp = Date.now()
  const a = await setup(`C30 F ${stamp}`)
  // $1,000 at ₹83.25, for 2 boxes and 5 bolts; a provision reversed at the month's end
  await call('POST', a.at('/vouchers'), { type: 'Sales', date: '2026-05-01', entries: [{ ledgerId: a.us, amount: R(83250), forex: 100000, forexRate: 832500 }, { ledgerId: a.sales, amount: -R(83250) }],
    inventory: [{ itemId: a.bolt, godownId: a.main, qty: -Q(25), rate: R(3330), amount: -R(83250) }] })
  await call('POST', a.at('/vouchers'), { type: 'Reversing Journal', date: '2026-05-31', applicableUpto: '2026-06-30', entries: [{ ledgerId: a.rent, amount: R(500) }, { ledgerId: a.cash, amount: -R(500) }] })
  const day = await handleXml(`<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>Day Book</ID></HEADER><BODY><DESC><STATICVARIABLES>
    <SVCURRENTCOMPANY>${a.c.name}</SVCURRENTCOMPANY><SVFROMDATE>20260401</SVFROMDATE><SVTODATE>20270331</SVTODATE></STATICVARIABLES></DESC></BODY></ENVELOPE>`)
  assert.match(day, /<AMOUNT>-\$ 1000\.00 @ ₹ 83\.25\/\$ = -₹ 83250\.00<\/AMOUNT>/)
  assert.match(day, /<ACTUALQTY>2 Box 5 Nos<\/ACTUALQTY>/)
  assert.match(day, /<APPLICABLEUPTO>20260630<\/APPLICABLEUPTO>/)

  const b = await setup(`C30 G ${stamp}`)
  const res = await handleXml(`<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>
    <REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${b.c.name}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>
    <REQUESTDATA>${day.match(/<TALLYMESSAGE>[\s\S]*?<\/TALLYMESSAGE>/g)!.join('\n')}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`)
  assert.match(res, /<CREATED>2<\/CREATED>/, res)
  const list: { id: number; type: string }[] = await call('GET', b.at('/vouchers?from=2026-04-01&to=2027-03-31'))
  const sale = await call('GET', b.at(`/vouchers/${list.find((v) => v.type === 'Sales')!.id}`))
  const usLine = sale.entries.find((e: { ledgerId: number }) => e.ledgerId === b.us)
  assert.deepEqual([usLine.amount, usLine.forex, usLine.forexRate, sale.inventory[0].qty], [R(83250), 100000, 832500, -Q(25)])
  const rj = await call('GET', b.at(`/vouchers/${list.find((v) => v.type === 'Reversing Journal')!.id}`))
  assert.equal(rj.applicableUpto, '2026-06-30')
})
