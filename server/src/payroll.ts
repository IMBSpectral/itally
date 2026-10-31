/**
 * Payroll: the masters (employee categories, groups and employees, which are cost categories and
 * cost centres; attendance and production types; pay heads, which are ledgers; salary details),
 * the Payroll voucher's auto-fill, and the payroll reports, all read from the cost allocations of
 * Payroll vouchers and the lines of Attendance vouchers.
 */
import { pool, withTx, type Queryable } from './db'
import { createLedger, deleteLedger, getCompany, loadGroups, loadLedgers, ValidationError } from './books'
import { alterCostCentre, createCostCentre } from './costcentres'
import { fyStartOf } from './engine/numbering'
import {
  computePay, daysOnRolls, gratuity, monthsIn, monthsLeftInYear, PAY_TYPES, salaryTax, sideOf, isTaxable, STATUTORY,
  type AttendanceKind, type AttendanceType, type Calculation, type FormulaTerm, type PayHead, type PayType, type Rounding, type SalaryLine, type Slab, type Statutory, type Declarations,
} from './engine/payroll'
import type { EntryInput } from './engine/voucher'

const uniqueName = (name: string) => (err: { code?: string }) => {
  if (err.code === '23505') throw new ValidationError([`The name "${name}" is already used`])
  throw err
}
const checkViolation = (err: { code?: string; constraint?: string }) => {
  if (err.code === '23514') {
    const what: Record<string, string> = {
      employees_pan_check: 'A PAN is 5 letters, 4 digits and a letter',
      employees_uan_check: 'A UAN is 12 digits',
      employees_esi_number_check: 'An ESI IP number is 10 digits',
      employees_pran_check: 'A PRAN is 12 digits',
      employees_ifsc_check: 'An IFSC is 4 letters, a 0 and 6 letters or digits',
      employees_check: 'The date of leaving is before the date of joining',
    }
    throw new ValidationError([what[err.constraint ?? ''] ?? 'An employee detail is not valid'])
  }
  throw err
}

// ------------------------------------------------------------------ employee groups and employees

export interface EmployeeDetails {
  number?: string | null
  designation?: string | null
  department?: string | null
  location?: string | null
  gender?: 'Male' | 'Female' | 'Other' | null
  dateOfBirth?: string | null
  dateOfJoining: string
  dateOfLeaving?: string | null
  pan?: string | null
  uan?: string | null
  pfNumber?: string | null
  esiNumber?: string | null
  pran?: string | null
  bankName?: string | null
  accountNo?: string | null
  ifsc?: string | null
  taxRegime?: 'new' | 'old'
}
export interface EmployeeInput extends EmployeeDetails {
  name: string
  categoryId?: number | null
  groupId?: number | null // an employee group; none = directly under the category
}

async function checkParent(db: Queryable, companyId: number, parentId: number | null | undefined) {
  if (!parentId) return
  const { rows } = await db.query<{ kind: string }>(`SELECT kind FROM cost_centres WHERE id = $1 AND company_id = $2`, [parentId, companyId])
  if (rows[0]?.kind !== 'employee group') throw new ValidationError(['An employee or employee group sits under an employee group'])
}

export async function createEmployeeGroup(companyId: number, g: { name: string; categoryId?: number | null; parentId?: number | null }) {
  await checkParent(pool, companyId, g.parentId)
  const id = await createCostCentre(companyId, g)
  await pool.query(`UPDATE cost_centres SET kind = 'employee group' WHERE id = $1`, [id])
  return id
}
export async function alterEmployeeGroup(companyId: number, id: number, g: { name: string; categoryId?: number | null; parentId?: number | null }) {
  await kindOf(companyId, id, 'employee group')
  await checkParent(pool, companyId, g.parentId)
  await alterCostCentre(companyId, id, g)
}

async function kindOf(companyId: number, id: number, kind: string) {
  const { rows } = await pool.query<{ kind: string }>(`SELECT kind FROM cost_centres WHERE id = $1 AND company_id = $2`, [id, companyId])
  if (rows[0]?.kind !== kind) throw new ValidationError([`Unknown ${kind} ${id}`])
}

const detailValues = (e: EmployeeDetails) => {
  const t = (s: string | null | undefined) => s?.trim() || null
  return [t(e.number), t(e.designation), t(e.department), t(e.location), e.gender ?? null, e.dateOfBirth || null, e.dateOfJoining, e.dateOfLeaving || null,
    t(e.pan)?.toUpperCase() ?? null, t(e.uan), t(e.pfNumber), t(e.esiNumber), t(e.pran), t(e.bankName), t(e.accountNo), t(e.ifsc)?.toUpperCase() ?? null, e.taxRegime ?? 'new']
}
const DETAIL_COLUMNS = `number, designation, department, location, gender, date_of_birth, date_of_joining, date_of_leaving, pan, uan, pf_number, esi_number, pran,
  bank_name, account_no, ifsc, tax_regime`

export async function createEmployee(companyId: number, e: EmployeeInput) {
  if (!e.dateOfJoining) throw new ValidationError(['Give the date of joining'])
  await checkParent(pool, companyId, e.groupId)
  const id = await createCostCentre(companyId, { name: e.name, categoryId: e.categoryId, parentId: e.groupId })
  try {
    await withTx(async (tx) => {
      await tx.query(`UPDATE cost_centres SET kind = 'employee' WHERE id = $1`, [id])
      await tx.query(`INSERT INTO employees (cost_centre_id, ${DETAIL_COLUMNS}) VALUES ($1,${Array.from({ length: 17 }, (_, i) => `$${i + 2}`).join(',')})`, [id, ...detailValues(e)])
    })
  } catch (err) {
    await pool.query(`DELETE FROM cost_centres WHERE id = $1`, [id])
    checkViolation(err as { code?: string })
  }
  return id
}

export async function alterEmployee(companyId: number, id: number, e: EmployeeInput) {
  await kindOf(companyId, id, 'employee')
  await checkParent(pool, companyId, e.groupId)
  if (!e.dateOfJoining) throw new ValidationError(['Give the date of joining'])
  await withTx(async (tx) => {
    await tx
      .query(`UPDATE employees SET (${DETAIL_COLUMNS}) = (${Array.from({ length: 17 }, (_, i) => `$${i + 2}`).join(',')}) WHERE cost_centre_id = $1`, [id, ...detailValues(e)])
      .catch(checkViolation)
  })
  await alterCostCentre(companyId, id, { name: e.name, categoryId: e.categoryId, parentId: e.groupId })
}

/** An employee or group with no salary booked, attendance recorded or members goes. */
export async function deletePayrollCentre(companyId: number, id: number) {
  return withTx(async (tx) => {
    const cur = (await tx.query<{ name: string; kind: string }>(`SELECT name, kind FROM cost_centres WHERE id = $1 AND company_id = $2`, [id, companyId])).rows[0]
    if (!cur || cur.kind === 'centre') throw new ValidationError(['Unknown employee or employee group'])
    if ((await tx.query(
      `SELECT 1 FROM cost_centres WHERE parent_id = $1 UNION ALL SELECT 1 FROM cost_allocations WHERE cost_centre_id = $1
       UNION ALL SELECT 1 FROM attendance_entries WHERE employee_id = $1 LIMIT 1`, [id])).rowCount)
      throw new ValidationError([`${cur.name} is in use and cannot be deleted`])
    await tx.query(`DELETE FROM cost_centres WHERE id = $1`, [id])
  })
}

// ------------------------------------------------------------------ attendance / production types

export interface AttendanceTypeInput {
  name: string
  kind: AttendanceKind
  unit?: string
}
export async function createAttendanceType(companyId: number, t: AttendanceTypeInput) {
  if (!t.name.trim()) throw new ValidationError(['An attendance type needs a name'])
  const { rows } = await pool
    .query<{ id: number }>(`INSERT INTO attendance_types (company_id, name, kind, unit) VALUES ($1,$2,$3,$4) RETURNING id`,
      [companyId, t.name.trim(), t.kind, t.unit?.trim() || 'Days'])
    .catch(uniqueName(t.name))
  return rows[0].id
}
export async function alterAttendanceType(companyId: number, id: number, t: AttendanceTypeInput) {
  if (!t.name.trim()) throw new ValidationError(['An attendance type needs a name'])
  const used = (await pool.query(`SELECT 1 FROM attendance_entries WHERE attendance_type_id = $1 UNION ALL SELECT 1 FROM pay_heads WHERE attendance_type_id = $1 LIMIT 1`, [id])).rowCount
  const cur = (await pool.query<{ kind: string }>(`SELECT kind FROM attendance_types WHERE id = $1 AND company_id = $2`, [id, companyId])).rows[0]
  if (!cur) throw new ValidationError(['Unknown attendance type'])
  if (used && cur.kind !== t.kind) throw new ValidationError(['The type is in use, so it stays a ' + cur.kind])
  await pool.query(`UPDATE attendance_types SET name = $3, kind = $4, unit = $5 WHERE id = $1 AND company_id = $2`, [id, companyId, t.name.trim(), t.kind, t.unit?.trim() || 'Days'])
    .catch(uniqueName(t.name))
}
export async function deleteAttendanceType(companyId: number, id: number) {
  if ((await pool.query(`SELECT 1 FROM attendance_entries WHERE attendance_type_id = $1 UNION ALL SELECT 1 FROM pay_heads WHERE attendance_type_id = $1 LIMIT 1`, [id])).rowCount)
    throw new ValidationError(['The type is in use and cannot be deleted'])
  await pool.query(`DELETE FROM attendance_types WHERE id = $1 AND company_id = $2`, [id, companyId])
}

// ------------------------------------------------------------------ pay heads

export interface PayHeadInput {
  name: string
  groupId: number // the ledger's group: an expense group for earnings, a liability for deductions
  payType: PayType
  statutory?: Statutory | null
  calculation: Calculation
  attendanceTypeId?: number | null
  perDayDays?: number | null
  formula?: FormulaTerm[]
  ceiling?: number | null
  slabs?: Slab[]
  rounding?: Rounding
  roundTo?: number
  expenseLedgerId?: number | null
  taxComponent?: 'basic' | 'hra' | null
}

async function payHeadErrors(db: Queryable, companyId: number, p: PayHeadInput, self?: number) {
  const errors: string[] = []
  if (!PAY_TYPES.includes(p.payType)) errors.push(`Unknown pay head type "${p.payType}"`)
  if (p.statutory && STATUTORY[p.statutory] && STATUTORY[p.statutory].side !== sideOf(p.payType))
    errors.push(`${STATUTORY[p.statutory].label} is ${STATUTORY[p.statutory].side === 'employer' ? "an employer's contribution" : 'a deduction from employees'}`)
  if (p.calculation === 'attendance' || p.calculation === 'production') {
    const t = p.attendanceTypeId
      ? (await db.query<{ kind: string }>(`SELECT kind FROM attendance_types WHERE id = $1 AND company_id = $2`, [p.attendanceTypeId, companyId])).rows[0]
      : undefined
    if (!t) errors.push(`Choose the ${p.calculation === 'production' ? 'production' : 'attendance'} type it is calculated on`)
    else if ((t.kind === 'production') !== (p.calculation === 'production'))
      errors.push(p.calculation === 'production' ? 'Choose a production type' : 'Choose an attendance or leave type')
  }
  const heads = new Set((await db.query<{ id: number }>(`SELECT p.ledger_id id FROM pay_heads p JOIN ledgers l ON l.id = p.ledger_id WHERE l.company_id = $1`, [companyId])).rows.map((r) => r.id))
  for (const t of p.formula ?? []) {
    if (!heads.has(t.payHeadId)) errors.push(`The formula names an unknown pay head ${t.payHeadId}`)
    if (t.payHeadId === self) errors.push('A pay head is not computed on itself')
  }
  if (p.calculation === 'computed' && p.statutory !== 'income-tax') {
    if (!p.formula?.length) errors.push('Give the pay heads it is computed on')
    if (!p.slabs?.length) errors.push('Give at least one slab (the rate or value)')
  }
  const slabs = p.slabs ?? []
  for (const [i, s] of slabs.entries()) {
    if (s.upTo !== null && i === slabs.length - 1 && slabs.length > 1 && s.upTo < (slabs[i - 1].upTo ?? 0)) errors.push('Slabs go up in order')
    if (s.upTo === null && i < slabs.length - 1) errors.push('Only the last slab has no upper limit')
    if (i > 0 && s.upTo !== null && slabs[i - 1].upTo !== null && s.upTo <= slabs[i - 1].upTo!) errors.push('Slabs go up in order')
    if (s.rate < 0 || s.value < 0) errors.push('A slab cannot be negative')
  }
  if (sideOf(p.payType) === 'employer') {
    if (!p.expenseLedgerId) errors.push("An employer's contribution needs the expense ledger it is charged to")
    else if (!(await db.query(`SELECT 1 FROM ledgers WHERE id = $1 AND company_id = $2`, [p.expenseLedgerId, companyId])).rowCount) errors.push('Unknown expense ledger')
  }
  return [...new Set(errors)]
}

const payHeadValues = (p: PayHeadInput) => [
  p.payType, p.statutory ?? null, p.calculation,
  p.calculation === 'attendance' || p.calculation === 'production' ? p.attendanceTypeId : null,
  p.calculation === 'attendance' ? p.perDayDays ?? null : null,
  JSON.stringify(p.formula ?? []), p.ceiling ?? null, JSON.stringify(p.slabs ?? []), p.rounding ?? 'normal', p.roundTo ?? 100,
  sideOf(p.payType) === 'employer' ? p.expenseLedgerId ?? null : null,
  sideOf(p.payType) === 'earning' ? p.taxComponent ?? null : null,
]

export async function createPayHead(companyId: number, p: PayHeadInput) {
  const errors = await payHeadErrors(pool, companyId, p)
  if (errors.length) throw new ValidationError(errors)
  // a pay head is a ledger whose amounts are split by employee
  const id = await createLedger(companyId, { name: p.name, groupId: p.groupId, costCentres: true })
  try {
    await pool.query(
      `INSERT INTO pay_heads (ledger_id, pay_type, statutory, calculation, attendance_type_id, per_day_days, formula, ceiling, slabs, rounding, round_to, expense_ledger_id, tax_component)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, ...payHeadValues(p)],
    )
  } catch (err) {
    await pool.query(`DELETE FROM ledgers WHERE id = $1`, [id])
    throw err
  }
  return id
}

export async function alterPayHead(companyId: number, id: number, p: PayHeadInput) {
  const errors = await payHeadErrors(pool, companyId, p, id)
  const groups = await loadGroups(pool, companyId)
  if (!groups.has(p.groupId)) errors.push(`Unknown group ${p.groupId}`)
  if (errors.length) throw new ValidationError(errors)
  await withTx(async (tx) => {
    const r = await tx.query(`UPDATE pay_heads SET (pay_type, statutory, calculation, attendance_type_id, per_day_days, formula, ceiling, slabs, rounding, round_to, expense_ledger_id, tax_component)
       = ($2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) WHERE ledger_id = $1 AND ledger_id IN (SELECT id FROM ledgers WHERE company_id = $14)`, [id, ...payHeadValues(p), companyId])
    if (!r.rowCount) throw new ValidationError(['Unknown pay head'])
    await tx.query(`UPDATE ledgers SET name = $2, group_id = $3, cost_centres = true WHERE id = $1`, [id, p.name.trim(), p.groupId]).catch(uniqueName(p.name))
  })
}

export async function deletePayHead(companyId: number, id: number) {
  const { rows } = await pool.query<{ name: string }>(
    `SELECT l.name FROM pay_heads p JOIN ledgers l ON l.id = p.ledger_id
      WHERE l.company_id = $1 AND (p.formula @> $2::jsonb)
      UNION ALL SELECT c.name FROM salary_details s JOIN cost_centres c ON c.id = s.cost_centre_id WHERE c.company_id = $1 AND s.lines @> $2::jsonb LIMIT 1`,
    [companyId, JSON.stringify([{ payHeadId: id }])],
  )
  if (rows[0]) throw new ValidationError([`The pay head is used by ${rows[0].name}`])
  await deleteLedger(companyId, id)
}

async function loadPayHeads(db: Queryable, companyId: number) {
  const { rows } = await db.query<PayHead & { groupId: number; expenseLedgerId: number | null }>(
    `SELECT l.id, l.name, l.group_id "groupId", p.pay_type "payType", p.statutory, p.calculation, p.attendance_type_id "attendanceTypeId", p.per_day_days "perDayDays",
            p.formula, p.ceiling::float8 ceiling, p.slabs, p.rounding, p.round_to "roundTo", p.expense_ledger_id "expenseLedgerId", p.tax_component "taxComponent"
       FROM pay_heads p JOIN ledgers l ON l.id = p.ledger_id WHERE l.company_id = $1 ORDER BY l.name`,
    [companyId],
  )
  return rows
}
async function loadAttendanceTypes(db: Queryable, companyId: number) {
  return (await db.query<AttendanceType & { unit: string }>(`SELECT id, name, kind, unit FROM attendance_types WHERE company_id = $1 ORDER BY name`, [companyId])).rows
}

// ------------------------------------------------------------------ salary details

export async function setSalary(companyId: number, centreId: number, effectiveFrom: string, lines: SalaryLine[]) {
  const { rows } = await pool.query<{ kind: string }>(`SELECT kind FROM cost_centres WHERE id = $1 AND company_id = $2`, [centreId, companyId])
  if (!rows[0] || rows[0].kind === 'centre') throw new ValidationError(['Salary details are kept for an employee or an employee group'])
  const heads = new Set((await loadPayHeads(pool, companyId)).map((h) => h.id))
  const errors: string[] = []
  const seen = new Set<number>()
  for (const l of lines) {
    if (!heads.has(l.payHeadId)) errors.push(`Unknown pay head ${l.payHeadId}`)
    if (seen.has(l.payHeadId)) errors.push('A pay head is in the salary details once')
    seen.add(l.payHeadId)
    if (l.rate !== null && (!Number.isSafeInteger(l.rate) || l.rate < 0)) errors.push('A rate is whole paise, not negative')
  }
  if (errors.length) throw new ValidationError([...new Set(errors)])
  if (!lines.length) await pool.query(`DELETE FROM salary_details WHERE cost_centre_id = $1 AND effective_from = $2`, [centreId, effectiveFrom])
  else
    await pool.query(
      `INSERT INTO salary_details (cost_centre_id, effective_from, lines) VALUES ($1,$2,$3)
       ON CONFLICT (cost_centre_id, effective_from) DO UPDATE SET lines = EXCLUDED.lines`,
      [centreId, effectiveFrom, JSON.stringify(lines.map((l) => ({ payHeadId: l.payHeadId, rate: l.rate })))],
    )
}

// ------------------------------------------------------------------ listing

export async function payrollMasters(db: Queryable, companyId: number) {
  const centres = (await db.query<{ id: number; name: string; kind: string; categoryId: number; parentId: number | null }>(
    `SELECT id, name, kind, category_id "categoryId", parent_id "parentId" FROM cost_centres WHERE company_id = $1 AND kind <> 'centre' ORDER BY name`, [companyId])).rows
  const details = new Map((await db.query<EmployeeDetails & { id: number }>(
    `SELECT e.cost_centre_id id, number, designation, department, location, gender, to_char(date_of_birth,'YYYY-MM-DD') "dateOfBirth",
            to_char(date_of_joining,'YYYY-MM-DD') "dateOfJoining", to_char(date_of_leaving,'YYYY-MM-DD') "dateOfLeaving", pan, uan, pf_number "pfNumber",
            esi_number "esiNumber", pran, bank_name "bankName", account_no "accountNo", ifsc, tax_regime "taxRegime"
       FROM employees e JOIN cost_centres c ON c.id = e.cost_centre_id WHERE c.company_id = $1`, [companyId])).rows.map((r) => [r.id, r]))
  const salary = (await db.query<{ centreId: number; effectiveFrom: string; lines: SalaryLine[] }>(
    `SELECT s.cost_centre_id "centreId", to_char(s.effective_from,'YYYY-MM-DD') "effectiveFrom", s.lines
       FROM salary_details s JOIN cost_centres c ON c.id = s.cost_centre_id WHERE c.company_id = $1 ORDER BY s.effective_from`, [companyId])).rows
  const categories = (await db.query<{ id: number; name: string }>(`SELECT id, name FROM cost_categories WHERE company_id = $1 ORDER BY is_default DESC, name`, [companyId])).rows
  return {
    categories,
    groups: centres.filter((c) => c.kind === 'employee group').map(({ kind: _k, ...c }) => c),
    employees: centres.filter((c) => c.kind === 'employee').map(({ kind: _k, ...c }) => ({ ...c, ...details.get(c.id)!, id: c.id })),
    attendanceTypes: await loadAttendanceTypes(db, companyId),
    payHeads: await loadPayHeads(db, companyId),
    salary,
  }
}
type Masters = Awaited<ReturnType<typeof payrollMasters>>
type Employee = Masters['employees'][number]

/** The salary details in force for an employee on a date: their own, else their group's (and up). */
function salaryOf(m: Masters, e: { id: number; parentId: number | null }, on: string): SalaryLine[] {
  const parentOf = new Map(m.groups.map((g) => [g.id, g.parentId]))
  for (let id: number | null = e.id; id !== null; id = id === e.id ? e.parentId : parentOf.get(id) ?? null) {
    const s = m.salary.filter((x) => x.centreId === id && x.effectiveFrom <= on).at(-1)
    if (s) return s.lines
  }
  return []
}

/** Employees on the rolls in a period, optionally only those under a group. */
function inPeriod(m: Masters, from: string, to: string, groupId?: number | null) {
  const parentOf = new Map(m.groups.map((g) => [g.id, g.parentId]))
  const under = (p: number | null) => {
    for (let x = p; x !== null; x = parentOf.get(x) ?? null) if (x === groupId) return true
    return false
  }
  return m.employees.filter((e) => e.dateOfJoining <= to && (!e.dateOfLeaving || e.dateOfLeaving >= from) && (!groupId || under(e.parentId)))
}

/** Attendance and production recorded in a period: employee -> type -> thousandths. */
async function attendanceIn(db: Queryable, companyId: number, from: string, to: string) {
  const { rows } = await db.query<{ emp: number; type: number; value: string }>(
    `SELECT a.employee_id emp, a.attendance_type_id type, SUM(a.value) value FROM attendance_entries a JOIN vouchers v ON v.id = a.voucher_id
      WHERE v.company_id = $1 AND v.type = 'Attendance' AND NOT v.cancelled AND v.date BETWEEN $2 AND $3 GROUP BY 1, 2`,
    [companyId, from, to],
  )
  const out = new Map<number, Map<number, number>>()
  for (const r of rows) {
    if (!out.has(r.emp)) out.set(r.emp, new Map())
    out.get(r.emp)!.set(r.type, Number(r.value))
  }
  return out
}

/** Every pay head amount booked to employees by Payroll vouchers in a period, signed as pay (+ earning, + deduction, + employer cost). */
async function bookedPay(db: Queryable, companyId: number, from: string, to: string, exceptVoucher?: number) {
  const { rows } = await db.query<{ emp: number; head: number; voucherId: number; date: string; amount: string }>(
    `SELECT ca.cost_centre_id emp, e.ledger_id head, v.id "voucherId", to_char(v.date,'YYYY-MM-DD') date, SUM(ca.amount) amount
       FROM cost_allocations ca JOIN entries e ON e.id = ca.entry_id JOIN vouchers v ON v.id = e.voucher_id JOIN pay_heads p ON p.ledger_id = e.ledger_id
      WHERE v.company_id = $1 AND v.type = 'Payroll' AND v.date BETWEEN $2 AND $3 AND v.id IS DISTINCT FROM $4
      GROUP BY 1, 2, 3, 4`,
    [companyId, from, to, exceptVoucher ?? null],
  )
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }))
}
const asPay = (payType: PayType, amount: number) => (sideOf(payType) === 'earning' ? amount : -amount)

// ------------------------------------------------------------------ the Payroll voucher's auto-fill

export interface FillInput {
  from: string
  to: string
  date: string // the voucher's date
  payableLedgerId: number // Salary Payable (credited with the net pay of each employee)
  groupId?: number | null
  employeeIds?: number[]
  values?: { employeeId: number; payHeadId: number; amount: number }[] // user-defined pay heads typed in the voucher
  voucherId?: number // the voucher being altered (its own pay is not "earlier in the year")
  arrears?: { payHeadId: number; from: string; to: string } // pay a back-dated revision's arrears for those months on this pay head
}

/** Tally's Payroll Auto Fill: every employee's pay for the period, and the voucher's entries split by employee. */
export async function payrollFill(companyId: number, f: FillInput) {
  const company = (await getCompany(pool, companyId))!
  const m = await payrollMasters(pool, companyId)
  const ledgers = await loadLedgers(pool, companyId)
  if (!ledgers.has(f.payableLedgerId)) throw new ValidationError(['Choose the ledger the net pay is credited to'])
  if (f.from > f.to) throw new ValidationError(['The period ends before it begins'])
  const heads = new Map(m.payHeads.map((h) => [h.id, h]))
  const types = new Map(m.attendanceTypes.map((t) => [t.id, t]))
  const att = await attendanceIn(pool, companyId, f.from, f.to)
  const fy = fyStartOf(f.from, company.fyStart)
  const earlier = await bookedPay(pool, companyId, fy, addDay(f.from, -1), f.voucherId)
  const list = inPeriod(m, f.from, f.to, f.groupId).filter((e) => !f.employeeIds?.length || f.employeeIds.includes(e.id))
  const loans = await loanInstalments(pool, companyId, f.from, f.to, f.voucherId)
  const declarations = await loadDeclarations(pool, companyId, fy)
  if (f.arrears && sideOf(heads.get(f.arrears.payHeadId)?.payType ?? 'Deductions from Employees') !== 'earning') throw new ValidationError(['Arrears are paid on an earnings pay head'])
  const arrears = f.arrears ? await payrollArrears(companyId, f.arrears.from, f.arrears.to, f.arrears.payHeadId) : undefined
  const employees = list.map((e) => {
    const mine = earlier.filter((r) => r.emp === e.id)
    const values = new Map((f.values ?? []).filter((v) => v.employeeId === e.id).map((v) => [v.payHeadId, v.amount]))
    const salary = [...salaryOf(m, e, f.to)]
    // what this month recovers of the employee's loans, and the arrears of a revision, go on their pay heads
    const extra = [...(loans.get(e.id) ?? new Map())]
    const arrear = arrears?.employees.find((x) => x.id === e.id)?.total ?? 0
    if (arrear > 0) extra.push([f.arrears!.payHeadId, arrear])
    for (const [head, amount] of extra) {
      if (!values.has(head)) values.set(head, amount)
      if (!salary.some((l) => l.payHeadId === head)) salary.push({ payHeadId: head, rate: null })
    }
    const sumOf = (c: 'basic' | 'hra') => mine.filter((r) => heads.get(r.head)?.taxComponent === c).reduce((s, r) => s + r.amount, 0)
    const pay = computePay(heads, types, {
      id: e.id, joining: e.dateOfJoining, leaving: e.dateOfLeaving ?? null, regime: e.taxRegime ?? 'new', salary,
      attendance: att.get(e.id) ?? new Map(), values,
      ytdTaxable: mine.filter((r) => heads.get(r.head) && isTaxable(heads.get(r.head)!.payType)).reduce((s, r) => s + r.amount, 0),
      ytdTax: -mine.filter((r) => heads.get(r.head)?.statutory === 'income-tax').reduce((s, r) => s + r.amount, 0),
      monthsLeft: monthsLeftInYear(f.from, Number(company.fyStart.slice(5, 7))),
      declarations: declarations.get(e.id) ?? null, ytdBasic: sumOf('basic'), ytdHra: sumOf('hra'),
    }, f.from, f.to)
    if (!salaryOf(m, e, f.to).length) pay.errors.push('no salary details')
    if (pay.net < 0) pay.errors.push('the deductions are more than the earnings')
    return { id: e.id, name: e.name, ...pay }
  })

  // one entry per pay head ledger (and expense ledger, and the payable), split by employee
  const byLedger = new Map<number, Map<number, number>>()
  const add = (ledgerId: number, emp: number, amount: number) => {
    if (!amount) return
    if (!byLedger.has(ledgerId)) byLedger.set(ledgerId, new Map())
    const x = byLedger.get(ledgerId)!
    x.set(emp, (x.get(emp) ?? 0) + amount)
  }
  for (const e of employees) {
    if (e.errors.length) continue
    for (const l of e.lines) {
      const h = heads.get(l.payHeadId)!
      const side = sideOf(h.payType)
      if (side === 'earning') add(h.id, e.id, l.amount)
      else if (side === 'deduction') add(h.id, e.id, -l.amount)
      else {
        add(h.id, e.id, -l.amount)
        add(h.expenseLedgerId!, e.id, l.amount)
      }
    }
    add(f.payableLedgerId, e.id, -e.net)
  }
  const entries: EntryInput[] = []
  for (const [ledgerId, split] of byLedger) {
    const amount = [...split.values()].reduce((s, a) => s + a, 0)
    if (!amount) continue
    const costs = ledgers.get(ledgerId)?.costCentres ? [...split].filter(([, a]) => a).map(([centreId, a]) => ({ centreId, amount: a })) : undefined
    // a ledger whose employees' amounts net to nothing on one side is still one entry
    if (costs && costs.some((c) => Math.sign(c.amount) !== Math.sign(amount))) {
      for (const c of costs) entries.push({ ledgerId, amount: c.amount, costs: [c] })
    } else entries.push({ ledgerId, amount, costs })
  }
  entries.sort((a, b) => b.amount - a.amount)
  return { employees, entries, heads: m.payHeads.filter((h) => employees.some((e) => e.lines.some((l) => l.payHeadId === h.id))).map(({ id, name, payType }) => ({ id, name, payType })) }
}

// ------------------------------------------------------------------ loans and advances

export interface LoanInput {
  employeeId: number
  payHeadId: number // a pay head of type Loans and Advances
  givenOn: string
  amount: number
  instalment: number
  recoverFrom: string // the first month recovered
  note?: string
}

export async function createLoan(companyId: number, l: LoanInput) {
  const errors: string[] = []
  const emp = (await pool.query(`SELECT 1 FROM cost_centres WHERE id = $1 AND company_id = $2 AND kind = 'employee'`, [l.employeeId, companyId])).rowCount
  if (!emp) errors.push('Choose the employee')
  const head = (await loadPayHeads(pool, companyId)).find((h) => h.id === l.payHeadId)
  if (!head || head.payType !== 'Loans and Advances') errors.push('Choose a pay head of type Loans and Advances')
  if (!(l.amount > 0) || !(l.instalment > 0)) errors.push('The loan and its instalment are above zero')
  if (l.instalment > l.amount) errors.push('The instalment is more than the loan')
  if (l.recoverFrom < l.givenOn) errors.push('Recovery starts after the loan is given')
  if (errors.length) throw new ValidationError(errors)
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO employee_loans (company_id, employee_id, pay_head_id, given_on, amount, instalment, recover_from, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [companyId, l.employeeId, l.payHeadId, l.givenOn, l.amount, l.instalment, l.recoverFrom, l.note?.trim() ?? ''],
  )
  return rows[0].id
}

export async function deleteLoan(companyId: number, id: number) {
  const { rowCount } = await pool.query(`DELETE FROM employee_loans WHERE id = $1 AND company_id = $2`, [id, companyId])
  if (!rowCount) throw new ValidationError(['Unknown loan'])
}

/**
 * Loans and advances as on a date: each loan with what has been recovered of it through its pay
 * head and what is left. Recoveries on a pay head settle the oldest loan on it first.
 */
export async function loanSchedule(db: Queryable, companyId: number, asOf: string, exceptVoucher?: number) {
  const loans = (await db.query<{ id: number; employeeId: number; employee: string; payHeadId: number; payHead: string; givenOn: string; amount: number; instalment: number
    recoverFrom: string; note: string }>(
    `SELECT el.id, el.employee_id "employeeId", c.name employee, el.pay_head_id "payHeadId", l.name "payHead", to_char(el.given_on,'YYYY-MM-DD') "givenOn",
            el.amount::float8 amount, el.instalment::float8 instalment, to_char(el.recover_from,'YYYY-MM-DD') "recoverFrom", el.note
       FROM employee_loans el JOIN cost_centres c ON c.id = el.employee_id JOIN ledgers l ON l.id = el.pay_head_id
      WHERE el.company_id = $1 AND el.given_on <= $2 ORDER BY c.name, el.given_on, el.id`,
    [companyId, asOf],
  )).rows
  const recovered = new Map((await db.query<{ k: string; s: number }>(
    `SELECT ca.cost_centre_id || '|' || e.ledger_id k, -SUM(ca.amount)::float8 s
       FROM cost_allocations ca JOIN entries e ON e.id = ca.entry_id JOIN vouchers v ON v.id = e.voucher_id
      WHERE v.company_id = $1 AND v.type = 'Payroll' AND NOT v.cancelled AND v.date <= $2 AND v.id IS DISTINCT FROM $3
        AND e.ledger_id IN (SELECT pay_head_id FROM employee_loans WHERE company_id = $1)
      GROUP BY 1`,
    [companyId, asOf, exceptVoucher ?? null],
  )).rows.map((r) => [r.k, r.s]))
  return loans.map((l) => {
    const k = `${l.employeeId}|${l.payHeadId}`
    const left = recovered.get(k) ?? 0
    const take = Math.min(left, l.amount)
    recovered.set(k, left - take)
    return { ...l, recovered: take, outstanding: l.amount - take }
  })
}

/** What a period's payroll recovers of each employee's loans: employee -> pay head -> amount. */
async function loanInstalments(db: Queryable, companyId: number, from: string, to: string, exceptVoucher?: number) {
  const out = new Map<number, Map<number, number>>()
  for (const l of await loanSchedule(db, companyId, addDay(from, -1), exceptVoucher)) {
    if (l.recoverFrom > to || l.outstanding <= 0) continue
    const heads = out.get(l.employeeId) ?? out.set(l.employeeId, new Map()).get(l.employeeId)!
    heads.set(l.payHeadId, (heads.get(l.payHeadId) ?? 0) + Math.min(l.instalment, l.outstanding))
  }
  return out
}

// ------------------------------------------------------------------ the old regime's declarations

const loadDeclarations = async (db: Queryable, companyId: number, fyStart: string) =>
  new Map((await db.query<Declarations & { employeeId: number }>(
    `SELECT d.employee_id "employeeId", d.rent_paid::float8 "rentPaid", d.metro, d.sec80c::float8 sec80c, d.sec80d::float8 sec80d, d.sec80ccd1b::float8 sec80ccd1b,
            d.sec24b::float8 sec24b, d.other::float8 other
       FROM tax_declarations d JOIN cost_centres c ON c.id = d.employee_id WHERE c.company_id = $1 AND d.fy_start = $2`,
    [companyId, fyStart],
  )).rows.map(({ employeeId, ...d }) => [employeeId, d]))

export async function getDeclarations(companyId: number, employeeId: number, fyStart: string) {
  return (await loadDeclarations(pool, companyId, fyStart)).get(employeeId) ?? null
}

export async function setDeclarations(companyId: number, employeeId: number, fyStart: string, d: Declarations) {
  const emp = (await pool.query(`SELECT 1 FROM cost_centres WHERE id = $1 AND company_id = $2 AND kind = 'employee'`, [employeeId, companyId])).rowCount
  if (!emp) throw new ValidationError(['Unknown employee'])
  await pool.query(
    `INSERT INTO tax_declarations (employee_id, fy_start, rent_paid, metro, sec80c, sec80d, sec80ccd1b, sec24b, other) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (employee_id, fy_start) DO UPDATE SET rent_paid = $3, metro = $4, sec80c = $5, sec80d = $6, sec80ccd1b = $7, sec24b = $8, other = $9`,
    [employeeId, fyStart, d.rentPaid, d.metro, d.sec80c, d.sec80d, d.sec80ccd1b, d.sec24b, d.other],
  )
}

// ------------------------------------------------------------------ arrears

/**
 * Arrears of a back-dated salary revision: for each month of the period, each employee's earnings
 * worked out again on the salary details now in force for that month, less what the Payroll
 * vouchers paid then (amounts typed on user-defined heads are taken as paid). The arrears pay head
 * itself is left out on both sides.
 */
export async function payrollArrears(companyId: number, from: string, to: string, arrearsHeadId?: number) {
  const m = await payrollMasters(pool, companyId)
  const heads = new Map(m.payHeads.map((h) => [h.id, h]))
  const types = new Map(m.attendanceTypes.map((t) => [t.id, t]))
  const months: { from: string; to: string }[] = []
  for (let d = from.slice(0, 7) + '-01'; d <= to; d = addDay(new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0)).toISOString().slice(0, 10), 1))
    months.push({ from: d, to: new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0)).toISOString().slice(0, 10) })
  const rows: { id: number; name: string; month: string; paid: number; due: number; arrears: number }[] = []
  for (const mo of months) {
    const booked = await bookedPay(pool, companyId, mo.from, mo.to)
    const att = await attendanceIn(pool, companyId, mo.from, mo.to)
    for (const e of inPeriod(m, mo.from, mo.to)) {
      const mine = booked.filter((r) => r.emp === e.id && r.head !== arrearsHeadId)
      // only months the payroll ran for the employee
      if (!mine.length) continue
      const earning = (head: number) => !!heads.get(head) && sideOf(heads.get(head)!.payType) === 'earning' && head !== arrearsHeadId
      const paid = mine.filter((r) => earning(r.head)).reduce((s, r) => s + r.amount, 0)
      const values = new Map(mine.filter((r) => heads.get(r.head)?.calculation === 'user').map((r) => [r.head, asPay(heads.get(r.head)!.payType, r.amount)]))
      const pay = computePay(heads, types, {
        id: e.id, joining: e.dateOfJoining, leaving: e.dateOfLeaving ?? null, regime: e.taxRegime ?? 'new', salary: salaryOf(m, e, mo.to),
        attendance: att.get(e.id) ?? new Map(), values, ytdTaxable: 0, ytdTax: 0, monthsLeft: 1,
      }, mo.from, mo.to)
      const due = pay.lines.filter((l) => earning(l.payHeadId)).reduce((s, l) => s + l.amount, 0)
      if (due !== paid) rows.push({ id: e.id, name: e.name, month: mo.from.slice(0, 7), paid, due, arrears: due - paid })
    }
  }
  // arrears already paid on the arrears pay head, in the period or after it
  const settled = arrearsHeadId ? (await bookedPay(pool, companyId, from, '9999-12-31')).filter((r) => r.head === arrearsHeadId) : []
  const employees = [...new Set(rows.map((r) => r.id))].map((id) => {
    const due = rows.filter((r) => r.id === id).reduce((s, r) => s + r.arrears, 0)
    const paid = settled.filter((r) => r.emp === id).reduce((s, r) => s + r.amount, 0)
    return { id, name: rows.find((r) => r.id === id)!.name, due, paid, total: Math.max(due - paid, 0) }
  })
  return { from, to, rows, employees, total: employees.reduce((s, e) => s + e.total, 0) }
}

// ------------------------------------------------------------------ statutory payments

const STATUTORY_DUES: Record<string, Statutory[]> = {
  pf: ['pf', 'eps', 'epf-employer', 'edli', 'pf-admin'], esi: ['esi', 'esi-employer'], pt: ['pt'], 'income-tax': ['income-tax'], nps: ['nps', 'nps-employer'],
}
export type StatutoryKind = keyof typeof STATUTORY_DUES

/**
 * What is due to pay for PF, ESI, professional tax, TDS on salary or NPS for a period: per pay
 * head, what the period's Payroll vouchers booked, less what has been paid on that ledger since
 * the period began. With the PF challan's accounts (1: EPF, 2: admin, 10: EPS, 21: EDLI) and the
 * due date (the 15th of the next month; the 7th for TDS).
 */
export async function statutoryDues(db: Queryable, companyId: number, kind: StatutoryKind, from: string, to: string) {
  const heads = (await loadPayHeads(db, companyId)).filter((h) => h.statutory && STATUTORY_DUES[kind].includes(h.statutory))
  const lines: { ledgerId: number; name: string; statutory: Statutory; booked: number; paid: number; due: number }[] = []
  for (const h of heads) {
    const { rows } = await db.query<{ booked: number; paid: number }>(
      `SELECT COALESCE(-SUM(e.amount) FILTER (WHERE v.type = 'Payroll' AND v.date BETWEEN $2 AND $3), 0)::float8 booked,
              COALESCE(SUM(e.amount) FILTER (WHERE v.type <> 'Payroll' AND v.date >= $2 AND e.amount > 0), 0)::float8 paid
         FROM entries e JOIN vouchers v ON v.id = e.voucher_id WHERE e.ledger_id = $1 AND NOT v.cancelled AND v.company_id = $4`,
      [h.id, from, to, companyId],
    )
    const due = rows[0].booked - rows[0].paid
    if (rows[0].booked) lines.push({ ledgerId: h.id, name: h.name, statutory: h.statutory!, booked: rows[0].booked, paid: rows[0].paid, due: Math.max(due, 0) })
  }
  const sum = (s: Statutory[]) => lines.filter((l) => s.includes(l.statutory)).reduce((t, l) => t + l.due, 0)
  const next = new Date(Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)), kind === 'income-tax' ? 7 : 15)).toISOString().slice(0, 10)
  return {
    kind, from, to, dueDate: next, lines, total: lines.reduce((t, l) => t + l.due, 0),
    ...(kind === 'pf' ? { challan: { ac1: sum(['pf', 'epf-employer']), ac2: sum(['pf-admin']), ac10: sum(['eps']), ac21: sum(['edli']), ac22: 0 } } : {}),
  }
}

function addDay(s: string, n: number) {
  const d = new Date(s + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// ------------------------------------------------------------------ reports

const ORDER: Record<string, number> = { earning: 0, deduction: 1, employer: 2 }

/** Pay Sheet: employees down, pay heads across, with earnings, deductions, net pay and the employer's cost. */
export async function paySheet(db: Queryable, companyId: number, from: string, to: string, groupId?: number | null) {
  const m = await payrollMasters(db, companyId)
  const heads = new Map(m.payHeads.map((h) => [h.id, h]))
  const booked = await bookedPay(db, companyId, from, to)
  const people = new Map(m.employees.map((e) => [e.id, e]))
  const keep = new Set(inPeriod(m, '0001-01-01', '9999-12-31', groupId).map((e) => e.id))
  const rows = new Map<number, { employeeId: number; name: string; number: string | null; amounts: Record<number, number>; earnings: number; deductions: number; employer: number; net: number }>()
  const used = new Set<number>()
  for (const r of booked) {
    const e = people.get(r.emp)
    const h = heads.get(r.head)
    if (!e || !h || !keep.has(e.id)) continue
    used.add(h.id)
    if (!rows.has(e.id)) rows.set(e.id, { employeeId: e.id, name: e.name, number: e.number ?? null, amounts: {}, earnings: 0, deductions: 0, employer: 0, net: 0 })
    const row = rows.get(e.id)!
    const v = asPay(h.payType, r.amount)
    row.amounts[h.id] = (row.amounts[h.id] ?? 0) + v
    const side = sideOf(h.payType)
    if (side === 'earning') row.earnings += v
    else if (side === 'deduction') row.deductions += v
    else row.employer += v
    row.net = row.earnings - row.deductions
  }
  const columns = m.payHeads
    .filter((h) => used.has(h.id))
    .sort((a, b) => ORDER[sideOf(a.payType)] - ORDER[sideOf(b.payType)] || a.name.localeCompare(b.name))
    .map((h) => ({ id: h.id, name: h.name, payType: h.payType, side: sideOf(h.payType), statutory: h.statutory }))
  const list = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name))
  const total = (k: 'earnings' | 'deductions' | 'employer' | 'net') => list.reduce((s, r) => s + r[k], 0)
  const totals = Object.fromEntries(columns.map((c) => [c.id, list.reduce((s, r) => s + (r.amounts[c.id] ?? 0), 0)]))
  return { from, to, columns, rows: list, totals, earnings: total('earnings'), deductions: total('deductions'), employer: total('employer'), net: total('net') }
}

/** A payslip: the employee, their attendance and their pay for the period. */
export async function payslip(db: Queryable, companyId: number, employeeId: number, from: string, to: string) {
  const m = await payrollMasters(db, companyId)
  const e = m.employees.find((x) => x.id === employeeId)
  if (!e) throw new ValidationError(['Unknown employee'])
  const sheet = await paySheet(db, companyId, from, to)
  const row = sheet.rows.find((r) => r.employeeId === employeeId)
  const att = (await attendanceIn(db, companyId, from, to)).get(employeeId) ?? new Map()
  const lines = sheet.columns.filter((c) => row?.amounts[c.id]).map((c) => ({ ...c, amount: row!.amounts[c.id] }))
  return {
    company: (await getCompany(pool, companyId))!.name,
    employee: e,
    group: m.groups.find((g) => g.id === e.parentId)?.name ?? null,
    from, to,
    attendance: m.attendanceTypes.filter((t) => att.has(t.id)).map((t) => ({ name: t.name, unit: t.unit, value: att.get(t.id)! })),
    earnings: lines.filter((l) => l.side === 'earning'),
    deductions: lines.filter((l) => l.side === 'deduction'),
    employer: lines.filter((l) => l.side === 'employer'),
    totalEarnings: row?.earnings ?? 0,
    totalDeductions: row?.deductions ?? 0,
    net: row?.net ?? 0,
  }
}

/** Attendance Sheet: employees down, attendance and production types across. */
export async function attendanceSheet(db: Queryable, companyId: number, from: string, to: string) {
  const m = await payrollMasters(db, companyId)
  const att = await attendanceIn(db, companyId, from, to)
  const columns = m.attendanceTypes.filter((t) => [...att.values()].some((x) => x.has(t.id)))
  const rows = inPeriod(m, from, to)
    .map((e) => ({ employeeId: e.id, name: e.name, values: Object.fromEntries([...(att.get(e.id) ?? new Map())]) as Record<number, number> }))
    .filter((r) => Object.keys(r.values).length)
  return { from, to, columns, rows }
}

/** Payroll Register: the period's Payroll vouchers with their totals. */
export async function payrollRegister(db: Queryable, companyId: number, from: string, to: string) {
  const m = await payrollMasters(db, companyId)
  const heads = new Map(m.payHeads.map((h) => [h.id, h]))
  const { rows: vouchers } = await db.query<{ id: number; docNo: string; date: string; narration: string; cancelled: boolean }>(
    `SELECT id, COALESCE(doc_no, number::text) "docNo", to_char(date,'YYYY-MM-DD') date, narration, cancelled FROM vouchers
      WHERE company_id = $1 AND type = 'Payroll' AND date BETWEEN $2 AND $3 ORDER BY date, number`,
    [companyId, from, to],
  )
  const booked = await bookedPay(db, companyId, from, to)
  const out = vouchers.map((v) => {
    const t = { earnings: 0, deductions: 0, employer: 0, employees: new Set<number>() }
    for (const r of booked.filter((x) => x.voucherId === v.id)) {
      const h = heads.get(r.head)!
      const side = sideOf(h.payType)
      const x = asPay(h.payType, r.amount)
      if (side === 'earning') t.earnings += x
      else if (side === 'deduction') t.deductions += x
      else t.employer += x
      t.employees.add(r.emp)
    }
    return { ...v, employees: t.employees.size, earnings: t.earnings, deductions: t.deductions, employer: t.employer, net: t.earnings - t.deductions }
  })
  return { from, to, vouchers: out }
}

/** Each employee's amount of each pay head, and the base of a statutory head (the sum of its formula's heads). */
async function statutoryRows(db: Queryable, companyId: number, from: string, to: string) {
  const m = await payrollMasters(db, companyId)
  const sheet = await paySheet(db, companyId, from, to)
  const byStat = (s: Statutory) => m.payHeads.filter((h) => h.statutory === s)
  const amountOf = (row: (typeof sheet.rows)[number] | undefined, s: Statutory) => byStat(s).reduce((t, h) => t + (row?.amounts[h.id] ?? 0), 0)
  const baseOf = (row: (typeof sheet.rows)[number] | undefined, s: Statutory) => {
    const h = byStat(s)[0]
    return h ? h.formula.reduce((t, f) => t + f.sign * (row?.amounts[f.payHeadId] ?? 0), 0) : 0
  }
  const att = await attendanceIn(db, companyId, from, to)
  const types = new Map(m.attendanceTypes.map((t) => [t.id, t]))
  const lwp = (id: number) => [...(att.get(id) ?? new Map())].filter(([t]) => types.get(t)?.kind === 'leave without pay').reduce((s, [, v]) => s + v, 0) / 1000
  const present = (id: number) => [...(att.get(id) ?? new Map())].filter(([t]) => ['attendance', 'leave with pay'].includes(types.get(t)?.kind ?? '')).reduce((s, [, v]) => s + v, 0) / 1000
  return { m, sheet, amountOf, baseOf, lwp, present, byStat }
}

/** PF: each member's wages and contributions, and the EPFO's ECR text (one line a member). */
export async function pfReport(db: Queryable, companyId: number, from: string, to: string) {
  const { m, sheet, amountOf, baseOf, lwp, byStat } = await statutoryRows(db, companyId, from, to)
  const months = monthsIn(from, to)
  const ceiling = (byStat('eps')[0]?.ceiling ?? STATUTORY.eps.ceiling) * months
  const rows = sheet.rows
    .map((r) => {
      const e = m.employees.find((x) => x.id === r.employeeId)!
      const epfWages = baseOf(r, 'pf') || baseOf(r, 'epf-employer')
      return {
        employeeId: e.id, name: e.name, uan: e.uan ?? null, pfNumber: e.pfNumber ?? null, gross: r.earnings, epfWages,
        epsWages: Math.min(epfWages, ceiling), edliWages: Math.min(epfWages, ceiling),
        epf: amountOf(r, 'pf'), eps: amountOf(r, 'eps'), epfEmployer: amountOf(r, 'epf-employer'), edli: amountOf(r, 'edli'), admin: amountOf(r, 'pf-admin'), ncpDays: lwp(e.id),
      }
    })
    .filter((r) => r.epf || r.eps || r.epfEmployer)
  const rupees = (p: number) => String(Math.round(p / 100))
  const ecr = rows.map((r) => [r.uan ?? '', r.name.toUpperCase(), rupees(r.gross), rupees(r.epfWages), rupees(r.epsWages), rupees(r.edliWages), rupees(r.epf), rupees(r.eps),
    rupees(r.epfEmployer), String(Math.round(r.ncpDays)), '0'].join('#~#')).join('\n')
  const problems = rows.filter((r) => !r.uan).map((r) => `${r.name}: no UAN`)
  const sum = (k: 'epf' | 'eps' | 'epfEmployer' | 'edli' | 'admin' | 'epfWages') => rows.reduce((s, r) => s + r[k], 0)
  return { from, to, rows, ecr, problems, totals: { epfWages: sum('epfWages'), epf: sum('epf'), eps: sum('eps'), epfEmployer: sum('epfEmployer'), edli: sum('edli'), admin: sum('admin') } }
}

/** ESI: each insured person's days, wages and contributions (the ESIC monthly contribution upload). */
export async function esiReport(db: Queryable, companyId: number, from: string, to: string) {
  const { m, sheet, amountOf, baseOf, lwp, present } = await statutoryRows(db, companyId, from, to)
  const rows = sheet.rows
    .map((r) => {
      const e = m.employees.find((x) => x.id === r.employeeId)!
      const days = present(e.id) || Math.max(0, daysOnRolls({ joining: e.dateOfJoining, leaving: e.dateOfLeaving ?? null }, from, to) - lwp(e.id))
      return { employeeId: e.id, name: e.name, ipNumber: e.esiNumber ?? null, days, wages: baseOf(r, 'esi') || baseOf(r, 'esi-employer'), employee: amountOf(r, 'esi'), employer: amountOf(r, 'esi-employer') }
    })
    .filter((r) => r.employee || r.employer)
  return {
    from, to, rows,
    problems: rows.filter((r) => !r.ipNumber).map((r) => `${r.name}: no ESI IP number`),
    totals: { wages: rows.reduce((s, r) => s + r.wages, 0), employee: rows.reduce((s, r) => s + r.employee, 0), employer: rows.reduce((s, r) => s + r.employer, 0) },
  }
}

/** Professional tax: month by month, each employee's gross and the tax deducted. */
export async function ptReport(db: Queryable, companyId: number, from: string, to: string) {
  const m = await payrollMasters(db, companyId)
  const heads = new Map(m.payHeads.map((h) => [h.id, h]))
  const pt = m.payHeads.find((h) => h.statutory === 'pt')
  const booked = await bookedPay(db, companyId, from, to)
  const key = (emp: number, month: string) => `${emp}/${month}`
  const rows = new Map<string, { employeeId: number; name: string; month: string; gross: number; pt: number }>()
  for (const r of booked) {
    const h = heads.get(r.head)!
    const e = m.employees.find((x) => x.id === r.emp)
    if (!e) continue
    const month = r.date.slice(0, 7)
    if (!rows.has(key(e.id, month))) rows.set(key(e.id, month), { employeeId: e.id, name: e.name, month, gross: 0, pt: 0 })
    const row = rows.get(key(e.id, month))!
    const v = asPay(h.payType, r.amount)
    if (pt?.formula.some((f) => f.payHeadId === h.id)) row.gross += v * pt.formula.find((f) => f.payHeadId === h.id)!.sign
    else if (!pt && sideOf(h.payType) === 'earning') row.gross += v
    if (h.statutory === 'pt') row.pt += v
  }
  const list = [...rows.values()].filter((r) => r.pt || r.gross).sort((a, b) => a.month.localeCompare(b.month) || a.name.localeCompare(b.name))
  return { from, to, rows: list, total: list.reduce((s, r) => s + r.pt, 0) }
}

/**
 * Income tax on salary for a financial year as of a date: each employee's taxable salary so far,
 * the year's projection (the last month's taxable pay for the months left), the tax on it and
 * what was deducted; and the month-by-month deductions that make Form 24Q's Annexure I.
 */
export async function salaryTaxReport(db: Queryable, companyId: number, fyStart: string, asOf: string) {
  const company = (await getCompany(pool, companyId))!
  const m = await payrollMasters(db, companyId)
  const heads = new Map(m.payHeads.map((h) => [h.id, h]))
  const booked = await bookedPay(db, companyId, fyStart, asOf)
  const fyEndMonth = monthsLeftInYear(asOf, Number(company.fyStart.slice(5, 7))) - 1 // months after asOf's month
  const rows = m.employees
    .map((e) => {
      const mine = booked.filter((r) => r.emp === e.id)
      const months = new Map<string, { date: string; taxable: number; tax: number }>()
      for (const r of mine) {
        const h = heads.get(r.head)!
        const month = r.date.slice(0, 7)
        if (!months.has(month)) months.set(month, { date: r.date, taxable: 0, tax: 0 })
        const x = months.get(month)!
        if (r.date > x.date) x.date = r.date
        if (isTaxable(h.payType)) x.taxable += r.amount
        if (h.statutory === 'income-tax') x.tax += -r.amount
      }
      const list = [...months].sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => ({ month, ...v }))
      const taxable = list.reduce((s, x) => s + x.taxable, 0)
      const deducted = list.reduce((s, x) => s + x.tax, 0)
      const last = list.at(-1)?.taxable ?? 0
      const regime = e.taxRegime ?? 'new'
      const t = salaryTax({ regime, ytdTaxable: taxable, ytdTax: deducted, monthsLeft: 1 }, last * fyEndMonth)
      return { employeeId: e.id, name: e.name, pan: e.pan ?? null, regime, months: list, taxable, projected: t.projected, standardDeduction: t.projected - t.taxable,
        taxableIncome: t.taxable, tax: t.annual, deducted, balance: t.annual - deducted }
    })
    .filter((r) => r.months.length)
  return { fyStart, asOf, rows, problems: rows.filter((r) => !r.pan && r.deducted).map((r) => `${r.name}: no PAN (tax is due at 20% or the slab rate, if higher)`) }
}

/** Gratuity as of a date: service, the last month's wages on the gratuity pay head's formula, and the gratuity. */
export async function gratuityReport(db: Queryable, companyId: number, asOf: string) {
  const m = await payrollMasters(db, companyId)
  const head = m.payHeads.find((h) => h.payType === 'Gratuity')
  const booked = await bookedPay(db, companyId, '0001-01-01', asOf)
  const heads = new Map(m.payHeads.map((h) => [h.id, h]))
  const rows = m.employees
    .filter((e) => e.dateOfJoining <= asOf && (!e.dateOfLeaving || e.dateOfLeaving >= addDay(asOf, -366)))
    .map((e) => {
      const mine = booked.filter((r) => r.emp === e.id)
      const lastMonth = mine.reduce((s, r) => (r.date.slice(0, 7) > s ? r.date.slice(0, 7) : s), '')
      const wages = mine
        .filter((r) => r.date.startsWith(lastMonth))
        .reduce((s, r) => {
          const t = head?.formula.find((f) => f.payHeadId === r.head)
          return s + (t ? t.sign * asPay(heads.get(r.head)!.payType, r.amount) : 0)
        }, 0)
      const g = gratuity(e.dateOfJoining, e.dateOfLeaving && e.dateOfLeaving < asOf ? e.dateOfLeaving : asOf, wages)
      return { employeeId: e.id, name: e.name, joining: e.dateOfJoining, leaving: e.dateOfLeaving ?? null, wages, ...g, payable: g.eligible ? g.amount : 0 }
    })
  return { asOf, payHead: head?.name ?? null, rows, total: rows.reduce((s, r) => s + r.payable, 0), provision: rows.reduce((s, r) => s + r.amount, 0) }
}

/** NPS: each subscriber's PRAN and the employee's and employer's contributions. */
export async function npsReport(db: Queryable, companyId: number, from: string, to: string) {
  const { m, sheet, amountOf } = await statutoryRows(db, companyId, from, to)
  const rows = sheet.rows
    .map((r) => {
      const e = m.employees.find((x) => x.id === r.employeeId)!
      return { employeeId: e.id, name: e.name, pran: e.pran ?? null, employee: amountOf(r, 'nps'), employer: amountOf(r, 'nps-employer') }
    })
    .filter((r) => r.employee || r.employer)
  return { from, to, rows, problems: rows.filter((r) => !r.pran).map((r) => `${r.name}: no PRAN`) }
}
