import { useEffect, useState } from 'react'
import { useApp } from '../App'
import { api, ApiError, type Currency, type RatesOn } from '../api'
import { formatForex, formatRate, parseRate, rateKindFor, pickRate, toBase, toForex } from '../../server/src/engine/forex'
import { formatINR } from '../../server/src/engine/money'
import { DateInput, drcr, enterAdvances, Errors, fmtDate, Picker, Title, useActive, useConfirm, useLoad } from '../ui'
import { messages, useDeleteKey, useSubmit } from './Masters'

/** A foreign amount as an editable field: 120050 cents -> "1200.50". */
export const formatForexField = (amount: number, decimals: number) => (decimals ? (amount / 10 ** decimals).toFixed(decimals) : String(amount))

/** "$1,200.50 Dr" / "" for nothing, the way Tally prints a foreign balance. */
export const forexDrCr = (amount: number, c: Pick<Currency, 'symbol' | 'decimals'>) => (amount ? `${formatForex(amount, c)} ${amount > 0 ? 'Dr' : 'Cr'}` : '')

/** Create / Alter, Currency: symbol, formal name and decimal places. */
export function CurrencyForm({ id }: { id?: number }) {
  const { company, changed, pop } = useApp()
  const [confirm, ask] = useConfirm()
  const { data } = useLoad(() => api.currencies(company.id), [company.id])
  const blank = { symbol: '', name: '', decimals: '2', decimalName: '' }
  const [f, setF] = useState(blank)
  const current = id ? data?.find((c) => c.id === id) : undefined
  useEffect(() => {
    if (current) setF({ symbol: current.symbol, name: current.name, decimals: String(current.decimals), decimalName: current.decimalName ?? '' })
  }, [current])
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }))
  const { errors, setErrors, ok, submit } = useSubmit(async () => {
    const body = { symbol: f.symbol, name: f.name, decimals: Number(f.decimals), decimalName: f.decimalName.trim() || null }
    if (id) await api.alterCurrency(company.id, id, body)
    else await api.createCurrency(company.id, body)
    changed()
    if (id) pop()
    else setF(blank)
    return `Currency ${f.symbol} saved`
  })
  useDeleteKey(!!id, ask, `Delete currency ${f.symbol}?`, () =>
    api
      .deleteCurrency(company.id, id!)
      .then(() => {
        changed()
        pop()
      })
      .catch((e) => setErrors(messages(e))),
  )
  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || (id && <span className="muted">Alt+D delete</span>)}>{id ? 'Currency Alteration' : 'Currency Creation'}</Title>
      <label>
        Symbol
        <input autoFocus required value={f.symbol} onChange={(e) => set('symbol', e.target.value)} placeholder="$" aria-label="Symbol" />
      </label>
      <label>
        Formal name
        <input required value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="US Dollar" aria-label="Formal name" />
      </label>
      <div className="inline">
        <label>
          Decimal places
          <select value={f.decimals} onChange={(e) => set('decimals', e.target.value)} aria-label="Decimal places">
            {['0', '1', '2', '3', '4'].map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <label>
          Word for the decimal portion
          <input value={f.decimalName} onChange={(e) => set('decimalName', e.target.value)} placeholder="cent" aria-label="Decimal word" />
        </label>
      </div>
      {current && current.used > 0 && <p className="muted">{current.used} ledgers are kept in this currency.</p>}
      <p className="muted">Give it its rates in Rates of Exchange; ledgers kept in it then take amounts in {f.symbol || 'it'} on vouchers.</p>
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

export function CurrencyPick() {
  const { company, replace } = useApp()
  const { data } = useLoad(() => api.currencies(company.id), [company.id])
  return (
    <div className="form narrow">
      <Title>Alter Currency</Title>
      {data && !data.length && <p className="muted">No currencies yet: create one first.</p>}
      <label>
        Currency
        <Picker options={(data ?? []).map((c) => ({ id: c.id, name: `${c.symbol} ${c.name}` }))} value={null} onChange={(id) => replace({ k: 'currency', id })} autoFocus />
      </label>
    </div>
  )
}

type RateRow = { standard: string; selling: string; buying: string }
const rateField = (r: number | null | undefined) => (r ? formatRate(r) : '')

/**
 * Rates of Exchange for a date: rupees for one unit of each currency. Standard values balances;
 * the selling rate is offered on payments, the buying rate on receipts. A rate holds until the next one.
 */
export function RatesForm() {
  const { company, period, changed } = useApp()
  const [date, setDate] = useState(period.to)
  const { data } = useLoad(() => api.rates(company.id, date), [company.id, date])
  const [rows, setRows] = useState<Record<number, RateRow>>({})
  useEffect(() => {
    if (!data) return
    // the rates set on this date can be changed; earlier ones show as a hint
    setRows(Object.fromEntries(data.map((c) => {
      const own = c.rates?.date === date ? c.rates : null
      return [c.id, { standard: rateField(own?.standard), selling: rateField(own?.selling), buying: rateField(own?.buying) }]
    })))
  }, [data, date])
  const set = (id: number, k: keyof RateRow, v: string) => setRows((r) => ({ ...r, [id]: { ...r[id], [k]: v } }))
  const { errors, ok, submit } = useSubmit(async () => {
    const problems: string[] = []
    const rate = (c: Currency, s: string) => {
      if (!s.trim()) return null
      const r = parseRate(s)
      if (r === null) problems.push(`${c.symbol}: "${s}" is not a rate (up to 4 decimals)`)
      return r
    }
    const body = (data ?? []).flatMap((c) => {
      const r = rows[c.id]
      if (!r) return []
      const own = c.rates?.date === date
      const out = { currencyId: c.id, standard: rate(c, r.standard), selling: rate(c, r.selling), buying: rate(c, r.buying) }
      return own || out.standard || out.selling || out.buying ? [out] : []
    })
    if (problems.length) throw new ApiError('', problems)
    await api.setRates(company.id, date, body)
    changed()
    return `Rates of ${fmtDate(date)} saved`
  })
  const hint = (r: RatesOn | null, k: keyof RateRow) => (r && r.date !== date && r[k] ? `${formatRate(r[k]!)} (${fmtDate(r.date)})` : '')
  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={ok && <span className="ok">{ok}</span>}>Rates of Exchange</Title>
      <label>
        Date
        <DateInput value={date} onChange={setDate} fyStart={company.fyStart} label="Date" autoFocus />
      </label>
      {data && !data.length && <p className="muted">No currencies yet: create one first (Create, Currency).</p>}
      {!!data?.length && (
        <table className="report">
          <thead>
            <tr>
              <th>Currency</th>
              <th className="num">Standard rate (₹)</th>
              <th className="num">Selling voucher rate</th>
              <th className="num">Buying voucher rate</th>
            </tr>
          </thead>
          <tbody>
            {data.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.symbol} {c.name}
                </td>
                {(['standard', 'selling', 'buying'] as const).map((k) => (
                  <td key={k} className="num">
                    <input
                      className="amount"
                      inputMode="decimal"
                      value={rows[c.id]?.[k] ?? ''}
                      placeholder={hint(c.rates, k)}
                      onChange={(e) => set(c.id, k, e.target.value)}
                      aria-label={`${c.symbol} ${k} rate`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted">
        Rupees for one unit. A rate holds from its date until the next one; payments offer the selling rate and receipts the buying rate, falling back to the standard
        rate, which also values balances in Forex Gain/Loss.
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

/**
 * Forex Gain/Loss: each foreign-currency ledger's balance valued at the standard rate on the date,
 * against its rupees, bill by bill on a bill-wise ledger. Alt+J books the difference with a Journal.
 */
export function ForexGainLossView() {
  const { company, period, version, push, changed } = useApp()
  const active = useActive()
  const [asOf, setAsOf] = useState(period.to)
  const { data, error } = useLoad(() => api.forexGainLoss(company.id, asOf), [company.id, asOf, version])
  const { data: ledgers } = useLoad(() => api.ledgers(company.id, period), [company.id, period, version])
  const [adjusting, setAdjusting] = useState(false)
  const [target, setTarget] = useState<number | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [done, setDone] = useState<string | null>(null)
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      // Esc closes the adjustment, not the report (an open ledger list takes it first)
      if (e.key === 'Escape' && adjusting && !document.querySelector('.picker-list')) {
        e.preventDefault()
        e.stopImmediatePropagation()
        setAdjusting(false)
        return
      }
      if (e.altKey && (e.key === 'j' || e.key === 'J') && data?.total !== undefined && data.ledgers.some((l) => l.difference)) {
        e.preventDefault()
        setAdjusting(true)
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  })
  const incomeOrExpense = (ledgers ?? []).filter((l) => !l.currencyId && ['Indirect Incomes', 'Indirect Expenses', 'Direct Incomes', 'Direct Expenses'].includes(l.primaryGroup ?? ''))
  useEffect(() => {
    if (target === null) setTarget(incomeOrExpense.find((l) => /forex|exchange/i.test(l.name))?.id ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgers])
  async function adjust() {
    setErrors([])
    if (target === null) return setErrors(['Choose the ledger the gain or loss goes to'])
    try {
      const v = await api.adjustForex(company.id, asOf, target)
      changed()
      setAdjusting(false)
      setDone(`Journal No. ${v.docNo ?? v.number} adjusts the gain or loss`)
    } catch (e) {
      setErrors(messages(e))
    }
  }
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const gainLoss = (d: number) => (d === 0 ? '' : `${formatINR(d)} ${d > 0 ? 'Gain' : 'Loss'}`)
  return (
    <div>
      <Title right={(done && <span className="ok">{done}</span>) || <span className="muted">Alt+J adjust with a Journal</span>}>Forex Gain/Loss</Title>
      <div className="inline">
        <label>
          As on
          <DateInput value={asOf} onChange={setAsOf} fyStart={company.fyStart} label="As on" />
        </label>
      </div>
      {!!data.missingRates.length && <p className="errors-inline">No standard rate on or before {fmtDate(asOf)} for {data.missingRates.join(', ')}: set it in Rates of Exchange.</p>}
      <table className="report">
        <thead>
          <tr>
            <th>Ledger</th>
            <th className="num">Balance in currency</th>
            <th className="num">Book balance (₹)</th>
            <th className="num">Standard rate</th>
            <th className="num">Value at rate (₹)</th>
            <th className="num">Gain / Loss</th>
          </tr>
        </thead>
        <tbody>
          {data.ledgers.map((l) => [
            <tr key={l.ledgerId} className="clickable" onClick={() => push({ k: 'statement', ledgerId: l.ledgerId, range: { from: period.from, to: asOf } })}>
              <td>{l.ledger}</td>
              <td className="num">{forexDrCr(l.forex, l)}</td>
              <td className="num">{drcr(l.book)}</td>
              <td className="num">{l.rate ? formatRate(l.rate) : '—'}</td>
              <td className="num">{l.value === null ? '' : drcr(l.value)}</td>
              <td className="num">{gainLoss(l.difference)}</td>
            </tr>,
            ...l.bills.map((b) => (
              <tr key={`${l.ledgerId}/${b.name}`} className="sub-row">
                <td className="indent">
                  Bill {b.name} <span className="muted">{b.settled ? 'settled: realised' : 'pending: unrealised'}</span>
                </td>
                <td className="num">{forexDrCr(b.forex, l)}</td>
                <td className="num">{drcr(b.book)}</td>
                <td />
                <td className="num">{drcr(b.value)}</td>
                <td className="num">{gainLoss(b.difference)}</td>
              </tr>
            )),
            l.bills.length && l.onAccount ? (
              <tr key={`${l.ledgerId}/on-account`} className="sub-row">
                <td className="indent">On account</td>
                <td colSpan={4} />
                <td className="num">{gainLoss(l.onAccount)}</td>
              </tr>
            ) : null,
          ])}
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <td colSpan={4} />
            <td className="num total">{gainLoss(data.total) || '—'}</td>
          </tr>
        </tfoot>
      </table>
      {!data.ledgers.length && <p className="muted">No ledger is kept in a foreign currency.</p>}
      {adjusting && (
        <form
          className="bill-panel"
          onSubmit={(e) => {
            e.preventDefault()
            adjust()
          }}
        >
          <div className="bill-head">
            <b>Adjust the forex gain or loss on {fmtDate(asOf)}</b>
            <span className="muted">Enter books it · Esc cancels</span>
          </div>
          <label>
            Gain or loss goes to
            <Picker
              options={incomeOrExpense.map((l) => ({ id: l.id, name: l.name, hint: l.group ?? '' }))}
              value={target}
              onChange={(id) => setTarget(id)}
              autoFocus
              placeholder="Forex Gain/Loss ledger"
            />
          </label>
          <p className="muted">
            A Journal takes each ledger to its value at the standard rate ({gainLoss(data.total) || 'nil'} in all), bill by bill, with no amount in the currency.
          </p>
          <Errors errors={errors} />
          <div className="actions">
            <button type="submit" className="primary">
              Book the Journal
            </button>
            <button type="button" onClick={() => setAdjusting(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

/**
 * The amount cell of a voucher line on a foreign-currency ledger: the amount in the currency and
 * its rate of exchange; the rupees follow (forex × rate). An amount of 0 makes the line a forex
 * adjustment, whose rupees are typed.
 */
export function ForexAmount({ currency, forex, rate, onChange, onDone, label }: {
  currency: Currency
  forex: string
  rate: string
  onChange: (forex: string, rate: string) => void
  onDone: () => void
  label: string
}) {
  return (
    <span className="forex-amount">
      <span className="muted">{currency.symbol}</span>
      <input
        className="amount"
        inputMode="decimal"
        value={forex}
        aria-label={`${label} in ${currency.symbol}`}
        onChange={(e) => onChange(e.target.value, rate)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          ;(e.currentTarget.parentElement?.querySelector('input[data-rate]') as HTMLInputElement | null)?.focus()
        }}
      />
      <span className="muted">@ ₹</span>
      <input
        data-rate
        className="amount rate"
        inputMode="decimal"
        value={rate}
        aria-label={`${label} rate`}
        onChange={(e) => onChange(forex, e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          onDone()
        }}
      />
    </span>
  )
}

/** The rate a voucher of a type offers for a currency on its date, as typed in the field. */
export function defaultRate(rates: (Currency & { rates: RatesOn | null })[] | null | undefined, currencyId: number, voucherType: string) {
  const r = pickRate(rates?.find((c) => c.id === currencyId)?.rates, rateKindFor(voucherType))
  return r ? formatRate(r) : ''
}

/** Rupees as typed (no grouping) for a foreign amount at a rate, or for rupees already there, the foreign amount. */
export const forexToRupeesField = (forex: number, rate: number, decimals: number) => (toBase(forex, rate, decimals) / 100).toFixed(2)
export const rupeesToForexField = (paise: number, rate: number, decimals: number) => formatForexField(toForex(paise, rate, decimals), decimals)
