import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { deflateRawSync } from 'node:zlib'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'
import { dateOf, readCsv, readSheet } from '../src/sheet'
import { crc32, xlsx } from '../../src/xlsx'

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
const b64 = (x: Uint8Array | string) => Buffer.from(x).toString('base64')

/** A workbook as Excel writes one: deflated parts, shared strings, the sheet found through the workbook's relationships. */
function excelLike(shared: string[], sheetRows: string) {
  const files: [string, string][] = [
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['xl/workbook.xml', '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId7"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId7" Type="worksheet" Target="worksheets/data.xml"/></Relationships>'],
    ['xl/sharedStrings.xml', `<sst>${shared.map((s, i) => (i === 0 ? `<si><r><t>${s.slice(0, 2)}</t></r><r><t>${s.slice(2)}</t></r></si>` : `<si><t>${s}</t></si>`)).join('')}</sst>`],
    ['xl/worksheets/data.xml', `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`],
  ]
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text] of files) {
    const data = Buffer.from(text)
    const packed = deflateRawSync(data)
    const n = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(n.length, 26)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(8, 10)
    c.writeUInt32LE(crc32(data), 16)
    c.writeUInt32LE(packed.length, 20)
    c.writeUInt32LE(data.length, 24)
    c.writeUInt16LE(n.length, 28)
    c.writeUInt32LE(offset, 42)
    parts.push(local, n, packed)
    central.push(c, n)
    offset += 30 + n.length + packed.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cd, end])
}

test('reading sheets: CSV quoting, dates, our own .xlsx, an Excel-made one', () => {
  assert.deepEqual(readCsv('Name,Amount\r\n"Shah, R.","1,500"\n"say ""hi""",\n'), [['Name', 'Amount'], ['Shah, R.', '1,500'], ['say "hi"', null]])
  assert.equal(dateOf(46157), '2026-05-15')
  assert.equal(dateOf('15-05-2026'), '2026-05-15')
  assert.equal(dateOf('15/5/2026'), '2026-05-15')
  assert.equal(dateOf('15-May-26'), '2026-05-15')
  assert.equal(dateOf('2026-5-15'), '2026-05-15')
  assert.equal(dateOf('soon'), null)
  const ours = readSheet(Buffer.from(xlsx('Sheet', [{ cells: ['Name', 'Qty'] }, { cells: ['Bolt', 12.5] }, { cells: [null, 3] }])))
  assert.deepEqual(ours, [['Name', 'Qty'], ['Bolt', 12.5], [null, 3]])
  const excel = readSheet(excelLike(['Ledger', 'Rent'], '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="str"><v>x</v></c></row><row r="3"><c r="B3" t="s"><v>1</v></c><c r="C3"><v>42</v></c></row>'))
  assert.deepEqual(excel, [['Ledger', null, 'x'], [], [null, 'Rent', 42]])
})

test('import from Excel, F12 configuration, split company, group company', async () => {
  const c = await call('POST', '/companies', { name: `Tools ${Date.now()}`, booksBegin: '2026-04-01' })
  const at = (p: string) => `/companies/${c.id}${p}`

  // ledgers from CSV: one with an unknown group fails on its own
  const csv = 'Name,Under,Opening Balance,Dr/Cr,PAN\nRam Traders,Sundry Debtors,"1,500.00",Dr,\nBad One,Nowhere,0,,\nShyam & Co,Sundry Creditors,2000,Cr,ABCPS1234K\nHDFC,Bank Accounts,100000,Dr,\nRent,Indirect Expenses,,,\nSales,Sales Accounts,,,\n'
  const li = await call('POST', at('/import/ledgers'), { file: b64(csv) })
  assert.equal(li.created, 5)
  assert.deepEqual(li.failed.map((f: { row: number; errors: string[] }) => [f.row, f.errors[0]]), [[3, 'Unknown group "Nowhere"']])
  const ledgers: { id: number; name: string; closing: number }[] = await call('GET', at('/ledgers?from=2026-04-01&to=2027-03-31'))
  assert.equal(ledgers.find((l) => l.name === 'Shyam & Co')!.closing, -R(2000))
  assert.equal((await raw('POST', at('/import/ledgers'), { file: b64('Who,What\nx,y\n') })).status, 422) // no Name/Group columns

  // stock items from our .xlsx: the unit is made when missing
  const items = xlsx('Items', [{ cells: ['Item Name', 'Unit', 'Opening Qty', 'Opening Rate', 'HSN', 'GST Rate'] }, { cells: ['Bolt', 'Nos', 100, 2.5, '7318', '18%'] }])
  const ii = await call('POST', at('/import/stock-items'), { file: b64(items) })
  assert.deepEqual([ii.created, ii.failed], [1, []])
  const stock: { name: string; openingValue: number; openingQty: number }[] = await call('GET', at('/stock-items'))
  assert.deepEqual([stock[0].openingQty, stock[0].openingValue], [100_000, R(250)])

  // vouchers: Excel dates, a voucher per date/type/number, one line with an unknown ledger
  const sheet = xlsx('Vouchers', [
    { cells: ['Date', 'Voucher Type', 'Voucher No', 'Ledger', 'Debit', 'Credit', 'Narration'] },
    { cells: [46157, 'Payment', 1, 'Rent', 30000, null, 'May rent'] },
    { cells: [null, null, null, 'HDFC', null, 30000, null] },
    { cells: ['20-05-2026', 'Receipt', 1, 'HDFC', 50000, null, null] },
    { cells: [null, null, null, 'Sales', null, 50000, null] },
    { cells: ['20-08-2026', 'Receipt', 2, 'HDFC', 20000, null, null] },
    { cells: [null, null, null, 'Ram Traders', null, 20000, null] },
    { cells: ['21-05-2026', 'Journal', 9, 'Nobody', 10, null, null] },
    { cells: [null, null, null, 'HDFC', null, 10, null] },
  ])
  const vi = await call('POST', at('/import/vouchers'), { file: b64(sheet) })
  assert.equal(vi.created, 3)
  assert.equal(vi.failed.length, 1)
  assert.match(vi.failed[0].errors[0], /Row 8: unknown ledger "Nobody"/)
  const day = await call('GET', at('/vouchers?from=2026-05-15&to=2026-05-15'))
  assert.ok(JSON.stringify(day).includes('May rent'))

  // F12
  assert.deepEqual((await call('GET', at('/config'))).voucherDate, 'today')
  assert.equal((await call('PUT', at('/config'), { voucherDate: 'last', dayBookNarration: true })).voucherDate, 'last')
  assert.equal((await raw('PUT', at('/config'), { fontSize: 3 })).status, 422)
  assert.equal((await raw('PUT', at('/config'), { showBalances: 'yes' })).status, 422)

  // split at 1 July: the books up to 30 June, and from 1 July with those closing balances as opening
  assert.equal((await raw('POST', at('/split'), { date: '2026-04-01' })).status, 422)
  const split = await call('POST', at('/split'), { date: '2026-07-01' })
  const bal = async (company: number, from: string, to: string) =>
    new Map(((await call('GET', `/companies/${company}/ledgers?from=${from}&to=${to}`)) as { name: string; closing: number }[]).map((l) => [l.name, l.closing]))
  const orig = await bal(c.id, '2026-04-01', '2027-03-31')
  const second = await bal(split.second.id, '2026-07-01', '2027-03-31')
  const first = await bal(split.first.id, '2026-04-01', '2027-03-31')
  assert.equal(second.get('HDFC'), orig.get('HDFC'))
  assert.equal(second.get('Ram Traders'), orig.get('Ram Traders'))
  assert.equal(first.get('HDFC'), R(100000 - 30000 + 50000))
  assert.equal(second.get('Rent'), 0) // income and expenses start afresh
  const bs2 = await call('GET', `/companies/${split.second.id}/reports/balance-sheet?from=2026-07-01&to=2027-03-31`)
  const origBs = await call('GET', at('/reports/balance-sheet?from=2026-04-01&to=2027-03-31'))
  assert.equal(bs2.totalAssets, origBs.totalAssets) // the same position at the year end
  assert.equal(bs2.openingDifference, origBs.openingDifference) // the test's openings don't tally; the split keeps that, no more
  const secondCo = (await call('GET', '/companies')).find((x: { id: number }) => x.id === split.second.id)
  assert.equal(secondCo.booksBegin, '2026-07-01')
  assert.equal((await call('GET', `/companies/${split.first.id}/vouchers?from=2026-08-01&to=2026-08-31`)).length, 0)
  assert.equal((await call('GET', `/companies/${split.second.id}/vouchers?from=2026-07-01&to=2027-03-31`)).length, 1)

  // a group company of the two halves' sibling and a fresh company
  const other = await call('POST', '/companies', { name: `Other ${Date.now()}`, booksBegin: '2026-04-01' })
  const og: { id: number; name: string }[] = await call('GET', `/companies/${other.id}/groups`)
  const obank = (await call('POST', `/companies/${other.id}/ledgers`, { name: 'HDFC', groupId: og.find((x) => x.name === 'Bank Accounts')!.id, opening: R(25000) })).id
  const ocap = (await call('POST', `/companies/${other.id}/ledgers`, { name: 'Capital', groupId: og.find((x) => x.name === 'Capital Account')!.id, opening: -R(25000) })).id
  assert.ok(obank && ocap)
  assert.equal((await raw('POST', '/group-companies', { name: 'Solo', members: [c.id] })).status, 422)
  const grp = (await call('POST', '/group-companies', { name: `Group ${Date.now()}`, members: [c.id, other.id] })).id
  const tb = await call('GET', `/group-companies/${grp}/reports/trial-balance?from=2026-04-01&to=2027-03-31`)
  // ledgers of the same name are one line: HDFC of both companies
  const hdfc = tb.rows.flatMap((r: { ledgers: { name: string; closing: number }[] }) => r.ledgers).filter((l: { name: string }) => l.name === 'HDFC')
  assert.deepEqual(hdfc.map((l: { closing: number }) => l.closing), [orig.get('HDFC')! + R(25000)])
  assert.ok(tb.rows.some((r: { name: string }) => r.name === 'Capital Account'))
  assert.equal(tb.openingDifference, R(99750)) // the first company's openings don't tally, and the group shows it
  // a company with users cannot be a member
  await call('POST', `/companies/${other.id}/users`, { username: 'owner', password: 'secret-pass-1', role: 'Owner' })
  assert.equal((await raw('GET', `/group-companies/${grp}/reports/trial-balance?from=2026-04-01&to=2027-03-31`)).status, 422)
})
