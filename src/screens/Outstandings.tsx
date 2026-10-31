import { useState } from 'react'
import { useApp } from '../App'
import { api } from '../api'
import { amt, drcr, Errors, fmtDate, Picker, Title, useLoad } from '../ui'

const asOfNote = (asOf: string) => <span className="muted">as on {fmtDate(asOf)}</span>

/** Outstandings are as on today (like Tally), unless the period ends earlier. */
function useAsOf() {
  const { period } = useApp()
  const today = new Date().toISOString().slice(0, 10)
  return { from: period.from, to: today < period.to ? (today < period.from ? period.from : today) : period.to }
}

/** Bills Receivable / Payable (Outstandings), or only the overdue ones (Exception Reports). */
export function BillsView({ side, overdue = false }: { side: 'receivable' | 'payable'; overdue?: boolean }) {
  const { company, version, push } = useApp()
  const period = useAsOf()
  const { data, error } = useLoad(() => api.bills(company.id, side, period, overdue), [company.id, period.to, version, side, overdue])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const title = `${overdue ? 'Overdue ' : 'Bills '}${side === 'receivable' ? 'Receivable' : 'Payable'}`
  const shownTotal = data.bills.reduce((t, b) => t + b.pending, 0)
  return (
    <div>
      <Title right={asOfNote(data.asOf)}>{title}</Title>
      <table className="report">
        <thead>
          <tr>
            <th>Date</th>
            <th>Ref. No.</th>
            <th>Party's Name</th>
            <th className="num">Pending Amount</th>
            <th>Due on</th>
            <th className="num">Overdue by days</th>
          </tr>
        </thead>
        <tbody>
          {data.bills.map((b) => (
            <tr key={`${b.ledgerId}-${b.name}`} className="clickable" onClick={() => push({ k: 'ledger-outstanding', ledgerId: b.ledgerId })}>
              <td>{fmtDate(b.billDate)}</td>
              <td>{b.name}</td>
              <td>{b.ledger}</td>
              <td className="num">{amt(b.pending)}</td>
              <td>{fmtDate(b.dueDate)}</td>
              <td className={`num ${b.overdueDays ? 'overdue' : ''}`}>{b.overdueDays || ''}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3}>Total</td>
            <td className="num total">{amt(shownTotal)}</td>
            <td colSpan={2} />
          </tr>
        </tfoot>
      </table>
      {data.bills.length === 0 && <p className="muted">No {overdue ? 'overdue ' : 'pending '}bills.</p>}
      {!overdue && data.bills.length > 0 && (
        <div className="ageing">
          {data.ageing.map((a) => (
            <div key={a.bucket}>
              <span className="muted">{a.bucket}</span>
              <b>{amt(a.amount) || '—'}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** One party's pending bills, On Account remainder and closing balance. */
export function LedgerOutstandingView({ ledgerId }: { ledgerId: number }) {
  const { company, version, push } = useApp()
  const period = useAsOf()
  const { data, error } = useLoad(() => api.outstanding(company.id, ledgerId, period), [company.id, period.to, version, ledgerId])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={asOfNote(data.asOf)}>Ledger Outstandings: {data.ledger.name}</Title>
      <table className="report">
        <thead>
          <tr>
            <th>Date</th>
            <th>Ref. No.</th>
            <th className="num">Pending Amount</th>
            <th>Due on</th>
            <th className="num">Overdue by days</th>
          </tr>
        </thead>
        <tbody>
          {data.bills.map((b) => (
            <tr key={b.name}>
              <td>{fmtDate(b.billDate)}</td>
              <td>{b.name}</td>
              <td className="num">{drcr(b.pending)}</td>
              <td>{fmtDate(b.dueDate)}</td>
              <td className={`num ${b.overdueDays ? 'overdue' : ''}`}>{b.overdueDays || ''}</td>
            </tr>
          ))}
          {data.onAccount !== 0 && (
            <tr className="muted">
              <td />
              <td>On Account</td>
              <td className="num">{drcr(data.onAccount)}</td>
              <td colSpan={2} />
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2}>Closing balance</td>
            <td className="num total">{drcr(data.closing) || 'nil'}</td>
            <td colSpan={2}>
              <button type="button" className="linkish-dark" onClick={() => push({ k: 'statement', ledgerId: data.ledger.id })}>
                Ledger vouchers
              </button>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

/** Every party under a group, with how much is billed, overdue and on account. */
export function GroupOutstandingView({ groupId }: { groupId?: number }) {
  const { company, version, push } = useApp()
  const period = useAsOf()
  const { data, error } = useLoad(() => api.groupOutstandings(company.id, period, groupId), [company.id, period.to, version, groupId])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={asOfNote(data.asOf)}>Group Outstandings: {data.group.name}</Title>
      <table className="report">
        <thead>
          <tr>
            <th>Particulars</th>
            <th className="num">Pending bills</th>
            <th className="num">Of which overdue</th>
            <th className="num">On Account</th>
            <th className="num">Closing balance</th>
          </tr>
        </thead>
        <tbody>
          {data.ledgers.map((l) => (
            <tr key={l.id} className="clickable" onClick={() => push({ k: 'ledger-outstanding', ledgerId: l.id })}>
              <td>{l.name}</td>
              <td className="num">{drcr(l.billed)}</td>
              <td className={`num ${l.overdue ? 'overdue' : ''}`}>{drcr(l.overdue)}</td>
              <td className="num">{drcr(l.onAccount)}</td>
              <td className="num">{drcr(l.closing)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={4}>Grand Total</td>
            <td className="num total">{drcr(data.total) || 'nil'}</td>
          </tr>
        </tfoot>
      </table>
      {data.ledgers.length === 0 && <p className="muted">Nothing outstanding in this group.</p>}
    </div>
  )
}

/** Pick a bill-wise ledger, or a group, for the outstanding reports. */
export function OutstandingPick({ kind }: { kind: 'ledger' | 'group' }) {
  const { company, period, replace } = useApp()
  const { data } = useLoad<{ id: number; name: string; hint?: string }[]>(
    () =>
      kind === 'ledger'
        ? api.ledgers(company.id, period).then((ls) => ls.filter((l) => l.billwise).map((l) => ({ id: l.id, name: l.name, hint: l.group ?? '' })))
        : api.groups(company.id).then((gs) => gs.map((g) => ({ id: g.id, name: g.name, hint: g.nature }))),
    [company.id, kind],
  )
  const [id, setId] = useState<number | null>(null)
  return (
    <div className="form narrow">
      <Title>{kind === 'ledger' ? 'Ledger Outstandings' : 'Group Outstandings'}</Title>
      {data && data.length === 0 && <p className="muted">No ledgers keep bill-wise details yet.</p>}
      <label>
        Name of {kind}
        <Picker
          options={data ?? []}
          value={id}
          onChange={(v) => {
            setId(v)
            replace(kind === 'ledger' ? { k: 'ledger-outstanding', ledgerId: v } : { k: 'group-outstanding', groupId: v })
          }}
          autoFocus
        />
      </label>
    </div>
  )
}
