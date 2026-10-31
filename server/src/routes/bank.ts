import type { Router, Request } from 'express'
import { z } from 'zod'
import { pool } from '../db'
import { bankEntries, getCompany, ledgerBalances, setBankDates, ValidationError } from '../books'
import { matchStatement, reconcile } from '../engine/bank'
import { draftVouchers, cancelledVouchers, chequeRegister, depositSlip, negativeLedgers, negativeStock, nextChequeNo, postDatedVouchers } from '../cheques'

/** Today, as the server sees it (cheques dated after it are post-dated). */
import { today } from '../engine/clock'

type Period = { from: string; to: string }
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use yyyy-mm-dd')

export function addBankRoutes(company: Router, cid: (req: Request) => number, period: (req: Request) => Promise<Period>) {
  /** Bank Reconciliation for one bank ledger as on the period end (?all=1 lists cleared entries too). */
  company.get('/ledgers/:id/reconciliation', async (req, res) => {
    const { from, to } = await period(req)
    const ledgerId = Number(req.params.id)
    const c = (await getCompany(pool, cid(req)))!
    const b = (await ledgerBalances(pool, cid(req), c.booksBegin, to)).find((x) => x.id === ledgerId)
    if (!b) return res.status(404).json({ error: 'Not found' })
    const open = await bankEntries(pool, cid(req), ledgerId, from, to)
    const entries = req.query.all === '1' ? await bankEntries(pool, cid(req), ledgerId, from, to, true) : open
    res.json({ ledger: { id: b.id, name: b.name }, asOf: to, entries, ...reconcile(b.closing, open) })
  })

  /** Cheque Register: every instrument in the period (?bankId= for one bank), with its status. */
  company.get('/reports/cheques', async (req, res) => {
    const p = await period(req)
    const bankId = req.query.bankId ? Number(req.query.bankId) : undefined
    res.json({ ...p, today: today(), lines: await chequeRegister(pool, cid(req), p.from, p.to, today(), bankId) })
  })
  /** Deposit slip for one bank: instruments received and not yet cleared. */
  company.get('/ledgers/:id/deposit-slip', async (req, res) => {
    const p = await period(req)
    const lines = await depositSlip(pool, cid(req), Number(req.params.id), p.from, p.to, today())
    res.json({ ...p, lines, total: lines.reduce((t, l) => t + l.amount, 0) })
  })
  company.get('/ledgers/:id/next-cheque', async (req, res) => res.json({ chequeNo: await nextChequeNo(pool, Number(req.params.id)) }))
  /** Post-dated vouchers still ahead of today. */
  company.get('/reports/post-dated', async (req, res) => res.json({ today: today(), vouchers: await postDatedVouchers(pool, cid(req), today()) }))
  /** Optional or Memorandum vouchers (?kind=optional|memorandum). */
  company.get('/reports/drafts', async (req, res) => {
    const p = await period(req)
    const kind = z.enum(['optional', 'memorandum']).parse(req.query.kind)
    res.json({ ...p, kind, vouchers: await draftVouchers(pool, cid(req), kind, p.from, p.to) })
  })
  company.get('/reports/cancelled', async (req, res) => {
    const p = await period(req)
    res.json({ ...p, vouchers: await cancelledVouchers(pool, cid(req), p.from, p.to) })
  })
  company.get('/reports/negative-ledgers', async (req, res) => {
    const p = await period(req)
    res.json({ ...p, ledgers: await negativeLedgers(pool, cid(req), p.from, p.to) })
  })
  company.get('/reports/negative-stock', async (req, res) => {
    const p = await period(req)
    res.json({ ...p, items: await negativeStock(pool, cid(req), p.from, p.to) })
  })

  company.put('/reconciliation', async (req, res) => {
    const items = z.array(z.object({ entryId: z.number().int(), bankDate: date.nullable() })).parse(req.body)
    await setBankDates(cid(req), items)
    res.status(204).end()
  })

  /**
   * Bank statement import: statement lines (parsed from the bank's CSV in the app) are matched
   * to uncleared entries and those get their bank dates. Returns what matched and what didn't.
   */
  company.post('/ledgers/:id/statement', async (req, res) => {
    const { from, to } = await period(req)
    const lines = z.array(z.object({ date, amount: z.number().int(), description: z.string().optional() })).parse(req.body)
    if (!lines.length) throw new ValidationError(['The statement has no lines'])
    const latest = lines.reduce((m, l) => (l.date > m ? l.date : m), to)
    const open = await bankEntries(pool, cid(req), Number(req.params.id), from, latest)
    const { matches, unmatched } = matchStatement(open, lines)
    if (matches.length) await setBankDates(cid(req), matches.map((m) => ({ entryId: m.entryId, bankDate: m.bankDate })))
    res.json({ matched: matches.length, unmatched: unmatched.map((i) => ({ line: i, ...lines[i] })) })
  })
}
