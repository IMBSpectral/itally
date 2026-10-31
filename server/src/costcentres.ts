/**
 * Cost categories and cost centres (masters), and the cost centre reports: Category Summary,
 * Cost Centre Break-up, Ledger Break-up and Group Break-up, all read from the cost allocations
 * of the period's entries.
 */
import { pool, withTx, type Queryable } from './db'
import { loadGroups, ValidationError } from './books'
import { isUnder } from './engine/groups'

const uniqueName = (name: string) => (err: { code?: string }) => {
  if (err.code === '23505') throw new ValidationError([`The name "${name}" is already used`])
  throw err
}

// ------------------------------------------------------------------ masters

export async function createCostCategory(companyId: number, c: { name: string }) {
  if (!c.name.trim()) throw new ValidationError(['A cost category needs a name'])
  const { rows } = await pool
    .query<{ id: number }>(`INSERT INTO cost_categories (company_id, name) VALUES ($1,$2) RETURNING id`, [companyId, c.name.trim()])
    .catch(uniqueName(c.name))
  return rows[0].id
}
export async function alterCostCategory(companyId: number, id: number, c: { name: string }) {
  if (!c.name.trim()) throw new ValidationError(['A cost category needs a name'])
  const r = await pool
    .query(`UPDATE cost_categories SET name = $3 WHERE id = $1 AND company_id = $2`, [id, companyId, c.name.trim()])
    .catch(uniqueName(c.name))
  if (!r.rowCount) throw new ValidationError(['Unknown cost category'])
}
export async function deleteCostCategory(companyId: number, id: number) {
  return withTx(async (tx) => {
    const { rows } = await tx.query<{ name: string; isDefault: boolean }>(
      `SELECT name, is_default "isDefault" FROM cost_categories WHERE id = $1 AND company_id = $2`, [id, companyId])
    if (!rows[0]) throw new ValidationError(['Unknown cost category'])
    if (rows[0].isDefault) throw new ValidationError([`${rows[0].name} is predefined and cannot be deleted`])
    if ((await tx.query(`SELECT 1 FROM cost_centres WHERE category_id = $1 LIMIT 1`, [id])).rowCount)
      throw new ValidationError([`${rows[0].name} has cost centres and cannot be deleted`])
    await tx.query(`DELETE FROM cost_categories WHERE id = $1`, [id])
  })
}

export interface CostCentreInput {
  name: string
  categoryId?: number | null // defaults to Primary Cost Category (or the parent's category)
  parentId?: number | null
}
async function centreValues(db: Queryable, companyId: number, c: CostCentreInput, self?: number) {
  const errors: string[] = []
  if (!c.name.trim()) errors.push('A cost centre needs a name')
  let categoryId = c.categoryId ?? null
  if (c.parentId) {
    const p = (await db.query<{ categoryId: number }>(`SELECT category_id "categoryId" FROM cost_centres WHERE id = $1 AND company_id = $2`, [c.parentId, companyId])).rows[0]
    if (!p) errors.push('Unknown parent cost centre')
    else if (categoryId !== null && categoryId !== p.categoryId) errors.push('A cost centre sits in the same category as the one it is under')
    else categoryId = p.categoryId
    if (self && p) {
      const { rows } = await db.query(
        `WITH RECURSIVE up AS (SELECT id, parent_id FROM cost_centres WHERE id = $1 UNION ALL
           SELECT x.id, x.parent_id FROM cost_centres x JOIN up ON x.id = up.parent_id) SELECT 1 FROM up WHERE id = $2`,
        [c.parentId, self],
      )
      if (rows.length) errors.push('A cost centre cannot sit under itself or one of its own sub-centres')
    }
  }
  if (categoryId === null)
    categoryId = (await db.query<{ id: number }>(`SELECT id FROM cost_categories WHERE company_id = $1 AND is_default`, [companyId])).rows[0]?.id ?? null
  else if (!(await db.query(`SELECT 1 FROM cost_categories WHERE id = $1 AND company_id = $2`, [categoryId, companyId])).rowCount)
    errors.push('Unknown cost category')
  if (errors.length) throw new ValidationError(errors)
  return [c.name.trim(), categoryId, c.parentId ?? null] as const
}
export async function createCostCentre(companyId: number, c: CostCentreInput) {
  const v = await centreValues(pool, companyId, c)
  const { rows } = await pool
    .query<{ id: number }>(`INSERT INTO cost_centres (company_id, name, category_id, parent_id) VALUES ($1,$2,$3,$4) RETURNING id`, [companyId, ...v])
    .catch(uniqueName(c.name))
  return rows[0].id
}
export async function alterCostCentre(companyId: number, id: number, c: CostCentreInput) {
  return withTx(async (tx) => {
    const cur = (await tx.query<{ categoryId: number }>(`SELECT category_id "categoryId" FROM cost_centres WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, companyId])).rows[0]
    if (!cur) throw new ValidationError(['Unknown cost centre'])
    const v = await centreValues(tx, companyId, c, id)
    // sub-centres follow their parent into another category
    if (v[1] !== cur.categoryId && (await tx.query(`SELECT 1 FROM cost_centres WHERE parent_id = $1 LIMIT 1`, [id])).rowCount)
      throw new ValidationError(['A cost centre with sub-centres cannot change category'])
    await tx.query(`UPDATE cost_centres SET name = $2, category_id = $3, parent_id = $4 WHERE id = $1`, [id, ...v]).catch(uniqueName(c.name))
  })
}
export async function deleteCostCentre(companyId: number, id: number) {
  return withTx(async (tx) => {
    const cur = (await tx.query<{ name: string }>(`SELECT name FROM cost_centres WHERE id = $1 AND company_id = $2`, [id, companyId])).rows[0]
    if (!cur) throw new ValidationError(['Unknown cost centre'])
    if ((await tx.query(`SELECT 1 FROM cost_centres WHERE parent_id = $1 UNION ALL SELECT 1 FROM cost_allocations WHERE cost_centre_id = $1 LIMIT 1`, [id])).rowCount)
      throw new ValidationError([`${cur.name} is in use and cannot be deleted`])
    await tx.query(`DELETE FROM cost_centres WHERE id = $1`, [id])
  })
}

export async function listCostMasters(db: Queryable, companyId: number) {
  const categories = (await db.query<{ id: number; name: string; isDefault: boolean }>(
    `SELECT id, name, is_default "isDefault" FROM cost_categories WHERE company_id = $1 ORDER BY is_default DESC, name`, [companyId])).rows
  const centres = (await db.query<{ id: number; name: string; categoryId: number; parentId: number | null }>(
    `SELECT id, name, category_id "categoryId", parent_id "parentId" FROM cost_centres WHERE company_id = $1 ORDER BY name`, [companyId])).rows
  return { categories, centres }
}

// ------------------------------------------------------------------ reports

export interface CostRow {
  centreId: number
  ledgerId: number
  ledger: string
  groupId: number | null
  dr: number
  cr: number // positive
}

/** Every cost centre × ledger total for the period (live vouchers only; a cancelled one has no entries). */
export async function costRows(db: Queryable, companyId: number, from: string, to: string): Promise<CostRow[]> {
  const { rows } = await db.query<CostRow>(
    `SELECT a.cost_centre_id "centreId", e.ledger_id "ledgerId", l.name ledger, l.group_id "groupId",
            SUM(GREATEST(a.amount, 0))::bigint dr, SUM(GREATEST(-a.amount, 0))::bigint cr
       FROM cost_allocations a JOIN entries e ON e.id = a.entry_id JOIN vouchers v ON v.id = e.voucher_id JOIN ledgers l ON l.id = e.ledger_id
      WHERE v.company_id = $1 AND v.date BETWEEN $2 AND $3
      GROUP BY 1, 2, 3, 4`,
    [companyId, from, to],
  )
  return rows.map((r) => ({ ...r, dr: Number(r.dr), cr: Number(r.cr) }))
}

const sum = (rs: { dr: number; cr: number }[]) => rs.reduce((t, r) => ({ dr: t.dr + r.dr, cr: t.cr + r.cr }), { dr: 0, cr: 0 })

/** A centre with everything under it. */
function subtree(centres: { id: number; parentId: number | null }[], id: number) {
  const out = new Set([id])
  for (let grew = true; grew; ) {
    grew = false
    for (const c of centres)
      if (c.parentId !== null && out.has(c.parentId) && !out.has(c.id)) {
        out.add(c.id)
        grew = true
      }
  }
  return out
}

/** Category Summary: each category's centres in their tree, a centre's totals including its sub-centres. */
export async function categorySummary(companyId: number, from: string, to: string) {
  const { categories, centres } = await listCostMasters(pool, companyId)
  const rows = await costRows(pool, companyId, from, to)
  const depthOf = (c: { parentId: number | null }): number => (c.parentId === null ? 0 : 1 + depthOf(centres.find((x) => x.id === c.parentId)!))
  return {
    from, to,
    categories: categories.map((cat) => {
      // parents before their children, siblings by name
      const mine = centres.filter((c) => c.categoryId === cat.id)
      const ordered: typeof mine = []
      const place = (parentId: number | null) => mine.filter((c) => c.parentId === parentId).forEach((c) => (ordered.push(c), place(c.id)))
      place(null)
      const lines = ordered.map((c) => {
        const ids = subtree(centres, c.id)
        return { id: c.id, name: c.name, parentId: c.parentId, depth: depthOf(c), ...sum(rows.filter((r) => ids.has(r.centreId))) }
      })
      return { id: cat.id, name: cat.name, lines, total: sum(lines.filter((l) => l.parentId === null)) }
    }),
  }
}

/** Cost Centre Break-up: the ledgers booked to one centre (and its sub-centres). */
export async function centreBreakup(companyId: number, centreId: number, from: string, to: string) {
  const { centres } = await listCostMasters(pool, companyId)
  const centre = centres.find((c) => c.id === centreId)
  if (!centre) return null
  const ids = subtree(centres, centreId)
  const byLedger = new Map<number, { id: number; name: string; dr: number; cr: number }>()
  for (const r of (await costRows(pool, companyId, from, to)).filter((r) => ids.has(r.centreId))) {
    const l = byLedger.get(r.ledgerId) ?? { id: r.ledgerId, name: r.ledger, dr: 0, cr: 0 }
    l.dr += r.dr
    l.cr += r.cr
    byLedger.set(r.ledgerId, l)
  }
  const lines = [...byLedger.values()].sort((a, b) => a.name.localeCompare(b.name))
  return { from, to, centre: { id: centre.id, name: centre.name }, lines, total: sum(lines) }
}

/** Ledger or Group Break-up: how one ledger's (or a group's ledgers') entries split across centres. */
export async function centresOf(companyId: number, which: { ledgerId: number } | { groupId: number }, from: string, to: string) {
  const { categories, centres } = await listCostMasters(pool, companyId)
  let rows = await costRows(pool, companyId, from, to)
  let title: string
  if ('ledgerId' in which) {
    const l = (await pool.query<{ name: string }>(`SELECT name FROM ledgers WHERE id = $1 AND company_id = $2`, [which.ledgerId, companyId])).rows[0]
    if (!l) return null
    title = l.name
    rows = rows.filter((r) => r.ledgerId === which.ledgerId)
  } else {
    const groups = await loadGroups(pool, companyId)
    const g = groups.get(which.groupId)
    if (!g) return null
    title = g.name
    rows = rows.filter((r) => r.groupId !== null && isUnder(groups, r.groupId, [g.name]))
  }
  const lines = centres
    .map((c) => ({ id: c.id, name: c.name, category: categories.find((x) => x.id === c.categoryId)!.name, ...sum(rows.filter((r) => r.centreId === c.id)) }))
    .filter((l) => l.dr || l.cr)
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
  return { from, to, title, lines, total: sum(lines) }
}
