import { isUnder, primaryOf, PROFIT_AND_LOSS, type GroupNode, type Nature } from './groups'
import type { Paise } from './money'

/** One ledger's position for a period, as the database's balance table supplies it. */
export interface LedgerBalance {
  id: number
  name: string
  groupId: number | null
  opening: Paise // + Dr, - Cr
  closing: Paise // opening + every posted entry up to the report date
  /**
   * Stock-in-Hand ledgers only: the closing stock valuation at the report date (accounts-only
   * mode, like Tally without integrated inventory). Vouchers can't post to these ledgers, so
   * `closing` stays equal to `opening`; the movement reaches the books through the P&L.
   */
  stockValue?: Paise
}

export interface TBRow {
  groupId: number
  name: string
  closing: Paise
  ledgers: { id: number; name: string; closing: Paise }[]
}

export interface TrialBalance {
  rows: TBRow[] // one per primary group with a balance, ledgers rolled up beneath it
  primaryLedgers: { id: number; name: string; closing: Paise }[] // e.g. Profit & Loss A/c
  totalDr: Paise
  totalCr: Paise
  /** Non-zero when opening balances don't agree; Tally shows "Difference in opening balances". */
  openingDifference: Paise
}

export function trialBalance(groups: Map<number, GroupNode>, balances: LedgerBalance[]): TrialBalance {
  const rows = new Map<number, TBRow>()
  const primaryLedgers: TrialBalance['primaryLedgers'] = []
  let totalDr = 0
  let totalCr = 0
  let openingSum = 0
  for (const b of balances) {
    openingSum += b.opening
    if (b.closing > 0) totalDr += b.closing
    else totalCr -= b.closing
    if (b.closing === 0) continue
    const line = { id: b.id, name: b.name, closing: b.closing }
    if (b.groupId === null) {
      primaryLedgers.push(line)
      continue
    }
    const p = primaryOf(groups, b.groupId)
    const row = rows.get(p.id) ?? { groupId: p.id, name: p.name, closing: 0, ledgers: [] }
    row.closing += b.closing
    row.ledgers.push(line)
    rows.set(p.id, row)
  }
  const sorted = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name))
  for (const r of sorted) r.ledgers.sort((a, b) => a.name.localeCompare(b.name))
  return { rows: sorted, primaryLedgers, totalDr, totalCr, openingDifference: openingSum }
}

export interface PLSection {
  name: string
  amount: Paise // shown positive on its natural side
  groupId: number // the primary group, for drilling into its Group Summary
}

export interface ProfitAndLoss {
  openingStock: Paise
  closingStock: Paise
  tradingDr: PLSection[] // purchases, direct expenses
  tradingCr: PLSection[] // sales, direct incomes
  grossProfit: Paise // negative = gross loss
  indirectExpenses: PLSection[]
  indirectIncomes: PLSection[]
  netProfit: Paise // negative = net loss
  stockGroupId: number | null // Stock-in-Hand, where the stock lines lead
}

/**
 * Accounts-only P&L (inventory not integrated): stock comes from Stock-in-Hand ledgers,
 * opening stock = their opening balance, closing stock = their closing balance.
 */
export function profitAndLoss(groups: Map<number, GroupNode>, balances: LedgerBalance[]): ProfitAndLoss {
  const byPrimary = new Map<number, Paise>()
  let openingStock = 0
  let closingStock = 0
  for (const b of balances) {
    if (b.groupId === null) continue
    if (isUnder(groups, b.groupId, ['Stock-in-Hand'])) {
      openingStock += b.opening
      closingStock += b.stockValue ?? b.opening
      continue
    }
    const p = primaryOf(groups, b.groupId)
    if (p.nature !== 'Income' && p.nature !== 'Expenses') continue
    byPrimary.set(p.id, (byPrimary.get(p.id) ?? 0) + b.closing)
  }
  const sections = (nature: Nature, gross: boolean) =>
    [...byPrimary.entries()]
      .map(([id, amt]) => ({ g: groups.get(id)!, amt }))
      .filter(({ g, amt }) => g.nature === nature && g.affectsGrossProfit === gross && amt !== 0)
      .sort((a, b) => a.g.name.localeCompare(b.g.name))
      // expenses are natural debits, incomes natural credits
      .map(({ g, amt }) => ({ name: g.name, amount: nature === 'Expenses' ? amt : -amt, groupId: g.id }))

  const tradingDr = sections('Expenses', true)
  const tradingCr = sections('Income', true)
  const sum = (s: PLSection[]) => s.reduce((t, x) => t + x.amount, 0)
  const grossProfit = sum(tradingCr) + closingStock - openingStock - sum(tradingDr)
  const indirectExpenses = sections('Expenses', false)
  const indirectIncomes = sections('Income', false)
  const netProfit = grossProfit + sum(indirectIncomes) - sum(indirectExpenses)
  const stockGroupId = [...groups.values()].find((g) => g.name === 'Stock-in-Hand')?.id ?? null
  return { openingStock, closingStock, tradingDr, tradingCr, grossProfit, indirectExpenses, indirectIncomes, netProfit, stockGroupId }
}

export interface BalanceSheet {
  liabilities: PLSection[]
  assets: PLSection[]
  profitAndLoss: { opening: Paise; currentPeriod: Paise; total: Paise } // credit-positive
  openingDifference: Paise // + Dr excess: shown on the liabilities side to balance
  totalLiabilities: Paise
  totalAssets: Paise
}

export function balanceSheet(groups: Map<number, GroupNode>, balances: LedgerBalance[]): BalanceSheet {
  const pl = profitAndLoss(groups, balances)
  const byPrimary = new Map<number, Paise>()
  let plOpening = 0
  let openingSum = 0
  for (const b of balances) {
    openingSum += b.opening
    if (b.groupId === null) {
      if (b.name === PROFIT_AND_LOSS) plOpening += -b.closing // credit balance = accumulated profit
      continue
    }
    const p = primaryOf(groups, b.groupId)
    if (p.nature === 'Income' || p.nature === 'Expenses') continue
    // stock appears at its valuation, the other half of the P&L's closing-stock credit
    const amount = b.stockValue !== undefined ? b.stockValue : b.closing
    byPrimary.set(p.id, (byPrimary.get(p.id) ?? 0) + amount)
  }
  const side = (nature: Nature) =>
    [...byPrimary.entries()]
      .map(([id, amt]) => ({ g: groups.get(id)!, amt }))
      .filter(({ g, amt }) => g.nature === nature && amt !== 0)
      .sort((a, b) => a.g.name.localeCompare(b.g.name))
      .map(({ g, amt }) => ({ name: g.name, amount: nature === 'Assets' ? amt : -amt, groupId: g.id }))

  const liabilities = side('Liabilities')
  const assets = side('Assets')
  const sum = (s: PLSection[]) => s.reduce((t, x) => t + x.amount, 0)
  const plTotal = plOpening + pl.netProfit
  const totalLiabilities = sum(liabilities) + plTotal + openingSum
  const totalAssets = sum(assets)
  return {
    liabilities,
    assets,
    profitAndLoss: { opening: plOpening, currentPeriod: pl.netProfit, total: plTotal },
    openingDifference: openingSum,
    totalLiabilities,
    totalAssets,
  }
}
