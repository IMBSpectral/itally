/**
 * Cheques and exceptions: the Cheque Register, deposit slips, post-dated vouchers, the next
 * cheque number of a bank, and the exception reports (cancelled vouchers, negative ledgers,
 * negative stock).
 */
import { pool, type Tx } from './db'
import { ledgerBalances, loadGroups } from './books'
import { primaryOf } from './engine/groups'
import { stockPositions } from './inventory'

type Db = Tx | typeof pool

export interface ChequeLine {
  entryId: number
  voucherId: number
  type: string
  number: number
  date: string
  bankId: number
  bank: string
  party: string // the voucher's other ledgers
  chequeNo: string | null
  chequeDate: string | null
  amount: number // - issued (Cr to the bank), + received
  bankDate: string | null
  status: 'cleared' | 'post-dated' | 'pending'
}

/** Every bank entry with an instrument in [from, to] (optionally one bank), with its status as on `today`. */
export async function chequeRegister(db: Db, companyId: number, from: string, to: string, today: string, bankId?: number): Promise<ChequeLine[]> {
  const { rows } = await db.query<Omit<ChequeLine, 'status'>>(
    `SELECT e.id "entryId", v.id "voucherId", v.type, v.number, COALESCE(v.doc_no, v.number::text) "docNo", to_char(v.date,'YYYY-MM-DD') date, e.ledger_id "bankId", l.name bank,
            COALESCE((SELECT string_agg(l2.name, ', ' ORDER BY e2.line) FROM entries e2 JOIN ledgers l2 ON l2.id = e2.ledger_id
                       WHERE e2.voucher_id = v.id AND e2.ledger_id <> e.ledger_id), '') party,
            e.instrument_no "chequeNo", to_char(e.instrument_date,'YYYY-MM-DD') "chequeDate", e.amount, to_char(e.bank_date,'YYYY-MM-DD') "bankDate"
       FROM entries e JOIN vouchers v ON v.id = e.voucher_id JOIN ledgers l ON l.id = e.ledger_id
      WHERE v.company_id = $1 AND v.date BETWEEN $2 AND $3 AND (e.instrument_no IS NOT NULL OR e.instrument_date IS NOT NULL)
        AND ($4::int IS NULL OR e.ledger_id = $4)
      ORDER BY v.date, v.id, e.line`,
    [companyId, from, to, bankId ?? null],
  )
  return rows.map((r) => ({
    ...r,
    amount: Number(r.amount),
    status: r.bankDate ? 'cleared' : (r.chequeDate ?? r.date) > today ? 'post-dated' : 'pending',
  }))
}

/** A deposit slip: the instruments received into a bank up to `to` and not yet cleared. */
export async function depositSlip(db: Db, companyId: number, bankId: number, from: string, to: string, today: string) {
  return (await chequeRegister(db, companyId, from, to, today, bankId)).filter((c) => c.amount > 0 && !c.bankDate)
}

/** The number after the bank's last issued cheque (keeping its leading zeros), or null if none is numeric. */
export async function nextChequeNo(db: Db, bankId: number): Promise<string | null> {
  const { rows } = await db.query<{ no: string }>(
    `SELECT e.instrument_no no FROM entries e JOIN vouchers v ON v.id = e.voucher_id
      WHERE e.ledger_id = $1 AND e.amount < 0 AND e.instrument_no ~ '^[0-9]{1,18}$'
      ORDER BY e.instrument_no::numeric DESC LIMIT 1`,
    [bankId],
  )
  if (!rows[0]) return null
  return String(BigInt(rows[0].no) + 1n).padStart(rows[0].no.length, '0')
}

/** Vouchers marked post-dated whose date is still ahead of `today`, with what they will move. */
export async function postDatedVouchers(db: Db, companyId: number, today: string) {
  const { rows } = await db.query<{ id: number; type: string; number: number; date: string; narration: string; entries: { ledger: string; amount: number }[] }>(
    `SELECT v.id, v.type, v.number, COALESCE(v.doc_no, v.number::text) "docNo", to_char(v.date,'YYYY-MM-DD') date, v.narration,
            COALESCE(json_agg(json_build_object('ledger', l.name, 'amount', e.amount) ORDER BY e.line) FILTER (WHERE e.id IS NOT NULL), (v.draft -> 'entries')::json, '[]'::json) entries,
            v.held
       FROM vouchers v LEFT JOIN entries e ON e.voucher_id = v.id LEFT JOIN ledgers l ON l.id = e.ledger_id
      WHERE v.company_id = $1 AND v.post_dated AND NOT v.cancelled AND v.date > $2
      GROUP BY v.id ORDER BY v.date, v.id`,
    [companyId, today],
  )
  return rows.map((v) => ({ ...v, amount: v.entries.reduce((t, e) => t + Math.max(Number(e.amount), 0), 0) }))
}

// ------------------------------------------------------------------ exception reports

/** Optional vouchers or Memorandum vouchers in the period: kept, but out of the books. */
export async function draftVouchers(db: Db, companyId: number, kind: 'optional' | 'memorandum', from: string, to: string) {
  const { rows } = await db.query<{ id: number; type: string; number: number; date: string; narration: string; entries: { ledger: string; amount: number }[] }>(
    `SELECT v.id, v.type, v.number, COALESCE(v.doc_no, v.number::text) "docNo", to_char(v.date,'YYYY-MM-DD') date, v.narration, COALESCE(v.draft -> 'entries', '[]') entries
       FROM vouchers v
      WHERE v.company_id = $1 AND v.draft IS NOT NULL AND NOT v.cancelled AND v.date BETWEEN $2 AND $3
        AND (CASE WHEN $4 = 'memorandum' THEN v.type = 'Memorandum' ELSE v.optional END)
      ORDER BY v.date, v.id`,
    [companyId, from, to, kind],
  )
  return rows.map((v) => ({ ...v, amount: v.entries.reduce((t, e) => t + Math.max(Number(e.amount), 0), 0) }))
}

export async function cancelledVouchers(db: Db, companyId: number, from: string, to: string) {
  const { rows } = await db.query(
    `SELECT v.id, v.type, v.number, COALESCE(v.doc_no, v.number::text) "docNo", to_char(v.date,'YYYY-MM-DD') date, v.narration, to_char(v.updated_at,'YYYY-MM-DD') "cancelledOn",
            (SELECT actor FROM edit_log WHERE entity = 'voucher' AND entity_id = v.id AND action = 'cancel' ORDER BY id DESC LIMIT 1) "by"
       FROM vouchers v WHERE v.company_id = $1 AND v.cancelled AND v.date BETWEEN $2 AND $3 ORDER BY v.date, v.id`,
    [companyId, from, to],
  )
  return rows
}

/**
 * Negative ledgers: balance-sheet ledgers standing on the wrong side of their nature at the
 * period end, such as Cash in credit or a supplier in debit.
 */
export async function negativeLedgers(db: Db, companyId: number, from: string, to: string) {
  const groups = await loadGroups(db, companyId)
  return (await ledgerBalances(db, companyId, from, to))
    .filter((b) => b.id > 0 && b.groupId !== null)
    .map((b) => ({ ...b, nature: primaryOf(groups, b.groupId!).nature, group: groups.get(b.groupId!)!.name }))
    .filter((b) => (b.nature === 'Assets' && b.closing < 0) || (b.nature === 'Liabilities' && b.closing > 0))
    .map((b) => ({ id: b.id, name: b.name, group: b.group, closing: b.closing }))
}

/** Items whose stock has run below zero by the period end. */
export async function negativeStock(db: Db, companyId: number, from: string, to: string) {
  return (await stockPositions(db, companyId, from, to))
    .filter((i) => i.closingQty < 0)
    .map((i) => ({ id: i.id, name: i.name, unit: i.unit, decimals: i.decimals, closingQty: i.closingQty }))
}
