/**
 * Inventory masters (units, stock groups, godowns, stock items), the item lines of vouchers,
 * and stock valuation at average cost.
 */
import { pool, withTx, type Tx, type Queryable } from './db'
import { ValidationError } from './books'
import { averageCost, LINKS, movesStock, valueOf, type InventoryLine, type ItemPosition, type StockItemRef, COSTED_TYPES } from './engine/inventory'
import type { VoucherInput, VoucherType } from './engine/voucher'
import { UQC_CODES } from './engine/gst-returns'
import { TAXABILITY, type Taxability } from './engine/gst'

type Db = Queryable

const uniqueName = (name: string) => (err: { code?: string }) => {
  if (err.code === '23505') throw new ValidationError([`The name "${name}" is already used`])
  throw err
}
async function one<T>(db: Db, sql: string, params: unknown[], what: string): Promise<T> {
  const { rows } = await db.query<T>(sql, params)
  if (!rows[0]) throw new ValidationError([`Unknown ${what}`])
  return rows[0]
}

// ------------------------------------------------------------------ units

export interface UnitInput {
  symbol: string // ignored for a compound unit, which is named after its parts ("Box of 12 Nos")
  name?: string
  decimals?: number // a compound unit takes its second unit's
  firstUnitId?: number | null // a compound unit: first unit, conversion, second unit
  conversion?: number | null
  secondUnitId?: number | null
  uqc?: string | null // GST unit quantity code, when the symbol isn't one GST knows (Box → BOX is found by itself)
}
const isCompound = (u: UnitInput) => u.firstUnitId != null || u.secondUnitId != null || u.conversion != null
function checkUnit(u: UnitInput) {
  if (u.uqc && !UQC_CODES.includes(u.uqc)) throw new ValidationError([`"${u.uqc}" is not a GST unit quantity code (UQC)`])
  if (isCompound(u)) {
    if (u.firstUnitId == null || u.secondUnitId == null || u.firstUnitId === u.secondUnitId)
      throw new ValidationError(['A compound unit needs two different simple units'])
    if (!Number.isInteger(u.conversion) || u.conversion! < 2) throw new ValidationError(['The conversion is a whole number of second units, 2 or more'])
    return
  }
  if (!u.symbol.trim()) throw new ValidationError(['A unit needs a symbol'])
  if (u.decimals !== undefined && (!Number.isInteger(u.decimals) || u.decimals < 0 || u.decimals > 3))
    throw new ValidationError(['A unit can have 0 to 3 decimal places'])
}
/** The values a unit row is written with; a compound unit's from its parts. */
async function unitRow(db: Db, companyId: number, u: UnitInput) {
  checkUnit(u)
  if (!isCompound(u)) return [u.symbol.trim(), u.name?.trim() ?? '', u.decimals ?? 0, null, null, null] as const
  const { rows } = await db.query<{ id: number; symbol: string; decimals: number; compound: boolean }>(
    `SELECT id, symbol, decimals, second_unit_id IS NOT NULL compound FROM units WHERE company_id = $1 AND id = ANY($2)`,
    [companyId, [u.firstUnitId, u.secondUnitId]],
  )
  const first = rows.find((r) => r.id === u.firstUnitId)
  const second = rows.find((r) => r.id === u.secondUnitId)
  if (!first || !second) throw new ValidationError(['Unknown unit'])
  if (first.compound || second.compound) throw new ValidationError(['A compound unit is made of simple units'])
  return [`${first.symbol} of ${u.conversion} ${second.symbol}`, '', second.decimals, u.firstUnitId!, u.secondUnitId!, u.conversion!] as const
}
export async function createUnit(companyId: number, u: UnitInput) {
  const row = await unitRow(pool, companyId, u)
  const { rows } = await pool
    .query<{ id: number }>(
      `INSERT INTO units (company_id, symbol, name, decimals, first_unit_id, second_unit_id, conversion) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [companyId, ...row],
    )
    .catch(uniqueName(row[0]))
  if (u.uqc) await pool.query(`UPDATE units SET uqc = $2 WHERE id = $1`, [rows[0].id, u.uqc])
  return rows[0].id
}
export async function alterUnit(companyId: number, id: number, u: UnitInput) {
  return withTx(async (tx) => {
    const cur = await one<{ decimals: number; compound: boolean; secondId: number | null; firstId: number | null; conversion: number | null }>(
      tx,
      `SELECT decimals, second_unit_id IS NOT NULL compound, second_unit_id "secondId", first_unit_id "firstId", conversion
         FROM units WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [id, companyId],
      'unit',
    )
    if (cur.compound !== isCompound(u)) throw new ValidationError(['A unit cannot change between simple and compound'])
    const row = await unitRow(tx, companyId, u)
    // quantities of a compound unit's items are in its second unit: that and the conversion stay once items use it
    const used = (await tx.query(`SELECT 1 FROM stock_items WHERE unit_id = $1 LIMIT 1`, [id])).rowCount
    if (cur.compound && used && (row[4] !== cur.secondId || row[5] !== cur.conversion))
      throw new ValidationError(['Stock items use this unit; its second unit and conversion stay'])
    // fewer decimals would make existing quantities invalid (in this unit, or in compounds counted in it)
    if (!cur.compound && row[2] < cur.decimals) {
      const step = 10 ** (3 - row[2])
      const bad = await tx.query(
        `SELECT 1 FROM stock_items s LEFT JOIN inventory_entries i ON i.item_id = s.id
          WHERE s.unit_id IN (SELECT $1 UNION SELECT id FROM units WHERE second_unit_id = $1) AND (s.opening_qty % $2 <> 0 OR i.qty % $2 <> 0) LIMIT 1`,
        [id, step],
      )
      if (bad.rowCount) throw new ValidationError(['Some quantities in this unit use more decimal places than that'])
    }
    await tx.query(`UPDATE units SET symbol = $2, name = $3, decimals = $4, first_unit_id = $5, second_unit_id = $6, conversion = $7 WHERE id = $1`, [id, ...row])
      .catch(uniqueName(row[0]))
    await tx.query(`UPDATE units SET uqc = $2 WHERE id = $1`, [id, u.uqc || null])
    if (!cur.compound) {
      // compounds made of this unit follow its symbol and decimals
      await tx.query(
        `UPDATE units c SET symbol = f.symbol || ' of ' || c.conversion || ' ' || s.symbol, decimals = s.decimals
           FROM units f, units s WHERE f.id = c.first_unit_id AND s.id = c.second_unit_id AND (c.first_unit_id = $1 OR c.second_unit_id = $1)`,
        [id],
      )
    }
  })
}
export async function deleteUnit(companyId: number, id: number) {
  return withTx(async (tx) => {
    const u = await one<{ symbol: string }>(tx, `SELECT symbol FROM units WHERE id = $1 AND company_id = $2`, [id, companyId], 'unit')
    if ((await tx.query(`SELECT 1 FROM stock_items WHERE unit_id = $1 LIMIT 1`, [id])).rowCount)
      throw new ValidationError([`Unit "${u.symbol}" is used by stock items`])
    if ((await tx.query(`SELECT 1 FROM units WHERE first_unit_id = $1 OR second_unit_id = $1 LIMIT 1`, [id])).rowCount)
      throw new ValidationError([`Unit "${u.symbol}" is part of a compound unit`])
    await tx.query(`DELETE FROM units WHERE id = $1`, [id])
  })
}

// ------------------------------------------------------------------ stock groups and godowns (both trees)

export interface TreeInput {
  name: string
  parentId?: number | null
  thirdParty?: 'ours' | 'theirs' | null // godowns: our stock with a job worker, or a principal's stock with us
}
async function createInTree(table: 'stock_groups' | 'godowns', companyId: number, t: TreeInput) {
  if (!t.name.trim()) throw new ValidationError(['A name is needed'])
  if (t.parentId) await one(pool, `SELECT 1 FROM ${table} WHERE id = $1 AND company_id = $2`, [t.parentId, companyId], 'parent')
  const { rows } = await pool
    .query<{ id: number }>(`INSERT INTO ${table} (company_id, name, parent_id) VALUES ($1,$2,$3) RETURNING id`, [companyId, t.name.trim(), t.parentId ?? null])
    .catch(uniqueName(t.name))
  if (table === 'godowns' && t.thirdParty) await pool.query(`UPDATE godowns SET third_party = $2 WHERE id = $1`, [rows[0].id, t.thirdParty])
  return rows[0].id
}
async function alterInTree(table: 'stock_groups' | 'godowns', companyId: number, id: number, t: TreeInput) {
  return withTx(async (tx) => {
    await one(tx, `SELECT 1 FROM ${table} WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, companyId], 'item')
    if (t.parentId) {
      // not under itself or its own descendants
      const { rows } = await tx.query(
        `WITH RECURSIVE up AS (SELECT id, parent_id FROM ${table} WHERE id = $1 UNION ALL
           SELECT x.id, x.parent_id FROM ${table} x JOIN up ON x.id = up.parent_id) SELECT 1 FROM up WHERE id = $2`,
        [t.parentId, id],
      )
      if (rows.length) throw new ValidationError(['It cannot sit under itself or one of its own sub-items'])
    }
    await tx.query(`UPDATE ${table} SET name = $2, parent_id = $3 WHERE id = $1`, [id, t.name.trim(), t.parentId ?? null]).catch(uniqueName(t.name))
    if (table === 'godowns') {
      // whose stock a godown holds decides whether its lines count; it stays once it has any
      const cur = (await tx.query<{ third_party: string | null }>(`SELECT third_party FROM godowns WHERE id = $1`, [id])).rows[0]
      if ((cur.third_party ?? null) !== (t.thirdParty ?? null)) {
        if ((await tx.query(`SELECT 1 FROM inventory_entries WHERE godown_id = $1 LIMIT 1`, [id])).rowCount)
          throw new ValidationError(['The godown has stock movements, so whose stock it holds cannot change'])
        await tx.query(`UPDATE godowns SET third_party = $2 WHERE id = $1`, [id, t.thirdParty ?? null])
      }
    }
  })
}
async function deleteInTree(table: 'stock_groups' | 'godowns', companyId: number, id: number) {
  return withTx(async (tx) => {
    const row = await one<{ name: string; is_default?: boolean }>(tx, `SELECT * FROM ${table} WHERE id = $1 AND company_id = $2`, [id, companyId], 'item')
    if (row.is_default) throw new ValidationError([`${row.name} is the default location and cannot be deleted`])
    const used =
      (await tx.query(`SELECT 1 FROM ${table} WHERE parent_id = $1 LIMIT 1`, [id])).rowCount! +
      (table === 'stock_groups'
        ? (await tx.query(`SELECT 1 FROM stock_items WHERE group_id = $1 LIMIT 1`, [id])).rowCount!
        : (await tx.query(`SELECT 1 FROM inventory_entries WHERE godown_id = $1 UNION ALL SELECT 1 FROM stock_items WHERE opening_godown_id = $1 LIMIT 1`, [id])).rowCount!)
    if (used) throw new ValidationError([`${row.name} is in use and cannot be deleted`])
    await tx.query(`DELETE FROM ${table} WHERE id = $1`, [id])
  })
}
export const createStockGroup = (c: number, t: TreeInput) => createInTree('stock_groups', c, t)
export const alterStockGroup = (c: number, id: number, t: TreeInput) => alterInTree('stock_groups', c, id, t)
export const deleteStockGroup = (c: number, id: number) => deleteInTree('stock_groups', c, id)
export const createGodown = (c: number, t: TreeInput) => createInTree('godowns', c, t)
export const alterGodown = (c: number, id: number, t: TreeInput) => alterInTree('godowns', c, id, t)
export const deleteGodown = (c: number, id: number) => deleteInTree('godowns', c, id)

export async function defaultGodown(db: Db, companyId: number) {
  return (await one<{ id: number }>(db, `SELECT id FROM godowns WHERE company_id = $1 AND is_default`, [companyId], 'default godown')).id
}

// ------------------------------------------------------------------ stock items

export interface StockItemInput {
  name: string
  groupId?: number | null
  unitId: number
  openingQty?: number // thousandths
  openingValue?: number // paise
  openingGodownId?: number | null
  hsn?: string | null
  gstRate?: number | null // hundredths of a percent
  cessRate?: number | null // compensation cess, hundredths of a percent
  reorderLevel?: number | null // thousandths: Reorder Status flags the item once stock falls below it
  minOrderQty?: number | null // thousandths: the least that is ordered at a time
  categoryId?: number | null // stock category (a brand, a size), across stock groups
  gstClassificationId?: number | null // its HSN, rate and taxability replace the item's own
  batches?: boolean // kept in batches: each line that moves it names its batch
  taxability?: Taxability | null // Exempt, Nil Rated or Non-GST; absent is taxable
}
async function checkItem(db: Db, companyId: number, s: StockItemInput) {
  const errors: string[] = []
  if (!s.name.trim()) errors.push('A stock item needs a name')
  const unit = (await db.query<{ decimals: number }>(`SELECT decimals FROM units WHERE id = $1 AND company_id = $2`, [s.unitId, companyId])).rows[0]
  if (!unit) errors.push('Choose a unit')
  if (s.groupId && !(await db.query(`SELECT 1 FROM stock_groups WHERE id = $1 AND company_id = $2`, [s.groupId, companyId])).rowCount)
    errors.push('Unknown stock group')
  if (s.categoryId && !(await db.query(`SELECT 1 FROM stock_categories WHERE id = $1 AND company_id = $2`, [s.categoryId, companyId])).rowCount)
    errors.push('Unknown stock category')
  if (s.gstClassificationId && !(await db.query(`SELECT 1 FROM gst_classifications WHERE id = $1 AND company_id = $2`, [s.gstClassificationId, companyId])).rowCount)
    errors.push('Unknown GST classification')
  if (s.taxability && !TAXABILITY.includes(s.taxability)) errors.push('Taxability is Taxable, Exempt, Nil Rated or Non-GST')
  if (s.openingGodownId && !(await db.query(`SELECT 1 FROM godowns WHERE id = $1 AND company_id = $2`, [s.openingGodownId, companyId])).rowCount)
    errors.push('Unknown godown')
  const qty = s.openingQty ?? 0
  const value = s.openingValue ?? 0
  if (!Number.isSafeInteger(qty) || qty < 0 || !Number.isSafeInteger(value) || value < 0) errors.push('Opening quantity and value cannot be negative')
  if (unit && qty % 10 ** (3 - unit.decimals) !== 0) errors.push(`The unit allows ${unit.decimals} decimal places`)
  if (qty === 0 && value !== 0) errors.push('An opening value needs an opening quantity')
  if (s.gstRate != null && (!Number.isInteger(s.gstRate) || s.gstRate < 0 || s.gstRate > 10000)) errors.push('GST rate must be between 0% and 100%')
  if (s.cessRate != null && (!Number.isInteger(s.cessRate) || s.cessRate < 0 || s.cessRate > 100000)) errors.push('Cess rate must be between 0% and 1000%')
  for (const [label, q] of [['reorder level', s.reorderLevel], ['minimum order quantity', s.minOrderQty]] as const)
    if (q != null && (!Number.isSafeInteger(q) || q < 0)) errors.push(`The ${label} cannot be negative`)
    else if (q != null && unit && q % 10 ** (3 - unit.decimals) !== 0) errors.push(`The unit allows ${unit.decimals} decimal places`)
  if (errors.length) throw new ValidationError(errors)
}
const itemExtras = (s: StockItemInput) => [s.categoryId ?? null, s.gstClassificationId ?? null, s.taxability && s.taxability !== 'Taxable' ? s.taxability : null, !!s.batches, s.cessRate || null]
export async function createStockItem(companyId: number, s: StockItemInput) {
  await checkItem(pool, companyId, s)
  const godown = s.openingGodownId ?? (await defaultGodown(pool, companyId))
  const { rows } = await pool
    .query<{ id: number }>(
      `INSERT INTO stock_items (company_id, name, group_id, unit_id, opening_qty, opening_value, opening_godown_id, hsn, gst_rate, reorder_level, min_order_qty)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [companyId, s.name.trim(), s.groupId ?? null, s.unitId, s.openingQty ?? 0, s.openingValue ?? 0, godown, s.hsn?.trim() || null, s.gstRate ?? null,
        s.reorderLevel ?? null, s.minOrderQty ?? null],
    )
    .catch(uniqueName(s.name))
  await pool.query(`UPDATE stock_items SET category_id = $2, gst_classification_id = $3, taxability = $4, batches = $5, cess_rate = $6 WHERE id = $1`, [rows[0].id, ...itemExtras(s)])
  return rows[0].id
}
export async function alterStockItem(companyId: number, id: number, s: StockItemInput) {
  return withTx(async (tx) => {
    await one(tx, `SELECT 1 FROM stock_items WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, companyId], 'stock item')
    await checkItem(tx, companyId, s)
    const decimals = (await tx.query<{ decimals: number }>(`SELECT decimals FROM units WHERE id = $1`, [s.unitId])).rows[0].decimals
    if ((await tx.query(`SELECT 1 FROM inventory_entries WHERE item_id = $1 AND qty % $2 <> 0 LIMIT 1`, [id, 10 ** (3 - decimals)])).rowCount)
      throw new ValidationError(['Vouchers hold quantities this unit cannot express'])
    await tx
      .query(
        `UPDATE stock_items SET name = $2, group_id = $3, unit_id = $4, opening_qty = $5, opening_value = $6, opening_godown_id = $7,
                hsn = $8, gst_rate = $9, reorder_level = $10, min_order_qty = $11 WHERE id = $1`,
        [id, s.name.trim(), s.groupId ?? null, s.unitId, s.openingQty ?? 0, s.openingValue ?? 0, s.openingGodownId ?? (await defaultGodown(tx, companyId)),
          s.hsn?.trim() || null, s.gstRate ?? null, s.reorderLevel ?? null, s.minOrderQty ?? null],
      )
      .catch(uniqueName(s.name))
    await tx.query(`UPDATE stock_items SET category_id = $2, gst_classification_id = $3, taxability = $4, batches = $5, cess_rate = $6 WHERE id = $1`, [id, ...itemExtras(s)])
  })
}
export async function deleteStockItem(companyId: number, id: number) {
  return withTx(async (tx) => {
    const s = await one<{ name: string }>(tx, `SELECT name FROM stock_items WHERE id = $1 AND company_id = $2`, [id, companyId], 'stock item')
    if ((await tx.query(`SELECT 1 FROM inventory_entries WHERE item_id = $1 LIMIT 1`, [id])).rowCount)
      throw new ValidationError([`${s.name} has vouchers and cannot be deleted`])
    await tx.query(`DELETE FROM stock_items WHERE id = $1`, [id])
  })
}

/** Everything an invoice needs to be checked: the company's items (with unit decimals) and godowns. */
export async function inventoryRefs(db: Db, companyId: number) {
  const items = (await db.query<StockItemRef>(
    `SELECT s.id, s.name, u.decimals FROM stock_items s JOIN units u ON u.id = s.unit_id WHERE s.company_id = $1`,
    [companyId],
  )).rows
  const godowns = (await db.query<{ id: number }>(`SELECT id FROM godowns WHERE company_id = $1`, [companyId])).rows
  return { items: new Map(items.map((i) => [i.id, i])), godowns: new Set(godowns.map((g) => g.id)) }
}

// ------------------------------------------------------------------ item lines

const LINE_COLUMNS = 17
/** Item lines of one or more vouchers, in chunked multi-row INSERTs. */
export async function insertInventory(tx: Tx, rows: { voucherId: number; type: VoucherType; lines: InventoryLine[] }[]) {
  // a third party's stock with us is not ours: its lines move none of our stock
  const theirs = await theirGodowns(tx, [...new Set(rows.flatMap((r) => r.lines.map((l) => l.godownId)))])
  const all = rows.flatMap((r) =>
    r.lines.map((l, i) => [
      r.voucherId, i + 1, l.itemId, l.godownId, l.qty, l.rate, l.amount,
      movesStock(r.type, l) && !theirs.has(l.godownId), l.counted ?? null, l.orderId ?? null, l.trackingId ?? null, l.dueDate ?? null,
      l.batch?.trim() || null, l.mfgDate ?? null, l.expiryDate ?? null, l.role ?? null, l.role === 'by-product' ? (l.costShare ?? null) : null,
    ]),
  )
  for (let at = 0; at < all.length; at += 1500) {
    const chunk = all.slice(at, at + 1500)
    await tx.query(
      `INSERT INTO inventory_entries (voucher_id, line, item_id, godown_id, qty, rate, amount, moves_stock, counted, order_id, tracking_id, due_date, batch, mfg_date, expiry_date,
                                      role, cost_share) VALUES ${chunk
        .map((_, j) => `(${Array.from({ length: LINE_COLUMNS }, (_, k) => `$${j * LINE_COLUMNS + k + 1}`).join(',')})`)
        .join(',')}`,
      chunk.flat(),
    )
  }
}

// ------------------------------------------------------------------ Physical Stock

/**
 * A Physical Stock voucher records what was counted; it moves stock by the difference from the
 * books as on its date (every voucher up to and including that day, apart from itself). A
 * shortage goes out at average cost; an excess comes in at the item's average rate, so it
 * doesn't change the average. The difference is fixed when the voucher is saved, as Tally's is
 * when its count is accepted; altering the voucher works it out again.
 */
export async function countToDifference(db: Db, companyId: number, v: VoucherInput, booksBegin: string, self?: number): Promise<VoucherInput> {
  if (COSTED_TYPES.includes(v.type)) return costMade(db, companyId, v, booksBegin, self)
  if (v.type !== 'Physical Stock' || !v.inventory?.length) return v
  const items = [...new Set(v.inventory.map((l) => l.itemId))]
  const { rows } = await db.query<{ item: number; godown: number; qty: number }>(
    `SELECT item, godown, SUM(qty)::bigint qty FROM (
       SELECT id item, opening_godown_id godown, opening_qty qty FROM stock_items WHERE company_id = $1 AND id = ANY($2)
       UNION ALL
       SELECT i.item_id, i.godown_id, i.qty FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id
        WHERE v.company_id = $1 AND i.item_id = ANY($2) AND i.moves_stock AND v.date <= $3 AND v.id IS DISTINCT FROM $4) x
     GROUP BY item, godown`,
    [companyId, items, v.date, self ?? null],
  )
  const book = new Map(rows.map((r) => [`${r.item}@${r.godown}`, Number(r.qty)]))
  const rates = new Map((await stockPositions(db, companyId, booksBegin, v.date, self)).map((p) => [p.id, p.rate]))
  return {
    ...v,
    inventory: v.inventory.map((l) => {
      if (l.counted == null) return l
      const qty = l.counted - (book.get(`${l.itemId}@${l.godownId}`) ?? 0)
      const rate = rates.get(l.itemId) ?? 0
      return { ...l, qty, rate, amount: qty ? valueOf(qty, rate) : 0 }
    }),
  }
}

async function theirGodowns(db: Db, ids: number[]) {
  if (!ids.length) return new Set<number>()
  return new Set((await db.query<{ id: number }>(`SELECT id FROM godowns WHERE id = ANY($1) AND third_party = 'theirs'`, [ids])).rows.map((r) => r.id))
}

/**
 * Manufacturing Journal, Material In and Material Out, as Tally values them: what is consumed (or
 * sent) goes out at average cost as on the voucher's date, and what is made (or received) takes
 * that cost plus the additional cost, shared by the values typed on its lines (else by quantity).
 * A third party's stock with us carries no value of ours and is left as typed. Scrap is valued at
 * the rate typed on it, which comes off the cost; a by-product with a cost share takes that share
 * of what is left; the main products share the rest.
 */
async function costMade(db: Db, companyId: number, v: VoucherInput, booksBegin: string, self?: number): Promise<VoucherInput> {
  const lines = v.inventory ?? []
  const theirs = await theirGodowns(db, [...new Set(lines.map((l) => l.godownId))])
  const ours = (l: InventoryLine) => !theirs.has(l.godownId)
  if (!lines.some((l) => l.qty < 0 && ours(l)) || !lines.some((l) => l.qty > 0 && ours(l))) return v
  const rates = new Map((await stockPositions(db, companyId, booksBegin, v.date, self)).map((p) => [p.id, p.rate]))
  const valued = lines.map((l) => (l.qty < 0 && ours(l) ? { ...l, rate: rates.get(l.itemId) ?? 0, amount: valueOf(l.qty, rates.get(l.itemId) ?? 0) } : l))
  const gross = -valued.filter((l) => l.qty < 0 && ours(l)).reduce((t, l) => t + l.amount, 0) + (v.additionalCost ?? 0)
  const scrapValue = valued.filter((l) => l.qty > 0 && ours(l) && l.role === 'scrap').reduce((t, l) => t + Math.max(l.amount, 0), 0)
  const fixed = valued.map((l, i) => ({ l, i })).filter(({ l }) => l.qty > 0 && ours(l) && l.role === 'by-product' && l.costShare != null)
  const shares = fixed.reduce((t, { l }) => t + l.costShare!, 0)
  if (shares > 10000) throw new ValidationError(["The by-products' shares of the cost come to more than 100%"])
  if (scrapValue > gross) throw new ValidationError(['The scrap is valued at more than the cost of what was consumed'])
  const net = gross - scrapValue
  for (const { l, i } of fixed) {
    const share = Math.round((net * l.costShare!) / 10000)
    valued[i] = { ...l, amount: share, rate: Math.round((share * 1000) / l.qty) }
  }
  const cost = net - fixed.reduce((t, { i }) => t + valued[i].amount, 0)
  const made = valued.map((l, i) => ({ l, i })).filter(({ l }) => l.qty > 0 && ours(l) && l.role !== 'scrap' && !(l.role === 'by-product' && l.costShare != null))
  if (!made.length) return { ...v, inventory: valued }
  const byValue = made.every(({ l }) => l.amount > 0)
  const weight = (l: InventoryLine) => (byValue ? l.amount : l.qty)
  const total = made.reduce((t, { l }) => t + weight(l), 0)
  let left = cost
  made.forEach(({ l, i }, k) => {
    const share = k === made.length - 1 ? left : Math.round((cost * weight(l)) / total)
    left -= share
    valued[i] = { ...l, amount: share, rate: Math.round((share * 1000) / l.qty) }
  })
  return { ...v, inventory: valued }
}

// ------------------------------------------------------------------ orders and notes

export interface PendingLine {
  voucherId: number
  type: VoucherType
  number: number
  docNo: string // the number shown
  date: string
  partyId: number | null
  party: string | null
  itemId: number
  item: string
  unit: string
  decimals: number
  godownId: number
  rate: number
  dueDate: string | null
  ordered: number // positive
  done: number // delivered (orders) or invoiced (notes), positive
  pending: number
}

/**
 * What is still pending on orders or notes of one type: each voucher's quantity of an item less
 * what other vouchers have since delivered or invoiced against it. `self` leaves out one
 * voucher's own lines (the one being altered); `all` keeps lines with nothing pending.
 */
export async function pendingLines(
  db: Db,
  companyId: number,
  opts: { type: VoucherType; partyId?: number; asOf?: string; ids?: number[]; self?: number; all?: boolean },
): Promise<PendingLine[]> {
  const { rows } = await db.query<PendingLine>(
    `WITH src AS (
       SELECT v.id, v.type, v.number, COALESCE(v.doc_no, v.number::text) doc_no, v.date, v.party_ledger_id, i.item_id, MIN(i.godown_id) godown_id, SUM(abs(i.qty))::bigint ordered,
              CASE WHEN SUM(abs(i.qty)) = 0 THEN 0 ELSE round(SUM(abs(i.amount)) * 1000.0 / SUM(abs(i.qty)))::bigint END rate,
              MIN(i.due_date) due_date
         FROM vouchers v JOIN inventory_entries i ON i.voucher_id = v.id
        WHERE v.company_id = $1 AND v.type = $2 AND NOT v.cancelled
          AND ($3::int IS NULL OR v.party_ledger_id = $3) AND ($4::date IS NULL OR v.date <= $4) AND ($5::int[] IS NULL OR v.id = ANY($5))
        GROUP BY v.id, i.item_id),
     done AS (
       SELECT COALESCE(i.order_id, i.tracking_id) src_id, i.item_id, SUM(abs(i.qty))::bigint qty
         FROM inventory_entries i
        WHERE COALESCE(i.order_id, i.tracking_id) IN (SELECT id FROM src) AND i.voucher_id IS DISTINCT FROM $6::int
        GROUP BY 1, 2)
     SELECT s.id "voucherId", s.type, s.number, s.doc_no "docNo", to_char(s.date,'YYYY-MM-DD') date, s.party_ledger_id "partyId", l.name party,
            s.item_id "itemId", st.name item, COALESCE(su.symbol, u.symbol) unit, u.decimals, s.godown_id "godownId", s.rate,
            fu.symbol "perUnit", u.conversion,
            to_char(s.due_date,'YYYY-MM-DD') "dueDate", s.ordered, COALESCE(d.qty, 0)::bigint done, (s.ordered - COALESCE(d.qty, 0))::bigint pending
       FROM src s JOIN stock_items st ON st.id = s.item_id JOIN units u ON u.id = st.unit_id LEFT JOIN units su ON su.id = u.second_unit_id LEFT JOIN units fu ON fu.id = u.first_unit_id
       LEFT JOIN ledgers l ON l.id = s.party_ledger_id
       LEFT JOIN done d ON d.src_id = s.id AND d.item_id = s.item_id
      WHERE $7::boolean OR s.ordered > COALESCE(d.qty, 0)
      ORDER BY s.date, s.number, st.name`,
    [companyId, opts.type, opts.partyId ?? null, opts.asOf ?? null, opts.ids ?? null, opts.self ?? null, opts.all ?? false],
  )
  return rows.map((r) => ({ ...r, ordered: Number(r.ordered), done: Number(r.done), pending: Number(r.pending), rate: Number(r.rate) }))
}

/** The batch an item's opening stock is in, when the item is kept in batches. */
export const OPENING_BATCH = 'Opening Stock'

/**
 * Batches: every line that moves an item kept in batches names its batch; goods going out of a
 * batch must be in it, in that godown, as on the voucher's date (the opening stock is the batch
 * "Opening Stock"). `earlier`: vouchers posted before this one in the same import, not yet in the books.
 */
export async function batchErrors(db: Db, companyId: number, v: VoucherInput, self?: number, earlier: VoucherInput[] = []): Promise<string[]> {
  const lines = (v.inventory ?? []).filter((l) => movesStock(v.type, l))
  if (!lines.length) return []
  const items = new Map((await db.query<{ id: number; name: string; decimals: number }>(
    `SELECT s.id, s.name, u.decimals FROM stock_items s JOIN units u ON u.id = s.unit_id WHERE s.company_id = $1 AND s.batches AND s.id = ANY($2)`,
    [companyId, [...new Set(lines.map((l) => l.itemId))]],
  )).rows.map((i) => [i.id, i]))
  if (!items.size) return []
  const errors: string[] = []
  const net = new Map<string, { itemId: number; godownId: number; batch: string; qty: number }>()
  lines.forEach((l, i) => {
    const item = items.get(l.itemId)
    if (!item) return
    const batch = l.batch?.trim()
    if (!batch) return errors.push(`Item line ${i + 1}: ${item.name} is kept in batches; name the batch`)
    if (batch.length > 40) return errors.push(`Item line ${i + 1}: a batch name is at most 40 characters`)
    if (l.mfgDate && l.expiryDate && l.expiryDate < l.mfgDate) errors.push(`Item line ${i + 1}: the batch expires before it is made`)
    const k = `${l.itemId}|${l.godownId}|${batch.toLowerCase()}`
    const x = net.get(k) ?? net.set(k, { itemId: l.itemId, godownId: l.godownId, batch, qty: 0 }).get(k)!
    x.qty += l.qty
  })
  for (const x of [...net.values()].filter((x) => x.qty < 0)) {
    const { rows } = await db.query<{ qty: number }>(
      `SELECT (COALESCE((SELECT SUM(i.qty) FROM inventory_entries i JOIN vouchers w ON w.id = i.voucher_id
                          WHERE w.company_id = $1 AND i.item_id = $2 AND i.godown_id = $3 AND lower(i.batch) = lower($4) AND i.moves_stock AND NOT w.cancelled
                            AND w.date <= $5 AND w.id IS DISTINCT FROM $6), 0)
             + COALESCE((SELECT opening_qty FROM stock_items WHERE id = $2 AND opening_godown_id = $3 AND lower($4) = lower($7)), 0))::float8 qty`,
      [companyId, x.itemId, x.godownId, x.batch, v.date, self ?? null, OPENING_BATCH],
    )
    const before = earlier.filter((w) => w.date <= v.date).flatMap((w) => (w.inventory ?? []).filter((l) => movesStock(w.type, l)))
      .filter((l) => l.itemId === x.itemId && l.godownId === x.godownId && l.batch?.trim().toLowerCase() === x.batch.toLowerCase())
    const have = rows[0].qty + before.reduce((s, l) => s + l.qty, 0)
    const item = items.get(x.itemId)!
    if (have + x.qty < 0)
      errors.push(have <= 0
        ? `${item.name}: there is no batch "${x.batch}" in that godown`
        : `${item.name}: batch "${x.batch}" has ${(have / 1000).toFixed(item.decimals)} in that godown, not ${(-x.qty / 1000).toFixed(item.decimals)}`)
  }
  return errors
}

/**
 * Batch-wise stock as on a date: each batch of each item kept in batches, by godown, with its
 * dates of manufacture and expiry and how many days are left (negative: expired).
 */
export async function batchSummary(db: Db, companyId: number, asOf: string, itemId?: number) {
  const { rows } = await db.query<{ itemId: number; item: string; unit: string; decimals: number; godown: string; batch: string; qty: number; mfgDate: string | null
    expiryDate: string | null; firstIn: string | null }>(
    `WITH lines AS (
       SELECT i.item_id, i.godown_id, i.batch, i.qty, i.mfg_date, i.expiry_date, w.date
         FROM inventory_entries i JOIN vouchers w ON w.id = i.voucher_id
        WHERE w.company_id = $1 AND i.batch IS NOT NULL AND i.moves_stock AND NOT w.cancelled AND w.date <= $2
       UNION ALL
       SELECT s.id, s.opening_godown_id, $4, s.opening_qty, NULL, NULL, NULL FROM stock_items s WHERE s.company_id = $1 AND s.batches AND s.opening_qty <> 0)
     SELECT s.id "itemId", s.name item, COALESCE(su.symbol, u.symbol) unit, u.decimals, g.name godown, min(l.batch) batch, SUM(l.qty)::float8 qty,
            to_char(min(l.mfg_date), 'YYYY-MM-DD') "mfgDate", to_char(min(l.expiry_date), 'YYYY-MM-DD') "expiryDate", to_char(min(l.date), 'YYYY-MM-DD') "firstIn"
       FROM lines l JOIN stock_items s ON s.id = l.item_id JOIN units u ON u.id = s.unit_id LEFT JOIN units su ON su.id = u.second_unit_id JOIN godowns g ON g.id = l.godown_id
      WHERE s.batches AND ($3::int IS NULL OR s.id = $3)
      GROUP BY s.id, s.name, su.symbol, u.symbol, u.decimals, g.name, lower(l.batch)
     HAVING SUM(l.qty) <> 0
      ORDER BY s.name, min(l.expiry_date) NULLS LAST, min(l.batch)`,
    [companyId, asOf, itemId ?? null, OPENING_BATCH],
  )
  const days = (d: string) => Math.round((Date.parse(d) - Date.parse(asOf)) / 86_400_000)
  return rows.map((r) => ({ ...r, daysLeft: r.expiryDate ? days(r.expiryDate) : null }))
}

/**
 * The orders and notes a voucher's lines are made against: of the right type, not cancelled,
 * for the same party, carrying the item, and with enough still pending.
 */
export async function linkErrors(db: Db, companyId: number, v: VoucherInput, self?: number): Promise<string[]> {
  const lines = (v.inventory ?? []).filter((l) => l.orderId != null || l.trackingId != null)
  if (!lines.length) return []
  const kinds = LINKS[v.type]
  if (!kinds) return [] // validateInventory has reported it
  const errors: string[] = []
  const parties = new Set<number>(v.partyId != null ? [v.partyId] : v.entries.map((e) => e.ledgerId))
  const ids = [...new Set(lines.map((l) => (l.orderId ?? l.trackingId)!))]
  const { rows: targets } = await db.query<{ id: number; type: VoucherType; docNo: string; party: number | null; cancelled: boolean }>(
    `SELECT id, type, COALESCE(doc_no, number::text) "docNo", party_ledger_id party, cancelled FROM vouchers WHERE company_id = $1 AND id = ANY($2)`,
    [companyId, ids],
  )
  const byId = new Map(targets.map((t) => [t.id, t]))
  const pending = new Map<string, PendingLine>()
  for (const type of new Set(targets.map((t) => t.type)))
    for (const p of await pendingLines(db, companyId, { type, ids, self, all: true })) pending.set(`${p.voucherId}#${p.itemId}`, p)
  const wanted = new Map<string, number>()
  lines.forEach((l, i) => {
    const id = (l.orderId ?? l.trackingId)!
    const t = byId.get(id)
    const expected = l.orderId != null ? kinds.order : kinds.note
    const at = `Item line ${i + 1}`
    if (!t || t.type !== expected) return errors.push(`${at}: there is no ${expected} ${id} to make it against`)
    const name = `${t.type} No. ${t.docNo}`
    if (t.cancelled) return errors.push(`${at}: ${name} is cancelled`)
    if (t.party === null || !parties.has(t.party)) return errors.push(`${at}: ${name} is for another party`)
    const key = `${id}#${l.itemId}`
    if (!pending.has(key)) return errors.push(`${at}: ${name} has no such item`)
    wanted.set(key, (wanted.get(key) ?? 0) + Math.abs(l.qty))
  })
  for (const [key, qty] of wanted) {
    const p = pending.get(key)!
    if (qty > p.pending) errors.push(`${p.item}: ${p.type} No. ${p.number} has ${p.pending / 1000} pending, not ${qty / 1000}`)
  }
  return errors
}

/** What other vouchers have delivered or invoiced against an order or note, item by item. */
export async function madeAgainst(db: Db, id: number) {
  const { rows } = await db.query<{ itemId: number; item: string; qty: number; against: string }>(
    `SELECT i.item_id "itemId", s.name item, SUM(abs(i.qty))::bigint qty, MIN(v.type || ' No. ' || COALESCE(v.doc_no, v.number::text)) against
       FROM inventory_entries i JOIN stock_items s ON s.id = i.item_id JOIN vouchers v ON v.id = i.voucher_id
      WHERE (i.order_id = $1 OR i.tracking_id = $1) AND i.voucher_id <> $1 GROUP BY i.item_id, s.name`,
    [id],
  )
  return rows.map((r) => ({ ...r, qty: Number(r.qty) }))
}

// ------------------------------------------------------------------ valuation

export interface ItemSummary extends ItemPosition {
  id: number
  name: string
  groupId: number | null
  unit: string // the unit quantities are counted in (a compound unit's second unit)
  decimals: number
  perUnit: string | null // a compound unit's first unit ("Box" of "Box of 12 Nos")
  conversion: number | null
}

/**
 * Every stock item's position for [from, to] at average cost. Movements before `from` are
 * valued first (from the books' beginning), so the period opens at the right value.
 */
export async function stockPositions(db: Db, companyId: number, from: string, to: string, self?: number): Promise<ItemSummary[]> {
  const { rows } = await db.query<{
    id: number; name: string; groupId: number | null; unit: string; decimals: number; perUnit: string | null; conversion: number | null
    openingQty: number; openingValue: number
    inQb: number; inVb: number; outQb: number; inQ: number; inV: number; outQ: number
  }>(
    `SELECT s.id, s.name, s.group_id "groupId", COALESCE(su.symbol, u.symbol) unit, u.decimals, fu.symbol "perUnit", u.conversion,
            s.opening_qty "openingQty", s.opening_value "openingValue",
            COALESCE(SUM(i.qty) FILTER (WHERE v.date < $2 AND i.qty > 0), 0)::bigint "inQb",
            COALESCE(SUM(i.amount) FILTER (WHERE v.date < $2 AND i.qty > 0), 0)::bigint "inVb",
            COALESCE(-SUM(i.qty) FILTER (WHERE v.date < $2 AND i.qty < 0), 0)::bigint "outQb",
            COALESCE(SUM(i.qty) FILTER (WHERE v.date BETWEEN $2 AND $3 AND i.qty > 0), 0)::bigint "inQ",
            COALESCE(SUM(i.amount) FILTER (WHERE v.date BETWEEN $2 AND $3 AND i.qty > 0), 0)::bigint "inV",
            COALESCE(-SUM(i.qty) FILTER (WHERE v.date BETWEEN $2 AND $3 AND i.qty < 0), 0)::bigint "outQ"
       FROM stock_items s JOIN units u ON u.id = s.unit_id LEFT JOIN units su ON su.id = u.second_unit_id LEFT JOIN units fu ON fu.id = u.first_unit_id
       LEFT JOIN inventory_entries i ON i.item_id = s.id AND i.moves_stock AND i.voucher_id IS DISTINCT FROM $4::int
       LEFT JOIN vouchers v ON v.id = i.voucher_id
      WHERE s.company_id = $1
      GROUP BY s.id, u.id, su.id, fu.id ORDER BY s.name`,
    [companyId, from, to, self ?? null],
  )
  return rows.map((r) => {
    const before = averageCost({ openingQty: r.openingQty, openingValue: r.openingValue, inQty: r.inQb, inValue: r.inVb, outQty: r.outQb })
    const period = averageCost(
      { openingQty: before.closingQty, openingValue: before.closingValue, inQty: r.inQ, inValue: r.inV, outQty: r.outQ },
      before.rate,
    )
    return { id: r.id, name: r.name, groupId: r.groupId, unit: r.unit, decimals: r.decimals, perUnit: r.perUnit, conversion: r.conversion, ...period }
  })
}

/** Total stock value: at the books' beginning, at the start of the period, and at its end. */
export async function stockTotals(db: Db, companyId: number, from: string, to: string) {
  const items = await stockPositions(db, companyId, from, to)
  if (!items.length) return null
  const { rows } = await db.query<{ v: number }>(`SELECT COALESCE(SUM(opening_value), 0)::bigint v FROM stock_items WHERE company_id = $1`, [companyId])
  return {
    booksBegin: rows[0].v,
    opening: items.reduce((t, i) => t + i.openingValue, 0),
    closing: items.reduce((t, i) => t + i.closingValue, 0),
  }
}
