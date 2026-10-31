import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { get } from 'node:https'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'
import { serve, tlsFromEnv } from '../src/serve'
import { handleXml } from '../src/xml/gateway'

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
const Q = (n: number) => n * 1000
const fixture = (f: string) => new URL(`./fixtures/${f}`, import.meta.url)

test('HTTPS with a certificate; both files or neither', async () => {
  const tls = { cert: readFileSync(fixture('localhost-cert.pem'), 'utf8'), key: readFileSync(fixture('localhost-key.pem'), 'utf8') }
  const s = await new Promise<Server>((ok) => {
    const x = serve(createApp(), 0, '127.0.0.1', tls, () => ok(x))
  })
  const port = (s.address() as AddressInfo).port
  const body = await new Promise<string>((ok, fail) =>
    get({ host: '127.0.0.1', port, path: '/api/health', ca: tls.cert, servername: 'localhost' }, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => ok(b))
    }).on('error', fail),
  )
  assert.deepEqual(JSON.parse(body), { ok: true })
  s.close()
  assert.equal(tlsFromEnv({}), undefined)
  assert.throws(() => tlsFromEnv({ TLS_CERT: 'x.pem' }), /both TLS_CERT and TLS_KEY/)
})

test('Tally Audit, POS Register, order analysis, ODBC views, more XML reports', async () => {
  const c = await call('POST', '/companies', { name: `C25 ${Date.now()}`, booksBegin: '2026-04-01' })
  const at = (p: string) => `/companies/${c.id}${p}`
  const groups: { id: number; name: string }[] = await call('GET', at('/groups'))
  const g = (n: string) => groups.find((x) => x.name === n)!.id
  const L = async (name: string, group: string, extra: object = {}) => (await call('POST', at('/ledgers'), { name, groupId: g(group), billwise: false, ...extra })).id as number
  const cash = (await call('GET', at('/ledgers?from=2026-04-01&to=2027-03-31'))).find((l: { name: string }) => l.name === 'Cash').id
  const bank = await L('HDFC', 'Bank Accounts', { opening: R(10000) })
  await L('Capital', 'Capital Account', { opening: -R(10000) })
  const sales = await L('Sales', 'Sales Accounts')
  const rent = await L('Rent', 'Indirect Expenses')
  const cafe = await L('Cafe', 'Sundry Debtors', { billwise: true })

  // Tally Audit
  const v1 = await call('POST', at('/vouchers'), { type: 'Payment', date: '2026-04-05', entries: [{ ledgerId: rent, amount: R(500) }, { ledgerId: bank, amount: -R(500) }] })
  const v2 = await call('POST', at('/vouchers'), { type: 'Payment', date: '2026-04-06', entries: [{ ledgerId: rent, amount: R(700) }, { ledgerId: bank, amount: -R(700) }] })
  await call('POST', at('/vouchers'), { type: 'Payment', date: '2026-04-07', entries: [{ ledgerId: rent, amount: R(900) }, { ledgerId: bank, amount: -R(900) }] })
  await call('PUT', at('/audit'), [{ voucherId: v1.id, status: 'Audited' }, { voucherId: v2.id, status: 'Under Observation', note: 'bill missing' }])
  const full = await call('GET', at(`/vouchers/${v1.id}`))
  await call('PUT', at(`/vouchers/${v1.id}`), { type: 'Payment', date: '2026-04-05', narration: 'changed', version: full.version, entries: [{ ledgerId: rent, amount: R(550) }, { ledgerId: bank, amount: -R(550) }] })
  const audit = await call('GET', at('/reports/tally-audit?from=2026-04-01&to=2026-04-30'))
  assert.deepEqual(audit.vouchers.map((v: { status: string }) => v.status), ['Altered after audit', 'Under Observation', 'Not audited'])
  assert.deepEqual(audit.summary, { total: 3, notAudited: 1, audited: 0, underObservation: 1, alteredAfterAudit: 1 })
  assert.equal(audit.vouchers[0].alterations, 1)
  assert.equal(audit.vouchers[1].mark.note, 'bill missing')
  await call('PUT', at('/audit'), [{ voucherId: v1.id, status: 'Audited' }, { voucherId: v2.id, status: null }])
  assert.deepEqual((await call('GET', at('/reports/tally-audit?from=2026-04-01&to=2026-04-30'))).summary.audited, 1)

  // POS: a Sales voucher type for the counter; cash, card and credit
  assert.equal((await raw('POST', at('/voucher-types'), { name: 'POS Receipt', baseType: 'Receipt', pos: true, numbering: 'auto' })).status, 422)
  const pos = (await call('POST', at('/voucher-types'), { name: 'POS Sale', baseType: 'Sales', pos: true, numbering: 'auto', prefix: 'POS/' })).id
  const sell = (date: string, entries: object[]) => call('POST', at('/vouchers'), { type: 'Sales', voucherTypeId: pos, date, entries })
  await sell('2026-05-01', [{ ledgerId: cash, amount: R(300) }, { ledgerId: bank, amount: R(200) }, { ledgerId: sales, amount: -R(500) }])
  await sell('2026-05-01', [{ ledgerId: cash, amount: R(100) }, { ledgerId: sales, amount: -R(100) }])
  await sell('2026-05-02', [{ ledgerId: cafe, amount: R(250) }, { ledgerId: sales, amount: -R(250) }])
  await call('POST', at('/vouchers'), { type: 'Sales', date: '2026-05-02', entries: [{ ledgerId: cash, amount: R(999) }, { ledgerId: sales, amount: -R(999) }] }) // not POS
  const reg = await call('GET', at('/reports/pos-register?from=2026-05-01&to=2026-05-31'))
  assert.deepEqual(reg.vouchers.map((v: { docNo: string; cash: number; bank: number; credit: number }) => [v.docNo, v.cash, v.bank, v.credit]),
    [['POS/1', R(300), R(200), 0], ['POS/2', R(100), 0, 0], ['POS/3', 0, 0, R(250)]])
  assert.deepEqual(reg.days.map((d: { date: string; count: number; total: number }) => [d.date, d.count, d.total]), [['2026-05-01', 2, R(600)], ['2026-05-02', 1, R(250)]])
  assert.equal(reg.vouchers[2].party, 'Cafe')

  // order analysis by month
  const nos = (await call('POST', at('/units'), { symbol: 'Nos', name: 'Numbers', decimals: 0 })).id
  const main = (await call('GET', at('/godowns'))).find((x: { isDefault: boolean }) => x.isDefault).id
  const cup = (await call('POST', at('/stock-items'), { name: 'Cup', unitId: nos, openingQty: Q(100), openingValue: R(1000), openingGodownId: main })).id
  const order = (date: string, qty: number) =>
    call('POST', at('/vouchers'), { type: 'Sales Order', date, partyId: cafe, entries: [], inventory: [{ itemId: cup, godownId: main, qty: -Q(qty), rate: R(20), amount: -R(20 * qty) }] })
  const o1 = await order('2026-06-03', 30)
  await order('2026-07-10', 10)
  await call('POST', at('/vouchers'), { type: 'Sales', date: '2026-07-15', entries: [{ ledgerId: cafe, amount: R(400) }, { ledgerId: sales, amount: -R(400) }],
    inventory: [{ itemId: cup, godownId: main, qty: -Q(20), rate: R(20), amount: -R(400), orderId: o1.id }] })
  const oa = await call('GET', at('/reports/order-analysis?type=Sales Order&by=item&from=2026-06-01&to=2026-07-31'))
  assert.deepEqual(oa.months, ['2026-06', '2026-07'])
  assert.deepEqual([oa.rows[0].key, oa.rows[0].byMonth['2026-06'].qty, oa.rows[0].byMonth['2026-07'].value, oa.rows[0].done, oa.rows[0].pending], ['Cup', Q(30), R(200), Q(20), Q(20)])
  assert.equal((await call('GET', at('/reports/order-analysis?type=Sales Order&by=party&from=2026-06-01&to=2026-07-31'))).rows[0].key, 'Cafe')

  // ODBC: plain SQL over the views, in rupees
  const { rows } = await pool.query(`SELECT ledger, debit, credit FROM odbc.ledger_entry WHERE company_id = $1 AND voucher_number = 'POS/1' ORDER BY debit DESC`, [c.id])
  assert.deepEqual(rows.map((r) => [r.ledger, Number(r.debit), Number(r.credit)]), [['Cash', 300, 0], ['HDFC', 200, 0], ['Sales', 0, 500]])
  assert.equal(Number((await pool.query(`SELECT opening_balance FROM odbc.ledger WHERE company_id = $1 AND name = 'HDFC'`, [c.id])).rows[0].opening_balance), 10000)
  assert.equal(Number((await pool.query(`SELECT qty FROM odbc.inventory_entry WHERE company_id = $1 AND voucher_type = 'Sales'`, [c.id])).rows[0].qty), -20)

  // XML: Balance Sheet, P&L, Stock Summary, Ledger Vouchers, Bills Receivable
  const xml = (report: string, extra = '') =>
    handleXml(`<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>${report}</ID></HEADER><BODY><DESC><STATICVARIABLES>
      <SVCURRENTCOMPANY>${c.name}</SVCURRENTCOMPANY><SVFROMDATE>20260401</SVFROMDATE><SVTODATE>20270331</SVTODATE>${extra}</STATICVARIABLES></DESC></BODY></ENVELOPE>`)
  assert.match(await xml('Balance Sheet'), /<DSPDISPNAME>Capital Account<\/DSPDISPNAME><\/DSPACCNAME><\/BSNAME><BSAMT><BSSUBAMT><\/BSSUBAMT><BSMAINAMT>10000.00</)
  assert.match(await xml('Profit and Loss'), /<DSPDISPNAME>Sales Accounts<\/DSPDISPNAME>.*<BSMAINAMT>2249.00</)
  assert.match(await xml('Stock Summary'), /<DSPDISPNAME>Cup<\/DSPDISPNAME>[\s\S]*<DSPCLQTY>80.000 Nos<\/DSPCLQTY>/)
  const lv = await xml('Ledger Vouchers', '<LEDGERNAME>Rent</LEDGERNAME>')
  assert.equal((lv.match(/<DSPVCHDATE>/g) ?? []).length, 3)
  assert.match(lv, /<DSPVCHDRAMT>550.00<\/DSPVCHDRAMT>/)
  assert.match(await xml('Ledger Vouchers', '<LEDGERNAME>Nobody</LEDGERNAME>'), /Ledger &quot;Nobody&quot; does not exist/)
  // the POS credit sale left a bill on account? Cafe is bill-wise: the invoice without a bill goes on account, so add one
  await call('POST', at('/vouchers'), { type: 'Sales', date: '2026-08-01', entries: [{ ledgerId: cafe, amount: R(150), bills: [{ type: 'New Ref', name: 'INV-9', amount: R(150) }] }, { ledgerId: sales, amount: -R(150) }] })
  assert.match(await xml('Bills Receivable'), /<BILLREF>INV-9<\/BILLREF><BILLPARTY>Cafe<\/BILLPARTY><\/BILLFIXED><BILLCL>150.00<\/BILLCL>/)
})
