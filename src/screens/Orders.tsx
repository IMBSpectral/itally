import { useApp } from '../App'
import { api, type PendingType } from '../api'
import { formatINR } from '../../server/src/engine/money'
import { amt, Errors, fmtDate, Title, useLoad } from '../ui'
import { periodNote } from './Books'
import { qty } from './Inventory'

const TITLES: Record<PendingType, string> = {
  'Sales Order': 'Sales Order Outstandings',
  'Purchase Order': 'Purchase Order Outstandings',
  'Delivery Note': 'Sales Bills Pending',
  'Receipt Note': 'Purchase Bills Pending',
}

/**
 * What is still to come on orders (not yet delivered or received) or notes (not yet invoiced),
 * line by line with the party and what is overdue. Enter opens the order or note.
 */
export function PendingView({ type }: { type: PendingType }) {
  const { company, period, version, push } = useApp()
  // as on the period's end, or today while that is still ahead (nothing is overdue in the future)
  const today = new Date().toLocaleDateString('en-CA')
  const asOf = period.to < today ? period.to : today
  const { data, error } = useLoad(() => api.pending(company.id, type, { asOf }), [company.id, type, asOf, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const order = type.endsWith('Order')
  const doneWord = order ? (type === 'Sales Order' ? 'Delivered' : 'Received') : 'Invoiced'
  const total = data.lines.reduce((t, l) => t + l.value, 0)
  return (
    <div>
      <Title right={<span className="muted">as on {fmtDate(data.asOf)}</span>}>{TITLES[type]}</Title>
      {data.lines.length === 0 ? (
        <p className="muted">Nothing pending.</p>
      ) : (
        <table className="report">
          <thead>
            <tr>
              <th>Date</th>
              <th>{type} No.</th>
              <th>Party</th>
              <th>Item</th>
              {order && <th>Due on</th>}
              <th className="num">{order ? 'Ordered' : 'Quantity'}</th>
              <th className="num">{doneWord}</th>
              <th className="num">Pending</th>
              <th className="num">Rate</th>
              <th className="num">Value</th>
              {order && <th className="num">Overdue by</th>}
            </tr>
          </thead>
          <tbody>
            {data.lines.map((l) => (
              <tr key={`${l.voucherId}-${l.itemId}`} className="clickable" onClick={() => push({ k: 'voucher', type: l.type, id: l.voucherId })}>
                <td>{fmtDate(l.date)}</td>
                <td>{l.docNo ?? l.number}</td>
                <td>{l.party}</td>
                <td>{l.item}</td>
                {order && <td>{l.dueDate ? fmtDate(l.dueDate) : ''}</td>}
                <td className="num">{qty(l.ordered, l.unit, l.decimals)}</td>
                <td className="num">{qty(l.done, l.unit, l.decimals)}</td>
                <td className="num">{qty(l.pending, l.unit, l.decimals)}</td>
                <td className="num">{l.rate ? `${formatINR(l.rate)}/${l.unit}` : ''}</td>
                <td className="num">{amt(l.value)}</td>
                {order && <td className={`num ${l.overdueDays ? 'neg' : ''}`}>{l.overdueDays ? `${l.overdueDays} days` : ''}</td>}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={order ? 9 : 8}>Total pending</td>
              <td className="num total">{formatINR(total)}</td>
              {order && <td />}
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  )
}

/** Godown Summary: each location's stock at the end of the period, valued at average cost. */
export function GodownSummaryView() {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.godownSummary(company.id, period), [company.id, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={periodNote(data)}>Godown Summary</Title>
      <table className="report">
        <thead>
          <tr>
            <th>Particulars</th>
            <th className="num">Quantity</th>
            <th className="num">Rate</th>
            <th className="num">Value</th>
          </tr>
        </thead>
        <tbody>
          {data.godowns.map((g) => [
            <tr key={`g${g.id}`} className="group-row">
              <td>
                <b>{g.name}</b>
              </td>
              <td />
              <td />
              <td className="num">
                <b>{amt(g.value)}</b>
              </td>
            </tr>,
            ...g.items.map((i) => (
              <tr key={`g${g.id}-${i.id}`} className="clickable" onClick={() => push({ k: 'stock-item-vouchers', itemId: i.id })}>
                <td className="indent">{i.name}</td>
                <td className={`num ${i.qty < 0 ? 'neg' : ''}`}>{qty(i.qty, i.unit, i.decimals)}</td>
                <td className="num">{i.rate ? formatINR(i.rate) : ''}</td>
                <td className="num">{amt(i.value)}</td>
              </tr>
            )),
          ])}
        </tbody>
        <tfoot>
          <tr>
            <td>Grand Total</td>
            <td />
            <td />
            <td className="num total">{formatINR(data.total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
