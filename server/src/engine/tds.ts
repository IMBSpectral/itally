/**
 * TDS (tax deducted at source) on payments, and TCS (tax collected at source) on sales of the goods
 * section 206C names: the rate for a party, and what is due on each voucher once the year's amounts
 * with the party cross a threshold. Amounts in paise, rates in hundredths of a percent; tax is
 * rounded to the rupee (section 288B).
 */

export const DEDUCTEE_TYPES = ['Individual/HUF', 'Company', 'Firm', 'AOP/BOI', 'Others'] as const
export type DeducteeType = (typeof DEDUCTEE_TYPES)[number]

export type TaxKind = 'TDS' | 'TCS'

export interface TdsNature {
  id: number
  name: string
  kind: TaxKind // a nature of payment (TDS) or of goods (TCS)
  section: string
  collectionCode: string | null // TCS: Form 27EQ's code for the goods
  rateIndividual: number
  rateOther: number
  rateNoPan: number
  thresholdSingle: number | null // one payment above it is taxed
  thresholdAnnual: number | null // the year's payments together above it are taxed
  excessOnly: boolean // 194Q: only the part above the annual limit is taxed
}

const L = (rupees: number) => rupees * 100
/**
 * The common natures of payment with their rates and thresholds for 2025-26 (Finance Act 2025).
 * A company's copies can be altered when the law changes. Rent's monthly ₹50,000 limit is checked
 * per payment.
 */
const tds = (name: string, section: string, rateIndividual: number, rateOther: number, rateNoPan: number, thresholdSingle: number | null, thresholdAnnual: number | null,
  excessOnly = false): Omit<TdsNature, 'id'> => ({ name, kind: 'TDS', section, collectionCode: null, rateIndividual, rateOther, rateNoPan, thresholdSingle, thresholdAnnual, excessOnly })
// section 206CC: without a PAN, twice the rate or 5%, whichever is higher
const tcs = (name: string, collectionCode: string, rate: number, thresholdSingle: number | null = null, section = '206C(1)'): Omit<TdsNature, 'id'> =>
  ({ name, kind: 'TCS', section, collectionCode, rateIndividual: rate, rateOther: rate, rateNoPan: Math.max(2 * rate, 500), thresholdSingle, thresholdAnnual: null, excessOnly: false })
export const STANDARD_NATURES: Omit<TdsNature, 'id'>[] = [
  tds('Payment to Contractors', '194C', 100, 200, 2000, L(30000), L(100000)),
  tds('Fees for Professional Services', '194J', 1000, 1000, 2000, null, L(50000)),
  tds('Fees for Technical Services', '194J', 200, 200, 2000, null, L(50000)),
  tds('Rent - Land and Building', '194I', 1000, 1000, 2000, L(50000), null),
  tds('Rent - Plant and Machinery', '194I', 200, 200, 2000, L(50000), null),
  tds('Commission or Brokerage', '194H', 200, 200, 2000, null, L(20000)),
  tds('Interest other than on Securities', '194A', 1000, 1000, 2000, null, L(10000)),
  tds('Purchase of Goods', '194Q', 10, 10, 500, null, L(5000000), true),
  // to non-residents (Form 27Q): the rate of the Act; a treaty rate goes on a copy of the nature
  tds('Other Sums Payable to Non-Residents', '195', 2000, 2000, 2000, null, null),
  // the goods of section 206C (Finance Act 2025)
  tcs('Alcoholic Liquor for Human Consumption', 'A', 100),
  tcs('Timber obtained under a Forest Lease', 'B', 200),
  tcs('Timber obtained by any other Mode', 'C', 200),
  tcs('Any other Forest Produce', 'D', 200),
  tcs('Scrap', 'E', 100),
  tcs('Tendu Leaves', 'I', 200),
  tcs('Minerals (Coal, Lignite, Iron Ore)', 'J', 100),
  tcs('Motor Vehicle above Rs 10 lakh', 'L', 100, L(1000000), '206C(1F)'),
]

/** The rate for a deductee: without a PAN the higher rate of section 206AA. */
export function rateFor(n: TdsNature, deductee: DeducteeType, hasPan: boolean) {
  const rate = deductee === 'Individual/HUF' ? n.rateIndividual : n.rateOther
  return hasPan ? rate : Math.max(rate, n.rateNoPan)
}

/** Tax on an amount at a rate, to the rupee. */
export const taxAt = (amount: number, rate: number) => Math.round((amount * rate) / 1_000_000) * 100

export interface TdsLine {
  voucherId: number
  date: string
  partyId: number
  natureId: number
  amount: number // credited to the party under this nature (a debit note's is negative)
  deducted: number // booked on the nature's TDS ledgers in this voucher
}
export interface TdsDue extends TdsLine {
  assessable: number // what the tax is due on: this amount, plus the year's earlier ones when the annual limit is first crossed
  rate: number
  due: number
  short: number // due less deducted (negative: deducted more)
  special?: 'certificate' | 'dtaa' // taxed (in part) at the party's own rate
  certificateNo?: string | null
}

/** A party's own rate: a section 197 certificate (for a period, up to an amount) or a treaty (DTAA) rate. */
export interface PartyRate {
  kind: 'certificate' | 'dtaa'
  rate: number
  certificateNo: string | null
  validFrom: string
  validTo: string
  limit: number | null // the amount the certificate covers; none for a treaty rate
}

/**
 * What is due on each line of one party under one nature, in date order within a financial year.
 * Below both limits nothing is due. A payment above the single limit is taxed on itself. Once the
 * year's total passes the annual limit, everything not yet taxed that year is taxed, the earlier
 * amounts included. Under 194Q only the part of the year's total above the limit is taxed.
 */
export function dueThroughYear(n: TdsNature, deductee: DeducteeType, hasPan: boolean, lines: TdsLine[], own: PartyRate[] = []): TdsDue[] {
  const rate = rateFor(n, deductee, hasPan)
  let total = 0 // paid or credited so far this year
  let covered = 0 // of which already taxed
  const used = new Map<PartyRate, number>() // what each certificate has covered so far
  return lines.map((l) => {
    let assessable = 0
    if (n.excessOnly && n.thresholdAnnual !== null) {
      assessable = Math.max(0, total + l.amount - n.thresholdAnnual) - Math.max(0, total - n.thresholdAnnual)
    } else if (n.thresholdAnnual !== null && total + l.amount > n.thresholdAnnual) {
      assessable = total + l.amount - covered
    } else if (n.thresholdSingle !== null && l.amount > n.thresholdSingle) {
      assessable = l.amount
    } else if (n.thresholdAnnual === null && n.thresholdSingle === null) {
      assessable = l.amount
    }
    total += l.amount
    covered += assessable
    // the party's own rate on what its certificate still covers (a treaty rate on all of it), the normal rate on the rest
    const p = own.find((x) => l.date >= x.validFrom && l.date <= x.validTo)
    if (p && assessable > 0) {
      const low = p.limit === null ? assessable : Math.max(0, Math.min(assessable, p.limit - (used.get(p) ?? 0)))
      used.set(p, (used.get(p) ?? 0) + low)
      if (low > 0) {
        const due = taxAt(low, p.rate) + taxAt(assessable - low, rate)
        return { ...l, assessable, rate: p.rate, due, short: due - l.deducted, special: p.kind, certificateNo: p.certificateNo }
      }
    }
    const due = taxAt(assessable, rate)
    return { ...l, assessable, rate, due, short: due - l.deducted }
  })
}

/** Problems with a nature of payment's definition. */
export function natureProblems(n: Omit<TdsNature, 'id'>) {
  const errors: string[] = []
  if (!n.name.trim()) errors.push(n.kind === 'TCS' ? 'A nature of goods needs a name' : 'A nature of payment needs a name')
  if (n.kind === 'TCS') {
    if (!/^206C(\([0-9A-Z]{1,3}\))?$/i.test(n.section.trim())) errors.push(`"${n.section}" is not a TCS section (like 206C(1))`)
    if (n.collectionCode && !/^[A-Z]{1,2}$/.test(n.collectionCode)) errors.push(`"${n.collectionCode}" is not a collection code (a letter, as A for liquor)`)
  } else if (!/^19[0-9A-Z()]{1,8}$/i.test(n.section.trim())) errors.push(`"${n.section}" is not a TDS section (like 194C)`)
  for (const r of [n.rateIndividual, n.rateOther, n.rateNoPan]) if (!Number.isInteger(r) || r < 0 || r > 10000) errors.push('A rate is between 0% and 100%')
  for (const t of [n.thresholdSingle, n.thresholdAnnual]) if (t !== null && (!Number.isSafeInteger(t) || t < 0)) errors.push('A threshold is an amount of 0 or more')
  if (n.excessOnly && n.thresholdAnnual === null) errors.push('Taxing only the excess needs an annual limit')
  return [...new Set(errors)]
}

/** A TAN: four letters, five digits, a letter. */
export const tanError = (tan: string) => (/^[A-Z]{4}[0-9]{5}[A-Z]$/.test(tan) ? null : `"${tan}" is not a TAN (four letters, five digits, a letter)`)

/** A party outside India (its country set to another) is a non-resident: its TDS goes on Form 27Q. */
export const isNonResident = (country: string | null | undefined) => !!country?.trim() && !/^india$/i.test(country.trim())

/** Form 26Q's deductee code (and 27Q's, 27EQ's collectee code): 01 for a company, 02 for everyone else. */
export const deducteeCode = (t: DeducteeType) => (t === 'Company' ? '01' : '02')

/** The quarter (1-4) of a financial year starting in April, and its months. */
export function quarterOf(date: string) {
  const m = Number(date.slice(5, 7))
  return m >= 4 && m <= 6 ? 1 : m <= 9 && m >= 7 ? 2 : m >= 10 ? 3 : 4
}

/**
 * A nature's place under the Income-tax Act, 2025 (tax year 2026-27 on): the section and table
 * serial that replace the 1961 Act's section, and the payment code Forms 140, 144 and 143 carry.
 * Taken from the Notes to those forms as published; check them against the RPU's own code list.
 * Contracts split by the deductee (individual or HUF, or others); section 194J by its kind of fee.
 */
export function act2025(n: { section: string; name?: string; collectionCode?: string | null }, deducteeCode = '02'): { section: string; code: string } | null {
  const name = (n.name ?? '').toLowerCase()
  if (n.collectionCode) {
    const tcs: Record<string, [string, string]> = {
      A: ['394(1) Sl. 1', '1068'], I: ['394(1) Sl. 2', '1069'], B: ['394(1) Sl. 3', '1070'], C: ['394(1) Sl. 3', '1071'], D: ['394(1) Sl. 3', '1072'],
      E: ['394(1) Sl. 4', '1073'], J: ['394(1) Sl. 5', '1074'], L: ['394(1) Sl. 6.D(a)', '1075'],
    }
    const t = tcs[n.collectionCode.toUpperCase()]
    return t ? { section: t[0], code: t[1] } : null
  }
  const individual = deducteeCode === '02'
  switch (n.section.toUpperCase()) {
    case '194C': return individual ? { section: '393(1) Sl. 6(i).D(a)', code: '1023' } : { section: '393(1) Sl. 6(i).D(b)', code: '1024' }
    case '194J': return /technical|royalty|call cent/.test(name) ? { section: '393(1) Sl. 6(iii).D(a)', code: '1026' } : { section: '393(1) Sl. 6(iii).D(b)', code: '1027' }
    case '194I': return /plant|machinery/.test(name) ? { section: '393(1) Sl. 2(ii).D(a)', code: '1008' } : { section: '393(1) Sl. 2(ii).D(b)', code: '1009' }
    case '194H': return { section: '393(1) Sl. 1(ii)', code: '1006' }
    case '194D': return { section: '393(1) Sl. 1(i)', code: '1005' }
    case '194A': return { section: '393(1) Sl. 5(iii)', code: '1022' }
    case '193': return { section: '393(1) Sl. 5(i)', code: '1019' }
    case '194Q': return { section: '393(1) Sl. 8(ii)', code: '1031' }
    case '194O': return { section: '393(1) Sl. 8(v)', code: '1035' }
    case '194R': return { section: '393(1) Sl. 8(iv)', code: '1033' }
    case '194T': return { section: '393(3) Sl. 7', code: '1067' }
    case '195': return { section: '393(2) Sl. 17', code: '1057' }
    default: return null
  }
}

/** The deductee (or collectee) sheet of a return, as the government's Return Preparation Utility lays it out. */
export interface ReturnSheetInput {
  form: '26Q' | '27Q' | '27EQ'
  deductions: { deducteeCode: string; pan: string; name: string; section: string; collectionCode: string | null; country: string | null; date: string; amount: number
    tds: number; rate: number; challan: { serial: number; bsrCode: string | null; challanNo: string | null; challanDate: string } | null
    reason?: string | null; certificateNo?: string | null; special?: 'certificate' | 'dtaa' | null; nature?: string }[]
  fyStart?: string // from 2026-04-01 the sheet adds the Income-tax Act 2025's section and payment code
}
export function returnSheet(r: ReturnSheetInput) {
  const dmy = (d: string | null | undefined) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '')
  const tcs = r.form === '27EQ'
  const newAct = !!r.fyStart && r.fyStart >= '2026-04-01'
  const head = [
    tcs ? 'Collectee code' : 'Deductee code', tcs ? 'PAN of collectee' : 'PAN of deductee', tcs ? 'Name of collectee' : 'Name of deductee',
    ...(tcs ? ['Collection code'] : ['Section']), ...(r.form === '27Q' ? ['Country of residence'] : []),
    tcs ? 'Date of receipt/debit' : 'Date of payment/credit', tcs ? 'Amount received/debited' : 'Amount paid/credited', tcs ? 'TCS' : 'TDS', 'Rate (%)',
    tcs ? 'Date of collection' : 'Date of deduction', 'Challan serial', 'BSR code', 'Challan number', 'Date of deposit',
    'Reason for lower/higher deduction', 'Certificate number', ...(r.form === '27Q' ? ['Rate as per (IT Act / DTAA)'] : []),
    ...(newAct ? ['Section (Income-tax Act 2025)', 'Payment code'] : []),
  ]
  const rows = r.deductions.map((d) => [
    d.deducteeCode, d.pan, d.name, tcs ? (d.collectionCode ?? '') : d.section, ...(r.form === '27Q' ? [d.country ?? ''] : []),
    dmy(d.date), (d.amount / 100).toFixed(2), (d.tds / 100).toFixed(2), (d.rate / 100).toFixed(2),
    dmy(d.date), d.challan?.serial ?? '', d.challan?.bsrCode ?? '', d.challan?.challanNo ?? '', dmy(d.challan?.challanDate),
    d.reason ?? '', d.certificateNo ?? '', ...(r.form === '27Q' ? [d.special === 'dtaa' ? 'DTAA' : 'IT Act'] : []),
    ...(newAct ? (() => { const a = act2025({ section: d.section, name: d.nature, collectionCode: tcs ? d.collectionCode : null }, d.deducteeCode); return [a?.section ?? '', a?.code ?? ''] })() : []),
  ])
  return { head, rows }
}
