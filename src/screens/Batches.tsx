import { useApp } from '../App'
import { api } from '../api'
import { amt, Errors, fmtDate, Title, useLoad } from '../ui'
import { periodNote } from './Books'
import { qtyField } from './Invoice'

/** Batches and Cost Tracking. */

/** Batch-wise stock: each batch of the items kept in batches, by godown, with how long it has before it expires. */
export function BatchesView() {
  const { company, period, version } = useApp()
  const { data, error } = useLoad(() => api.batches(company.id, period.to), [company.id, period.to, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const status = (d: number | null) =>
    d === null ? '' : d < 0 ? <span className="errors-inline">expired {-d} days ago</span> : d <= 30 ? <b>expires in {d} days</b> : <span className="muted">{d} days left</span>
  return (
    <div>
      <Title right={<span className="muted">as on {fmtDate(data.asOf)}</span>}>Batches</Title>
      <table className="report">
        <thead><tr><th>Item</th><th>Batch</th><th>Godown</th><th className="num">In stock</th><th>Made on</th><th>Expires on</th><th>Expiry</th></tr></thead>
        <tbody>
          {data.batches.map((b) => (
            <tr key={`${b.itemId}/${b.batch}/${b.godown}`}>
              <td>{b.item}</td><td>{b.batch}</td><td>{b.godown}</td>
              <td className="num">{qtyField(b.qty, b)} {b.unit}</td>
              <td>{b.mfgDate ? fmtDate(b.mfgDate) : ''}</td><td>{b.expiryDate ? fmtDate(b.expiryDate) : ''}</td><td>{status(b.daysLeft)}</td>
            </tr>
          ))}
          {!data.batches.length && <tr className="muted"><td colSpan={7}>No batches in stock. Set "Maintain in batches" on a stock item.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

/** Cost Tracking: the sales and costs of each cost track named on vouchers, and the margin. */
export function CostTracksView() {
  const { company, period, version } = useApp()
  const { data, error } = useLoad(() => api.costTracks(company.id, period), [company.id, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const signed = (p: number) => (p < 0 ? `-${amt(-p)}` : amt(p))
  return (
    <div>
      <Title right={periodNote(data)}>Cost Tracking</Title>
      <table className="report">
        <thead><tr><th>Cost track</th><th className="num">Vouchers</th><th className="num">Sales</th><th className="num">Costs</th><th className="num">Margin</th><th className="num">Margin %</th><th className="num">Goods in</th><th className="num">Goods out</th></tr></thead>
        <tbody>
          {data.tracks.map((t) => (
            <tr key={t.track}>
              <td>{t.track}</td><td className="num">{t.vouchers}</td><td className="num">{amt(t.sales)}</td><td className="num">{amt(t.costs)}</td>
              <td className="num"><b>{signed(t.margin)}</b></td><td className="num">{t.sales ? `${((t.margin / t.sales) * 100).toFixed(1)}%` : ''}</td>
              <td className="num">{amt(t.goodsIn)}</td><td className="num">{amt(t.goodsOut)}</td>
            </tr>
          ))}
          {!data.tracks.length && <tr className="muted"><td colSpan={8}>No vouchers name a cost track in this period (the Cost track field, with cost tracking on in F11).</td></tr>}
        </tbody>
      </table>
    </div>
  )
}
