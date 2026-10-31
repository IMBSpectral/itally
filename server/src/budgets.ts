/**
 * Budgets and scenarios. A budget sets, over its period, an amount for groups, ledgers or cost
 * centres: on their nett transactions in the period, or on their closing balance at its end. Budget
 * Variance sets each against the books. A scenario is the books (or not) plus the vouchers kept out
 * of them that it includes: reversing journals (while effective), optional and memorandum vouchers.
 */
import { pool, withTx, type Tx } from './db'
import { ledgerBalances, loadGroups, ValidationError, type ScenarioView } from './books'
import { isUnder } from './engine/groups'

type Db = Tx | typeof pool

export interface BudgetLine {
  kind: 'group' | 'ledger' | 'cost centre'
  targetId: number
  type: 'nett' | 'closing'
  amount: number // paise, + Dr
}
export interface BudgetInput {
  name: string
  parentId: number | null
  from: string
  to: string
  lines: BudgetLine[]
}

const taken = (kind: string, name: string) => (err: { code?: string }) => {
  if (err.code === '23505') throw new ValidationError([`The name "${name}" is already used by another ${kind}`])
  throw err
}

export async function listBudgets(companyId: number) {
  return (await pool.query(
    `SELECT b.id, b.name, b.parent_id "parentId", (SELECT name FROM budgets p WHERE p.id = b.parent_id) parent, to_char(b.from_date, 'YYYY-MM-DD') "from",
            to_char(b.to_date, 'YYYY-MM-DD') "to", (SELECT count(*)::int FROM budget_lines l WHERE l.budget_id = b.id) lines
       FROM budgets b WHERE b.company_id = $1 ORDER BY lower(b.name)`,
    [companyId],
  )).rows
}

export async function getBudget(db: Db, companyId: number, id: number) {
  const b = (await db.query(
    `SELECT id, name, parent_id "parentId", to_char(from_date, 'YYYY-MM-DD') "from", to_char(to_date, 'YYYY-MM-DD') "to" FROM budgets WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  )).rows[0]
  if (!b) return null
  const lines = (await db.query<BudgetLine>(
    `SELECT CASE WHEN group_id IS NOT NULL THEN 'group' WHEN ledger_id IS NOT NULL THEN 'ledger' ELSE 'cost centre' END kind,
            COALESCE(group_id, ledger_id, cost_centre_id) "targetId", type, amount::float8 amount
       FROM budget_lines WHERE budget_id = $1 ORDER BY 1, 2`,
    [id],
  )).rows
  return { ...b, lines } as { id: number; name: string; parentId: number | null; from: string; to: string; lines: BudgetLine[] }
}

async function checkBudget(db: Db, companyId: number, id: number | null, b: BudgetInput) {
  const errors: string[] = []
  if (!b.name.trim()) errors.push('A budget needs a name')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.from) || !/^\d{4}-\d{2}-\d{2}$/.test(b.to)) errors.push('Give the period of the budget')
  else if (b.to < b.from) errors.push('The budget ends before it begins')
  if (b.parentId !== null) {
    // a parent is one of the company's budgets, and not the budget itself or one under it
    let p: number | null = b.parentId
    const parents = new Map((await db.query<{ id: number; parentId: number | null }>(`SELECT id, parent_id "parentId" FROM budgets WHERE company_id = $1`, [companyId])).rows.map((r) => [r.id, r.parentId]))
    if (!parents.has(b.parentId)) errors.push(`Unknown budget ${b.parentId}`)
    else
      for (let n = 0; p !== null && n < 100; n++) {
        if (p === id) {
          errors.push('A budget cannot be under itself')
          break
        }
        p = parents.get(p) ?? null
      }
  }
  const tables = { group: 'groups', ledger: 'ledgers', 'cost centre': 'cost_centres' } as const
  const seen = new Set<string>()
  for (const [i, l] of b.lines.entries()) {
    const k = `${l.kind}/${l.targetId}`
    if (seen.has(k)) errors.push(`Line ${i + 1}: the ${l.kind} is budgeted twice`)
    seen.add(k)
    if (!Number.isSafeInteger(l.amount)) errors.push(`Line ${i + 1}: the amount is whole paise`)
    if (!(await db.query(`SELECT 1 FROM ${tables[l.kind]} WHERE id = $1 AND company_id = $2`, [l.targetId, companyId])).rowCount)
      errors.push(`Line ${i + 1}: unknown ${l.kind} ${l.targetId}`)
  }
  if (errors.length) throw new ValidationError(errors)
}

async function writeLines(tx: Tx, budgetId: number, lines: BudgetLine[]) {
  await tx.query(`DELETE FROM budget_lines WHERE budget_id = $1`, [budgetId])
  for (const l of lines.filter((l) => l.amount !== 0))
    await tx.query(
      `INSERT INTO budget_lines (budget_id, group_id, ledger_id, cost_centre_id, type, amount) VALUES ($1,$2,$3,$4,$5,$6)`,
      [budgetId, l.kind === 'group' ? l.targetId : null, l.kind === 'ledger' ? l.targetId : null, l.kind === 'cost centre' ? l.targetId : null, l.type, l.amount],
    )
}

export async function createBudget(companyId: number, b: BudgetInput) {
  return withTx(async (tx) => {
    await checkBudget(tx, companyId, null, b)
    const id = (await tx.query<{ id: number }>(
      `INSERT INTO budgets (company_id, name, parent_id, from_date, to_date) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [companyId, b.name.trim(), b.parentId, b.from, b.to],
    ).catch(taken('budget', b.name))).rows[0].id
    await writeLines(tx, id, b.lines)
    return id
  })
}

export async function alterBudget(companyId: number, id: number, b: BudgetInput) {
  await withTx(async (tx) => {
    if (!(await tx.query(`SELECT 1 FROM budgets WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, companyId])).rowCount) throw new ValidationError([`Unknown budget ${id}`])
    await checkBudget(tx, companyId, id, b)
    await tx.query(`UPDATE budgets SET name = $2, parent_id = $3, from_date = $4, to_date = $5 WHERE id = $1`, [id, b.name.trim(), b.parentId, b.from, b.to]).catch(taken('budget', b.name))
    await writeLines(tx, id, b.lines)
  })
}

export async function deleteBudget(companyId: number, id: number) {
  await withTx(async (tx) => {
    const b = (await tx.query<{ name: string }>(`SELECT name FROM budgets WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, companyId])).rows[0]
    if (!b) throw new ValidationError([`Unknown budget ${id}`])
    if ((await tx.query(`SELECT 1 FROM budgets WHERE parent_id = $1 LIMIT 1`, [id])).rowCount) throw new ValidationError([`Budgets are under ${b.name}; move them first`])
    await tx.query(`DELETE FROM budgets WHERE id = $1`, [id])
  })
}

/**
 * Budget Variance: each line of the budget with the books' figure for its period (the nett
 * transactions, or the closing balance at its end; a group's of every ledger under it, a cost
 * centre's of the amounts allocated to it) and the variance (actual less budget, + Dr).
 */
export async function budgetVariance(companyId: number, id: number, scenario?: ScenarioView | null) {
  const b = await getBudget(pool, companyId, id)
  if (!b) throw new ValidationError([`Unknown budget ${id}`])
  const groups = await loadGroups(pool, companyId)
  const balances = await ledgerBalances(pool, companyId, b.from, b.to, scenario)
  const names = new Map<string, string>()
  const lookup = async (table: string, kind: string) => {
    for (const r of (await pool.query<{ id: number; name: string }>(`SELECT id, name FROM ${table} WHERE company_id = $1`, [companyId])).rows) names.set(`${kind}/${r.id}`, r.name)
  }
  await lookup('ledgers', 'ledger')
  await lookup('cost_centres', 'cost centre')
  for (const g of groups.values()) names.set(`group/${g.id}`, g.name)
  const lines = []
  for (const l of b.lines) {
    let actual = 0
    if (l.kind === 'cost centre') {
      const { rows } = await pool.query<{ total: number; closing: number }>(
        `SELECT COALESCE(SUM(a.amount) FILTER (WHERE v.date >= $3), 0)::float8 total, COALESCE(SUM(a.amount), 0)::float8 closing
           FROM cost_allocations a JOIN entries e ON e.id = a.entry_id JOIN vouchers v ON v.id = e.voucher_id
          WHERE a.cost_centre_id = $1 AND v.company_id = $2 AND v.date <= $4 AND NOT v.cancelled`,
        [l.targetId, companyId, b.from, b.to],
      )
      actual = l.type === 'nett' ? rows[0].total : rows[0].closing
    } else {
      const mine = balances.filter((x) => (l.kind === 'ledger' ? x.id === l.targetId : x.groupId !== null && (x.groupId === l.targetId || isUnder(groups, x.groupId, [names.get(`group/${l.targetId}`)!]))))
      actual = mine.reduce((t, x) => t + (l.type === 'nett' ? x.closing - x.opening : x.closing), 0)
    }
    lines.push({ ...l, name: names.get(`${l.kind}/${l.targetId}`) ?? '', actual, variance: actual - l.amount })
  }
  return { budget: { id: b.id, name: b.name, from: b.from, to: b.to }, lines }
}

// ------------------------------------------------------------------ scenarios

export const SCENARIO_INCLUDES = ['Reversing Journal', 'Optional', 'Memorandum'] as const
export type ScenarioInclude = (typeof SCENARIO_INCLUDES)[number]
export interface ScenarioInput {
  name: string
  includeActuals: boolean
  include: ScenarioInclude[]
}

export async function listScenarios(db: Db, companyId: number): Promise<(ScenarioInput & { id: number })[]> {
  return (await db.query(`SELECT id, name, include_actuals "includeActuals", include FROM scenarios WHERE company_id = $1 ORDER BY lower(name)`, [companyId])).rows
}
function checkScenario(s: ScenarioInput) {
  const errors: string[] = []
  if (!s.name.trim()) errors.push('A scenario needs a name')
  if (!s.include.length && !s.includeActuals) errors.push('A scenario includes the actuals, or some vouchers kept out of the books')
  if (errors.length) throw new ValidationError(errors)
}
export async function createScenario(companyId: number, s: ScenarioInput) {
  checkScenario(s)
  return (await pool.query<{ id: number }>(
    `INSERT INTO scenarios (company_id, name, include_actuals, include) VALUES ($1,$2,$3,$4) RETURNING id`, [companyId, s.name.trim(), s.includeActuals, [...new Set(s.include)]],
  ).catch(taken('scenario', s.name))).rows[0].id
}
export async function alterScenario(companyId: number, id: number, s: ScenarioInput) {
  checkScenario(s)
  const { rowCount } = await pool.query(`UPDATE scenarios SET name = $3, include_actuals = $4, include = $5 WHERE id = $1 AND company_id = $2`,
    [id, companyId, s.name.trim(), s.includeActuals, [...new Set(s.include)]]).catch(taken('scenario', s.name))
  if (!rowCount) throw new ValidationError([`Unknown scenario ${id}`])
}
export async function deleteScenario(companyId: number, id: number) {
  const { rowCount } = await pool.query(`DELETE FROM scenarios WHERE id = $1 AND company_id = $2`, [id, companyId])
  if (!rowCount) throw new ValidationError([`Unknown scenario ${id}`])
}

/**
 * What a scenario adds to the books for a report from `from` to `to`: the lines of the vouchers it
 * includes, those before the period as earlier movement, those in it as the period's. A reversing
 * journal counts only while the report's date is within its applicable-upto date.
 */
export async function scenarioView(db: Db, companyId: number, scenarioId: number, to: string): Promise<ScenarioView & { name: string }> {
  const s = (await listScenarios(db, companyId)).find((x) => x.id === scenarioId)
  if (!s) throw new ValidationError([`Unknown scenario ${scenarioId}`])
  const { rows } = await db.query<{ date: string; entries: { ledgerId: number; amount: number }[] }>(
    `SELECT to_char(v.date, 'YYYY-MM-DD') date, v.draft -> 'entries' entries FROM vouchers v
      WHERE v.company_id = $1 AND NOT v.cancelled AND v.draft IS NOT NULL AND v.date <= $2
        AND ((v.type = 'Reversing Journal' AND 'Reversing Journal' = ANY($3) AND v.applicable_upto >= $2)
          OR (v.optional AND 'Optional' = ANY($3))
          OR (v.type = 'Memorandum' AND NOT v.optional AND 'Memorandum' = ANY($3)))`,
    [companyId, to, s.include],
  )
  return { name: s.name, includeActuals: s.includeActuals, lines: rows.flatMap((r) => (r.entries ?? []).map((e) => ({ date: r.date, ledgerId: e.ledgerId, amount: Number(e.amount) }))) }
}

