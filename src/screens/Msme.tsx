import { useEffect, useRef, useState } from 'react'
import { useApp } from '../App'
import { api, type MsmeActivity, type MsmeDetails, type MsmeForm1, type MsmeType } from '../api'
import { amt, Errors, fmtDate, Title, enterAdvances, useActive, useLoad } from '../ui'
import { useSubmit } from './Masters'

/** MSME: the parties' registrations under the MSMED Act, and MSME Form 1. */

const TYPES: MsmeType[] = ['Micro', 'Small', 'Medium']
const ACTIVITIES: MsmeActivity[] = ['Manufacturing', 'Services', 'Trading']

/** Party MSME Update: the type, Udyam number and activity of every party, set together and saved with Ctrl+A. */
export function MsmeUpdateView() {
  const { company, version, changed } = useApp()
  const { data, error } = useLoad(() => api.msmeParties(company.id), [company.id, version])
  const [edits, setEdits] = useState<Record<number, MsmeDetails | null>>({})
  const [creditorsOnly, setCreditorsOnly] = useState(true)
  useEffect(() => setEdits({}), [data])
  const { errors, ok, submit } = useSubmit(async () => {
    const items = Object.entries(edits).map(([id, msme]) => ({ ledgerId: Number(id), msme }))
    if (!items.length) return 'Nothing changed'
    await api.setMsme(company.id, items)
    changed()
    return `MSME details of ${items.length} part${items.length > 1 ? 'ies' : 'y'} saved`
  })
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const rows = data.filter((p) => !creditorsOnly || p.group !== 'Sundry Debtors')
  const value = (p: (typeof data)[number]): MsmeDetails | null =>
    p.ledgerId in edits ? edits[p.ledgerId] : p.type ? { type: p.type, udyamNo: p.udyamNo, activity: p.activity ?? 'Manufacturing' } : null
  const set = (p: (typeof data)[number], patch: Partial<MsmeDetails> | null) =>
    setEdits((e) => {
      const was = value(p)
      return { ...e, [p.ledgerId]: patch === null ? null : { type: 'Micro', udyamNo: null, activity: 'Manufacturing', ...was, ...patch } }
    })
  return (
    <form onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || <span className="muted">{Object.keys(edits).length} changed · Ctrl+A saves</span>}>Party MSME Update</Title>
      <label>
        Show
        <select value={creditorsOnly ? 'suppliers' : 'all'} onChange={(e) => setCreditorsOnly(e.target.value === 'suppliers')} aria-label="Show">
          <option value="suppliers">Suppliers</option>
          <option value="all">All parties</option>
        </select>
      </label>
      <table className="report">
        <thead>
          <tr>
            <th>Party</th>
            <th>Group</th>
            <th>PAN</th>
            <th>Type of enterprise</th>
            <th>Udyam registration number</th>
            <th>Activity</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const v = value(p)
            return (
              <tr key={p.ledgerId}>
                <td>{p.name}</td>
                <td className="muted">{p.group}</td>
                <td>{p.pan ?? <span className="muted">—</span>}</td>
                <td>
                  <select value={v?.type ?? ''} onChange={(e) => set(p, e.target.value ? { type: e.target.value as MsmeType } : null)} aria-label={`Type of ${p.name}`}>
                    <option value="">Not applicable</option>
                    {TYPES.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input value={v?.udyamNo ?? ''} disabled={!v} size={22} placeholder={v ? 'UDYAM-MH-01-0012345' : ''}
                    onChange={(e) => set(p, { udyamNo: e.target.value.toUpperCase() || null })} aria-label={`Udyam number of ${p.name}`} />
                </td>
                <td>
                  <select value={v?.activity ?? 'Manufacturing'} disabled={!v} onChange={(e) => set(p, { activity: e.target.value as MsmeActivity })} aria-label={`Activity of ${p.name}`}>
                    {ACTIVITIES.map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </select>
                </td>
              </tr>
            )
          })}
          {!rows.length && (
            <tr className="muted">
              <td colSpan={6}>No parties</td>
            </tr>
          )}
        </tbody>
      </table>
      <Errors errors={errors} />
      <div className="actions">
        <button type="submit" className="primary">
          <b>Ctrl+A</b> Save
        </button>
      </div>
    </form>
  )
}

/** MSME Form 1 for a half-year: what is owed to micro and small suppliers beyond the days the Act allows. Keys 1 and 2 pick the half. */
export function MsmeForm1View() {
  const { company, period, version, push } = useApp()
  const fy = `${period.from.slice(5) >= '04-01' ? period.from.slice(0, 4) : Number(period.from.slice(0, 4)) - 1}-04-01`
  const [half, setHalf] = useState(() => (Number(period.to.slice(5, 7)) >= 4 && Number(period.to.slice(5, 7)) <= 9 ? 1 : 2))
  const { data, error } = useLoad(() => api.msmeForm1(company.id, fy, half), [company.id, fy, half, version])
  const active = useActive()
  const latest = useRef<MsmeForm1 | null>(null)
  latest.current = data ?? null
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (['1', '2'].includes(e.key) && !e.altKey && !e.ctrlKey && !(e.target as HTMLElement).closest('input, select')) setHalf(Number(e.key))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={<span className="muted">keys 1-2 half-year · Enter opens the supplier's bills</span>}>
        MSME Form 1: {half === 1 ? 'April to September' : 'October to March'} ({fmtDate(data.from)} to {fmtDate(data.to)})
      </Title>
      {data.problems.length > 0 && <Errors errors={data.problems} />}
      <h3 className="sub">Amounts due to micro and small enterprises beyond 45 days (or the agreed period)</h3>
      <table className="report">
        <thead>
          <tr>
            <th>Supplier</th>
            <th>PAN</th>
            <th>Udyam registration</th>
            <th>Type</th>
            <th className="num">Bills</th>
            <th>Due from</th>
            <th className="num">Amount due</th>
          </tr>
        </thead>
        <tbody>
          {data.suppliers.map((s) => (
            <tr key={s.ledgerId} className="clickable" onClick={() => push({ k: 'ledger-outstanding', ledgerId: s.ledgerId })}>
              <td>{s.supplier}</td>
              <td>{s.pan ?? '—'}</td>
              <td>{s.udyamNo ?? '—'}</td>
              <td>{s.type}</td>
              <td className="num">{s.bills}</td>
              <td>{fmtDate(s.dueFrom)}</td>
              <td className="num">{amt(s.amount)}</td>
            </tr>
          ))}
          {!data.suppliers.length && (
            <tr className="muted">
              <td colSpan={7}>Nothing owed beyond the time allowed</td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={6}>Total</td>
            <td className="num total">{amt(data.total)}</td>
          </tr>
        </tfoot>
      </table>
      {data.lines.length > 0 && (
        <>
          <h3 className="sub">Bills</h3>
          <table className="report">
            <thead>
              <tr>
                <th>Supplier</th>
                <th>Bill</th>
                <th>Bill date</th>
                <th>Due on</th>
                <th className="num">Days overdue</th>
                <th className="num">Pending</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={`${l.ledgerId}/${l.bill}`}>
                  <td>{l.supplier}</td>
                  <td>{l.bill}</td>
                  <td>{fmtDate(l.billDate)}</td>
                  <td>{fmtDate(l.dueDate)}</td>
                  <td className="num">{l.daysOverdue}</td>
                  <td className="num">{amt(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <p className="muted">
        The Act allows the credit period agreed with the supplier, at most 45 days, or 15 days with none agreed (the ledger's credit period).
        {data.yearEnd && ' At the year end these amounts are also what section 43B(h) disallows until they are paid.'} Only bill-wise amounts are counted.
      </p>
    </div>
  )
}

/** Interest on late payments to micro and small suppliers (MSMED Act, section 16): compound, monthly rests, at three times the bank rate. */
export function MsmeInterestView() {
  const { company, period, version } = useApp()
  const [bankRate, setBankRate] = useState('5.50')
  const rate = Math.round(Number(bankRate) * 100)
  const { data, error } = useLoad(() => (rate > 0 ? api.msmeInterest(company.id, period.to, rate) : Promise.resolve(null)), [company.id, period.to, rate, version])
  return (
    <div>
      <Title right={<span className="muted">as on {fmtDate(period.to)} · Alt+F2 date</span>}>Interest on Late Payments to MSMEs</Title>
      <label className="inline">
        RBI bank rate %
        <input className="amount" value={bankRate} onChange={(e) => setBankRate(e.target.value)} aria-label="Bank rate" />
        <span className="muted">{rate > 0 ? `interest at ${(rate * 3) / 100}% a year, compounded monthly; check the bank rate the RBI notifies` : ''}</span>
      </label>
      {error && <Errors errors={[error]} />}
      {data && (
        <table className="report">
          <thead><tr><th>Supplier</th><th>Bill</th><th>Bill date</th><th>Due on</th><th className="num">Amount</th><th className="num">Unpaid</th><th>Paid on</th><th className="num">Days late</th><th className="num">Interest</th></tr></thead>
          <tbody>
            {data.lines.map((l) => (
              <tr key={`${l.ledgerId}/${l.bill}`}>
                <td>{l.supplier}</td><td>{l.bill}</td><td>{fmtDate(l.billDate)}</td><td>{fmtDate(l.dueDate)}</td><td className="num">{amt(l.amount)}</td><td className="num">{l.unpaid ? amt(l.unpaid) : ''}</td>
                <td>{l.paidOn ? fmtDate(l.paidOn) : ''}</td><td className="num">{l.daysLate}</td><td className="num">{amt(l.interest)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={8}>Total</td><td className="num total">{amt(data.total)}</td></tr></tfoot>
        </table>
      )}
      <p className="muted">The interest is owed to the supplier whether claimed or not, and is not an allowable expense (section 23 of the Act).</p>
    </div>
  )
}
