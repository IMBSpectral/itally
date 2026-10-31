/**
 * GST beyond the monthly returns: the GST vouchers of a period, the documents the portal holds
 * (GSTR-2B with IMS actions, a filed GSTR-1) reconciled with the books, advances received (GSTR-1
 * 11A/11B), the annual return (GSTR-9), a composition dealer's CMP-08 and GSTR-4, challans of GST
 * paid, and the parties' GSTINs updated together.
 */
import { pool, withTx } from './db'
import { getCompany, loadGroups, ValidationError } from './books'
import { isUnder } from './engine/groups'
import { gstinError, stateCode, stateName, type GstBreakup } from './engine/gst'
import { gstr1, gstr3b, type Amended, type GstVoucher, type TaxSum } from './engine/gst-returns'
import type { VoucherType } from './engine/voucher'

type Period = { from: string; to: string }

/** The GST registration a voucher is of: its voucher type's, else the company's own (0). */
const REGISTRATION = `COALESCE((SELECT t.gst_registration_id FROM voucher_types t WHERE t.id = voucher_type_id), 0)`

export async function gstVouchers(companyId: number, p: Period, registration = 0) {
  const { rows } = await pool.query<GstVoucher>(
    `SELECT id, type, number, COALESCE(doc_no, number::text) "docNo", to_char(date,'YYYY-MM-DD') date, gst FROM vouchers
      WHERE company_id = $1 AND date BETWEEN $2 AND $3 AND NOT cancelled AND gst IS NOT NULL AND ${REGISTRATION} = $4 ORDER BY date, id`,
    [companyId, p.from, p.to, registration],
  )
  return rows
}
export async function issued(companyId: number, p: Period, registration = 0) {
  return (await pool.query<{ type: VoucherType; number: number; docNo: string; series: string | null; cancelled: boolean }>(
    `SELECT type, number, COALESCE(doc_no, number::text) "docNo", (SELECT name FROM voucher_types t WHERE t.id = voucher_type_id) series, cancelled
       FROM vouchers WHERE company_id = $1 AND type IN ('Sales', 'Credit Note') AND date BETWEEN $2 AND $3 AND ${REGISTRATION} = $4`,
    [companyId, p.from, p.to, registration],
  )).rows
}

/** The company's GST registrations: its own GSTIN (id 0) and the further ones. */
export async function gstRegistrations(companyId: number) {
  const c = (await getCompany(pool, companyId))!
  const more = (await pool.query<{ id: number; name: string; gstin: string; state: string; types: number }>(
    `SELECT r.id, r.name, r.gstin, r.state, (SELECT count(*)::int FROM voucher_types t WHERE t.gst_registration_id = r.id) types
       FROM gst_registrations r WHERE r.company_id = $1 ORDER BY r.id`, [companyId],
  )).rows
  return [{ id: 0, name: 'Main', gstin: c.gstin, state: c.state, types: 0 }, ...more]
}
export async function createGstRegistration(companyId: number, r: { name: string; gstin: string }) {
  const gstin = r.gstin.trim().toUpperCase()
  const errors: string[] = []
  if (!r.name.trim()) errors.push('Name the registration (the branch or state)')
  const bad = gstinError(gstin)
  if (bad) errors.push(bad)
  const c = (await getCompany(pool, companyId))!
  if (!c.gstin) errors.push('Set the company\'s own GSTIN first')
  if (c.gstin && !bad && c.gstin.slice(2, 12) !== gstin.slice(2, 12)) errors.push('A further registration has the company\'s PAN (characters 3 to 12 of the GSTIN)')
  if (c.gstin === gstin) errors.push('That is the company\'s own GSTIN')
  if (errors.length) throw new ValidationError(errors)
  return (await pool.query<{ id: number }>(`INSERT INTO gst_registrations (company_id, name, gstin, state) VALUES ($1,$2,$3,$4) RETURNING id`,
    [companyId, r.name.trim(), gstin, stateName(gstin.slice(0, 2))]).catch((e: { code?: string }) => {
    if (e.code === '23505') throw new ValidationError(['A registration of that name or GSTIN is already there'])
    throw e
  })).rows[0].id
}
export async function deleteGstRegistration(companyId: number, id: number) {
  if ((await pool.query(`SELECT 1 FROM voucher_types WHERE gst_registration_id = $1 LIMIT 1`, [id])).rowCount)
    throw new ValidationError(['Voucher types belong to this registration; move them first'])
  await pool.query(`DELETE FROM gst_registrations WHERE id = $1 AND company_id = $2`, [id, companyId])
}
/** The GSTIN and state of a registration (0: the company's own). */
export async function registrationOf(companyId: number, id: number) {
  const r = (await gstRegistrations(companyId)).find((x) => x.id === id)
  if (!r) throw new ValidationError([`Unknown GST registration ${id}`])
  if (!r.gstin) throw new ValidationError(['Set the company GSTIN first (GST Reports → Registration)'])
  return r
}

/**
 * Kerala Flood Cess (1 August 2019 to 31 July 2021): 1% on intra-state supplies to unregistered
 * buyers by a dealer registered in Kerala (0.25% on goods taxed at 3%), on the taxable value.
 */
export async function keralaFloodCess(companyId: number, p: Period, registration = 0) {
  const r = await registrationOf(companyId, registration)
  if (r.gstin!.slice(0, 2) !== '32') return { applicable: false, reason: 'Kerala Flood Cess applied to dealers registered in Kerala', lines: [], total: { taxable: 0, cess: 0 } }
  const from = p.from < '2019-08-01' ? '2019-08-01' : p.from
  const to = p.to > '2021-07-31' ? '2021-07-31' : p.to
  if (from > to) return { applicable: false, reason: 'Kerala Flood Cess was levied from 1 August 2019 to 31 July 2021', lines: [], total: { taxable: 0, cess: 0 } }
  const lines = []
  for (const v of await gstVouchers(companyId, { from, to }, registration)) {
    if (v.gst.side !== 'outward' || v.gst.gstin || v.gst.interstate) continue
    const s = v.type === 'Credit Note' ? -1 : 1
    for (const l of v.gst.lines.filter((l) => !l.noTax && l.rate >= 300)) {
      const rate = l.rate === 300 ? 25 : 100 // hundredths of a percent
      lines.push({ voucherId: v.id, date: v.date, docNo: v.docNo ?? String(v.number), party: v.gst.party, gstRate: l.rate, rate, taxable: s * l.taxable, cess: s * Math.round((l.taxable * rate) / 10000) })
    }
  }
  return { applicable: true, from, to, lines, total: { taxable: lines.reduce((t, l) => t + l.taxable, 0), cess: lines.reduce((t, l) => t + l.cess, 0) } }
}
/**
 * Invoices and notes of months already filed that were altered during this period, after their
 * month was filed: reported as amendments, with the number and date the filed return carried
 * (the voucher as the Edit Log had it when the month was filed).
 */
export async function amendedVouchers(companyId: number, p: Period): Promise<Amended[]> {
  const { rows } = await pool.query<GstVoucher & { originalNumber: string; originalDate: string }>(
    `SELECT v.id, v.type, v.number, COALESCE(v.doc_no, v.number::text) "docNo", to_char(v.date,'YYYY-MM-DD') date, v.gst, filed.number "originalNumber", filed.date "originalDate"
       FROM vouchers v
       JOIN gst_filings f ON f.company_id = v.company_id
       CROSS JOIN LATERAL (
         SELECT COALESCE(l.data ->> 'docNo', l.data ->> 'number') number, l.data ->> 'date' date FROM edit_log l
          WHERE l.entity = 'voucher' AND l.entity_id = v.id AND l.company_id = v.company_id AND l.at <= f.filed_at
          ORDER BY l.id DESC LIMIT 1) filed
      WHERE v.company_id = $1 AND NOT v.cancelled AND v.gst IS NOT NULL AND f.month = left(filed.date, 7)
        AND filed.date::date < $2::date
        AND EXISTS (SELECT 1 FROM edit_log e WHERE e.entity = 'voucher' AND e.entity_id = v.id AND e.company_id = v.company_id
                       AND e.action = 'alter' AND e.at > f.filed_at AND e.at >= $2::date AND e.at < $3::date + 1)
      ORDER BY v.date, v.id`,
    [companyId, p.from, p.to],
  )
  return rows.map(({ originalNumber, originalDate, ...voucher }) => ({ voucher, originalNumber, originalDate }))
}


// ------------------------------------------------------------------ the portal's documents

export interface PortalDoc {
  gstin: string
  party: string | null
  docType: 'Invoice' | 'Credit Note' | 'Debit Note'
  docNo: string
  docDate: string
  pos: string | null
  rcm: boolean
  taxable: number
  igst: number
  cgst: number
  sgst: number
  cess: number
  value: number
}

const paise = (x: unknown) => Math.round(Number(x ?? 0) * 100)
/** dd-mm-yyyy (the portal's dates) to yyyy-mm-dd */
const isoOf = (d: string) => {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(d ?? '').trim())
  if (!m) throw new ValidationError([`"${d}" is not a date as the portal writes it (dd-mm-yyyy)`])
  return `${m[3]}-${m[2]}-${m[1]}`
}
/** mmyyyy (a return period) to yyyy-mm */
const monthOf = (fp: string) => {
  const m = /^(\d{2})(\d{4})$/.exec(String(fp ?? '').trim())
  if (!m) throw new ValidationError([`"${fp}" is not a return period (mmyyyy)`])
  return `${m[2]}-${m[1]}`
}
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * The documents of a GSTR-2B file downloaded from the portal (B2B invoices and registered credit
 * and debit notes, with the supplier, the reverse charge flag and the tax per item) and its period.
 */
export function parse2b(file: Json): { month: string; gstin: string | null; docs: PortalDoc[] } {
  const d = file?.data ?? file
  const month = monthOf(d?.rtnprd)
  const docdata = d?.docdata ?? {}
  const sums = (items: Json[]) => ({
    taxable: items.reduce((t, i) => t + paise(i.txval), 0), igst: items.reduce((t, i) => t + paise(i.igst), 0), cgst: items.reduce((t, i) => t + paise(i.cgst), 0),
    sgst: items.reduce((t, i) => t + paise(i.sgst), 0), cess: items.reduce((t, i) => t + paise(i.cess), 0),
  })
  const docs: PortalDoc[] = []
  for (const s of docdata.b2b ?? [])
    for (const inv of s.inv ?? [])
      docs.push({ gstin: s.ctin, party: s.trdnm ?? null, docType: 'Invoice', docNo: String(inv.inum), docDate: isoOf(inv.dt), pos: inv.pos ?? null, rcm: inv.rev === 'Y',
        ...sums(inv.items ?? []), value: paise(inv.val) })
  for (const s of docdata.cdnr ?? [])
    for (const nt of s.nt ?? [])
      docs.push({ gstin: s.ctin, party: s.trdnm ?? null, docType: nt.typ === 'D' ? 'Debit Note' : 'Credit Note', docNo: String(nt.ntnum), docDate: isoOf(nt.dt), pos: nt.pos ?? null,
        rcm: nt.rev === 'Y', ...sums(nt.items ?? []), value: paise(nt.val) })
  if (!d?.docdata) throw new ValidationError(['This is not a GSTR-2B file: it has no docdata'])
  return { month, gstin: d?.gstin ? String(d.gstin).toUpperCase() : null, docs }
}

/** The B2B invoices and registered notes of a GSTR-1 (as filed, or the JSON this app makes) and its period. */
export function parseGstr1(file: Json): { month: string; gstin: string | null; docs: PortalDoc[] } {
  const month = monthOf(file?.fp)
  if (!file?.b2b && !file?.cdnr) throw new ValidationError(['This is not a GSTR-1 file: it has no b2b or cdnr section'])
  const sums = (items: Json[]) => {
    const det = items.map((i) => i.itm_det ?? i)
    return {
      taxable: det.reduce((t, i) => t + paise(i.txval), 0), igst: det.reduce((t, i) => t + paise(i.iamt), 0), cgst: det.reduce((t, i) => t + paise(i.camt), 0),
      sgst: det.reduce((t, i) => t + paise(i.samt), 0), cess: det.reduce((t, i) => t + paise(i.csamt), 0),
    }
  }
  const docs: PortalDoc[] = []
  for (const s of file.b2b ?? [])
    for (const inv of s.inv ?? [])
      docs.push({ gstin: s.ctin, party: null, docType: 'Invoice', docNo: String(inv.inum), docDate: isoOf(inv.idt), pos: inv.pos ?? null, rcm: inv.rchrg === 'Y',
        ...sums(inv.itms ?? []), value: paise(inv.val) })
  for (const s of file.cdnr ?? [])
    for (const nt of s.nt ?? [])
      docs.push({ gstin: s.ctin, party: null, docType: nt.ntty === 'D' ? 'Debit Note' : 'Credit Note', docNo: String(nt.nt_num), docDate: isoOf(nt.nt_dt), pos: nt.pos ?? null,
        rcm: nt.rchrg === 'Y', ...sums(nt.itms ?? []), value: paise(nt.val) })
  return { month, gstin: file?.gstin ? String(file.gstin).toUpperCase() : null, docs }
}

/** Keeps a GSTR-2B or GSTR-1 file's documents for its period, replacing an earlier upload; the IMS actions already taken stay. */
export async function importPortalDocs(companyId: number, source: '2B' | 'GSTR-1', file: Json) {
  const { month, gstin, docs } = source === '2B' ? parse2b(file) : parseGstr1(file)
  // the file is for the company's GSTIN or one of its further registrations
  const regs = await gstRegistrations(companyId)
  const own = gstin ? regs.find((r) => r.gstin?.toUpperCase() === gstin) : regs.find((r) => r.id === 0)
  if (!own) throw new ValidationError([`This file is for GSTIN ${gstin}, which is not this company's nor one of its further registrations`])
  const registration = own.id || null
  await withTx(async (tx) => {
    const kept = new Map((await tx.query<{ k: string; action: string }>(
      `SELECT gstin || '|' || doc_type || '|' || upper(doc_no) k, ims_action action FROM gst_portal_docs
        WHERE company_id = $1 AND source = $2 AND month = $3 AND registration_id IS NOT DISTINCT FROM $4`, [companyId, source, month, registration],
    )).rows.map((r) => [r.k, r.action]))
    await tx.query(`DELETE FROM gst_portal_docs WHERE company_id = $1 AND source = $2 AND month = $3 AND registration_id IS NOT DISTINCT FROM $4`, [companyId, source, month, registration])
    for (const d of docs)
      await tx.query(
        `INSERT INTO gst_portal_docs (company_id, source, month, gstin, party, doc_type, doc_no, doc_date, pos, rcm, taxable, igst, cgst, sgst, cess, value, ims_action, registration_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT DO NOTHING`,
        [companyId, source, month, d.gstin, d.party, d.docType, d.docNo, d.docDate, d.pos, d.rcm, d.taxable, d.igst, d.cgst, d.sgst, d.cess, d.value,
          kept.get(`${d.gstin}|${d.docType}|${d.docNo.toUpperCase()}`) ?? 'Pending', registration],
      )
  })
  return { month, count: docs.length, registration: own.id }
}

/** IMS: accept, reject or leave pending each inward document of GSTR-2B. */
export async function setImsActions(companyId: number, items: { id: number; action: 'Accepted' | 'Rejected' | 'Pending' }[]) {
  await withTx(async (tx) => {
    for (const i of items) {
      const { rowCount } = await tx.query(`UPDATE gst_portal_docs SET ims_action = $3 WHERE id = $1 AND company_id = $2 AND source = '2B'`, [i.id, companyId, i.action])
      if (!rowCount) throw new ValidationError([`Unknown GSTR-2B document ${i.id}`])
    }
  })
}

interface BooksDoc {
  voucherId: number
  type: string
  docNo: string
  date: string
  gstin: string
  party: string | null
  taxable: number
  igst: number
  cgst: number
  sgst: number
  value: number
}
const norm = (s: string) => s.toUpperCase().replace(/[\s/-]/g, '').replace(/^0+/, '')
const close = (a: number, b: number) => Math.abs(a - b) <= 100 // a rupee's rounding

/**
 * Matches the portal's documents for a month with the books: by GSTIN, kind of document and number
 * (the supplier's invoice number on a purchase); matched documents whose date, taxable value or
 * tax differ by more than a rupee are mismatches. Books' documents of the month that the portal
 * lacks, and the portal's that the books lack, are listed apart.
 */
async function reconcile(companyId: number, source: '2B' | 'GSTR-1', month: string, registration = 0) {
  const company = await registrationOf(companyId, registration)
  const portal = (await pool.query<PortalDoc & { id: number; imsAction: string }>(
    `SELECT id, gstin, party, doc_type "docType", doc_no "docNo", to_char(doc_date, 'YYYY-MM-DD') "docDate", pos, rcm, taxable::float8 taxable, igst::float8 igst,
            cgst::float8 cgst, sgst::float8 sgst, cess::float8 cess, value::float8 value, ims_action "imsAction"
       FROM gst_portal_docs WHERE company_id = $1 AND source = $2 AND month = $3 AND COALESCE(registration_id, 0) = $4 ORDER BY gstin, doc_date, doc_no`,
    [companyId, source, month, registration],
  )).rows
  // the books' side: a year either side of the month, so documents booked in another month still match
  const from = `${Number(month.slice(0, 4)) - 1}${month.slice(4)}-01`
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10)
  const to = `${Number(last.slice(0, 4)) + 1}${last.slice(4)}`
  const types = source === '2B' ? ['Purchase', 'Debit Note'] : ['Sales', 'Credit Note']
  const books = (await pool.query<{ id: number; type: string; docNo: string; date: string; refNo: string | null; gst: GstBreakup }>(
    `SELECT id, type, COALESCE(doc_no, number::text) "docNo", to_char(COALESCE(ref_date, date), 'YYYY-MM-DD') date, ref_no "refNo", gst FROM vouchers
      WHERE company_id = $1 AND type = ANY($2) AND date BETWEEN $3 AND $4 AND NOT cancelled AND gst IS NOT NULL AND gst ->> 'gstin' IS NOT NULL AND ${REGISTRATION} = $5
      ORDER BY date, id`,
    [companyId, types, from, to, registration],
  )).rows.map((v): BooksDoc => {
    const lines = v.gst.lines
    return {
      voucherId: v.id, type: v.type, docNo: (source === '2B' ? v.refNo : null) ?? v.docNo, date: v.date, gstin: v.gst.gstin!, party: v.gst.party,
      taxable: lines.reduce((t, l) => t + l.taxable, 0), igst: lines.reduce((t, l) => t + l.igst, 0), cgst: lines.reduce((t, l) => t + l.cgst, 0),
      sgst: lines.reduce((t, l) => t + l.sgst, 0), value: v.gst.invoiceValue,
    }
  })
  // the portal's credit note from a supplier is our debit note; a GSTR-1 credit note is ours
  const kindOf = (b: BooksDoc) => (b.type === 'Purchase' || b.type === 'Sales' ? 'Invoice' : source === '2B' ? 'Credit Note' : 'Credit Note')
  const key = (gstin: string, kind: string, no: string) => `${gstin}|${kind}|${norm(no)}`
  const byKey = new Map(books.map((b) => [key(b.gstin, kindOf(b), b.docNo), b]))
  const used = new Set<number>()
  const rows = portal.map((p) => {
    const b = byKey.get(key(p.gstin, p.docType, p.docNo))
    if (b) used.add(b.voucherId)
    const differences: string[] = []
    if (b) {
      if (b.date !== p.docDate) differences.push('date')
      if (!close(b.taxable, p.taxable)) differences.push('taxable value')
      if (!close(b.igst, p.igst) || !close(b.cgst, p.cgst) || !close(b.sgst, p.sgst)) differences.push('tax')
    }
    return { id: p.id, status: !b ? 'Not in books' : differences.length ? 'Mismatch' : 'Matched', differences, portal: p, books: b ?? null, imsAction: p.imsAction }
  })
  const missing = books.filter((b) => !used.has(b.voucherId) && b.date.slice(0, 7) === month)
  const total = (xs: { igst: number; cgst: number; sgst: number }[]) => ({ igst: xs.reduce((t, x) => t + x.igst, 0), cgst: xs.reduce((t, x) => t + x.cgst, 0), sgst: xs.reduce((t, x) => t + x.sgst, 0) })
  const sign = (d: { docType: string }) => (d.docType === 'Credit Note' ? -1 : 1)
  const signed = (xs: PortalDoc[]) => xs.map((x) => ({ igst: sign(x) * x.igst, cgst: sign(x) * x.cgst, sgst: sign(x) * x.sgst }))
  return {
    month, gstin: company.gstin, uploaded: portal.length > 0,
    rows,
    notOnPortal: missing.map((b) => ({ ...b, status: source === '2B' ? 'Not in GSTR-2B' : 'Not in GSTR-1' })),
    summary: {
      matched: rows.filter((r) => r.status === 'Matched').length,
      mismatched: rows.filter((r) => r.status === 'Mismatch').length,
      notInBooks: rows.filter((r) => r.status === 'Not in books').length,
      notOnPortal: missing.length,
      portalTax: total(signed(portal)),
      // IMS: the credit the portal will allow is that of the documents not rejected
      ...(source === '2B' ? { acceptedTax: total(signed(portal.filter((p) => p.imsAction !== 'Rejected' && !p.rcm))), pending: portal.filter((p) => p.imsAction === 'Pending').length } : {}),
    },
  }
}
export const reconcile2b = (companyId: number, month: string, registration = 0) => reconcile(companyId, '2B', month, registration)
export const reconcileGstr1 = (companyId: number, month: string, registration = 0) => reconcile(companyId, 'GSTR-1', month, registration)

// ------------------------------------------------------------------ advances

/**
 * Advances received for services, taxed on receipt (GSTR-1 tables 11A and 11B): a Receipt with a
 * GST rate whose party's bill is an Advance. 11A: what is still unadjusted at the period's end of
 * the advances received in it; 11B: what invoices in the period adjusted of advances received
 * before it. The amounts received include the tax.
 */
export async function gstAdvances(companyId: number, p: { from: string; to: string }, registration = 0) {
  const company = registration ? await registrationOf(companyId, registration) : (await getCompany(pool, companyId))!
  const { rows } = await pool.query<{ voucherId: number; docNo: string; date: string; ledgerId: number; party: string; state: string | null; gstin: string | null; rate: number; bill: string
    received: number }>(
    `SELECT v.id "voucherId", COALESCE(v.doc_no, v.number::text) "docNo", to_char(v.date, 'YYYY-MM-DD') date, a.ledger_id "ledgerId", l.name party, l.state, l.gstin, v.advance_rate rate,
            a.name bill, (-a.amount)::float8 received
       FROM vouchers v JOIN entries e ON e.voucher_id = v.id JOIN bill_allocations a ON a.entry_id = e.id JOIN ledgers l ON l.id = a.ledger_id
      WHERE v.company_id = $1 AND v.type = 'Receipt' AND v.advance_rate IS NOT NULL AND NOT v.cancelled AND a.ref_type = 'Advance' AND v.date <= $2
        AND COALESCE((SELECT t.gst_registration_id FROM voucher_types t WHERE t.id = v.voucher_type_id), 0) = $3
      ORDER BY v.date, v.id`,
    [companyId, p.to, registration],
  )
  const adjusted = async (ledgerId: number, bill: string, from: string | null, to: string) =>
    Number((await pool.query<{ s: number }>(
      `SELECT COALESCE(SUM(a.amount), 0)::float8 s FROM bill_allocations a JOIN entries e ON e.id = a.entry_id JOIN vouchers v ON v.id = e.voucher_id
        WHERE a.ledger_id = $1 AND lower(a.name) = lower($2) AND a.ref_type = 'Agst Ref' AND v.type = 'Sales' AND NOT v.cancelled
          AND v.date <= $3 AND ($4::date IS NULL OR v.date >= $4)`,
      [ledgerId, bill, to, from],
    )).rows[0].s)
  // the place of supply is the party's: the state of its GSTIN, else the state it is in, else ours
  const split = (gross: number, rate: number, r: { state: string | null; gstin: string | null }) => {
    const taxable = Math.round((gross * 10000) / (10000 + rate))
    const tax = gross - taxable
    const pos = (r.gstin && !gstinError(r.gstin) ? r.gstin.slice(0, 2) : undefined) ?? stateCode(r.state ?? company.state) ?? stateCode(company.state) ?? ''
    const inter = !!company.state && pos !== stateCode(company.state)
    const half = Math.round(tax / 2)
    return { pos, interstate: inter, taxable, igst: inter ? tax : 0, cgst: inter ? 0 : half, sgst: inter ? 0 : tax - half }
  }
  const received = []
  const adjustedRows = []
  for (const r of rows) {
    if (r.date >= p.from) {
      const unadjusted = r.received - (await adjusted(r.ledgerId, r.bill, null, p.to))
      if (unadjusted > 0) received.push({ ...r, rate: Number(r.rate), unadjusted, ...split(unadjusted, Number(r.rate), r) })
    } else {
      const adj = await adjusted(r.ledgerId, r.bill, p.from, p.to)
      if (adj > 0) adjustedRows.push({ ...r, rate: Number(r.rate), adjusted: adj, ...split(adj, Number(r.rate), r) })
    }
  }
  const sum = (xs: { taxable: number; igst: number; cgst: number; sgst: number }[]) => ({
    taxable: xs.reduce((t, x) => t + x.taxable, 0), igst: xs.reduce((t, x) => t + x.igst, 0), cgst: xs.reduce((t, x) => t + x.cgst, 0), sgst: xs.reduce((t, x) => t + x.sgst, 0),
  })
  const a = sum(received)
  const b = sum(adjustedRows)
  return { received, adjusted: adjustedRows, totals: { received: a, adjusted: b, net: { taxable: a.taxable - b.taxable, igst: a.igst - b.igst, cgst: a.cgst - b.cgst, sgst: a.sgst - b.sgst } } }
}

// ------------------------------------------------------------------ annual return and composition

const monthsOf = (fyStart: string) =>
  Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(Number(fyStart.slice(0, 4)), Number(fyStart.slice(5, 7)) - 1 + i, 1))
    const from = d.toISOString().slice(0, 10)
    const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)
    return { from, to }
  })
const zero3 = () => ({ igst: 0, cgst: 0, sgst: 0 })
const add3 = (t: { igst: number; cgst: number; sgst: number }, x: { igst: number; cgst: number; sgst: number }, s = 1) => {
  t.igst += s * x.igst
  t.cgst += s * x.cgst
  t.sgst += s * x.sgst
  return t
}
const zeroSum = () => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0 })
const addSum = (t: TaxSum, x: TaxSum, s = 1) => {
  t.taxable += s * x.taxable
  add3(t, x, s)
  return t
}

/** Inward supplies by HSN and rate (GSTR-9 table 18). */
function inwardHsn(vouchers: GstVoucher[]) {
  const m = new Map<string, { hsn: string; rate: number; uqc: string; qty: number } & TaxSum>()
  for (const v of vouchers.filter((v) => v.gst.side === 'inward')) {
    const s = v.type === 'Debit Note' ? -1 : 1
    for (const l of v.gst.lines) {
      const k = `${l.hsn}|${l.rate}|${l.uqc}`
      const r = m.get(k) ?? m.set(k, { hsn: l.hsn, rate: l.rate, uqc: l.uqc, qty: 0, ...zeroSum() }).get(k)!
      r.qty += s * l.qty
      addSum(r, l, s)
    }
  }
  return [...m.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate)
}

/**
 * GSTR-9 for the financial year starting `fyStart`: outward supplies by kind (table 4), those not
 * taxed (5), input tax credit as availed in GSTR-3B and reversed (6, 7), against what GSTR-2B
 * showed (8), the tax payable and how it was paid (9), and the HSN summaries (17, 18). Built from
 * the year's GSTR-1 and the twelve months' GSTR-3B.
 */
export async function gstr9(companyId: number, fyStart: string, registration = 0) {
  const company = await registrationOf(companyId, registration)
  const months = monthsOf(fyStart)
  const year = { from: months[0].from, to: months[11].to }
  const vouchers = await gstVouchers(companyId, year, registration)
  const r1 = gstr1(vouchers, await issued(companyId, year, registration), [])
  const t4 = {
    b2c: addSum(addSum(zeroSum(), r1.b2cs.reduce((t, x) => addSum(t, x), zeroSum())), r1.b2cl.reduce((t, x) => addSum(t, x), zeroSum())),
    b2b: r1.b2b.reduce((t, x) => addSum(t, x), zeroSum()),
    exportsWithTax: r1.exp.filter((x) => x.expType === 'WPAY').reduce((t, x) => addSum(t, x), zeroSum()),
    advances: zeroSum(),
    creditNotes: addSum(r1.cdnr.reduce((t, x) => addSum(t, x), zeroSum()), r1.cdnur.reduce((t, x) => addSum(t, x), zeroSum())),
    total: zeroSum(),
  }
  const paid = { payable: zero3(), byItc: zero3(), cash: zero3() }
  const itc = { inputs: zero3(), rcm: zero3(), reversed: zero3(), reclaimed: zero3() }
  const t5 = { exportsWithoutTax: r1.exp.filter((x) => x.expType === 'WOPAY').reduce((t, x) => t + x.taxable, 0), nilExempt: 0, nonGst: 0 }
  for (const m of months) {
    const mv = vouchers.filter((v) => v.date >= m.from && v.date <= m.to)
    const adv = await gstAdvances(companyId, m, registration)
    addSum(t4.advances, adv.totals.net)
    const r3 = gstr3b(mv, adv.totals.net)
    add3(paid.payable, r3.payable)
    for (const s of r3.setOff) paid.byItc[s.to] += s.amount
    add3(paid.cash, r3.cash)
    add3(itc.inputs, r3.itc)
    add3(itc.rcm, r3.itcRcm)
    add3(itc.reversed, r3.reversed)
    add3(itc.reclaimed, r3.reclaimed)
    t5.nilExempt += r3.nilExempt.taxable
    t5.nonGst += r3.nonGst.taxable
  }
  addSum(addSum(addSum(addSum(addSum(t4.total, t4.b2c), t4.b2b), t4.exportsWithTax), t4.advances), t4.creditNotes, -1)
  // table 8: the credit GSTR-2B showed for the year's months, as accepted in IMS
  const fps = months.map((m) => m.from.slice(0, 7))
  const b2b = (await pool.query<{ igst: number; cgst: number; sgst: number }>(
    `SELECT COALESCE(SUM(CASE WHEN doc_type = 'Credit Note' THEN -igst ELSE igst END), 0)::float8 igst, COALESCE(SUM(CASE WHEN doc_type = 'Credit Note' THEN -cgst ELSE cgst END), 0)::float8 cgst,
            COALESCE(SUM(CASE WHEN doc_type = 'Credit Note' THEN -sgst ELSE sgst END), 0)::float8 sgst
       FROM gst_portal_docs WHERE company_id = $1 AND source = '2B' AND month = ANY($2) AND NOT rcm AND ims_action <> 'Rejected' AND COALESCE(registration_id, 0) = $3`,
    [companyId, fps, registration],
  )).rows[0]
  const availed = add3(add3(zero3(), itc.inputs), itc.rcm)
  return {
    gstin: company.gstin, fyStart, from: year.from, to: year.to,
    t4, t5,
    t6: { ...itc, availed, net: add3(add3(add3(zero3(), availed), itc.reclaimed), itc.reversed, -1) },
    t8: { as2b: b2b, inputsAvailed: itc.inputs, difference: add3(add3(zero3(), b2b), itc.inputs, -1), uploaded2b: (await pool.query(
      `SELECT 1 FROM gst_portal_docs WHERE company_id = $1 AND source = '2B' AND month = ANY($2) AND COALESCE(registration_id, 0) = $3 LIMIT 1`, [companyId, fps, registration])).rowCount! > 0 },
    t9: paid,
    t17: [...[...r1.hsn.b2b, ...r1.hsn.b2c].reduce((m, h) => {
      const k = `${h.hsn}|${h.rate}|${h.uqc}`
      const r = m.get(k) ?? m.set(k, { hsn: h.hsn, rate: h.rate, uqc: h.uqc, qty: 0, ...zeroSum() }).get(k)!
      r.qty += h.qty
      addSum(r, h)
      return m
    }, new Map<string, { hsn: string; rate: number; uqc: string; qty: number } & TaxSum>()).values()],
    t18: inwardHsn(vouchers),
    attention: r1.attention.length,
  }
}

const quarters = (fyStart: string) => {
  const m = monthsOf(fyStart)
  return [0, 3, 6, 9].map((i) => ({ from: m[i].from, to: m[i + 2].to }))
}

/** CMP-08 for a quarter: a composition dealer's outward turnover (exempt supplies included) and the tax on it at the composition rate, and tax on inward supplies under reverse charge. */
export async function cmp08(companyId: number, fyStart: string, quarter: 1 | 2 | 3 | 4) {
  const company = (await getCompany(pool, companyId))!
  if (company.gstType !== 'Composition') throw new ValidationError(['CMP-08 is for a composition dealer: set the registration type (GST Reports → Registration)'])
  const q = quarters(fyStart)[quarter - 1]
  const vouchers = await gstVouchers(companyId, q)
  let turnover = 0
  const rcm = zero3()
  for (const v of vouchers) {
    const s = v.type === 'Credit Note' || v.type === 'Debit Note' ? -1 : 1
    if (v.gst.side === 'outward') turnover += s * v.gst.lines.reduce((t, l) => t + l.taxable, 0)
    if (v.gst.side === 'inward' && v.gst.rcm) add3(rcm, v.gst.rcm, s)
  }
  const tax = Math.round((turnover * company.compositionRate!) / 10000)
  const half = Math.round(tax / 2)
  const outward = { cgst: half, sgst: tax - half }
  return {
    gstin: company.gstin, fyStart, quarter, ...q, rate: company.compositionRate!, turnover, outward, rcm,
    payable: { igst: rcm.igst, cgst: outward.cgst + rcm.cgst, sgst: outward.sgst + rcm.sgst },
  }
}

/** GSTR-4, a composition dealer's annual return: inward supplies from registered and unregistered suppliers (4A-4C), the four CMP-08s (5) and outward supplies at the composition rate (6). */
export async function gstr4(companyId: number, fyStart: string) {
  const company = (await getCompany(pool, companyId))!
  if (company.gstType !== 'Composition') throw new ValidationError(['GSTR-4 is for a composition dealer: set the registration type (GST Reports → Registration)'])
  const year = { from: monthsOf(fyStart)[0].from, to: monthsOf(fyStart)[11].to }
  const vouchers = (await gstVouchers(companyId, year)).filter((v) => v.gst.side === 'inward')
  const bySupplier = new Map<string, { gstin: string; party: string | null; taxable: number; igst: number; cgst: number; sgst: number; rcm: boolean }>()
  const unregRcm = zeroSum()
  for (const v of vouchers) {
    const s = v.type === 'Debit Note' ? -1 : 1
    const taxable = v.gst.lines.reduce((t, l) => t + l.taxable, 0)
    if (!v.gst.gstin) {
      if (v.gst.rcm) addSum(unregRcm, v.gst.rcm, s)
      continue
    }
    const k = `${v.gst.gstin}|${!!v.gst.rcm}`
    const r = bySupplier.get(k) ?? bySupplier.set(k, { gstin: v.gst.gstin, party: v.gst.party, taxable: 0, ...zero3(), rcm: !!v.gst.rcm }).get(k)!
    r.taxable += s * taxable
    add3(r, v.gst.rcm ?? v.gst.charged, s)
  }
  const cmp = []
  for (const q of [1, 2, 3, 4] as const) cmp.push(await cmp08(companyId, fyStart, q))
  const turnover = cmp.reduce((t, c) => t + c.turnover, 0)
  return {
    gstin: company.gstin, fyStart, ...year, rate: company.compositionRate!,
    t4a: [...bySupplier.values()].filter((r) => !r.rcm), t4b: [...bySupplier.values()].filter((r) => r.rcm), t4c: unregRcm,
    t5: cmp.map((c) => ({ quarter: c.quarter, turnover: c.turnover, cgst: c.outward.cgst, sgst: c.outward.sgst, rcm: c.rcm })),
    t6: { rate: company.compositionRate!, turnover, cgst: cmp.reduce((t, c) => t + c.outward.cgst, 0), sgst: cmp.reduce((t, c) => t + c.outward.sgst, 0) },
  }
}

// ------------------------------------------------------------------ challans of GST paid

/** The CPIN (and once paid the CIN and date) of a payment of GST. */
export async function setGstChallans(companyId: number, items: { voucherId: number; challan: { cpin: string; cin: string | null; depositDate: string } | null }[]) {
  const errors: string[] = []
  for (const { voucherId, challan: c } of items) {
    if (!c) continue
    if (!/^[0-9]{14}$/.test(c.cpin)) errors.push(`Voucher ${voucherId}: a CPIN has 14 digits`)
    if (c.cin && !/^[0-9A-Z]{17,20}$/.test(c.cin)) errors.push(`Voucher ${voucherId}: a CIN has 17 to 20 letters and digits`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.depositDate)) errors.push(`Voucher ${voucherId}: give the date of deposit`)
  }
  if (errors.length) throw new ValidationError(errors)
  await withTx(async (tx) => {
    for (const { voucherId, challan: c } of items) {
      if (!(await tx.query(`SELECT 1 FROM vouchers WHERE id = $1 AND company_id = $2`, [voucherId, companyId])).rowCount) throw new ValidationError([`Unknown voucher ${voucherId}`])
      if (!c) await tx.query(`DELETE FROM gst_challans WHERE voucher_id = $1`, [voucherId])
      else
        await tx.query(
          `INSERT INTO gst_challans (voucher_id, cpin, cin, deposit_date) VALUES ($1,$2,$3,$4) ON CONFLICT (voucher_id) DO UPDATE SET cpin = $2, cin = $3, deposit_date = $4`,
          [voucherId, c.cpin, c.cin?.toUpperCase() || null, c.depositDate],
        )
    }
  })
}

/**
 * GST Challan Reconciliation: payments in the period that debit the GST tax ledgers, by tax, with
 * their challans; against what GSTR-3B says is to be paid in cash for the same period.
 */
export async function gstChallanReconciliation(companyId: number, p: { from: string; to: string }) {
  const { rows } = await pool.query<{ voucherId: number; docNo: string; date: string; taxType: string; amount: number; cpin: string | null; cin: string | null; depositDate: string | null }>(
    `SELECT v.id "voucherId", COALESCE(v.doc_no, v.number::text) "docNo", to_char(v.date, 'YYYY-MM-DD') date, l.gst_tax_type "taxType", e.amount::float8 amount,
            c.cpin, c.cin, to_char(c.deposit_date, 'YYYY-MM-DD') "depositDate"
       FROM vouchers v JOIN entries e ON e.voucher_id = v.id JOIN ledgers l ON l.id = e.ledger_id LEFT JOIN gst_challans c ON c.voucher_id = v.id
      WHERE v.company_id = $1 AND v.type = 'Payment' AND NOT v.cancelled AND v.date BETWEEN $2 AND $3 AND l.gst_tax_type IS NOT NULL AND e.amount > 0
      ORDER BY v.date, v.id`,
    [companyId, p.from, p.to],
  )
  const byVoucher = new Map<number, { voucherId: number; docNo: string; date: string; igst: number; cgst: number; sgst: number; cess: number; total: number
    challan: { cpin: string; cin: string | null; depositDate: string } | null }>()
  for (const r of rows) {
    const v = byVoucher.get(r.voucherId) ?? byVoucher.set(r.voucherId, { voucherId: r.voucherId, docNo: r.docNo, date: r.date, igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0,
      challan: r.cpin ? { cpin: r.cpin, cin: r.cin, depositDate: r.depositDate! } : null }).get(r.voucherId)!
    const k = r.taxType.toLowerCase() as 'igst' | 'cgst' | 'sgst' | 'cess'
    v[k] += r.amount
    v.total += r.amount
  }
  const payments = [...byVoucher.values()]
  const paid = { igst: payments.reduce((t, x) => t + x.igst, 0), cgst: payments.reduce((t, x) => t + x.cgst, 0), sgst: payments.reduce((t, x) => t + x.sgst, 0) }
  const company = (await getCompany(pool, companyId))!
  const cash = company.gstin ? gstr3b(await gstVouchers(companyId, p), (await gstAdvances(companyId, p)).totals.net).cash : zero3()
  return { payments, paid, due: cash, difference: add3(add3(zero3(), paid), cash, -1), withoutChallan: payments.filter((x) => !x.challan).length }
}

// ------------------------------------------------------------------ party GSTIN update

/** Every party with its GSTIN, state and PAN, for updating them together. */
export async function gstParties(companyId: number) {
  const groups = await loadGroups(pool, companyId)
  const { rows } = await pool.query<{ ledgerId: number; name: string; groupId: number; gstin: string | null; state: string | null; pan: string | null; country: string | null }>(
    `SELECT id "ledgerId", name, group_id "groupId", gstin, state, pan, country FROM ledgers WHERE company_id = $1 ORDER BY lower(name)`, [companyId],
  )
  return rows.filter((r) => isUnder(groups, r.groupId, ['Sundry Debtors', 'Sundry Creditors'])).map((r) => ({ ...r, group: groups.get(r.groupId)?.name ?? '' }))
}

/** Party GSTIN update: GSTIN and state (the state follows the GSTIN), and the PAN that is part of it; all or none are saved. */
export async function setGstParties(companyId: number, items: { ledgerId: number; gstin: string | null; state: string | null }[]) {
  const groups = await loadGroups(pool, companyId)
  const ledgers = new Map((await pool.query<{ id: number; name: string; groupId: number }>(
    `SELECT id, name, group_id "groupId" FROM ledgers WHERE company_id = $1 AND id = ANY($2)`, [companyId, items.map((i) => i.ledgerId)],
  )).rows.map((l) => [l.id, l]))
  const errors: string[] = []
  const rows = items.map((i) => {
    const l = ledgers.get(i.ledgerId)
    if (!l) {
      errors.push(`Unknown ledger ${i.ledgerId}`)
      return null
    }
    if (!isUnder(groups, l.groupId, ['Sundry Debtors', 'Sundry Creditors'])) errors.push(`${l.name} is not a party`)
    const gstin = i.gstin?.trim().toUpperCase() || null
    const bad = gstin ? gstinError(gstin) : null
    if (bad) errors.push(`${l.name}: ${bad}`)
    if (i.state?.trim() && !stateCode(i.state)) errors.push(`${l.name}: "${i.state}" is not a GST state`)
    const code = gstin && !bad ? gstin.slice(0, 2) : stateCode(i.state)
    if (gstin && !bad && i.state?.trim() && stateCode(i.state) !== gstin.slice(0, 2)) errors.push(`${l.name}: the GSTIN is registered in ${stateName(gstin.slice(0, 2))}`)
    return { id: l.id, gstin, state: code ? (stateName(code) ?? null) : null, pan: gstin && !bad ? gstin.slice(2, 12) : null }
  })
  if (errors.length) throw new ValidationError(errors)
  await withTx(async (tx) => {
    for (const r of rows) await tx.query(`UPDATE ledgers SET gstin = $2, state = $3, pan = COALESCE($4, pan) WHERE id = $1`, [r!.id, r!.gstin, r!.state, r!.pan])
  })
}
