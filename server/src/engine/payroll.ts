/**
 * Payroll as Tally computes it. A pay head is a ledger with a way of working out its amount for an
 * employee in a period: a value typed in the voucher, a flat rate, a rate for the days attended,
 * a rate per unit produced, or a value computed from other pay heads through slabs. The statutory
 * ones (PF, ESI, professional tax, income tax on salary, NPS) are computed the same way, with the
 * few rules of their own the law adds (the EPS wage ceiling, the ESI wage limit, the tax on a
 * year's projected salary). Amounts are paise; rates hundredths of a percent; days and units
 * thousandths.
 */
import type { Paise } from './money'

export const PAY_TYPES = [
  'Earnings for Employees',
  'Deductions from Employees',
  "Employees' Statutory Deductions",
  "Employer's Statutory Contributions",
  "Employer's Other Charges",
  'Bonus',
  'Gratuity',
  'Loans and Advances',
  'Reimbursements to Employees',
] as const
export type PayType = (typeof PAY_TYPES)[number]

/** What a pay head does to the employee's pay: adds to it, takes from it, or costs the employer only. */
export function sideOf(t: PayType): 'earning' | 'deduction' | 'employer' {
  if (t === 'Earnings for Employees' || t === 'Bonus' || t === 'Gratuity' || t === 'Reimbursements to Employees') return 'earning'
  if (t === "Employer's Statutory Contributions" || t === "Employer's Other Charges") return 'employer'
  return 'deduction'
}
/** Earnings taxed as salary (reimbursements are not). */
export const isTaxable = (t: PayType) => t === 'Earnings for Employees' || t === 'Bonus'

export const STATUTORY = {
  pf: { label: 'PF: employee (EPF)', side: 'deduction', rate: 1200, ceiling: null },
  eps: { label: 'PF: employer pension (EPS)', side: 'employer', rate: 833, ceiling: 1500000 },
  'epf-employer': { label: 'PF: employer (EPF, after EPS)', side: 'employer', rate: 1200, ceiling: null },
  edli: { label: 'PF: EDLI', side: 'employer', rate: 50, ceiling: 1500000 },
  'pf-admin': { label: 'PF: admin charges', side: 'employer', rate: 50, ceiling: null },
  esi: { label: 'ESI: employee', side: 'deduction', rate: 75, ceiling: 2100000 },
  'esi-employer': { label: 'ESI: employer', side: 'employer', rate: 325, ceiling: 2100000 },
  pt: { label: 'Professional tax', side: 'deduction', rate: 0, ceiling: null },
  'income-tax': { label: 'Income tax on salary', side: 'deduction', rate: 0, ceiling: null },
  nps: { label: 'NPS: employee', side: 'deduction', rate: 1000, ceiling: null },
  'nps-employer': { label: 'NPS: employer', side: 'employer', rate: 1000, ceiling: null },
} as const
export type Statutory = keyof typeof STATUTORY

export type Calculation = 'user' | 'flat' | 'attendance' | 'production' | 'computed'
export type Rounding = 'normal' | 'up' | 'down' | 'none'
export interface Slab {
  upTo: Paise | null // the slab applies while the base is at most this; null = no limit
  rate: number // hundredths of a percent of the base
  value: Paise // plus a fixed amount
}
export interface FormulaTerm {
  payHeadId: number
  sign: 1 | -1
}

export interface PayHead {
  id: number
  name: string
  payType: PayType
  statutory: Statutory | null
  calculation: Calculation
  attendanceTypeId: number | null
  perDayDays: number | null // null: the calendar days of the period
  formula: FormulaTerm[]
  ceiling: Paise | null
  slabs: Slab[]
  rounding: Rounding
  roundTo: Paise
  taxComponent?: 'basic' | 'hra' | null // Basic (with DA) and HRA: the HRA exemption under the old regime
}

export type AttendanceKind = 'attendance' | 'leave with pay' | 'leave without pay' | 'production'
export interface AttendanceType {
  id: number
  name: string
  kind: AttendanceKind
}

export interface SalaryLine {
  payHeadId: number
  rate: Paise | null // a monthly rate, a rate per unit, or a default value; none for a computed head
}

export interface EmployeeRun {
  id: number
  joining: string
  leaving: string | null
  regime: 'new' | 'old'
  salary: SalaryLine[]
  attendance: Map<number, number> // attendance type -> thousandths
  values?: Map<number, Paise> // amounts typed for user-defined pay heads
  ytdTaxable: Paise // the year's taxable salary before this period
  ytdTax: Paise // income tax deducted from it
  monthsLeft: number // months of the financial year from this period's, inclusive
  declarations?: Declarations | null // the old regime's exemptions and deductions for the year
  ytdBasic?: Paise // Basic and HRA paid in the year before this period
  ytdHra?: Paise
}

/** What an employee declares for a year under the old regime (paise). */
export interface Declarations {
  rentPaid: Paise
  metro: boolean
  sec80c: Paise
  sec80d: Paise
  sec80ccd1b: Paise
  sec24b: Paise
  other: Paise
}

/**
 * The old regime's exemptions and deductions for a year: the HRA exemption (the least of the HRA
 * received, the rent less 10% of Basic, and 50% of Basic in a metro city or 40% elsewhere) and
 * Chapter VI-A within its limits: 80C ₹1.5 lakh, 80D ₹1 lakh (self, family and senior parents),
 * 80CCD(1B) ₹50,000, home-loan interest under 24(b) ₹2 lakh.
 */
export function oldRegimeDeductions(d: Declarations, basic: Paise, hra: Paise) {
  const hraExempt = Math.max(0, Math.min(hra, d.rentPaid - Math.round(basic / 10), Math.round((basic * (d.metro ? 50 : 40)) / 100)))
  const chapterVIA = Math.min(d.sec80c, 15000000) + Math.min(d.sec80d, 10000000) + Math.min(d.sec80ccd1b, 5000000) + d.other
  const homeLoan = Math.min(d.sec24b, 20000000)
  return { hraExempt, chapterVIA, homeLoan, total: hraExempt + chapterVIA + homeLoan }
}

export interface PayLine {
  payHeadId: number
  amount: Paise // positive; the pay head's type says which side
}

const ISO = (d: Date) => d.toISOString().slice(0, 10)
const day = (s: string) => new Date(s + 'T00:00:00Z')
export const daysBetween = (from: string, to: string) => Math.round((day(to).getTime() - day(from).getTime()) / 86400000) + 1

export function round(x: number, how: Rounding, to: Paise): Paise {
  if (how === 'none') return Math.round(x)
  const q = x / to
  const r = how === 'up' ? Math.ceil(q - 1e-9) : how === 'down' ? Math.floor(q + 1e-9) : Math.round(q)
  return r * to
}

/** The slab a base falls in, and what it comes to. */
export function slabAmount(base: Paise, slabs: Slab[]): number {
  const s = slabs.find((x) => x.upTo === null || base <= x.upTo)
  return s ? s.value + (base * s.rate) / 10000 : 0
}

/** Days an employee is on the rolls in a period (joining and leaving inside it shorten it). */
export function daysOnRolls(e: Pick<EmployeeRun, 'joining' | 'leaving'>, from: string, to: string) {
  const a = e.joining > from ? e.joining : from
  const b = e.leaving && e.leaving < to ? e.leaving : to
  return a > b ? 0 : daysBetween(a, b)
}

// ------------------------------------------------------------------ income tax on salary (FY 2025-26)

const NEW_SLABS: [number, number][] = [[400000, 0], [800000, 5], [1200000, 10], [1600000, 15], [2000000, 20], [2400000, 25], [Infinity, 30]]
const OLD_SLABS: [number, number][] = [[250000, 0], [500000, 5], [1000000, 20], [Infinity, 30]]
export const STANDARD_DEDUCTION = { new: 7500000, old: 5000000 } // paise

/** Tax on a year's taxable income (rupees), with the 87A rebate (and its marginal relief), surcharge and 4% cess; rupees. */
export function incomeTax(income: number, regime: 'new' | 'old'): number {
  const slabs = regime === 'new' ? NEW_SLABS : OLD_SLABS
  let tax = 0
  let below = 0
  for (const [upTo, pct] of slabs) {
    if (income > below) tax += ((Math.min(income, upTo) - below) * pct) / 100
    below = upTo
  }
  const rebateLimit = regime === 'new' ? 1200000 : 500000
  if (income <= rebateLimit) tax = 0
  else if (regime === 'new') tax = Math.min(tax, income - rebateLimit) // marginal relief just above the limit
  const surcharge = income > 50000000 ? (regime === 'new' ? 25 : 37) : income > 20000000 ? 25 : income > 10000000 ? 15 : income > 5000000 ? 10 : 0
  tax += (tax * surcharge) / 100
  return Math.round(tax * 1.04)
}

/** The year's projected tax on salary and this month's share of what is still to deduct. */
export function salaryTax(e: Pick<EmployeeRun, 'regime' | 'ytdTaxable' | 'ytdTax' | 'monthsLeft'>, monthTaxable: Paise, deductions: Paise = 0) {
  const projected = e.ytdTaxable + monthTaxable * e.monthsLeft
  // the old regime's exemptions and Chapter VI-A deductions; the new regime has none of them
  const taxable = Math.max(0, projected - STANDARD_DEDUCTION[e.regime] - (e.regime === 'old' ? deductions : 0))
  const annual = incomeTax(Math.floor(taxable / 100), e.regime) * 100
  const month = Math.max(0, Math.round((annual - e.ytdTax) / Math.max(1, e.monthsLeft) / 100) * 100)
  return { projected, taxable, annual, month }
}

// ------------------------------------------------------------------ the run

/**
 * An employee's pay for a period: every pay head of the salary structure worked out in turn, a
 * computed head first computing the heads its formula names. Errors name what is missing.
 */
export function computePay(heads: Map<number, PayHead>, types: Map<number, AttendanceType>, e: EmployeeRun, from: string, to: string) {
  const errors: string[] = []
  const done = new Map<number, Paise>()
  const busy = new Set<number>()
  const rateOf = new Map(e.salary.map((l) => [l.payHeadId, l.rate]))
  const calendar = daysBetween(from, to)
  const onRolls = daysOnRolls(e, from, to)
  const kindTotal = (k: AttendanceKind[]) => [...e.attendance].filter(([t]) => k.includes(types.get(t)?.kind as AttendanceKind)).reduce((s, [, v]) => s + v, 0)
  const recorded = kindTotal(['attendance', 'leave with pay'])
  // days paid for: what was recorded as attended (or leave with pay), else the days on the rolls less leave without pay
  const payable = recorded > 0 ? recorded / 1000 : Math.max(0, onRolls - kindTotal(['leave without pay']) / 1000)

  const amountOf = (id: number): Paise => {
    if (done.has(id)) return done.get(id)!
    const h = heads.get(id)
    if (!h) {
      errors.push(`Unknown pay head ${id}`)
      return 0
    }
    if (busy.has(id)) {
      errors.push(`${h.name} is computed on itself`)
      return 0
    }
    busy.add(id)
    const v = Math.max(0, round(raw(h), h.rounding, h.roundTo))
    busy.delete(id)
    done.set(id, v)
    return v
  }
  // a formula's heads count only where the employee's salary has them
  const base = (h: PayHead) => h.formula.reduce((s, t) => s + (rateOf.has(t.payHeadId) ? t.sign * amountOf(t.payHeadId) : 0), 0)
  const taxableThisRun = () =>
    e.salary.filter((l) => { const x = heads.get(l.payHeadId); return x && isTaxable(x.payType) }).reduce((s, l) => s + amountOf(l.payHeadId), 0)

  function raw(h: PayHead): number {
    const rate = rateOf.get(h.id) ?? null
    if (onRolls === 0) return 0
    switch (h.statutory) {
      case 'income-tax': {
        if (e.regime !== 'old' || !e.declarations) return salaryTax(e, taxableThisRun()).month
        // the year's Basic and HRA, as paid so far and projected at this month's rate
        const part = (c: 'basic' | 'hra') => e.salary.filter((l) => heads.get(l.payHeadId)?.taxComponent === c).reduce((s, l) => s + amountOf(l.payHeadId), 0)
        const basic = (e.ytdBasic ?? 0) + part('basic') * e.monthsLeft
        const hra = (e.ytdHra ?? 0) + part('hra') * e.monthsLeft
        return salaryTax(e, taxableThisRun(), oldRegimeDeductions(e.declarations, basic, hra).total).month
      }
      case 'esi':
      case 'esi-employer': {
        // ESI covers those whose wages are within the limit
        const b = base(h)
        return h.ceiling !== null && b > h.ceiling ? 0 : slabAmount(b, h.slabs)
      }
      case 'epf-employer': {
        const eps = [...heads.values()].find((x) => x.statutory === 'eps' && rateOf.has(x.id))
        const b = h.ceiling !== null ? Math.min(base(h), h.ceiling) : base(h)
        return slabAmount(b, h.slabs) - (eps ? amountOf(eps.id) : 0)
      }
    }
    switch (h.calculation) {
      case 'user':
        return e.values?.get(h.id) ?? rate ?? 0
      case 'flat':
        if (rate === null) errors.push(`${h.name}: no rate in the salary details`)
        return rate ?? 0
      case 'attendance': {
        if (rate === null) errors.push(`${h.name}: no rate in the salary details`)
        const t = types.get(h.attendanceTypeId!)
        const days = t?.kind === 'leave without pay' ? Math.max(0, onRolls - (e.attendance.get(t.id) ?? 0) / 1000) : t ? payable : 0
        return ((rate ?? 0) * days) / (h.perDayDays ?? calendar)
      }
      case 'production':
        if (rate === null) errors.push(`${h.name}: no rate in the salary details`)
        return ((rate ?? 0) * (e.attendance.get(h.attendanceTypeId!) ?? 0)) / 1000
      case 'computed': {
        const b = h.ceiling !== null ? Math.min(base(h), h.ceiling) : base(h)
        return slabAmount(b, h.slabs)
      }
    }
  }

  const lines: PayLine[] = []
  for (const l of e.salary) {
    const amount = amountOf(l.payHeadId)
    if (amount) lines.push({ payHeadId: l.payHeadId, amount })
  }
  let earnings = 0
  let deductions = 0
  let employer = 0
  for (const l of lines) {
    const s = sideOf(heads.get(l.payHeadId)!.payType)
    if (s === 'earning') earnings += l.amount
    else if (s === 'deduction') deductions += l.amount
    else employer += l.amount
  }
  return { lines, earnings, deductions, employer, net: earnings - deductions, payableDays: payable, onRolls, errors: [...new Set(errors)] }
}

/** The months of the financial year left from a period's month, inclusive (April starts the year). */
export function monthsLeftInYear(from: string, fyStartMonth = 4) {
  const m = Number(from.slice(5, 7))
  return ((fyStartMonth + 11 - m) % 12) + 1
}

/** A period's months, for per-month ceilings (two months take twice the PF ceiling). */
export function monthsIn(from: string, to: string) {
  const a = day(from)
  const b = day(to)
  return Math.max(1, (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() + 1)
}

/**
 * Gratuity (Payment of Gratuity Act): 15 days' wages for each completed year of service, a
 * part year over six months counting as a year, at 26 working days a month; due after five
 * years; at most ₹20 lakh.
 */
export function gratuity(joining: string, asOf: string, monthlyWages: Paise) {
  const a = day(joining)
  const b = day(asOf)
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth()
  if (b.getUTCDate() < a.getUTCDate()) months--
  const years = Math.floor(months / 12) + (months % 12 > 6 ? 1 : 0)
  const amount = Math.min(200000000, Math.round((monthlyWages * 15 * years) / 26 / 100) * 100)
  return { years, eligible: months >= 60, amount }
}

export const addDays = (s: string, n: number) => {
  const d = day(s)
  d.setUTCDate(d.getUTCDate() + n)
  return ISO(d)
}
