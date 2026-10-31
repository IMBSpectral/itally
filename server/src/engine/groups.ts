/**
 * The chart of groups every new company starts with: 15 primary groups and 13 sub-groups,
 * matching the structure TallyPrime ships (names are standard accounting terms).
 * Nature decides which side of the Balance Sheet / P&L a group sits on; affectsGrossProfit
 * puts it in the trading section of the P&L.
 */
export type Nature = 'Assets' | 'Liabilities' | 'Income' | 'Expenses'

export interface GroupDef {
  name: string
  parent: string | null // null = primary group
  nature: Nature
  affectsGrossProfit: boolean
}

const primary = (name: string, nature: Nature, affectsGrossProfit = false): GroupDef => ({
  name,
  parent: null,
  nature,
  affectsGrossProfit,
})
const sub = (name: string, parent: string, nature: Nature): GroupDef => ({
  name,
  parent,
  nature,
  affectsGrossProfit: false,
})

export const DEFAULT_GROUPS: GroupDef[] = [
  primary('Branch / Divisions', 'Liabilities'),
  primary('Capital Account', 'Liabilities'),
  primary('Current Assets', 'Assets'),
  primary('Current Liabilities', 'Liabilities'),
  primary('Direct Expenses', 'Expenses', true),
  primary('Direct Incomes', 'Income', true),
  primary('Fixed Assets', 'Assets'),
  primary('Indirect Expenses', 'Expenses'),
  primary('Indirect Incomes', 'Income'),
  primary('Investments', 'Assets'),
  primary('Loans (Liability)', 'Liabilities'),
  primary('Misc. Expenses (ASSET)', 'Assets'),
  primary('Purchase Accounts', 'Expenses', true),
  primary('Sales Accounts', 'Income', true),
  primary('Suspense A/c', 'Liabilities'),
  sub('Bank Accounts', 'Current Assets', 'Assets'),
  sub('Bank OD A/c', 'Loans (Liability)', 'Liabilities'),
  sub('Cash-in-Hand', 'Current Assets', 'Assets'),
  sub('Deposits (Asset)', 'Current Assets', 'Assets'),
  sub('Duties & Taxes', 'Current Liabilities', 'Liabilities'),
  sub('Loans & Advances (Asset)', 'Current Assets', 'Assets'),
  sub('Provisions', 'Current Liabilities', 'Liabilities'),
  sub('Reserves & Surplus', 'Capital Account', 'Liabilities'),
  sub('Secured Loans', 'Loans (Liability)', 'Liabilities'),
  sub('Stock-in-Hand', 'Current Assets', 'Assets'),
  sub('Sundry Creditors', 'Current Liabilities', 'Liabilities'),
  sub('Sundry Debtors', 'Current Assets', 'Assets'),
  sub('Unsecured Loans', 'Loans (Liability)', 'Liabilities'),
]

/** Ledgers created with every company. Profit & Loss A/c is primary (no group). */
export const DEFAULT_LEDGERS: { name: string; group: string | null }[] = [
  { name: 'Cash', group: 'Cash-in-Hand' },
  { name: 'Profit & Loss A/c', group: null },
]

export const PROFIT_AND_LOSS = 'Profit & Loss A/c'

/** Groups whose ledgers count as cash or bank (Contra / Payment / Receipt rules). */
export const CASH_BANK_GROUPS = ['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c']

export interface GroupNode {
  id: number
  name: string
  parentId: number | null
  nature: Nature
  affectsGrossProfit: boolean
}

/** Walk up to the primary group; a sub-group inherits nature/affectsGrossProfit from it. */
export function primaryOf(groups: Map<number, GroupNode>, id: number): GroupNode {
  let g = groups.get(id)
  const seen = new Set<number>()
  while (g && g.parentId !== null) {
    if (seen.has(g.id)) throw new Error(`Group cycle at ${g.name}`)
    seen.add(g.id)
    g = groups.get(g.parentId)
  }
  if (!g) throw new Error(`Unknown group ${id}`)
  return g
}

/** True if `id` is `ancestorName` or sits anywhere beneath it. */
export function isUnder(groups: Map<number, GroupNode>, id: number, ancestorNames: string[]): boolean {
  let g = groups.get(id)
  while (g) {
    if (ancestorNames.includes(g.name)) return true
    g = g.parentId === null ? undefined : groups.get(g.parentId)
  }
  return false
}
