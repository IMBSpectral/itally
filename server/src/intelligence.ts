/**
 * Intelligence: Money Map (cash now, what comes in and goes out in the next days, the projected
 * closing and what to pay first), the review queue (checks over the books that suggest, never
 * act: possible duplicates, unreconciled bank entries, overdue collections, GST problems, GSTR-2B
 * mismatches, e-Invoices due, cash below zero), and the assistants that run those checks on a
 * schedule. Everything here is worked out from the books; nothing is posted, altered or paid.
 */
import { pool } from './db'
import { getCompany, ledgerBalances, loadGroups, pendingBills, ValidationError } from './books'
import { isUnder } from './engine/groups'
import { today } from './engine/clock'
import { fyStartOf } from './engine/numbering'
import { reconcile2b } from './gst-more'
import { eDocRegister } from './edocs'

const DAY = 86_400_000
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10)
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY)

async function cashAndBank(companyId: number, asOf: string) {
  const c = (await getCompany(pool, companyId))!
  const groups = await loadGroups(pool, companyId)
  const balances = await ledgerBalances(pool, companyId, fyStartOf(asOf, c.fyStart), asOf)
  const of = (g: string) => balances.filter((b) => b.groupId !== null && isUnder(groups, b.groupId, [g]))
  return { company: c, groups, cash: of('Cash-in-Hand'), bank: of('Bank Accounts') }
}

// ------------------------------------------------------------------ Money Map

/**
 * Money Map for the next `days` days: cash and bank now; the receivable bills falling due (those
 * overdue counted as expected now) and post-dated receipts; the payable bills falling due and
 * post-dated payments; the projected closing, the headroom above a reserve, and the payables in
 * the order they fall due.
 */
export async function moneyMap(companyId: number, days = 30, reserve = 0) {
  const asOf = today()
  const until = addDays(asOf, days)
  const { cash, bank } = await cashAndBank(companyId, asOf)
  const cashNow = cash.reduce((t, b) => t + b.closing, 0)
  const bankNow = bank.reduce((t, b) => t + b.closing, 0)
  const bills = (await pendingBills(pool, companyId, asOf)).filter((b) => b.dueDate <= until)
  const collections = bills.filter((b) => b.pending > 0).map((b) => ({ ledgerId: b.ledgerId, party: b.ledger, bill: b.name, dueDate: b.dueDate, amount: b.pending,
    overdueDays: Math.max(0, daysBetween(b.dueDate, asOf)) }))
  const payables = bills.filter((b) => b.pending < 0).map((b) => ({ ledgerId: b.ledgerId, party: b.ledger, bill: b.name, dueDate: b.dueDate, amount: -b.pending,
    overdueDays: Math.max(0, daysBetween(b.dueDate, asOf)) }))
  // post-dated vouchers waiting for their day: receipts into and payments out of cash or bank
  const cashIds = [...cash, ...bank].map((b) => b.id)
  const pdc = (await pool.query<{ id: number; type: string; date: string; amount: number }>(
    `SELECT v.id, v.type, to_char(v.date, 'YYYY-MM-DD') date, SUM((d->>'amount')::bigint)::float8 amount
       FROM vouchers v, jsonb_array_elements(v.draft->'entries') d
      WHERE v.company_id = $1 AND v.held AND NOT v.cancelled AND v.date <= $2 AND (d->>'ledgerId')::int = ANY($3)
      GROUP BY v.id`,
    [companyId, until, cashIds],
  )).rows
  const pdcIn = pdc.filter((p) => p.amount > 0).reduce((t, p) => t + p.amount, 0)
  const pdcOut = -pdc.filter((p) => p.amount < 0).reduce((t, p) => t + p.amount, 0)
  const expected = collections.reduce((t, c) => t + c.amount, 0) + pdcIn
  const planned = payables.reduce((t, p) => t + p.amount, 0) + pdcOut
  const now = cashNow + bankNow
  const projected = now + expected - planned
  const byParty = new Map<string, { party: string; amount: number; dueDate: string }>()
  for (const c of collections) {
    const x = byParty.get(c.party) ?? byParty.set(c.party, { party: c.party, amount: 0, dueDate: c.dueDate }).get(c.party)!
    x.amount += c.amount
    if (c.dueDate < x.dueDate) x.dueDate = c.dueDate
  }
  return {
    asOf, until, days, reserve,
    cashNow: now, cash: cashNow, bank: bankNow,
    expected, planned, projected, headroom: projected - reserve,
    collections: [...byParty.values()].sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    payments: [
      { what: 'Supplier bills', amount: payables.reduce((t, p) => t + p.amount, 0) },
      ...(pdcOut ? [{ what: 'Post-dated payments', amount: pdcOut }] : []),
    ],
    pdcIn,
    // what to pay first: the oldest due first
    priority: payables.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || b.amount - a.amount).slice(0, 25)
      .map((p) => ({ ...p, reason: p.overdueDays ? `Overdue by ${p.overdueDays} day${p.overdueDays > 1 ? 's' : ''}` : `Due on ${p.dueDate}` })),
  }
}

// ------------------------------------------------------------------ the review queue

export type SuggestionKind = 'duplicate' | 'bank' | 'overdue' | 'gst' | 'gstr2b' | 'einvoice' | 'cash'
export interface Suggestion {
  key: string // stable: what the user decided about it is kept under this
  kind: SuggestionKind
  severity: 'high' | 'medium' | 'low'
  title: string
  detail: string
  open?: { screen: 'voucher'; type: string; id: number } | { screen: 'ledger'; id: number } | { screen: 'reconciliation'; id: number } | { screen: 'gstr2b' } | { screen: 'e-documents' }
}
const rupees = (p: number) => `₹${(Math.abs(p) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** The checks, run now; kinds limit them (an assistant runs only its own). */
export async function findSuggestions(companyId: number, kinds?: SuggestionKind[]): Promise<Suggestion[]> {
  const want = (k: SuggestionKind) => !kinds || kinds.includes(k)
  const asOf = today()
  const out: Suggestion[] = []
  const { groups, cash, bank } = await cashAndBank(companyId, asOf)

  if (want('duplicate')) {
    // the same party, type and amount within three days: entered twice?
    const parties = (await pool.query<{ id: number; groupId: number | null }>(`SELECT id, group_id "groupId" FROM ledgers WHERE company_id = $1`, [companyId])).rows
      .filter((l) => l.groupId !== null && isUnder(groups, l.groupId, ['Sundry Debtors', 'Sundry Creditors'])).map((l) => l.id)
    const { rows } = await pool.query<{ a: number; b: number; type: string; aNo: string; bNo: string; aDate: string; bDate: string; party: string; amount: number }>(
      `SELECT a.id a, b.id b, a.type, COALESCE(a.doc_no, a.number::text) "aNo", COALESCE(b.doc_no, b.number::text) "bNo",
              to_char(a.date, 'YYYY-MM-DD') "aDate", to_char(b.date, 'YYYY-MM-DD') "bDate", l.name party, abs(e1.amount)::float8 amount
         FROM vouchers a JOIN entries e1 ON e1.voucher_id = a.id JOIN ledgers l ON l.id = e1.ledger_id
         JOIN vouchers b ON b.company_id = a.company_id AND b.type = a.type AND b.id > a.id AND abs(b.date - a.date) <= 3 AND NOT b.cancelled
         JOIN entries e2 ON e2.voucher_id = b.id AND e2.ledger_id = e1.ledger_id AND e2.amount = e1.amount
        WHERE a.company_id = $1 AND NOT a.cancelled AND a.date >= $2 AND e1.ledger_id = ANY($3)
        ORDER BY a.date DESC LIMIT 50`,
      [companyId, addDays(asOf, -120), parties],
    )
    for (const r of rows)
      out.push({ key: `dup:${r.a}:${r.b}`, kind: 'duplicate', severity: 'high', title: `Possible duplicate: ${r.type} No. ${r.bNo}`,
        detail: `${r.party}, ${rupees(r.amount)}: the same as ${r.type} No. ${r.aNo} of ${r.aDate} (this one ${r.bDate})`, open: { screen: 'voucher', type: r.type, id: r.b } })
  }

  if (want('bank')) {
    // bank entries the bank hasn't cleared in 15 days
    for (const b of bank) {
      const { rows } = await pool.query<{ n: number; total: number; oldest: string }>(
        `SELECT count(*)::int n, COALESCE(sum(e.amount), 0)::float8 total, to_char(min(v.date), 'YYYY-MM-DD') oldest
           FROM entries e JOIN vouchers v ON v.id = e.voucher_id WHERE e.ledger_id = $1 AND e.bank_date IS NULL AND NOT v.cancelled AND v.date <= $2`,
        [b.id, addDays(asOf, -15)],
      )
      if (rows[0].n)
        out.push({ key: `bank:${b.id}:${rows[0].oldest}:${rows[0].n}`, kind: 'bank', severity: 'medium', title: `${rows[0].n} unreconciled entries in ${b.name}`,
          detail: `older than 15 days, net ${rupees(rows[0].total)} ${rows[0].total >= 0 ? 'Dr' : 'Cr'}, the oldest of ${rows[0].oldest}: match them with the statement`,
          open: { screen: 'reconciliation', id: b.id } })
    }
  }

  if (want('overdue')) {
    // collections more than 60 days past due, party by party
    const bills = (await pendingBills(pool, companyId, asOf)).filter((x) => x.pending > 0 && daysBetween(x.dueDate, asOf) > 60)
    const byParty = new Map<number, { party: string; total: number; oldest: string; n: number }>()
    for (const x of bills) {
      const p = byParty.get(x.ledgerId) ?? byParty.set(x.ledgerId, { party: x.ledger, total: 0, oldest: x.dueDate, n: 0 }).get(x.ledgerId)!
      p.total += x.pending
      p.n++
      if (x.dueDate < p.oldest) p.oldest = x.dueDate
    }
    for (const [id, p] of byParty)
      out.push({ key: `overdue:${id}:${p.oldest}`, kind: 'overdue', severity: p.total > 10_00_000_00 ? 'high' : 'medium', title: `${p.party}: ${rupees(p.total)} over 60 days past due`,
        detail: `${p.n} bill${p.n > 1 ? 's' : ''}, the oldest due ${p.oldest} (${daysBetween(p.oldest, asOf)} days): follow up`, open: { screen: 'ledger', id } })
  }

  if (want('gst')) {
    const { rows } = await pool.query<{ id: number; type: string; no: string; date: string; problems: string[] }>(
      `SELECT id, type, COALESCE(doc_no, number::text) no, to_char(date, 'YYYY-MM-DD') date, ARRAY(SELECT jsonb_array_elements_text(gst->'problems')) problems
         FROM vouchers WHERE company_id = $1 AND NOT cancelled AND date >= $2 AND gst IS NOT NULL AND jsonb_array_length(COALESCE(gst->'problems', '[]')) > 0
        ORDER BY date DESC LIMIT 50`,
      [companyId, addDays(asOf, -90)],
    )
    for (const r of rows)
      out.push({ key: `gst:${r.id}:${r.problems.join('|')}`, kind: 'gst', severity: 'medium', title: `GST: ${r.type} No. ${r.no} of ${r.date}`, detail: r.problems.join('; '),
        open: { screen: 'voucher', type: r.type, id: r.id } })
  }

  if (want('gstr2b')) {
    // last month's GSTR-2B against the books, when it has been uploaded
    const month = addDays(asOf.slice(0, 7) + '-01', -1).slice(0, 7)
    const r = await reconcile2b(companyId, month).catch(() => null)
    if (r?.uploaded && (r.summary.mismatched || r.summary.notInBooks))
      out.push({ key: `2b:${month}:${r.summary.mismatched}:${r.summary.notInBooks}`, kind: 'gstr2b', severity: 'high', title: `GSTR-2B ${month}: ${r.summary.mismatched + r.summary.notInBooks} documents to look at`,
        detail: `${r.summary.mismatched} differ from the books, ${r.summary.notInBooks} are not in the books; ${r.summary.pending ?? 0} await an IMS action`, open: { screen: 'gstr2b' } })
  }

  if (want('einvoice')) {
    // an e-Invoice is reported within 30 days of the invoice (for the larger taxpayers): flag those due and not generated
    const reg = await eDocRegister(companyId, { from: addDays(asOf, -30), to: asOf }).catch(() => [])
    const due = reg.filter((v) => v.einvoice.needed && !v.einvoice.irn)
    if (due.length)
      out.push({ key: `einv:${asOf}:${due.length}`, kind: 'einvoice', severity: due.some((v) => daysBetween(v.date, asOf) > 20) ? 'high' : 'medium',
        title: `${due.length} e-Invoice${due.length > 1 ? 's' : ''} due and not generated`, detail: `the oldest of ${due[0].date}; the IRP takes them within 30 days`, open: { screen: 'e-documents' } })
  }

  if (want('cash')) {
    for (const b of [...cash, ...bank].filter((x) => x.closing < 0))
      out.push({ key: `cash:${b.id}:${asOf}`, kind: 'cash', severity: 'high', title: `${b.name} is below zero`, detail: `${rupees(b.closing)} Cr today: a payment entered before its receipt, or a missing receipt`,
        open: { screen: 'ledger', id: b.id } })
  }
  return out
}

/** The review queue: the suggestions not yet dismissed or done, worst first. */
export async function reviewQueue(companyId: number) {
  const decided = new Map((await pool.query<{ key: string; status: string }>(`SELECT key, status FROM ai_review WHERE company_id = $1`, [companyId])).rows.map((r) => [r.key, r.status]))
  const all = await findSuggestions(companyId)
  const rank = { high: 0, medium: 1, low: 2 }
  return {
    open: all.filter((s) => !decided.has(s.key)).sort((a, b) => rank[a.severity] - rank[b.severity]),
    decided: all.filter((s) => decided.has(s.key)).map((s) => ({ ...s, status: decided.get(s.key)! })),
  }
}

export async function decide(companyId: number, key: string, status: 'dismissed' | 'done' | 'open', user?: string) {
  if (status === 'open') await pool.query(`DELETE FROM ai_review WHERE company_id = $1 AND key = $2`, [companyId, key])
  else
    await pool.query(`INSERT INTO ai_review (company_id, key, status, by_user) VALUES ($1,$2,$3,$4) ON CONFLICT (company_id, key) DO UPDATE SET status = $3, at = now(), by_user = $4`,
      [companyId, key, status, user ?? null])
}

/** Reminder drafts for the overdue collections: text to send by hand or e-mail; nothing is sent. */
export async function collectionDrafts(companyId: number) {
  const c = (await getCompany(pool, companyId))!
  const asOf = today()
  const bills = (await pendingBills(pool, companyId, asOf)).filter((x) => x.pending > 0 && x.dueDate < asOf)
  const byParty = new Map<number, typeof bills>()
  for (const b of bills) (byParty.get(b.ledgerId) ?? byParty.set(b.ledgerId, []).get(b.ledgerId)!).push(b)
  return [...byParty.entries()].map(([ledgerId, bs]) => {
    const total = bs.reduce((t, b) => t + b.pending, 0)
    const lines = bs.map((b) => `  ${b.name} of ${b.billDate}, due ${b.dueDate}: ${rupees(b.pending)}`).join('\n')
    return {
      ledgerId, party: bs[0].ledger, total, bills: bs.length,
      text: `Dear ${bs[0].ledger},\n\nAs per our books, the following bills are overdue:\n${lines}\n\nTotal: ${rupees(total)}\n\nPlease arrange the payment at the earliest, or let us know if it is already on its way.\n\nRegards,\n${c.mailingName || c.name}`,
    }
  }).sort((a, b) => b.total - a.total)
}

// ------------------------------------------------------------------ the assistants

export const AGENTS = {
  'bank-match': { name: 'Bank Match Assistant', purpose: 'Finds bank entries not yet matched with the statement', kinds: ['bank'] as SuggestionKind[], mode: 'Suggest only' },
  collections: { name: 'Collections Assistant', purpose: 'Prepares follow-ups for overdue bills', kinds: ['overdue'] as SuggestionKind[], mode: 'Draft only' },
  'voucher-review': { name: 'Voucher Review Assistant', purpose: 'Flags possible duplicates and GST problems', kinds: ['duplicate', 'gst', 'einvoice'] as SuggestionKind[], mode: 'Read-only' },
  'cash-planning': { name: 'Cash Planning Assistant', purpose: 'Warns when cash runs short of the next 30 days\' payments', kinds: ['cash'] as SuggestionKind[], mode: 'Read-only' },
} as const
export type AgentKind = keyof typeof AGENTS

export async function listAgents(companyId: number) {
  const rows = new Map((await pool.query<{ kind: AgentKind; active: boolean; schedule: string; lastRun: string | null; lastResult: string | null }>(
    `SELECT kind, active, schedule, to_char(last_run, 'YYYY-MM-DD HH24:MI') "lastRun", last_result "lastResult" FROM ai_agents WHERE company_id = $1`, [companyId])).rows.map((r) => [r.kind, r]))
  return (Object.keys(AGENTS) as AgentKind[]).map((kind) => ({
    kind, ...AGENTS[kind], active: rows.get(kind)?.active ?? false, schedule: rows.get(kind)?.schedule ?? (kind === 'collections' ? 'weekdays 10:00' : 'daily 09:00'),
    lastRun: rows.get(kind)?.lastRun ?? null, lastResult: rows.get(kind)?.lastResult ?? null,
  }))
}

export async function setAgent(companyId: number, kind: AgentKind, a: { active: boolean; schedule: string }) {
  if (!AGENTS[kind]) throw new ValidationError([`Unknown assistant ${kind}`])
  if (!/^(daily|weekdays) ([01][0-9]|2[0-3]):[0-5][0-9]$/.test(a.schedule)) throw new ValidationError(['The schedule is "daily HH:MM" or "weekdays HH:MM"'])
  await pool.query(`INSERT INTO ai_agents (company_id, kind, active, schedule) VALUES ($1,$2,$3,$4) ON CONFLICT (company_id, kind) DO UPDATE SET active = $3, schedule = $4`,
    [companyId, kind, a.active, a.schedule])
}

/** Run an assistant now: its checks, and for cash planning the Money Map's headroom. Returns what it found. */
export async function runAgent(companyId: number, kind: AgentKind) {
  const a = AGENTS[kind]
  if (!a) throw new ValidationError([`Unknown assistant ${kind}`])
  const found = await findSuggestions(companyId, [...a.kinds])
  let result = `${found.length} suggestion${found.length === 1 ? '' : 's'}`
  if (kind === 'collections') result = `${(await collectionDrafts(companyId)).length} reminder drafts; ${result}`
  if (kind === 'cash-planning') {
    const m = await moneyMap(companyId, 30)
    result = `${result}; projected 30-day closing ${rupees(m.projected)}${m.projected < 0 ? ' (short)' : ''}`
  }
  await pool.query(`INSERT INTO ai_agents (company_id, kind, last_run, last_result) VALUES ($1,$2, now(), $3)
                    ON CONFLICT (company_id, kind) DO UPDATE SET last_run = now(), last_result = $3`, [companyId, kind, result])
  await pool.query(`INSERT INTO ai_agent_log (company_id, kind, result) VALUES ($1,$2,$3)`, [companyId, kind, result])
  return { kind, result, suggestions: found }
}

export async function agentLog(companyId: number) {
  return (await pool.query(`SELECT id, kind, to_char(at, 'YYYY-MM-DD HH24:MI') at, result FROM ai_agent_log WHERE company_id = $1 ORDER BY id DESC LIMIT 100`, [companyId])).rows
}

/** Run the active assistants whose time has come today (called every minute while the server runs). */
export async function runDueAgents(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60_000) // India time
  const hhmm = ist.toISOString().slice(11, 16)
  const weekday = ist.getUTCDay() >= 1 && ist.getUTCDay() <= 5
  const { rows } = await pool.query<{ companyId: number; kind: AgentKind; schedule: string; ranToday: boolean }>(
    `SELECT company_id "companyId", kind, schedule, COALESCE((last_run + interval '330 minutes')::date = ($1::timestamptz + interval '330 minutes')::date, false) "ranToday"
       FROM ai_agents WHERE active`,
    [now.toISOString()],
  )
  for (const r of rows) {
    const [when, time] = r.schedule.split(' ')
    if (r.ranToday || time > hhmm || (when === 'weekdays' && !weekday)) continue
    await runAgent(r.companyId, r.kind).catch((e) => console.warn(`assistant ${r.kind} of company ${r.companyId} failed:`, e))
  }
}
