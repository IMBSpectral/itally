import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Bill, BillType, PendingBill } from '../api'
import { formatINR, toPaise } from '../../server/src/engine/money'
import { parseShortDate } from '../../server/src/engine/dates'
import { drcr, fmtDate, Picker } from '../ui'

const TYPES: BillType[] = ['New Ref', 'Agst Ref', 'Advance', 'On Account']
const TYPE_KEYS: Record<string, BillType> = { n: 'New Ref', a: 'Agst Ref', d: 'Advance', o: 'On Account' }

interface Row {
  type: BillType
  name: string
  due: string // as typed: days ("30") or a date ("15-6"); blank = the ledger's credit period
  amount: string // rupees, positive
}

const paise = (s: string) => {
  try {
    return s.trim() ? toPaise(s) : 0
  } catch {
    return NaN
  }
}
const rupees = (p: number) => formatINR(Math.abs(p)).replace(/,/g, '')

/**
 * Tally's "Bill-wise Details" for one voucher line on a party ledger: how the line's amount
 * splits across bills. Opens after the amount; defaults to settling the oldest open bill on
 * the other side, otherwise a New Ref named after the voucher. Keys: N/A/D/O pick the type,
 * Enter moves on, and when the bills add up to the line the panel closes itself.
 */
export function BillPanel({
  ledger,
  amount,
  voucherDate,
  fyStart,
  pending,
  initial,
  defaultName,
  onDone,
}: {
  ledger: string
  amount: number // the line's amount, signed (+ Dr)
  voucherDate: string
  fyStart: string
  pending: PendingBill[] // this ledger's open bills, excluding the voucher being altered
  initial?: Bill[] | null
  defaultName: string
  onDone: (bills: Bill[]) => void
}) {
  const sign = Math.sign(amount) || 1
  const total = Math.abs(amount)
  // bills on the other side are the ones this line can settle
  const settleable = pending.filter((b) => Math.sign(b.pending) === -sign)

  const used = (rows: Row[]) => new Set(rows.map((r) => r.name.toLowerCase()))
  function nextDefault(rows: Row[]): Row {
    const left = total - rows.reduce((t, r) => t + (paise(r.amount) || 0), 0)
    const open = settleable.find((b) => !used(rows).has(b.name.toLowerCase()))
    if (open) return { type: 'Agst Ref', name: open.name, due: '', amount: rupees(Math.min(left, Math.abs(open.pending))) }
    if (!rows.length) return { type: 'New Ref', name: defaultName, due: '', amount: rupees(left) }
    return { type: 'On Account', name: '', due: '', amount: rupees(left) }
  }

  const [rows, setRows] = useState<Row[]>(() =>
    initial?.length
      ? initial.map((b) => ({ type: b.type, name: b.name ?? '', due: b.dueDate ? fmtDate(b.dueDate) : '', amount: rupees(b.amount) }))
      : [nextDefault([])],
  )
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('select')?.focus()
  }, [])

  const allocated = rows.reduce((t, r) => t + (paise(r.amount) || 0), 0)
  const left = total - allocated
  const update = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, n) => (n === i ? { ...r, ...patch } : r)))

  function dueDate(r: Row): string | null | undefined {
    if (r.type !== 'New Ref' || !r.due.trim()) return null
    if (/^\d{1,4}$/.test(r.due.trim())) {
      const d = new Date(voucherDate + 'T00:00:00Z')
      d.setUTCDate(d.getUTCDate() + Number(r.due.trim()))
      return d.toISOString().slice(0, 10)
    }
    return parseShortDate(r.due, voucherDate, fyStart) ?? undefined
  }

  function finish() {
    const bills: Bill[] = []
    for (const r of rows) {
      const p = paise(r.amount)
      if (!p) continue
      if (Number.isNaN(p)) return setError(`"${r.amount}" is not an amount`)
      if (r.type !== 'On Account' && !r.name.trim()) return setError(`A ${r.type} needs a bill name`)
      const due = dueDate(r)
      if (due === undefined) return setError(`"${r.due}" is not a due date or number of days`)
      bills.push({ type: r.type, name: r.type === 'On Account' ? null : r.name.trim(), dueDate: due, amount: p * sign })
    }
    onDone(bills)
  }

  /** Enter on a row's amount: add the next bill while something is left, else close. */
  function amountDone(i: number) {
    if (Number.isNaN(paise(rows[i].amount))) return setError(`"${rows[i].amount}" is not an amount`)
    if (left < 0) return setError(`The bills add up to more than the line (${formatINR(total)})`)
    setError(null)
    if (left === 0) return finish()
    if (i === rows.length - 1) {
      setRows((rs) => [...rs, nextDefault(rs)])
      setTimeout(() => [...(box.current?.querySelectorAll<HTMLElement>('select') ?? [])][i + 1]?.focus(), 0)
    }
  }

  // Enter walks the fields inside the panel; the last one of a row is its amount
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const el = e.target as HTMLElement
    if (e.key !== 'Enter' || el.closest('.picker')) return
    e.preventDefault()
    e.stopPropagation()
    if (el.dataset.amount !== undefined) return amountDone(Number(el.dataset.amount))
    const fields = [...(box.current?.querySelectorAll<HTMLElement>('input, select') ?? [])].filter((f) => !f.hasAttribute('disabled'))
    fields[fields.indexOf(el) + 1]?.focus()
  }

  return (
    <div className="bill-panel" ref={box} onKeyDown={onKey}>
      <div className="bill-head">
        <b>Bill-wise Details for: {ledger}</b>
        <span className="muted">
          Up to {formatINR(total)} {sign > 0 ? 'Dr' : 'Cr'} · left {formatINR(Math.max(left, 0))}
        </span>
      </div>
      <table className="bill-table">
        <thead>
          <tr>
            <th style={{ width: 120 }}>Type of Ref</th>
            <th>Name</th>
            <th style={{ width: 130 }}>Due (days or date)</th>
            <th className="num" style={{ width: 150 }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <select
                  value={r.type}
                  aria-label={`Bill ${i + 1} type`}
                  onChange={(e) => update(i, { type: e.target.value as BillType })}
                  onKeyDown={(e) => {
                    const t = TYPE_KEYS[e.key.toLowerCase()]
                    if (t) {
                      e.preventDefault()
                      update(i, { type: t, name: t === 'On Account' ? '' : r.name })
                    }
                  }}
                >
                  {TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </td>
              <td>
                {r.type === 'Agst Ref' ? (
                  <Picker
                    options={settleable.map((b, k) => ({ id: k + 1, name: b.name, hint: `${drcr(b.pending)} · due ${fmtDate(b.dueDate)}` }))}
                    value={settleable.findIndex((b) => b.name === r.name) + 1 || null}
                    onChange={(k) => {
                      const b = settleable[k - 1]
                      const before = rows.reduce((t, x, n) => (n === i ? t : t + (paise(x.amount) || 0)), 0)
                      update(i, { name: b.name, amount: rupees(Math.min(total - before, Math.abs(b.pending))) })
                    }}
                    placeholder="Pending bill"
                  />
                ) : (
                  <input
                    value={r.name}
                    disabled={r.type === 'On Account'}
                    aria-label={`Bill ${i + 1} name`}
                    onChange={(e) => update(i, { name: e.target.value })}
                  />
                )}
              </td>
              <td>
                <input
                  value={r.due}
                  disabled={r.type !== 'New Ref'}
                  placeholder={r.type === 'New Ref' ? 'credit period' : ''}
                  aria-label={`Bill ${i + 1} due`}
                  onChange={(e) => update(i, { due: e.target.value })}
                />
              </td>
              <td className="num">
                <input
                  className="amount"
                  inputMode="decimal"
                  data-amount={i}
                  aria-label={`Bill ${i + 1} amount`}
                  value={r.amount}
                  onChange={(e) => update(i, { amount: e.target.value })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <div className="errors">{error}</div>}
      {settleable.length > 0 && (
        <div className="bill-pending muted small">
          Pending: {settleable.map((b) => `${b.name} ${drcr(b.pending)}${b.overdueDays ? ` (${b.overdueDays}d overdue)` : ''}`).join(' · ')}
        </div>
      )}
    </div>
  )
}

/** One line summary of a line's bills, shown under it in the voucher. */
export function billSummary(bills?: Bill[] | null) {
  if (!bills?.length) return ''
  return bills.map((b) => `${b.type}${b.name ? ' ' + b.name : ''} ${formatINR(Math.abs(b.amount))}`).join(' · ')
}
