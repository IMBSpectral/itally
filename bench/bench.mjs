// Speed benchmark over Tally's XML interface, so the same requests can hit Spectral Tally
// or a real TallyPrime (port 9000) and the numbers compare like for like.
//
//   node bench/bench.mjs --xml http://127.0.0.1:9010 --target spectral-pg --api http://127.0.0.1:4100
//   node bench/bench.mjs --xml http://127.0.0.1:9000 --target tallyprime --company "Bench Co"
//
// --api (Spectral only) creates a fresh company first; for TallyPrime, create the company in
// Tally, load it, and pass its name with --company. Results go to bench/results/<target>.json.
// Voucher dates use only the 1st, 2nd and 31st of each month, the dates TallyPrime's
// Educational mode accepts, so the identical dataset also runs on an unlicensed Tally.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : dflt
}
const xmlUrl = arg('xml', 'http://127.0.0.1:9010')
const target = arg('target', 'spectral')
const apiUrl = arg('api')
const parties = Number(arg('parties', 200))
const vouchers = Number(arg('vouchers', 5000))
const batch = Number(arg('batch', 500))
let company = arg('company', `Bench ${Date.now()}`)

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const post = async (body) => {
  const t = performance.now()
  const res = await fetch(xmlUrl, { method: 'POST', headers: { 'content-type': 'text/xml' }, body })
  const text = await res.text()
  return { ms: performance.now() - t, text }
}
const tag = (xml, t) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(xml)?.[1]
const importEnv = (msgs) =>
  `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME>` +
  `<STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${msgs}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`
const exportEnv = (report, from, to) =>
  `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>${report}</REPORTNAME>` +
  `<STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY><SVFROMDATE>${from}</SVFROMDATE><SVTODATE>${to}</SVTODATE>` +
  `<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`

// ---------------------------------------------------------------- dataset (deterministic)
let seed = 42
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
const ledger = (name, parent, opening = 0) =>
  `<TALLYMESSAGE><LEDGER NAME="${esc(name)}" ACTION="Create"><NAME>${esc(name)}</NAME><PARENT>${parent}</PARENT>` +
  (opening ? `<OPENINGBALANCE>${(-opening).toFixed(2)}</OPENINGBALANCE>` : '') + `</LEDGER></TALLYMESSAGE>`
const masters = [
  ledger('Bench Bank', 'Bank Accounts'),
  ledger('Bench Capital', 'Capital Account'),
  ledger('Bench Sales', 'Sales Accounts'),
  ledger('Bench Purchases', 'Purchase Accounts'),
  ledger('Bench Rent', 'Indirect Expenses'),
  ...Array.from({ length: parties }, (_, i) => ledger(`Customer ${String(i + 1).padStart(4, '0')}`, 'Sundry Debtors')),
  ...Array.from({ length: parties / 4 }, (_, i) => ledger(`Supplier ${String(i + 1).padStart(4, '0')}`, 'Sundry Creditors')),
]
const DAYS = ['01', '02']
const MONTHS = ['202604', '202605', '202606', '202607', '202608', '202609', '202610', '202611', '202612', '202701', '202702', '202703']
const line = (name, dr, amt) =>
  `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(name)}</LEDGERNAME><ISDEEMEDPOSITIVE>${dr ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>` +
  `<AMOUNT>${(dr ? -amt : amt).toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`
function voucher(i) {
  const date = MONTHS[i % 12] + DAYS[Math.floor(i / 12) % 2]
  const amt = Math.round(rand() * 100000) / 100 + 100
  const cust = `Customer ${String((i % parties) + 1).padStart(4, '0')}`
  const sup = `Supplier ${String((i % (parties / 4)) + 1).padStart(4, '0')}`
  const [type, a, b] = [
    ['Sales', [cust, true], ['Bench Sales', false]],
    ['Receipt', ['Bench Bank', true], [cust, false]],
    ['Purchase', ['Bench Purchases', true], [sup, false]],
    ['Payment', [sup, true], ['Bench Bank', false]],
    ['Payment', ['Bench Rent', true], ['Bench Bank', false]],
  ][i % 5]
  return `<TALLYMESSAGE><VOUCHER VCHTYPE="${type}" ACTION="Create"><DATE>${date}</DATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME>` +
    `<NARRATION>bench ${i}</NARRATION>${line(a[0], a[1], amt)}${line(b[0], b[1], amt)}</VOUCHER></TALLYMESSAGE>`
}

// ---------------------------------------------------------------- run
if (apiUrl) {
  const res = await fetch(`${apiUrl}/api/companies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: company, booksBegin: '2026-04-01' }),
  })
  if (!res.ok) throw new Error(`could not create company: ${await res.text()}`)
}
const ping = await fetch(xmlUrl).then((r) => r.text()).catch((e) => `unreachable: ${e.message}`)
console.log(`target ${target} at ${xmlUrl}: ${ping.trim().slice(0, 80)}`)
console.log(`company "${company}", ${masters.length} ledgers, ${vouchers} vouchers`)

const metrics = []
const record = (name, value, unit) => {
  metrics.push({ name, value: Math.round(value * 10) / 10, unit })
  console.log(`  ${name.padEnd(34)} ${Math.round(value * 10) / 10} ${unit}`)
}

const m = await post(importEnv(masters.join('')))
const created = Number(tag(m.text, 'CREATED') ?? 0)
if (created < masters.length) console.log(`  warning: ${created}/${masters.length} ledgers created; ${tag(m.text, 'LINEERROR') ?? m.text.slice(0, 300)}`)
record('import ledgers', m.ms, 'ms')

let importMs = 0
let ok = 0
const errors = []
for (let i = 0; i < vouchers; i += batch) {
  const r = await post(importEnv(Array.from({ length: Math.min(batch, vouchers - i) }, (_, k) => voucher(i + k)).join('')))
  importMs += r.ms
  ok += Number(tag(r.text, 'CREATED') ?? 0)
  if (Number(tag(r.text, 'ERRORS') ?? 0)) errors.push(tag(r.text, 'LINEERROR'))
}
if (ok < vouchers) console.log(`  warning: ${ok}/${vouchers} vouchers imported; first error: ${errors[0]}`)
record('import vouchers (throughput)', (ok / importMs) * 1000, 'vch/s')

const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]
for (const [name, report] of [['trial balance (full year)', 'Trial Balance'], ['day book (full year)', 'Day Book'], ['list of accounts', 'List of Accounts']]) {
  const times = []
  let size = 0
  for (let k = 0; k < 5; k++) {
    const r = await post(exportEnv(report, '20260401', '20270331'))
    times.push(r.ms)
    size = r.text.length
  }
  record(name, median(times), 'ms')
  if (size < 200) console.log(`  note: ${report} reply was only ${size} bytes`)
}

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results')
mkdirSync(out, { recursive: true })
writeFileSync(
  path.join(out, `${target}.json`),
  JSON.stringify({ target, date: new Date().toISOString(), dataset: `${masters.length} ledgers, ${ok} vouchers`, metrics }, null, 1),
)
