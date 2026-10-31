import { useState } from 'react'
import { useApp } from '../App'
import { api } from '../api'
import { amt, Errors, fmtDate, Picker, Title, useLoad } from '../ui'
import { messages } from './Masters'
import { periodNote } from './Books'

/** Payment gateway reconciliation and the Kerala Flood Cess report. */

/** Payment Gateway Reconciliation: a gateway's settlement report against the receipts on its ledger; each settlement posted as one Receipt. */
export function GatewayRecoView() {
  const { company, period, version, changed, push } = useApp()
  const { data: known } = useLoad(() => api.gateways(company.id), [company.id, version])
  const { data: ledgers } = useLoad(() => api.ledgers(company.id, period), [company.id, period, version])
  const [gateway, setGateway] = useState('Razorpay')
  const [ledgerId, setLedgerId] = useState<number | null>(null)
  const [post, setPost] = useState<{ bankLedgerId: number | null; feeLedgerId: number | null; taxLedgerId: number | null }>({ bankLedgerId: null, feeLedgerId: null, taxLedgerId: null })
  const [errors, setErrors] = useState<string[]>([])
  const [note, setNote] = useState<string | null>(null)
  const { data, error } = useLoad(() => (ledgerId ? api.gatewayReco(company.id, gateway, ledgerId, period) : Promise.resolve(null)), [company.id, gateway, ledgerId, period, version])
  const options = (ledgers ?? []).map((l) => ({ id: l.id, name: l.name, hint: l.group ?? '' }))
  const upload = async (f: File) => {
    setErrors([])
    try {
      const bytes = new Uint8Array(await f.arrayBuffer())
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      const r = await api.uploadGatewayReport(company.id, gateway, btoa(bin))
      setNote(`${r.kept} payments kept${r.failed.length ? `; rows not read: ${r.failed.map((x) => `${x.row} (${x.errors.join('; ')})`).join(', ')}` : ''}`)
      changed()
    } catch (e) {
      setErrors(messages(e))
    }
  }
  const postSettlement = async (id: string) => {
    setErrors([])
    if (!ledgerId || !post.bankLedgerId || !post.feeLedgerId) return setErrors(['Choose the bank the settlement went to and the ledger for the gateway fee'])
    try {
      const v = await api.postSettlement(company.id, gateway, id, { gatewayLedgerId: ledgerId, bankLedgerId: post.bankLedgerId, feeLedgerId: post.feeLedgerId, taxLedgerId: post.taxLedgerId })
      setNote(`Settlement ${id} posted as Receipt ${v.id}`)
      changed()
    } catch (e) {
      setErrors(messages(e))
    }
  }
  return (
    <div>
      <Title right={data ? periodNote(data) : null}>Payment Gateway Reconciliation</Title>
      <div className="inline form">
        <label>
          Gateway
          <input list="gateways" value={gateway} onChange={(e) => setGateway(e.target.value)} aria-label="Gateway" />
          <datalist id="gateways">{(known ?? []).map((g) => <option key={g.gateway} value={g.gateway}>{g.payments} payments</option>)}</datalist>
        </label>
        <label>
          Its ledger (receipts go to it)
          <Picker options={options} value={ledgerId} onChange={setLedgerId} placeholder="Razorpay" />
        </label>
        <label>
          Settlement report (.csv or .xlsx)
          <input type="file" accept=".csv,.xlsx" aria-label="Settlement report"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) upload(f)
            }} />
        </label>
      </div>
      {note && <p className="ok">{note}</p>}
      <Errors errors={errors} />
      {error && <Errors errors={[error]} />}
      {!ledgerId && (
        <p className="muted">
          Choose the gateway's ledger (a ledger under Bank Accounts the receipts are taken into) and upload the gateway's settlement report: a row per payment with its id, date,
          amount, fee, GST on the fee and settlement.
        </p>
      )}
      {data && (
        <>
          <p>
            {data.summary.matched} matched · <b>{data.summary.notInBooks}</b> not in the books · {data.notInReport.length} receipts not in the report · gross {amt(data.summary.gross)},
            fees and GST {amt(data.summary.fees)}
          </p>
          <table className="report">
            <thead><tr><th>Date</th><th>Payment</th><th>Reference</th><th className="num">Amount</th><th className="num">Fee + GST</th><th>Settlement</th><th>Status</th></tr></thead>
            <tbody>
              {data.payments.map((p) => (
                <tr key={p.id}>
                  <td>{fmtDate(p.date)}</td><td>{p.paymentId}</td><td className="muted">{p.reference ?? ''}</td><td className="num">{amt(p.amount)}</td>
                  <td className="num">{amt(p.fee + p.tax)}</td><td>{p.settlementId ?? <span className="muted">not settled</span>}</td>
                  <td>
                    {p.receipt ? (
                      <span className="clickable" onClick={() => push({ k: 'voucher', type: 'Receipt', id: p.receipt!.voucherId })}>{p.status} (Rcpt {p.receipt.docNo})</span>
                    ) : (
                      <span className="errors-inline">{p.status}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.notInReport.length > 0 && (
            <>
              <h3 className="sub">Receipts on the gateway's ledger not in the report</h3>
              <table className="report">
                <thead><tr><th>Date</th><th>Rcpt</th><th>Party</th><th>Narration</th><th className="num">Amount</th></tr></thead>
                <tbody>
                  {data.notInReport.map((r) => (
                    <tr key={r.voucherId}><td>{fmtDate(r.date)}</td><td>{r.docNo}</td><td>{r.party}</td><td className="muted">{r.narration}</td><td className="num">{amt(r.amount)}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <h3 className="sub">Settlements</h3>
          <div className="inline form">
            <label>Bank it went to<Picker options={options} value={post.bankLedgerId} onChange={(v) => setPost({ ...post, bankLedgerId: v })} placeholder="Bank" /></label>
            <label>Gateway fee ledger<Picker options={options} value={post.feeLedgerId} onChange={(v) => setPost({ ...post, feeLedgerId: v })} placeholder="Bank charges" /></label>
            <label>GST on the fee<Picker options={options} value={post.taxLedgerId} onChange={(v) => setPost({ ...post, taxLedgerId: v })} placeholder="Input IGST" /></label>
          </div>
          <table className="report">
            <thead><tr><th>Settlement</th><th>Settled on</th><th className="num">Payments</th><th className="num">Gross</th><th className="num">Fee</th><th className="num">GST</th><th className="num">Net to bank</th><th /></tr></thead>
            <tbody>
              {data.settlements.map((s) => (
                <tr key={s.settlementId}>
                  <td>{s.settlementId}</td><td>{s.settledOn ? fmtDate(s.settledOn) : ''}</td><td className="num">{s.count}</td><td className="num">{amt(s.gross)}</td>
                  <td className="num">{amt(s.fee)}</td><td className="num">{amt(s.tax)}</td><td className="num"><b>{amt(s.net)}</b></td>
                  <td>
                    {s.postedVoucherId ? (
                      <span className="clickable ok" onClick={() => push({ k: 'voucher', type: 'Receipt', id: s.postedVoucherId! })}>posted</span>
                    ) : (
                      <button type="button" onClick={() => postSettlement(s.settlementId)}>Post receipt</button>
                    )}
                  </td>
                </tr>
              ))}
              {!data.settlements.length && <tr className="muted"><td colSpan={8}>No settlements in the report for this period</td></tr>}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

/** Kerala Flood Cess: 1% (0.25% on 3% goods) on intra-state supplies to unregistered buyers in Kerala, August 2019 to July 2021. */
export function KeralaFloodCessView() {
  const { company, period, version } = useApp()
  const { data, error } = useLoad(() => api.keralaFloodCess(company.id, period), [company.id, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={periodNote(data)}>Kerala Flood Cess</Title>
      {!data.applicable ? (
        <p className="muted">{data.reason}.</p>
      ) : (
        <table className="report">
          <thead><tr><th>Date</th><th>Vch No.</th><th>Party</th><th className="num">GST rate</th><th className="num">Taxable</th><th className="num">Cess rate</th><th className="num">Cess</th></tr></thead>
          <tbody>
            {data.lines.map((l, i) => (
              <tr key={i}>
                <td>{fmtDate(l.date)}</td><td>{l.docNo}</td><td>{l.party}</td><td className="num">{l.gstRate / 100}%</td><td className="num">{amt(l.taxable)}</td>
                <td className="num">{l.rate / 100}%</td><td className="num">{amt(l.cess)}</td>
              </tr>
            ))}
            {!data.lines.length && <tr className="muted"><td colSpan={7}>No supplies liable to the cess</td></tr>}
          </tbody>
          <tfoot><tr><td colSpan={4}>Total</td><td className="num total">{amt(data.total.taxable)}</td><td /><td className="num total">{amt(data.total.cess)}</td></tr></tfoot>
        </table>
      )}
    </div>
  )
}
