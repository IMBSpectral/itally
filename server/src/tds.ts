/**
 * TDS and TCS: the company's TAN, natures of payment and of goods, and what the books say was due,
 * deducted (or collected) and paid. Due is worked out from the entries each time (see
 * engine/tds.ts): a voucher's party is the ledger in it with a deductee type, its amounts under a
 * nature are the lines on expense ledgers (TDS) or sales ledgers (TCS) of that nature, and what was
 * deducted or collected is the credit on tax ledgers (under Duties & Taxes) of the same nature. A
 * debit to such a tax ledger with no party in the voucher is a payment of the tax to the government.
 */
import { pool, withTx, type Tx } from './db'
import { getCompany, loadGroups, ValidationError } from './books'
import { isUnder, primaryOf } from './engine/groups'
import { fyStartOf } from './engine/numbering'
import {
  deducteeCode, dueThroughYear, isNonResident, natureProblems, quarterOf, STANDARD_NATURES, tanError, type DeducteeType, type TaxKind, type TdsDue, type TdsLine,
  type TdsNature, type PartyRate,
} from './engine/tds'

type Db = Tx | typeof pool

const NATURE_COLUMNS = `id, name, kind, section, collection_code "collectionCode", rate_individual "rateIndividual", rate_other "rateOther", rate_no_pan "rateNoPan",
  threshold_single::float8 "thresholdSingle", threshold_annual::float8 "thresholdAnnual", excess_only "excessOnly"`

export async function listNatures(db: Db, companyId: number): Promise<(TdsNature & { used: number })[]> {
  return (await db.query(
    `SELECT ${NATURE_COLUMNS}, (SELECT count(*)::int FROM ledgers l WHERE l.tds_nature_id = n.id) used
       FROM tds_natures n WHERE company_id = $1 ORDER BY kind, section, lower(name)`,
    [companyId],
  )).rows
}

/** The standard natures of payment and of goods, each kind added once (when TDS and TCS are first set up). */
export async function seedNatures(db: Db, companyId: number) {
  const has = new Set((await db.query<{ kind: TaxKind }>(`SELECT DISTINCT kind FROM tds_natures WHERE company_id = $1`, [companyId])).rows.map((r) => r.kind))
  for (const n of STANDARD_NATURES.filter((n) => !has.has(n.kind)))
    await db.query(
      `INSERT INTO tds_natures (company_id, name, kind, section, collection_code, rate_individual, rate_other, rate_no_pan, threshold_single, threshold_annual, excess_only)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
      [companyId, n.name, n.kind, n.section, n.collectionCode, n.rateIndividual, n.rateOther, n.rateNoPan, n.thresholdSingle, n.thresholdAnnual, n.excessOnly],
    )
}

type NatureInput = Omit<TdsNature, 'id'>
const natureValues = (n: NatureInput) => [
  n.name.trim(), n.kind, n.section.trim().toUpperCase(), n.kind === 'TCS' ? n.collectionCode?.trim().toUpperCase() || null : null,
  n.rateIndividual, n.rateOther, n.rateNoPan, n.thresholdSingle, n.thresholdAnnual, n.excessOnly,
]
const natureTaken = (name: string) => (err: { code?: string }) => {
  if (err.code === '23505') throw new ValidationError([`The name "${name}" is already used by another nature of payment or goods`])
  throw err
}
export async function createNature(companyId: number, n: NatureInput) {
  const errors = natureProblems(n)
  if (errors.length) throw new ValidationError(errors)
  return (await pool
    .query<{ id: number }>(
      `INSERT INTO tds_natures (company_id, name, kind, section, collection_code, rate_individual, rate_other, rate_no_pan, threshold_single, threshold_annual, excess_only)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [companyId, ...natureValues(n)],
    )
    .catch(natureTaken(n.name))).rows[0].id
}
export async function alterNature(companyId: number, id: number, n: NatureInput) {
  const errors = natureProblems(n)
  if (errors.length) throw new ValidationError(errors)
  const was = (await pool.query<{ kind: TaxKind; used: number }>(
    `SELECT kind, (SELECT count(*)::int FROM ledgers l WHERE l.tds_nature_id = n.id) used FROM tds_natures n WHERE id = $1 AND company_id = $2`, [id, companyId],
  )).rows[0]
  if (!was) throw new ValidationError([`Unknown nature of payment ${id}`])
  if (was.kind !== n.kind && was.used) throw new ValidationError(['A nature set on ledgers cannot change between TDS and TCS'])
  await pool
    .query(
      `UPDATE tds_natures SET name = $3, kind = $4, section = $5, collection_code = $6, rate_individual = $7, rate_other = $8, rate_no_pan = $9, threshold_single = $10,
              threshold_annual = $11, excess_only = $12 WHERE id = $1 AND company_id = $2`,
      [id, companyId, ...natureValues(n)],
    )
    .catch(natureTaken(n.name))
}
export async function deleteNature(companyId: number, id: number) {
  return withTx(async (tx) => {
    const n = (await tx.query<{ name: string }>(`SELECT name FROM tds_natures WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, companyId])).rows[0]
    if (!n) throw new ValidationError([`Unknown nature of payment ${id}`])
    if ((await tx.query(`SELECT 1 FROM ledgers WHERE tds_nature_id = $1 LIMIT 1`, [id])).rowCount)
      throw new ValidationError([`${n.name} is set on ledgers; change them first`])
    await tx.query(`DELETE FROM tds_natures WHERE id = $1`, [id])
  })
}

export interface TdsSettings {
  tan: string | null
  deductorType: 'Government' | 'Others'
  responsible: string | null
}
export async function getTdsSettings(db: Db, companyId: number): Promise<TdsSettings> {
  return (await db.query(`SELECT tan, tds_deductor_type "deductorType", tds_responsible responsible FROM companies WHERE id = $1`, [companyId])).rows[0]
}
/** The TAN (TDS and TCS share it) and deductor; the first time, the standard natures come with it. */
export async function setTdsSettings(companyId: number, s: TdsSettings) {
  const tan = s.tan?.trim().toUpperCase() || null
  const e = tan && tanError(tan)
  if (e) throw new ValidationError([e])
  await withTx(async (tx) => {
    await tx.query(`UPDATE companies SET tan = $2, tds_deductor_type = $3, tds_responsible = $4 WHERE id = $1`, [companyId, tan, s.deductorType, s.responsible?.trim() || null])
    await seedNatures(tx, companyId)
  })
}

/** A nature or deductee type set on a ledger must make sense for its group. */
export async function checkLedgerTds(db: Db, companyId: number, groupId: number | null, natureId: number | null | undefined, deductee: DeducteeType | null | undefined) {
  const errors: string[] = []
  const kind = natureId != null ? (await db.query<{ kind: TaxKind }>(`SELECT kind FROM tds_natures WHERE id = $1 AND company_id = $2`, [natureId, companyId])).rows[0]?.kind : undefined
  if (natureId != null && !kind) errors.push(`Unknown nature of payment ${natureId}`)
  if (groupId !== null) {
    const groups = await loadGroups(db, companyId)
    const party = isUnder(groups, groupId, ['Sundry Creditors', 'Sundry Debtors', 'Current Liabilities', 'Loans (Liability)'])
    if (deductee && !party) errors.push('A deductee type goes on a party ledger (a supplier, a contractor, a buyer)')
    const taxLedger = isUnder(groups, groupId, ['Duties & Taxes'])
    const nature = primaryOf(groups, groupId).nature
    if (kind === 'TDS' && !taxLedger && !['Expenses', 'Assets'].includes(nature))
      errors.push('A nature of payment goes on an expense ledger, or on a TDS ledger under Duties & Taxes')
    if (kind === 'TCS' && !taxLedger && nature !== 'Income') errors.push('A nature of goods goes on a sales ledger, or on a TCS ledger under Duties & Taxes')
  }
  if (errors.length) throw new ValidationError(errors)
}

interface Row {
  voucherId: number
  type: string
  docNo: string
  date: string
  ledgerId: number
  ledger: string
  amount: number
  natureId: number | null
  deductee: DeducteeType | null
  pan: string | null
  country: string | null
  groupId: number | null
}
export interface TdsLineOut extends TdsDue {
  kind: TaxKind
  type: string
  docNo: string
  party: string
  pan: string | null
  country: string | null
  nonResident: boolean
  deducteeType: DeducteeType
  nature: string
  section: string
  collectionCode: string | null
  problems: string[]
}
export interface TdsPayment {
  voucherId: number
  date: string
  docNo: string
  natureId: number
  kind: TaxKind
  section: string
  amount: number
  challan: { bsrCode: string; challanNo: string; challanDate: string } | null
}

/**
 * TCS is collected on the sale consideration: what the buyer is charged (tax and other charges
 * included) less the TCS itself. A voucher with goods of more than one nature shares it out in
 * proportion to their sales.
 */
function collectedOn(partyAmount: number, natures: { amount: number; deducted: number }[]) {
  const sales = natures.reduce((t, x) => t + x.amount, 0)
  if (!sales) return
  const consideration = partyAmount - natures.reduce((t, x) => t + x.deducted, 0)
  let left = consideration
  natures.forEach((x, i) => {
    const share = i === natures.length - 1 ? left : Math.round((consideration * x.amount) / sales)
    x.amount = share
    left -= share
  })
}

/**
 * Every TDS and TCS line from the start of the financial year of `from` to `to` (so thresholds
 * count the year's earlier amounts), and the payments of the tax; callers keep what falls in their
 * period and is of their kind.
 */
async function tdsBooks(companyId: number, from: string, to: string) {
  const company = (await getCompany(pool, companyId))!
  const yearStart = fyStartOf(from, company.fyStart)
  const groups = await loadGroups(pool, companyId)
  const natures = new Map((await listNatures(pool, companyId)).map((n) => [n.id, n]))
  const partyRates = await loadPartyRates(pool, companyId)
  const { rows } = await pool.query<Row>(
    `SELECT v.id "voucherId", v.type, COALESCE(v.doc_no, v.number::text) "docNo", to_char(v.date, 'YYYY-MM-DD') date,
            e.ledger_id "ledgerId", l.name ledger, e.amount::float8 amount, l.tds_nature_id "natureId", l.deductee_type deductee, l.pan, l.country, l.group_id "groupId"
       FROM vouchers v JOIN entries e ON e.voucher_id = v.id JOIN ledgers l ON l.id = e.ledger_id
      WHERE v.company_id = $1 AND v.date BETWEEN $2 AND $3 AND NOT v.cancelled AND NOT v.optional
        AND (l.tds_nature_id IS NOT NULL OR l.deductee_type IS NOT NULL)
      ORDER BY v.date, v.id, e.line`,
    [companyId, yearStart, to],
  )
  const taxLedger = (r: Row) => r.groupId !== null && isUnder(groups, r.groupId, ['Duties & Taxes'])
  const isTcs = (id: number) => natures.get(id)?.kind === 'TCS'
  const byVoucher = new Map<number, Row[]>()
  for (const r of rows) (byVoucher.get(r.voucherId) ?? byVoucher.set(r.voucherId, []).get(r.voucherId)!).push(r)
  const lines: (TdsLine & { party: Row; type: string; docNo: string })[] = []
  const payments: TdsPayment[] = []
  for (const vr of byVoucher.values()) {
    const party = vr.find((r) => r.deductee)
    const tax = vr.filter((r) => r.natureId !== null && taxLedger(r))
    if (!party) {
      // no party in the voucher: a debit to a TDS or TCS ledger is the tax paid to the government
      for (const t of tax.filter((t) => t.amount > 0)) {
        const n = natures.get(t.natureId!)
        payments.push({ voucherId: t.voucherId, date: t.date, docNo: t.docNo, natureId: t.natureId!, kind: n?.kind ?? 'TDS', section: n?.section ?? '', amount: t.amount, challan: null })
      }
      continue
    }
    const byNature = new Map<number, { amount: number; deducted: number }>()
    const at = (id: number) => byNature.get(id) ?? byNature.set(id, { amount: 0, deducted: 0 }).get(id)!
    // a purchase or expense is a debit; a sale a credit to the sales ledger
    for (const r of vr) if (r.natureId !== null && !taxLedger(r) && r !== party) at(r.natureId).amount += isTcs(r.natureId) ? -r.amount : r.amount
    for (const t of tax) at(t.natureId!).deducted -= t.amount
    const partyAmount = vr.filter((r) => r.ledgerId === party.ledgerId).reduce((t, r) => t + r.amount, 0)
    collectedOn(partyAmount, [...byNature].filter(([id]) => isTcs(id)).map(([, x]) => x))
    for (const [natureId, x] of byNature)
      lines.push({ voucherId: party.voucherId, date: party.date, partyId: party.ledgerId, natureId, ...x, party, type: party.type, docNo: party.docNo })
  }
  // challans of the payments
  if (payments.length) {
    const ch = await pool.query<{ voucherId: number; bsrCode: string; challanNo: string; challanDate: string }>(
      `SELECT voucher_id "voucherId", bsr_code "bsrCode", challan_no "challanNo", to_char(challan_date, 'YYYY-MM-DD') "challanDate" FROM tds_challans WHERE voucher_id = ANY($1)`,
      [payments.map((p) => p.voucherId)],
    )
    for (const p of payments) {
      const c = ch.rows.find((x) => x.voucherId === p.voucherId)
      p.challan = c ? { bsrCode: c.bsrCode, challanNo: c.challanNo, challanDate: c.challanDate } : null
    }
  }
  // due, party by party and nature by nature through each financial year
  const groupsOf = new Map<string, typeof lines>()
  for (const l of lines) {
    const k = `${l.partyId}|${l.natureId}|${fyStartOf(l.date, company.fyStart)}`
    ;(groupsOf.get(k) ?? groupsOf.set(k, []).get(k)!).push(l)
  }
  const out: TdsLineOut[] = []
  for (const ls of groupsOf.values()) {
    const n = natures.get(ls[0].natureId)!
    const p = ls[0].party
    const own = partyRates.filter((r) => r.ledgerId === p.ledgerId && (r.natureId === null || r.natureId === n.id))
    const due = dueThroughYear(n, p.deductee!, !!p.pan, ls.map(({ party: _, type: _t, docNo: _d, ...l }) => l), own)
    due.forEach((d, i) => {
      const problems: string[] = []
      if (!p.pan && d.due && !d.special) problems.push(`No PAN: the higher rate of section ${n.kind === 'TCS' ? '206CC' : '206AA'} applies`)
      if (d.short > 100) problems.push(`${n.kind} short by ${(d.short / 100).toFixed(2)}`)
      else if (d.short < -100) problems.push(`${n.kind} more than due by ${(-d.short / 100).toFixed(2)}`)
      out.push({
        ...d, kind: n.kind, type: ls[i].type, docNo: ls[i].docNo, party: p.ledger, pan: p.pan, country: p.country, nonResident: n.kind === 'TDS' && isNonResident(p.country),
        deducteeType: p.deductee!, nature: n.name, section: n.section, collectionCode: n.collectionCode, problems,
      })
    })
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.voucherId - b.voucherId)
  return { company, natures, lines: out, payments }
}

/** TDS (or TCS) Computation: each voucher's amount under a nature, what was due and what was deducted or collected. */
export async function tdsComputation(companyId: number, from: string, to: string, kind: TaxKind = 'TDS') {
  const { lines } = await tdsBooks(companyId, from, to)
  return lines.filter((l) => l.date >= from && l.kind === kind)
}

/** TDS (or TCS) Outstandings by nature: deducted or collected in the period, paid, and what is still to be paid. */
export async function tdsOutstandings(companyId: number, from: string, to: string, kind: TaxKind = 'TDS') {
  const books = await tdsBooks(companyId, from, to)
  const natures = books.natures
  const lines = books.lines.filter((l) => l.kind === kind)
  const payments = books.payments.filter((p) => p.kind === kind)
  const rows = new Map<number, { natureId: number; nature: string; section: string; due: number; deducted: number; paid: number; payable: number }>()
  const at = (id: number) =>
    rows.get(id) ?? rows.set(id, { natureId: id, nature: natures.get(id)?.name ?? '', section: natures.get(id)?.section ?? '', due: 0, deducted: 0, paid: 0, payable: 0 }).get(id)!
  // what is payable runs from the start of the year; due and deducted are the period's
  for (const l of lines) {
    const r = at(l.natureId)
    r.payable += l.deducted
    if (l.date >= from) {
      r.due += l.due
      r.deducted += l.deducted
    }
  }
  for (const p of payments) {
    const r = at(p.natureId)
    r.payable -= p.amount
    if (p.date >= from) r.paid += p.amount
  }
  return {
    natures: [...rows.values()].sort((a, b) => a.section.localeCompare(b.section) || a.nature.localeCompare(b.nature)),
    parties: lines.filter((l) => l.date >= from && (l.due || l.deducted)),
    payments: payments.filter((p) => p.date >= from),
    unpaidChallans: payments.filter((p) => p.date >= from && !p.challan).length,
  }
}

/**
 * The year's deductions (or collections) matched to the payments that deposited them: each, in
 * date order, to the earliest payment of its section on or after it with tax left. Payments are
 * numbered from the start of the year, as the challan serials of the returns.
 */
function matchChallans(lines: TdsLineOut[], payments: TdsPayment[], yearStart: string) {
  const challans = payments.filter((p) => p.date >= yearStart).map((p, i) => ({ ...p, serial: i + 1, left: p.amount }))
  const matched = new Map<TdsLineOut, (typeof challans)[number]>()
  for (const l of lines.filter((l) => l.date >= yearStart && l.deducted > 0)) {
    const c = challans.find((c) => c.section === l.section && c.date >= l.date && c.left >= l.deducted)
    if (!c) continue
    c.left -= l.deducted
    matched.set(l, c)
  }
  return { challans, matched }
}

export type ReturnForm = '26Q' | '27Q' | '27EQ'
const FORM_LINES: Record<ReturnForm, (l: TdsLineOut) => boolean> = {
  '26Q': (l) => l.kind === 'TDS' && !l.nonResident,
  '27Q': (l) => l.kind === 'TDS' && l.nonResident,
  '27EQ': (l) => l.kind === 'TCS',
}

/**
 * A quarterly return for a quarter of the financial year starting `fyStart`: Form 26Q (TDS on
 * residents), 27Q (TDS on non-residents) or 27EQ (TCS). The deductor, each deduction or collection
 * (party code, PAN, section or collection code, dates, amount, tax, rate) with the challan that
 * paid it, and the challans.
 */
export async function quarterlyReturn(companyId: number, fyStart: string, quarter: 1 | 2 | 3 | 4, form: ReturnForm = '26Q') {
  const y = Number(fyStart.slice(0, 4))
  const starts = [`${y}-04-01`, `${y}-07-01`, `${y}-10-01`, `${y + 1}-01-01`]
  const ends = [`${y}-06-30`, `${y}-09-30`, `${y}-12-31`, `${y + 1}-03-31`]
  const from = starts[quarter - 1]
  const to = ends[quarter - 1]
  // challans may be paid up to the 30th of April for March, the 7th of the next month otherwise: look a little past the year
  const { company, lines, payments } = await tdsBooks(companyId, starts[0], `${y + 1}-05-31`)
  const kind: TaxKind = form === '27EQ' ? 'TCS' : 'TDS'
  const settings = await getTdsSettings(pool, companyId)
  const { challans, matched } = matchChallans(lines.filter((l) => l.kind === kind), payments.filter((p) => p.kind === kind), starts[0])
  const deductions = lines
    .filter((l) => l.date >= from && l.date <= to && l.deducted > 0 && FORM_LINES[form](l))
    .map((l) => {
      const c = matched.get(l)
      return {
        deducteeCode: deducteeCode(l.deducteeType), pan: l.pan ?? 'PANNOTAVBL', name: l.party, section: l.section, collectionCode: l.collectionCode, country: l.country,
        date: l.date, amount: l.amount, tds: l.deducted, rate: l.rate, docNo: l.docNo, voucherId: l.voucherId,
        // the return's reason code: A, a lower or no deduction on a certificate; C, the higher rate without a PAN
        reason: l.special === 'certificate' ? 'A' : !l.pan && l.kind === 'TDS' ? 'C' : null, certificateNo: l.certificateNo ?? null, special: l.special ?? null,
        challan: c ? { serial: c.serial, bsrCode: c.challan?.bsrCode ?? null, challanNo: c.challan?.challanNo ?? null, challanDate: c.challan?.challanDate ?? c.date } : null,
      }
    })
  const used = new Set(deductions.map((d) => d.challan?.serial))
  const word = kind === 'TCS' ? 'collection' : 'deduction'
  const problems = [
    ...(!settings.tan ? ['Set the TAN (Alt+K, TDS Details)'] : []),
    ...deductions.filter((d) => !d.challan).map((d) => `${d.name} (${d.section}, ${d.docNo}): no ${kind} payment matches this ${word} yet`),
    ...challans.filter((c) => used.has(c.serial) && !c.challan).map((c) => `Payment ${c.docNo} of ${(c.amount / 100).toFixed(2)} has no challan details`),
    ...deductions.filter((d) => d.pan === 'PANNOTAVBL').map((d) => `${d.name}: no PAN`),
    ...(form === '27EQ' ? deductions.filter((d) => !d.collectionCode).map((d) => `${d.name} (${d.docNo}): the nature of goods has no collection code`) : []),
  ]
  return {
    form,
    title: returnTitle(form, fyStart),
    deductor: { name: company.name, tan: settings.tan, type: settings.deductorType, responsible: settings.responsible, address: company.address },
    fyStart, quarter, from, to,
    deductions,
    challans: challans.filter((c) => used.has(c.serial)).map(({ left: _, ...c }) => c),
    total: { amount: deductions.reduce((t, d) => t + d.amount, 0), tds: deductions.reduce((t, d) => t + d.tds, 0) },
    problems,
  }
}
/**
 * The statement's name for a year: under the Income-tax Act, 2025 (tax year 2026-27 on) Form 26Q
 * is Form 140, 27Q is Form 144 and 27EQ is Form 143; earlier quarters keep the 1961 Act's forms.
 */
export function returnTitle(form: ReturnForm, fyStart: string) {
  if (fyStart < '2026-04-01') return `Form ${form}`
  return `Form ${({ '26Q': '140', '27Q': '144', '27EQ': '143' } as const)[form]} (was ${form})`
}
export const form26q = (companyId: number, fyStart: string, quarter: 1 | 2 | 3 | 4) => quarterlyReturn(companyId, fyStart, quarter, '26Q')

/**
 * Challan Reconciliation: every payment of TDS and TCS in the period with its challan details, how
 * much of it the year's deductions and collections account for, and what is left unallocated.
 */
export async function challanReconciliation(companyId: number, from: string, to: string) {
  const company = (await getCompany(pool, companyId))!
  const yearStart = fyStartOf(from, company.fyStart)
  const { lines, payments } = await tdsBooks(companyId, yearStart, to)
  const { challans, matched } = matchChallans(lines, payments, yearStart)
  const count = new Map<number, number>()
  for (const c of matched.values()) count.set(c.serial, (count.get(c.serial) ?? 0) + 1)
  return {
    payments: challans
      .filter((c) => c.date >= from && c.date <= to)
      .map(({ left, ...c }) => ({ ...c, allocated: c.amount - left, unallocated: left, deductions: count.get(c.serial) ?? 0 })),
    unmatched: lines.filter((l) => l.date >= from && l.deducted > 0 && !matched.has(l)).length,
  }
}

/** A quarter of the financial year containing a date. */
export const quarterFor = (date: string) => quarterOf(date) as 1 | 2 | 3 | 4

const challanErrors = (c: { bsrCode: string; challanNo: string; challanDate: string }) => {
  const errors: string[] = []
  if (!/^[0-9]{7}$/.test(c.bsrCode)) errors.push('The BSR code has 7 digits')
  if (!/^[0-9]{5}$/.test(c.challanNo)) errors.push('The challan serial number has 5 digits')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.challanDate)) errors.push('Give the date of deposit')
  return errors
}

/** The challan of a payment of TDS or TCS (BSR code, challan serial number, date of deposit). */
export async function setChallan(companyId: number, voucherId: number, c: { bsrCode: string; challanNo: string; challanDate: string } | null) {
  return setChallans(companyId, [{ voucherId, challan: c }])
}

/** Challans of several payments at once (Challan Reconciliation); all or none are saved. */
export async function setChallans(companyId: number, items: { voucherId: number; challan: { bsrCode: string; challanNo: string; challanDate: string } | null }[]) {
  const errors: string[] = []
  for (const { voucherId, challan } of items) if (challan) errors.push(...challanErrors(challan).map((e) => (items.length > 1 ? `Voucher ${voucherId}: ${e}` : e)))
  if (errors.length) throw new ValidationError(errors)
  await withTx(async (tx) => {
    for (const { voucherId, challan: c } of items) {
      if (!(await tx.query(`SELECT 1 FROM vouchers WHERE id = $1 AND company_id = $2`, [voucherId, companyId])).rowCount) throw new ValidationError([`Unknown voucher ${voucherId}`])
      if (!c) await tx.query(`DELETE FROM tds_challans WHERE voucher_id = $1`, [voucherId])
      else
        await tx.query(
          `INSERT INTO tds_challans (voucher_id, bsr_code, challan_no, challan_date) VALUES ($1,$2,$3,$4)
           ON CONFLICT (voucher_id) DO UPDATE SET bsr_code = $2, challan_no = $3, challan_date = $4`,
          [voucherId, c.bsrCode, c.challanNo, c.challanDate],
        )
    }
  })
}

/**
 * What TDS or TCS a voucher being entered should carry: for its party and each nature in it, the
 * due amount given the year's earlier vouchers (the voucher itself left out when it is being
 * altered), and the tax ledger to book it on.
 */
export async function suggestTds(companyId: number, v: { id?: number; date: string; entries: { ledgerId: number; amount: number }[] }) {
  const company = (await getCompany(pool, companyId))!
  const groups = await loadGroups(pool, companyId)
  const ids = v.entries.map((e) => e.ledgerId)
  const ls = (await pool.query<{ id: number; name: string; natureId: number | null; deductee: DeducteeType | null; pan: string | null; groupId: number | null }>(
    `SELECT id, name, tds_nature_id "natureId", deductee_type deductee, pan, group_id "groupId" FROM ledgers WHERE company_id = $1 AND id = ANY($2)`, [companyId, ids],
  )).rows
  const party = ls.find((l) => l.deductee)
  if (!party) return []
  const natures = new Map((await listNatures(pool, companyId)).map((n) => [n.id, n]))
  const isTax = (l: { groupId: number | null }) => l.groupId !== null && isUnder(groups, l.groupId, ['Duties & Taxes'])
  const amounts = new Map<number, { amount: number; deducted: number }>()
  let partyAmount = 0
  for (const e of v.entries) {
    const l = ls.find((x) => x.id === e.ledgerId)
    if (l === party) partyAmount += e.amount
    else if (l?.natureId && !isTax(l)) {
      const x = amounts.get(l.natureId) ?? amounts.set(l.natureId, { amount: 0, deducted: 0 }).get(l.natureId)!
      x.amount += natures.get(l.natureId)?.kind === 'TCS' ? -e.amount : e.amount
    }
  }
  // TCS already on the voucher comes off the consideration it is worked out on
  for (const e of v.entries) {
    const l = ls.find((x) => x.id === e.ledgerId)
    if (l?.natureId && isTax(l) && amounts.has(l.natureId)) amounts.get(l.natureId)!.deducted -= e.amount
  }
  collectedOn(partyAmount, [...amounts].filter(([id]) => natures.get(id)?.kind === 'TCS').map(([, x]) => x))
  const { lines } = await tdsBooks(companyId, fyStartOf(v.date, company.fyStart), v.date)
  const out = []
  for (const [natureId, { amount }] of amounts) {
    const n = natures.get(natureId)!
    const earlier = lines
      .filter((l) => l.partyId === party.id && l.natureId === natureId && l.voucherId !== v.id)
      .map((l) => ({ voucherId: l.voucherId, date: l.date, partyId: l.partyId, natureId, amount: l.amount, deducted: l.deducted }))
    const all = dueThroughYear(n, party.deductee!, !!party.pan, [...earlier, { voucherId: v.id ?? 0, date: v.date, partyId: party.id, natureId, amount, deducted: 0 }])
    const mine = all[all.length - 1]
    const taxLedgers = (await pool.query<{ id: number; name: string; groupId: number }>(
      `SELECT id, name, group_id "groupId" FROM ledgers WHERE company_id = $1 AND tds_nature_id = $2 ORDER BY id`, [companyId, natureId],
    )).rows.filter((l) => isTax(l))
    out.push({
      natureId, kind: n.kind, nature: n.name, section: n.section, partyId: party.id, party: party.name, amount, assessable: mine.assessable, rate: mine.rate, due: mine.due,
      ledgerId: taxLedgers[0]?.id ?? null, ledger: taxLedgers[0]?.name ?? null,
    })
  }
  return out
}

// ------------------------------------------------------------------ a party's own rates

export interface PartyRateInput {
  ledgerId: number
  natureId: number | null // null: every nature
  kind: 'certificate' | 'dtaa'
  rate: number
  certificateNo?: string | null
  validFrom: string
  validTo: string
  limit?: number | null
}

async function loadPartyRates(db: Db, companyId: number) {
  return (await db.query<PartyRate & { id: number; ledgerId: number; natureId: number | null; party: string; nature: string | null }>(
    `SELECT r.id, r.ledger_id "ledgerId", l.name party, r.nature_id "natureId", n.name nature, r.kind, r.rate, r.certificate_no "certificateNo",
            to_char(r.valid_from, 'YYYY-MM-DD') "validFrom", to_char(r.valid_to, 'YYYY-MM-DD') "validTo", r.amount_limit::float8 "limit"
       FROM tds_party_rates r JOIN ledgers l ON l.id = r.ledger_id LEFT JOIN tds_natures n ON n.id = r.nature_id
      WHERE r.company_id = $1 ORDER BY l.name, r.valid_from`,
    [companyId],
  )).rows
}
export const listPartyRates = (companyId: number) => loadPartyRates(pool, companyId)

export async function createPartyRate(companyId: number, r: PartyRateInput) {
  const errors: string[] = []
  const l = (await pool.query<{ country: string | null; pan: string | null }>(`SELECT country, pan FROM ledgers WHERE id = $1 AND company_id = $2`, [r.ledgerId, companyId])).rows[0]
  if (!l) errors.push('Choose the party')
  if (r.natureId !== null && !(await pool.query(`SELECT 1 FROM tds_natures WHERE id = $1 AND company_id = $2`, [r.natureId, companyId])).rowCount) errors.push('Unknown nature of payment')
  if (!Number.isInteger(r.rate) || r.rate < 0 || r.rate > 10000) errors.push('The rate is between 0% and 100%')
  if (r.validTo < r.validFrom) errors.push('The certificate ends before it begins')
  if (r.kind === 'certificate') {
    if (!r.certificateNo?.trim()) errors.push('Give the certificate number (from TRACES)')
    if (l && !l.pan) errors.push('A section 197 certificate is issued against a PAN: give the party its PAN first')
  } else if (l && !isNonResident(l.country)) errors.push('A treaty (DTAA) rate is for a party outside India: set its country')
  if (r.limit != null && !(r.limit > 0)) errors.push('The amount the certificate covers is above zero')
  if (errors.length) throw new ValidationError(errors)
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO tds_party_rates (company_id, ledger_id, nature_id, kind, rate, certificate_no, valid_from, valid_to, amount_limit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [companyId, r.ledgerId, r.natureId, r.kind, r.rate, r.certificateNo?.trim() || null, r.validFrom, r.validTo, r.kind === 'certificate' ? (r.limit ?? null) : null],
  )
  return rows[0].id
}

export async function deletePartyRate(companyId: number, id: number) {
  const { rowCount } = await pool.query(`DELETE FROM tds_party_rates WHERE id = $1 AND company_id = $2`, [id, companyId])
  if (!rowCount) throw new ValidationError(['Unknown party rate'])
}
