import { useEffect, useRef, useState } from 'react'
import { useApp } from '../App'
import { api, type GstReco } from '../api'
import { amt as unsigned, Errors, fmtDate, Title, enterAdvances, useLoad } from '../ui'
import { messages, rateText, useSubmit } from './Masters'
import { periodNote } from './Books'
import { gstinError } from '../../server/src/engine/gst'
import { RegistrationPick, currentRegistration } from './Gst'

/** GST beyond the monthly returns: reconciliations with the portal, IMS, advances, GSTR-9, CMP-08, GSTR-4, challans, party GSTINs. */

// differences, credit notes and net advances can be negative: shown with a minus sign
const amt = (p: number) => (p < 0 ? `-${unsigned(-p)}` : unsigned(p))
const tax = (x: { igst: number; cgst: number; sgst: number }) => x.igst + x.cgst + x.sgst
const fyOfPeriod = (from: string) => `${from.slice(5) >= '04-01' ? from.slice(0, 4) : Number(from.slice(0, 4)) - 1}-04-01`

/** Upload a JSON file downloaded from the GST portal. */
function Upload({ label, onFile }: { label: string; onFile: (json: unknown) => Promise<void> }) {
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  return (
    <div className="inline">
      <label>
        {label}
        <input type="file" accept=".json,application/json" disabled={busy} aria-label={label}
          onChange={async (e) => {
            const f = e.target.files?.[0]
            if (!f) return
            setErrors([])
            setBusy(true)
            try {
              await onFile(JSON.parse(await f.text()))
            } catch (err) {
              setErrors(err instanceof SyntaxError ? ['The file is not JSON'] : messages(err))
            } finally {
              setBusy(false)
              e.target.value = ''
            }
          }} />
      </label>
      <Errors errors={errors} />
    </div>
  )
}

/** GSTR-2B (inward, with IMS actions) or GSTR-1 (outward) against the books for a month. */
export function GstRecoView({ source }: { source: '2B' | 'GSTR-1' }) {
  const { company, period, version, changed, push } = useApp()
  const [month, setMonth] = useState(period.from.slice(0, 7))
  const [reg, setReg] = useState(currentRegistration)
  const { data, error } = useLoad(() => (source === '2B' ? api.gstr2bReco(company.id, month, reg) : api.gstr1Reco(company.id, month, reg)), [company.id, month, version, source, reg])
  const [actions, setActions] = useState<Record<number, 'Accepted' | 'Rejected' | 'Pending'>>({})
  const [filter, setFilter] = useState('')
  useEffect(() => setActions({}), [data])
  const { errors, ok, submit } = useSubmit(async () => {
    const items = Object.entries(actions).map(([id, action]) => ({ id: Number(id), action }))
    if (!items.length) return 'Nothing changed'
    await api.setIms(company.id, items)
    changed()
    return `${items.length} action${items.length > 1 ? 's' : ''} saved`
  })
  const title = source === '2B' ? 'GSTR-2B Reconciliation' : 'GSTR-1 Reconciliation'
  const rows: GstReco['rows'] = data?.rows.filter((r) => !filter || r.status === filter) ?? []
  return (
    <form onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || <><RegistrationPick value={reg} onChange={setReg} /> <span className="muted">{source === '2B' ? 'IMS actions: Ctrl+A saves' : 'as filed on the portal'}</span></>}>{title}</Title>
      <div className="inline">
        <label>
          Month
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="Month" />
        </label>
        <Upload label={source === '2B' ? 'Upload GSTR-2B (JSON from the portal)' : 'Upload GSTR-1 as filed (JSON)'}
          onFile={async (json) => {
            const r = await api.uploadPortal(company.id, source, json)
            setMonth(r.month)
            changed()
          }} />
      </div>
      {error && <Errors errors={[error]} />}
      {data && !data.uploaded && <p className="muted">No {source} uploaded for {month} yet. Download it from the GST portal (Returns, {source === '2B' ? 'GSTR-2B' : 'GSTR-1, View/Download'}) and upload the JSON.</p>}
      {data && (
        <>
          <p>
            <b>{data.summary.matched}</b> matched · <b>{data.summary.mismatched}</b> mismatched · <b>{data.summary.notInBooks}</b> not in the books · <b>{data.summary.notOnPortal}</b> not on the portal
            {data.summary.acceptedTax && <> · credit as accepted in IMS: <b>{amt(tax(data.summary.acceptedTax))}</b> ({data.summary.pending} pending)</>}
          </p>
          <label className="inline">
            Show
            <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Show">
              <option value="">All</option>
              <option>Matched</option>
              <option>Mismatch</option>
              <option>Not in books</option>
            </select>
          </label>
          <table className="report">
            <thead>
              <tr>
                <th>GSTIN</th><th>Party</th><th>Document</th><th>Date</th><th className="num">Taxable (portal)</th><th className="num">Tax (portal)</th>
                <th className="num">Taxable (books)</th><th className="num">Tax (books)</th><th>Status</th>{source === '2B' && <th>IMS</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.portal.gstin}</td>
                  <td>{r.books?.party ?? r.portal.party}</td>
                  <td>{r.portal.docType === 'Invoice' ? '' : `${r.portal.docType} `}{r.portal.docNo}</td>
                  <td>{fmtDate(r.portal.docDate)}</td>
                  <td className="num">{amt(r.portal.taxable)}</td>
                  <td className="num">{amt(tax(r.portal))}</td>
                  <td className="num">{r.books ? amt(r.books.taxable) : ''}</td>
                  <td className="num">{r.books ? amt(tax(r.books)) : ''}</td>
                  <td>
                    {r.books ? <span className="clickable" onClick={() => push({ k: 'voucher', type: r.books!.type as never, id: r.books!.voucherId })}>{r.status}</span> : r.status}
                    {r.differences.length > 0 && <div className="errors-inline small">differs: {r.differences.join(', ')}</div>}
                  </td>
                  {source === '2B' && (
                    <td>
                      <select value={actions[r.id] ?? r.imsAction} onChange={(e) => setActions((a) => ({ ...a, [r.id]: e.target.value as 'Accepted' }))} aria-label={`IMS ${r.portal.docNo}`}>
                        <option>Pending</option>
                        <option>Accepted</option>
                        <option>Rejected</option>
                      </select>
                    </td>
                  )}
                </tr>
              ))}
              {!rows.length && <tr className="muted"><td colSpan={10}>None</td></tr>}
            </tbody>
          </table>
          {data.notOnPortal.length > 0 && (
            <>
              <h3 className="sub">In the books, not in {source}</h3>
              <table className="report">
                <thead><tr><th>Date</th><th>Vch</th><th>Document</th><th>Party</th><th>GSTIN</th><th className="num">Taxable</th><th className="num">Tax</th></tr></thead>
                <tbody>
                  {data.notOnPortal.map((b) => (
                    <tr key={b.voucherId} className="clickable" onClick={() => push({ k: 'voucher', type: b.type as never, id: b.voucherId })}>
                      <td>{fmtDate(b.date)}</td><td>{b.type}</td><td>{b.docNo}</td><td>{b.party}</td><td>{b.gstin}</td><td className="num">{amt(b.taxable)}</td><td className="num">{amt(tax(b))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <p className="muted">
            {source === '2B'
              ? "Purchases match on the supplier's GSTIN and invoice number (Supplier Invoice No. on the voucher), ignoring spaces, slashes, dashes and leading zeros. Reject in IMS what you did not receive; its credit is left out."
              : 'Invoices and credit notes to registered parties match on GSTIN and number.'}
          </p>
          <Errors errors={errors} />
          {source === '2B' && <div className="actions"><button type="submit" className="primary"><b>Ctrl+A</b> Save IMS actions</button></div>}
        </>
      )}
    </form>
  )
}

/** Advances received for services (GSTR-1 11A and 11B). */
export function GstAdvancesView() {
  const { company, period, version } = useApp()
  const [reg, setReg] = useState(currentRegistration)
  const { data, error } = useLoad(() => api.gstAdvances(company.id, period, reg), [company.id, period, version, reg])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const table = (rows: typeof data.received, what: 'unadjusted' | 'adjusted') => (
    <table className="report">
      <thead><tr><th>Date</th><th>Vch No.</th><th>Party</th><th>Advance</th><th className="num">Rate</th><th className="num">{what === 'unadjusted' ? 'Unadjusted' : 'Adjusted'}</th><th className="num">Taxable</th><th className="num">Tax</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.voucherId}/${r.bill}`}>
            <td>{fmtDate(r.date)}</td><td>{r.docNo}</td><td>{r.party}</td><td>{r.bill}</td><td className="num">{rateText(r.rate)}%</td>
            <td className="num">{amt(r.unadjusted ?? r.adjusted ?? 0)}</td><td className="num">{amt(r.taxable)}</td><td className="num">{amt(tax(r))}</td>
          </tr>
        ))}
        {!rows.length && <tr className="muted"><td colSpan={8}>None</td></tr>}
      </tbody>
    </table>
  )
  return (
    <div>
      <Title right={<><RegistrationPick value={reg} onChange={setReg} /> {periodNote(data)}</>}>Advances (GSTR-1 tables 11A and 11B)</Title>
      <h3 className="sub">11A: received in the period, not yet invoiced</h3>
      {table(data.received, 'unadjusted')}
      <h3 className="sub">11B: received earlier, adjusted by invoices in the period</h3>
      {table(data.adjusted, 'adjusted')}
      <p>Net tax on advances added to GSTR-3B 3.1(a): <b>{amt(tax(data.totals.net))}</b> on {amt(data.totals.net.taxable)}</p>
      <p className="muted">A Receipt is an advance when its party's bill is an Advance and the voucher has the GST rate of the services (the Advance GST rate field). The invoice adjusts it by Agst Ref to the advance.</p>
    </div>
  )
}

const T3 = ({ x }: { x: { igst: number; cgst: number; sgst: number } }) => (
  <>
    <td className="num">{amt(x.igst)}</td><td className="num">{amt(x.cgst)}</td><td className="num">{amt(x.sgst)}</td>
  </>
)

/** GSTR-9, the annual return. */
export function Gstr9View() {
  const { company, period, version } = useApp()
  const fy = fyOfPeriod(period.from)
  const [reg, setReg] = useState(currentRegistration)
  const { data, error } = useLoad(() => api.gstr9(company.id, fy, reg), [company.id, fy, version, reg])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const row = (label: string, x: { taxable?: number; igst: number; cgst: number; sgst: number }) => (
    <tr><td>{label}</td><td className="num">{x.taxable !== undefined ? amt(x.taxable) : ''}</td><T3 x={x} /></tr>
  )
  return (
    <div>
      <Title right={<><RegistrationPick value={reg} onChange={setReg} /> <span className="muted">{fmtDate(data.from)} to {fmtDate(data.to)} · {data.gstin}</span></>}>GSTR-9 Annual Return</Title>
      {data.attention > 0 && <p className="errors-inline">{data.attention} invoices need attention in GSTR-1 first.</p>}
      <table className="report">
        <thead><tr><th>Pt. II, 4: outward supplies on which tax is payable</th><th className="num">Taxable</th><th className="num">IGST</th><th className="num">CGST</th><th className="num">SGST</th></tr></thead>
        <tbody>
          {row('4A Supplies to unregistered persons (B2C)', data.t4.b2c)}
          {row('4B Supplies to registered persons (B2B)', data.t4.b2b)}
          {row('4C Exports with payment of tax', data.t4.exportsWithTax)}
          {row('4F Advances on which tax was paid, not yet invoiced', data.t4.advances)}
          {row('4I Credit notes (less)', data.t4.creditNotes)}
          {row('4N Total', data.t4.total)}
        </tbody>
      </table>
      <table className="report">
        <thead><tr><th>5: supplies on which tax is not payable</th><th className="num">Value</th></tr></thead>
        <tbody>
          <tr><td>5A Exports without payment of tax</td><td className="num">{amt(data.t5.exportsWithoutTax)}</td></tr>
          <tr><td>5D/5E Exempted and nil rated</td><td className="num">{amt(data.t5.nilExempt)}</td></tr>
          <tr><td>5F Non-GST supplies</td><td className="num">{amt(data.t5.nonGst)}</td></tr>
        </tbody>
      </table>
      <table className="report">
        <thead><tr><th>Pt. III, 6-8: input tax credit</th><th /><th className="num">IGST</th><th className="num">CGST</th><th className="num">SGST</th></tr></thead>
        <tbody>
          {row('6B Inward supplies (other than imports and reverse charge)', data.t6.inputs)}
          {row('6C/6D Inward supplies under reverse charge', data.t6.rcm)}
          {row('6 Total availed in GSTR-3B', data.t6.availed)}
          {row('7 Reversed', data.t6.reversed)}
          {row('Reclaimed', data.t6.reclaimed)}
          {row('Net ITC available', data.t6.net)}
          {row('8A ITC as per GSTR-2B (accepted in IMS)', data.t8.as2b)}
          {row('8D Difference (8A less 6B)', data.t8.difference)}
        </tbody>
      </table>
      {!data.t8.uploaded2b && <p className="muted">No GSTR-2B uploaded for the year: 8A is empty (GST Reports, GSTR-2B Reconciliation).</p>}
      <table className="report">
        <thead><tr><th>Pt. IV, 9: tax paid</th><th /><th className="num">IGST</th><th className="num">CGST</th><th className="num">SGST</th></tr></thead>
        <tbody>
          {row('Tax payable', data.t9.payable)}
          {row('Paid through ITC', data.t9.byItc)}
          {row('Paid in cash', data.t9.cash)}
        </tbody>
      </table>
      {(['t17', 't18'] as const).map((k) => (
        <table className="report" key={k}>
          <thead><tr><th>{k === 't17' ? '17 HSN summary of outward supplies' : '18 HSN summary of inward supplies'}</th><th className="num">Rate</th><th className="num">Taxable</th><th className="num">IGST</th><th className="num">CGST</th><th className="num">SGST</th></tr></thead>
          <tbody>
            {data[k].map((h) => (
              <tr key={`${h.hsn}/${h.rate}/${h.uqc}`}><td>{h.hsn || <span className="errors-inline">no HSN</span>}</td><td className="num">{rateText(h.rate)}%</td><td className="num">{amt(h.taxable)}</td><T3 x={h} /></tr>
            ))}
          </tbody>
        </table>
      ))}
      <p className="muted">Built from the year's GSTR-1 and the twelve months' GSTR-3B; file it on the portal (or with your GST practitioner) after checking these against the returns filed.</p>
    </div>
  )
}

/** CMP-08 for a quarter and GSTR-4 for the year: a composition dealer's returns. Keys 1-4 pick the quarter. */
export function CompositionView({ annual }: { annual?: boolean }) {
  const { company, period, version } = useApp()
  const fy = fyOfPeriod(period.from)
  const [quarter, setQuarter] = useState(() => {
    const m = Number(period.from.slice(5, 7))
    return m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 ? 3 : 4
  })
  const { data: q, error: qe } = useLoad(() => (annual ? Promise.resolve(null) : api.cmp08(company.id, fy, quarter)), [company.id, fy, quarter, version, annual])
  const { data: y, error: ye } = useLoad(() => (annual ? api.gstr4(company.id, fy) : Promise.resolve(null)), [company.id, fy, version, annual])
  const ref = useRef(setQuarter)
  ref.current = setQuarter
  useEffect(() => {
    if (annual) return
    const onKey = (e: KeyboardEvent) => {
      if (['1', '2', '3', '4'].includes(e.key) && !(e.target as HTMLElement).closest('input, select')) ref.current(Number(e.key))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [annual])
  const error = qe ?? ye
  if (error) return <Errors errors={[error]} />
  if (!annual && q)
    return (
      <div>
        <Title right={<span className="muted">keys 1-4 quarter · {fmtDate(q.from)} to {fmtDate(q.to)}</span>}>CMP-08: Q{q.quarter}</Title>
        <table className="report">
          <thead><tr><th>Description</th><th className="num">Value</th><th className="num">IGST</th><th className="num">CGST</th><th className="num">SGST</th></tr></thead>
          <tbody>
            <tr><td>Outward supplies (exempt included) at {rateText(q.rate)}%</td><td className="num">{amt(q.turnover)}</td><td /><td className="num">{amt(q.outward.cgst)}</td><td className="num">{amt(q.outward.sgst)}</td></tr>
            <tr><td>Inward supplies under reverse charge</td><td /><T3 x={q.rcm} /></tr>
            <tr className="total"><td>Tax payable</td><td /><T3 x={q.payable} /></tr>
          </tbody>
        </table>
      </div>
    )
  if (annual && y)
    return (
      <div>
        <Title right={<span className="muted">{fmtDate(y.from)} to {fmtDate(y.to)}</span>}>GSTR-4 Annual Return</Title>
        <table className="report">
          <thead><tr><th>4A/4B Inward supplies from registered suppliers</th><th>GSTIN</th><th className="num">Taxable</th><th className="num">IGST</th><th className="num">CGST</th><th className="num">SGST</th></tr></thead>
          <tbody>
            {[...y.t4a, ...y.t4b].map((r) => (
              <tr key={`${r.gstin}/${r.rcm}`}><td>{r.party}{r.rcm ? ' (reverse charge)' : ''}</td><td>{r.gstin}</td><td className="num">{amt(r.taxable)}</td><T3 x={r} /></tr>
            ))}
            <tr><td>4C From unregistered suppliers, reverse charge</td><td /><td className="num">{amt(y.t4c.taxable)}</td><T3 x={y.t4c} /></tr>
          </tbody>
        </table>
        <table className="report">
          <thead><tr><th>5 CMP-08 of the year</th><th className="num">Turnover</th><th className="num">CGST</th><th className="num">SGST</th></tr></thead>
          <tbody>
            {y.t5.map((c) => <tr key={c.quarter}><td>Q{c.quarter}</td><td className="num">{amt(c.turnover)}</td><td className="num">{amt(c.cgst)}</td><td className="num">{amt(c.sgst)}</td></tr>)}
            <tr className="total"><td>6 Outward supplies at {rateText(y.t6.rate)}%</td><td className="num">{amt(y.t6.turnover)}</td><td className="num">{amt(y.t6.cgst)}</td><td className="num">{amt(y.t6.sgst)}</td></tr>
          </tbody>
        </table>
      </div>
    )
  return <p className="muted">Loading…</p>
}

/** GST Challan Reconciliation: GST paid in the period, its challans (CPIN, CIN, date), against GSTR-3B's cash. */
export function GstChallansView() {
  const { company, period, version, changed } = useApp()
  const { data, error } = useLoad(() => api.gstChallans(company.id, period), [company.id, period, version])
  const [edits, setEdits] = useState<Record<number, { cpin: string; cin: string; depositDate: string }>>({})
  useEffect(() => setEdits({}), [data])
  const { errors, ok, submit } = useSubmit(async () => {
    const items = Object.entries(edits).map(([id, c]) => ({ voucherId: Number(id), challan: c.cpin || c.cin || c.depositDate ? { ...c, cin: c.cin || null } : null }))
    if (!items.length) return 'Nothing changed'
    await api.setGstChallans(company.id, items)
    changed()
    return `${items.length} challan${items.length > 1 ? 's' : ''} saved`
  })
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const value = (p: (typeof data.payments)[number]) => edits[p.voucherId] ?? { cpin: p.challan?.cpin ?? '', cin: p.challan?.cin ?? '', depositDate: p.challan?.depositDate ?? '' }
  const set = (p: (typeof data.payments)[number], patch: Partial<{ cpin: string; cin: string; depositDate: string }>) => setEdits((e) => ({ ...e, [p.voucherId]: { ...value(p), ...patch } }))
  return (
    <form onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || periodNote(data)}>GST Challan Reconciliation</Title>
      <table className="report">
        <thead><tr><th>Date</th><th>Vch No.</th><th className="num">IGST</th><th className="num">CGST</th><th className="num">SGST</th><th className="num">Cess</th><th>CPIN</th><th>CIN</th><th>Deposited on</th></tr></thead>
        <tbody>
          {data.payments.map((p) => {
            const c = value(p)
            return (
              <tr key={p.voucherId}>
                <td>{fmtDate(p.date)}</td><td>{p.docNo}</td><td className="num">{amt(p.igst)}</td><td className="num">{amt(p.cgst)}</td><td className="num">{amt(p.sgst)}</td><td className="num">{amt(p.cess)}</td>
                <td><input inputMode="numeric" size={15} value={c.cpin} onChange={(e) => set(p, { cpin: e.target.value.trim() })} aria-label={`CPIN ${p.docNo}`} /></td>
                <td><input size={18} value={c.cin} onChange={(e) => set(p, { cin: e.target.value.trim().toUpperCase() })} aria-label={`CIN ${p.docNo}`} /></td>
                <td><input type="date" value={c.depositDate} onChange={(e) => set(p, { depositDate: e.target.value })} aria-label={`Deposited on ${p.docNo}`} /></td>
              </tr>
            )
          })}
          {!data.payments.length && <tr className="muted"><td colSpan={9}>No GST paid in this period (a Payment debiting the GST ledgers)</td></tr>}
        </tbody>
        <tfoot>
          <tr><td colSpan={2}>Paid</td><T3 x={data.paid} /><td colSpan={4} /></tr>
          <tr><td colSpan={2}>GSTR-3B: to pay in cash</td><T3 x={data.due} /><td colSpan={4} /></tr>
          <tr><td colSpan={2}>Difference</td><T3 x={data.difference} /><td colSpan={4} /></tr>
        </tfoot>
      </table>
      <Errors errors={errors} />
      <div className="actions"><button type="submit" className="primary"><b>Ctrl+A</b> Save challans</button></div>
    </form>
  )
}

/** Party GSTIN Update: the GSTIN of every party at once; the state and PAN follow it. */
export function GstPartiesView() {
  const { company, version, changed } = useApp()
  const { data, error } = useLoad(() => api.gstParties(company.id), [company.id, version])
  const [edits, setEdits] = useState<Record<number, string>>({})
  const [missingOnly, setMissingOnly] = useState(false)
  useEffect(() => setEdits({}), [data])
  const { errors, ok, submit } = useSubmit(async () => {
    const items = Object.entries(edits).map(([id, gstin]) => ({ ledgerId: Number(id), gstin: gstin.trim() || null, state: data?.find((p) => p.ledgerId === Number(id))?.state ?? null }))
    if (!items.length) return 'Nothing changed'
    await api.setGstParties(company.id, items.map((i) => (i.gstin ? { ...i, state: null } : i)))
    changed()
    return `GSTIN of ${items.length} part${items.length > 1 ? 'ies' : 'y'} saved`
  })
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const rows = data.filter((p) => !missingOnly || !p.gstin)
  return (
    <form onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || <span className="muted">{Object.keys(edits).length} changed · Ctrl+A saves</span>}>Party GSTIN Update</Title>
      <label className="inline">
        Show
        <select value={missingOnly ? 'missing' : 'all'} onChange={(e) => setMissingOnly(e.target.value === 'missing')} aria-label="Show">
          <option value="all">All parties</option>
          <option value="missing">Parties without a GSTIN</option>
        </select>
      </label>
      <table className="report">
        <thead><tr><th>Party</th><th>Group</th><th>GSTIN/UIN</th><th>State</th><th>PAN</th></tr></thead>
        <tbody>
          {rows.map((p) => {
            const g = edits[p.ledgerId] ?? p.gstin ?? ''
            const bad = g.trim() ? gstinError(g.trim().toUpperCase()) : null
            return (
              <tr key={p.ledgerId}>
                <td>{p.name}</td><td className="muted">{p.group}</td>
                <td>
                  <input size={17} value={g} onChange={(e) => setEdits((x) => ({ ...x, [p.ledgerId]: e.target.value.toUpperCase() }))} aria-label={`GSTIN of ${p.name}`} />
                  {bad && <div className="errors-inline small">{bad}</div>}
                </td>
                <td>{p.state ?? <span className="muted">—</span>}</td><td>{p.pan ?? <span className="muted">—</span>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <Errors errors={errors} />
      <div className="actions"><button type="submit" className="primary"><b>Ctrl+A</b> Save</button></div>
    </form>
  )
}
