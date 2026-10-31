import { useEffect, useState } from 'react'
import { useApp } from '../App'
import { api, type GstClassification } from '../api'
import { TAXABILITY, type Taxability } from '../../server/src/engine/gst'
import { Errors, Picker, Title, enterAdvances, useConfirm, useLoad } from '../ui'
import { messages, parseRate, rateText, useDeleteKey, useSubmit } from './Masters'

const rateLabel = (c: { taxability: Taxability; gstRate: number | null }) => (c.taxability === 'Taxable' ? `${rateText(c.gstRate)}%` : c.taxability)

/**
 * The GST details of a stock item or ledger: a GST Classification (whose HSN, rate and taxability
 * then apply), or the master's own taxability, HSN/SAC and rate.
 */
export function GstDetails(p: {
  classificationId: number | null
  setClassificationId: (id: number | null) => void
  taxability: Taxability
  setTaxability: (t: Taxability) => void
  hsn: string
  setHsn: (s: string) => void
  gstRate: string
  setGstRate: (s: string) => void
  ratePlaceholder?: string
  /** compensation cess (tobacco, pan masala, aerated drinks …) */
  cessRate?: string
  setCessRate?: (s: string) => void
}) {
  const { company, version } = useApp()
  const { data } = useLoad(() => api.gstClassifications(company.id), [company.id, version])
  const chosen = data?.find((c) => c.id === p.classificationId)
  return (
    <>
      <label data-field="classification">
        GST classification
        <Picker
          options={[{ id: 0, name: 'Not applicable', hint: 'set the details here' }, ...(data ?? []).map((c) => ({ id: c.id, name: c.name, hint: `${c.hsn ?? ''} ${rateLabel(c)}` }))]}
          value={p.classificationId ?? 0}
          onChange={(id) => p.setClassificationId(id || null)}
          placeholder="Not applicable"
        />
      </label>
      {chosen ? (
        <p className="muted">
          HSN/SAC {chosen.hsn ?? '—'} · {rateLabel(chosen)} — from the classification
        </p>
      ) : (
        <>
          <label>
            Taxability
            <select value={p.taxability} onChange={(e) => p.setTaxability(e.target.value as Taxability)} aria-label="Taxability">
              {TAXABILITY.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            HSN/SAC
            <input value={p.hsn} onChange={(e) => p.setHsn(e.target.value)} aria-label="HSN/SAC" />
          </label>
          {p.taxability === 'Taxable' && (
            <label>
              GST rate (%)
              <input className="amount" inputMode="decimal" value={p.gstRate} onChange={(e) => p.setGstRate(e.target.value)} placeholder={p.ratePlaceholder} aria-label="GST rate" />
            </label>
          )}
          {p.taxability === 'Taxable' && p.setCessRate && (
            <label>
              Cess rate (%)
              <input className="amount" inputMode="decimal" value={p.cessRate ?? ''} onChange={(e) => p.setCessRate!(e.target.value)} placeholder="none" aria-label="Cess rate" />
            </label>
          )}
        </>
      )}
    </>
  )
}

/** Create / Alter, GST Classification: an HSN/SAC with its rate and taxability, picked on items and ledgers. */
export function GstClassificationForm({ id }: { id?: number }) {
  const { company, changed, pop } = useApp()
  const [confirm, ask] = useConfirm()
  const { data } = useLoad(() => api.gstClassifications(company.id), [company.id])
  const [f, setF] = useState({ name: '', hsn: '', description: '', taxability: 'Taxable' as Taxability, gstRate: '' })
  const current = id ? data?.find((c) => c.id === id) : undefined
  useEffect(() => {
    if (current) setF({ name: current.name, hsn: current.hsn ?? '', description: current.description ?? '', taxability: current.taxability, gstRate: rateText(current.gstRate) })
  }, [current])
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }))
  const { errors, setErrors, ok, submit } = useSubmit(async () => {
    const body = { name: f.name, hsn: f.hsn.trim() || null, description: f.description.trim() || null, taxability: f.taxability,
      gstRate: f.taxability === 'Taxable' ? parseRate(f.gstRate) : null }
    if (id) await api.alterGstClassification(company.id, id, body)
    else await api.createGstClassification(company.id, body)
    changed()
    if (id) pop()
    else setF({ name: '', hsn: '', description: '', taxability: 'Taxable', gstRate: '' })
    return `GST classification "${f.name}" saved`
  })
  useDeleteKey(!!id, ask, `Delete GST classification "${f.name}"?`, () =>
    api
      .deleteGstClassification(company.id, id!)
      .then(() => {
        changed()
        pop()
      })
      .catch((e) => setErrors(messages(e))),
  )
  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || (id && <span className="muted">Alt+D delete</span>)}>
        {id ? 'GST Classification Alteration' : 'GST Classification Creation'}
      </Title>
      <label>
        Name
        <input autoFocus required value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Packaged food 5%" aria-label="Name" />
      </label>
      <label>
        HSN/SAC
        <input value={f.hsn} onChange={(e) => set('hsn', e.target.value)} inputMode="numeric" aria-label="HSN/SAC" />
      </label>
      <label>
        Description
        <input value={f.description} onChange={(e) => set('description', e.target.value)} aria-label="Description" />
      </label>
      <label>
        Taxability
        <select value={f.taxability} onChange={(e) => set('taxability', e.target.value as Taxability)} aria-label="Taxability">
          {TAXABILITY.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      {f.taxability === 'Taxable' && (
        <label>
          GST rate (%)
          <input className="amount" inputMode="decimal" value={f.gstRate} onChange={(e) => set('gstRate', e.target.value)} aria-label="GST rate" />
        </label>
      )}
      {current && current.used > 0 && (
        <p className="muted">
          Used on {current.used} stock items and ledgers. A new rate applies to invoices entered from now on; saved invoices keep theirs.
        </p>
      )}
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

export function GstClassificationPick() {
  const { company, replace } = useApp()
  const { data } = useLoad(() => api.gstClassifications(company.id), [company.id])
  return (
    <div className="form narrow">
      <Title>Alter GST Classification</Title>
      {data && !data.length && <p className="muted">No GST classifications yet (Create, GST Classification).</p>}
      <label>
        Name of classification
        <Picker
          options={(data ?? []).map((c: GstClassification) => ({ id: c.id, name: c.name, hint: `${c.hsn ?? ''} ${rateLabel(c)}` }))}
          value={null}
          onChange={(id) => replace({ k: 'gst-classification', id })}
          autoFocus
        />
      </label>
    </div>
  )
}
