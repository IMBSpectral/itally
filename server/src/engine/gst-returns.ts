/**
 * GST returns from the breakups stored with each invoice: GSTR-1 (outward supplies, by the
 * sections of the return), GSTR-3B (the monthly summary with input tax credit set off in the
 * order Rule 88A requires) and the GSTR-1 file for the GST portal's offline upload.
 */
import type { VoucherType } from './voucher'
import { stateName, type GstBreakup, type GstLine } from './gst'

export interface GstVoucher {
  id: number
  docNo?: string // the number on the document, when it differs from the internal one (a voucher type's series)
  type: VoucherType
  number: number
  date: string
  gst: GstBreakup
}
export interface TaxSum {
  taxable: number
  igst: number
  cgst: number
  sgst: number
  cess?: number // compensation cess
}
const zero = (): TaxSum => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 })
function add(t: TaxSum, x: TaxSum, sign = 1) {
  t.taxable += sign * x.taxable
  t.igst += sign * x.igst
  t.cgst += sign * x.cgst
  t.sgst += sign * x.sgst
  t.cess = (t.cess ?? 0) + sign * (x.cess ?? 0)
  return t
}

/** Unregistered inter-state invoices above this value go to B2C (Large), invoice by invoice. */
export const B2CL_LIMIT = 100000_00

/** An invoice reported line by line: its values per rate. */
export interface InvoiceRow extends TaxSum {
  voucherId: number
  type: VoucherType
  number: number
  docNo: string // the number on the document
  date: string
  party: string | null
  gstin: string | null
  pos: string
  value: number
  rates: ({ rate: number } & TaxSum)[]
}
/** A line reported in GSTR-1 table 8 (nil-rated, exempt, non-GST) rather than with the invoice's rates. */
export const untaxed = (l: GstLine) => !!l.noTax || l.rate === 0

function invoiceRow(v: GstVoucher): InvoiceRow {
  const byRate = new Map<number, { rate: number } & TaxSum>()
  for (const l of v.gst.lines.filter((l) => v.gst.export || !untaxed(l))) add(byRate.get(l.rate) ?? byRate.set(l.rate, { rate: l.rate, ...zero() }).get(l.rate)!, l)
  const rates = [...byRate.values()].sort((a, b) => a.rate - b.rate)
  return {
    voucherId: v.id, type: v.type, number: v.number, docNo: v.docNo ?? String(v.number), date: v.date, party: v.gst.party, gstin: v.gst.gstin, pos: v.gst.pos,
    value: v.gst.invoiceValue, rates, ...rates.reduce((t, r) => add(t, r), zero()),
  }
}

export interface NilRow {
  supplyType: 'INTRB2B' | 'INTRAB2B' | 'INTRB2C' | 'INTRAB2C'
  nil: number
  exempt: number
  nonGst: number
}
export interface HsnRow extends TaxSum {
  hsn: string
  rate: number
  uqc: string
  qty: number
}
/** An export (6A): with IGST paid, or without under a letter of undertaking. */
export interface ExportRow extends InvoiceRow {
  expType: 'WPAY' | 'WOPAY'
  shippingBill?: { port: string; no: string; date: string }
}
/** A credit note to an unregistered party (9B) against an export or a B2C (Large) invoice. */
export interface UnregNoteRow extends InvoiceRow {
  noteType: 'B2CL' | 'EXPWP' | 'EXPWOP'
}
/** A changed invoice or note of a month already filed: its original number and date, and what it is now. */
export interface AmendedRow extends InvoiceRow {
  originalNumber: number | string // the number the filed return carried
  originalDate: string
}
export interface Amended {
  voucher: GstVoucher
  originalNumber: number | string // the number the filed return carried
  originalDate: string
}
export interface Gstr1 {
  b2b: InvoiceRow[]
  b2cl: InvoiceRow[]
  b2cs: ({ pos: string; rate: number; interstate: boolean } & TaxSum)[]
  exp: ExportRow[]
  cdnr: InvoiceRow[]
  cdnur: UnregNoteRow[]
  b2ba: AmendedRow[]
  b2cla: AmendedRow[]
  cdnra: AmendedRow[]
  nil: TaxSum
  /** Table 8 by supply type: inter- or intra-state, to registered or unregistered persons. */
  nilRows: NilRow[]
  hsn: { b2b: HsnRow[]; b2c: HsnRow[] }
  docs: { type: VoucherType; series: string | null; from: string; to: string; total: number; cancelled: number }[]
  summary: ({ section: string; count: number } & TaxSum)[]
  attention: { voucherId: number; type: VoucherType; number: number; docNo: string; date: string; problems: string[] }[]
}

/**
 * GSTR-1 for the outward vouchers of a period. `issued` lists every invoice and note numbered,
 * cancelled ones included; `amended` the vouchers of months already filed that changed in this one.
 */
export function gstr1(
  vouchers: GstVoucher[],
  issued: { type: VoucherType; number: number; docNo?: string; series?: string | null; cancelled: boolean }[] = [],
  amended: Amended[] = [],
): Gstr1 {
  const out = vouchers.filter((v) => v.gst.side === 'outward')
  const b2b: InvoiceRow[] = []
  const b2cl: InvoiceRow[] = []
  const exp: ExportRow[] = []
  const cdnr: InvoiceRow[] = []
  const cdnur: UnregNoteRow[] = []
  const b2cs = new Map<string, { pos: string; rate: number; interstate: boolean } & TaxSum>()
  const hsn = { b2b: new Map<string, HsnRow>(), b2c: new Map<string, HsnRow>() }
  const nil = zero()
  const nilRows = new Map<NilRow['supplyType'], NilRow>()
  for (const v of out) {
    const note = v.type === 'Credit Note'
    const sign = note ? -1 : 1
    const row = invoiceRow(v)
    const registered = !!v.gst.gstin
    const large = v.gst.interstate && v.gst.invoiceValue > B2CL_LIMIT
    if (v.gst.export && !note) exp.push({ ...row, expType: v.gst.export, ...(v.gst.shippingBill ? { shippingBill: v.gst.shippingBill } : {}) })
    else if (!row.rates.length) {
      // only exempt, nil-rated or non-GST lines: reported in table 8 alone
    } else if (registered) (note ? cdnr : b2b).push(row)
    else if (note && (v.gst.export || large)) cdnur.push({ ...row, noteType: v.gst.export ? (v.gst.export === 'WPAY' ? 'EXPWP' : 'EXPWOP') : 'B2CL' })
    else if (!note && large) b2cl.push(row)
    else
      // B2C (Small) is reported net, so unregistered credit notes come off it
      for (const r of row.rates) {
        const key = `${v.gst.pos}|${r.rate}|${v.gst.interstate}`
        add(b2cs.get(key) ?? b2cs.set(key, { pos: v.gst.pos, rate: r.rate, interstate: v.gst.interstate, ...zero() }).get(key)!, r, sign)
      }
    for (const l of v.gst.lines) {
      if (untaxed(l) && !v.gst.export) {
        add(nil, l, sign)
        const supplyType = `${v.gst.interstate ? 'INTR' : 'INTRA'}${registered ? 'B2B' : 'B2C'}` as NilRow['supplyType']
        const n = nilRows.get(supplyType) ?? nilRows.set(supplyType, { supplyType, nil: 0, exempt: 0, nonGst: 0 }).get(supplyType)!
        n[l.noTax === 'exempt' ? 'exempt' : l.noTax === 'nongst' ? 'nonGst' : 'nil'] += sign * l.taxable
      }
      // a non-GST supply has no HSN line
      if (l.noTax === 'nongst') continue
      const table = registered ? hsn.b2b : hsn.b2c
      const key = `${l.hsn}|${l.rate}|${l.uqc}`
      const h = table.get(key) ?? table.set(key, { hsn: l.hsn, rate: l.rate, uqc: l.uqc, qty: 0, ...zero() }).get(key)!
      h.qty += sign * l.qty
      add(h, l, sign)
    }
  }
  const sum = (rows: TaxSum[], sign = 1) => rows.reduce((t, r) => add(t, r, sign), zero())
  // one line per numbering series: the predefined type's own numbers, and each voucher type's
  const docs = (['Sales', 'Credit Note'] as const).flatMap((type) => {
    const series = [...new Set(issued.filter((d) => d.type === type).map((d) => d.series ?? null))].sort((a, b) => (a ?? '').localeCompare(b ?? ''))
    return series.map((name) => {
      const ns = issued.filter((d) => d.type === type && (d.series ?? null) === name).sort((a, b) => a.number - b.number)
      const no = (d: (typeof ns)[number]) => d.docNo ?? String(d.number)
      return { type, series: name, from: no(ns[0]), to: no(ns[ns.length - 1]), total: ns.length, cancelled: ns.filter((d) => d.cancelled).length }
    })
  })
  // amendments: registered invoices and notes, and B2C (Large) invoices, as they now stand
  const amend = (pick: (a: Amended) => boolean) =>
    amended.filter(pick).map((a) => ({ ...invoiceRow(a.voucher), originalNumber: a.originalNumber, originalDate: a.originalDate }))
  const outwardA = (a: Amended) => a.voucher.gst.side === 'outward' && !a.voucher.gst.export
  const b2ba = amend((a) => outwardA(a) && a.voucher.type === 'Sales' && !!a.voucher.gst.gstin)
  const cdnra = amend((a) => outwardA(a) && a.voucher.type === 'Credit Note' && !!a.voucher.gst.gstin)
  const b2cla = amend((a) => outwardA(a) && a.voucher.type === 'Sales' && !a.voucher.gst.gstin && a.voucher.gst.interstate && a.voucher.gst.invoiceValue > B2CL_LIMIT)
  const b2csRows = [...b2cs.values()].filter((r) => r.taxable || r.igst || r.cgst || r.sgst).sort((a, b) => a.pos.localeCompare(b.pos) || a.rate - b.rate)
  return {
    b2b,
    b2cl,
    b2cs: b2csRows,
    exp,
    cdnr,
    cdnur,
    b2ba,
    b2cla,
    cdnra,
    nil,
    nilRows: (['INTRB2B', 'INTRAB2B', 'INTRB2C', 'INTRAB2C'] as const).flatMap((t) => nilRows.get(t) ?? []),
    hsn: { b2b: [...hsn.b2b.values()].sort((a, b) => a.hsn.localeCompare(b.hsn)), b2c: [...hsn.b2c.values()].sort((a, b) => a.hsn.localeCompare(b.hsn)) },
    docs,
    summary: [
      { section: 'B2B Invoices (4A)', count: b2b.length, ...sum(b2b) },
      { section: 'B2C (Large) Invoices (5A)', count: b2cl.length, ...sum(b2cl) },
      { section: 'B2C (Small) Invoices (7)', count: b2csRows.length, ...sum(b2csRows) },
      { section: 'Exports (6A)', count: exp.length, ...sum(exp) },
      { section: 'Credit/Debit Notes (Registered) (9B)', count: cdnr.length, ...sum(cdnr, -1) },
      { section: 'Credit/Debit Notes (Unregistered) (9B)', count: cdnur.length, ...sum(cdnur, -1) },
      ...(nilRows.size ? [{ section: 'Nil Rated, Exempt and Non-GST (8)', count: nilRows.size, ...nil }] : []),
      ...(b2ba.length ? [{ section: 'Amended B2B Invoices (9A)', count: b2ba.length, ...sum(b2ba) }] : []),
      ...(b2cla.length ? [{ section: 'Amended B2C (Large) Invoices (9A)', count: b2cla.length, ...sum(b2cla) }] : []),
      ...(cdnra.length ? [{ section: 'Amended Credit/Debit Notes (Registered) (9C)', count: cdnra.length, ...sum(cdnra, -1) }] : []),
    ],
    attention: out.filter((v) => v.gst.problems.length).map((v) => ({ voucherId: v.id, type: v.type, number: v.number, docNo: v.docNo ?? String(v.number), date: v.date, problems: v.gst.problems })),
  }
}

export interface Gstr3b {
  outward: TaxSum // 3.1(a) taxable outward supplies
  zeroRated: TaxSum // 3.1(b) exports
  rcmInward: TaxSum // 3.1(d) inward supplies liable to reverse charge
  nilExempt: TaxSum // 3.1(c) nil-rated and exempt
  nonGst: TaxSum // 3.1(e) non-GST outward supplies
  /** 5: exempt, nil-rated and non-GST inward supplies, from other states and within the state */
  inwardExempt: { inter: number; intra: number }
  inwardNonGst: { inter: number; intra: number }
  interstateUnregistered: { pos: string; state: string; taxable: number; igst: number }[] // 3.2
  itc: { igst: number; cgst: number; sgst: number } // 4(A)(5) all other ITC
  itcRcm: { igst: number; cgst: number; sgst: number } // 4(A)(3) inward supplies liable to reverse charge
  reversed: { igst: number; cgst: number; sgst: number } // 4(B)(2) ITC reversed (others)
  reclaimed: { igst: number; cgst: number; sgst: number } // 4(D)(1) ITC reclaimed
  netItc: { igst: number; cgst: number; sgst: number } // 4(C)
  rcmCash: { igst: number; cgst: number; sgst: number } // reverse charge tax: paid in cash only
  payable: { igst: number; cgst: number; sgst: number } // tax due
  setOff: { from: 'igst' | 'cgst' | 'sgst'; to: 'igst' | 'cgst' | 'sgst'; amount: number }[]
  cash: { igst: number; cgst: number; sgst: number } // paid in cash after the credit
  carryForward: { igst: number; cgst: number; sgst: number } // credit left over
  /** compensation cess: its own credit pays only cess */
  cess: { outward: number; itc: number; reversed: number; payable: number; credit: number; cash: number; carryForward: number }
  attention: number
}

/**
 * GSTR-3B: outward tax as charged on the invoices (exports apart, in 3.1(b)), reverse charge
 * purchases in 3.1(d) with their tax as credit in 4(A)(3), other input tax credit as charged on
 * purchases (debit notes reverse it), less reversals and plus reclaims from GST adjustment
 * journals. Then the credit is set off against the outward tax: IGST credit first against IGST,
 * then CGST and SGST; CGST credit against CGST, then IGST; SGST credit against SGST, then IGST.
 * Reverse charge tax can't be paid from credit: it is paid in cash. Advances received and not yet
 * invoiced (net of those adjusted) add to the outward tax.
 */
export function gstr3b(vouchers: GstVoucher[], advances?: TaxSum): Gstr3b {
  const outward = zero()
  const zeroRated = zero()
  const rcmInward = zero()
  const nilExempt = zero()
  const nonGst = zero()
  const inwardExempt = { inter: 0, intra: 0 }
  const inwardNonGst = { inter: 0, intra: 0 }
  const unreg = new Map<string, { pos: string; state: string; taxable: number; igst: number }>()
  const itc = { igst: 0, cgst: 0, sgst: 0 }
  const reversed = { igst: 0, cgst: 0, sgst: 0 }
  const reclaimed = { igst: 0, cgst: 0, sgst: 0 }
  const cess = { outward: 0, itc: 0, reversed: 0 }
  const tax = (c: { igst: number; cgst: number; sgst: number }, sign = 1) => ({ igst: sign * c.igst, cgst: sign * c.cgst, sgst: sign * c.sgst })
  const into = (t: { igst: number; cgst: number; sgst: number }, x: { igst: number; cgst: number; sgst: number }) => {
    t.igst += x.igst
    t.cgst += x.cgst
    t.sgst += x.sgst
  }
  for (const v of vouchers) {
    const sign = v.type === 'Credit Note' || v.type === 'Debit Note' ? -1 : 1
    if (v.gst.side === 'adjustment') {
      into(v.gst.adjustment === 'itc-reclaim' ? reclaimed : reversed, tax(v.gst.charged))
      cess.reversed += (v.gst.adjustment === 'itc-reclaim' ? -1 : 1) * v.gst.charged.cess
      continue
    }
    if (v.gst.side === 'inward') {
      into(itc, tax(v.gst.charged, sign))
      cess.itc += sign * v.gst.charged.cess
      if (v.gst.rcm) add(rcmInward, v.gst.rcm, sign)
      for (const l of v.gst.lines.filter(untaxed)) (l.noTax === 'nongst' ? inwardNonGst : inwardExempt)[v.gst.interstate ? 'inter' : 'intra'] += sign * l.taxable
      continue
    }
    const taxed = v.gst.lines.filter((l) => !untaxed(l)).reduce((t, l) => t + l.taxable, 0)
    cess.outward += sign * v.gst.charged.cess
    if (v.gst.export) {
      add(zeroRated, { taxable: v.gst.lines.reduce((t, l) => t + l.taxable, 0), igst: v.gst.charged.igst, cgst: 0, sgst: 0, cess: v.gst.charged.cess }, sign)
      continue
    }
    add(outward, { taxable: taxed, igst: v.gst.charged.igst, cgst: v.gst.charged.cgst, sgst: v.gst.charged.sgst, cess: v.gst.charged.cess }, sign)
    for (const l of v.gst.lines.filter(untaxed)) add(l.noTax === 'nongst' ? nonGst : nilExempt, l, sign)
    if (!v.gst.gstin && v.gst.interstate) {
      const u = unreg.get(v.gst.pos) ?? unreg.set(v.gst.pos, { pos: v.gst.pos, state: stateName(v.gst.pos) ?? v.gst.pos, taxable: 0, igst: 0 }).get(v.gst.pos)!
      u.taxable += sign * taxed
      u.igst += sign * v.gst.charged.igst
    }
  }
  // advances received for services and not yet invoiced are taxed as outward supplies (GSTR-1 11A less 11B)
  if (advances) add(outward, advances)
  const itcRcm = tax(rcmInward)
  const netItc = { igst: 0, cgst: 0, sgst: 0 }
  into(netItc, itc)
  into(netItc, itcRcm)
  into(netItc, reclaimed)
  into(netItc, tax(reversed, -1))
  // tax on exports with payment is due like any outward tax
  const payable = { igst: outward.igst + zeroRated.igst, cgst: outward.cgst, sgst: outward.sgst }
  const due = { ...payable }
  const credit = { igst: Math.max(netItc.igst, 0), cgst: Math.max(netItc.cgst, 0), sgst: Math.max(netItc.sgst, 0) }
  const setOff: Gstr3b['setOff'] = []
  const use = (from: 'igst' | 'cgst' | 'sgst', to: 'igst' | 'cgst' | 'sgst') => {
    const amount = Math.min(credit[from], Math.max(due[to], 0))
    if (amount <= 0) return
    credit[from] -= amount
    due[to] -= amount
    setOff.push({ from, to, amount })
  }
  use('igst', 'igst')
  use('igst', 'cgst')
  use('igst', 'sgst')
  use('cgst', 'cgst')
  use('cgst', 'igst')
  use('sgst', 'sgst')
  use('sgst', 'igst')
  const rcmCash = tax(rcmInward)
  const cessCredit = Math.max(cess.itc - cess.reversed, 0)
  const cessUsed = Math.min(cessCredit, Math.max(cess.outward, 0))
  return {
    outward,
    zeroRated,
    rcmInward,
    nilExempt,
    nonGst,
    inwardExempt,
    inwardNonGst,
    interstateUnregistered: [...unreg.values()].filter((u) => u.taxable || u.igst).sort((a, b) => a.pos.localeCompare(b.pos)),
    itc,
    itcRcm,
    reversed,
    reclaimed,
    netItc,
    rcmCash,
    payable: { igst: payable.igst + rcmCash.igst, cgst: payable.cgst + rcmCash.cgst, sgst: payable.sgst + rcmCash.sgst },
    setOff,
    cash: { igst: Math.max(due.igst, 0) + rcmCash.igst, cgst: Math.max(due.cgst, 0) + rcmCash.cgst, sgst: Math.max(due.sgst, 0) + rcmCash.sgst },
    carryForward: credit,
    cess: {
      ...cess, payable: cess.outward, credit: cessCredit, cash: Math.max(cess.outward - cessUsed, 0), carryForward: cessCredit - cessUsed,
    },
    attention: vouchers.filter((v) => v.gst.problems.length).length,
  }
}

/** GSTR-3B 5.1: interest and late fee on a return filed after its due date. */
export interface Gstr3bLate {
  dueDate: string // the 20th of the next month (monthly filers)
  filedOn: string
  daysLate: number
  interest: { igst: number; cgst: number; sgst: number; cess: number } // 18% a year on the tax paid in cash
  lateFee: { cgst: number; sgst: number }
}

/**
 * Interest and late fee for a GSTR-3B filed (and its tax paid) on `filedOn`: interest at 18% a
 * year (section 50) on the tax paid in cash, for each day after the due date; late fee (section 47)
 * of ₹25 CGST and ₹25 SGST a day, ₹10 each for a nil return, capped by the previous year's
 * turnover as Notification 19/2021-Central Tax does: ₹250 each for a nil return, ₹1,000 each up
 * to ₹1.5 crore, ₹2,500 each up to ₹5 crore, ₹5,000 each above.
 */
export function gstr3bLate(month: string, filedOn: string, cash: { igst: number; cgst: number; sgst: number; cess?: number }, nil: boolean, lastYearTurnover: number): Gstr3bLate {
  const [y, m] = month.split('-').map(Number)
  const due = new Date(Date.UTC(y, m, 20)) // month m is the next month (0-based)
  const dueDate = due.toISOString().slice(0, 10)
  const daysLate = Math.max(Math.round((Date.parse(filedOn) - due.getTime()) / 86400000), 0)
  const interestOn = (tax: number) => Math.round((Math.max(tax, 0) * 18 * daysLate) / (100 * 365))
  const perDay = nil ? 1000 : 2500
  const cap = nil ? 25000 : lastYearTurnover <= 1_50_00_000_00 ? 1_00_000 : lastYearTurnover <= 5_00_00_000_00 ? 2_50_000 : 5_00_000
  const fee = Math.min(perDay * daysLate, cap)
  return {
    dueDate, filedOn, daysLate,
    interest: { igst: interestOn(cash.igst), cgst: interestOn(cash.cgst), sgst: interestOn(cash.sgst), cess: interestOn(cash.cess ?? 0) },
    lateFee: { cgst: fee, sgst: fee },
  }
}

/** GST's unit quantity codes (UQC) for the common unit symbols; anything else is OTH. */
const UQC: Record<string, string> = {
  kg: 'KGS', kgs: 'KGS', kilogram: 'KGS', kilograms: 'KGS', g: 'GMS', gm: 'GMS', gms: 'GMS', gram: 'GMS', grams: 'GMS',
  qtl: 'QTL', quintal: 'QTL', ton: 'TON', tonne: 'TON', mt: 'MTS', nos: 'NOS', no: 'NOS', numbers: 'NOS', pcs: 'PCS', pc: 'PCS', pieces: 'PCS',
  bag: 'BAG', bags: 'BAG', box: 'BOX', boxes: 'BOX', btl: 'BTL', bottle: 'BTL', doz: 'DOZ', dozen: 'DOZ', ltr: 'LTR', l: 'LTR', litre: 'LTR',
  ml: 'MLT', mtr: 'MTR', m: 'MTR', metre: 'MTR', meter: 'MTR', set: 'SET', sets: 'SET', pac: 'PAC', pack: 'PAC', roll: 'ROL', sqm: 'SQM', sqft: 'SQF',
  unt: 'UNT', units: 'UNT', oth: 'OTH',
}
/** Every unit quantity code the GST portal accepts. */
export const UQC_CODES = [
  'BAG', 'BAL', 'BDL', 'BKL', 'BOU', 'BOX', 'BTL', 'BUN', 'CAN', 'CBM', 'CCM', 'CMS', 'CTN', 'DOZ', 'DRM', 'GGK', 'GMS', 'GRS', 'GYD', 'KGS', 'KLR', 'KME',
  'LTR', 'MLS', 'MLT', 'MTR', 'MTS', 'NOS', 'OTH', 'PAC', 'PCS', 'PRS', 'QTL', 'ROL', 'SET', 'SQF', 'SQM', 'SQY', 'TBS', 'TGM', 'THD', 'TON', 'TUB', 'UGS',
  'UNT', 'YDS',
]
/** A unit's UQC: the code itself, or the code for a common symbol, else OTH. */
export const uqcOf = (unit: string) => (UQC_CODES.includes(unit.trim()) ? unit.trim() : (UQC[unit.trim().toLowerCase()] ?? 'OTH'))

const rupees = (p: number) => Math.round(p) / 100
const dmy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`
const pct = (rate: number) => rate / 100
const items = (rows: ({ rate: number } & TaxSum)[], igstOnly = false) =>
  rows.map((r, i) => ({
    num: i + 1,
    itm_det: igstOnly
      ? { rt: pct(r.rate), txval: rupees(r.taxable), iamt: rupees(r.igst), csamt: rupees(r.cess ?? 0) }
      : { rt: pct(r.rate), txval: rupees(r.taxable), iamt: rupees(r.igst), camt: rupees(r.cgst), samt: rupees(r.sgst), csamt: rupees(r.cess ?? 0) },
  }))

/**
 * GSTR-1 in the JSON layout of the GST portal's offline tool, for one return month (`fp` is
 * MMYYYY). Amounts are rupees; dates dd-mm-yyyy.
 */
export function gstr1Json(r: Gstr1, gstin: string, fp: string) {
  const byParty = <R extends InvoiceRow, T>(rows: R[], make: (row: R) => T) => {
    const m = new Map<string, T[]>()
    for (const row of rows) (m.get(row.gstin!) ?? m.set(row.gstin!, []).get(row.gstin!)!).push(make(row))
    return [...m.entries()]
  }
  const hsnRows = (rows: HsnRow[]) =>
    rows.map((h, i) => ({
      num: i + 1, hsn_sc: h.hsn, uqc: uqcOf(h.uqc), qty: h.qty / 1000, rt: pct(h.rate), txval: rupees(h.taxable),
      iamt: rupees(h.igst), camt: rupees(h.cgst), samt: rupees(h.sgst), csamt: rupees(h.cess ?? 0),
    }))
  return {
    gstin,
    fp,
    b2b: byParty(r.b2b, (row) => ({
      inum: row.docNo, idt: dmy(row.date), val: rupees(row.value), pos: row.pos, rchrg: 'N', inv_typ: 'R', itms: items(row.rates),
    })).map(([ctin, inv]) => ({ ctin, inv })),
    b2cl: [...new Set(r.b2cl.map((x) => x.pos))].map((pos) => ({
      pos,
      inv: r.b2cl.filter((x) => x.pos === pos).map((row) => ({ inum: row.docNo, idt: dmy(row.date), val: rupees(row.value), itms: items(row.rates, true) })),
    })),
    b2cs: r.b2cs.map((x) => ({
      sply_ty: x.interstate ? 'INTER' : 'INTRA', pos: x.pos, typ: 'OE', rt: pct(x.rate), txval: rupees(x.taxable),
      iamt: rupees(x.igst), camt: rupees(x.cgst), samt: rupees(x.sgst), csamt: rupees(x.cess ?? 0),
    })),
    exp: (['WPAY', 'WOPAY'] as const)
      .map((t) => ({
        exp_typ: t,
        inv: r.exp.filter((x) => x.expType === t).map((row) => ({
          inum: row.docNo, idt: dmy(row.date), val: rupees(row.value),
          ...(row.shippingBill ? { sbpcode: row.shippingBill.port, sbnum: row.shippingBill.no, sbdt: dmy(row.shippingBill.date) } : {}),
          itms: row.rates.map((x) => ({ txval: rupees(x.taxable), rt: pct(x.rate), iamt: rupees(x.igst), csamt: rupees(x.cess ?? 0) })),
        })),
      }))
      .filter((x) => x.inv.length),
    cdnur: r.cdnur.map((row) => ({
      typ: row.noteType, ntty: 'C', nt_num: row.docNo, nt_dt: dmy(row.date), val: rupees(row.value),
      ...(row.noteType === 'B2CL' ? { pos: row.pos } : {}), itms: items(row.rates, true),
    })),
    b2ba: byParty(r.b2ba, (row) => ({
      oinum: String(row.originalNumber), oidt: dmy(row.originalDate), inum: row.docNo, idt: dmy(row.date), val: rupees(row.value),
      pos: row.pos, rchrg: 'N', inv_typ: 'R', itms: items(row.rates),
    })).map(([ctin, inv]) => ({ ctin, inv })),
    b2cla: [...new Set(r.b2cla.map((x) => x.pos))].map((pos) => ({
      pos,
      inv: r.b2cla.filter((x) => x.pos === pos).map((row) => ({
        oinum: String(row.originalNumber), oidt: dmy(row.originalDate), inum: row.docNo, idt: dmy(row.date), val: rupees(row.value), itms: items(row.rates, true),
      })),
    })),
    cdnra: byParty(r.cdnra, (row) => ({
      ont_num: String(row.originalNumber), ont_dt: dmy(row.originalDate), ntty: 'C', nt_num: row.docNo, nt_dt: dmy(row.date), val: rupees(row.value),
      pos: row.pos, rchrg: 'N', inv_typ: 'R', itms: items(row.rates),
    })).map(([ctin, nt]) => ({ ctin, nt })),
    cdnr: byParty(r.cdnr, (row) => ({
      ntty: 'C', nt_num: row.docNo, nt_dt: dmy(row.date), val: rupees(row.value), pos: row.pos, rchrg: 'N', inv_typ: 'R', itms: items(row.rates),
    })).map(([ctin, nt]) => ({ ctin, nt })),
    ...(r.nilRows.length
      ? { nil: { inv: r.nilRows.map((n) => ({ sply_ty: n.supplyType, nil_amt: rupees(n.nil), expt_amt: rupees(n.exempt), ngsup_amt: rupees(n.nonGst) })) } }
      : {}),
    hsn: { hsn_b2b: hsnRows(r.hsn.b2b), hsn_b2c: hsnRows(r.hsn.b2c) },
    doc_issue: {
      // 1 invoices for outward supply, 5 credit notes; a line per numbering series
      doc_det: (['Sales', 'Credit Note'] as const).filter((t) => r.docs.some((d) => d.type === t)).map((t) => ({
        doc_num: t === 'Sales' ? 1 : 5,
        docs: r.docs.filter((d) => d.type === t).map((d, i) => ({ num: i + 1, from: d.from, to: d.to, totnum: d.total, cancel: d.cancelled, net_issue: d.total - d.cancelled })),
      })),
    },
  }
}
