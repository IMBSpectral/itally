/**
 * MSME: a party's registration under the MSMED Act (micro, small or medium, its Udyam number and
 * activity), set on the parties together (Party MSME Update), and MSME Form 1, the half-yearly
 * return of what is owed to micro and small suppliers beyond the time the Act allows: the credit
 * period agreed, at most 45 days, or 15 days with none agreed (section 15).
 */
import { pool, withTx } from './db'
import { getCompany, loadGroups, pendingBills, ValidationError } from './books'
import { isUnder } from './engine/groups'

export const MSME_TYPES = ['Micro', 'Small', 'Medium'] as const
export const MSME_ACTIVITIES = ['Manufacturing', 'Services', 'Trading'] as const
export type MsmeType = (typeof MSME_TYPES)[number]
export type MsmeActivity = (typeof MSME_ACTIVITIES)[number]
export interface MsmeDetails {
  type: MsmeType
  udyamNo: string | null
  activity: MsmeActivity
}

/** Every party ledger (debtors and creditors) with its MSME details, if any. */
export async function msmeParties(companyId: number) {
  const groups = await loadGroups(pool, companyId)
  const { rows } = await pool.query<{ ledgerId: number; name: string; groupId: number; pan: string | null; type: MsmeType | null; udyamNo: string | null; activity: MsmeActivity | null }>(
    `SELECT l.id "ledgerId", l.name, l.group_id "groupId", l.pan, m.type, m.udyam_no "udyamNo", m.activity
       FROM ledgers l LEFT JOIN party_msme m ON m.ledger_id = l.id WHERE l.company_id = $1 ORDER BY lower(l.name)`,
    [companyId],
  )
  return rows
    .filter((r) => isUnder(groups, r.groupId, ['Sundry Creditors', 'Sundry Debtors']))
    .map((r) => ({ ...r, group: groups.get(r.groupId)?.name ?? '' }))
}

/** Party MSME Update: the details of several parties at once; null clears them. All or none are saved. */
export async function setMsme(companyId: number, items: { ledgerId: number; msme: MsmeDetails | null }[]) {
  const groups = await loadGroups(pool, companyId)
  const ids = items.map((i) => i.ledgerId)
  const ledgers = new Map((await pool.query<{ id: number; name: string; groupId: number }>(
    `SELECT id, name, group_id "groupId" FROM ledgers WHERE company_id = $1 AND id = ANY($2)`, [companyId, ids],
  )).rows.map((l) => [l.id, l]))
  const errors: string[] = []
  for (const { ledgerId, msme } of items) {
    const l = ledgers.get(ledgerId)
    if (!l) {
      errors.push(`Unknown ledger ${ledgerId}`)
      continue
    }
    if (!msme) continue
    if (!isUnder(groups, l.groupId, ['Sundry Creditors', 'Sundry Debtors'])) errors.push(`${l.name}: MSME details go on a party (a supplier or a customer)`)
    const u = msme.udyamNo?.trim().toUpperCase()
    if (u && !/^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/.test(u)) errors.push(`${l.name}: "${msme.udyamNo}" is not a Udyam registration number (UDYAM-MH-01-0012345)`)
  }
  if (errors.length) throw new ValidationError(errors)
  await withTx(async (tx) => {
    for (const { ledgerId, msme } of items) {
      if (!msme) await tx.query(`DELETE FROM party_msme WHERE ledger_id = $1`, [ledgerId])
      else
        await tx.query(
          `INSERT INTO party_msme (ledger_id, type, udyam_no, activity) VALUES ($1,$2,$3,$4)
           ON CONFLICT (ledger_id) DO UPDATE SET type = $2, udyam_no = $3, activity = $4`,
          [ledgerId, msme.type, msme.udyamNo?.trim().toUpperCase() || null, msme.activity],
        )
    }
  })
}

/** The days the Act allows for paying a supplier: the agreed credit period up to 45 days, else 15. */
export const allowedDays = (creditDays: number | null) => (creditDays === null ? 15 : Math.min(creditDays, 45))

const addDays = (date: string, days: number) => new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10)
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)

/**
 * MSME Form 1 for a half of the financial year starting `fyStart` (1: April-September, 2:
 * October-March): each bill of a micro or small supplier still unpaid at the half's end beyond
 * the days allowed, with the date it fell due. At the year's end the same bills are what section
 * 43B(h) disallows until paid.
 */
export async function msmeForm1(companyId: number, fyStart: string, half: 1 | 2) {
  const company = (await getCompany(pool, companyId))!
  const y = Number(fyStart.slice(0, 4))
  const from = half === 1 ? `${y}-04-01` : `${y}-10-01`
  const asOf = half === 1 ? `${y}-09-30` : `${y + 1}-03-31`
  const groups = await loadGroups(pool, companyId)
  const suppliers = new Map((await pool.query<{ id: number; name: string; groupId: number; pan: string | null; creditDays: number | null; type: MsmeType; udyamNo: string | null; activity: MsmeActivity }>(
    `SELECT l.id, l.name, l.group_id "groupId", l.pan, l.credit_days "creditDays", m.type, m.udyam_no "udyamNo", m.activity
       FROM ledgers l JOIN party_msme m ON m.ledger_id = l.id WHERE l.company_id = $1 AND m.type IN ('Micro', 'Small')`,
    [companyId],
  )).rows.filter((s) => isUnder(groups, s.groupId, ['Sundry Creditors'])).map((s) => [s.id, s]))
  const bills = (await pendingBills(pool, companyId, asOf)).filter((b) => suppliers.has(b.ledgerId) && b.pending < 0)
  const lines = bills
    .map((b) => {
      const s = suppliers.get(b.ledgerId)!
      const due = addDays(b.billDate, allowedDays(s.creditDays))
      return { ledgerId: s.id, supplier: s.name, pan: s.pan, udyamNo: s.udyamNo, type: s.type, activity: s.activity, bill: b.name, billDate: b.billDate, dueDate: due,
        daysOverdue: daysBetween(due, asOf), amount: -b.pending }
    })
    .filter((l) => l.daysOverdue > 0)
  const bySupplier = new Map<number, { ledgerId: number; supplier: string; pan: string | null; udyamNo: string | null; type: MsmeType; amount: number; dueFrom: string; bills: number }>()
  for (const l of lines) {
    const s = bySupplier.get(l.ledgerId) ?? bySupplier.set(l.ledgerId, { ledgerId: l.ledgerId, supplier: l.supplier, pan: l.pan, udyamNo: l.udyamNo, type: l.type, amount: 0, dueFrom: l.dueDate, bills: 0 }).get(l.ledgerId)!
    s.amount += l.amount
    s.bills += 1
    if (l.dueDate < s.dueFrom) s.dueFrom = l.dueDate
  }
  const problems = [...bySupplier.values()].flatMap((s) => [
    ...(!s.udyamNo ? [`${s.supplier}: no Udyam registration number`] : []),
    ...(!s.pan ? [`${s.supplier}: no PAN`] : []),
  ])
  return {
    company: company.name, fyStart, half, from, to: asOf, yearEnd: half === 2,
    lines, suppliers: [...bySupplier.values()].sort((a, b) => a.supplier.localeCompare(b.supplier)),
    total: lines.reduce((t, l) => t + l.amount, 0),
    problems,
  }
}

/**
 * Interest on late payments to micro and small suppliers (section 16 of the MSMED Act): compound
 * interest with monthly rests at three times the RBI's bank rate, from the day a bill fell due
 * (the credit period agreed, at most 45 days, else 15) until it is paid, or until `asOf` while it
 * is unpaid. Each payment on a bill stops the interest on what it paid. The interest is not an
 * allowable expense (section 23).
 */
export async function msmeInterest(companyId: number, asOf: string, bankRate: number) {
  const groups = await loadGroups(pool, companyId)
  const suppliers = new Map((await pool.query<{ id: number; name: string; groupId: number; creditDays: number | null; udyamNo: string | null }>(
    `SELECT l.id, l.name, l.group_id "groupId", l.credit_days "creditDays", m.udyam_no "udyamNo"
       FROM ledgers l JOIN party_msme m ON m.ledger_id = l.id WHERE l.company_id = $1 AND m.type IN ('Micro', 'Small')`,
    [companyId],
  )).rows.filter((s) => isUnder(groups, s.groupId, ['Sundry Creditors'])).map((s) => [s.id, s]))
  if (!suppliers.size) return { asOf, bankRate, rate: bankRate * 3, lines: [], total: 0 }
  const { rows } = await pool.query<{ ledgerId: number; name: string; kind: string; date: string; amount: number }>(
    `SELECT a.ledger_id "ledgerId", a.name, a.ref_type kind, to_char(v.date, 'YYYY-MM-DD') date, a.amount::float8 amount
       FROM bill_allocations a JOIN entries e ON e.id = a.entry_id JOIN vouchers v ON v.id = e.voucher_id
      WHERE a.ledger_id = ANY($1) AND a.name IS NOT NULL AND v.date <= $2 AND NOT v.cancelled
     UNION ALL
     SELECT ob.ledger_id, ob.name, 'Opening', to_char(ob.bill_date, 'YYYY-MM-DD'), ob.amount::float8 FROM opening_bills ob WHERE ob.ledger_id = ANY($1)
     ORDER BY 4`,
    [[...suppliers.keys()], asOf],
  )
  const monthly = (bankRate * 3) / 100 / 12 / 100 // bank rate in hundredths of a percent a year
  const interestOn = (amount: number, from: string, to: string) => {
    const days = daysBetween(from, to)
    return days > 0 ? Math.round(amount * ((1 + monthly) ** (days / (365 / 12)) - 1)) : 0
  }
  const bills = new Map<string, { ledgerId: number; bill: string; billDate: string; amount: number; payments: { date: string; amount: number }[] }>()
  for (const r of rows) {
    const k = `${r.ledgerId}|${r.name.toLowerCase()}`
    if (r.kind === 'Agst Ref') bills.get(k)?.payments.push({ date: r.date, amount: r.amount })
    else if (r.amount < 0 && !bills.has(k)) bills.set(k, { ledgerId: r.ledgerId, bill: r.name, billDate: r.date, amount: -r.amount, payments: [] })
  }
  const lines = []
  for (const b of bills.values()) {
    const s = suppliers.get(b.ledgerId)!
    const due = addDays(b.billDate, allowedDays(s.creditDays))
    let left = b.amount
    let interest = 0
    let lastPaid: string | null = null
    for (const p of b.payments) {
      const paid = Math.min(left, p.amount)
      if (paid <= 0) continue
      interest += interestOn(paid, due, p.date)
      left -= paid
      lastPaid = p.date
    }
    if (left > 0) interest += interestOn(left, due, asOf)
    if (interest <= 0) continue
    lines.push({ ledgerId: s.id, supplier: s.name, udyamNo: s.udyamNo, bill: b.bill, billDate: b.billDate, dueDate: due, amount: b.amount, unpaid: left,
      paidOn: left > 0 ? null : lastPaid, daysLate: daysBetween(due, left > 0 ? asOf : lastPaid!), interest })
  }
  lines.sort((a, b) => a.supplier.localeCompare(b.supplier) || a.dueDate.localeCompare(b.dueDate))
  return { asOf, bankRate, rate: bankRate * 3, lines, total: lines.reduce((t, l) => t + l.interest, 0) }
}
