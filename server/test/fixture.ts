import { DEFAULT_GROUPS, type GroupNode } from '../src/engine/groups'
import type { LedgerBalance } from '../src/engine/reports'
import type { LedgerRef, VoucherInput } from '../src/engine/voucher'

/** An in-memory company: default groups, named ledgers, and posting that mimics the database. */
export function makeCompany() {
  const groups = new Map<number, GroupNode>()
  const groupId = new Map<string, number>()
  DEFAULT_GROUPS.forEach((g, i) => groupId.set(g.name, i + 1))
  DEFAULT_GROUPS.forEach((g, i) =>
    groups.set(i + 1, {
      id: i + 1,
      name: g.name,
      parentId: g.parent ? groupId.get(g.parent)! : null,
      nature: g.nature,
      affectsGrossProfit: g.affectsGrossProfit,
    }),
  )
  const ledgers = new Map<number, LedgerRef>()
  const balances = new Map<number, LedgerBalance>()
  const byName = new Map<string, number>()

  function ledger(name: string, group: string | null, opening = 0) {
    const id = ledgers.size + 1
    const gid = group === null ? null : groupId.get(group)
    if (gid === undefined) throw new Error(`no group ${group}`)
    ledgers.set(id, { id, name, groupId: gid })
    balances.set(id, { id, name, groupId: gid, opening, closing: opening })
    byName.set(name, id)
    return id
  }
  const id = (name: string) => byName.get(name)!

  function post(v: VoucherInput) {
    for (const e of v.entries) balances.get(e.ledgerId)!.closing += e.amount
  }

  function setStockValue(name: string, value: number) {
    balances.get(id(name))!.stockValue = value
  }

  return { groups, ledgers, ledger, id, post, setStockValue, balances: () => [...balances.values()] }
}
