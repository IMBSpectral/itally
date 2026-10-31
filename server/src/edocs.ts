/**
 * e-Invoice and e-Way Bill for vouchers: the document as the portals want it, built from the
 * voucher, the company's and the party's mailing details and the stored GST breakup; and what the
 * portals gave back (IRN, e-Way Bill number) once the JSON has been uploaded.
 */
import { pool } from './db'
import { getCompany, getVoucher, gstContext, ValidationError } from './books'
import { partyOf, stateCode, taxableLines, taxOn, type GstBreakup } from './engine/gst'
import { uqcOf } from './engine/gst-returns'
import { EWB_LIMIT, einvoiceProblems, ewayProblems, readSignedQr, type EdocInput, type EdocParty, type Transport } from './engine/edocs'
import type { VoucherInput } from './engine/voucher'

/** Vouchers an e-Invoice can be raised for, and those that can carry goods on an e-Way Bill. */
export const EINVOICE_TYPES = ['Sales', 'Credit Note', 'Debit Note'] as const
export const EWAY_TYPES = ['Sales', 'Purchase', 'Credit Note', 'Debit Note'] as const

export interface EDocRecord {
  irn: string | null
  ackNo: string | null
  ackDate: string | null
  signedQr: string | null
  irnCancelled: boolean
  ewbNo: string | null
  ewbDate: string | null
  ewbValidUpto: string | null
  transport: Transport | null
}

const RECORD = `irn, ack_no "ackNo", ack_date "ackDate", signed_qr "signedQr", irn_cancelled "irnCancelled",
                ewb_no "ewbNo", ewb_date "ewbDate", ewb_valid_upto "ewbValidUpto", transport`

export async function eDocRecord(voucherId: number): Promise<EDocRecord | null> {
  return (await pool.query<EDocRecord>(`SELECT ${RECORD} FROM e_documents WHERE voucher_id = $1`, [voucherId])).rows[0] ?? null
}

/** The voucher as an e-document: who issues it to whom, its lines with tax, and the stored transport details. */
export async function edocInput(companyId: number, voucherId: number): Promise<{ input: EdocInput; record: EDocRecord | null }> {
  const v = await getVoucher(pool, companyId, voucherId)
  if (!v) throw new ValidationError([`Unknown voucher ${voucherId}`])
  if (![...EWAY_TYPES].includes(v.type)) throw new ValidationError([`A ${v.type} voucher has no e-Invoice or e-Way Bill`])
  if (v.cancelled) throw new ValidationError(['The voucher is cancelled'])
  const c = (await getCompany(pool, companyId))!
  const breakup = (await pool.query<{ gst: GstBreakup | null }>(`SELECT gst FROM vouchers WHERE id = $1`, [voucherId])).rows[0].gst
  if (!c.gstin || !breakup) throw new ValidationError(['GST does not apply to this voucher (set the company GSTIN, and give the items or ledgers their GST details)'])
  const ctx = await gstContext(pool, companyId, c)
  const input = v as VoucherInput
  const partyLine = v.partyId ? { ledgerId: v.partyId as number, amount: 0 } : partyOf(input, ctx.ledgers)
  const party = (await pool.query<{ name: string; mailingName: string | null; address: string | null; pincode: string | null; phone: string | null
    email: string | null; country: string | null; gstin: string | null; state: string | null }>(
    `SELECT name, mailing_name "mailingName", address, pincode, phone, email, country, gstin, state FROM ledgers WHERE id = $1`,
    [partyLine?.ledgerId],
  )).rows[0]
  if (!party) throw new ValidationError(['The voucher has no party'])

  const company: EdocParty = {
    gstin: c.gstin, legalName: c.mailingName ?? c.name, address: c.address ?? '', pincode: c.pincode ?? '',
    stateCode: stateCode(c.state) ?? c.gstin.slice(0, 2), phone: c.phone, email: c.email,
  }
  const counterparty: EdocParty = {
    gstin: party.gstin, legalName: party.mailingName ?? party.name, address: party.address ?? '', pincode: party.pincode ?? '',
    stateCode: breakup.pos === '96' ? '96' : (stateCode(party.state) ?? party.gstin?.slice(0, 2) ?? breakup.pos),
    phone: party.phone, email: party.email, country: party.country,
  }
  const wopay = breakup.export === 'WOPAY'
  const lines = taxableLines(input, ctx, partyLine?.ledgerId ?? -1)
    .filter((l) => !l.rcm)
    .map((l) => {
      const item = l.what.startsWith('item ') ? ctx.items.get(Number(l.what.slice(5))) : undefined
      const rate = l.rate ?? 0
      return {
        description: item?.name ?? l.what,
        isService: !item && l.hsn.startsWith('99'),
        hsn: l.hsn.replace(/\s/g, ''),
        qty: l.qty,
        uqc: item ? uqcOf(l.uqc) : 'OTH',
        taxable: l.taxable,
        rate,
        ...(wopay ? { igst: 0, cgst: 0, sgst: 0 } : taxOn(l.taxable, rate, breakup.interstate)),
      }
    })
  const record = await eDocRecord(voucherId)
  const purchase = v.type === 'Purchase'
  return {
    input: {
      type: v.type,
      number: v.docNo,
      date: v.date,
      seller: purchase ? counterparty : company,
      buyer: purchase ? company : counterparty,
      pos: breakup.pos,
      interstate: breakup.interstate,
      export: breakup.export,
      ...(breakup.shippingBill ? { shippingBill: breakup.shippingBill } : {}),
      lines,
      invoiceValue: breakup.invoiceValue,
      transport: record?.transport ?? null,
    },
    record,
  }
}

/** What the screens show for one voucher: whether each document is due, possible, or done. */
export function edocStatus(input: EdocInput, record: EDocRecord | null) {
  const einvoice = (EINVOICE_TYPES as readonly string[]).includes(input.type) ? einvoiceProblems(input) : ['Only sales, credit notes and debit notes carry an e-Invoice']
  const eway = ewayProblems(input)
  const goods = input.lines.filter((l) => !l.isService).reduce((t, l) => t + l.taxable + l.igst + l.cgst + l.sgst, 0)
  return {
    einvoice: { needed: !!input.export || (!!input.buyer.gstin && input.seller.gstin !== null && input.type !== 'Purchase'), problems: einvoice,
      irn: record?.irn ?? null, cancelled: record?.irnCancelled ?? false },
    eway: { needed: goods > EWB_LIMIT, problems: eway, ewbNo: record?.ewbNo ?? null },
  }
}

export interface EDocUpdate {
  transport?: Transport | null
  irn?: string | null
  ackNo?: string | null
  ackDate?: string | null
  signedQr?: string | null
  irnCancelled?: boolean
  ewbNo?: string | null
  ewbDate?: string | null
  ewbValidUpto?: string | null
}

/**
 * Store what the portals gave back, or the transport details. A signed QR code carries the IRN:
 * pasted alone, the IRN is read from it; pasted with one, they must agree.
 */
export async function saveEDocument(companyId: number, voucherId: number, u: EDocUpdate) {
  const { input, record } = await edocInput(companyId, voucherId)
  const next: EDocRecord = { ...(record ?? { irn: null, ackNo: null, ackDate: null, signedQr: null, irnCancelled: false, ewbNo: null, ewbDate: null, ewbValidUpto: null, transport: null }) }
  for (const k of Object.keys(u) as (keyof EDocUpdate)[]) {
    const val = u[k]
    ;(next as unknown as Record<string, unknown>)[k] = typeof val === 'string' ? val.trim() || null : (val ?? null)
  }
  if (next.irnCancelled === null) next.irnCancelled = false
  const errors: string[] = []
  if (next.signedQr) {
    const qr = readSignedQr(next.signedQr)
    if (!qr) errors.push('The signed QR code is not one the IRP issues (a signed token in three dot-separated parts)')
    else {
      if (!next.irn && qr.irn) next.irn = qr.irn
      if (qr.irn && next.irn !== qr.irn) errors.push('The signed QR code is for another IRN')
      if (qr.docNo && qr.docNo !== input.number) errors.push(`The signed QR code is for document ${qr.docNo}, not ${input.number}`)
    }
  }
  if (next.irn) next.irn = next.irn.toLowerCase()
  if (next.irn && !/^[0-9a-f]{64}$/.test(next.irn)) errors.push('An IRN is 64 hexadecimal characters')
  if (next.ewbNo && !/^[0-9]{12}$/.test(next.ewbNo)) errors.push('An e-Way Bill number is 12 digits')
  if (next.irnCancelled && !next.irn) errors.push('There is no IRN to cancel')
  if (next.transport) {
    const t = next.transport
    if (!['1', '2', '3', '4'].includes(t.mode)) errors.push('Choose the mode of transport')
    if (t.vehicleNo) t.vehicleNo = t.vehicleNo.replace(/[\s-]/g, '').toUpperCase()
    if (t.transporterId) t.transporterId = t.transporterId.trim().toUpperCase()
  }
  if (errors.length) throw new ValidationError(errors)
  await pool.query(
    `INSERT INTO e_documents (voucher_id, irn, ack_no, ack_date, signed_qr, irn_cancelled, ewb_no, ewb_date, ewb_valid_upto, transport, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     ON CONFLICT (voucher_id) DO UPDATE SET irn = $2, ack_no = $3, ack_date = $4, signed_qr = $5, irn_cancelled = $6, ewb_no = $7, ewb_date = $8,
       ewb_valid_upto = $9, transport = $10, updated_at = now()`,
    [voucherId, next.irn, next.ackNo, next.ackDate, next.signedQr, next.irnCancelled, next.ewbNo, next.ewbDate, next.ewbValidUpto,
      next.transport ? JSON.stringify(next.transport) : null],
  )
  return next
}

/** Every voucher in the period that could carry an e-Invoice or an e-Way Bill, with its state. */
export async function eDocRegister(companyId: number, p: { from: string; to: string }) {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT v.id FROM vouchers v WHERE v.company_id = $1 AND v.date BETWEEN $2 AND $3 AND NOT v.cancelled AND v.gst IS NOT NULL
        AND v.type = ANY($4) AND (v.gst ->> 'side') IN ('outward', 'inward') ORDER BY v.date, v.id`,
    [companyId, p.from, p.to, [...EWAY_TYPES]],
  )
  const out = []
  for (const r of rows) {
    const { input, record } = await edocInput(companyId, r.id)
    out.push({
      voucherId: r.id, type: input.type, number: input.number, date: input.date,
      party: input.type === 'Purchase' ? input.seller.legalName : input.buyer.legalName,
      value: input.invoiceValue, ...edocStatus(input, record),
    })
  }
  return out
}
