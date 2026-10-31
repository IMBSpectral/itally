/**
 * e-Invoice (IRP schema 1.1) and e-Way Bill (bulk-upload JSON) for one voucher, and the checks
 * the portals would otherwise reject the document for. Amounts come in as paise and quantities as
 * thousandths; the JSON carries rupees and units as plain numbers, dates as dd/mm/yyyy.
 */
import type { Paise } from './money'
import { stateName } from './gst'

export interface EdocParty {
  gstin: string | null // null: unregistered (URP)
  legalName: string
  address: string // lines separated by \n
  pincode: string
  stateCode: string // two digits; 96 = other countries
  phone?: string | null
  email?: string | null
  country?: string | null
}

export interface EdocLine {
  description: string
  isService: boolean
  hsn: string
  qty: number // thousandths; 0 for a service with no quantity
  uqc: string
  taxable: Paise
  rate: number // hundredths of a percent
  igst: Paise
  cgst: Paise
  sgst: Paise
  cess?: Paise
  cessRate?: number // hundredths of a percent
}

export interface Transport {
  mode: '1' | '2' | '3' | '4' // road, rail, air, ship
  distance: number // km; 0 lets the portal work it out from the PIN codes
  transporterId?: string | null // GSTIN or TRANSIN of the transporter
  transporterName?: string | null
  vehicleNo?: string | null
  vehicleType?: 'R' | 'O' // regular, over-dimensional cargo
  docNo?: string | null // LR / RR / airway bill / bill of lading
  docDate?: string | null // YYYY-MM-DD
}

export interface EdocInput {
  type: 'Sales' | 'Credit Note' | 'Debit Note' | 'Purchase'
  number: string
  date: string // YYYY-MM-DD
  seller: EdocParty // who issues the document: the company, or for a purchase the supplier
  buyer: EdocParty // who it is issued to
  pos: string // place of supply
  interstate: boolean
  export?: 'WPAY' | 'WOPAY'
  shippingBill?: { port: string; no: string; date: string }
  lines: EdocLine[]
  invoiceValue: Paise // what the party owes: the value of the document as booked
  transport?: Transport | null
}

const rupees = (p: Paise) => Math.round(p) / 100
const qtyOf = (q: number) => q / 1000
const pct = (r: number) => r / 100
const ddmmyyyy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`
const sum = (ls: EdocLine[], k: 'taxable' | 'igst' | 'cgst' | 'sgst') => ls.reduce((t, l) => t + l[k], 0)

/** Address split the way both schemas want it: two address lines and a place (the last line, else the state). */
function addressOf(p: EdocParty) {
  const lines = p.address.split('\n').map((x) => x.trim()).filter(Boolean)
  const place = lines.length > 1 ? lines[lines.length - 1] : (stateName(p.stateCode) ?? p.country ?? '')
  const body = lines.length > 1 ? lines.slice(0, -1) : lines
  return { addr1: (body[0] ?? '').slice(0, 100), addr2: body.slice(1).join(', ').slice(0, 100) || undefined, place: place.slice(0, 50) }
}

const DOC_NO = /^[A-Za-z1-9][A-Za-z0-9/-]{0,15}$/
const GSTIN = /^[0-9]{2}[0-9A-Z]{13}$/
const VEHICLE = /^[A-Z]{2}[0-9A-Z]{1,3}[0-9A-Z]{0,3}[0-9]{4}$/

function partyProblems(who: string, p: EdocParty, overseas = false) {
  const out: string[] = []
  if (p.legalName.trim().length < 3) out.push(`${who}: the name needs at least 3 characters`)
  const a = addressOf(p)
  if (a.addr1.length < 1) out.push(`${who}: no address (set the mailing details)`)
  if (a.place.length < 3) out.push(`${who}: the place (last address line) needs at least 3 characters`)
  if (!overseas && !/^[1-9][0-9]{5}$/.test(p.pincode)) out.push(`${who}: the PIN code must be six digits`)
  if (p.gstin && !GSTIN.test(p.gstin)) out.push(`${who}: "${p.gstin}" is not a GSTIN`)
  return out
}

/** The document type both portals use: a tax invoice, a credit note or a debit note. */
const docType = (t: EdocInput['type']) => (t === 'Credit Note' ? 'CRN' : t === 'Debit Note' ? 'DBN' : 'INV')

/** Why the IRP would refuse this e-Invoice; empty when it can be uploaded. */
export function einvoiceProblems(x: EdocInput): string[] {
  const out: string[] = []
  if (x.type === 'Purchase') out.push('An e-Invoice is raised by the seller: a purchase has none')
  if (!x.seller.gstin) out.push('Set the company GSTIN first')
  if (!x.export && !x.buyer.gstin) out.push('The buyer has no GSTIN: invoices to unregistered buyers need no e-Invoice (B2C)')
  if (!DOC_NO.test(x.number)) out.push(`Document number "${x.number}" must be 1 to 16 letters, digits, / or -, not starting with 0`)
  out.push(...partyProblems('Seller', x.seller), ...partyProblems('Buyer', x.buyer, !!x.export))
  if (!x.lines.length) out.push('The document has no taxable lines')
  for (const l of x.lines) {
    if (!/^[0-9]{4}([0-9]{2})?([0-9]{2})?$/.test(l.hsn)) out.push(`"${l.description}": HSN/SAC must be 4, 6 or 8 digits`)
    if (!l.description.trim()) out.push('A line has no description')
  }
  return out
}

/** The e-Invoice as the IRP takes it (schema 1.1), for upload on the portal or through a GSP. */
export function einvoiceJson(x: EdocInput) {
  const seller = addressOf(x.seller)
  const buyer = addressOf(x.buyer)
  const items = x.lines.map((l, i) => ({
    SlNo: String(i + 1),
    PrdDesc: l.description.slice(0, 300),
    IsServc: l.isService ? 'Y' : 'N',
    HsnCd: l.hsn,
    ...(l.qty ? { Qty: qtyOf(l.qty), Unit: l.uqc, UnitPrice: Math.round((l.taxable * 1000) / l.qty) / 100 } : { UnitPrice: rupees(l.taxable) }),
    TotAmt: rupees(l.taxable),
    AssAmt: rupees(l.taxable),
    GstRt: pct(l.rate),
    IgstAmt: rupees(l.igst),
    CgstAmt: rupees(l.cgst),
    SgstAmt: rupees(l.sgst),
    ...(l.cess ? { CesRt: pct(l.cessRate ?? 0), CesAmt: rupees(l.cess) } : {}),
    TotItemVal: rupees(l.taxable + l.igst + l.cgst + l.sgst + (l.cess ?? 0)),
  }))
  const taxable = sum(x.lines, 'taxable')
  const igst = sum(x.lines, 'igst')
  const cgst = sum(x.lines, 'cgst')
  const sgst = sum(x.lines, 'sgst')
  const cess = x.lines.reduce((s, l) => s + (l.cess ?? 0), 0)
  const supTyp = x.export ? (x.export === 'WPAY' ? 'EXPWP' : 'EXPWOP') : 'B2B'
  return {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: supTyp, RegRev: 'N', IgstOnIntra: x.interstate || !igst ? 'N' : 'Y' },
    DocDtls: { Typ: docType(x.type), No: x.number, Dt: ddmmyyyy(x.date) },
    SellerDtls: {
      Gstin: x.seller.gstin, LglNm: x.seller.legalName, Addr1: seller.addr1, ...(seller.addr2 ? { Addr2: seller.addr2 } : {}), Loc: seller.place,
      Pin: Number(x.seller.pincode), Stcd: x.seller.stateCode, ...(x.seller.phone ? { Ph: x.seller.phone.replace(/\D/g, '').slice(-12) } : {}),
      ...(x.seller.email ? { Em: x.seller.email } : {}),
    },
    BuyerDtls: {
      Gstin: x.export ? 'URP' : x.buyer.gstin, LglNm: x.buyer.legalName, Pos: x.pos, Addr1: buyer.addr1, ...(buyer.addr2 ? { Addr2: buyer.addr2 } : {}),
      Loc: buyer.place, Pin: x.export ? 999999 : Number(x.buyer.pincode), Stcd: x.export ? '96' : x.buyer.stateCode,
      ...(x.buyer.phone ? { Ph: x.buyer.phone.replace(/\D/g, '').slice(-12) } : {}), ...(x.buyer.email ? { Em: x.buyer.email } : {}),
    },
    ItemList: items,
    ValDtls: {
      AssVal: rupees(taxable), IgstVal: rupees(igst), CgstVal: rupees(cgst), SgstVal: rupees(sgst), ...(cess ? { CesVal: rupees(cess) } : {}),
      // whatever else is on the bill (rounding off, a non-GST charge) closes the gap to the booked value
      RndOffAmt: rupees(x.invoiceValue - taxable - igst - cgst - sgst - cess),
      TotInvVal: rupees(x.invoiceValue),
    },
    ...(x.export
      ? {
          ExpDtls: {
            ...(x.shippingBill ? { ShipBNo: x.shippingBill.no, ShipBDt: ddmmyyyy(x.shippingBill.date), Port: x.shippingBill.port } : {}),
            ...(countryCode(x.buyer.country) ? { CntCode: countryCode(x.buyer.country) } : {}),
          },
        }
      : {}),
    ...(x.transport && !x.export ? { EwbDtls: ewbPartB(x.transport) } : {}),
  }
}

const ewbPartB = (t: Transport) => ({
  ...(t.transporterId ? { TransId: t.transporterId } : {}),
  ...(t.transporterName ? { TransName: t.transporterName } : {}),
  TransMode: t.mode,
  Distance: t.distance,
  ...(t.docNo ? { TransDocNo: t.docNo } : {}),
  ...(t.docDate ? { TransDocDt: ddmmyyyy(t.docDate) } : {}),
  ...(t.vehicleNo ? { VehNo: t.vehicleNo, VehType: t.vehicleType ?? 'R' } : {}),
})

/** An e-Way Bill is needed for goods worth more than this (₹50,000), the general limit. */
export const EWB_LIMIT: Paise = 5_000_000

/** Why the e-Way Bill portal would refuse this document; empty when it can be uploaded. */
export function ewayProblems(x: EdocInput): string[] {
  const out: string[] = []
  const goods = x.lines.filter((l) => !l.isService)
  if (!goods.length) out.push('An e-Way Bill is for goods: this document moves none')
  if (!DOC_NO.test(x.number)) out.push(`Document number "${x.number}" must be 1 to 16 letters, digits, / or -, not starting with 0`)
  const { from, to } = route(x)
  out.push(...partyProblems('From', from, from === x.buyer && !!x.export), ...partyProblems('To', to, to === x.buyer && !!x.export))
  for (const l of goods) if (!/^[0-9]{4,8}$/.test(l.hsn)) out.push(`"${l.description}": HSN must be 4 to 8 digits`)
  const t = x.transport
  if (!t) out.push('Enter the transport details (mode, distance, and the vehicle number or transporter)')
  else {
    if (!Number.isInteger(t.distance) || t.distance < 0 || t.distance > 4000) out.push('The distance must be whole kilometres from 0 to 4000')
    if (t.vehicleNo && !VEHICLE.test(t.vehicleNo)) out.push(`"${t.vehicleNo}" is not a vehicle number (for example KA01AB1234)`)
    if (t.mode === '1' && !t.vehicleNo && !t.transporterId) out.push('By road, give the vehicle number or the transporter ID')
    if (t.mode !== '1' && !t.docNo) out.push('By rail, air or ship, give the transport document number')
    if (t.transporterId && !GSTIN.test(t.transporterId)) out.push(`"${t.transporterId}" is not a transporter ID (GSTIN or TRANSIN)`)
  }
  return out
}

/** One e-Way Bill as the portal's bulk-upload JSON takes it (the `billLists` entry). */
export function ewayBill(x: EdocInput) {
  const inward = x.type === 'Purchase'
  const { from, to } = route(x)
  const overseasTo = to === x.buyer && !!x.export
  const a = addressOf(from)
  const b = addressOf(to)
  const goods = x.lines.filter((l) => !l.isService)
  const t = x.transport
  return {
    userGstin: inward ? x.buyer.gstin : x.seller.gstin, // the company's
    supplyType: inward || x.type === 'Credit Note' ? 'I' : 'O',
    // 1 supply, 3 export, 7 sales return, 8 others (a purchase return, described)
    subSupplyType: x.type === 'Credit Note' ? 7 : x.type === 'Debit Note' ? 8 : x.export ? 3 : 1,
    ...(x.type === 'Debit Note' ? { subSupplyDesc: 'Purchase return' } : {}),
    docType: docType(x.type) === 'INV' ? 'INV' : 'OTH', // a note travels as "others"
    docNo: x.number,
    docDate: ddmmyyyy(x.date),
    fromGstin: from.gstin ?? 'URP', fromTrdName: from.legalName, fromAddr1: a.addr1, fromAddr2: a.addr2 ?? '', fromPlace: a.place,
    fromPincode: Number(from.pincode), actFromStateCode: Number(from.stateCode), fromStateCode: Number(from.stateCode),
    toGstin: overseasTo ? 'URP' : (to.gstin ?? 'URP'), toTrdName: to.legalName, toAddr1: b.addr1, toAddr2: b.addr2 ?? '', toPlace: b.place,
    toPincode: overseasTo ? 999999 : Number(to.pincode), actToStateCode: overseasTo ? 96 : Number(to.stateCode), toStateCode: overseasTo ? 96 : Number(to.stateCode),
    transactionType: 1, // regular
    totalValue: rupees(sum(goods, 'taxable')),
    cgstValue: rupees(sum(goods, 'cgst')),
    sgstValue: rupees(sum(goods, 'sgst')),
    igstValue: rupees(sum(goods, 'igst')),
    cessValue: rupees(goods.reduce((s, l) => s + (l.cess ?? 0), 0)),
    cessNonAdvolValue: 0,
    otherValue: rupees(x.invoiceValue - x.lines.reduce((s, l) => s + l.taxable + l.igst + l.cgst + l.sgst + (l.cess ?? 0), 0)),
    totInvValue: rupees(x.invoiceValue),
    transMode: Number(t?.mode ?? 1),
    transDistance: String(t?.distance ?? 0),
    transporterId: t?.transporterId ?? '',
    transporterName: t?.transporterName ?? '',
    transDocNo: t?.docNo ?? '',
    transDocDate: t?.docDate ? ddmmyyyy(t.docDate) : '',
    vehicleNo: t?.vehicleNo ?? '',
    vehicleType: t?.vehicleType ?? 'R',
    itemList: goods.map((l, i) => ({
      itemNo: i + 1,
      productName: l.description.slice(0, 100),
      productDesc: l.description.slice(0, 100),
      hsnCode: Number(l.hsn),
      quantity: qtyOf(l.qty),
      qtyUnit: l.uqc,
      taxableAmount: rupees(l.taxable),
      sgstRate: x.interstate ? 0 : pct(l.rate) / 2,
      cgstRate: x.interstate ? 0 : pct(l.rate) / 2,
      igstRate: x.interstate ? pct(l.rate) : 0,
      cessRate: pct(l.cessRate ?? 0),
      cessNonAdvol: 0,
    })),
  }
}

/** Which way the goods go: a credit note brings them back from the customer, a purchase from the supplier. */
function route(x: EdocInput) {
  const back = x.type === 'Credit Note'
  return back ? { from: x.buyer, to: x.seller } : { from: x.seller, to: x.buyer }
}

/** The e-Way Bill portal's bulk-upload file for several bills. */
export const ewayBillFile = (bills: ReturnType<typeof ewayBill>[]) => ({ version: '1.0.0621', billLists: bills })

/** ISO 3166 codes for the countries Indian exports most often go to (the e-Invoice CntCode). */
const COUNTRIES: Record<string, string> = {
  'united states': 'US', usa: 'US', 'united states of america': 'US', 'united kingdom': 'GB', uk: 'GB', 'united arab emirates': 'AE', uae: 'AE',
  china: 'CN', bangladesh: 'BD', nepal: 'NP', 'sri lanka': 'LK', singapore: 'SG', germany: 'DE', netherlands: 'NL', france: 'FR', italy: 'IT',
  belgium: 'BE', spain: 'ES', japan: 'JP', 'south korea': 'KR', 'saudi arabia': 'SA', australia: 'AU', canada: 'CA', malaysia: 'MY',
  indonesia: 'ID', vietnam: 'VN', thailand: 'TH', 'hong kong': 'HK', 'south africa': 'ZA', kenya: 'KE', nigeria: 'NG', egypt: 'EG',
  turkey: 'TR', israel: 'IL', brazil: 'BR', mexico: 'MX', russia: 'RU', qatar: 'QA', oman: 'OM', kuwait: 'KW', bahrain: 'BH',
}
export const countryCode = (c?: string | null) => (c ? COUNTRIES[c.trim().toLowerCase()] : undefined)

/** The parts of the IRP's answer a printed invoice shows: from a signed QR code's payload (a JWT). */
export function readSignedQr(jwt: string): { irn?: string; docNo?: string; docDate?: string; value?: number } | null {
  const part = jwt.split('.')[1]
  if (!part) return null
  try {
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    const data = typeof json.data === 'string' ? JSON.parse(json.data) : json
    return { irn: data.Irn, docNo: data.DocNo, docDate: data.DocDt, value: data.TotInvVal }
  } catch {
    return null
  }
}
