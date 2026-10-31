/**
 * Cash Flow, Funds Flow and Ratio Analysis: Tally's analysis reports, built from the same ledger
 * balances as the Balance Sheet and from the entries of the vouchers that touch cash or bank.
 */
import { isUnder, primaryOf, PROFIT_AND_LOSS, type GroupNode } from './groups'
import { profitAndLoss, type LedgerBalance } from './reports'
import type { Paise } from './money'

/** One non-cash line of a voucher that moved cash or bank: amount is + Dr, - Cr. */
export interface CashCounterLine {
  month: string // YYYY-MM
  groupId: number | null // the ledger's group (null: Profit & Loss A/c)
  amount: Paise
}

export interface FlowGroup {
  groupId: number | null
  name: string
  inflow: Paise
  outflow: Paise
}

export interface CashFlowMonth {
  month: string
  inflow: Paise
  outflow: Paise
  net: Paise
  groups: FlowGroup[] // by the primary group the cash came from or went to
}

export interface CashFlow {
  opening: Paise // cash and bank at the start of the period (+ Dr)
  months: CashFlowMonth[]
  inflow: Paise
  outflow: Paise
  net: Paise
  closing: Paise
  groups: FlowGroup[] // the whole period
}

/**
 * Cash comes in from (or goes out to) the other side of each voucher that touches cash or bank:
 * a credit to a non-cash ledger is an inflow, a debit an outflow. Transfers between cash and bank
 * (Contra) have no other side, so they are not flows.
 */
export function cashFlow(groups: Map<number, GroupNode>, lines: CashCounterLine[], months: string[], opening: Paise): CashFlow {
  const name = (id: number | null) => (id === null ? PROFIT_AND_LOSS : groups.get(id)!.name)
  const collect = (xs: CashCounterLine[]) => {
    const by = new Map<number | null, FlowGroup>()
    for (const l of xs) {
      const p = l.groupId === null ? null : primaryOf(groups, l.groupId).id
      const g = by.get(p) ?? { groupId: p, name: name(p), inflow: 0, outflow: 0 }
      if (l.amount < 0) g.inflow -= l.amount
      else g.outflow += l.amount
      by.set(p, g)
    }
    return [...by.values()].filter((g) => g.inflow || g.outflow).sort((a, b) => a.name.localeCompare(b.name))
  }
  const sum = (gs: FlowGroup[]) => gs.reduce((t, g) => ({ inflow: t.inflow + g.inflow, outflow: t.outflow + g.outflow }), { inflow: 0, outflow: 0 })
  const out = months.map((month) => {
    const gs = collect(lines.filter((l) => l.month === month))
    const t = sum(gs)
    return { month, ...t, net: t.inflow - t.outflow, groups: gs }
  })
  const all = collect(lines)
  const t = sum(all)
  return { opening, months: out, ...t, net: t.inflow - t.outflow, closing: opening + t.inflow - t.outflow, groups: all }
}

/** Ledgers under Current Assets and Current Liabilities make up working capital. */
const WORKING_CAPITAL = ['Current Assets', 'Current Liabilities']

export interface FundsLine {
  groupId: number | null
  name: string
  amount: Paise
}

export interface WorkingCapitalLine {
  groupId: number
  name: string
  opening: Paise // + Dr
  closing: Paise
  increase: Paise // in working capital: a rise in an asset, a fall in a liability
}

export interface FundsFlow {
  sources: FundsLine[]
  applications: FundsLine[]
  totalSources: Paise
  totalApplications: Paise
  workingCapital: { opening: Paise; closing: Paise; lines: WorkingCapitalLine[] }
  increase: Paise // = sources - applications = the change in working capital
}

/**
 * Funds Flow: what raised working capital (sources) and what used it (applications) over the
 * period. Every group outside working capital that fell on the debit side (a loan taken, capital
 * brought in, an asset sold) is a source, every one that rose (an asset bought, a loan repaid) an
 * application, and so is the period's profit or loss. The two sides differ by exactly the change
 * in working capital, which the statement lists group by group.
 */
export function fundsFlow(groups: Map<number, GroupNode>, balances: LedgerBalance[]): FundsFlow {
  const nonCurrent = new Map<number | null, FundsLine>()
  const current = new Map<number, WorkingCapitalLine>()
  for (const b of balances) {
    const closing = b.stockValue ?? b.closing
    if (b.groupId === null) {
      // Profit & Loss A/c itself (a transfer to reserves, say); the period's profit comes below
      const change = closing - b.opening
      if (change) nonCurrent.set(null, { groupId: null, name: b.name, amount: (nonCurrent.get(null)?.amount ?? 0) + change })
      continue
    }
    const p = primaryOf(groups, b.groupId)
    if (p.nature === 'Income' || p.nature === 'Expenses') continue
    if (isUnder(groups, b.groupId, WORKING_CAPITAL)) {
      // group by the sub-group directly under Current Assets / Current Liabilities
      let g = groups.get(b.groupId)!
      while (g.parentId !== null && g.parentId !== p.id) g = groups.get(g.parentId)!
      const line = current.get(g.id) ?? { groupId: g.id, name: g.name, opening: 0, closing: 0, increase: 0 }
      line.opening += b.opening
      line.closing += closing
      line.increase += closing - b.opening
      current.set(g.id, line)
      continue
    }
    const line = nonCurrent.get(p.id) ?? { groupId: p.id, name: p.name, amount: 0 }
    line.amount += closing - b.opening // + Dr: the group used funds
    nonCurrent.set(p.id, line)
  }
  const { netProfit } = profitAndLoss(groups, balances)
  const sources: FundsLine[] = []
  const applications: FundsLine[] = []
  if (netProfit > 0) sources.push({ groupId: null, name: 'Net Profit', amount: netProfit })
  if (netProfit < 0) applications.push({ groupId: null, name: 'Net Loss', amount: -netProfit })
  for (const l of [...nonCurrent.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (l.amount < 0) sources.push({ ...l, amount: -l.amount })
    if (l.amount > 0) applications.push(l)
  }
  const lines = [...current.values()].filter((l) => l.opening || l.closing).sort((a, b) => a.name.localeCompare(b.name))
  const sum = (xs: { amount: Paise }[]) => xs.reduce((t, x) => t + x.amount, 0)
  const totalSources = sum(sources)
  const totalApplications = sum(applications)
  const wc = (k: 'opening' | 'closing') => lines.reduce((t, l) => t + l[k], 0)
  return {
    sources, applications, totalSources, totalApplications,
    workingCapital: { opening: wc('opening'), closing: wc('closing'), lines },
    increase: totalSources - totalApplications,
  }
}

export interface Ratios {
  /** Principal groups, positive on their natural side. */
  workingCapital: Paise
  cashInHand: Paise
  bankAccounts: Paise
  bankOd: Paise
  sundryDebtors: Paise
  sundryCreditors: Paise
  sales: Paise
  purchases: Paise
  closingStock: Paise
  netProfit: Paise
  grossProfit: Paise
  capital: Paise // Capital Account and the Profit & Loss A/c balance
  loans: Paise
  days: number
  /** Principal ratios; null where the divisor is nil. */
  workingCapitalTurnover: number | null // sales / working capital
  inventoryTurnover: number | null // sales / closing stock
  currentRatio: number | null // current assets : current liabilities
  quickRatio: number | null // (current assets - stock) : current liabilities
  debtEquity: number | null // loans : capital
  grossProfitPct: number | null
  netProfitPct: number | null
  operatingCostPct: number | null // (sales - net profit) / sales
  receivableDays: number | null // debtors / sales × days in the period
  returnOnInvestmentPct: number | null // net profit / capital
  returnOnWorkingCapitalPct: number | null // net profit / working capital
}

/** Ratio Analysis, with Tally's principal groups and ratios, as at the end of the period. */
export function ratios(groups: Map<number, GroupNode>, balances: LedgerBalance[], days: number): Ratios {
  const pl = profitAndLoss(groups, balances)
  const under = (names: string[]) =>
    balances.filter((b) => b.groupId !== null && isUnder(groups, b.groupId, names)).reduce((t, b) => t + (b.stockValue ?? b.closing), 0)
  const currentAssets = under(['Current Assets'])
  const currentLiabilities = -under(['Current Liabilities'])
  const plBalance = -(balances.find((b) => b.groupId === null && b.name === PROFIT_AND_LOSS)?.closing ?? 0) + pl.netProfit
  const sales = -under(['Sales Accounts'])
  const workingCapital = currentAssets - currentLiabilities
  const capital = -under(['Capital Account']) + plBalance
  const loans = -under(['Loans (Liability)'])
  const closingStock = under(['Stock-in-Hand'])
  const sundryDebtors = under(['Sundry Debtors'])
  const ratio = (a: number, b: number) => (b === 0 ? null : a / b)
  const pct = (a: number, b: number) => (b === 0 ? null : (a / b) * 100)
  return {
    workingCapital,
    cashInHand: under(['Cash-in-Hand']),
    bankAccounts: under(['Bank Accounts']),
    bankOd: -under(['Bank OD A/c']),
    sundryDebtors,
    sundryCreditors: -under(['Sundry Creditors']),
    sales,
    purchases: under(['Purchase Accounts']),
    closingStock,
    netProfit: pl.netProfit,
    grossProfit: pl.grossProfit,
    capital,
    loans,
    days,
    workingCapitalTurnover: ratio(sales, workingCapital),
    inventoryTurnover: ratio(sales, closingStock),
    currentRatio: ratio(currentAssets, currentLiabilities),
    quickRatio: ratio(currentAssets - closingStock, currentLiabilities),
    debtEquity: ratio(loans, capital),
    grossProfitPct: pct(pl.grossProfit, sales),
    netProfitPct: pct(pl.netProfit, sales),
    operatingCostPct: pct(sales - pl.netProfit, sales),
    receivableDays: sales === 0 ? null : (sundryDebtors / sales) * days,
    returnOnInvestmentPct: pct(pl.netProfit, capital),
    returnOnWorkingCapitalPct: pct(pl.netProfit, workingCapital),
  }
}
