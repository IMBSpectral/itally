/**
 * Group companies, as Tally's: two or more companies whose books are shown together. Groups and
 * ledgers of the same name are one line; each member's Profit & Loss A/c and stock are added in. No
 * inter-company entries are eliminated (as in Tally, the members' books are simply combined).
 * Companies with users and passwords cannot be members: their books open only to a signed-in user.
 */
import { pool } from './db'
import { getCompany, ledgerBalances, loadGroups, STOCK_ITEMS_LINE, ValidationError } from './books'
import { isSecured } from './security'
import { balanceSheet, profitAndLoss, trialBalance, type LedgerBalance } from './engine/reports'
import type { GroupNode } from './engine/groups'

export async function listGroupCompanies() {
  const { rows } = await pool.query<{ id: number; name: string; members: number[] }>(`SELECT id, name, members FROM group_companies ORDER BY lower(name)`)
  const names = new Map((await pool.query<{ id: number; name: string }>(`SELECT id, name FROM companies`)).rows.map((c) => [c.id, c.name]))
  return rows.map((g) => ({ ...g, members: g.members.filter((m) => names.has(m)).map((m) => ({ id: m, name: names.get(m)! })) }))
}

async function check(name: string, members: number[]) {
  const errors: string[] = []
  if (!name.trim()) errors.push('A group company needs a name')
  const unique = [...new Set(members)]
  if (unique.length < 2) errors.push('A group company has two or more member companies')
  for (const m of unique) {
    const c = await getCompany(pool, m)
    if (!c) errors.push(`Unknown company ${m}`)
    else if (await isSecured(m)) errors.push(`${c.name} has users and passwords; its books cannot be shown in a group company`)
  }
  if ((await pool.query(`SELECT 1 FROM companies WHERE lower(name) = lower($1)`, [name.trim()])).rowCount) errors.push(`"${name}" is the name of a company`)
  if (errors.length) throw new ValidationError(errors)
  return unique
}
const taken = (name: string) => (err: { code?: string }) => {
  if (err.code === '23505') throw new ValidationError([`The name "${name}" is already used by another group company`])
  throw err
}

export async function createGroupCompany(name: string, members: number[]) {
  const m = await check(name, members)
  return (await pool.query<{ id: number }>(`INSERT INTO group_companies (name, members) VALUES ($1,$2) RETURNING id`, [name.trim(), m]).catch(taken(name))).rows[0].id
}
export async function alterGroupCompany(id: number, name: string, members: number[]) {
  const m = await check(name, members)
  const { rowCount } = await pool.query(`UPDATE group_companies SET name = $2, members = $3 WHERE id = $1`, [id, name.trim(), m]).catch(taken(name))
  if (!rowCount) throw new ValidationError([`Unknown group company ${id}`])
}
export async function deleteGroupCompany(id: number) {
  await pool.query(`DELETE FROM group_companies WHERE id = $1`, [id])
}

/**
 * The members' groups and ledger balances as one company's: groups by name (a member's own group
 * goes under its parent's name), ledgers by name. Ids are made afresh.
 */
async function consolidated(memberIds: number[], from: string, to: string) {
  const groups = new Map<number, GroupNode>()
  const groupIdByName = new Map<string, number>()
  const balances = new Map<string, LedgerBalance>()
  let nextLedger = 1
  for (const m of memberIds) {
    const own = await loadGroups(pool, m)
    // parents first, so each group's parent is already known by name
    const depth = (g: GroupNode): number => (g.parentId === null ? 0 : 1 + depth(own.get(g.parentId)!))
    for (const g of [...own.values()].sort((a, b) => depth(a) - depth(b))) {
      if (groupIdByName.has(g.name)) continue
      const id = groups.size + 1
      const parentId = g.parentId === null ? null : groupIdByName.get(own.get(g.parentId)!.name)!
      groups.set(id, { ...g, id, parentId })
      groupIdByName.set(g.name, id)
    }
    for (const b of await ledgerBalances(pool, m, from, to)) {
      const groupId = b.groupId === null ? null : groupIdByName.get(own.get(b.groupId)!.name)!
      const key = b.id === STOCK_ITEMS_LINE ? '\u0000stock' : b.name
      const was = balances.get(key)
      if (was) {
        was.opening += b.opening
        was.closing += b.closing
        if (b.stockValue !== undefined) was.stockValue = (was.stockValue ?? 0) + b.stockValue
      } else balances.set(key, { ...b, id: b.id === STOCK_ITEMS_LINE ? STOCK_ITEMS_LINE : nextLedger++, groupId })
    }
  }
  return { groups, balances: [...balances.values()] }
}

/** A group company's consolidated Trial Balance, Profit & Loss A/c or Balance Sheet for a period. */
export async function groupReport(id: number, report: 'trial-balance' | 'profit-loss' | 'balance-sheet', from: string, to: string) {
  const g = (await listGroupCompanies()).find((x) => x.id === id)
  if (!g) throw new ValidationError([`Unknown group company ${id}`])
  if (g.members.length < 2) throw new ValidationError(['A member company was deleted; the group company needs two or more'])
  for (const m of g.members) if (await isSecured(m.id)) throw new ValidationError([`${m.name} now has users and passwords; take it out of the group company`])
  const { groups, balances } = await consolidated(g.members.map((m) => m.id), from, to)
  const build = { 'trial-balance': trialBalance, 'profit-loss': profitAndLoss, 'balance-sheet': balanceSheet }[report]
  return { name: g.name, members: g.members, from, to, ...build(groups, balances) }
}
