/**
 * Interest Calculations: one ledger's interest for a period (on its balance, or on its overdue
 * bills), and the Interest Receivable / Payable and Group views that add them up.
 */
import { pool, type Tx } from './db'

type Db = Tx | typeof pool
import { ledgerBalances, loadGroups, loadLedgers, postVoucher, ValidationError } from './books'
import { isUnder } from './engine/groups'
import { billStretches, stretches, type InterestBill, type Stretch } from './engine/interest'

export interface LedgerInterest {
  id: number
  name: string
  groupId: number | null
  rate: number // hundredths of a percent a year
  on: 'balance' | 'bills'
  stretches: (Stretch & { bill?: string })[]
  interest: number // + receivable (Dr), - payable (Cr)
}

/** The bills of one ledger with the dates they fall due and settle, for interest on bills. */
async function interestBills(db: Db, ledgerId: number, to: string): Promise<InterestBill[]> {
  const { rows } = await db.query<{ name: string; kind: string; date: string; due: string | null; amount: number }>(
    `SELECT a.name, a.ref_type kind, to_char(v.date,'YYYY-MM-DD') date,
            to_char(COALESCE(a.due_date, v.date + COALESCE(l.credit_days, 0)),'YYYY-MM-DD') due, a.amount
       FROM bill_allocations a JOIN entries e ON e.id = a.entry_id JOIN vouchers v ON v.id = e.voucher_id JOIN ledgers l ON l.id = a.ledger_id
      WHERE a.ledger_id = $1 AND a.name IS NOT NULL AND v.date <= $2
     UNION ALL
     SELECT ob.name, 'Opening', to_char(ob.bill_date,'YYYY-MM-DD'),
            to_char(COALESCE(ob.due_date, ob.bill_date + COALESCE(l.credit_days, 0)),'YYYY-MM-DD'), ob.amount
       FROM opening_bills ob JOIN ledgers l ON l.id = ob.ledger_id WHERE ob.ledger_id = $1
     ORDER BY 3`,
    [ledgerId, to],
  )
  const bills = new Map<string, InterestBill>()
  for (const r of rows) {
    const key = r.name.toLowerCase()
    const amount = Number(r.amount)
    if (r.kind === 'Agst Ref') {
      const b = bills.get(key)
      if (b) b.settlements.push({ date: r.date, amount })
    } else if (!bills.has(key)) bills.set(key, { name: r.name, dueDate: r.due ?? r.date, amount, settlements: [] })
    else bills.get(key)!.amount += amount // an Advance and a New Ref under one name add up
  }
  return [...bills.values()]
}

/** Interest on one ledger for [from, to]; null if the ledger doesn't calculate interest. */
export async function ledgerInterest(db: Db, companyId: number, ledgerId: number, from: string, to: string): Promise<LedgerInterest | null> {
  const l = (await db.query<{ id: number; name: string; groupId: number | null; rate: number | null; on: 'balance' | 'bills' }>(
    `SELECT id, name, group_id "groupId", interest_rate rate, interest_on "on" FROM ledgers WHERE id = $1 AND company_id = $2`,
    [ledgerId, companyId],
  )).rows[0]
  if (!l?.rate) return null
  let out: LedgerInterest['stretches']
  if (l.on === 'bills') {
    out = billStretches(await interestBills(db, l.id, to), from, to, l.rate).flatMap((b) => b.stretches.map((s) => ({ ...s, bill: b.name })))
  } else {
    const opening = (await ledgerBalances(db, companyId, from, to)).find((b) => b.id === l.id)?.opening ?? 0
    const { rows } = await db.query<{ date: string; amount: number }>(
      `SELECT to_char(d.day,'YYYY-MM-DD') date, (d.dr - d.cr)::bigint amount FROM ledger_daily d
        WHERE d.ledger_id = $1 AND d.day BETWEEN $2 AND $3 AND d.dr <> d.cr`,
      [l.id, from, to],
    )
    out = stretches(opening, rows.map((r) => ({ date: r.date, amount: Number(r.amount) })), from, to, l.rate)
  }
  return { id: l.id, name: l.name, groupId: l.groupId, rate: l.rate, on: l.on, stretches: out, interest: out.reduce((t, s) => t + s.interest, 0) }
}

/**
 * Every interest-bearing ledger's interest for the period. `side` keeps the receivable (Dr) or
 * payable (Cr) ones; `groupId` keeps the ledgers under a group.
 */
export async function interestSummary(companyId: number, from: string, to: string, opts: { side?: 'receivable' | 'payable'; groupId?: number }) {
  const ids = (await pool.query<{ id: number }>(`SELECT id FROM ledgers WHERE company_id = $1 AND interest_rate IS NOT NULL ORDER BY name`, [companyId])).rows
  const groups = opts.groupId ? await loadGroups(pool, companyId) : null
  const group = opts.groupId ? groups!.get(opts.groupId) : null
  if (opts.groupId && !group) return null
  const lines: Omit<LedgerInterest, 'stretches'>[] = []
  for (const { id } of ids) {
    const r = await ledgerInterest(pool, companyId, id, from, to)
    if (!r || !r.interest) continue
    if (opts.side === 'receivable' && r.interest < 0) continue
    if (opts.side === 'payable' && r.interest > 0) continue
    if (group && (r.groupId === null || !isUnder(groups!, r.groupId, [group.name]))) continue
    const { stretches: _, ...line } = r
    lines.push(line)
  }
  return { from, to, title: group?.name ?? null, lines, total: lines.reduce((t, l) => t + l.interest, 0) }
}

/**
 * Books a ledger's interest for a period with a Journal, as Tally's interest voucher does:
 * receivable interest is debited to the party and credited to an income ledger, payable interest
 * debited to an expense ledger and credited to the party. A party kept bill-wise gets it as a new
 * bill named "Interest to <date>".
 */
export async function bookInterest(companyId: number, b: { ledgerId: number; from: string; to: string; interestLedgerId: number; date: string }) {
  const r = await ledgerInterest(pool, companyId, b.ledgerId, b.from, b.to)
  if (!r) throw new ValidationError(['This ledger does not calculate interest'])
  if (!r.interest) throw new ValidationError(['There is no interest in this period'])
  const ledgers = await loadLedgers(pool, companyId)
  const other = ledgers.get(b.interestLedgerId)
  if (!other || other.id === b.ledgerId) throw new ValidationError(['Choose the interest ledger it is booked to'])
  const groups = await loadGroups(pool, companyId)
  const nature = other.groupId === null ? null : (() => {
    let g = groups.get(other.groupId!)
    while (g?.parentId) g = groups.get(g.parentId)
    return g?.nature
  })()
  if (nature !== (r.interest > 0 ? 'Income' : 'Expenses')) throw new ValidationError([r.interest > 0 ? 'Interest receivable is booked to an income ledger' : 'Interest payable is booked to an expense ledger'])
  const party = ledgers.get(b.ledgerId)!
  const bill = party.billwise ? { bills: [{ type: 'New Ref' as const, name: `Interest to ${b.to}`, amount: r.interest }] } : {}
  return postVoucher(companyId, {
    type: 'Journal', date: b.date, narration: `Interest at ${r.rate / 100}% a year for ${b.from} to ${b.to}`,
    entries: [{ ledgerId: b.ledgerId, amount: r.interest, ...bill }, { ledgerId: b.interestLedgerId, amount: -r.interest }],
  })
}
