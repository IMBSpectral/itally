import { useEffect, useRef, useState } from 'react'
import { useApp } from '../App'
import { api, type Form26Q, type ReturnForm, type TdsChallan, type TdsSettings, type TdsSuggestion } from '../api'
import { returnSheet, type TaxKind } from '../../server/src/engine/tds'
import { toPaise } from '../../server/src/engine/money'
import { amt, DateInput, Errors, fmtDate, Picker, Title, enterAdvances, useActive, useConfirm, useLoad } from '../ui'
import { messages, parseRate, rateText, useDeleteKey, useSubmit } from './Masters'
import { periodNote } from './Books'

const pct = (r: number) => `${rateText(r)}%`
const rupeesField = (p: number | null) => (p === null ? '' : String(p / 100))

/** Alt+K, TDS Details: the TAN and the person responsible; the first save brings the standard natures of payment. */
export function TdsDetailsForm() {
  const { company, changed } = useApp()
  const { data } = useLoad(() => api.tdsSettings(company.id), [company.id])
  const [f, setF] = useState<TdsSettings>({ tan: '', deductorType: 'Others', responsible: '' })
  useEffect(() => {
    if (data) setF({ tan: data.tan ?? '', deductorType: data.deductorType, responsible: data.responsible ?? '' })
  }, [data])
  const { errors, ok, submit } = useSubmit(async () => {
    await api.setTdsSettings(company.id, { ...f, tan: f.tan?.trim() || null, responsible: f.responsible?.trim() || null })
    changed()
    return 'Saved'
  })
  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={ok && <span className="ok">{ok}</span>}>TDS Details</Title>
      <label>
        TAN (tax deduction account number)
        <input autoFocus value={f.tan ?? ''} onChange={(e) => setF({ ...f, tan: e.target.value.toUpperCase() })} placeholder="MUMR12345B" aria-label="TAN" />
      </label>
      <label>
        Deductor type
        <select value={f.deductorType} onChange={(e) => setF({ ...f, deductorType: e.target.value as TdsSettings['deductorType'] })} aria-label="Deductor type">
          <option>Others</option>
          <option>Government</option>
        </select>
      </label>
      <label>
        Person responsible for deduction
        <input value={f.responsible ?? ''} onChange={(e) => setF({ ...f, responsible: e.target.value })} aria-label="Person responsible" />
      </label>
      <p className="muted">
        Mark suppliers and contractors (and, for TCS, buyers) with their deductee type, and give expense ledgers and TDS ledgers (under Duties &amp; Taxes) their nature
        of payment, sales ledgers and TCS ledgers their nature of goods. Vouchers then show the TDS or TCS due, and Alt+T books it. The TAN serves TDS and TCS alike.
      </p>
      <Errors errors={errors} />
      <div className="actions">
        <button type="submit" className="primary">
          <b>Ctrl+A</b> Save
        </button>
      </div>
    </form>
  )
}

/** Create / Alter, TDS Nature of Payment or TCS Nature of Goods: section (and collection code), rates and thresholds. */
export function TdsNatureForm({ id, kind: newKind = 'TDS' }: { id?: number; kind?: TaxKind }) {
  const { company, changed, pop } = useApp()
  const [confirm, ask] = useConfirm()
  const { data } = useLoad(() => api.tdsNatures(company.id), [company.id])
  const current = id ? data?.find((n) => n.id === id) : undefined
  const kind = current?.kind ?? newKind
  const tcs = kind === 'TCS'
  const noun = tcs ? 'nature of goods' : 'nature of payment'
  const blank = { name: '', section: '', collectionCode: '', rateIndividual: '', rateOther: '', rateNoPan: tcs ? '5' : '20', thresholdSingle: '', thresholdAnnual: '', excessOnly: false }
  const [f, setF] = useState(blank)
  useEffect(() => {
    if (current)
      setF({
        name: current.name, section: current.section, collectionCode: current.collectionCode ?? '', rateIndividual: rateText(current.rateIndividual), rateOther: rateText(current.rateOther),
        rateNoPan: rateText(current.rateNoPan), thresholdSingle: rupeesField(current.thresholdSingle), thresholdAnnual: rupeesField(current.thresholdAnnual),
        excessOnly: current.excessOnly,
      })
  }, [current])
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }))
  const { errors, setErrors, ok, submit } = useSubmit(async () => {
    const rate = (s: string) => parseRate(s) ?? 0
    const money = (s: string) => (s.trim() ? toPaise(s) : null)
    const body = {
      name: f.name, kind, section: f.section, collectionCode: tcs ? f.collectionCode.trim() || null : null, rateIndividual: rate(f.rateIndividual), rateOther: rate(f.rateOther || f.rateIndividual), rateNoPan: rate(f.rateNoPan),
      thresholdSingle: money(f.thresholdSingle), thresholdAnnual: money(f.thresholdAnnual), excessOnly: f.excessOnly,
    }
    if (id) await api.alterTdsNature(company.id, id, body)
    else await api.createTdsNature(company.id, body)
    changed()
    if (id) pop()
    else setF(blank)
    return `${tcs ? 'Nature of goods' : 'Nature of payment'} "${f.name}" saved`
  })
  useDeleteKey(!!id, ask, `Delete ${noun} "${f.name}"?`, () =>
    api
      .deleteTdsNature(company.id, id!)
      .then(() => {
        changed()
        pop()
      })
      .catch((e) => setErrors(messages(e))),
  )
  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || (id && <span className="muted">Alt+D delete</span>)}>
        {tcs ? 'TCS Nature of Goods' : 'TDS Nature of Payment'} {id ? 'Alteration' : 'Creation'}
      </Title>
      <label>
        Name
        <input autoFocus required value={f.name} onChange={(e) => set('name', e.target.value)} placeholder={tcs ? 'Scrap' : 'Payment to Contractors'} aria-label="Name" />
      </label>
      <div className="inline">
        <label>
          Section
          <input value={f.section} onChange={(e) => set('section', e.target.value.toUpperCase())} placeholder={tcs ? '206C(1)' : '194C'} aria-label="Section" />
        </label>
        {tcs && (
          <label>
            Collection code (Form 27EQ)
            <input value={f.collectionCode} maxLength={2} onChange={(e) => set('collectionCode', e.target.value.toUpperCase())} placeholder="E" aria-label="Collection code" />
          </label>
        )}
      </div>
      <div className="inline">
        <label>
          Rate: individuals and HUFs (%)
          <input className="amount" inputMode="decimal" value={f.rateIndividual} onChange={(e) => set('rateIndividual', e.target.value)} aria-label="Rate for individuals" />
        </label>
        <label>
          Rate: others (%)
          <input className="amount" inputMode="decimal" value={f.rateOther} onChange={(e) => set('rateOther', e.target.value)} aria-label="Rate for others" />
        </label>
        <label>
          Rate without PAN (%)
          <input className="amount" inputMode="decimal" value={f.rateNoPan} onChange={(e) => set('rateNoPan', e.target.value)} aria-label="Rate without PAN" />
        </label>
      </div>
      <div className="inline">
        <label>
          {tcs ? 'Single sale above' : 'Single payment above'}
          <input className="amount" inputMode="decimal" value={f.thresholdSingle} onChange={(e) => set('thresholdSingle', e.target.value)} placeholder="none" aria-label="Single threshold" />
        </label>
        <label>
          Year's total above
          <input className="amount" inputMode="decimal" value={f.thresholdAnnual} onChange={(e) => set('thresholdAnnual', e.target.value)} placeholder="none" aria-label="Annual threshold" />
        </label>
        <label>
          Tax only the excess
          <select value={f.excessOnly ? 'Yes' : 'No'} onChange={(e) => set('excessOnly', e.target.value === 'Yes')} aria-label="Tax only the excess">
            <option>No</option>
            <option>Yes</option>
          </select>
        </label>
      </div>
      <p className="muted">
        {tcs
          ? 'TCS is collected on what the buyer is charged, GST included. Below the limits nothing is due; a motor vehicle is taxed above ₹10 lakh a sale. Without a PAN, section 206CC: twice the rate or 5%.'
          : `Below both limits nothing is due. A payment above the single limit is taxed; once the year's total passes the annual limit, the year's untaxed payments are taxed
        too. "Tax only the excess" is for 194Q, where only the part above ₹50 lakh is taxed.`}
      </p>
      {current && current.used > 0 && <p className="muted">Set on {current.used} ledgers.</p>}
      <Errors errors={errors} />
      <div className="actions">
        <button type="submit" className="primary">
          <b>Ctrl+A</b> Save
        </button>
      </div>
      {confirm}
    </form>
  )
}

export function TdsNaturePick({ kind = 'TDS' }: { kind?: TaxKind }) {
  const { company, replace } = useApp()
  const { data } = useLoad(() => api.tdsNatures(company.id), [company.id])
  const mine = (data ?? []).filter((n) => n.kind === kind)
  const noun = kind === 'TCS' ? 'Nature of Goods' : 'Nature of Payment'
  return (
    <div className="form narrow">
      <Title>Alter {kind} {noun}</Title>
      {data && !mine.length && <p className="muted">None yet: save the TDS Details (Alt+K) to get the standard natures.</p>}
      <label>
        {noun}
        <Picker options={mine.map((n) => ({ id: n.id, name: n.name, hint: n.section }))} value={null} onChange={(id) => replace({ k: 'tds-nature', id })} autoFocus />
      </label>
    </div>
  )
}

/** The nature picker on a ledger: of payment (TDS) on expenses, of goods (TCS) on sales, either on a tax ledger. */
export function TdsNaturePicker({ value, onChange, kinds = ['TDS'] }: { value: number | null; onChange: (id: number | null) => void; kinds?: TaxKind[] }) {
  const { company, version } = useApp()
  const { data } = useLoad(() => api.tdsNatures(company.id), [company.id, version])
  return (
    <label>
      {kinds.length > 1 ? 'TDS/TCS nature' : kinds[0] === 'TCS' ? 'TCS nature of goods' : 'TDS nature of payment'}
      <Picker
        options={[{ id: 0, name: 'Not applicable' }, ...(data ?? []).filter((n) => kinds.includes(n.kind)).map((n) => ({ id: n.id, name: n.name, hint: kinds.length > 1 ? `${n.kind} ${n.section}` : n.section }))]}
        value={value ?? 0}
        onChange={(id) => onChange(id || null)}
        placeholder="Not applicable"
      />
    </label>
  )
}

/**
 * On a voucher: the TDS or TCS due for its party under each nature in it, given the year's earlier
 * vouchers. Alt+T books it: a credit on the nature's tax ledger, taken off the party's line (TDS)
 * or added to what the buyer is charged (TCS).
 */
export function TdsHint({ voucherId, date, entries, onDeduct }: {
  voucherId?: number
  date: string
  entries: { ledgerId: number; amount: number }[]
  onDeduct: (s: TdsSuggestion[]) => void
}) {
  const { company, features } = useApp()
  const active = useActive()
  const [found, setFound] = useState<TdsSuggestion[]>([])
  const key = JSON.stringify(entries)
  useEffect(() => {
    if (!(features.tds || features.tcs) || !entries.length) return setFound([])
    const t = setTimeout(() => {
      api.tdsSuggest(company.id, { id: voucherId, date, entries }).then(setFound, () => setFound([]))
    }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id, features.tds, features.tcs, voucherId, date, key])
  const latest = useRef(found)
  latest.current = found
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === 't' || e.key === 'T') && latest.current.some((s) => s.due && s.ledgerId)) {
        e.preventDefault()
        onDeduct(latest.current.filter((s) => s.due && s.ledgerId))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  if (!found.length) return null
  return (
    <div className="tds-hint">
      {found.map((s) => (
        <div key={s.natureId}>
          {s.kind} u/s {s.section} ({s.nature}) on {s.party}:{' '}
          {s.due ? (
            <>
              <b>{amt(s.due)}</b> at {pct(s.rate)} on {amt(s.assessable)}
              {s.ledgerId ? (
                <span className="muted"> · Alt+T {s.kind === 'TCS' ? 'collects' : 'deducts'} it on {s.ledger}</span>
              ) : (
                <span className="errors-inline"> · no {s.kind} ledger for this nature</span>
              )}
            </>
          ) : (
            <span className="muted">nothing due yet (below the limits)</span>
          )}
        </div>
      ))}
    </div>
  )
}

/** TDS (or TCS) Computation: each voucher's amount under a nature, what was due and what was deducted or collected. */
export function TdsComputationView({ kind = 'TDS' }: { kind?: TaxKind }) {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.tdsComputation(company.id, period, kind), [company.id, period, version, kind])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={periodNote(data)}>{kind} Computation</Title>
      <table className="report">
        <thead>
          <tr>
            <th>Date</th>
            <th>Party</th>
            <th>Section</th>
            <th>Vch No.</th>
            <th className="num">Amount</th>
            <th className="num">Taxed on</th>
            <th className="num">Rate</th>
            <th className="num">Due</th>
            <th className="num">{kind === 'TCS' ? 'Collected' : 'Deducted'}</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l) => (
            <tr key={`${l.voucherId}/${l.section}/${l.nature}`} className="clickable" onClick={() => push({ k: 'voucher', type: l.type, id: l.voucherId })}>
              <td>{fmtDate(l.date)}</td>
              <td>
                {l.party}
                {l.problems.map((p) => (
                  <div key={p} className="errors-inline small">
                    {p}
                  </div>
                ))}
              </td>
              <td>{l.section}</td>
              <td>{l.docNo}</td>
              <td className="num">{amt(l.amount)}</td>
              <td className="num">{amt(l.assessable)}</td>
              <td className="num">{pct(l.rate)}</td>
              <td className="num">{amt(l.due)}</td>
              <td className="num">{amt(l.deducted)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!data.lines.length && <p className="muted">{kind === 'TCS' ? 'No sales of goods with TCS in this period.' : 'No payments to deductees in this period.'}</p>}
    </div>
  )
}

/** TDS (or TCS) Outstandings: by nature, due and deducted in the period, paid, and still payable; the payments and their challans. */
export function TdsOutstandingsView({ kind = 'TDS' }: { kind?: TaxKind }) {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.tdsOutstandings(company.id, period, kind), [company.id, period, version, kind])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={periodNote(data)}>{kind} Outstandings</Title>
      <table className="report">
        <thead>
          <tr>
            <th>{kind === 'TCS' ? 'Nature of goods' : 'Nature of payment'}</th>
            <th>Section</th>
            <th className="num">Due</th>
            <th className="num">{kind === 'TCS' ? 'Collected' : 'Deducted'}</th>
            <th className="num">Paid</th>
            <th className="num">Payable</th>
          </tr>
        </thead>
        <tbody>
          {data.natures.map((n) => (
            <tr key={n.natureId}>
              <td>{n.nature}</td>
              <td>{n.section}</td>
              <td className="num">{amt(n.due)}</td>
              <td className="num">{amt(n.deducted)}</td>
              <td className="num">{amt(n.paid)}</td>
              <td className="num">{amt(n.payable)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 className="sub">Payments of {kind}{data.unpaidChallans ? ` (${data.unpaidChallans} without challan details: Enter adds them)` : ''}</h3>
      <table className="report">
        <thead>
          <tr>
            <th>Date</th>
            <th>Vch No.</th>
            <th>Section</th>
            <th className="num">Amount</th>
            <th>Challan (BSR · serial · date)</th>
          </tr>
        </thead>
        <tbody>
          {data.payments.map((p) => (
            <tr key={`${p.voucherId}/${p.natureId}`} className="clickable" onClick={() => push({ k: 'tds-challan', voucherId: p.voucherId })}>
              <td>{fmtDate(p.date)}</td>
              <td>{p.docNo}</td>
              <td>{p.section}</td>
              <td className="num">{amt(p.amount)}</td>
              <td>{p.challan ? `${p.challan.bsrCode} · ${p.challan.challanNo} · ${fmtDate(p.challan.challanDate)}` : <span className="errors-inline">not given</span>}</td>
            </tr>
          ))}
          {!data.payments.length && (
            <tr className="muted">
              <td colSpan={5}>No {kind} paid in this period</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

/** The challan of a payment of TDS or TCS: BSR code, challan serial number and date of deposit. */
export function TdsChallanForm({ voucherId }: { voucherId: number }) {
  const { company, changed, pop } = useApp()
  const { data } = useLoad(() => api.tdsChallan(company.id, voucherId), [company.id, voucherId])
  const [f, setF] = useState({ bsrCode: '', challanNo: '', challanDate: '' })
  useEffect(() => {
    if (data) setF(data)
  }, [data])
  const { errors, submit } = useSubmit(async () => {
    await api.setTdsChallan(company.id, voucherId, f)
    changed()
    pop()
    return 'Saved'
  })
  return (
    <form className="form narrow" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title>Challan</Title>
      <label>
        BSR code (7 digits)
        <input autoFocus inputMode="numeric" value={f.bsrCode} onChange={(e) => setF({ ...f, bsrCode: e.target.value.trim() })} aria-label="BSR code" />
      </label>
      <label>
        Challan serial number (5 digits)
        <input inputMode="numeric" value={f.challanNo} onChange={(e) => setF({ ...f, challanNo: e.target.value.trim() })} aria-label="Challan number" />
      </label>
      <DateInput label="Date of deposit" value={f.challanDate} onChange={(d) => setF({ ...f, challanDate: d })} fyStart={company.fyStart} />
      <Errors errors={errors} />
      <div className="actions">
        <button type="submit" className="primary">
          <b>Ctrl+A</b> Save
        </button>
      </div>
    </form>
  )
}

/**
 * Form 26Q (TDS on residents), 27Q (TDS on non-residents) or 27EQ (TCS) for a quarter: the deductor,
 * deductions or collections matched to challans, the challans; Alt+J saves the deductee or
 * collectee details as CSV for the return utility.
 */
export function Form26QView({ form = '26Q' }: { form?: ReturnForm }) {
  const { company, period, version } = useApp()
  const fy = `${period.from.slice(5) >= '04-01' ? period.from.slice(0, 4) : Number(period.from.slice(0, 4)) - 1}-04-01`
  const [quarter, setQuarter] = useState(() => {
    const m = Number(period.from.slice(5, 7))
    return m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 ? 3 : 4
  })
  const { data, error } = useLoad(() => api.taxReturn(company.id, form, fy, quarter), [company.id, form, fy, quarter, version])
  const tcs = form === '27EQ'
  const active = useActive()
  const latest = useRef<Form26Q | null>(null)
  latest.current = data ?? null
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (['1', '2', '3', '4'].includes(e.key) && !e.altKey && !e.ctrlKey && !(e.target as HTMLElement).closest('input, select')) setQuarter(Number(e.key))
      if (e.altKey && (e.key === 'j' || e.key === 'J') && latest.current) {
        e.preventDefault()
        download(latest.current)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={<span className="muted">FY {fy.slice(0, 4)}-{String(Number(fy.slice(2, 4)) + 1).padStart(2, '0')} · keys 1-4 quarter · Alt+J CSV</span>}>
        {data.title}: Q{quarter} ({fmtDate(data.from)} to {fmtDate(data.to)})
      </Title>
      <p>
        {data.deductor.name} · TAN {data.deductor.tan ?? <span className="errors-inline">not set</span>} · {data.deductor.type}
        {data.deductor.responsible ? ` · responsible: ${data.deductor.responsible}` : ''}
      </p>
      {data.problems.length > 0 && <Errors errors={data.problems} />}
      <h3 className="sub">{tcs ? 'Collectee details' : 'Deductee details'}</h3>
      <table className="report">
        <thead>
          <tr>
            <th>Code</th>
            <th>PAN</th>
            <th>Name</th>
            <th>{tcs ? 'Collection code' : 'Section'}</th>
            {form === '27Q' && <th>Country</th>}
            <th>Date</th>
            <th className="num">Amount</th>
            <th className="num">Rate</th>
            <th className="num">{tcs ? 'TCS' : 'TDS'}</th>
            <th className="num">Challan</th>
          </tr>
        </thead>
        <tbody>
          {data.deductions.map((d) => (
            <tr key={`${d.voucherId}/${d.section}`}>
              <td>{d.deducteeCode}</td>
              <td>{d.pan}</td>
              <td>{d.name}</td>
              <td>{tcs ? (d.collectionCode ?? <span className="errors-inline">none</span>) : d.section}</td>
              {form === '27Q' && <td>{d.country}</td>}
              <td>{fmtDate(d.date)}</td>
              <td className="num">{amt(d.amount)}</td>
              <td className="num">{pct(d.rate)}</td>
              <td className="num">{amt(d.tds)}</td>
              <td className="num">{d.challan?.serial ?? '—'}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={form === '27Q' ? 6 : 5}>Total</td>
            <td className="num total">{amt(data.total.amount)}</td>
            <td />
            <td className="num total">{amt(data.total.tds)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
      <h3 className="sub">Challans</h3>
      <table className="report">
        <thead>
          <tr>
            <th className="num">Serial</th>
            <th>Section</th>
            <th>BSR code</th>
            <th>Challan No.</th>
            <th>Date</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {data.challans.map((c) => (
            <tr key={c.serial}>
              <td className="num">{c.serial}</td>
              <td>{c.section}</td>
              <td>{c.challan?.bsrCode ?? '—'}</td>
              <td>{c.challan?.challanNo ?? '—'}</td>
              <td>{fmtDate(c.challan?.challanDate ?? c.date)}</td>
              <td className="num">{amt(c.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        The CSV follows the deductee sheet of the government's Return Preparation Utility; the return itself is prepared and validated there (or by your TDS filer).
      </p>
    </div>
  )
}

function download(r: Form26Q) {
  const cell = (v: unknown) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''))
  const { head, rows } = returnSheet(r)
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([[head, ...rows].map((l) => l.map(cell).join(',')).join('\r\n') + '\r\n'], { type: 'text/csv' }))
  a.download = `${r.form}_Q${r.quarter}_${r.fyStart.slice(0, 4)}.csv`
  a.click()
}

/**
 * Challan Reconciliation: the period's payments of TDS and TCS with their challans, how much the
 * deductions and collections account for; the challan details of every payment are typed in
 * here and saved together (Ctrl+A).
 */
export function ChallanReconciliationView() {
  const { company, period, version, changed, push } = useApp()
  const { data, error } = useLoad(() => api.challanReconciliation(company.id, period), [company.id, period, version])
  const [edits, setEdits] = useState<Record<number, TdsChallan>>({})
  useEffect(() => setEdits({}), [data])
  const { errors, ok, submit } = useSubmit(async () => {
    const items = Object.entries(edits).map(([id, c]) => ({ voucherId: Number(id), challan: c.bsrCode || c.challanNo || c.challanDate ? c : null }))
    if (!items.length) return 'Nothing changed'
    await api.setTdsChallans(company.id, items)
    changed()
    return `${items.length} challan${items.length > 1 ? 's' : ''} saved`
  })
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const value = (p: (typeof data.payments)[number]) => edits[p.voucherId] ?? p.challan ?? { bsrCode: '', challanNo: '', challanDate: '' }
  const set = (p: (typeof data.payments)[number], patch: Partial<TdsChallan>) => setEdits((e) => ({ ...e, [p.voucherId]: { ...value(p), ...patch } }))
  return (
    <form onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || periodNote(data)}>Challan Reconciliation</Title>
      <table className="report">
        <thead>
          <tr>
            <th>Date</th>
            <th>Vch No.</th>
            <th>Tax</th>
            <th>Section</th>
            <th className="num">Paid</th>
            <th className="num">Accounted for</th>
            <th className="num">Unallocated</th>
            <th>BSR code</th>
            <th>Challan No.</th>
            <th>Deposited on</th>
          </tr>
        </thead>
        <tbody>
          {data.payments.map((p) => {
            const c = value(p)
            return (
              <tr key={p.voucherId}>
                <td className="clickable" onClick={() => push({ k: 'voucher', type: 'Payment', id: p.voucherId })}>{fmtDate(p.date)}</td>
                <td>{p.docNo}</td>
                <td>{p.kind}</td>
                <td>{p.section}</td>
                <td className="num">{amt(p.amount)}</td>
                <td className="num">{amt(p.allocated)}{p.deductions ? <span className="muted"> ({p.deductions})</span> : null}</td>
                <td className="num">{p.unallocated ? <span className="errors-inline">{amt(p.unallocated)}</span> : ''}</td>
                <td><input inputMode="numeric" size={8} value={c.bsrCode} onChange={(e) => set(p, { bsrCode: e.target.value.trim() })} aria-label={`BSR code ${p.docNo}`} /></td>
                <td><input inputMode="numeric" size={6} value={c.challanNo} onChange={(e) => set(p, { challanNo: e.target.value.trim() })} aria-label={`Challan number ${p.docNo}`} /></td>
                <td><input type="date" value={c.challanDate} onChange={(e) => set(p, { challanDate: e.target.value })} aria-label={`Date of deposit ${p.docNo}`} /></td>
              </tr>
            )
          })}
          {!data.payments.length && (
            <tr className="muted">
              <td colSpan={10}>No TDS or TCS paid in this period</td>
            </tr>
          )}
        </tbody>
      </table>
      {data.unmatched > 0 && <p className="errors-inline">{data.unmatched} deductions or collections in the period are not covered by any payment yet.</p>}
      <Errors errors={errors} />
      <div className="actions">
        <button type="submit" className="primary">
          <b>Ctrl+A</b> Save challans
        </button>
      </div>
    </form>
  )
}

/** A party's own rates: certificates for lower or no deduction (section 197) and treaty (DTAA) rates. */
export function TdsPartyRatesView() {
  const { company, period, version, changed } = useApp()
  const { data, error } = useLoad(() => api.tdsPartyRates(company.id), [company.id, version])
  const { data: ledgers } = useLoad(() => api.ledgers(company.id, period), [company.id, version])
  const { data: natures } = useLoad(() => api.tdsNatures(company.id), [company.id, version])
  const [confirm, ask] = useConfirm()
  const [f, setF] = useState({ ledgerId: null as number | null, natureId: 0, kind: 'certificate' as 'certificate' | 'dtaa', rate: '', certificateNo: '', validFrom: period.from, validTo: period.to, limit: '' })
  const { errors, setErrors, ok, submit } = useSubmit(async () => {
    const rate = parseRate(f.rate)
    await api.createTdsPartyRate(company.id, {
      ledgerId: f.ledgerId ?? 0, natureId: f.natureId || null, kind: f.kind, rate: rate ?? -1, certificateNo: f.certificateNo, validFrom: f.validFrom, validTo: f.validTo,
      limit: f.kind === 'certificate' && f.limit.trim() ? toPaise(f.limit) : null,
    })
    changed()
    setF({ ...f, rate: '', certificateNo: '', limit: '' })
    return 'Saved'
  })
  if (error) return <Errors errors={[error]} />
  return (
    <form className="form wide" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || <span className="muted">Ctrl+A saves</span>}>Lower Deduction Certificates and Treaty Rates</Title>
      <table className="report">
        <thead><tr><th>Party</th><th>Nature</th><th>Kind</th><th className="num">Rate</th><th>Certificate</th><th>From</th><th>To</th><th className="num">Up to</th><th /></tr></thead>
        <tbody>
          {(data ?? []).map((r) => (
            <tr key={r.id}>
              <td>{r.party}</td><td>{r.nature ?? 'Every nature'}</td><td>{r.kind === 'certificate' ? 'Section 197' : 'DTAA'}</td><td className="num">{rateText(r.rate)}%</td>
              <td>{r.certificateNo ?? ''}</td><td>{fmtDate(r.validFrom)}</td><td>{fmtDate(r.validTo)}</td><td className="num">{r.limit ? amt(r.limit) : ''}</td>
              <td><button type="button" className="small" onClick={() => ask(`Delete the rate of ${r.party}?`, () => api.deleteTdsPartyRate(company.id, r.id).then(changed, (e) => setErrors(messages(e))))}>Delete</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 className="sub">New</h3>
      <div className="inline">
        <label>
          Party
          <Picker options={(ledgers ?? []).filter((l) => l.primaryGroup !== null).map((l) => ({ id: l.id, name: l.name, hint: l.group ?? '' }))} value={f.ledgerId} onChange={(v) => setF({ ...f, ledgerId: v })} placeholder="Party" />
        </label>
        <label>
          Nature of payment
          <Picker options={[{ id: 0, name: 'Every nature' }, ...(natures ?? []).filter((n) => n.kind === 'TDS').map((n) => ({ id: n.id, name: n.name, hint: n.section }))]} value={f.natureId}
            onChange={(v) => setF({ ...f, natureId: v ?? 0 })} />
        </label>
        <label>
          Kind
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as 'certificate' | 'dtaa' })} aria-label="Kind">
            <option value="certificate">Section 197 certificate (lower or no deduction)</option>
            <option value="dtaa">Treaty rate (DTAA), a party abroad</option>
          </select>
        </label>
      </div>
      <div className="inline">
        <label>Rate %<input className="amount" required value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} aria-label="Rate" /></label>
        {f.kind === 'certificate' && <label>Certificate number<input value={f.certificateNo} onChange={(e) => setF({ ...f, certificateNo: e.target.value })} aria-label="Certificate number" /></label>}
        <label>From<input type="date" value={f.validFrom} onChange={(e) => setF({ ...f, validFrom: e.target.value })} aria-label="Valid from" /></label>
        <label>To<input type="date" value={f.validTo} onChange={(e) => setF({ ...f, validTo: e.target.value })} aria-label="Valid to" /></label>
        {f.kind === 'certificate' && <label>Up to amount<input className="amount" value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} aria-label="Amount covered" /></label>}
      </div>
      <p className="muted">The TDS reports work out what is due at this rate (within the dates, and up to the amount a certificate covers; the normal rate after). Forms 26Q and 27Q show reason A and the certificate number, or the DTAA rate.</p>
      <Errors errors={errors} />
      <div className="actions"><button type="submit" className="primary"><b>Ctrl+A</b> Save</button></div>
      {confirm}
    </form>
  )
}
