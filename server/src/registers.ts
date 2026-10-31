/**
 * Tally Audit (an auditor marks vouchers audited or under observation; a voucher altered afterwards
 * shows as altered after audit), the POS Register (the vouchers of POS voucher types with how each
 * was paid), and order analysis by period (what was ordered each month, delivered and pending).
 */
import { pool, withTx } from './db'
import { loadGroups, ValidationError } from './books'
import { isUnder, primaryOf } from './engine/groups'
import { pendingLines } from './inventory'

type Period = { from: string; to: string }

export type AuditStatus = 'Audited' | 'Under Observation'

/**
 * Tally Audit for a period: each voucher with who entered it and when, its last alteration, and
 * its audit status: not audited, audited, under observation, or altered after audit (its version
 * moved on since the mark).
 */
export async function tallyAudit(companyId: number, p: Period) {
  const { rows } = await pool.query<{
    voucherId: number; type: string; docNo: string; date: string; narration: string; version: number; amount: number
    createdBy: string | null; createdAt: string | null; alteredBy: string | null; alteredAt: string | null; alterations: number
    mark: { status: AuditStatus; version: number; auditor: string; at: string; note: string } | null
  }>(
    `SELECT v.id "voucherId", v.type, COALESCE(v.doc_no, v.number::text) "docNo", to_char(v.date, 'YYYY-MM-DD') date, v.narration, v.version,
            COALESCE((SELECT SUM(e.amount) FROM entries e WHERE e.voucher_id = v.id AND e.amount > 0), 0)::float8 amount,
            c.actor "createdBy", to_char(c.at, 'YYYY-MM-DD"T"HH24:MI:SSOF') "createdAt",
            a.actor "alteredBy", to_char(a.at, 'YYYY-MM-DD"T"HH24:MI:SSOF') "alteredAt",
            (SELECT count(*)::int FROM edit_log l WHERE l.entity = 'voucher' AND l.entity_id = v.id AND l.company_id = v.company_id AND l.action = 'alter') alterations,
            CASE WHEN m.voucher_id IS NULL THEN NULL ELSE json_build_object('status', m.status, 'version', m.version, 'auditor', m.auditor,
              'at', to_char(m.at, 'YYYY-MM-DD"T"HH24:MI:SSOF'), 'note', m.note) END mark
       FROM vouchers v
       LEFT JOIN LATERAL (SELECT actor, at FROM edit_log l WHERE l.entity = 'voucher' AND l.entity_id = v.id AND l.company_id = v.company_id AND l.action = 'create'
                          ORDER BY l.id LIMIT 1) c ON true
       LEFT JOIN LATERAL (SELECT actor, at FROM edit_log l WHERE l.entity = 'voucher' AND l.entity_id = v.id AND l.company_id = v.company_id AND l.action = 'alter'
                          ORDER BY l.id DESC LIMIT 1) a ON true
       LEFT JOIN audit_marks m ON m.voucher_id = v.id
      WHERE v.company_id = $1 AND v.date BETWEEN $2 AND $3 AND NOT v.cancelled
      ORDER BY v.date, v.id`,
    [companyId, p.from, p.to],
  )
  const vouchers = rows.map((r) => ({
    ...r,
    status: !r.mark ? 'Not audited' : r.version > r.mark.version ? 'Altered after audit' : r.mark.status,
  }))
  const count = (s: string) => vouchers.filter((v) => v.status === s).length
  return {
    vouchers,
    summary: { total: vouchers.length, notAudited: count('Not audited'), audited: count('Audited'), underObservation: count('Under Observation'), alteredAfterAudit: count('Altered after audit') },
  }
}

/** Mark vouchers audited or under observation (on their present version), or clear the mark. */
export async function setAudit(companyId: number, auditor: string, items: { voucherId: number; status: AuditStatus | null; note?: string }[]) {
  await withTx(async (tx) => {
    for (const i of items) {
      const v = (await tx.query<{ version: number }>(`SELECT version FROM vouchers WHERE id = $1 AND company_id = $2`, [i.voucherId, companyId])).rows[0]
      if (!v) throw new ValidationError([`Unknown voucher ${i.voucherId}`])
      if (!i.status) await tx.query(`DELETE FROM audit_marks WHERE voucher_id = $1`, [i.voucherId])
      else
        await tx.query(
          `INSERT INTO audit_marks (voucher_id, status, version, auditor, note) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (voucher_id) DO UPDATE SET status = $2, version = $3, auditor = $4, note = $5, at = now()`,
          [i.voucherId, i.status, v.version, auditor, i.note?.trim() ?? ''],
        )
    }
  })
}

/**
 * POS Register: the period's vouchers of POS voucher types, each with what was received in cash,
 * through banks (cards, UPI, cheques), and left on credit to the party; and the day's totals.
 */
export async function posRegister(companyId: number, p: Period) {
  const groups = await loadGroups(pool, companyId)
  const { rows } = await pool.query<{ voucherId: number; voucherType: string; docNo: string; date: string; party: string | null; lines: { ledger: string; groupId: number | null; amount: number }[] }>(
    `SELECT v.id "voucherId", t.name "voucherType", COALESCE(v.doc_no, v.number::text) "docNo", to_char(v.date, 'YYYY-MM-DD') date, v.gst ->> 'party' party,
            json_agg(json_build_object('ledger', l.name, 'groupId', l.group_id, 'amount', e.amount) ORDER BY e.line) lines
       FROM vouchers v JOIN voucher_types t ON t.id = v.voucher_type_id AND t.pos JOIN entries e ON e.voucher_id = v.id JOIN ledgers l ON l.id = e.ledger_id
      WHERE v.company_id = $1 AND v.date BETWEEN $2 AND $3 AND NOT v.cancelled
      GROUP BY v.id, t.name ORDER BY v.date, v.id`,
    [companyId, p.from, p.to],
  )
  const under = (gid: number | null, names: string[]) => gid !== null && isUnder(groups, gid, names)
  const vouchers = rows.map((r) => {
    const debits = r.lines.filter((l) => l.amount > 0)
    const cash = debits.filter((l) => under(l.groupId, ['Cash-in-Hand'])).reduce((t, l) => t + Number(l.amount), 0)
    const bank = debits.filter((l) => under(l.groupId, ['Bank Accounts', 'Bank OD A/c'])).reduce((t, l) => t + Number(l.amount), 0)
    const total = debits.reduce((t, l) => t + Number(l.amount), 0)
    const party = debits.find((l) => under(l.groupId, ['Sundry Debtors']))?.ledger ?? r.party
    return { voucherId: r.voucherId, voucherType: r.voucherType, docNo: r.docNo, date: r.date, party, cash, bank, credit: total - cash - bank, total }
  })
  const days = new Map<string, { date: string; count: number; cash: number; bank: number; credit: number; total: number }>()
  for (const v of vouchers) {
    const d = days.get(v.date) ?? days.set(v.date, { date: v.date, count: 0, cash: 0, bank: 0, credit: 0, total: 0 }).get(v.date)!
    d.count++
    d.cash += v.cash
    d.bank += v.bank
    d.credit += v.credit
    d.total += v.total
  }
  const sum = (k: 'cash' | 'bank' | 'credit' | 'total') => vouchers.reduce((t, v) => t + v[k], 0)
  return { vouchers, days: [...days.values()], total: { count: vouchers.length, cash: sum('cash'), bank: sum('bank'), credit: sum('credit'), total: sum('total') } }
}

/**
 * Cost Tracking: for each cost track named on vouchers of the period, the sales (income credited),
 * the costs (purchases and expenses debited), the margin, and the goods in and out at their value.
 */
export async function costTracks(companyId: number, p: Period) {
  const groups = await loadGroups(pool, companyId)
  const { rows } = await pool.query<{ track: string; groupId: number | null; amount: number; vouchers: number }>(
    `SELECT v.cost_track track, l.group_id "groupId", SUM(e.amount)::float8 amount, count(DISTINCT v.id)::int vouchers
       FROM vouchers v JOIN entries e ON e.voucher_id = v.id JOIN ledgers l ON l.id = e.ledger_id
      WHERE v.company_id = $1 AND v.cost_track IS NOT NULL AND NOT v.cancelled AND v.date BETWEEN $2 AND $3
      GROUP BY v.cost_track, l.group_id`,
    [companyId, p.from, p.to],
  )
  const goods = (await pool.query<{ track: string; inValue: number; outValue: number }>(
    `SELECT v.cost_track track, COALESCE(SUM(i.amount) FILTER (WHERE i.qty > 0), 0)::float8 "inValue", COALESCE(-SUM(i.amount) FILTER (WHERE i.qty < 0), 0)::float8 "outValue"
       FROM vouchers v JOIN inventory_entries i ON i.voucher_id = v.id
      WHERE v.company_id = $1 AND v.cost_track IS NOT NULL AND NOT v.cancelled AND v.date BETWEEN $2 AND $3 AND i.moves_stock GROUP BY v.cost_track`,
    [companyId, p.from, p.to],
  )).rows
  const tracks = new Map<string, { track: string; sales: number; costs: number; margin: number; goodsIn: number; goodsOut: number; vouchers: number }>()
  const at = (t: string) => tracks.get(t) ?? tracks.set(t, { track: t, sales: 0, costs: 0, margin: 0, goodsIn: 0, goodsOut: 0, vouchers: 0 }).get(t)!
  const voucherCount = (await pool.query<{ track: string; n: number }>(
    `SELECT cost_track track, count(*)::int n FROM vouchers WHERE company_id = $1 AND cost_track IS NOT NULL AND NOT cancelled AND date BETWEEN $2 AND $3 GROUP BY cost_track`,
    [companyId, p.from, p.to],
  )).rows
  for (const r of rows) {
    if (r.groupId === null) continue
    const nature = primaryOf(groups, r.groupId).nature
    if (nature === 'Income') at(r.track).sales -= r.amount
    else if (nature === 'Expenses') at(r.track).costs += r.amount
  }
  for (const g of goods) {
    at(g.track).goodsIn = g.inValue
    at(g.track).goodsOut = g.outValue
  }
  for (const v of voucherCount) at(v.track).vouchers = v.n
  for (const t of tracks.values()) t.margin = t.sales - t.costs
  return [...tracks.values()].sort((a, b) => a.track.localeCompare(b.track))
}

/**
 * Sales or Purchase Order analysis by period: for each item (or party), the quantity and value
 * ordered in each month of the period, what has since been delivered against those orders, and
 * what is pending.
 */
export async function orderAnalysis(companyId: number, type: 'Sales Order' | 'Purchase Order', p: Period, by: 'item' | 'party') {
  const lines = (await pendingLines(pool, companyId, { type, asOf: p.to, all: true })).filter((l) => l.date >= p.from)
  const months: string[] = []
  for (let d = new Date(`${p.from.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 10) <= p.to; d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 7))
  const rows = new Map<string, { key: string; unit: string | null; decimals: number; byMonth: Record<string, { qty: number; value: number }>; ordered: number; value: number; done: number; pending: number
    pendingValue: number; orders: number }>()
  for (const l of lines) {
    const key = by === 'item' ? l.item : (l.party ?? '(no party)')
    const r = rows.get(key) ?? rows.set(key, { key, unit: by === 'item' ? l.unit : null, decimals: l.decimals, byMonth: {}, ordered: 0, value: 0, done: 0, pending: 0, pendingValue: 0, orders: 0 }).get(key)!
    const value = Math.round((l.ordered * l.rate) / 1000)
    const m = l.date.slice(0, 7)
    const cell = r.byMonth[m] ?? (r.byMonth[m] = { qty: 0, value: 0 })
    cell.qty += l.ordered
    cell.value += value
    r.ordered += l.ordered
    r.value += value
    r.done += l.done
    r.pending += l.pending
    r.pendingValue += Math.round((l.pending * l.rate) / 1000)
    r.orders++
  }
  const list = [...rows.values()].sort((a, b) => b.value - a.value)
  return {
    type, by, ...p, months, rows: list,
    total: { value: list.reduce((t, r) => t + r.value, 0), pendingValue: list.reduce((t, r) => t + r.pendingValue, 0), byMonth: Object.fromEntries(months.map((m) => [m, list.reduce((t, r) => t + (r.byMonth[m]?.value ?? 0), 0)])) },
  }
}
