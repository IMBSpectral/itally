/**
 * Account Books: Cash/Bank Books, Group Summary, Group Vouchers, voucher registers and the
 * month-wise ledger summary. All movement figures come from ledger_daily, so these stay quick
 * however many vouchers there are.
 */
import type { Router, Request } from 'express'
import { z } from 'zod'
import { pool } from '../db'
import { ledgerBalances, loadGroups, ValidationError } from '../books'
import { CASH_BANK_GROUPS, isUnder, type GroupNode } from '../engine/groups'
import { VOUCHER_TYPES } from '../engine/voucher'
import { cashFlow, fundsFlow, ratios } from '../engine/analysis'

type Period = { from: string; to: string }

/** Debit and credit totals per ledger within the period. */
async function movements(companyId: number, p: Period) {
  const { rows } = await pool.query<{ id: number; debit: number; credit: number }>(
    `SELECT d.ledger_id id, SUM(d.dr)::bigint debit, SUM(d.cr)::bigint credit
       FROM ledger_daily d JOIN ledgers l ON l.id = d.ledger_id
      WHERE l.company_id = $1 AND d.day BETWEEN $2 AND $3 GROUP BY d.ledger_id`,
    [companyId, p.from, p.to],
  )
  return new Map(rows.map((r) => [r.id, r]))
}

interface Line {
  kind: 'group' | 'ledger' | 'stock'
  id: number
  name: string
  opening: number
  debit: number
  credit: number
  closing: number
}

/** Direct sub-groups (rolled up) and ledgers of the given groups, with movement in the period. */
async function summary(companyId: number, p: Period, parents: GroupNode[], groups: Map<number, GroupNode>) {
  const balances = await ledgerBalances(pool, companyId, p.from, p.to)
  const moves = await movements(companyId, p)
  const parentIds = new Set(parents.map((g) => g.id))
  const lines = new Map<string, Line>()
  for (const b of balances) {
    if (b.groupId === null || !parents.some((g) => isUnder(groups, b.groupId!, [g.name]))) continue
    // the child of one of the parents that this ledger sits under (or the ledger itself)
    let g = groups.get(b.groupId)!
    while (g.parentId !== null && !parentIds.has(g.parentId) && !parentIds.has(g.id)) g = groups.get(g.parentId)!
    const direct = parentIds.has(b.groupId)
    const key = direct ? `l${b.id}` : `g${g.id}`
    const m = moves.get(b.id)
    const kind: Line['kind'] = !direct ? 'group' : b.id < 0 ? 'stock' : 'ledger' // the stock items' line opens the Stock Summary
    const line = lines.get(key) ?? { kind, id: direct ? b.id : g.id, name: direct ? b.name : g.name, opening: 0, debit: 0, credit: 0, closing: 0 }
    line.opening += b.opening
    line.debit += m?.debit ?? 0
    line.credit += m?.credit ?? 0
    line.closing += b.stockValue ?? b.closing
    lines.set(key, line)
  }
  const out = [...lines.values()].filter((l) => l.opening || l.debit || l.credit || l.closing)
  out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'group' ? -1 : 1))
  const total = out.reduce((t, l) => ({ opening: t.opening + l.opening, debit: t.debit + l.debit, credit: t.credit + l.credit, closing: t.closing + l.closing }), {
    opening: 0, debit: 0, credit: 0, closing: 0,
  })
  return { lines: out, total }
}

export function addBookRoutes(company: Router, cid: (req: Request) => number, period: (req: Request) => Promise<Period>) {
  /** Group Summary for one group (?groupId=), or Cash/Bank Books when ?cashBank=1. */
  company.get('/reports/group-summary', async (req, res) => {
    const p = await period(req)
    const groups = await loadGroups(pool, cid(req))
    const parents =
      req.query.cashBank === '1'
        ? [...groups.values()].filter((g) => CASH_BANK_GROUPS.includes(g.name))
        : [groups.get(Number(req.query.groupId))].filter((g): g is GroupNode => !!g)
    if (!parents.length) throw new ValidationError(['Choose a group'])
    const title = req.query.cashBank === '1' ? 'Cash/Bank Books' : parents[0].name
    res.json({ title, ...p, ...(await summary(cid(req), p, parents, groups)) })
  })

  /** Group Vouchers: every entry on any ledger under the group, with a running balance. */
  company.get('/reports/group-vouchers', async (req, res) => {
    const p = await period(req)
    const groups = await loadGroups(pool, cid(req))
    const group = groups.get(Number(req.query.groupId))
    if (!group) throw new ValidationError(['Choose a group'])
    const ledgerIds = (await pool.query<{ id: number; group_id: number | null }>(`SELECT id, group_id FROM ledgers WHERE company_id = $1`, [cid(req)])).rows
      .filter((l) => l.group_id !== null && isUnder(groups, l.group_id, [group.name]))
      .map((l) => l.id)
    const balances = (await ledgerBalances(pool, cid(req), p.from, p.to)).filter((b) => ledgerIds.includes(b.id))
    const opening = balances.reduce((t, b) => t + b.opening, 0)
    const { rows } = await pool.query(
      `SELECT v.id "voucherId", v.type, v.number, COALESCE(v.doc_no, v.number::text) "docNo", to_char(v.date,'YYYY-MM-DD') date, l.name ledger, e.amount
         FROM entries e JOIN vouchers v ON v.id = e.voucher_id JOIN ledgers l ON l.id = e.ledger_id
        WHERE e.ledger_id = ANY($1) AND v.date BETWEEN $2 AND $3
        ORDER BY v.date, v.id, e.line`,
      [ledgerIds, p.from, p.to],
    )
    let running = opening
    const lines = rows.map((r) => ({ ...r, balance: (running += r.amount) }))
    res.json({ group: { id: group.id, name: group.name }, ...p, opening, lines, closing: running })
  })

  /** A voucher register: one line per month with how many vouchers and their value. */
  company.get('/reports/register', async (req, res) => {
    const p = await period(req)
    const type = z.enum(VOUCHER_TYPES).parse(req.query.type)
    const { rows } = await pool.query<{ month: string; count: number; total: number }>(
      // an inventory voucher has no entries: its value is that of its items
      `SELECT to_char(v.date, 'YYYY-MM') "month", count(DISTINCT v.id)::int "count",
              (COALESCE(SUM(GREATEST(e.amount, 0)), 0) +
               COALESCE(SUM((SELECT SUM(abs(i.amount)) FROM inventory_entries i WHERE i.voucher_id = v.id)) FILTER (WHERE e.id IS NULL), 0))::bigint total
         FROM vouchers v LEFT JOIN entries e ON e.voucher_id = v.id
        WHERE v.company_id = $1 AND v.type = $2 AND v.date BETWEEN $3 AND $4 AND NOT v.cancelled
        GROUP BY 1 ORDER BY 1`,
      [cid(req), type, p.from, p.to],
    )
    res.json({ type, ...p, months: monthsOf(p).map((m) => rows.find((r) => r.month === m) ?? { month: m, count: 0, total: 0 }) })
  })

  /** Cash Flow: month by month, what came into cash and bank and what went out, by the other side's group. */
  company.get('/reports/cash-flow', async (req, res) => {
    const p = await period(req)
    const groups = await loadGroups(pool, cid(req))
    const cashGroups = [...groups.values()].filter((g) => isUnder(groups, g.id, CASH_BANK_GROUPS)).map((g) => g.id)
    const { rows } = await pool.query<{ month: string; groupId: number | null; amount: number }>(
      `WITH cash AS (SELECT id FROM ledgers WHERE company_id = $1 AND group_id = ANY($4)),
            touched AS (SELECT DISTINCT v.id, v.date FROM vouchers v JOIN entries e ON e.voucher_id = v.id
                         WHERE v.company_id = $1 AND v.date BETWEEN $2 AND $3 AND e.ledger_id IN (SELECT id FROM cash))
       SELECT to_char(t.date, 'YYYY-MM') "month", l.group_id "groupId", SUM(e.amount)::bigint amount
         FROM touched t JOIN entries e ON e.voucher_id = t.id JOIN ledgers l ON l.id = e.ledger_id
        WHERE e.ledger_id NOT IN (SELECT id FROM cash)
        GROUP BY t.id, 1, l.group_id`,
      [cid(req), p.from, p.to, cashGroups],
    )
    const balances = await ledgerBalances(pool, cid(req), p.from, p.to)
    const opening = balances.filter((b) => b.groupId !== null && cashGroups.includes(b.groupId)).reduce((t, b) => t + b.opening, 0)
    res.json({ ...p, ...cashFlow(groups, rows, monthsOf(p), opening) })
  })

  /**
   * Statistics, as Tally's: how many vouchers of each type in the period (the company's own voucher
   * types apart, cancelled and optional ones counted separately), and how many masters of each kind.
   */
  company.get('/reports/statistics', async (req, res) => {
    const p = await period(req)
    const { rows } = await pool.query<{ type: string; voucherTypeId: number | null; name: string; count: number; cancelled: number; optional: number }>(
      `SELECT v.type, v.voucher_type_id "voucherTypeId", COALESCE(t.name, v.type) "name",
              count(*) FILTER (WHERE NOT v.cancelled AND NOT v.optional)::int "count",
              count(*) FILTER (WHERE v.cancelled)::int cancelled, count(*) FILTER (WHERE v.optional AND NOT v.cancelled)::int optional
         FROM vouchers v LEFT JOIN voucher_types t ON t.id = v.voucher_type_id
        WHERE v.company_id = $1 AND v.date BETWEEN $2 AND $3 GROUP BY 1, 2, 3`,
      [cid(req), p.from, p.to],
    )
    const own = (await pool.query<{ id: number; name: string; baseType: string }>(
      `SELECT id, name, base_type "baseType" FROM voucher_types WHERE company_id = $1 ORDER BY base_type, lower(name)`, [cid(req)],
    )).rows
    // every predefined type, each followed by the company's own types under it
    const vouchers = VOUCHER_TYPES.flatMap((type) => [
      { type, voucherTypeId: null as number | null, name: type },
      ...own.filter((t) => t.baseType === type).map((t) => ({ type, voucherTypeId: t.id as number | null, name: t.name })),
    ]).map((t) => {
      const r = rows.find((x) => x.type === t.type && x.voucherTypeId === t.voucherTypeId)
      return { ...t, count: r?.count ?? 0, cancelled: r?.cancelled ?? 0, optional: r?.optional ?? 0 }
    })
    const counts = (await pool.query<Record<string, number>>(
      `SELECT (SELECT count(*) FROM groups WHERE company_id = $1)::int "Groups",
              (SELECT count(*) FROM ledgers WHERE company_id = $1)::int "Ledgers",
              (SELECT count(*) FROM cost_categories WHERE company_id = $1)::int "Cost Categories",
              (SELECT count(*) FROM cost_centres WHERE company_id = $1)::int "Cost Centres",
              (SELECT count(*) FROM voucher_types WHERE company_id = $1)::int + ${VOUCHER_TYPES.length} "Voucher Types",
              (SELECT count(*) FROM stock_groups WHERE company_id = $1)::int "Stock Groups",
              (SELECT count(*) FROM stock_categories WHERE company_id = $1)::int "Stock Categories",
              (SELECT count(*) FROM stock_items WHERE company_id = $1)::int "Stock Items",
              (SELECT count(*) FROM units WHERE company_id = $1)::int "Units",
              (SELECT count(*) FROM godowns WHERE company_id = $1)::int "Godowns",
              (SELECT count(*) FROM gst_classifications WHERE company_id = $1)::int "GST Classifications"`,
      [cid(req)],
    )).rows[0]
    res.json({ ...p, vouchers, total: vouchers.reduce((t, v) => t + v.count, 0), masters: Object.entries(counts).map(([name, count]) => ({ name, count })) })
  })

  /**
   * Dashboard: the figures an owner looks at first — cash and bank, receivables and payables,
   * sales, purchases and profit for the period, sales and purchases month by month, and the
   * largest balances owed either way.
   */
  company.get('/reports/dashboard', async (req, res) => {
    const p = await period(req)
    const groups = await loadGroups(pool, cid(req))
    const balances = await ledgerBalances(pool, cid(req), p.from, p.to)
    const days = Math.round((Date.parse(p.to) - Date.parse(p.from)) / 86_400_000) + 1
    const r = ratios(groups, balances, days)
    const ids = (names: string[]) => [...groups.values()].filter((g) => isUnder(groups, g.id, names)).map((g) => g.id)
    const { rows } = await pool.query<{ month: string; sales: number; purchases: number }>(
      `SELECT to_char(d.day, 'YYYY-MM') "month",
              COALESCE(SUM(d.cr - d.dr) FILTER (WHERE l.group_id = ANY($4)), 0)::bigint sales,
              COALESCE(SUM(d.dr - d.cr) FILTER (WHERE l.group_id = ANY($5)), 0)::bigint purchases
         FROM ledger_daily d JOIN ledgers l ON l.id = d.ledger_id
        WHERE l.company_id = $1 AND d.day BETWEEN $2 AND $3 AND l.group_id = ANY($4 || $5) GROUP BY 1`,
      [cid(req), p.from, p.to, ids(['Sales Accounts']), ids(['Purchase Accounts'])],
    )
    const party = (names: string[], sign: 1 | -1) =>
      balances
        .filter((b) => b.groupId !== null && isUnder(groups, b.groupId, names) && sign * b.closing > 0)
        .sort((a, b) => sign * (b.closing - a.closing))
        .slice(0, 5)
        .map((b) => ({ id: b.id, name: b.name, amount: sign * b.closing }))
    const vouchers = (await pool.query<{ n: number }>(
      `SELECT count(*)::int n FROM vouchers WHERE company_id = $1 AND date BETWEEN $2 AND $3 AND NOT cancelled AND NOT optional`, [cid(req), p.from, p.to],
    )).rows[0].n
    res.json({
      ...p,
      cash: r.cashInHand,
      bank: r.bankAccounts - r.bankOd,
      receivables: r.sundryDebtors,
      payables: r.sundryCreditors,
      sales: r.sales,
      purchases: r.purchases,
      grossProfit: r.grossProfit,
      netProfit: r.netProfit,
      closingStock: r.closingStock,
      vouchers,
      months: monthsOf(p).map((m) => rows.find((x) => x.month === m) ?? { month: m, sales: 0, purchases: 0 }),
      topDebtors: party(['Sundry Debtors'], 1),
      topCreditors: party(['Sundry Creditors'], -1),
    })
  })

  /** Funds Flow: sources and applications of working capital over the period. */
  company.get('/reports/funds-flow', async (req, res) => {
    const p = await period(req)
    const groups = await loadGroups(pool, cid(req))
    res.json({ ...p, ...fundsFlow(groups, await ledgerBalances(pool, cid(req), p.from, p.to)) })
  })

  /** Ratio Analysis as at the end of the period. */
  company.get('/reports/ratios', async (req, res) => {
    const p = await period(req)
    const groups = await loadGroups(pool, cid(req))
    const days = Math.round((Date.parse(p.to) - Date.parse(p.from)) / 86_400_000) + 1
    res.json({ ...p, ...ratios(groups, await ledgerBalances(pool, cid(req), p.from, p.to), days) })
  })

  /** Month-wise summary of one ledger: opening, debits, credits and closing for each month. */
  company.get('/ledgers/:id/monthly', async (req, res) => {
    const p = await period(req)
    const ledgerId = Number(req.params.id)
    const b = (await ledgerBalances(pool, cid(req), p.from, p.to)).find((x) => x.id === ledgerId)
    if (!b) return res.status(404).json({ error: 'Not found' })
    const { rows } = await pool.query<{ month: string; debit: number; credit: number }>(
      `SELECT to_char(day, 'YYYY-MM') "month", SUM(dr)::bigint debit, SUM(cr)::bigint credit
         FROM ledger_daily WHERE ledger_id = $1 AND day BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 1`,
      [ledgerId, p.from, p.to],
    )
    let running = b.opening
    const months = monthsOf(p).map((m) => {
      const r = rows.find((x) => x.month === m)
      running += (r?.debit ?? 0) - (r?.credit ?? 0)
      return { month: m, debit: r?.debit ?? 0, credit: r?.credit ?? 0, closing: running }
    })
    res.json({ ledger: { id: b.id, name: b.name }, ...p, opening: b.opening, months, closing: b.closing })
  })
}

/** Every calendar month the period touches, as YYYY-MM. */
function monthsOf(p: Period) {
  const out: string[] = []
  let [y, m] = p.from.split('-').map(Number)
  const [ty, tm] = p.to.split('-').map(Number)
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    if (++m > 12) {
      m = 1
      y++
    }
  }
  return out
}
