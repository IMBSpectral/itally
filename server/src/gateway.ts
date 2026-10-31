/**
 * Payment gateway reconciliation: a gateway's settlement report (Razorpay, PayU, Paytm, Stripe:
 * any CSV or Excel export with a row per payment) is kept per payment, matched to the receipts in
 * the books on the gateway's ledger (by the payment id in the narration, else by amount within
 * three days), and each settlement can be posted as one Receipt: the net into the bank, the fee
 * and the GST on it as expenses, the gross off the gateway ledger.
 */
import { pool, withTx } from './db'
import { postVoucher, ValidationError } from './books'
import { dateOf, readSheet, type Cell } from './sheet'
import { toPaise } from './engine/money'

type Period = { from: string; to: string }
const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const COLUMNS: Record<string, string[]> = {
  paymentId: ['paymentid', 'id', 'entityid', 'transactionid', 'txnid', 'mihpayid', 'chargeid'],
  date: ['date', 'createdat', 'paymentdate', 'transactiondate', 'addedon', 'created'],
  amount: ['amount', 'grossamount', 'paymentamount', 'credit', 'gross'],
  fee: ['fee', 'fees', 'gatewayfee', 'commission', 'mdr', 'servicecharge'],
  tax: ['tax', 'gst', 'taxonfee', 'gstonfee', 'servicetax', 'feetax'],
  settlementId: ['settlementid', 'settlementutr', 'utr', 'payoutid', 'transferid'],
  settledOn: ['settledat', 'settlementdate', 'settledon', 'payoutdate', 'availableon'],
  reference: ['description', 'notes', 'orderid', 'reference', 'invoice', 'invoiceid', 'udf1'],
}

const rupees = (x: Cell) => {
  if (x === null || x === '') return 0
  if (typeof x === 'number') return Math.round(x * 100)
  return toPaise(String(x).replace(/[,₹\s]/g, '') || '0')
}

/** Keeps a settlement report's payments (a payment seen again is updated, a settlement already posted stays posted). */
export async function importGatewayReport(companyId: number, gateway: string, file: Buffer) {
  if (!gateway.trim()) throw new ValidationError(['Name the gateway (Razorpay, PayU …)'])
  const rows = readSheet(file)
  const headAt = rows.findIndex((r) => r.some((c) => c !== null && String(c).trim()))
  const head = (rows[headAt] ?? []).map(norm)
  const col: Record<string, number> = {}
  for (const [f, names] of Object.entries(COLUMNS)) {
    const i = head.findIndex((h) => names.includes(h))
    if (i >= 0) col[f] = i
  }
  const missing = ['paymentId', 'date', 'amount'].filter((f) => !(f in col))
  if (missing.length) throw new ValidationError([`The report needs columns for the payment id, its date and amount; missing: ${missing.join(', ')}`])
  const get = (r: Cell[], f: string) => (f in col ? (r[col[f]] ?? null) : null)
  const failed: { row: number; errors: string[] }[] = []
  let kept = 0
  await withTx(async (tx) => {
    for (const [i, r] of rows.slice(headAt + 1).entries()) {
      if (!r.some((c) => c !== null && String(c).trim())) continue
      const row = headAt + i + 2
      const id = String(get(r, 'paymentId') ?? '').trim()
      const date = dateOf(typeof get(r, 'date') === 'string' ? String(get(r, 'date')).slice(0, 10) : get(r, 'date'))
      if (!id || !date) {
        failed.push({ row, errors: [!id ? 'no payment id' : `"${get(r, 'date')}" is not a date`] })
        continue
      }
      try {
        const settled = get(r, 'settledOn')
        await tx.query(
          `INSERT INTO gateway_payments (company_id, gateway, payment_id, date, amount, fee, tax, settlement_id, settled_on, reference)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (company_id, lower(gateway), payment_id) DO UPDATE SET date = $4, amount = $5, fee = $6, tax = $7, settlement_id = $8, settled_on = $9, reference = $10`,
          [companyId, gateway.trim(), id, date, rupees(get(r, 'amount')), rupees(get(r, 'fee')), rupees(get(r, 'tax')), String(get(r, 'settlementId') ?? '').trim() || null,
            settled === null ? null : dateOf(typeof settled === 'string' ? settled.slice(0, 10) : settled), String(get(r, 'reference') ?? '').trim() || null],
        )
        kept++
      } catch (e) {
        failed.push({ row, errors: [e instanceof ValidationError ? e.errors.join('; ') : String((e as Error).message)] })
      }
    }
  })
  return { kept, failed }
}

/**
 * The period's payments of a gateway against the receipts on its ledger: each payment matched
 * (by its id in the receipt's narration, else the same amount within three days) or not in the
 * books; the receipts no payment explains; and the settlements with what they paid out.
 */
export async function gatewayReconciliation(companyId: number, gateway: string, ledgerId: number, p: Period) {
  const payments = (await pool.query<{ id: number; paymentId: string; date: string; amount: number; fee: number; tax: number; settlementId: string | null; settledOn: string | null
    reference: string | null; postedVoucherId: number | null }>(
    `SELECT id, payment_id "paymentId", to_char(date, 'YYYY-MM-DD') date, amount::float8 amount, fee::float8 fee, tax::float8 tax, settlement_id "settlementId",
            to_char(settled_on, 'YYYY-MM-DD') "settledOn", reference, posted_voucher_id "postedVoucherId"
       FROM gateway_payments WHERE company_id = $1 AND lower(gateway) = lower($2) AND date BETWEEN $3 AND $4 ORDER BY date, id`,
    [companyId, gateway, p.from, p.to],
  )).rows
  const receipts = (await pool.query<{ voucherId: number; docNo: string; date: string; amount: number; narration: string; party: string | null }>(
    `SELECT v.id "voucherId", COALESCE(v.doc_no, v.number::text) "docNo", to_char(v.date, 'YYYY-MM-DD') date, e.amount::float8 amount, v.narration,
            (SELECT l.name FROM entries o JOIN ledgers l ON l.id = o.ledger_id WHERE o.voucher_id = v.id AND o.amount < 0 ORDER BY o.line LIMIT 1) party
       FROM vouchers v JOIN entries e ON e.voucher_id = v.id
      WHERE v.company_id = $1 AND e.ledger_id = $2 AND e.amount > 0 AND NOT v.cancelled AND v.date BETWEEN $3::date - 3 AND $4::date + 3
        AND NOT EXISTS (SELECT 1 FROM gateway_payments g WHERE g.posted_voucher_id = v.id)
      ORDER BY v.date, v.id`,
    [companyId, ledgerId, p.from, p.to],
  )).rows
  const used = new Set<number>()
  const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000
  const rows = payments.map((pay) => {
    const byId = receipts.find((r) => !used.has(r.voucherId) && r.narration.toLowerCase().includes(pay.paymentId.toLowerCase()))
    const byAmount = byId ?? receipts.find((r) => !used.has(r.voucherId) && r.amount === pay.amount && days(r.date, pay.date) <= 3)
    if (byAmount) used.add(byAmount.voucherId)
    return { ...pay, status: byAmount ? (byAmount.amount === pay.amount ? 'Matched' : 'Amount differs') : 'Not in books', receipt: byAmount ?? null }
  })
  const settlements = new Map<string, { settlementId: string; settledOn: string | null; count: number; gross: number; fee: number; tax: number; net: number; postedVoucherId: number | null }>()
  for (const r of payments.filter((x) => x.settlementId)) {
    const s = settlements.get(r.settlementId!) ?? settlements.set(r.settlementId!, { settlementId: r.settlementId!, settledOn: r.settledOn, count: 0, gross: 0, fee: 0, tax: 0, net: 0, postedVoucherId: r.postedVoucherId }).get(r.settlementId!)!
    s.count++
    s.gross += r.amount
    s.fee += r.fee
    s.tax += r.tax
    s.net = s.gross - s.fee - s.tax
  }
  return {
    payments: rows,
    notInReport: receipts.filter((r) => !used.has(r.voucherId) && r.date >= p.from && r.date <= p.to),
    settlements: [...settlements.values()],
    summary: {
      matched: rows.filter((r) => r.status === 'Matched').length, notInBooks: rows.filter((r) => r.status === 'Not in books').length,
      gross: payments.reduce((t, x) => t + x.amount, 0), fees: payments.reduce((t, x) => t + x.fee + x.tax, 0),
    },
  }
}

/** Post a settlement as a Receipt on its date: net into the bank, fee and GST on it debited, the gross off the gateway's ledger. */
export async function postSettlement(companyId: number, gateway: string, settlementId: string, l: { gatewayLedgerId: number; bankLedgerId: number; feeLedgerId: number; taxLedgerId?: number | null }) {
  const rows = (await pool.query<{ amount: number; fee: number; tax: number; settledOn: string | null; date: string; posted: number | null }>(
    `SELECT amount::float8 amount, fee::float8 fee, tax::float8 tax, to_char(settled_on, 'YYYY-MM-DD') "settledOn", to_char(date, 'YYYY-MM-DD') date, posted_voucher_id posted
       FROM gateway_payments WHERE company_id = $1 AND lower(gateway) = lower($2) AND settlement_id = $3`,
    [companyId, gateway, settlementId],
  )).rows
  if (!rows.length) throw new ValidationError([`No payments of settlement ${settlementId}`])
  if (rows.some((r) => r.posted)) throw new ValidationError([`Settlement ${settlementId} is already posted`])
  const gross = rows.reduce((t, r) => t + r.amount, 0)
  const fee = rows.reduce((t, r) => t + r.fee, 0)
  const tax = rows.reduce((t, r) => t + r.tax, 0)
  if (tax && !l.taxLedgerId) throw new ValidationError(['The settlement has GST on the fee: choose the ledger for it (input GST)'])
  const date = rows.map((r) => r.settledOn ?? r.date).sort().at(-1)!
  const entries = [
    { ledgerId: l.bankLedgerId, amount: gross - fee - tax },
    ...(fee ? [{ ledgerId: l.feeLedgerId, amount: fee }] : []),
    ...(tax ? [{ ledgerId: l.taxLedgerId!, amount: tax }] : []),
    { ledgerId: l.gatewayLedgerId, amount: -gross },
  ]
  const v = await postVoucher(companyId, { type: 'Receipt', date, narration: `${gateway} settlement ${settlementId}: ${rows.length} payments`, entries })
  await pool.query(`UPDATE gateway_payments SET posted_voucher_id = $4 WHERE company_id = $1 AND lower(gateway) = lower($2) AND settlement_id = $3`, [companyId, gateway, settlementId, v.id])
  return v
}

export async function gateways(companyId: number) {
  return (await pool.query<{ gateway: string; payments: number }>(
    `SELECT min(gateway) gateway, count(*)::int payments FROM gateway_payments WHERE company_id = $1 GROUP BY lower(gateway) ORDER BY 1`, [companyId],
  )).rows
}
