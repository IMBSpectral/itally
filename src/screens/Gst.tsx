import { useEffect, useState } from 'react'
import { useApp } from '../App'
import { api, ApiError } from '../api'
import { gstinError, stateCode, stateName } from '../../server/src/engine/gst'
import type { InvoiceRow, TaxSum } from '../../server/src/engine/gst-returns'
import { amt as unsigned, Errors, fmtDate, Picker, Title, enterAdvances, useActive, useLoad } from '../ui'
import { messages, STATE_OPTIONS, useSubmit } from './Masters'
import { periodNote } from './Books'

/** An amount in a return, with its sign: notes or reversals can take a figure below zero. */
const amt = (p: number) => (p < 0 ? `-${unsigned(-p)}` : unsigned(p))

const rate = (r: number) => `${r / 100}%`
const taxCells = (t: TaxSum) => (
  <>
    <td className="num">{amt(t.taxable)}</td>
    <td className="num">{amt(t.igst)}</td>
    <td className="num">{amt(t.cgst)}</td>
    <td className="num">{amt(t.sgst)}</td>
  </>
)
const taxHeads = (
  <>
    <th className="num">Taxable Value</th>
    <th className="num">IGST</th>
    <th className="num">CGST</th>
    <th className="num">SGST/UTGST</th>
  </>
)

/** The company's GST registration: GSTIN and state. Returns and tax on invoices start once it is set. */
/** GSTR-1 table 8 rows, as the portal names them. */
const NIL_SUPPLY = {
  INTRB2B: 'Inter-State supplies to registered persons',
  INTRAB2B: 'Intra-State supplies to registered persons',
  INTRB2C: 'Inter-State supplies to unregistered persons',
  INTRAB2C: 'Intra-State supplies to unregistered persons',
} as const

export function GstRegistration() {
  const { company, changed, pop } = useApp()
  const [gstin, setGstin] = useState('')
  const [stateId, setStateId] = useState<number | null>(null)
  const [gstType, setGstType] = useState<'Regular' | 'Composition'>('Regular')
  const [compositionRate, setCompositionRate] = useState('1')
  useEffect(() => {
    api.company(company.id).then((c) => {
      setGstin(c.gstin ?? '')
      setGstType(c.gstType ?? 'Regular')
      if (c.compositionRate) setCompositionRate(String(c.compositionRate / 100))
      setStateId(stateCode(c.state) ? Number(stateCode(c.state)) : null)
    })
  }, [company.id])
  const { errors, ok, submit } = useSubmit(async () => {
    await api.setGst(company.id, {
      gstin: gstin.trim() || null, state: stateId === null ? null : (stateName(String(stateId).padStart(2, '0')) ?? null), gstType,
      compositionRate: gstType === 'Composition' ? Math.round(Number(compositionRate) * 100) : null,
    })
    changed()
    pop()
    return ''
  })
  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={ok && <span className="ok">{ok}</span>}>GST Registration</Title>
      <label>
        GSTIN/UIN
        <input
          autoFocus
          value={gstin}
          onChange={(e) => setGstin(e.target.value.toUpperCase())}
          onBlur={() => !gstinError(gstin) && setStateId(Number(gstin.slice(0, 2)))}
          aria-label="GSTIN"
        />
        {gstin.trim() && gstinError(gstin) && <span className="muted">{gstinError(gstin)}</span>}
      </label>
      <label>
        State
        <Picker options={STATE_OPTIONS} value={stateId} onChange={setStateId} placeholder="State" />
      </label>
      <div className="inline">
        <label>
          Registration type
          <select value={gstType} onChange={(e) => setGstType(e.target.value as 'Regular')} aria-label="Registration type">
            <option>Regular</option>
            <option>Composition</option>
          </select>
        </label>
        {gstType === 'Composition' && (
          <label>
            Composition rate (%, CGST and SGST together)
            <input className="amount" inputMode="decimal" value={compositionRate} onChange={(e) => setCompositionRate(e.target.value)} aria-label="Composition rate" />
          </label>
        )}
      </div>
      <p className="muted">
        With a GSTIN, invoices work out CGST + SGST within the state and IGST across states, and the GST reports fill in. Create tax ledgers under Duties &amp; Taxes (tax type IGST, CGST, SGST) and give items and service ledgers their HSN/SAC and rate.
      </p>
      <Errors errors={errors} />
      <div className="actions">
        <button type="submit" className="primary">
          <b>Enter</b> Save
        </button>
      </div>
      <FurtherRegistrations />
    </form>
  )
}

/** Further GST registrations of the company (a branch in another state): a voucher type then belongs to one (Alter, Voucher Type). */
function FurtherRegistrations() {
  const { company, version, changed } = useApp()
  const { data } = useLoad(() => api.gstRegistrations(company.id), [company.id, version])
  const [name, setName] = useState('')
  const [gstin, setGstin] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const run = (p: Promise<unknown>) => p.then(() => { setErrors([]); setName(''); setGstin(''); changed() }, (e) => setErrors(messages(e)))
  return (
    <fieldset>
      <legend>Further registrations (tax units)</legend>
      <table className="report">
        <thead><tr><th>Name</th><th>GSTIN</th><th>State</th><th className="num">Voucher types</th><th /></tr></thead>
        <tbody>
          {(data ?? []).slice(1).map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td><td>{r.gstin}</td><td>{r.state}</td><td className="num">{r.types}</td>
              <td><button type="button" onClick={() => run(api.deleteGstRegistration(company.id, r.id))}>Delete</button></td>
            </tr>
          ))}
          <tr>
            <td><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Karnataka branch" aria-label="Registration name" /></td>
            <td><input value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} placeholder="29…" aria-label="Registration GSTIN" /></td>
            <td className="muted">{!gstinError(gstin) && gstin ? stateName(gstin.slice(0, 2)) : ''}</td>
            <td />
            <td><button type="button" onClick={() => run(api.createGstRegistration(company.id, { name, gstin }))}>Add</button></td>
          </tr>
        </tbody>
      </table>
      <p className="muted">A voucher type set to a registration (Alter, Voucher Type) taxes its vouchers from that state; GSTR-1 and GSTR-3B then show each registration's own return.</p>
      <Errors errors={errors} />
    </fieldset>
  )
}

/** An invoice section; amendments show the number and date the filed return carried, exports their type. */
function InvoiceTable({ rows, title, note }: { rows: (InvoiceRow & { originalNumber?: number | string; originalDate?: string; expType?: string; noteType?: string })[]; title: string; note?: boolean }) {
  const { push } = useApp()
  if (!rows.length) return null
  return (
    <>
      <h3 className="sub">{title}</h3>
      <table className="report">
        <thead>
          <tr>
            <th>Date</th>
            <th>Party</th>
            <th>GSTIN</th>
            <th className="num">{note ? 'Note' : 'Invoice'} No.</th>
            {rows[0].originalNumber !== undefined && <th>Original</th>}
            {(rows[0].expType || rows[0].noteType) && <th>Type</th>}
            <th>Place of supply</th>
            <th className="num">Value</th>
            {taxHeads}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.voucherId} className="clickable" onClick={() => push({ k: 'voucher', type: r.type, id: r.voucherId })}>
              <td>{fmtDate(r.date)}</td>
              <td>{r.party}</td>
              <td>{r.gstin}</td>
              <td className="num">{r.docNo ?? r.number}</td>
              {r.originalNumber !== undefined && (
                <td>
                  No. {r.originalNumber} of {fmtDate(r.originalDate!)}
                </td>
              )}
              {(r.expType || r.noteType) && <td>{r.expType === 'WOPAY' ? 'Without payment (LUT)' : r.expType === 'WPAY' ? 'With payment' : r.noteType}</td>}
              <td>{r.pos === '96' ? 'Other countries' : (stateName(r.pos) ?? r.pos)}</td>
              <td className="num">{amt(r.value)}</td>
              {taxCells(r)}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

/** Alt+J downloads the return month's GSTR-1 as the portal's JSON file; Alt+F marks the month filed (or not). */
function useJsonKey(run: () => void, toggleFiled?: () => void) {
  const active = useActive()
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault()
        run()
      }
      if (e.altKey && (e.key === 'f' || e.key === 'F') && toggleFiled) {
        e.preventDefault()
        toggleFiled()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
}

/** GSTR-1: outward supplies by the return's sections, the HSN summary, documents issued, and what needs fixing. */
// the GST registration the returns are of, shared by GSTR-1 and GSTR-3B (0: the company's own GSTIN)
let registrationNow = 0
export const currentRegistration = () => registrationNow
/** Which of the company's GST registrations a return is for, when it has more than one. */
export function RegistrationPick({ value, onChange }: { value: number; onChange: (id: number) => void }) {
  const { company, version } = useApp()
  const { data } = useLoad(() => api.gstRegistrations(company.id), [company.id, version])
  if (!data || data.length < 2) return null
  return (
    <select value={value} onChange={(e) => onChange((registrationNow = Number(e.target.value)))} aria-label="GST registration">
      {data.map((r) => <option key={r.id} value={r.id}>{r.name}: {r.gstin}</option>)}
    </select>
  )
}

export function Gstr1View() {
  const { company, period, version, push, changed } = useApp()
  const [reg, setReg] = useState(registrationNow)
  const { data, error } = useLoad(() => api.gstr1(company.id, period, reg), [company.id, period, version, reg])
  // a return is one month: once filed, later changes to its invoices go to the amendment tables
  const month = period.from.slice(0, 7)
  const oneMonth = period.from.endsWith('-01') && period.to.slice(0, 7) === month && new Date(Date.parse(period.to + 'T00:00:00Z') + 86_400_000).getUTCDate() === 1
  const toggleFiled = () =>
    oneMonth && data && api.setFiled(company.id, month, !data.filed).then(changed).catch((e) => setFileErrors(e instanceof ApiError ? messages(e) : [String(e)]))
  const [fileErrors, setFileErrors] = useState<string[]>([])
  const [saved, setSaved] = useState<string | null>(null)
  const download = () => {
    setFileErrors([])
    api
      .gstr1File(company.id, period, reg)
      .then((file) => {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' }))
        a.download = `GSTR1_${file.gstin}_${file.fp}.json`
        a.click()
        URL.revokeObjectURL(a.href)
        setSaved(a.download)
      })
      .catch((e) => setFileErrors(e instanceof ApiError ? messages(e) : [String(e)]))
  }
  useJsonKey(download, toggleFiled)
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const hsn = [...data.hsn.b2b.map((h) => ({ ...h, kind: 'B2B' })), ...data.hsn.b2c.map((h) => ({ ...h, kind: 'B2C' }))]
  return (
    <div>
      <Title
        right={
          <>
            <RegistrationPick value={reg} onChange={setReg} /> {periodNote(data)} <span className="muted">· GSTIN {data.gstin} · Alt+F2 month · Alt+J portal file{oneMonth ? ` · Alt+F ${data.filed ? 'not filed' : 'mark filed'}` : ''}</span>
          </>
        }
      >
        GSTR-1 {data.filed && <span className="badge">Filed</span>}
      </Title>
      {saved && <p className="ok">Saved {saved}; upload it in the GST portal's offline tool for GSTR-1.</p>}
      <Errors errors={fileErrors} />
      {data.attention.length > 0 && (
        <>
          <h3 className="sub">Needs attention ({data.attention.length})</h3>
          <table className="report">
            <tbody>
              {data.attention.map((a) => (
                <tr key={a.voucherId} className="clickable" onClick={() => push({ k: 'voucher', type: a.type, id: a.voucherId })}>
                  <td>{fmtDate(a.date)}</td>
                  <td>
                    {a.type} {a.docNo ?? a.number}
                  </td>
                  <td className="errors-inline">{a.problems.join('; ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <table className="report">
        <thead>
          <tr>
            <th>Particulars</th>
            <th className="num">Count</th>
            {taxHeads}
          </tr>
        </thead>
        <tbody>
          {data.summary.map((s) => (
            <tr key={s.section}>
              <td>{s.section}</td>
              <td className="num">{s.count || ''}</td>
              {taxCells(s)}
            </tr>
          ))}
        </tbody>
      </table>
      <InvoiceTable rows={data.b2b} title="B2B Invoices (4A)" />
      <InvoiceTable rows={data.b2cl} title="B2C (Large) Invoices (5A)" />
      <InvoiceTable rows={data.exp} title="Exports (6A)" />
      {data.b2cs.length > 0 && (
        <>
          <h3 className="sub">B2C (Small) (7)</h3>
          <table className="report">
            <thead>
              <tr>
                <th>Place of supply</th>
                <th>Supply</th>
                <th className="num">Rate</th>
                {taxHeads}
              </tr>
            </thead>
            <tbody>
              {data.b2cs.map((r) => (
                <tr key={`${r.pos}${r.rate}${r.interstate}`}>
                  <td>{stateName(r.pos) ?? r.pos}</td>
                  <td>{r.interstate ? 'Inter-state' : 'Intra-state'}</td>
                  <td className="num">{rate(r.rate)}</td>
                  {taxCells(r)}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <InvoiceTable rows={data.cdnr} title="Credit/Debit Notes (Registered) (9B)" note />
      <InvoiceTable rows={data.cdnur} title="Credit/Debit Notes (Unregistered) (9B)" note />
      <InvoiceTable rows={data.b2ba} title="Amended B2B Invoices (9A)" />
      <InvoiceTable rows={data.b2cla} title="Amended B2C (Large) Invoices (9A)" />
      <InvoiceTable rows={data.cdnra} title="Amended Credit/Debit Notes (Registered) (9C)" note />
      {data.nilRows.length > 0 && (
        <>
          <h3 className="sub">Nil Rated, Exempt and Non-GST Supplies (8)</h3>
          <table className="report">
            <thead>
              <tr>
                <th>Supply</th>
                <th className="num">Nil Rated</th>
                <th className="num">Exempted</th>
                <th className="num">Non-GST</th>
              </tr>
            </thead>
            <tbody>
              {data.nilRows.map((n) => (
                <tr key={n.supplyType}>
                  <td>{NIL_SUPPLY[n.supplyType]}</td>
                  <td className="num">{amt(n.nil)}</td>
                  <td className="num">{amt(n.exempt)}</td>
                  <td className="num">{amt(n.nonGst)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {hsn.length > 0 && (
        <>
          <h3 className="sub">HSN/SAC Summary (12)</h3>
          <table className="report">
            <thead>
              <tr>
                <th>Table</th>
                <th>HSN/SAC</th>
                <th>UQC</th>
                <th className="num">Quantity</th>
                <th className="num">Rate</th>
                {taxHeads}
              </tr>
            </thead>
            <tbody>
              {hsn.map((h) => (
                <tr key={`${h.kind}${h.hsn}${h.rate}${h.uqc}`}>
                  <td>{h.kind}</td>
                  <td>{h.hsn || <span className="errors-inline">missing</span>}</td>
                  <td>{h.uqc}</td>
                  <td className="num">{h.qty ? h.qty / 1000 : ''}</td>
                  <td className="num">{rate(h.rate)}</td>
                  {taxCells(h)}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {data.docs.length > 0 && (
        <>
          <h3 className="sub">Documents issued (13)</h3>
          <table className="report">
            <thead>
              <tr>
                <th>Document</th>
                <th className="num">From</th>
                <th className="num">To</th>
                <th className="num">Total</th>
                <th className="num">Cancelled</th>
              </tr>
            </thead>
            <tbody>
              {data.docs.map((d) => (
                <tr key={d.type}>
                  <td>{d.type === 'Sales' ? 'Invoices for outward supply' : 'Credit notes'}</td>
                  <td className="num">{d.from}</td>
                  <td className="num">{d.to}</td>
                  <td className="num">{d.total}</td>
                  <td className="num">{d.cancelled || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

const HEAD = { igst: 'IGST', cgst: 'CGST', sgst: 'SGST' } as const

/** GSTR-3B: outward tax, input tax credit, and how the credit pays the tax (Rule 88A order). */
export function Gstr3bView() {
  const { company, period, version } = useApp()
  const [reg, setReg] = useState(registrationNow)
  const [filedOn, setFiledOn] = useState('')
  const { data, error } = useLoad(() => api.gstr3b(company.id, period, reg, filedOn || undefined), [company.id, period, version, reg, filedOn])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const heads = ['igst', 'cgst', 'sgst'] as const
  return (
    <div>
      <Title right={<><RegistrationPick value={reg} onChange={setReg} /> {periodNote(data)} <span className="muted">· GSTIN {data.gstin} · Alt+F2 month</span></>}>GSTR-3B</Title>
      {data.attention > 0 && <p className="errors">{data.attention} voucher(s) need attention; see GSTR-1.</p>}
      <h3 className="sub">3.1 Outward supplies</h3>
      <table className="report">
        <thead>
          <tr>
            <th>Nature of supplies</th>
            {taxHeads}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>(a) Outward taxable supplies</td>
            {taxCells(data.outward)}
          </tr>
          <tr>
            <td>(b) Outward taxable supplies (zero rated: exports)</td>
            {taxCells(data.zeroRated)}
          </tr>
          <tr>
            <td>(c) Nil rated and exempted</td>
            {taxCells(data.nilExempt)}
          </tr>
          <tr>
            <td>(d) Inward supplies liable to reverse charge</td>
            {taxCells(data.rcmInward)}
          </tr>
          <tr>
            <td>(e) Non-GST outward supplies</td>
            {taxCells(data.nonGst)}
          </tr>
        </tbody>
      </table>
      {data.interstateUnregistered.length > 0 && (
        <>
          <h3 className="sub">3.2 Inter-state supplies to unregistered persons</h3>
          <table className="report">
            <thead>
              <tr>
                <th>Place of supply</th>
                <th className="num">Taxable Value</th>
                <th className="num">IGST</th>
              </tr>
            </thead>
            <tbody>
              {data.interstateUnregistered.map((u) => (
                <tr key={u.pos}>
                  <td>{u.state}</td>
                  <td className="num">{amt(u.taxable)}</td>
                  <td className="num">{amt(u.igst)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <h3 className="sub">4 Eligible input tax credit</h3>
      <table className="report">
        <thead>
          <tr>
            <th>Details</th>
            <th className="num">IGST</th>
            <th className="num">CGST</th>
            <th className="num">SGST/UTGST</th>
          </tr>
        </thead>
        <tbody>
          {(
            [
              ['(A)(3) Inward supplies liable to reverse charge', data.itcRcm],
              ['(A)(5) All other ITC', data.itc],
              ['(B)(2) ITC reversed: others', data.reversed],
              ['(C) Net ITC available', data.netItc],
              ['(D)(1) ITC reclaimed', data.reclaimed],
            ] as const
          ).map(([label, t]) => (
            <tr key={label} className={label.startsWith('(C)') ? 'group-row' : ''}>
              <td>{label}</td>
              {heads.map((h) => (
                <td key={h} className="num">
                  {amt(t[h])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(data.inwardExempt.inter || data.inwardExempt.intra || data.inwardNonGst.inter || data.inwardNonGst.intra) !== 0 && (
        <>
          <h3 className="sub">5 Exempt, nil-rated and non-GST inward supplies</h3>
          <table className="report">
            <thead>
              <tr>
                <th>Nature of supplies</th>
                <th className="num">Inter-State</th>
                <th className="num">Intra-State</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Exempt and nil-rated (and from composition dealers)</td>
                <td className="num">{amt(data.inwardExempt.inter)}</td>
                <td className="num">{amt(data.inwardExempt.intra)}</td>
              </tr>
              <tr>
                <td>Non-GST supply</td>
                <td className="num">{amt(data.inwardNonGst.inter)}</td>
                <td className="num">{amt(data.inwardNonGst.intra)}</td>
              </tr>
            </tbody>
          </table>
        </>
      )}
      <h3 className="sub">Payment of tax</h3>
      {(data.rcmCash.igst || data.rcmCash.cgst || data.rcmCash.sgst) > 0 && (
        <p className="muted">Tax payable includes reverse charge tax, which is paid in cash: it can't be set off against credit.</p>
      )}
      <table className="report">
        <thead>
          <tr>
            <th>Description</th>
            <th className="num">Tax payable</th>
            <th className="num">Paid through ITC</th>
            <th className="num">Paid in cash</th>
            <th className="num">ITC carried forward</th>
          </tr>
        </thead>
        <tbody>
          {heads.map((h) => (
            <tr key={h}>
              <td>{HEAD[h]}</td>
              <td className="num">{amt(data.payable[h])}</td>
              <td className="num">
                {data.setOff
                  .filter((s) => s.to === h)
                  .map((s) => `${amt(s.amount)} (${HEAD[s.from]})`)
                  .join(', ')}
              </td>
              <td className="num total">{amt(data.cash[h])}</td>
              <td className="num">{amt(data.carryForward[h])}</td>
            </tr>
          ))}
          {(data.cess.payable || data.cess.credit) > 0 && (
            <tr>
              <td>Cess</td>
              <td className="num">{amt(data.cess.payable)}</td>
              <td className="num">{data.cess.payable - data.cess.cash ? `${amt(data.cess.payable - data.cess.cash)} (Cess)` : ''}</td>
              <td className="num total">{amt(data.cess.cash)}</td>
              <td className="num">{amt(data.cess.carryForward)}</td>
            </tr>
          )}
        </tbody>
      </table>
      {data.from.endsWith('-01') && data.to.slice(0, 7) === data.from.slice(0, 7) && <>
      <h3 className="sub">5.1 Interest and late fee</h3>
      <label className="inline">
        Filed and paid on
        <input type="date" value={filedOn || data.late.filedOn} onChange={(e) => setFiledOn(e.target.value)} aria-label="Filed on" />
        <span className="muted">
          due {fmtDate(data.late.dueDate)}
          {data.late.daysLate ? ` · ${data.late.daysLate} day(s) late` : ' · on time'}
        </span>
      </label>
      {data.late.daysLate > 0 && (
        <table className="report">
          <thead>
            <tr>
              <th>Description</th>
              <th className="num">Integrated Tax</th>
              <th className="num">Central Tax</th>
              <th className="num">State/UT Tax</th>
              <th className="num">Cess</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Interest (18% a year on tax paid in cash)</td>
              <td className="num">{amt(data.late.interest.igst)}</td>
              <td className="num">{amt(data.late.interest.cgst)}</td>
              <td className="num">{amt(data.late.interest.sgst)}</td>
              <td className="num">{amt(data.late.interest.cess)}</td>
            </tr>
            <tr>
              <td>Late fee</td>
              <td className="num" />
              <td className="num">{amt(data.late.lateFee.cgst)}</td>
              <td className="num">{amt(data.late.lateFee.sgst)}</td>
              <td className="num" />
            </tr>
          </tbody>
        </table>
      )}
      </>}
    </div>
  )
}
