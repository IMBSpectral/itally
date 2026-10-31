import { useEffect, useState } from 'react'
import { useApp } from '../App'
import { api, ApiError, type Period, type Voucher } from '../api'
import type { VoucherType } from '../../server/src/engine/voucher'
import { amt, Errors, fmtDate, Title, useActive, useLoad } from '../ui'

/**
 * Day Book: every voucher in the period. Arrows select, Enter alters,
 * Alt+X cancels (keeps the number), Alt+D deletes; both ask first.
 */
export function DayBook({ type, range }: { type?: VoucherType; range?: Period } = {}) {
  const { company, period: appPeriod, version, push, changed, config } = useApp()
  const period = range ?? appPeriod
  const { data, error } = useLoad(() => api.vouchers(company.id, period, type), [company.id, period.from, period.to, version, type])
  const [sel, setSel] = useState(0)
  const [confirm, setConfirm] = useState<{ kind: 'cancel' | 'delete'; v: Voucher } | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const rows = data ?? []
  const active = useActive()
  useEffect(() => setErrors([]), [version]) // a message about the books goes once they change

  async function act(kind: 'cancel' | 'delete', v: Voucher) {
    setConfirm(null)
    try {
      if (kind === 'cancel') await api.cancelVoucher(company.id, v.id)
      else await api.deleteVoucher(company.id, v.id)
      changed()
    } catch (e) {
      setErrors(e instanceof ApiError ? e.errors : [String(e)])
    }
  }

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (confirm) {
        if (e.key === 'y' || e.key === 'Y' || e.key === 'Enter') act(confirm.kind, confirm.v)
        if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') {
          e.stopImmediatePropagation()
          setConfirm(null)
        }
        e.preventDefault()
        return
      }
      const v = rows[sel]
      if (e.key === 'ArrowDown') setSel((s) => Math.min(s + 1, rows.length - 1))
      else if (e.key === 'ArrowUp') setSel((s) => Math.max(s - 1, 0))
      else if (e.key === 'Enter' && v && !v.cancelled) push({ k: 'voucher', type: v.type, id: v.id })
      else if (e.altKey && (e.key === 'p' || e.key === 'P') && v) {
        e.stopImmediatePropagation() // print this voucher, not the whole Day Book
        push({ k: 'voucher-print', id: v.id })
      } else if (e.altKey && (e.key === 'x' || e.key === 'X') && v && !v.cancelled) setConfirm({ kind: 'cancel', v })
      else if (e.altKey && (e.key === 'd' || e.key === 'D') && v) setConfirm({ kind: 'delete', v })
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  })

  if (error) return <Errors errors={[error]} />
  return (
    <div>
      <Title right={<span className="muted" data-own-keys>Enter alter · Alt+P print · Alt+X cancel · Alt+D delete</span>}>{type ? `${type} vouchers` : 'Day Book'}</Title>
      {confirm && (
        <div className="confirm" role="alertdialog">
          {confirm.kind === 'cancel' ? 'Cancel' : 'Delete'} {confirm.v.type} No. {confirm.v.docNo ?? confirm.v.number}? <b>Y</b>es / <b>N</b>o
        </div>
      )}
      <Errors errors={errors} />
      <table className="report">
        <thead>
          <tr>
            <th>Date</th>
            <th>Particulars</th>
            <th>Vch Type</th>
            <th className="num">Vch No.</th>
            <th className="num">Debit Amount</th>
            <th className="num">Credit Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v, i) => {
            const first = v.entries[0]
            const total = v.entries.reduce((t, e) => t + Math.max(e.amount, 0), 0)
            return (
              <tr
                key={v.id}
                className={`clickable ${i === sel ? 'sel' : ''} ${v.cancelled ? 'cancelled' : ''}`}
                onClick={() => setSel(i)}
                onDoubleClick={() => !v.cancelled && push({ k: 'voucher', type: v.type, id: v.id })}
              >
                <td>{fmtDate(v.date)}</td>
                <td>
                  {v.cancelled ? '(cancelled)' : first?.ledger ?? v.party ?? 'Stock'}
                  {(v.optional || v.type === 'Memorandum') && !v.cancelled ? <span className="badge muted-badge small">{v.type === 'Memorandum' ? 'memo' : 'optional'}</span> : null}
                  {/* an inventory voucher posts nothing to ledgers: its items' value is shown instead */}
                  {!first && !v.cancelled && v.stockValue ? <span className="muted small"> · items {amt(v.stockValue)}</span> : null}
                  {v.narration && config.dayBookNarration && <div className="muted small">{v.narration}</div>}
                </td>
                <td>{v.voucherType ?? v.type}</td>
                <td className="num">{v.docNo ?? v.number}</td>
                <td className="num">{first && first.amount > 0 ? amt(total) : ''}</td>
                <td className="num">{first && first.amount < 0 ? amt(total) : ''}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {data && rows.length === 0 && <p className="muted">No vouchers in this period. Press F4–F9 to enter one.</p>}
    </div>
  )
}
