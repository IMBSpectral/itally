import { Fragment, useEffect, useState } from 'react'
import { useApp, type Screen } from '../App'
import { api } from '../api'
import type { BalanceSheet, PLSection, ProfitAndLoss, TrialBalance } from '../../server/src/engine/reports'
import { amt, Errors, fmtDate, Title, useLoad } from '../ui'

// the scenario the statements are shown under, shared by Trial Balance, P&L and Balance Sheet while the app runs
let scenarioNow: number | null = null
const scenarioListeners = new Set<() => void>()
function useScenario(): [number | null, (id: number | null) => void] {
  const [, rerender] = useState(0)
  useEffect(() => {
    const f = () => rerender((x) => x + 1)
    scenarioListeners.add(f)
    return () => void scenarioListeners.delete(f)
  }, [])
  return [scenarioNow, (id) => {
    scenarioNow = id
    scenarioListeners.forEach((f) => f())
  }]
}

function useReport<T>(name: 'trial-balance' | 'profit-loss' | 'balance-sheet') {
  const { company, period, version } = useApp()
  const [scenario] = useScenario()
  return useLoad(() => api.report<T>(company.id, name, period, scenario), [company.id, period, version, name, scenario])
}

/** The period, and the scenario to show the statement under when the company has any. */
function PeriodNote() {
  const { company, period, version } = useApp()
  const { data: scenarios } = useLoad(() => api.scenarios(company.id), [company.id, version])
  const [scenario, setScenario] = useScenario()
  return (
    <span className="muted">
      {!!scenarios?.length && (
        <select value={scenario ?? ''} onChange={(e) => setScenario(e.target.value ? Number(e.target.value) : null)} aria-label="Scenario">
          <option value="">Actuals</option>
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              Scenario: {s.name}
            </option>
          ))}
        </select>
      )}{' '}
      {fmtDate(period.from)} to {fmtDate(period.to)}
    </span>
  )
}

export function TrialBalanceView() {
  const { data, error } = useReport<TrialBalance>('trial-balance')
  const { push, company, version } = useApp()
  const [open, setOpen] = useState<Set<number>>(new Set())
  // a budget's figures beside the actuals, for the groups and ledgers it budgets
  const { data: budgets } = useLoad(() => api.budgets(company.id), [company.id, version])
  const [budgetId, setBudgetId] = useState(0)
  const { data: variance } = useLoad(() => (budgetId ? api.budgetVariance(company.id, budgetId) : Promise.resolve(null)), [company.id, budgetId, version])
  const budgeted = new Map((variance?.lines ?? []).filter((l) => l.kind !== 'cost centre').map((l) => [`${l.kind}/${l.targetId}`, l]))
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const budgetCells = (key: string) => {
    if (!budgetId) return null
    const b = budgeted.get(key)
    return (
      <>
        <td className="num">{b ? amt(Math.abs(b.amount)) : ''}</td>
        <td className="num">{b ? `${b.variance < 0 ? '-' : ''}${amt(Math.abs(b.variance))}` : ''}</td>
      </>
    )
  }
  // never mutate the previous Set: StrictMode runs updaters twice
  const toggle = (id: number) =>
    setOpen((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const cell = (p: number) => (
    <>
      <td className="num">{p > 0 ? amt(p) : ''}</td>
      <td className="num">{p < 0 ? amt(-p) : ''}</td>
    </>
  )
  return (
    <div>
      <Title right={<><PeriodNote />{budgets?.length ? (
        <select value={budgetId} onChange={(e) => setBudgetId(Number(e.target.value))} aria-label="Budget">
          <option value={0}>No budget</option>
          {budgets.map((b) => <option key={b.id} value={b.id}>Budget: {b.name}</option>)}
        </select>
      ) : null}</>}>Trial Balance</Title>
      {variance && <p className="muted">Budget {variance.budget.name}, {fmtDate(variance.budget.from)} to {fmtDate(variance.budget.to)}: variance is the actual for that period less the budget.</p>}
      <table className="report">
        <thead>
          <tr>
            <th>Particulars</th>
            <th className="num">Debit</th>
            <th className="num">Credit</th>
            {budgetId ? <><th className="num">Budget</th><th className="num">Variance</th></> : null}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <Fragment key={r.groupId}>
              <tr className="clickable group-row" onClick={() => toggle(r.groupId)}>
                <td>
                  {open.has(r.groupId) ? '▾' : '▸'} {r.name}
                </td>
                {cell(r.closing)}
                {budgetCells(`group/${r.groupId}`)}
              </tr>
              {open.has(r.groupId) &&
                r.ledgers.map((l) => (
                  <tr key={l.id} className="clickable detail" onClick={() => push(drill(l.id))}>
                    <td className="indent">{l.name}</td>
                    {cell(l.closing)}
                    {budgetCells(`ledger/${l.id}`)}
                  </tr>
                ))}
            </Fragment>
          ))}
          {data.primaryLedgers.map((l) => (
            <tr key={l.id} className="clickable group-row" onClick={() => push(drill(l.id))}>
              <td>{l.name}</td>
              {cell(l.closing)}
            </tr>
          ))}
          {data.openingDifference !== 0 && (
            <tr className="warn">
              <td>Difference in opening balances</td>
              {cell(-data.openingDifference)}
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td>Grand Total</td>
            <td className="num total">{amt(data.totalDr + Math.max(-data.openingDifference, 0))}</td>
            <td className="num total">{amt(data.totalCr + Math.max(data.openingDifference, 0))}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

/** A line of a two-sided statement: name, amount, bold, and what Enter on it opens. */
type Line = [string, number, boolean?, Screen?]

/**
 * Two-sided statement, the way Tally lays out the P&L and Balance Sheet. Lines that open
 * something are reachable with ↑/↓ (down the left side, then the right) and Enter.
 */
function TwoSided({ left, right, leftTitle, rightTitle }: { left: Line[]; right: Line[]; leftTitle: string; rightTitle: string }) {
  const { push } = useApp()
  const n = Math.max(left.length, right.length)
  const line = (x: Line | undefined, col: number) =>
    x ? (
      <>
        <td className={`${x[2] ? 'strong' : ''} ${x[3] ? 'clickable' : ''}`} data-col={col} onClick={x[3] && (() => push(x[3]!))}>
          {x[0]}
        </td>
        <td className={`num ${x[2] ? 'strong' : ''}`} onClick={x[3] && (() => push(x[3]!))}>
          {signed(x[1])}
        </td>
      </>
    ) : (
      <>
        <td />
        <td />
      </>
    )
  return (
    <table className="report two-sided">
      <thead>
        <tr>
          <th>{leftTitle}</th>
          <th />
          <th className="divider">{rightTitle}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: n }, (_, i) => (
          <tr key={i}>
            {line(left[i], 0)}
            {line(right[i], 1)}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** An item normally on one side shows with a minus sign when its balance is the other way. */
const signed = (p: number) => (p < 0 ? `-${amt(-p)}` : amt(p))

const rows = (s: PLSection[]): Line[] => s.map((x) => [x.name, x.amount, false, { k: 'group-summary', groupId: x.groupId }])
const total = (xs: Line[]) => xs.reduce((t, x) => t + x[1], 0)

export function ProfitLossView() {
  const { features } = useApp()
  const { data, error } = useReport<ProfitAndLoss>('profit-loss')
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  if (features.incomeExpenditure) return <IncomeExpenditure data={data} />
  const gp = data.grossProfit
  const stock: Screen | undefined = data.stockGroupId === null ? undefined : { k: 'group-summary', groupId: data.stockGroupId }
  const tradingL: Line[] = [['Opening Stock', data.openingStock, false, stock], ...rows(data.tradingDr)]
  const tradingR: Line[] = [...rows(data.tradingCr), ['Closing Stock', data.closingStock, false, stock]]
  if (gp >= 0) tradingL.push(['Gross Profit c/o', gp, true])
  else tradingR.push(['Gross Loss c/o', -gp, true])
  const indL: Line[] = [...(gp < 0 ? [['Gross Loss b/f', -gp] as Line] : []), ...rows(data.indirectExpenses)]
  const indR: Line[] = [...(gp >= 0 ? [['Gross Profit b/f', gp] as Line] : []), ...rows(data.indirectIncomes)]
  if (data.netProfit >= 0) indL.push(['Net Profit', data.netProfit, true])
  else indR.push(['Net Loss', -data.netProfit, true])
  return (
    <div>
      <Title right={<PeriodNote />}>Profit &amp; Loss A/c</Title>
      <TwoSided leftTitle="Particulars" rightTitle="Particulars" left={tradingL} right={tradingR} />
      <div className="totals-row">
        <span>{amt(total(tradingL))}</span>
        <span>{amt(total(tradingR))}</span>
      </div>
      <TwoSided leftTitle="" rightTitle="" left={indL} right={indR} />
      <div className="totals-row">
        <span>Total {amt(total(indL))}</span>
        <span>Total {amt(total(indR))}</span>
      </div>
    </div>
  )
}

/**
 * A non-profit's Income & Expenditure A/c (F11): every expense against every income in one
 * account, without the trading part, closing with the excess of one over the other.
 */
function IncomeExpenditure({ data }: { data: ProfitAndLoss }) {
  const stock: Screen | undefined = data.stockGroupId === null ? undefined : { k: 'group-summary', groupId: data.stockGroupId }
  const left: Line[] = [...(data.openingStock ? [['Opening Stock', data.openingStock, false, stock] as Line] : []), ...rows(data.tradingDr), ...rows(data.indirectExpenses)]
  const right: Line[] = [...rows(data.tradingCr), ...rows(data.indirectIncomes), ...(data.closingStock ? [['Closing Stock', data.closingStock, false, stock] as Line] : [])]
  if (data.netProfit >= 0) left.push(['Excess of Income over Expenditure', data.netProfit, true])
  else right.push(['Excess of Expenditure over Income', -data.netProfit, true])
  return (
    <div>
      <Title right={<PeriodNote />}>Income &amp; Expenditure A/c</Title>
      <TwoSided leftTitle="Expenditure" rightTitle="Income" left={left} right={right} />
      <div className="totals-row">
        <span>Total {amt(total(left))}</span>
        <span>Total {amt(total(right))}</span>
      </div>
    </div>
  )
}

export function BalanceSheetView() {
  const { features } = useApp()
  const { data, error } = useReport<BalanceSheet>('balance-sheet')
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const left: Line[] = rows(data.liabilities)
  const right: Line[] = rows(data.assets)
  // a debit P&L balance (accumulated loss) and a credit opening difference sit on the assets side
  const place = (name: string, creditPositive: number, open?: Screen) => {
    if (creditPositive > 0) left.push([name, creditPositive, false, open])
    else if (creditPositive < 0) right.push([name, -creditPositive, false, open])
  }
  place(features.incomeExpenditure ? 'Income & Expenditure A/c' : 'Profit & Loss A/c', data.profitAndLoss.total, { k: 'pl' })
  place('Difference in opening balances', data.openingDifference)
  const extra = Math.max(-data.profitAndLoss.total, 0) + Math.max(-data.openingDifference, 0)
  return (
    <div>
      <Title right={<PeriodNote />}>Balance Sheet</Title>
      <TwoSided leftTitle="Liabilities" rightTitle="Assets" left={left} right={right} />
      <div className="pl-note muted">
        Profit &amp; Loss A/c: opening {amt(data.profitAndLoss.opening) || '0.00'}, current period {amt(data.profitAndLoss.currentPeriod) || '0.00'}
        {data.profitAndLoss.currentPeriod < 0 && ' (loss)'}
      </div>
      <div className="totals-row">
        <span>Total {amt(data.totalLiabilities + extra)}</span>
        <span>Total {amt(data.totalAssets + extra)}</span>
      </div>
    </div>
  )
}

/** A ledger line opens its statement; the stock items' line (id -1) opens the Stock Summary. */
const drill = (ledgerId: number): Screen => (ledgerId < 0 ? { k: 'stock-summary' } : { k: 'statement', ledgerId })
