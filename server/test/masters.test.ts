import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import {
  alterGroup,
  alterLedger,
  createCompany,
  createGroup,
  createLedger,
  deleteGroup,
  deleteLedger,
  getLedger,
  loadGroups,
  postVoucher,
  setStockValue,
} from '../src/books'

before(() => migrate(() => {}))
after(() => pool.end())

async function setup() {
  const companyId = await createCompany({ name: `Masters ${Date.now()}-${Math.random()}`, booksBegin: '2026-04-01' })
  const groups = await loadGroups(pool, companyId)
  const g = (n: string) => [...groups.values()].find((x) => x.name === n)!.id
  const { rows } = await pool.query(`SELECT id, name FROM ledgers WHERE company_id = $1`, [companyId])
  const ledger = (n: string) => rows.find((r) => r.name === n)!.id as number
  return { companyId, g, cash: ledger('Cash'), pl: ledger('Profit & Loss A/c') }
}

const rejects = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: Error) => re.test(e.message))

test('alter a ledger: rename, regroup, opening; the name stays unique', async () => {
  const { companyId, g } = await setup()
  const id = await createLedger(companyId, { name: 'Ravi', groupId: g('Sundry Debtors'), opening: 5000 })
  await createLedger(companyId, { name: 'Sonal', groupId: g('Sundry Debtors') })
  await alterLedger(companyId, id, { name: 'Ravi Enterprises', groupId: g('Sundry Creditors'), opening: -7000, gstin: '27AAPFU0939F1ZV' })
  const l = await getLedger(pool, companyId, id)
  assert.deepEqual([l.name, l.groupId, l.opening, l.gstin], ['Ravi Enterprises', g('Sundry Creditors'), -7000, '27AAPFU0939F1ZV'])
  await rejects(alterLedger(companyId, id, { name: 'sonal', groupId: g('Sundry Debtors') }), /already used/)
})

test('alter a ledger: refuses moves that would break the books', async () => {
  const { companyId, g, cash } = await setup()
  const party = await createLedger(companyId, { name: 'Party', groupId: g('Sundry Debtors'), opening: 100 })
  await rejects(alterLedger(companyId, party, { name: 'Party', groupId: g('Indirect Expenses'), opening: 100 }), /cannot carry an opening/)

  const sales = await createLedger(companyId, { name: 'Sales', groupId: g('Sales Accounts') })
  await postVoucher(companyId, { type: 'Sales', date: '2026-04-02', entries: [{ ledgerId: cash, amount: 100 }, { ledgerId: sales, amount: -100 }] })
  await rejects(alterLedger(companyId, sales, { name: 'Sales', groupId: g('Stock-in-Hand') }), /with vouchers cannot move under Stock-in-Hand/)

  const stock = await createLedger(companyId, { name: 'Stock', groupId: g('Stock-in-Hand'), opening: 100 })
  await setStockValue(companyId, stock, '2026-06-30', 200)
  await rejects(alterLedger(companyId, stock, { name: 'Stock', groupId: g('Current Assets'), opening: 100 }), /must stay under Stock-in-Hand/)
})

test('Profit & Loss A/c: opening can change, name and deletion cannot', async () => {
  const { companyId, pl } = await setup()
  await alterLedger(companyId, pl, { name: 'Profit & Loss A/c', groupId: 0, opening: -50000 })
  assert.equal((await getLedger(pool, companyId, pl)).opening, -50000)
  await rejects(alterLedger(companyId, pl, { name: 'Retained Earnings', groupId: 0 }), /cannot be renamed/)
  await rejects(deleteLedger(companyId, pl), /cannot be deleted/)
})

test('delete a ledger only while it has no vouchers', async () => {
  const { companyId, g, cash } = await setup()
  const rent = await createLedger(companyId, { name: 'Rent', groupId: g('Indirect Expenses') })
  const spare = await createLedger(companyId, { name: 'Spare', groupId: g('Indirect Expenses') })
  await postVoucher(companyId, { type: 'Payment', date: '2026-04-02', entries: [{ ledgerId: rent, amount: 100 }, { ledgerId: cash, amount: -100 }] })
  await rejects(deleteLedger(companyId, rent), /has vouchers/)
  await deleteLedger(companyId, spare)
  assert.equal(await getLedger(pool, companyId, spare), undefined)
})

test('alter a group: rename, move, nature follows the new parent down the branch', async () => {
  const { companyId, g } = await setup()
  const branch = await createGroup(companyId, { name: 'Branch Debtors', parentId: g('Sundry Debtors') })
  const north = await createGroup(companyId, { name: 'North', parentId: branch })
  await createLedger(companyId, { name: 'N1', groupId: north })

  await alterGroup(companyId, branch, { name: 'Branch Expenses', parentId: g('Indirect Expenses') })
  const groups = await loadGroups(pool, companyId)
  assert.equal(groups.get(branch)!.name, 'Branch Expenses')
  assert.equal(groups.get(branch)!.nature, 'Expenses')
  assert.equal(groups.get(north)!.nature, 'Expenses') // the sub-group followed

  await rejects(alterGroup(companyId, branch, { name: 'Loop', parentId: north }), /under itself/)
  await rejects(alterGroup(companyId, branch, { name: 'Loop', parentId: branch }), /under itself/)
  await rejects(alterGroup(companyId, g('Sundry Debtors'), { name: 'Debtors', parentId: g('Current Assets') }), /predefined/)
})

test('alter a group: refuses to carry opening balances into income or expenses', async () => {
  const { companyId, g } = await setup()
  const grp = await createGroup(companyId, { name: 'Advances', parentId: g('Current Assets') })
  await createLedger(companyId, { name: 'Advance to Raj', groupId: grp, opening: 900 })
  await rejects(alterGroup(companyId, grp, { name: 'Advances', parentId: g('Indirect Expenses') }), /Advance to Raj/)
  // nothing changed
  assert.equal((await loadGroups(pool, companyId)).get(grp)!.nature, 'Assets')
})

test('delete a group only when empty; predefined groups never', async () => {
  const { companyId, g } = await setup()
  const a = await createGroup(companyId, { name: 'A', parentId: g('Current Assets') })
  const b = await createGroup(companyId, { name: 'B', parentId: a })
  await rejects(deleteGroup(companyId, a), /still has/)
  await deleteGroup(companyId, b)
  await deleteGroup(companyId, a)
  await rejects(deleteGroup(companyId, g('Bank Accounts')), /predefined/)
})
