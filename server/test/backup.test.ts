import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { gunzipSync, gzipSync } from 'node:zlib'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import {
  alterGroup, bankEntries, cancelVoucher, createCompany, createGroup, createLedger, ledgerBalances, loadGroups,
  pendingBills, postVoucher, setBankDates, setOpeningBills, setStockValue,
} from '../src/books'
import { backupCompany, restoreCompany } from '../src/backup'
import { balanceSheet, profitAndLoss, trialBalance } from '../src/engine/reports'

const R = (rupees: number) => rupees * 100
before(() => migrate(() => {}))
after(() => pool.end())

async function richCompany() {
  const name = `Backup Co ${Date.now()}-${Math.random()}`
  const companyId = await createCompany({ name, booksBegin: '2026-04-01' })
  const groups = await loadGroups(pool, companyId)
  const g = (n: string) => [...groups.values()].find((x) => x.name === n)!.id
  // a user group created later and then moved under another user group (parents-first order matters)
  const north = await createGroup(companyId, { name: 'North Debtors', parentId: g('Sundry Debtors') })
  const regions = await createGroup(companyId, { name: 'Regions', parentId: g('Sundry Debtors') })
  await alterGroup(companyId, north, { name: 'North Debtors', parentId: regions })
  const cash = (await pool.query(`SELECT id FROM ledgers WHERE company_id = $1 AND name = 'Cash'`, [companyId])).rows[0].id
  const bank = await createLedger(companyId, { name: 'Axis', groupId: g('Bank Accounts'), opening: R(5000) })
  const cap = await createLedger(companyId, { name: 'Capital', groupId: g('Capital Account'), opening: -R(9000) })
  const stock = await createLedger(companyId, { name: 'Stock', groupId: g('Stock-in-Hand'), opening: R(1000) })
  const party = await createLedger(companyId, { name: 'Kiran & Sons', groupId: north, opening: R(3000), creditDays: 15 })
  const sales = await createLedger(companyId, { name: 'Sales', groupId: g('Sales Accounts') })
  const rent = await createLedger(companyId, { name: 'Rent', groupId: g('Indirect Expenses') })
  void cap
  await setOpeningBills(companyId, party, [{ name: 'OB-7', billDate: '2026-03-20', amount: R(3000) }])
  await setStockValue(companyId, stock, '2027-03-31', R(1500))
  await postVoucher(companyId, { type: 'Sales', date: '2026-04-05', narration: 'inv & co <ok>', entries: [
    { ledgerId: party, amount: R(4000), bills: [{ type: 'New Ref', name: 'INV-1', dueDate: '2026-05-01', amount: R(4000) }] },
    { ledgerId: sales, amount: -R(4000) }] })
  await postVoucher(companyId, { type: 'Receipt', date: '2026-04-20', entries: [
    { ledgerId: bank, amount: R(5000) },
    { ledgerId: party, amount: -R(5000), bills: [{ type: 'Agst Ref', name: 'OB-7', amount: -R(3000) }, { type: 'Agst Ref', name: 'INV-1', amount: -R(2000) }] }] })
  const p = await postVoucher(companyId, { type: 'Payment', date: '2026-04-25', entries: [{ ledgerId: rent, amount: R(800) }, { ledgerId: bank, amount: -R(800) }] })
  const cancelled = await postVoucher(companyId, { type: 'Payment', date: '2026-04-26', entries: [{ ledgerId: rent, amount: R(1) }, { ledgerId: cash, amount: -R(1) }] })
  await cancelVoucher(companyId, cancelled.id)
  const [e] = (await bankEntries(pool, companyId, bank, '2026-04-01', '2027-03-31')).filter((x) => x.voucherId === p.id)
  await setBankDates(companyId, [{ entryId: e.entryId, bankDate: '2026-04-27' }])
  return { name, companyId }
}

/** Everything a user can see about a company, with database ids replaced by names. */
async function picture(companyId: number) {
  const groups = await loadGroups(pool, companyId)
  const b = await ledgerBalances(pool, companyId, '2026-04-01', '2027-03-31')
  const strip = (x: unknown) => JSON.parse(JSON.stringify(x, (k, v) => (['id', 'groupId', 'stockGroupId', 'ledgerId', 'entryId', 'voucherId'].includes(k) ? undefined : v)))
  const bank = b.find((x) => x.name === 'Axis')!
  const { rows: vouchers } = await pool.query(
    `SELECT v.type, v.number, to_char(v.date,'YYYY-MM-DD') date, v.narration, v.cancelled, v.version,
            (SELECT json_agg(json_build_object('l', l.name, 'a', e.amount, 'bd', to_char(e.bank_date,'YYYY-MM-DD')) ORDER BY e.line)
               FROM entries e JOIN ledgers l ON l.id = e.ledger_id WHERE e.voucher_id = v.id) entries
       FROM vouchers v WHERE v.company_id = $1 ORDER BY v.type, v.number`,
    [companyId],
  )
  return strip({
    tb: trialBalance(groups, b),
    pl: profitAndLoss(groups, b),
    bs: balanceSheet(groups, b),
    bills: await pendingBills(pool, companyId, '2027-03-31'),
    bank: await bankEntries(pool, companyId, bank.id, '2026-04-01', '2027-03-31', true),
    vouchers,
    counters: (await pool.query(`SELECT type, last FROM voucher_counters WHERE company_id = $1 ORDER BY type`, [companyId])).rows,
  })
}

test('backup and restore: the restored company reads exactly like the original', async () => {
  const { name, companyId } = await richCompany()
  const { file } = await backupCompany(companyId)
  assert.equal(file[0], 0x1f) // gzip
  const restored = await restoreCompany(file)
  assert.equal(restored.name, `${name} (restored)`)
  assert.deepEqual(await picture(restored.id), await picture(companyId))
  // numbering continues where it left off
  const { rows } = await pool.query(`SELECT last FROM voucher_counters WHERE company_id = $1 AND type = 'Payment'`, [restored.id])
  assert.equal(rows[0].last, 2)
  // the history came along, and the restore itself is on record
  const log = (await pool.query(`SELECT actor FROM edit_log WHERE company_id = $1`, [restored.id])).rows.map((r) => r.actor)
  assert.ok(log.filter((a) => a === 'local user').length > 30)
  assert.ok(log.some((a) => a.startsWith('restore from backup of')))
  // a second restore gets its own name
  assert.equal((await restoreCompany(file)).name, `${name} (restored 2)`)
})

test('restore refuses files that are not backups, and tampered books, without leaving anything behind', async () => {
  const { companyId } = await richCompany()
  const count = async () => (await pool.query(`SELECT count(*)::int n FROM companies`)).rows[0].n
  await assert.rejects(restoreCompany(Buffer.from('hello')), /not a Spectral Tally backup/)
  await assert.rejects(restoreCompany(gzipSync(JSON.stringify({ format: 'spectral-tally-backup', version: 99 }))), /newer version/)
  const doc = JSON.parse(gunzipSync((await backupCompany(companyId)).file).toString('utf8'))
  doc.company.name += ' tampered'
  doc.vouchers[0].entries[0].amount += 1 // one paisa out of balance
  const before = await count()
  await assert.rejects(restoreCompany(gzipSync(JSON.stringify(doc))), /not balanced|add up to/)
  assert.equal(await count(), before)
})
