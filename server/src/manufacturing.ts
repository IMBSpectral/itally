/**
 * Bills of materials, Cost Estimation (what an item costs to make from its components at their
 * current cost) and the job work reports: job work orders and what is pending on them, our stock
 * with job workers, and principals' stock with us.
 */
import { pool, type Queryable } from './db'
import { getCompany, ValidationError } from './books'
import { pendingLines, stockPositions } from './inventory'
import { valueOf } from './engine/inventory'

export interface BomInput {
  name?: string // an item may have several; the first is "Main"
  makesQty: number // thousandths of the item's unit one batch makes
  components: { itemId: number; qty: number }[] // thousandths, per batch
  byProducts?: { itemId: number; qty: number; costShare: number | null }[] // made alongside, with their share of the cost (hundredths of a percent)
  scrap?: { itemId: number; qty: number }[]
}

/** An item's bill of materials by name, else its first. */
export async function getBom(db: Queryable, companyId: number, itemId: number, name?: string) {
  const { rows } = await db.query<Required<BomInput>>(
    `SELECT b.name, b.makes_qty::float8 "makesQty", b.components, b.by_products "byProducts", b.scrap FROM boms b JOIN stock_items s ON s.id = b.item_id
      WHERE b.item_id = $1 AND s.company_id = $2 AND ($3::text IS NULL OR lower(b.name) = lower($3)) ORDER BY b.id LIMIT 1`,
    [itemId, companyId, name ?? null],
  )
  return rows[0] ?? null
}

/** The names of an item's bills of materials. */
export async function bomNames(db: Queryable, companyId: number, itemId: number) {
  return (await db.query<{ name: string }>(
    `SELECT b.name FROM boms b JOIN stock_items s ON s.id = b.item_id WHERE b.item_id = $1 AND s.company_id = $2 ORDER BY b.id`, [itemId, companyId])).rows.map((r) => r.name)
}

/** Set one of an item's bills of materials (by name); no components removes it. */
export async function setBom(companyId: number, itemId: number, b: BomInput) {
  const name = b.name?.trim() || 'Main'
  const { rows } = await pool.query<{ id: number; decimals: number }>(
    `SELECT s.id, u.decimals FROM stock_items s JOIN units u ON u.id = s.unit_id WHERE s.company_id = $1`, [companyId])
  const items = new Map(rows.map((r) => [r.id, r]))
  if (!items.has(itemId)) throw new ValidationError(['Unknown stock item'])
  if (!b.components.length) {
    await pool.query(`DELETE FROM boms WHERE item_id = $1 AND lower(name) = lower($2)`, [itemId, name])
    return
  }
  const errors: string[] = []
  if (!Number.isSafeInteger(b.makesQty) || b.makesQty <= 0) errors.push('Give the quantity the components make')
  const seen = new Set<number>()
  for (const [i, c] of b.components.entries()) {
    if (!items.has(c.itemId)) errors.push(`Component ${i + 1}: unknown stock item`)
    if (c.itemId === itemId) errors.push('An item is not made from itself')
    if (seen.has(c.itemId)) errors.push(`Component ${i + 1}: listed twice`)
    seen.add(c.itemId)
    if (!Number.isSafeInteger(c.qty) || c.qty <= 0) errors.push(`Component ${i + 1}: give the quantity`)
  }
  for (const [i, x] of [...(b.byProducts ?? []), ...(b.scrap ?? [])].entries()) {
    if (!items.has(x.itemId)) errors.push(`By-product or scrap ${i + 1}: unknown stock item`)
    if (x.itemId === itemId || b.components.some((c) => c.itemId === x.itemId)) errors.push(`By-product or scrap ${i + 1}: the item made or a component`)
    if (!Number.isSafeInteger(x.qty) || x.qty <= 0) errors.push(`By-product or scrap ${i + 1}: give the quantity`)
  }
  if ((b.byProducts ?? []).reduce((t, x) => t + (x.costShare ?? 0), 0) > 10000) errors.push("The by-products' shares of the cost come to more than 100%")
  // no item may end up made from itself through its components
  const boms = new Map((await pool.query<{ itemId: number; components: { itemId: number }[] }>(
    `SELECT b.item_id "itemId", b.components FROM boms b JOIN stock_items s ON s.id = b.item_id WHERE s.company_id = $1`, [companyId])).rows
    .map((r) => [r.itemId, r.components.map((c) => c.itemId)]))
  boms.set(itemId, b.components.map((c) => c.itemId))
  const reaches = (from: number, path = new Set<number>()): boolean =>
    (boms.get(from) ?? []).some((c) => c === itemId || (!path.has(c) && (path.add(c), reaches(c, path))))
  if (b.components.some((c) => c.itemId !== itemId && reaches(c.itemId))) errors.push('A component is itself made from this item')
  if (errors.length) throw new ValidationError([...new Set(errors)])
  const json = (xs: object[]) => JSON.stringify(xs)
  const values = [b.makesQty, json(b.components.map((c) => ({ itemId: c.itemId, qty: c.qty }))),
    json((b.byProducts ?? []).map((x) => ({ itemId: x.itemId, qty: x.qty, costShare: x.costShare ?? null }))), json((b.scrap ?? []).map((x) => ({ itemId: x.itemId, qty: x.qty })))]
  const { rowCount } = await pool.query(
    `UPDATE boms SET makes_qty = $3, components = $4, by_products = $5, scrap = $6 WHERE item_id = $1 AND lower(name) = lower($2)`, [itemId, name, ...values])
  if (!rowCount) await pool.query(`INSERT INTO boms (item_id, name, makes_qty, components, by_products, scrap) VALUES ($1,$2,$3,$4,$5,$6)`, [itemId, name, ...values])
}

export interface CostLine {
  level: number // 1 = a direct component
  itemId: number
  item: string
  unit: string
  qty: number // thousandths
  rate: number // per unit
  amount: number
  made: boolean // costed from its own components (it had no cost of its own)
}

/**
 * Cost Estimation: an item's components for a quantity, each at its average cost as on the date;
 * a component with no cost yet that has its own bill of materials is costed from that, a level down.
 */
export async function costEstimation(db: Queryable, companyId: number, itemId: number, qty: number, asOf: string) {
  const company = (await getCompany(pool, companyId))!
  const positions = new Map((await stockPositions(db, companyId, company.booksBegin, asOf)).map((p) => [p.id, p]))
  const boms = new Map((await db.query<{ itemId: number; makesQty: number; components: { itemId: number; qty: number }[] }>(
    `SELECT b.item_id "itemId", b.makes_qty::float8 "makesQty", b.components FROM boms b JOIN stock_items s ON s.id = b.item_id WHERE s.company_id = $1 ORDER BY b.id DESC`, [companyId])).rows
    .map((r) => [r.itemId, r]))
  const top = positions.get(itemId)
  if (!top) throw new ValidationError(['Unknown stock item'])
  if (!boms.has(itemId)) throw new ValidationError([`${top.name} has no bill of materials`])
  const lines: CostLine[] = []
  const explode = (id: number, q: number, level: number): number => {
    const bom = boms.get(id)!
    let total = 0
    for (const c of bom.components) {
      const p = positions.get(c.itemId)
      const need = Math.round((c.qty * q) / bom.makesQty)
      const at = lines.length
      lines.push({ level, itemId: c.itemId, item: p?.name ?? '', unit: p?.unit ?? '', qty: need, rate: p?.rate ?? 0, amount: 0, made: false })
      let amount: number
      if ((p?.rate ?? 0) === 0 && boms.has(c.itemId) && level < 10) {
        amount = explode(c.itemId, need, level + 1)
        lines[at] = { ...lines[at], made: true, rate: need ? Math.round((amount * 1000) / need) : 0 }
      } else amount = valueOf(need, p?.rate ?? 0)
      lines[at].amount = amount
      total += amount
    }
    return total
  }
  const total = explode(itemId, qty, 1)
  return { item: top.name, unit: top.unit, qty, asOf, lines, total, perUnit: qty ? Math.round((total * 1000) / qty) : 0, currentRate: top.rate }
}

/** Job work as on a date: orders out and in with what is pending, our stock with job workers, and principals' stock with us. */
export async function jobWorkReport(db: Queryable, companyId: number, asOf: string) {
  const outOrders = await pendingLines(db, companyId, { type: 'Job Work Out Order', asOf, all: true })
  const inOrders = await pendingLines(db, companyId, { type: 'Job Work In Order', asOf, all: true })
  const { rows } = await db.query<{ godownId: number; godown: string; thirdParty: 'ours' | 'theirs'; itemId: number; item: string; unit: string; qty: string }>(
    `SELECT g.id "godownId", g.name godown, g.third_party "thirdParty", s.id "itemId", s.name item, u.symbol unit, SUM(x.qty) qty FROM (
       SELECT opening_godown_id godown_id, id item_id, opening_qty qty FROM stock_items WHERE company_id = $1
       UNION ALL
       SELECT i.godown_id, i.item_id, i.qty FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id
        WHERE v.company_id = $1 AND v.date <= $2 AND v.type NOT IN ('Sales Order', 'Purchase Order', 'Job Work In Order', 'Job Work Out Order') AND i.tracking_id IS NULL) x
       JOIN godowns g ON g.id = x.godown_id JOIN stock_items s ON s.id = x.item_id JOIN units u ON u.id = s.unit_id
      WHERE g.third_party IS NOT NULL
      GROUP BY g.id, s.id, u.symbol HAVING SUM(x.qty) <> 0 ORDER BY g.name, s.name`,
    [companyId, asOf],
  )
  const company = (await getCompany(pool, companyId))!
  const rates = new Map((await stockPositions(db, companyId, company.booksBegin, asOf)).map((p) => [p.id, p.rate]))
  const stock = rows.map((r) => ({ ...r, qty: Number(r.qty), value: r.thirdParty === 'ours' ? valueOf(Number(r.qty), rates.get(r.itemId) ?? 0) : null }))
  return {
    asOf,
    outOrders,
    inOrders,
    withJobWorkers: stock.filter((s) => s.thirdParty === 'ours'),
    withUs: stock.filter((s) => s.thirdParty === 'theirs'),
  }
}
