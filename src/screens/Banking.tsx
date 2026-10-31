import { useRef, useState } from 'react'
import { useApp } from '../App'
import { api, ApiError, type BankEntry } from '../api'
import { parseShortDate } from '../../server/src/engine/dates'
import { parseStatementCsv } from '../../server/src/engine/bankcsv'
import { amt, drcr, Errors, fmtDate, Picker, Title, useLoad } from '../ui'

/** Reconciliation is as on today (like Tally), unless the period ends earlier. */
function useAsOf() {
  const { period } = useApp()
  const today = new Date().toISOString().slice(0, 10)
  return { from: period.from, to: today < period.to ? (today < period.from ? period.from : today) : period.to }
}

const BANK_TITLES = { reco: 'Bank Reconciliation', cheques: 'Cheque Register', slip: 'Deposit Slip' }

export function BankPick({ next = 'reco' }: { next?: 'reco' | 'cheques' | 'slip' }) {
  const { company, period, replace } = useApp()
  const { data } = useLoad(() => api.ledgers(company.id, period), [company.id])
  const banks = (data ?? []).filter((l) => l.group === 'Bank Accounts' || l.group === 'Bank OD A/c')
  const open = (id: number) =>
    replace(next === 'reco' ? { k: 'bank-reco', ledgerId: id } : next === 'cheques' ? { k: 'cheque-register', bankId: id } : { k: 'deposit-slip', bankId: id })
  return (
    <div className="form narrow">
      <Title>{BANK_TITLES[next]}</Title>
      {data && banks.length === 0 && <p className="muted">Create a ledger under Bank Accounts first.</p>}
      <label>
        Name of bank
        <Picker options={banks.map((l) => ({ id: l.id, name: l.name, hint: drcr(l.closing) }))} value={null} onChange={open} autoFocus />
      </label>
    </div>
  )
}

/**
 * Bank Reconciliation: the entries the bank hasn't reflected yet, each with a Bank Date to
 * fill in (Enter saves the row and moves on), the reconciliation statement, and a bank
 * statement import that clears the matching entries by itself.
 */
export function BankRecoView({ ledgerId }: { ledgerId: number }) {
  const { company, version, changed } = useApp()
  const period = useAsOf()
  const [showAll, setShowAll] = useState(false)
  const { data, error } = useLoad(() => api.reconciliation(company.id, ledgerId, period, showAll), [company.id, ledgerId, period.to, version, showAll])
  const [dates, setDates] = useState<Record<number, string>>({})
  const [errors, setErrors] = useState<string[]>([])
  const [imported, setImported] = useState<{ matched: number; unmatched: { date: string; amount: number; description?: string }[] } | null>(null)
  const table = useRef<HTMLTableElement>(null)
  const file = useRef<HTMLInputElement>(null)

  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>

  async function save(e: BankEntry, text: string, input: HTMLInputElement) {
    const t = text.trim()
    const bankDate = t ? parseShortDate(t, e.date, company.fyStart) : null
    if (t && !bankDate) return setErrors([`"${t}" is not a date`])
    try {
      await api.setBankDates(company.id, [{ entryId: e.entryId, bankDate }])
      setErrors([])
      changed()
      const inputs = [...(table.current?.querySelectorAll<HTMLInputElement>('input.date') ?? [])]
      inputs[inputs.indexOf(input) + 1]?.focus()
    } catch (err) {
      setErrors(err instanceof ApiError ? err.errors : [String(err)])
    }
  }

  async function importStatement(f: File) {
    try {
      const { lines, skipped } = parseStatementCsv(await f.text())
      const r = await api.importStatement(company.id, ledgerId, period, lines)
      setImported(r)
      setErrors(skipped ? [`${skipped} line(s) of the file weren't transactions and were skipped`] : [])
      changed()
    } catch (err) {
      setErrors(err instanceof ApiError ? err.errors : [(err as Error).message])
    }
  }

  return (
    <div>
      <Title
        right={
          <span className="inline">
            <button type="button" onClick={() => setShowAll((x) => !x)}>
              {showAll ? 'Hide reconciled' : 'Show reconciled'}
            </button>
            <button type="button" onClick={() => file.current?.click()}>
              Import bank statement (CSV)
            </button>
            <input ref={file} type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files?.[0] && importStatement(e.target.files[0])} />
          </span>
        }
      >
        Bank Reconciliation: {data.ledger.name}
      </Title>
      <Errors errors={errors} />
      {imported && (
        <div className="confirm">
          Statement imported: {imported.matched} entr{imported.matched === 1 ? 'y' : 'ies'} reconciled.
          {imported.unmatched.length > 0 && (
            <> Not in the books ({imported.unmatched.length}): {imported.unmatched.map((u) => `${fmtDate(u.date)} ${u.description ?? ''} ${drcr(-u.amount)}`).join(' · ')}</>
          )}
        </div>
      )}
      <table className="report" ref={table}>
        <thead>
          <tr>
            <th>Date</th>
            <th>Particulars</th>
            <th>Vch Type</th>
            <th className="num">Vch No.</th>
            <th className="num">Debit</th>
            <th className="num">Credit</th>
            <th>Bank Date</th>
          </tr>
        </thead>
        <tbody>
          {data.entries.map((e, i) => (
            <tr key={e.entryId} className={e.bankDate ? 'muted' : ''}>
              <td>{fmtDate(e.date)}</td>
              <td>
                {e.particulars}
                {e.narration && <div className="muted small">{e.narration}</div>}
              </td>
              <td>{e.type}</td>
              <td className="num">{e.docNo ?? e.number}</td>
              <td className="num">{e.amount > 0 ? amt(e.amount) : ''}</td>
              <td className="num">{e.amount < 0 ? amt(-e.amount) : ''}</td>
              <td>
                <input
                  className="date"
                  autoFocus={i === 0}
                  aria-label={`Bank date for ${e.type} ${e.docNo ?? e.number}`}
                  placeholder="dd-mm"
                  value={dates[e.entryId] ?? (e.bankDate ? fmtDate(e.bankDate) : '')}
                  onFocus={(ev) => ev.target.select()}
                  onChange={(ev) => setDates((d) => ({ ...d, [e.entryId]: ev.target.value }))}
                  onKeyDown={(ev) => {
                    if (ev.key !== 'Enter') return
                    ev.preventDefault()
                    save(e, ev.currentTarget.value, ev.currentTarget)
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.entries.length === 0 && <p className="muted">Everything up to {fmtDate(data.asOf)} is reconciled.</p>}
      <table className="report reco">
        <tbody>
          <tr>
            <td>Balance as per Company Books</td>
            <td className="num">{drcr(data.bookBalance) || '0.00'}</td>
          </tr>
          <tr>
            <td>Amounts not reflected in Bank: deposits not yet credited</td>
            <td className="num">{amt(data.notCredited) || '—'}</td>
          </tr>
          <tr>
            <td>Amounts not reflected in Bank: payments not yet debited</td>
            <td className="num">{amt(data.notDebited) || '—'}</td>
          </tr>
          <tr className="strong">
            <td>Balance as per Bank (on {fmtDate(data.asOf)})</td>
            <td className="num total">{drcr(data.bankBalance) || '0.00'}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
