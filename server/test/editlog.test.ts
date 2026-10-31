import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { alterLedger, alterVoucher, cancelVoucher, createCompany, createLedger, deleteVoucher, loadGroups, postVoucher, postVouchers } from '../src/books'

const R = (rupees: number) => rupees * 100
before(() => migrate(() => {}))
after(() => pool.end())

const log = async (companyId: number, entity?: string) =>
  (await pool.query(
    `SELECT entity, entity_id, action, label, data FROM edit_log WHERE company_id = $1 AND ($2::text IS NULL OR entity = $2) ORDER BY id`,
    [companyId, entity ?? null],
  )).rows

async function setup() {
  const companyId = await createCompany({ name: `Log ${Date.now()}-${Math.random()}`, booksBegin: '2026-04-01' })
  const groups = await loadGroups(pool, companyId)
  const g = (n: string) => [...groups.values()].find((x) => x.name === n)!.id
  const cash = (await pool.query(`SELECT id FROM ledgers WHERE company_id = $1 AND name = 'Cash'`, [companyId])).rows[0].id
  const rent = await createLedger(companyId, { name: 'Rent', groupId: g('Indirect Expenses') })
  return { companyId, g, cash, rent }
}

test('a new company logs itself, its groups and its default ledgers', async () => {
  const { companyId } = await setup()
  const rows = await log(companyId)
  assert.equal(rows.filter((r) => r.entity === 'company').length, 1)
  assert.equal(rows.filter((r) => r.entity === 'group' && r.action === 'create').length, 28)
  assert.deepEqual(rows.filter((r) => r.entity === 'ledger').map((r) => r.label), ['Cash', 'Profit & Loss A/c', 'Rent'])
})

test('every voucher change is logged with the full voucher: create, alter, cancel, delete', async () => {
  const { companyId, cash, rent } = await setup()
  const v = await postVoucher(companyId, { type: 'Payment', date: '2026-04-10', narration: 'first', entries: [{ ledgerId: rent, amount: R(100) }, { ledgerId: cash, amount: -R(100) }] })
  await alterVoucher(companyId, v.id, { type: 'Payment', date: '2026-04-11', narration: 'second', entries: [{ ledgerId: rent, amount: R(150) }, { ledgerId: cash, amount: -R(150) }] })
  await cancelVoucher(companyId, v.id)
  const w = await postVoucher(companyId, { type: 'Payment', date: '2026-04-12', entries: [{ ledgerId: rent, amount: R(5) }, { ledgerId: cash, amount: -R(5) }] })
  await deleteVoucher(companyId, w.id)

  const rows = await log(companyId, 'voucher')
  assert.deepEqual(rows.map((r) => [r.label, r.action]), [
    ['Payment No. 1', 'create'], ['Payment No. 1', 'alter'], ['Payment No. 1', 'cancel'], ['Payment No. 2', 'create'], ['Payment No. 2', 'delete'],
  ])
  // each version is the whole voucher as it then stood
  assert.equal(rows[0].data.narration, 'first')
  assert.deepEqual(rows[0].data.entries.map((e: { ledger: string; amount: number }) => [e.ledger, e.amount]), [['Rent', R(100)], ['Cash', -R(100)]])
  assert.equal(rows[1].data.date, '2026-04-11')
  assert.equal(rows[1].data.entries[0].amount, R(150))
  assert.equal(rows[2].data.cancelled, true)
  assert.deepEqual(rows[2].data.entries, [])
  assert.equal(rows[4].data.entries[0].amount, R(5)) // what was deleted
})

test('bulk imports log every voucher too, and masters log their alterations', async () => {
  const { companyId, g, cash, rent } = await setup()
  const res = await postVouchers(companyId, Array.from({ length: 30 }, (_, i) => ({
    type: 'Payment' as const, date: '2026-04-15', entries: [{ ledgerId: rent, amount: R(i + 1) }, { ledgerId: cash, amount: -R(i + 1) }],
  })))
  assert.ok(res.every((r) => r.ok))
  assert.equal((await log(companyId, 'voucher')).length, 30)
  await alterLedger(companyId, rent, { name: 'Office Rent', groupId: g('Indirect Expenses') })
  const led = (await log(companyId, 'ledger')).filter((r) => r.entity_id === rent)
  assert.deepEqual(led.map((r) => [r.action, r.label]), [['create', 'Rent'], ['alter', 'Office Rent']])
})

test('the log cannot be edited, deleted or truncated, and survives deleting the company', async () => {
  const { companyId } = await setup()
  await assert.rejects(pool.query(`UPDATE edit_log SET label = 'x' WHERE company_id = $1`, [companyId]), /cannot be changed/)
  await assert.rejects(pool.query(`DELETE FROM edit_log WHERE company_id = $1`, [companyId]), /cannot be changed/)
  await assert.rejects(pool.query(`TRUNCATE edit_log`), /cannot be changed/)
  const before = (await log(companyId)).length
  await pool.query(`DELETE FROM companies WHERE id = $1`, [companyId])
  const rows = await log(companyId)
  assert.ok(rows.length > before)
  assert.ok(rows.some((r) => r.entity === 'company' && r.action === 'delete'))
  assert.ok(rows.some((r) => r.entity === 'ledger' && r.action === 'delete')) // its ledgers went with it, on record
})

test('a batch import logs each voucher exactly as a single posting does, and still checks the balance', async () => {
  const one = await setup()
  const many = await setup()
  const debtor = async (s: typeof one) => {
    const id = await createLedger(s.companyId, { name: 'Bistro', groupId: s.g('Sundry Debtors'), billwise: true })
    const sales = await createLedger(s.companyId, { name: 'Sales', groupId: s.g('Sales Accounts') })
    return { id, sales }
  }
  const [a, b] = [await debtor(one), await debtor(many)]
  const vouchers = (s: typeof one, d: { id: number; sales: number }) => [
    { type: 'Payment' as const, date: '2026-04-10', narration: 'rent', entries: [{ ledgerId: s.rent, amount: R(500) }, { ledgerId: s.cash, amount: -R(500) }] },
    { type: 'Sales' as const, date: '2026-04-11', entries: [
      { ledgerId: d.id, amount: R(900), bills: [{ type: 'New Ref' as const, name: 'INV-1', amount: R(900) }] },
      { ledgerId: d.sales, amount: -R(900) },
    ] },
  ]
  for (const v of vouchers(one, a)) await postVoucher(one.companyId, v)
  const r = await postVouchers(many.companyId, vouchers(many, b))
  assert.ok(r.every((x) => x.ok))
  const strip = (rows: Awaited<ReturnType<typeof log>>) =>
    rows.map(({ entity_id: _, data, ...x }) => ({ ...x, data: { ...data, entries: data.entries.map(({ ledgerId: _l, ...e }: { ledgerId: number }) => e) } }))
  assert.deepEqual(strip(await log(many.companyId, 'voucher')), strip(await log(one.companyId, 'voucher')))
  // the daily ledger totals the reports read come out the same as from the row trigger
  const daily = async (cid: number) =>
    (await pool.query(`SELECT l.name, to_char(d.day,'YYYY-MM-DD') "on", d.dr::bigint dr, d.cr::bigint cr FROM ledger_daily d JOIN ledgers l ON l.id = d.ledger_id
      WHERE l.company_id = $1 AND (d.dr <> 0 OR d.cr <> 0) ORDER BY 1, 2`, [cid])).rows
  assert.deepEqual(await daily(many.companyId), await daily(one.companyId))
  // the next change after a batch is logged by the row trigger again
  const [pay] = await postVouchers(many.companyId, [vouchers(many, b)[0]])
  await cancelVoucher(many.companyId, (pay as { id: number }).id)
  assert.deepEqual((await log(many.companyId, 'voucher')).map((x) => x.action), ['create', 'create', 'create', 'cancel'])

  // the batch check is the database's own rule: an unbalanced voucher still can't get in
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    const { rows } = await c.query(`INSERT INTO vouchers (company_id, type, number, date) VALUES ($1, 'Journal', 999, '2026-04-12') RETURNING id`, [one.companyId])
    await c.query(`INSERT INTO entries (voucher_id, line, ledger_id, amount) VALUES ($1, 1, $2, 100), ($1, 2, $3, -99)`, [rows[0].id, one.rent, a.id])
    await c.query(`SELECT set_config('app.voucher_batch', 'on', true)`)
    await assert.rejects(c.query('SELECT close_voucher_batch($1)', [[rows[0].id]]), /is not balanced/)
    await c.query('ROLLBACK')
    // nor an entry on another company's ledger
    await c.query('BEGIN')
    await c.query(`SELECT set_config('app.voucher_batch', 'on', true)`)
    const v2 = (await c.query(`INSERT INTO vouchers (company_id, type, number, date) VALUES ($1, 'Payment', 998, '2026-04-12') RETURNING id`, [one.companyId])).rows[0].id
    await c.query(`INSERT INTO entries (voucher_id, line, ledger_id, amount) VALUES ($1, 1, $2, 100), ($1, 2, $3, -100)`, [v2, one.rent, many.cash])
    await assert.rejects(c.query('SELECT close_voucher_batch($1)', [[v2]]), /belongs to another company/)
  } finally {
    await c.query('ROLLBACK')
    c.release()
  }
})
