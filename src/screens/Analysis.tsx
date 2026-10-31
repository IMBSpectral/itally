import { useApp, type Screen } from '../App'
import { api } from '../api'
import { amt, Errors, Title, useLoad } from '../ui'
import { monthName, periodNote } from './Books'
import { qty } from './Inventory'

/** Amounts here can be negative (a net outflow, a fall in working capital): keep the sign. */
const signed = (p: number) => (p < 0 ? `-${amt(-p)}` : amt(p) || '0.00')

/**
 * Cash Flow, as Tally's: inflow, outflow and net flow of cash and bank month by month. A month
 * (or the Grand Total) opens the groups the money came from and went to.
 */
export function CashFlowView({ month }: { month?: string }) {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.cashFlow(company.id, period), [company.id, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  if (month) {
    const m = month === 'all' ? data : data.months.find((x) => x.month === month)
    if (!m) return <Errors errors={['No such month in the period']} />
    return (
      <div>
        <Title right={periodNote(data)}>Cash Flow: {month === 'all' ? 'the whole period' : monthName(month)}</Title>
        <table className="report">
          <thead>
            <tr>
              <th>Particulars</th>
              <th className="num">Inflow</th>
              <th className="num">Outflow</th>
            </tr>
          </thead>
          <tbody>
            {m.groups.map((g) => (
              <tr key={g.name}>
                <td>{g.name}</td>
                <td className="num">{amt(g.inflow)}</td>
                <td className="num">{amt(g.outflow)}</td>
              </tr>
            ))}
            {!m.groups.length && (
              <tr className="muted">
                <td colSpan={3}>No cash or bank movement</td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td>Total (net flow {signed(m.inflow - m.outflow)})</td>
              <td className="num total">{amt(m.inflow)}</td>
              <td className="num total">{amt(m.outflow)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    )
  }
  return (
    <div>
      <Title right={periodNote(data)}>Cash Flow</Title>
      <table className="report">
        <thead>
          <tr>
            <th>Particulars</th>
            <th className="num">Inflow</th>
            <th className="num">Outflow</th>
            <th className="num">Nett Flow</th>
          </tr>
        </thead>
        <tbody>
          <tr className="muted">
            <td>Opening Balance of cash and bank</td>
            <td />
            <td />
            <td className="num">{signed(data.opening)}</td>
          </tr>
          {data.months.map((m) => (
            <tr key={m.month} className={m.groups.length ? 'clickable' : 'muted'} onClick={() => m.groups.length && push({ k: 'cash-flow', month: m.month })}>
              <td>{monthName(m.month)}</td>
              <td className="num">{amt(m.inflow)}</td>
              <td className="num">{amt(m.outflow)}</td>
              <td className="num">{m.inflow || m.outflow ? signed(m.net) : ''}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="clickable" onClick={() => push({ k: 'cash-flow', month: 'all' })}>
            <td>Grand Total</td>
            <td className="num total">{amt(data.inflow)}</td>
            <td className="num total">{amt(data.outflow)}</td>
            <td className="num total">{signed(data.net)}</td>
          </tr>
          <tr>
            <td>Closing Balance of cash and bank</td>
            <td />
            <td />
            <td className="num total">{signed(data.closing)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

/** Funds Flow: sources and applications of working capital, then the working capital changes. */
export function FundsFlowView() {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.fundsFlow(company.id, period), [company.id, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const n = Math.max(data.sources.length, data.applications.length)
  const open = (groupId: number | null) => (groupId === null ? undefined : () => push({ k: 'group-summary', groupId }))
  const cell = (x?: { groupId: number | null; name: string; amount: number }) =>
    x ? (
      <>
        <td className={x.groupId === null ? 'strong' : 'clickable'} onClick={open(x.groupId)}>
          {x.name}
        </td>
        <td className="num">{amt(x.amount)}</td>
      </>
    ) : (
      <>
        <td />
        <td />
      </>
    )
  const { workingCapital: wc } = data
  return (
    <div>
      <Title right={periodNote(data)}>Funds Flow</Title>
      <table className="report two-sided">
        <thead>
          <tr>
            <th>Sources of Funds</th>
            <th />
            <th className="divider">Application of Funds</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: n }, (_, i) => (
            <tr key={i}>
              {cell(data.sources[i])}
              {cell(data.applications[i])}
            </tr>
          ))}
          <tr>
            {data.increase < 0 ? cell({ groupId: null, name: 'Decrease in Working Capital', amount: -data.increase }) : cell()}
            {data.increase > 0 ? cell({ groupId: null, name: 'Increase in Working Capital', amount: data.increase }) : cell()}
          </tr>
        </tbody>
      </table>
      <div className="totals-row">
        <span>Total {amt(data.totalSources + Math.max(-data.increase, 0)) || '0.00'}</span>
        <span>Total {amt(data.totalApplications + Math.max(data.increase, 0)) || '0.00'}</span>
      </div>
      <h3 className="sub">Working Capital Changes</h3>
      <table className="report">
        <thead>
          <tr>
            <th>Particulars</th>
            <th className="num">Opening</th>
            <th className="num">Closing</th>
            <th className="num">Increase in Working Capital</th>
          </tr>
        </thead>
        <tbody>
          {wc.lines.map((l) => (
            <tr key={l.groupId} className="clickable" onClick={() => push({ k: 'group-summary', groupId: l.groupId })}>
              <td>{l.name}</td>
              <td className="num">{signed(l.opening)}</td>
              <td className="num">{signed(l.closing)}</td>
              <td className="num">{signed(l.increase)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Working Capital</td>
            <td className="num total">{signed(wc.opening)}</td>
            <td className="num total">{signed(wc.closing)}</td>
            <td className="num total">{signed(wc.closing - wc.opening)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="muted">Assets show positive, liabilities negative; a fall in a liability raises working capital.</p>
    </div>
  )
}

const times = (x: number | null) => (x === null ? '—' : `${x.toFixed(2)} : 1`)
const pct = (x: number | null) => (x === null ? '—' : `${x.toFixed(2)} %`)

/** Ratio Analysis: Tally's principal groups beside its principal ratios. */
export function RatiosView() {
  const { company, period, version, push } = useApp()
  const { data: r, error } = useLoad(() => api.ratios(company.id, period), [company.id, period, version])
  if (error) return <Errors errors={[error]} />
  if (!r) return <p className="muted">Loading…</p>
  const groups: [string, number, (() => void)?][] = [
    ['Working Capital', r.workingCapital],
    ['Cash-in-Hand', r.cashInHand],
    ['Bank Accounts', r.bankAccounts],
    ['Bank OD A/c', r.bankOd],
    ['Sundry Debtors', r.sundryDebtors, () => push({ k: 'bills', side: 'receivable' })],
    ['Sundry Creditors', r.sundryCreditors, () => push({ k: 'bills', side: 'payable' })],
    ['Sales Accounts', r.sales],
    ['Purchase Accounts', r.purchases],
    ['Stock-in-Hand', r.closingStock, () => push({ k: 'stock-summary' })],
    [r.netProfit < 0 ? 'Nett Loss' : 'Nett Profit', Math.abs(r.netProfit), () => push({ k: 'pl' })],
    ['Wkg. Capital Turnover (Sales / Working Capital)', NaN],
    ['Inventory Turnover (Sales / Closing Stock)', NaN],
  ]
  const turnover = [r.workingCapitalTurnover, r.inventoryTurnover]
  const ratios: [string, string][] = [
    ['Current Ratio (Current Assets : Current Liabilities)', times(r.currentRatio)],
    ['Quick Ratio (Current Assets less Stock : Current Liabilities)', times(r.quickRatio)],
    ['Debt/Equity Ratio (Loans (Liability) : Capital Account + Nett Profit)', times(r.debtEquity)],
    ['Gross Profit %', pct(r.grossProfitPct)],
    ['Nett Profit %', pct(r.netProfitPct)],
    ['Operating Cost % (as percentage of Sales Accounts)', pct(r.operatingCostPct)],
    ['Recv. Turnover in days (payment performance of Debtors)', r.receivableDays === null ? '—' : `${r.receivableDays.toFixed(2)} days`],
    ['Return on Investment %', pct(r.returnOnInvestmentPct)],
    ['Return on Wkg. Capital %', pct(r.returnOnWorkingCapitalPct)],
  ]
  return (
    <div>
      <Title right={periodNote(r)}>Ratio Analysis</Title>
      <table className="report two-sided">
        <thead>
          <tr>
            <th>Principal Groups</th>
            <th />
            <th className="divider">Principal Ratios</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: Math.max(groups.length, ratios.length) }, (_, i) => {
            const g = groups[i]
            const x = ratios[i]
            return (
              <tr key={i}>
                <td className={g?.[2] ? 'clickable' : ''} onClick={g?.[2]}>
                  {g?.[0]}
                </td>
                <td className="num">{g ? (Number.isNaN(g[1]) ? (turnover[i - 10] === null ? '—' : turnover[i - 10]!.toFixed(2)) : signed(g[1])) : ''}</td>
                <td className="divider">{x?.[0]}</td>
                <td className="num">{x?.[1]}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="muted">
        Balances as at the end of the period; Sales, Purchases and profit over its {r.days} days. Capital is the Capital Account with the Profit &amp; Loss A/c
        balance.
      </p>
    </div>
  )
}

/** Stock Ageing Analysis: the stock in hand by how long ago it came in, valued at what it cost. */
export function StockAgeingView() {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.stockAgeing(company.id, period), [company.id, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={periodNote(data)}>Stock Ageing Analysis</Title>
      <table className="report">
        <thead>
          <tr>
            <th>Particulars</th>
            <th className="num">Closing Quantity</th>
            <th className="num">Value</th>
            {data.labels.map((l) => (
              <th key={l} className="num">
                {l}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l) => (
            <tr key={l.id} className="clickable" onClick={() => push({ k: 'stock-item-vouchers', itemId: l.id })}>
              <td>{l.name}</td>
              <td className="num">{qty(l.closingQty, l.unit, l.decimals, l)}</td>
              <td className="num">{amt(l.closingValue)}</td>
              {l.buckets.map((b) => (
                <td key={b.label} className="num">
                  {b.qty ? (
                    <>
                      {qty(b.qty, l.unit, l.decimals, l)}
                      <br />
                      <span className="muted">{amt(b.value)}</span>
                    </>
                  ) : (
                    ''
                  )}
                </td>
              ))}
            </tr>
          ))}
          {!data.lines.length && (
            <tr className="muted">
              <td colSpan={3 + data.labels.length}>No stock in hand</td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td>Grand Total</td>
            <td />
            <td className="num total">{amt(data.lines.reduce((t, l) => t + l.closingValue, 0))}</td>
            {data.totals.map((t, i) => (
              <td key={i} className="num total">
                {amt(t)}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
      <p className="muted">The stock in hand is taken from the latest receipts (first in, first out) and aged to the end of the period; values share the closing value, as the Stock Summary has it.</p>
    </div>
  )
}

/** Movement Analysis: inward and outward quantity, value and average rate for each item. */
export function MovementView() {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.movement(company.id, period), [company.id, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={periodNote(data)}>Movement Analysis</Title>
      <table className="report">
        <thead>
          <tr>
            <th>Stock Item</th>
            <th className="num">Inward Qty</th>
            <th className="num">Avg. Rate</th>
            <th className="num">Inward Value</th>
            <th className="num">Outward Qty</th>
            <th className="num">Avg. Rate</th>
            <th className="num">Outward Value</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((i) => (
            <tr key={i.id} className="clickable" onClick={() => push({ k: 'movement', itemId: i.id })}>
              <td>{i.name}</td>
              <td className="num">{qty(i.inQty, i.unit, i.decimals)}</td>
              <td className="num">{amt(i.inRate)}</td>
              <td className="num">{amt(i.inValue)}</td>
              <td className="num">{qty(i.outQty, i.unit, i.decimals)}</td>
              <td className="num">{amt(i.outRate)}</td>
              <td className="num">{amt(i.outValue)}</td>
            </tr>
          ))}
          {!data.items.length && (
            <tr className="muted">
              <td colSpan={7}>No stock moved in the period</td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td>Grand Total</td>
            <td />
            <td />
            <td className="num total">{amt(data.items.reduce((t, i) => t + i.inValue, 0))}</td>
            <td />
            <td />
            <td className="num total">{amt(data.items.reduce((t, i) => t + i.outValue, 0))}</td>
          </tr>
        </tfoot>
      </table>
      <p className="muted">Orders and transfers between godowns are not movement. Rates are per stock unit.</p>
    </div>
  )
}

/** One item's movement: who it came from and who it went to, with the average rate for each. */
export function ItemMovementView({ itemId }: { itemId: number }) {
  const { company, period, version } = useApp()
  const { data, error } = useLoad(() => api.itemMovement(company.id, period, itemId), [company.id, period, version, itemId])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const { item } = data
  const side = (title: string, lines: typeof data.inward) => (
    <>
      <h3 className="sub">{title}</h3>
      <table className="report">
        <thead>
          <tr>
            <th>Party</th>
            <th className="num">Quantity</th>
            <th className="num">Avg. Rate</th>
            <th className="num">Value</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.party}>
              <td>{l.party}</td>
              <td className="num">{qty(l.qty, item.unit, item.decimals)}</td>
              <td className="num">{amt(l.rate)}</td>
              <td className="num">{amt(l.value)}</td>
            </tr>
          ))}
          {!lines.length && (
            <tr className="muted">
              <td colSpan={4}>None</td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <td className="num total">{qty(lines.reduce((t, l) => t + l.qty, 0), item.unit, item.decimals)}</td>
            <td />
            <td className="num total">{amt(lines.reduce((t, l) => t + l.value, 0))}</td>
          </tr>
        </tfoot>
      </table>
    </>
  )
  return (
    <div>
      <Title right={periodNote(data)}>Movement Analysis: {item.name}</Title>
      {side('Movement Inward', data.inward)}
      {side('Movement Outward', data.outward)}
    </div>
  )
}

/** Reorder Status: items below their reorder level once orders are counted, and how much to order. */
export function ReorderView() {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.reorder(company.id, period), [company.id, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const q = (n: number, l: (typeof data.lines)[number]) => qty(n, l.unit, l.decimals, l)
  return (
    <div>
      <Title right={periodNote(data)}>Reorder Status</Title>
      <table className="report">
        <thead>
          <tr>
            <th>Stock Item</th>
            <th className="num">Closing Balance</th>
            <th className="num">Purchase Orders Pending</th>
            <th className="num">Sales Orders Due</th>
            <th className="num">Nett Available</th>
            <th className="num">Reorder Level</th>
            <th className="num">Shortfall</th>
            <th className="num">Min. Order</th>
            <th className="num">Order to be Placed</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l) => (
            <tr key={l.id} className={`clickable ${l.toOrder ? 'warn' : ''}`} onClick={() => push({ k: 'stock-item-vouchers', itemId: l.id })}>
              <td>{l.name}</td>
              <td className="num">{q(l.closingQty, l)}</td>
              <td className="num">{q(l.purchaseOrders, l)}</td>
              <td className="num">{q(l.salesOrders, l)}</td>
              <td className="num">{l.available < 0 ? `-${q(-l.available, l)}` : q(l.available, l)}</td>
              <td className="num">{q(l.reorderLevel, l)}</td>
              <td className="num">{q(l.shortfall, l)}</td>
              <td className="num">{l.minOrderQty ? q(l.minOrderQty, l) : ''}</td>
              <td className="num strong">{q(l.toOrder, l)}</td>
            </tr>
          ))}
          {!data.lines.length && (
            <tr className="muted">
              <td colSpan={9}>No stock item has a reorder level: set one in the stock item (Alter, Stock Item)</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Statistics, as Tally's: vouchers of each type in the period (the company's own types under
 * their predefined one) and masters of each kind. Enter on a voucher type opens its register.
 */
export function StatisticsView() {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.statistics(company.id, period), [company.id, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={periodNote(data)}>Statistics</Title>
      <div className="dash-cols">
        <table className="report">
          <thead>
            <tr>
              <th>Types of Vouchers</th>
              <th className="num">Count</th>
              <th className="num">Cancelled</th>
              <th className="num">Optional</th>
            </tr>
          </thead>
          <tbody>
            {data.vouchers.map((v) => (
              <tr key={`${v.type}/${v.voucherTypeId}`} className="clickable" onClick={() => push({ k: 'register', type: v.type })}>
                <td style={v.voucherTypeId ? { paddingLeft: 22 } : undefined}>{v.name}</td>
                <td className="num">{v.count || ''}</td>
                <td className="num">{v.cancelled || ''}</td>
                <td className="num">{v.optional || ''}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td className="num total">{data.total}</td>
              <td />
              <td />
            </tr>
          </tfoot>
        </table>
        <table className="report">
          <thead>
            <tr>
              <th>Types of Accounts</th>
              <th className="num">Count</th>
            </tr>
          </thead>
          <tbody>
            {data.masters.map((m) => (
              <tr key={m.name}>
                <td>{m.name}</td>
                <td className="num">{m.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Dashboard: the first figures an owner looks at; a tile or a party opens the report behind it. */
export function DashboardView() {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.dashboard(company.id, period), [company.id, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const tiles: [string, number, Screen | undefined][] = [
    ['Cash-in-Hand', data.cash, { k: 'cash-flow' }],
    ['Bank balance', data.bank, undefined],
    ['Receivables', data.receivables, undefined],
    ['Payables', data.payables, undefined],
    ['Sales', data.sales, { k: 'register', type: 'Sales' }],
    ['Purchases', data.purchases, { k: 'register', type: 'Purchase' }],
    [data.netProfit >= 0 ? 'Net profit' : 'Net loss', Math.abs(data.netProfit), { k: 'pl' }],
    ['Closing stock', data.closingStock, undefined],
  ]
  const top = Math.max(1, ...data.months.flatMap((m) => [m.sales, m.purchases]))
  const h = (v: number) => `${(Math.max(v, 0) / top) * 100}%`
  return (
    <div>
      <Title right={<>{periodNote(data)} · {data.vouchers} vouchers</>}>Dashboard</Title>
      <div className="tiles">
        {tiles.map(([label, value, open]) => (
          <button key={label} type="button" className={`tile ${open ? 'clickable' : ''}`} onClick={() => open && push(open)} disabled={!open}>
            <div className="label">{label}</div>
            <div className="value">{signed(value)}</div>
          </button>
        ))}
      </div>
      <h3 className="sub">Sales and purchases by month</h3>
      <div className="chart-legend">
        <span>
          <i style={{ background: 'var(--series-1)' }} />
          Sales
        </span>
        <span>
          <i style={{ background: 'var(--series-2)' }} />
          Purchases
        </span>
      </div>
      <div className="bars" role="img" aria-label="Sales and purchases by month">
        {data.months.map((m) => (
          <div key={m.month} className="month">
            <div className="bar s1" style={{ height: h(m.sales) }} />
            <div className="bar s2" style={{ height: h(m.purchases) }} />
            <div className="tip">
              {monthName(m.month)}: sales {signed(m.sales)}, purchases {signed(m.purchases)}
            </div>
          </div>
        ))}
      </div>
      <div className="bar-axis">
        {data.months.map((m) => (
          <span key={m.month}>{monthName(m.month).slice(0, 3)}</span>
        ))}
      </div>
      <div className="dash-cols" style={{ marginTop: 16 }}>
        {(
          [
            ['Largest receivables', data.topDebtors],
            ['Largest payables', data.topCreditors],
          ] as const
        ).map(([title, rows]) => (
          <table key={title} className="report">
            <thead>
              <tr>
                <th>{title}</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => push({ k: 'statement', ledgerId: r.id })}>
                  <td>{r.name}</td>
                  <td className="num">{amt(r.amount)}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr className="muted">
                  <td colSpan={2}>None</td>
                </tr>
              )}
            </tbody>
          </table>
        ))}
      </div>
    </div>
  )
}
