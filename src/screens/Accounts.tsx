import { useState } from 'react'
import { useApp } from '../App'
import { api, type Group, type Ledger, type Period } from '../api'
import { amt, drcr, Errors, fmtDate, Menu, Picker, Title, useLoad } from '../ui'
import { forexDrCr } from './Forex'
import { formatForex, formatRate } from '../../server/src/engine/forex'

/** Groups as a tree with their ledgers and closing balances. */
export function ChartOfAccounts() {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(
    () => Promise.all([api.groups(company.id), api.ledgers(company.id, period)]),
    [company.id, period, version],
  )
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const [groups, ledgers] = data

  const children = (id: number | null) => groups.filter((g) => g.parentId === id).sort((a, b) => a.name.localeCompare(b.name))
  const ledgersOf = (id: number | null) => ledgers.filter((l) => l.groupId === id)

  function node(g: Group, depth: number): React.ReactNode {
    return (
      <div key={`g${g.id}`}>
        <div className="coa-group" style={{ paddingLeft: depth * 18 }}>
          {g.name} <span className="muted">{g.nature}</span>
        </div>
        {children(g.id).map((c) => node(c, depth + 1))}
        {ledgersOf(g.id).map((l) => leaf(l, depth + 1))}
      </div>
    )
  }
  const leaf = (l: Ledger, depth: number) => (
    <div key={`l${l.id}`} className="coa-ledger" style={{ paddingLeft: depth * 18 }} onClick={() => push({ k: 'statement', ledgerId: l.id })}>
      <span>{l.name}</span>
      <span className="num">{drcr(l.closing)}</span>
    </div>
  )

  return (
    <div>
      <Title right={<span className="muted">{ledgers.length} ledgers · click a ledger for its vouchers</span>}>Chart of Accounts</Title>
      <div className="coa">
        {children(null).map((g) => node(g, 0))}
        {ledgersOf(null).map((l) => leaf(l, 0))}
      </div>
    </div>
  )
}

export function LedgerPick() {
  const { company, period, push } = useApp()
  const { data } = useLoad(() => api.ledgers(company.id, period), [company.id, period])
  const [id, setId] = useState<number | null>(null)
  return (
    <div className="form narrow">
      <Title>Ledger Vouchers</Title>
      <label>
        Name of ledger
        <Picker
          options={(data ?? []).map((l) => ({ id: l.id, name: l.name, hint: l.group ?? 'Primary' }))}
          value={id}
          onChange={(v) => {
            setId(v)
            push({ k: 'ledger-monthly', ledgerId: v })
          }}
          autoFocus
        />
      </label>
    </div>
  )
}

/** Ledger Vouchers report: opening, each voucher with its running balance, closing. */
export function LedgerStatement({ ledgerId, range }: { ledgerId: number; range?: Period }) {
  const { company, period: appPeriod, version, push } = useApp()
  const period = range ?? appPeriod
  const { data, error } = useLoad(() => api.statement(company.id, ledgerId, period), [company.id, ledgerId, period.from, period.to, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const dr = data.lines.reduce((t, l) => t + Math.max(l.amount, 0), 0)
  const cr = data.lines.reduce((t, l) => t + Math.max(-l.amount, 0), 0)
  const fx = data.currency // a foreign-currency ledger also shows its amounts and balance in the currency
  return (
    <div>
      <Title right={<span className="muted">{fmtDate(period.from)} to {fmtDate(period.to)}</span>}>Ledger: {data.ledger.name}</Title>
      <table className="report">
        <thead>
          <tr>
            <th>Date</th>
            <th>Particulars</th>
            <th>Vch Type</th>
            <th className="num">Vch No.</th>
            {fx && <th className="num">In {fx.symbol}</th>}
            <th className="num">Debit</th>
            <th className="num">Credit</th>
            <th className="num">Balance</th>
            {fx && <th className="num">Balance in {fx.symbol}</th>}
          </tr>
        </thead>
        <tbody>
          <tr className="muted">
            <td />
            <td>Opening Balance</td>
            <td colSpan={fx ? 5 : 4} />
            <td className="num">{drcr(data.opening)}</td>
            {fx && <td className="num">{forexDrCr(data.openingForex ?? 0, fx)}</td>}
          </tr>
          {data.lines.map((l, i) => (
            <tr key={i} className="clickable" onClick={() => push({ k: 'voucher', type: l.type as never, id: l.voucherId })}>
              <td>{fmtDate(l.date)}</td>
              <td>
                {l.particulars}
                {l.narration && <div className="muted small">{l.narration}</div>}
              </td>
              <td>{l.voucherType ?? l.type}</td>
              <td className="num">{l.docNo ?? l.number}</td>
              {fx && (
                <td className="num">
                  {l.forex ? `${formatForex(l.forex, fx)} @ ${formatRate(l.forexRate!)}` : l.forex === 0 ? <span className="muted">forex adjustment</span> : ''}
                </td>
              )}
              <td className="num">{l.amount > 0 ? amt(l.amount) : ''}</td>
              <td className="num">{l.amount < 0 ? amt(-l.amount) : ''}</td>
              <td className="num">{drcr(l.balance)}</td>
              {fx && <td className="num">{forexDrCr(l.forexBalance ?? 0, fx)}</td>}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td />
            <td>Current Total</td>
            <td colSpan={fx ? 3 : 2} />
            <td className="num total">{amt(dr)}</td>
            <td className="num total">{amt(cr)}</td>
            <td className="num total">{drcr(data.closing)}</td>
            {fx && <td className="num total">{forexDrCr(data.closingForex ?? 0, fx)}</td>}
          </tr>
        </tfoot>
      </table>
      {data.lines.length === 0 && <Menu autoFocus={false} items={[{ heading: 'No vouchers in this period' }]} />}
    </div>
  )
}
