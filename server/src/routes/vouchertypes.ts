import type { Router, Request } from 'express'
import { z } from 'zod'
import { pool } from '../db'
import { stockPositions } from '../inventory'
import {
  alterStockCategory, alterVoucherType, createStockCategory, createVoucherType, deleteStockCategory, deleteVoucherType, FEATURES, getFeatures, listVoucherTypes,
  setFeatures,
} from '../vouchertypes'
import { VOUCHER_TYPES } from '../engine/voucher'

type Period = { from: string; to: string }
const voucherType = z.object({
  name: z.string(),
  baseType: z.enum(VOUCHER_TYPES),
  abbreviation: z.string().optional(),
  numbering: z.enum(['auto', 'manual']).default('auto'),
  prefix: z.string().default(''),
  suffix: z.string().default(''),
  width: z.number().int().default(0),
  startNumber: z.number().int().default(1),
  restartYearly: z.boolean().default(false),
  printTitle: z.string().nullish(),
  pos: z.boolean().optional(),
  gstRegistrationId: z.number().int().nullish(),
  active: z.boolean().optional(),
})
const category = z.object({ name: z.string(), parentId: z.number().int().nullish() })

/** Voucher Types, F11 features, stock categories with their summary, and Stock Query. */
export function addVoucherTypeRoutes(company: Router, cid: (req: Request) => number, period: (req: Request) => Promise<Period>) {
  company.get('/voucher-types', async (req, res) => res.json(await listVoucherTypes(cid(req))))
  company.post('/voucher-types', async (req, res) => res.status(201).json({ id: await createVoucherType(cid(req), voucherType.parse(req.body)) }))
  company.put('/voucher-types/:id', async (req, res) => {
    await alterVoucherType(cid(req), Number(req.params.id), voucherType.parse(req.body))
    res.status(204).end()
  })
  company.delete('/voucher-types/:id', async (req, res) => {
    await deleteVoucherType(cid(req), Number(req.params.id))
    res.status(204).end()
  })

  company.get('/features', async (req, res) => res.json({ features: await getFeatures(cid(req)), labels: FEATURES }))
  company.put('/features', async (req, res) => {
    await setFeatures(cid(req), z.record(z.string(), z.boolean()).parse(req.body))
    res.status(204).end()
  })

  company.get('/stock-categories', async (req, res) =>
    res.json((await pool.query(`SELECT id, name, parent_id "parentId" FROM stock_categories WHERE company_id = $1 ORDER BY lower(name)`, [cid(req)])).rows))
  company.post('/stock-categories', async (req, res) => res.status(201).json({ id: await createStockCategory(cid(req), category.parse(req.body)) }))
  company.put('/stock-categories/:id', async (req, res) => {
    await alterStockCategory(cid(req), Number(req.params.id), category.parse(req.body))
    res.status(204).end()
  })
  company.delete('/stock-categories/:id', async (req, res) => {
    await deleteStockCategory(cid(req), Number(req.params.id))
    res.status(204).end()
  })

  /** Stock Category Summary: items by category (?categoryId= for one category's contents), at average cost. */
  company.get('/reports/stock-category-summary', async (req, res) => {
    const p = await period(req)
    const cats = (await pool.query<{ id: number; name: string; parentId: number | null }>(
      `SELECT id, name, parent_id "parentId" FROM stock_categories WHERE company_id = $1`, [cid(req)],
    )).rows
    const itemCat = new Map((await pool.query<{ id: number; categoryId: number | null }>(
      `SELECT id, category_id "categoryId" FROM stock_items WHERE company_id = $1`, [cid(req)],
    )).rows.map((r) => [r.id, r.categoryId]))
    const parent = req.query.categoryId ? Number(req.query.categoryId) : null
    // the child of `parent` a category sits under (itself, if it is one); null: directly in `parent`; undefined: elsewhere
    const childOf = (catId: number | null): number | null | undefined => {
      if (catId === parent) return null
      let c = cats.find((x) => x.id === catId)
      while (c && c.parentId !== parent) c = cats.find((x) => x.id === c!.parentId)
      return c ? c.id : undefined
    }
    type Line = { kind: 'category' | 'item'; id: number; name: string; unit?: string; decimals?: number; closingQty?: number
      openingValue: number; inValue: number; outValue: number; closingValue: number }
    const lines = new Map<string, Line>()
    for (const it of await stockPositions(pool, cid(req), p.from, p.to)) {
      const under = childOf(itemCat.get(it.id) ?? null)
      if (under === undefined) continue
      const key = under === null ? `i${it.id}` : `c${under}`
      const line: Line = lines.get(key) ?? (under === null
        ? { kind: 'item', id: it.id, name: it.name, unit: it.unit, decimals: it.decimals, closingQty: it.closingQty, openingValue: 0, inValue: 0, outValue: 0, closingValue: 0 }
        : { kind: 'category', id: under, name: cats.find((c) => c.id === under)!.name, openingValue: 0, inValue: 0, outValue: 0, closingValue: 0 })
      line.openingValue += it.openingValue
      line.inValue += it.inValue
      line.outValue += it.outValue
      line.closingValue += it.closingValue
      lines.set(key, line)
    }
    const out = [...lines.values()].filter((l) => l.openingValue || l.inValue || l.outValue || l.closingValue || l.closingQty)
    out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'category' ? -1 : 1))
    const sum = (k: 'openingValue' | 'inValue' | 'outValue' | 'closingValue') => out.reduce((t, l) => t + l[k], 0)
    res.json({
      ...p, category: parent === null ? null : (cats.find((c) => c.id === parent) ?? null), lines: out,
      total: { openingValue: sum('openingValue'), inValue: sum('inValue'), outValue: sum('outValue'), closingValue: sum('closingValue') },
    })
  })

  /** Stock Query: one item at a glance: stock by godown, cost, the last purchases and sales, what is on order. */
  company.get('/stock-items/:id/query', async (req, res) => {
    const p = await period(req)
    const itemId = Number(req.params.id)
    const pos = (await stockPositions(pool, cid(req), p.from, p.to)).find((i) => i.id === itemId)
    if (!pos) return res.status(404).json({ error: 'Not found' })
    const info = (await pool.query(
      `SELECT s.hsn, s.gst_rate "gstRate", g.name "group", c.name category, s.reorder_level "reorderLevel" FROM stock_items s
         LEFT JOIN stock_groups g ON g.id = s.group_id LEFT JOIN stock_categories c ON c.id = s.category_id WHERE s.id = $1`,
      [itemId],
    )).rows[0]
    const godowns = (await pool.query(
      `SELECT g.name godown, SUM(x.qty)::bigint qty FROM (
         SELECT opening_godown_id godown_id, opening_qty qty FROM stock_items WHERE id = $1 AND opening_qty <> 0
         UNION ALL SELECT i.godown_id, i.qty FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id WHERE i.item_id = $1 AND i.moves_stock AND v.date <= $2) x
         JOIN godowns g ON g.id = x.godown_id GROUP BY g.name HAVING SUM(x.qty) <> 0 ORDER BY g.name`,
      [itemId, p.to],
    )).rows
    const last = async (types: string[]) => (await pool.query(
      `SELECT v.id "voucherId", v.type, COALESCE(v.doc_no, v.number::text) "docNo", to_char(v.date,'YYYY-MM-DD') date, abs(i.qty)::bigint qty, i.rate,
              COALESCE((SELECT name FROM ledgers WHERE id = v.party_ledger_id),
                       (SELECT l.name FROM entries e JOIN ledgers l ON l.id = e.ledger_id WHERE e.voucher_id = v.id ORDER BY e.line LIMIT 1), '') party
         FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id
        WHERE i.item_id = $1 AND v.type = ANY($2) AND v.date <= $3 AND NOT v.cancelled ORDER BY v.date DESC, v.id DESC LIMIT 5`,
      [itemId, types, p.to],
    )).rows
    // ordered less what has been delivered or received against the orders
    const onOrder = async (type: string) => Number((await pool.query<{ qty: string }>(
      `SELECT (COALESCE((SELECT SUM(abs(i.qty)) FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id
                          WHERE i.item_id = $1 AND v.type = $2 AND NOT v.cancelled AND v.date <= $3), 0)
             - COALESCE((SELECT SUM(abs(d.qty)) FROM inventory_entries d JOIN vouchers o ON o.id = d.order_id
                          WHERE d.item_id = $1 AND o.type = $2 AND NOT o.cancelled), 0))::bigint qty`,
      [itemId, type, p.to],
    )).rows[0].qty)
    res.json({
      ...p, item: pos, ...info, godowns,
      purchases: await last(['Purchase', 'Receipt Note']), sales: await last(['Sales', 'Delivery Note']),
      purchaseOrders: Math.max(await onOrder('Purchase Order'), 0), salesOrders: Math.max(await onOrder('Sales Order'), 0),
    })
  })
}
