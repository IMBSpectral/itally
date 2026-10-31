import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Cost, CostMasters } from '../api'
import { formatINR, toPaise } from '../../server/src/engine/money'
import { Picker } from '../ui'

const END = -1
interface Row {
  centreId: number | null
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
 * Tally's "Cost Allocations" for one voucher line: how its amount splits across cost centres.
 * Each line takes what is left; the panel closes itself once the shares add up, or with End of
 * List (nothing allocated leaves the line unsplit). Esc closes it and keeps what was there.
 */
export function CostPanel({
  ledger,
  amount,
  masters,
  initial,
  onDone,
}: {
  ledger: string
  amount: number // the line's amount, signed (+ Dr)
  masters: CostMasters
  initial?: Cost[] | null
  onDone: (costs: Cost[] | null) => void
}) {
  const sign = Math.sign(amount) || 1
  const total = Math.abs(amount)
  const [rows, setRows] = useState<Row[]>(() =>
    initial?.length ? initial.map((c) => ({ centreId: c.centreId, amount: rupees(c.amount) })) : [{ centreId: null, amount: rupees(total) }],
  )
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.querySelector<HTMLInputElement>('.picker input')?.focus()
  }, [])

  const allocated = rows.reduce((t, r) => t + (r.centreId !== null ? paise(r.amount) || 0 : 0), 0)
  const left = total - allocated
  const update = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, n) => (n === i ? { ...r, ...patch } : r)))
  const categoryOf = (id: number) => masters.categories.find((k) => k.id === id)?.name ?? ''
  const options = [
    { id: END, name: 'End of List' },
    ...masters.centres.map((c) => ({ id: c.id, name: c.name, hint: categoryOf(c.categoryId) })),
  ]

  function finish(rs: Row[]) {
    const costs: Cost[] = []
    for (const r of rs) {
      if (r.centreId === null) continue
      const p = paise(r.amount)
      if (Number.isNaN(p) || !p) return setError(`"${r.amount}" is not an amount`)
      costs.push({ centreId: r.centreId, amount: p * sign })
    }
    const sum = costs.reduce((t, c) => t + Math.abs(c.amount), 0)
    if (costs.length && sum !== total) return setError(`The cost centres take ${formatINR(sum)}; the line is ${formatINR(total)}`)
    onDone(costs.length ? costs : null)
  }

  /** Enter on a share: the next centre while something is left, else close. */
  function amountDone(i: number) {
    const p = paise(rows[i].amount)
    if (Number.isNaN(p)) return setError(`"${rows[i].amount}" is not an amount`)
    if (left < 0) return setError(`The cost centres add up to more than the line (${formatINR(total)})`)
    setError(null)
    if (left === 0) return finish(rows)
    if (i === rows.length - 1) {
      setRows((rs) => [...rs, { centreId: null, amount: rupees(left) }])
      setTimeout(() => [...(box.current?.querySelectorAll<HTMLInputElement>('.picker input') ?? [])][i + 1]?.focus(), 0)
    }
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const el = e.target as HTMLElement
    if (e.key === 'Escape' && !box.current?.querySelector('.picker-list')) {
      e.preventDefault()
      e.stopPropagation()
      return onDone(initial ?? null)
    }
    if (e.key !== 'Enter' || el.closest('.picker')) return
    e.preventDefault()
    e.stopPropagation()
    if (el.dataset.amount !== undefined) amountDone(Number(el.dataset.amount))
  }

  return (
    <div className="bill-panel cost-panel" ref={box} onKeyDown={onKey}>
      <div className="bill-head">
        <b>Cost Allocations for: {ledger}</b>
        <span className="muted">
          Up to {formatINR(total)} {sign > 0 ? 'Dr' : 'Cr'} · left {formatINR(Math.max(left, 0))}
        </span>
      </div>
      <table className="bill-table">
        <thead>
          <tr>
            <th>Name of Cost Centre</th>
            <th className="num" style={{ width: 150 }}>
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <Picker
                  options={options}
                  value={r.centreId}
                  onChange={(centreId) => {
                    if (centreId !== END) return update(i, { centreId })
                    const kept = rows.filter((x, n) => n !== i || x.centreId !== null)
                    setRows(kept)
                    finish(kept)
                  }}
                  placeholder="Cost centre"
                />
              </td>
              <td className="num">
                <input
                  className="amount"
                  inputMode="decimal"
                  data-amount={i}
                  aria-label={`Cost centre ${i + 1} amount`}
                  value={r.amount}
                  onChange={(e) => update(i, { amount: e.target.value })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <div className="errors">{error}</div>}
    </div>
  )
}

/** One line summary of a line's cost centres, shown under it in the voucher. */
export function costSummary(costs: Cost[] | null | undefined, masters: CostMasters | null) {
  if (!costs?.length) return ''
  const name = (id: number) => masters?.centres.find((c) => c.id === id)?.name ?? '?'
  return costs.map((c) => `${name(c.centreId)} ${formatINR(Math.abs(c.amount))}`).join(' · ')
}
