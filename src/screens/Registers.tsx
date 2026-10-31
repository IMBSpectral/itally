import { useEffect, useState } from 'react'
import { useApp } from '../App'
import { api, type AuditRow, type PendingLine } from '../api'
import { amt, Errors, fmtDate, Title, useLoad } from '../ui'
import { messages } from './Masters'
import { periodNote } from './Books'
import { qtyField } from './Invoice'

/** Tally Audit, the POS Register, order analysis by month, and tracked vouchers (notes not yet invoiced). */

const STATUSES = ['Not audited', 'Audited', 'Under Observation', 'Altered after audit'] as const

/** Tally Audit: the period's vouchers, who entered and altered them, and their audit status. Space selects; A audits, O puts under observation, C clears. */
export function TallyAuditView() {
  const { company, period, version, changed, push, user } = useApp()
  const { data, error } = useLoad(() => api.tallyAudit(company.id, period), [company.id, period, version])
  const [show, setShow] = useState<string>('')
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [note, setNote] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  useEffect(() => setPicked(new Set()), [data])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const rows = data.vouchers.filter((v) => !show || v.status === show)
  const mark = async (status: 'Audited' | 'Under Observation' | null) => {
    setErrors([])
    try {
      await api.setAudit(company.id, [...picked].map((voucherId) => ({ voucherId, status, note })))
      setNote('')
      changed()
    } catch (e) {
      setErrors(messages(e))
    }
  }
  const toggle = (v: AuditRow) =>
    setPicked((p) => {
      const n = new Set(p)
      if (n.has(v.voucherId)) n.delete(v.voucherId)
      else n.add(v.voucherId)
      return n
    })
  const s = data.summary
  return (
    <div>
      <Title right={periodNote(data)}>Tally Audit</Title>
      <p>
        {s.total} vouchers · <b>{s.notAudited}</b> not audited · {s.audited} audited · {s.underObservation} under observation · <b className={s.alteredAfterAudit ? 'errors-inline' : ''}>{s.alteredAfterAudit}</b> altered after audit
        {user ? <span className="muted"> · auditing as {user.username}</span> : null}
      </p>
      <div className="inline">
        <label>
          Show
          <select value={show} onChange={(e) => setShow(e.target.value)} aria-label="Show">
            <option value="">All</option>
            {STATUSES.map((x) => <option key={x}>{x}</option>)}
          </select>
        </label>
        <label>
          Note
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="for the vouchers marked" aria-label="Audit note" />
        </label>
        <button type="button" disabled={!picked.size} onClick={() => mark('Audited')}>Mark audited ({picked.size})</button>
        <button type="button" disabled={!picked.size} onClick={() => mark('Under Observation')}>Under observation</button>
        <button type="button" disabled={!picked.size} onClick={() => mark(null)}>Clear the mark</button>
      </div>
      <Errors errors={errors} />
      <table className="report">
        <thead>
          <tr>
            <th><input type="checkbox" aria-label="Select all" checked={rows.length > 0 && rows.every((v) => picked.has(v.voucherId))}
              onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((v) => v.voucherId)) : new Set())} /></th>
            <th>Date</th><th>Vch Type</th><th>Vch No.</th><th className="num">Amount</th><th>Entered by</th><th>Last altered</th><th>Status</th><th>Auditor</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => (
            <tr key={v.voucherId} className={picked.has(v.voucherId) ? 'sel' : undefined}>
              <td><input type="checkbox" checked={picked.has(v.voucherId)} onChange={() => toggle(v)} aria-label={`Select ${v.type} ${v.docNo}`} /></td>
              <td className="clickable" onClick={() => push({ k: 'voucher', type: v.type as never, id: v.voucherId })}>{fmtDate(v.date)}</td>
              <td>{v.type}</td><td>{v.docNo}</td><td className="num">{amt(v.amount)}</td>
              <td>{v.createdBy ?? <span className="muted">—</span>}{v.createdAt ? <div className="muted small">{fmtDate(v.createdAt.slice(0, 10))}</div> : null}</td>
              <td>{v.alteredBy ? <>{v.alteredBy}<div className="muted small">{fmtDate(v.alteredAt!.slice(0, 10))} · {v.alterations}×</div></> : <span className="muted">never</span>}</td>
              <td className={v.status === 'Altered after audit' ? 'errors-inline' : v.status === 'Audited' ? 'ok' : undefined}>
                {v.status}{v.mark?.note ? <div className="muted small">{v.mark.note}</div> : null}
              </td>
              <td>{v.mark ? <>{v.mark.auditor}<div className="muted small">{fmtDate(v.mark.at.slice(0, 10))}</div></> : ''}</td>
            </tr>
          ))}
          {!rows.length && <tr className="muted"><td colSpan={9}>None</td></tr>}
        </tbody>
      </table>
      <p className="muted">A mark is on the voucher as it stood; altering it afterwards shows "Altered after audit" (the Edit Log has what changed).</p>
    </div>
  )
}

/** POS Register: the POS vouchers of the period, how each was paid, and the day's totals. */
export function PosRegisterView() {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.posRegister(company.id, period), [company.id, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={periodNote(data)}>POS Register</Title>
      <table className="report">
        <thead><tr><th>Date</th><th>Vch Type</th><th>Vch No.</th><th>Party</th><th className="num">Cash</th><th className="num">Card / bank</th><th className="num">Credit</th><th className="num">Total</th></tr></thead>
        <tbody>
          {data.vouchers.map((v) => (
            <tr key={v.voucherId} className="clickable" onClick={() => push({ k: 'voucher', type: 'Sales', id: v.voucherId })}>
              <td>{fmtDate(v.date)}</td><td>{v.voucherType}</td><td>{v.docNo}</td><td>{v.party ?? ''}</td>
              <td className="num">{amt(v.cash)}</td><td className="num">{amt(v.bank)}</td><td className="num">{amt(v.credit)}</td><td className="num">{amt(v.total)}</td>
            </tr>
          ))}
          {!data.vouchers.length && <tr className="muted"><td colSpan={8}>No POS vouchers. Mark a Sales voucher type "Use for POS invoicing" (Alter, Voucher Type).</td></tr>}
        </tbody>
        <tfoot><tr><td colSpan={4}>Total ({data.total.count})</td><td className="num total">{amt(data.total.cash)}</td><td className="num total">{amt(data.total.bank)}</td><td className="num total">{amt(data.total.credit)}</td><td className="num total">{amt(data.total.total)}</td></tr></tfoot>
      </table>
      {data.days.length > 1 && (
        <>
          <h3 className="sub">By day</h3>
          <table className="report">
            <thead><tr><th>Date</th><th className="num">Bills</th><th className="num">Cash</th><th className="num">Card / bank</th><th className="num">Credit</th><th className="num">Total</th></tr></thead>
            <tbody>{data.days.map((d) => <tr key={d.date}><td>{fmtDate(d.date)}</td><td className="num">{d.count}</td><td className="num">{amt(d.cash)}</td><td className="num">{amt(d.bank)}</td><td className="num">{amt(d.credit)}</td><td className="num">{amt(d.total)}</td></tr>)}</tbody>
          </table>
        </>
      )}
    </div>
  )
}

const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' })

/** Sales or Purchase Order analysis: what was ordered each month, by item or by party, and what is delivered and pending. */
export function OrderAnalysisView({ type }: { type: 'Sales Order' | 'Purchase Order' }) {
  const { company, period, version } = useApp()
  const [by, setBy] = useState<'item' | 'party'>('item')
  const { data, error } = useLoad(() => api.orderAnalysis(company.id, type, period, by), [company.id, type, period, by, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const q = (n: number, d: number) => qtyField(n, { decimals: d })
  return (
    <div>
      <Title right={periodNote(data)}>{type === 'Sales Order' ? 'Sales' : 'Purchase'} Order Analysis</Title>
      <label className="inline">
        By
        <select value={by} onChange={(e) => setBy(e.target.value as 'item')} aria-label="By">
          <option value="item">Stock item</option>
          <option value="party">Party</option>
        </select>
      </label>
      <table className="report">
        <thead>
          <tr>
            <th>{by === 'item' ? 'Item' : 'Party'}</th>
            {data.months.map((m) => <th key={m} className="num">{monthName(m)}</th>)}
            <th className="num">Ordered</th>{by === 'item' && <><th className="num">Delivered</th><th className="num">Pending</th></>}<th className="num">Pending value</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.key}>
              <td>{r.key}<div className="muted small">{r.orders} order lines</div></td>
              {data.months.map((m) => <td key={m} className="num">{r.byMonth[m] ? amt(r.byMonth[m].value) : ''}{by === 'item' && r.byMonth[m] ? <div className="muted small">{q(r.byMonth[m].qty, r.decimals)} {r.unit}</div> : null}</td>)}
              <td className="num">{amt(r.value)}</td>
              {by === 'item' && <><td className="num">{q(r.done, r.decimals)} {r.unit}</td><td className="num">{r.pending ? <b>{q(r.pending, r.decimals)} {r.unit}</b> : ''}</td></>}
              <td className="num">{amt(r.pendingValue)}</td>
            </tr>
          ))}
          {!data.rows.length && <tr className="muted"><td colSpan={data.months.length + 5}>No orders in this period</td></tr>}
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            {data.months.map((m) => <td key={m} className="num total">{amt(data.total.byMonth[m])}</td>)}
            <td className="num total">{amt(data.total.value)}</td>{by === 'item' && <><td /><td /></>}<td className="num total">{amt(data.total.pendingValue)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="muted">Orders dated in the period; delivered counts what was delivered or invoiced against them up to the period's end.</p>
    </div>
  )
}

/** Tracked vouchers: delivery and receipt notes not yet (fully) invoiced, as of the period's end. */
export function TrackedVouchersView() {
  const { company, period, version, push } = useApp()
  const { data: out, error: e1 } = useLoad(() => api.pending(company.id, 'Delivery Note', { asOf: period.to }), [company.id, period.to, version])
  const { data: inn, error: e2 } = useLoad(() => api.pending(company.id, 'Receipt Note', { asOf: period.to }), [company.id, period.to, version])
  if (e1 || e2) return <Errors errors={[(e1 ?? e2)!]} />
  if (!out || !inn) return <p className="muted">Loading…</p>
  const age = (d: string) => Math.max(0, Math.round((Date.parse(period.to) - Date.parse(d)) / 86_400_000))
  const table = (title: string, lines: PendingLine[], done: string) => (
    <>
      <h3 className="sub">{title}</h3>
      <table className="report">
        <thead><tr><th>Date</th><th>Note No.</th><th>Party</th><th>Item</th><th className="num">Quantity</th><th className="num">{done}</th><th className="num">Not invoiced</th><th className="num">Value</th><th className="num">Days</th></tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr key={`${l.voucherId}/${l.itemId}`} className="clickable" onClick={() => push({ k: 'voucher', type: l.type, id: l.voucherId })}>
              <td>{fmtDate(l.date)}</td><td>{l.docNo ?? l.number}</td><td>{l.party}</td><td>{l.item}</td>
              <td className="num">{qtyField(l.ordered, l)} {l.unit}</td><td className="num">{l.done ? `${qtyField(l.done, l)} ${l.unit}` : ''}</td>
              <td className="num"><b>{qtyField(l.pending, l)} {l.unit}</b></td><td className="num">{amt(l.value)}</td><td className="num">{age(l.date)}</td>
            </tr>
          ))}
          {!lines.length && <tr className="muted"><td colSpan={9}>None: every note is invoiced</td></tr>}
        </tbody>
      </table>
    </>
  )
  return (
    <div>
      <Title right={<span className="muted">as on {fmtDate(period.to)}</span>}>Tracked Vouchers</Title>
      {table('Delivery notes not yet invoiced (goods out, no sales invoice)', out.lines, 'Invoiced')}
      {table('Receipt notes not yet invoiced (goods in, no purchase invoice)', inn.lines, 'Invoiced')}
    </div>
  )
}
