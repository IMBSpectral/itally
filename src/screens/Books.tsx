import { useState } from 'react'
import { useApp } from '../App'
import { api, type Period } from '../api'
import type { VoucherType } from '../../server/src/engine/voucher'
import { amt, drcr, Errors, fmtDate, MONTHS, Picker, Title, useLoad } from '../ui'

export const periodNote = (p: Period) => (
  <span className="muted">
    {fmtDate(p.from)} to {fmtDate(p.to)}
  </span>
)
export const monthName = (m: string) => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`
/** The first and last day of a YYYY-MM month, clipped to the period. */
export function monthRange(m: string, p: Period): Period {
  const [y, mo] = m.split('-').map(Number)
  const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10)
  const first = `${m}-01`
  return { from: first < p.from ? p.from : first, to: last > p.to ? p.to : last }
}

/** Group Summary (one group), or Cash/Bank Books: sub-groups and ledgers with their movement. */
export function GroupSummaryView({ groupId, cashBank }: { groupId?: number; cashBank?: boolean }) {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.groupSummary(company.id, period, cashBank ? { cashBank: true } : { groupId: groupId! }), [
    company.id, period, version, groupId, cashBank,
  ])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={periodNote(data)}>{cashBank ? 'Cash/Bank Books' : `Group Summary: ${data.title}`}</Title>
      <table className="report">
        <thead>
          <tr>
            <th>Particulars</th>
            <th className="num">Opening Balance</th>
            <th className="num">Debit</th>
            <th className="num">Credit</th>
            <th className="num">Closing Balance</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l) => (
            <tr
              key={`${l.kind}${l.id}`}
              className={`clickable ${l.kind === 'group' ? 'group-row' : ''}`}
              onClick={() =>
                push(l.kind === 'group' ? { k: 'group-summary', groupId: l.id } : l.kind === 'stock' ? { k: 'stock-summary' } : { k: 'ledger-monthly', ledgerId: l.id })
              }
            >
              <td>{l.name}</td>
              <td className="num">{drcr(l.opening)}</td>
              <td className="num">{amt(l.debit)}</td>
              <td className="num">{amt(l.credit)}</td>
              <td className="num">{drcr(l.closing)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Grand Total</td>
            <td className="num total">{drcr(data.total.opening)}</td>
            <td className="num total">{amt(data.total.debit)}</td>
            <td className="num total">{amt(data.total.credit)}</td>
            <td className="num total">{drcr(data.total.closing)}</td>
          </tr>
        </tfoot>
      </table>
      {data.lines.length === 0 && <p className="muted">Nothing in this group for the period.</p>}
    </div>
  )
}

/** Group Vouchers: every entry on the group's ledgers, with a running balance. */
export function GroupVouchersView({ groupId }: { groupId: number }) {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.groupVouchers(company.id, period, groupId), [company.id, period, version, groupId])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={periodNote(data)}>Group Vouchers: {data.group.name}</Title>
      <table className="report">
        <thead>
          <tr>
            <th>Date</th>
            <th>Ledger</th>
            <th>Vch Type</th>
            <th className="num">Vch No.</th>
            <th className="num">Debit</th>
            <th className="num">Credit</th>
            <th className="num">Balance</th>
          </tr>
        </thead>
        <tbody>
          <tr className="muted">
            <td />
            <td>Opening Balance</td>
            <td colSpan={4} />
            <td className="num">{drcr(data.opening)}</td>
          </tr>
          {data.lines.map((l, i) => (
            <tr key={i} className="clickable" onClick={() => push({ k: 'voucher', type: l.type, id: l.voucherId })}>
              <td>{fmtDate(l.date)}</td>
              <td>{l.ledger}</td>
              <td>{l.type}</td>
              <td className="num">{l.docNo ?? l.number}</td>
              <td className="num">{l.amount > 0 ? amt(l.amount) : ''}</td>
              <td className="num">{l.amount < 0 ? amt(-l.amount) : ''}</td>
              <td className="num">{drcr(l.balance)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td />
            <td>Closing Balance</td>
            <td colSpan={4} />
            <td className="num total">{drcr(data.closing)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

/** A voucher register: one line per month; a month opens its vouchers. */
export function RegisterView({ type }: { type: VoucherType }) {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.register(company.id, period, type), [company.id, period, version, type])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const total = data.months.reduce((t, m) => ({ count: t.count + m.count, value: t.value + m.total }), { count: 0, value: 0 })
  return (
    <div>
      <Title right={periodNote(data)}>{type} Register</Title>
      <table className="report">
        <thead>
          <tr>
            <th>Particulars</th>
            <th className="num">Vouchers</th>
            <th className="num">Total value</th>
          </tr>
        </thead>
        <tbody>
          {data.months.map((m) => (
            <tr key={m.month} className={m.count ? 'clickable' : 'muted'} onClick={() => m.count && push({ k: 'daybook', type, range: monthRange(m.month, data) })}>
              <td>{monthName(m.month)}</td>
              <td className="num">{m.count || ''}</td>
              <td className="num">{amt(m.total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Grand Total</td>
            <td className="num total">{total.count}</td>
            <td className="num total">{amt(total.value)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

/** Tally's Ledger in Account Books: a month-wise summary; a month opens its vouchers. */
export function LedgerMonthlyView({ ledgerId }: { ledgerId: number }) {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.ledgerMonthly(company.id, ledgerId, period), [company.id, period, version, ledgerId])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const dr = data.months.reduce((t, m) => t + m.debit, 0)
  const cr = data.months.reduce((t, m) => t + m.credit, 0)
  return (
    <div>
      <Title right={periodNote(data)}>Ledger: {data.ledger.name}</Title>
      <table className="report">
        <thead>
          <tr>
            <th>Particulars</th>
            <th className="num">Debit</th>
            <th className="num">Credit</th>
            <th className="num">Closing Balance</th>
          </tr>
        </thead>
        <tbody>
          <tr className="muted">
            <td>Opening Balance</td>
            <td colSpan={2} />
            <td className="num">{drcr(data.opening)}</td>
          </tr>
          {data.months.map((m) => (
            <tr
              key={m.month}
              className={m.debit || m.credit ? 'clickable' : 'muted'}
              onClick={() => (m.debit || m.credit) && push({ k: 'statement', ledgerId, range: monthRange(m.month, data) })}
            >
              <td>{monthName(m.month)}</td>
              <td className="num">{amt(m.debit)}</td>
              <td className="num">{amt(m.credit)}</td>
              <td className="num">{drcr(m.closing)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Grand Total</td>
            <td className="num total">{amt(dr)}</td>
            <td className="num total">{amt(cr)}</td>
            <td className="num total">{drcr(data.closing)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

/** Choose a group for Group Summary or Group Vouchers. */
export function GroupPick({ next }: { next: 'summary' | 'vouchers' }) {
  const { company, replace } = useApp()
  const { data } = useLoad(() => api.groups(company.id), [company.id])
  const [id, setId] = useState<number | null>(null)
  return (
    <div className="form narrow">
      <Title>{next === 'summary' ? 'Group Summary' : 'Group Vouchers'}</Title>
      <label>
        Name of group
        <Picker
          options={(data ?? []).map((g) => ({ id: g.id, name: g.name, hint: g.nature }))}
          value={id}
          onChange={(v) => {
            setId(v)
            replace(next === 'summary' ? { k: 'group-summary', groupId: v } : { k: 'group-vouchers', groupId: v })
          }}
          autoFocus
        />
      </label>
    </div>
  )
}
