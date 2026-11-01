import { useEffect, useState } from 'react'
import { useApp } from '../App'
import { api, ApiError, type EDocRecord, type Transport } from '../api'
import { amt, Errors, fmtDate, Title, enterAdvances, useActive, useLoad } from '../ui'
import { messages, useSubmit } from './Masters'
import { periodNote } from './Books'

/** Save JSON the way the portals take it. */
function saveJson(data: unknown, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }))
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

/**
 * e-Invoice and e-Way Bill register: every sale, purchase and note of the period with what each
 * needs and what is done. Space ticks a voucher; Alt+J saves the ticked (or every ready) e-Invoice
 * for the IRP's upload, Alt+W the e-Way Bills for the portal's bulk upload; Enter opens one.
 */
export function EDocRegisterView() {
  const { company, period, version, push } = useApp()
  const active = useActive()
  const { data, error } = useLoad(() => api.eDocuments(company.id, period), [company.id, period, version])
  const [ticked, setTicked] = useState<Set<number>>(new Set())
  const [errors, setErrors] = useState<string[]>([])
  const [saved, setSaved] = useState('')
  const { data: gsp } = useLoad(() => api.gspSettings(company.id), [company.id, version])
  const { changed } = useApp()
  const [busy, setBusy] = useState(false)
  // through the API: the ticked vouchers, else every one due and ready; each succeeds or fails on its own
  const generate = async (what: 'irn' | 'ewb') => {
    if (!data) return
    const kind = what === 'irn' ? 'einvoice' : 'eway'
    const ready = data.vouchers.filter((v) => (kind === 'einvoice' ? v.einvoice.needed && !v.einvoice.irn : v.eway.needed && !v.eway.ewbNo) && !v[kind].problems.length)
    const ids = ticked.size ? [...ticked] : ready.map((v) => v.voucherId)
    if (!ids.length) return setErrors([`Nothing to generate: no ${what === 'irn' ? 'e-Invoice' : 'e-Way Bill'} is due and ready (Space ticks vouchers)`])
    setBusy(true)
    setErrors([])
    try {
      const r = await api.generateEDocs(company.id, ids, what)
      const failed = r.filter((x) => !x.ok)
      const number = (id: number) => { const v = data.vouchers.find((x) => x.voucherId === id); return v ? `${v.type} No. ${v.number}` : `voucher ${id}` }
      setErrors(failed.flatMap((x) => (x.errors ?? []).map((e) => `${number(x.id)}: ${e}`)))
      setSaved(`${r.length - failed.length} of ${r.length} ${what === 'irn' ? 'IRNs' : 'e-Way Bills'} generated`)
      setTicked(new Set())
      changed()
    } catch (e) {
      setErrors(messages(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!active || !data) return
    const save = (kind: 'einvoice' | 'eway') => {
      setErrors([])
      const ready = data.vouchers.filter((v) => (kind === 'einvoice' ? v.einvoice.needed && !v.einvoice.irn : v.eway.needed && !v.eway.ewbNo) && !v[kind].problems.length)
      const ids = ticked.size ? [...ticked] : ready.map((v) => v.voucherId)
      if (!ids.length) return setErrors([`Nothing to upload: no ${kind === 'einvoice' ? 'e-Invoice' : 'e-Way Bill'} is due and ready (Space ticks vouchers)`])
      const stamp = new Date().toISOString().slice(0, 10)
      ;(kind === 'einvoice' ? api.eInvoiceFile(company.id, ids) : api.eWayBillFile(company.id, ids))
        .then((file) => {
          const name = `${kind === 'einvoice' ? 'e-Invoice' : 'e-Way-Bill'}_${stamp}_${ids.length}.json`
          saveJson(file, name)
          setSaved(`${name}: ${ids.length} document${ids.length > 1 ? 's' : ''}`)
        })
        .catch((e) => setErrors(e instanceof ApiError ? messages(e) : [String(e)]))
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault()
        save('einvoice')
      } else if (e.altKey && (e.key === 'w' || e.key === 'W')) {
        e.preventDefault()
        save('eway')
      } else if (e.key === ' ' && !(e.target as HTMLElement).closest('input, select, textarea, button')) {
        const row = document.querySelector<HTMLElement>('.screen:not([hidden]) tr.sel[data-id]')
        if (!row) return
        e.preventDefault()
        const id = Number(row.dataset.id)
        setTicked((s) => {
          const next = new Set(s)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, data, ticked, company.id])

  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const state = (needed: boolean, problems: string[], done: string | null, cancelled = false) =>
    cancelled ? <span className="warn">cancelled</span> : done ? <span className="ok">{done}</span> : !needed ? <span className="muted">not needed</span> : problems.length ? <span className="warn">{problems.length} to fix</span> : 'ready'
  return (
    <div>
      <Title right={<>{periodNote(data)} <span className="muted">· Space tick · Alt+J e-Invoice file · Alt+W e-Way Bill file</span></>}>e-Invoice and e-Way Bill</Title>
      {saved && <p className="ok">{/generated$/.test(saved) ? saved : `Saved ${saved}. Upload it on the portal, then enter what it gives back on each voucher (Enter).`}</p>}
      {gsp && (
        <div className="actions" style={{ justifyContent: 'flex-start' }}>
          <button type="button" disabled={busy} onClick={() => generate('irn')}>Generate IRNs ({ticked.size || 'all ready'})</button>
          <button type="button" disabled={busy} onClick={() => generate('ewb')}>Generate e-Way Bills ({ticked.size || 'all ready'})</button>
          <span className="muted">through the API ({gsp.environment})</span>
        </div>
      )}
      <Errors errors={errors} />
      <table className="report">
        <thead>
          <tr>
            <th />
            <th>Date</th>
            <th>Voucher</th>
            <th>Party</th>
            <th className="num">Value</th>
            <th>e-Invoice (IRN)</th>
            <th>e-Way Bill</th>
          </tr>
        </thead>
        <tbody>
          {data.vouchers.map((v) => (
            <tr key={v.voucherId} data-id={v.voucherId} className="clickable" onClick={() => push({ k: 'e-document', voucherId: v.voucherId })}>
              <td>{ticked.has(v.voucherId) ? '✓' : ''}</td>
              <td>{fmtDate(v.date)}</td>
              <td>
                {v.type} No. {v.number}
              </td>
              <td>{v.party}</td>
              <td className="num">{amt(v.value)}</td>
              <td>{state(v.einvoice.needed, v.einvoice.problems, v.einvoice.irn && `${v.einvoice.irn.slice(0, 10)}…`, v.einvoice.cancelled)}</td>
              <td>{state(v.eway.needed, v.eway.problems, v.eway.ewbNo)}</td>
            </tr>
          ))}
          {!data.vouchers.length && (
            <tr className="muted">
              <td colSpan={7}>No sales, purchases or notes with GST in the period</td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="muted">
        e-Invoice: for invoices and notes to registered buyers and exports, once your turnover crosses the limit. e-Way Bill: goods worth more than ₹50,000 on the move.
        {gsp ? 'Generated through the API; the saved files remain for upload by hand.' : 'Without a GSP account, upload the saved files on einvoice1.gst.gov.in and ewaybillgst.gov.in (or set up the API: Alt+K, GSP).'}
      </p>
    </div>
  )
}

const MODES: [Transport['mode'], string][] = [
  ['1', 'Road'],
  ['2', 'Rail'],
  ['3', 'Air'],
  ['4', 'Ship'],
]

/** One voucher's e-Invoice and e-Way Bill: what to fix, the transport details, and what the portals gave back. */
export function EDocumentView({ voucherId }: { voucherId: number }) {
  const { company, version, changed } = useApp()
  const { data, error } = useLoad(() => api.eDocument(company.id, voucherId), [company.id, voucherId, version])
  const { data: gsp } = useLoad(() => api.gspSettings(company.id), [company.id, version])
  const [f, setF] = useState<Record<string, string>>({})
  const [apiErrors, setApiErrors] = useState<string[]>([])
  const [apiOk, setApiOk] = useState('')
  const [cancel, setCancel] = useState({ reason: '2', remark: '' })
  const [vehicle, setVehicle] = useState({ vehicleNo: '', fromPlace: '', fromState: '', reason: '1', remark: '' })
  const run = (what: string, p: () => Promise<unknown>) => {
    setApiErrors([])
    setApiOk('')
    p().then(() => (setApiOk(what), changed()), (e) => setApiErrors(messages(e)))
  }
  // the fields follow every load, so they show what was saved once the voucher reloads
  useEffect(() => {
    if (!data) return
    const r: Partial<EDocRecord> = data.record ?? {}
    const t: Partial<Transport> = r.transport ?? {}
    setF({
      mode: t.mode ?? '1', distance: t.distance === undefined ? '0' : String(t.distance), vehicleNo: t.vehicleNo ?? '', transporterId: t.transporterId ?? '',
      transporterName: t.transporterName ?? '', docNo: t.docNo ?? '', docDate: t.docDate ?? '',
      irn: r.irn ?? '', ackNo: r.ackNo ?? '', ackDate: r.ackDate ?? '', signedQr: r.signedQr ?? '', irnCancelled: r.irnCancelled ? 'Yes' : 'No',
      ewbNo: r.ewbNo ?? '', ewbDate: r.ewbDate ?? '', ewbValidUpto: r.ewbValidUpto ?? '',
    })
  }, [data])
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }))
  const { errors, ok, submit } = useSubmit(async () => {
    if (!/^\d+$/.test(f.distance.trim())) throw new ApiError('', ['Distance: whole kilometres (0 lets the portal work it out)'])
    await api.saveEDocument(company.id, voucherId, {
      transport: {
        mode: f.mode as Transport['mode'], distance: Number(f.distance), vehicleNo: f.vehicleNo || null, transporterId: f.transporterId || null,
        transporterName: f.transporterName || null, docNo: f.docNo || null, docDate: f.docDate || null,
      },
      irn: f.irn || null, ackNo: f.ackNo || null, ackDate: f.ackDate || null, signedQr: f.signedQr || null, irnCancelled: f.irnCancelled === 'Yes',
      ewbNo: f.ewbNo || null, ewbDate: f.ewbDate || null, ewbValidUpto: f.ewbValidUpto || null,
    })
    changed()
    return 'Saved'
  })
  if (error) return <Errors errors={[error]} />
  if (!data || !('mode' in f)) return <p className="muted">Loading…</p>
  const { input } = data
  const field = (k: string, label: string, extra: object = {}) => (
    <label>
      {label}
      <input value={f[k]} onChange={set(k)} aria-label={label} {...extra} />
    </label>
  )
  return (
    <form className="form wide" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || <span className="muted">Ctrl+A save</span>}>
        {input.type} No. {input.number} of {fmtDate(input.date)}: e-Invoice and e-Way Bill
      </Title>
      <p>
        {input.seller.legalName} → {input.buyer.legalName} · {amt(input.invoiceValue)}
      </p>
      <h3 className="sub">e-Invoice {data.einvoice.needed ? '' : '(not needed)'}</h3>
      {data.einvoice.problems.length > 0 ? (
        <Errors errors={data.einvoice.problems} />
      ) : (
        <p>
          Ready.{' '}
          <button type="button" onClick={() => saveJson([data.einvoiceJson], `e-Invoice_${input.type.replace(' ', '-')}_${input.number}.json`)}>
            Save e-Invoice JSON
          </button>
        </p>
      )}
      {gsp && (
        <div className="actions" style={{ justifyContent: 'flex-start' }}>
          {(!data.einvoice.irn || data.einvoice.cancelled) && data.einvoice.problems.length === 0 && (
            <button type="button" className="primary" onClick={() => run('IRN generated', () => api.generateIrn(company.id, voucherId))}>Generate IRN</button>
          )}
          {data.einvoice.irn && !data.einvoice.cancelled && (
            <>
              <select value={cancel.reason} onChange={(e) => setCancel({ ...cancel, reason: e.target.value })} aria-label="Reason to cancel">
                <option value="1">Duplicate</option>
                <option value="2">Data entry mistake</option>
                <option value="3">Order cancelled</option>
                <option value="4">Other</option>
              </select>
              <input placeholder="Remark" value={cancel.remark} onChange={(e) => setCancel({ ...cancel, remark: e.target.value })} aria-label="Remark" />
              <button type="button" onClick={() => run('IRN cancelled', () => api.cancelIrn(company.id, voucherId, cancel.reason, cancel.remark))}>Cancel IRN (within 24 hours)</button>
            </>
          )}
        </div>
      )}
      <div className="inline">
        {field('irn', 'IRN', { size: 66 })}
        {field('ackNo', 'Ack No.')}
        {field('ackDate', 'Ack Date')}
      </div>
      <label>
        Signed QR code (paste from the IRP; the IRN is read from it)
        <textarea rows={3} value={f.signedQr} onChange={set('signedQr')} aria-label="Signed QR code" />
      </label>
      <label>
        IRN cancelled
        <select value={f.irnCancelled} onChange={set('irnCancelled')} aria-label="IRN cancelled">
          <option>No</option>
          <option>Yes</option>
        </select>
      </label>
      <h3 className="sub">e-Way Bill {data.eway.needed ? '' : '(not needed: goods under ₹50,000 or none)'}</h3>
      <div className="inline">
        <label>
          Mode
          <select value={f.mode} onChange={set('mode')} aria-label="Mode of transport">
            {MODES.map(([v, n]) => (
              <option key={v} value={v}>
                {n}
              </option>
            ))}
          </select>
        </label>
        {field('distance', 'Distance (km)', { inputMode: 'numeric', className: 'amount' })}
        {field('vehicleNo', 'Vehicle No.', { placeholder: 'KA01AB1234' })}
      </div>
      <div className="inline">
        {field('transporterId', 'Transporter ID')}
        {field('transporterName', 'Transporter')}
        {field('docNo', 'LR/RR No.')}
        {field('docDate', 'LR/RR date', { type: 'date' })}
      </div>
      {data.eway.problems.length > 0 ? (
        <Errors errors={data.eway.problems} />
      ) : (
        <p>
          Ready.{' '}
          <button type="button" onClick={() => saveJson(data.ewayJson, `e-Way-Bill_${input.type.replace(' ', '-')}_${input.number}.json`)}>
            Save e-Way Bill JSON
          </button>
        </p>
      )}
      {gsp && (
        <div className="actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
          {!data.eway.ewbNo && data.eway.problems.length === 0 && (
            <button type="button" className="primary" onClick={() => run('e-Way Bill generated', () => api.generateEwb(company.id, voucherId))}>
              Generate e-Way Bill{data.einvoice.irn && !data.einvoice.cancelled ? ' (by IRN)' : ''}
            </button>
          )}
          {data.eway.ewbNo && (
            <>
              <input placeholder="New vehicle No." value={vehicle.vehicleNo} onChange={(e) => setVehicle({ ...vehicle, vehicleNo: e.target.value })} aria-label="New vehicle No." />
              <input placeholder="From place" value={vehicle.fromPlace} onChange={(e) => setVehicle({ ...vehicle, fromPlace: e.target.value })} aria-label="From place" />
              <input placeholder="State code" size={4} value={vehicle.fromState} onChange={(e) => setVehicle({ ...vehicle, fromState: e.target.value })} aria-label="From state code" />
              <select value={vehicle.reason} onChange={(e) => setVehicle({ ...vehicle, reason: e.target.value })} aria-label="Reason for the new vehicle">
                <option value="1">Breakdown</option>
                <option value="2">Transhipment</option>
                <option value="3">Others</option>
                <option value="4">First time</option>
              </select>
              <button type="button" onClick={() => run('Vehicle updated', () => api.updateVehicle(company.id, voucherId, vehicle))}>Update vehicle (Part B)</button>
              <button type="button" onClick={() => run('e-Way Bill cancelled', () => api.cancelEwb(company.id, voucherId, cancel.reason, cancel.remark))}>Cancel e-Way Bill</button>
            </>
          )}
        </div>
      )}
      {apiOk && <p className="ok">{apiOk}</p>}
      <Errors errors={apiErrors} />
      <div className="inline">
        {field('ewbNo', 'e-Way Bill No.', { inputMode: 'numeric' })}
        {field('ewbDate', 'Generated on')}
        {field('ewbValidUpto', 'Valid up to')}
      </div>
      <Errors errors={errors} />
      <div className="actions">
        <button type="submit" className="primary">
          <b>Ctrl+A</b> Save
        </button>
      </div>
    </form>
  )
}

const NIC = {
  sandbox: { einvoice: 'https://einv-apisandbox.nic.in', eway: 'https://ewb.nic.in' },
  production: { einvoice: 'https://einv-api.nic.in', eway: 'https://ewb.nic.in' },
}

/** Alt+K, GSP: access to the e-Invoice and e-Way Bill APIs. Secrets are sent, never shown; blank keeps the saved one. */
export function GspSettingsForm() {
  const { company, version, changed } = useApp()
  const { data } = useLoad(() => api.gspSettings(company.id), [company.id, version])
  const { data: log } = useLoad(() => api.gspLog(company.id), [company.id, version])
  const [f, setF] = useState({
    environment: 'sandbox' as 'sandbox' | 'production', einvoiceBase: NIC.sandbox.einvoice, ewayBase: NIC.sandbox.eway, clientId: '', clientSecret: '', einvoiceUser: '', einvoicePassword: '',
    ewayUser: '', ewayPassword: '', publicKey: '', ewayPublicKey: '', headers: '',
  })
  const [test, setTest] = useState<{ einvoice: string; eway: string } | null>(null)
  useEffect(() => {
    if (!data) return
    setF((x) => ({ ...x, environment: data.environment, einvoiceBase: data.einvoiceBase, ewayBase: data.ewayBase, clientId: data.clientId, einvoiceUser: data.einvoiceUser,
      ewayUser: data.ewayUser ?? '', publicKey: data.publicKey, ewayPublicKey: data.ewayPublicKey ?? '',
      headers: Object.entries(data.extraHeaders ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n') }))
  }, [data])
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }))
  const { errors, setErrors, ok, submit } = useSubmit(async () => {
    const extraHeaders = Object.fromEntries(f.headers.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const i = l.indexOf(':')
      if (i < 1) throw new ApiError('', [`"${l}" is not a header (name: value)`])
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }))
    await api.setGspSettings(company.id, { ...f, extraHeaders, ewayUser: f.ewayUser || null, ewayPassword: f.ewayPassword || null, ewayPublicKey: f.ewayPublicKey || null })
    changed()
    setF((x) => ({ ...x, clientSecret: '', einvoicePassword: '', ewayPassword: '' }))
    return 'Saved. Test the connection next.'
  })
  const field = (k: keyof typeof f, label: string, extra: object = {}) => (
    <label>{label}<input value={f[k]} onChange={set(k)} aria-label={label} {...extra} /></label>
  )
  const secret = (k: 'clientSecret' | 'einvoicePassword' | 'ewayPassword', label: string, isSet?: boolean) => (
    <label>{label}<input type="password" autoComplete="new-password" value={f[k]} onChange={set(k)} placeholder={isSet ? 'saved (leave blank to keep)' : ''} aria-label={label} /></label>
  )
  return (
    <form className="form wide" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || <span className="muted">Ctrl+A save</span>}>GSP: e-Invoice and e-Way Bill API</Title>
      <p className="muted">
        From your GSP (or NIC, for direct access): the API addresses, a client id and secret, the API user names and passwords you create on the e-Invoice and e-Way Bill
        portals (API registration), and the portals' public key. Try the sandbox first.
      </p>
      <label>
        Environment
        <select value={f.environment} onChange={(e) => {
          const env = e.target.value as 'sandbox' | 'production'
          setF((x) => ({ ...x, environment: env, ...(Object.values(NIC).some((n) => n.einvoice === x.einvoiceBase) ? { einvoiceBase: NIC[env].einvoice, ewayBase: NIC[env].eway } : {}) }))
        }} aria-label="Environment">
          <option value="sandbox">Sandbox (testing)</option>
          <option value="production">Production (live)</option>
        </select>
      </label>
      {field('einvoiceBase', 'e-Invoice API address')}
      {field('ewayBase', 'e-Way Bill API address')}
      {field('clientId', 'Client id')}
      {secret('clientSecret', 'Client secret', data?.clientSecretSet)}
      {field('einvoiceUser', 'e-Invoice API user name')}
      {secret('einvoicePassword', 'e-Invoice API password', data?.einvoicePasswordSet)}
      {field('ewayUser', 'e-Way Bill API user name')}
      {secret('ewayPassword', 'e-Way Bill API password', data?.ewayPasswordSet)}
      <label>Public key (PEM, from the portal)<textarea rows={4} value={f.publicKey} onChange={set('publicKey')} placeholder="-----BEGIN PUBLIC KEY-----" aria-label="Public key" /></label>
      <label>e-Way Bill public key, if different<textarea rows={3} value={f.ewayPublicKey} onChange={set('ewayPublicKey')} aria-label="e-Way Bill public key" /></label>
      <label>Your GSP's own headers, one a line (name: value)<textarea rows={3} value={f.headers} onChange={set('headers')} placeholder="x-subscription-key: …" aria-label="GSP headers" /></label>
      <Errors errors={errors} />
      <div className="actions">
        {data && (
          <button type="button" onClick={() => api.gspTest(company.id).then((r) => (setTest(r), changed()), (e) => setErrors(messages(e)))}>Test the connection</button>
        )}
        <button type="submit" className="primary"><b>Ctrl+A</b> Save</button>
      </div>
      {test && <p>e-Invoice: <b>{test.einvoice}</b> · e-Way Bill: <b>{test.eway}</b></p>}
      {log && log.length > 0 && (
        <>
          <h3 className="sub">Calls made</h3>
          <table className="report">
            <thead><tr><th>When</th><th>System</th><th>What</th><th>Result</th></tr></thead>
            <tbody>
              {log.slice(0, 50).map((l) => (
                <tr key={l.id}><td>{l.at}</td><td>{l.system === 'einvoice' ? 'e-Invoice' : 'e-Way Bill'}</td><td>{l.action}</td><td className={l.ok ? '' : 'warn'}>{l.message}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </form>
  )
}
