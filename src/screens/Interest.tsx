import { useState } from 'react'
import { useApp } from '../App'
import { api } from '../api'
import { messages } from './Masters'
import { formatINR } from '../../server/src/engine/money'
import { drcr, Errors, fmtDate, Picker, Title, useLoad } from '../ui'
import { periodNote } from './Books'

const rate = (r: number) => `${r / 100}%`
const onText = (on: 'balance' | 'bills') => (on === 'bills' ? 'on overdue bills' : 'on balance')

/** Interest Receivable / Payable, or a group's interest-bearing ledgers. Enter opens a ledger's calculation. */
export function InterestView(which: { side: 'receivable' | 'payable' } | { groupId: number }) {
  const { company, period, version, push } = useApp()
  const key = 'side' in which ? which.side : `g${which.groupId}`
  const { data, error } = useLoad(() => api.interestSummary(company.id, period, which), [company.id, key, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const title = 'side' in which ? `Interest ${which.side === 'receivable' ? 'Receivable' : 'Payable'}` : `Group Interest: ${data.title}`
  return (
    <div>
      <Title right={periodNote(data)}>{title}</Title>
      {data.lines.length === 0 ? (
        <p className="muted">No interest in this period. Give a ledger a yearly interest rate (in its alteration) to calculate it.</p>
      ) : (
        <table className="report">
          <thead>
            <tr>
              <th>Particulars</th>
              <th className="num">Rate</th>
              <th>Calculated</th>
              <th className="num">Interest</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((l) => (
              <tr key={l.id} className="clickable" onClick={() => push({ k: 'ledger-interest', ledgerId: l.id })}>
                <td>{l.name}</td>
                <td className="num">{rate(l.rate)}</td>
                <td className="muted">{onText(l.on)}</td>
                <td className="num">{drcr(l.interest)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>Total</td>
              <td className="num total">{drcr(data.total) || formatINR(0)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  )
}

/** One ledger's interest: each stretch of days with the amount standing and the interest on it. */
export function LedgerInterestView({ ledgerId }: { ledgerId: number }) {
  const { company, period, version, changed } = useApp()
  const { data, error } = useLoad(() => api.ledgerInterest(company.id, ledgerId, period), [company.id, ledgerId, period, version])
  const { data: ledgers } = useLoad(() => api.ledgers(company.id, period), [company.id, version])
  const [interestLedger, setInterestLedger] = useState<number | null>(null)
  const [booked, setBooked] = useState<string | null>(null)
  const [bookErrors, setBookErrors] = useState<string[]>([])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const bills = data.on === 'bills'
  const nature = data.interest > 0 ? 'Income' : 'Expenses'
  const book = () =>
    api.bookInterest(company.id, { ledgerId, from: period.from, to: period.to, interestLedgerId: interestLedger ?? 0, date: period.to })
      .then((r) => (setBooked(`Journal No. ${r.number} booked`), setBookErrors([]), changed()), (e) => setBookErrors(messages(e)))
  return (
    <div>
      <Title right={periodNote(data)}>
        Interest: {data.name} <span className="muted small">at {rate(data.rate)} a year {onText(data.on)}</span>
      </Title>
      {data.stretches.length === 0 ? (
        <p className="muted">No interest in this period.</p>
      ) : (
        <table className="report">
          <thead>
            <tr>
              {bills && <th>Bill</th>}
              <th>From</th>
              <th>To</th>
              <th className="num">Days</th>
              <th className="num">{bills ? 'Overdue amount' : 'Balance'}</th>
              <th className="num">Interest</th>
            </tr>
          </thead>
          <tbody>
            {data.stretches.map((s, i) => (
              <tr key={i}>
                {bills && <td>{s.bill}</td>}
                <td>{fmtDate(s.from)}</td>
                <td>{fmtDate(s.to)}</td>
                <td className="num">{s.days}</td>
                <td className="num">{drcr(s.amount)}</td>
                <td className="num">{drcr(s.interest)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={bills ? 5 : 4}>Total interest {data.interest > 0 ? 'receivable' : 'payable'}</td>
              <td className="num total">{drcr(data.interest)}</td>
            </tr>
          </tfoot>
        </table>
      )}
      {data.interest !== 0 && (
        <div className="inline">
          <label>
            Book it to
            <Picker options={(ledgers ?? []).filter((l) => l.primaryGroup && (nature === 'Income' ? /Income/.test(l.primaryGroup) : /Expense/.test(l.primaryGroup))).map((l) => ({ id: l.id, name: l.name, hint: l.group ?? '' }))}
              value={interestLedger} onChange={setInterestLedger} placeholder={nature === 'Income' ? 'Interest Received' : 'Interest Paid'} />
          </label>
          <button type="button" onClick={book}>Book interest (Journal on {fmtDate(period.to)})</button>
          {booked && <span className="ok">{booked}</span>}
        </div>
      )}
      <Errors errors={bookErrors} />
    </div>
  )
}

/** Pick a ledger (one that calculates interest) or a group for the interest reports. */
export function InterestPick({ of }: { of: 'ledger' | 'group' }) {
  const { company, period, replace } = useApp()
  const { data } = useLoad<{ id: number; name: string; hint?: string }[]>(
    async () =>
      of === 'ledger'
        ? (await api.ledgers(company.id, period)).filter((l) => l.interestRate).map((l) => ({ id: l.id, name: l.name, hint: `${(l.interestRate ?? 0) / 100}%` }))
        : (await api.groups(company.id)).map((g) => ({ id: g.id, name: g.name, hint: g.nature })),
    [company.id, of],
  )
  return (
    <div className="form narrow">
      <Title>{of === 'ledger' ? 'Ledger Interest' : 'Group Interest'}</Title>
      {data && data.length === 0 && <p className="muted">No ledger calculates interest yet.</p>}
      <label>
        Name of {of}
        <Picker
          options={data ?? []}
          value={null}
          onChange={(id) => replace(of === 'ledger' ? { k: 'ledger-interest', ledgerId: id } : { k: 'interest', groupId: id })}
          autoFocus
        />
      </label>
    </div>
  )
}
