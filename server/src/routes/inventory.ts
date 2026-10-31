import type { Router, Request } from 'express'
import { z } from 'zod'
import { TAXABILITY } from '../engine/gst'
import { pool } from '../db'
import {
  alterGodown, alterStockGroup, alterStockItem, alterUnit, createGodown, createStockGroup, createStockItem, createUnit,
  deleteGodown, deleteStockGroup, deleteStockItem, deleteUnit, pendingLines, stockPositions,
} from '../inventory'
import { valueOf } from '../engine/inventory'
import { AGE_BRACKETS, ageStock, reorderStatus, type Inward } from '../engine/stock-analysis'

type Period = { from: string; to: string }
const id = z.number().int()
const unitBody = z.object({
  symbol: z.string().trim().default(''),
  name: z.string().optional(),
  decimals: z.number().int().optional(),
  firstUnitId: id.nullish(),
  conversion: z.number().int().nullish(),
  secondUnitId: id.nullish(),
  uqc: z.string().trim().toUpperCase().nullish(),
})
const treeBody = z.object({ name: z.string().trim().min(1), parentId: id.nullish(), thirdParty: z.enum(['ours', 'theirs']).nullish() })
const itemBody = z.object({
  name: z.string().trim().min(1),
  groupId: id.nullish(),
  unitId: id,
  openingQty: z.number().int().optional(),
  openingValue: z.number().int().optional(),
  openingGodownId: id.nullish(),
  hsn: z.string().nullish(),
  gstRate: z.number().int().nullish(),
  cessRate: z.number().int().nullish(),
  reorderLevel: z.number().int().nullish(),
  minOrderQty: z.number().int().nullish(),
  categoryId: id.nullish(),
  gstClassificationId: id.nullish(),
  taxability: z.enum(TAXABILITY).nullish(),
  batches: z.boolean().optional(),
})

export function addInventoryRoutes(company: Router, cid: (req: Request) => number, period: (req: Request) => Promise<Period>) {
  const crud = (
    path: string,
    list: string,
    create: (c: number, b: never) => Promise<number>,
    alter: (c: number, i: number, b: never) => Promise<void>,
    remove: (c: number, i: number) => Promise<void>,
    body: z.ZodTypeAny,
  ) => {
    company.get(path, async (req, res) => res.json((await pool.query(list, [cid(req)])).rows))
    company.post(path, async (req, res) => res.status(201).json({ id: await create(cid(req), body.parse(req.body) as never) }))
    company.put(`${path}/:id`, async (req, res) => {
      await alter(cid(req), Number(req.params.id), body.parse(req.body) as never)
      res.status(204).end()
    })
    company.delete(`${path}/:id`, async (req, res) => {
      await remove(cid(req), Number(req.params.id))
      res.status(204).end()
    })
  }
  crud('/units', `SELECT id, symbol, name, decimals, first_unit_id "firstUnitId", second_unit_id "secondUnitId", conversion, uqc FROM units WHERE company_id = $1 ORDER BY symbol`,
    createUnit, alterUnit, deleteUnit, unitBody)
  crud('/stock-groups', `SELECT id, name, parent_id "parentId" FROM stock_groups WHERE company_id = $1 ORDER BY name`,
    createStockGroup, alterStockGroup, deleteStockGroup, treeBody)
  crud('/godowns', `SELECT id, name, parent_id "parentId", is_default "isDefault", third_party "thirdParty" FROM godowns WHERE company_id = $1 ORDER BY is_default DESC, name`,
    createGodown, alterGodown, deleteGodown, treeBody)
  crud(
    '/stock-items',
    `SELECT s.id, s.name, s.group_id "groupId", g.name "group", s.unit_id "unitId", COALESCE(su.symbol, u.symbol) unit, u.decimals,
            fu.symbol "perUnit", u.conversion,
            s.opening_qty "openingQty", s.opening_value "openingValue", s.opening_godown_id "openingGodownId", s.hsn, s.gst_rate "gstRate", s.cess_rate "cessRate",
            s.reorder_level "reorderLevel", s.min_order_qty "minOrderQty", s.category_id "categoryId",
            s.gst_classification_id "gstClassificationId", COALESCE(s.taxability, 'Taxable') taxability, s.batches
       FROM stock_items s JOIN units u ON u.id = s.unit_id LEFT JOIN units su ON su.id = u.second_unit_id LEFT JOIN units fu ON fu.id = u.first_unit_id
       LEFT JOIN stock_groups g ON g.id = s.group_id
      WHERE s.company_id = $1 ORDER BY s.name`,
    createStockItem, alterStockItem, deleteStockItem, itemBody,
  )

  /** Stock Summary: every item at average cost, grouped (?groupId= for one group's contents). */
  company.get('/reports/stock-summary', async (req, res) => {
    const p = await period(req)
    const items = await stockPositions(pool, cid(req), p.from, p.to)
    const groups = (await pool.query<{ id: number; name: string; parentId: number | null }>(
      `SELECT id, name, parent_id "parentId" FROM stock_groups WHERE company_id = $1`, [cid(req)],
    )).rows
    const godownQty = (await pool.query<{ itemId: number; godown: string; qty: number }>(
      `SELECT x.item_id "itemId", g.name godown, SUM(x.qty)::bigint qty FROM (
         SELECT s.id item_id, s.opening_godown_id godown_id, s.opening_qty qty FROM stock_items s WHERE s.company_id = $1 AND s.opening_qty <> 0
         UNION ALL SELECT i.item_id, i.godown_id, i.qty FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id
          WHERE v.company_id = $1 AND v.date <= $2 AND i.moves_stock) x JOIN godowns g ON g.id = x.godown_id
        GROUP BY x.item_id, g.name HAVING SUM(x.qty) <> 0 ORDER BY g.name`,
      [cid(req), p.to],
    )).rows
    const parent = req.query.groupId ? Number(req.query.groupId) : null
    // the direct child of `parent` an item belongs under (or the item itself)
    const under = (gid: number | null): number | null => {
      let g = groups.find((x) => x.id === gid)
      while (g && g.parentId !== parent) g = groups.find((x) => x.id === g!.parentId)
      return g && g.parentId === parent ? g.id : null
    }
    const inScope = (gid: number | null) => parent === null || gid === parent || under(gid) !== null
    const lines: { kind: 'group' | 'item'; id: number; name: string; unit?: string; decimals?: number; openingQty?: number; openingValue: number;
      inQty?: number; inValue: number; outQty?: number; outValue: number; closingQty?: number; closingValue: number; rate?: number; godowns?: unknown[] }[] = []
    for (const it of items.filter((i) => inScope(i.groupId))) {
      const g = it.groupId === parent ? null : under(it.groupId)
      if (g === null)
        lines.push({ kind: 'item', ...it, godowns: godownQty.filter((x) => x.itemId === it.id).map(({ godown, qty }) => ({ godown, qty })) })
      else {
        let line = lines.find((l) => l.kind === 'group' && l.id === g)
        if (!line) lines.push((line = { kind: 'group', id: g, name: groups.find((x) => x.id === g)!.name, openingValue: 0, inValue: 0, outValue: 0, closingValue: 0 }))
        line.openingValue += it.openingValue
        line.inValue += it.inValue
        line.outValue += it.outValue
        line.closingValue += it.closingValue
      }
    }
    lines.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'group' ? -1 : 1))
    const sum = (k: 'openingValue' | 'inValue' | 'outValue' | 'closingValue') => lines.reduce((t, l) => t + l[k], 0)
    res.json({
      ...p,
      group: parent === null ? null : groups.find((g) => g.id === parent) ?? null,
      lines,
      total: { openingValue: sum('openingValue'), inValue: sum('inValue'), outValue: sum('outValue'), closingValue: sum('closingValue') },
      negative: items.filter((i) => i.closingQty < 0).map((i) => i.name),
    })
  })

  /** Stock Item Vouchers: an item's movements in the period with a running quantity. */
  company.get('/stock-items/:id/vouchers', async (req, res) => {
    const p = await period(req)
    const itemId = Number(req.params.id)
    const pos = (await stockPositions(pool, cid(req), p.from, p.to)).find((i) => i.id === itemId)
    if (!pos) return res.status(404).json({ error: 'Not found' })
    const { rows } = await pool.query(
      `SELECT v.id "voucherId", v.type, v.number, COALESCE(v.doc_no, v.number::text) "docNo", to_char(v.date,'YYYY-MM-DD') date, g.name godown, i.qty, i.rate, i.amount,
              COALESCE((SELECT name FROM ledgers WHERE id = v.party_ledger_id),
                       (SELECT l.name FROM entries e JOIN ledgers l ON l.id = e.ledger_id WHERE e.voucher_id = v.id ORDER BY e.line LIMIT 1), '') party
         FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id JOIN godowns g ON g.id = i.godown_id
        WHERE i.item_id = $1 AND v.company_id = $2 AND v.date BETWEEN $3 AND $4 AND i.moves_stock ORDER BY v.date, v.id, i.line`,
      [itemId, cid(req), p.from, p.to],
    )
    let running = pos.openingQty
    res.json({ item: { id: pos.id, name: pos.name, unit: pos.unit, decimals: pos.decimals, perUnit: pos.perUnit, conversion: pos.conversion }, ...p, position: pos,
      lines: rows.map((r) => ({ ...r, balance: (running += r.qty) })) })
  })

  /** Each item's average cost and quantity in hand for the period: the starting rate for lines that move stock out. */
  company.get('/reports/stock-rates', async (req, res) => {
    const p = await period(req)
    res.json((await stockPositions(pool, cid(req), p.from, p.to)).map((i) => ({ id: i.id, rate: i.rate, closingQty: i.closingQty })))
  })

  /** Godown Summary: what each godown holds at the end of the period, valued at the items' average cost. */
  company.get('/reports/godown-summary', async (req, res) => {
    const p = await period(req)
    const items = new Map((await stockPositions(pool, cid(req), p.from, p.to)).map((i) => [i.id, i]))
    const godowns = (await pool.query<{ id: number; name: string; parentId: number | null }>(
      `SELECT id, name, parent_id "parentId" FROM godowns WHERE company_id = $1 ORDER BY is_default DESC, name`, [cid(req)],
    )).rows
    const { rows } = await pool.query<{ godownId: number; itemId: number; qty: number }>(
      `SELECT godown_id "godownId", item_id "itemId", SUM(qty)::bigint qty FROM (
         SELECT opening_godown_id godown_id, id item_id, opening_qty qty FROM stock_items WHERE company_id = $1 AND opening_qty <> 0
         UNION ALL SELECT i.godown_id, i.item_id, i.qty FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id
          WHERE v.company_id = $1 AND v.date <= $2 AND i.moves_stock) x
        GROUP BY 1, 2 HAVING SUM(qty) <> 0`,
      [cid(req), p.to],
    )
    const out = godowns.map((g) => {
      const held = rows
        .filter((r) => r.godownId === g.id)
        .map((r) => {
          const it = items.get(r.itemId)!
          const qty = Number(r.qty)
          return { id: it.id, name: it.name, unit: it.unit, decimals: it.decimals, qty, rate: it.rate, value: valueOf(qty, it.rate) }
        })
        .sort((a, b) => a.name.localeCompare(b.name))
      return { ...g, items: held, value: held.reduce((t, i) => t + i.value, 0) }
    })
    res.json({ ...p, godowns: out, total: out.reduce((t, g) => t + g.value, 0) })
  })

  /**
   * Orders and notes still pending: Sales/Purchase Orders not yet delivered or received, and
   * Delivery/Receipt Notes not yet invoiced (Tally's Order Outstandings and Sales/Purchase Bills
   * Pending). ?partyId= for one party; ?asOf= for the vouchers dated up to then.
   */
  company.get('/reports/pending', async (req, res) => {
    const type = z.enum(['Sales Order', 'Purchase Order', 'Delivery Note', 'Receipt Note']).parse(req.query.type)
    const partyId = req.query.partyId ? Number(req.query.partyId) : undefined
    const asOf = req.query.asOf ? z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(req.query.asOf) : undefined
    const self = req.query.excludeVoucher ? Number(req.query.excludeVoucher) : undefined
    const lines = await pendingLines(pool, cid(req), { type, partyId, asOf, self })
    const on = asOf ?? new Date().toISOString().slice(0, 10)
    const day = (d: string) => Date.parse(d + 'T00:00:00Z') / 86_400_000
    res.json({
      type,
      asOf: on,
      lines: lines.map((l) => ({ ...l, value: valueOf(l.pending, l.rate), overdueDays: l.dueDate && l.dueDate < on ? day(on) - day(l.dueDate) : 0 })),
    })
  })

  /** Stock Ageing Analysis: each item's stock in hand by how long ago it came in (?brackets=45,90,180). */
  company.get('/reports/stock-ageing', async (req, res) => {
    const p = await period(req)
    const brackets = req.query.brackets
      ? z.array(z.coerce.number().int().positive()).min(1).parse(String(req.query.brackets).split(',')).sort((a, b) => a - b)
      : AGE_BRACKETS
    const items = (await stockPositions(pool, cid(req), p.from, p.to)).filter((i) => i.closingQty > 0)
    const { rows } = await pool.query<Inward & { itemId: number }>(
      `SELECT s.id "itemId", to_char(c.books_begin, 'YYYY-MM-DD') date, s.opening_qty qty, s.opening_value amount
         FROM stock_items s JOIN companies c ON c.id = s.company_id WHERE s.company_id = $1 AND s.opening_qty > 0
       UNION ALL
       SELECT i.item_id, to_char(v.date, 'YYYY-MM-DD'), i.qty, i.amount
         FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id
        WHERE v.company_id = $1 AND v.date <= $2 AND i.moves_stock AND i.qty > 0
          AND NOT EXISTS (SELECT 1 FROM inventory_entries o WHERE o.voucher_id = i.voucher_id AND o.item_id = i.item_id AND o.qty < 0)`,
      [cid(req), p.to],
    )
    const lines = items.map((it) => ({
      id: it.id, name: it.name, unit: it.unit, decimals: it.decimals, perUnit: it.perUnit, conversion: it.conversion, closingQty: it.closingQty, closingValue: it.closingValue,
      buckets: ageStock(rows.filter((r) => r.itemId === it.id), it.closingQty, p.to, brackets, it.closingValue),
    }))
    const labels = lines[0]?.buckets.map((b) => b.label) ?? ageStock([], 0, p.to, brackets).map((b) => b.label)
    res.json({ ...p, labels, lines, totals: labels.map((_, k) => lines.reduce((t, l) => t + l.buckets[k].value, 0)) })
  })

  /**
   * Movement Analysis: what came in and went out in the period, item by item; with ?itemId=, one
   * item's movement party by party with the average rate. Transfers between godowns are not movement.
   */
  company.get('/reports/movement', async (req, res) => {
    const p = await period(req)
    const itemId = req.query.itemId ? Number(req.query.itemId) : null
    const { rows } = await pool.query<{ itemId: number; item: string; unit: string; decimals: number; party: string; inQty: number; inValue: number; outQty: number; outValue: number }>(
      `SELECT i.item_id "itemId", s.name item, COALESCE(su.symbol, u.symbol) unit, u.decimals,
              COALESCE((SELECT name FROM ledgers WHERE id = v.party_ledger_id),
                       (SELECT l.name FROM entries e JOIN ledgers l ON l.id = e.ledger_id WHERE e.voucher_id = v.id ORDER BY e.line LIMIT 1), v.type) party,
              COALESCE(SUM(i.qty) FILTER (WHERE i.qty > 0), 0)::bigint "inQty", COALESCE(SUM(abs(i.amount)) FILTER (WHERE i.qty > 0), 0)::bigint "inValue",
              COALESCE(-SUM(i.qty) FILTER (WHERE i.qty < 0), 0)::bigint "outQty", COALESCE(SUM(abs(i.amount)) FILTER (WHERE i.qty < 0), 0)::bigint "outValue"
         FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id JOIN stock_items s ON s.id = i.item_id JOIN units u ON u.id = s.unit_id
         LEFT JOIN units su ON su.id = u.second_unit_id
        WHERE v.company_id = $1 AND v.date BETWEEN $2 AND $3 AND i.moves_stock AND ($4::int IS NULL OR i.item_id = $4)
          AND NOT EXISTS (SELECT 1 FROM inventory_entries o WHERE o.voucher_id = i.voucher_id AND o.item_id = i.item_id AND sign(o.qty) = -sign(i.qty))
        GROUP BY i.item_id, s.name, su.symbol, u.symbol, u.decimals, 5
        ORDER BY s.name, 5`,
      [cid(req), p.from, p.to, itemId],
    )
    const rate = (value: number, qty: number) => (qty ? Math.round((value * 1000) / qty) : 0) // paise per unit
    if (itemId !== null) {
      const item = (await pool.query(`SELECT s.id, s.name FROM stock_items s WHERE s.id = $1 AND s.company_id = $2`, [itemId, cid(req)])).rows[0]
      if (!item) return res.status(404).json({ error: 'Not found' })
      const side = (k: 'in' | 'out') =>
        rows.filter((r) => r[`${k}Qty`]).map((r) => ({ party: r.party, qty: r[`${k}Qty`], value: r[`${k}Value`], rate: rate(r[`${k}Value`], r[`${k}Qty`]) }))
      return res.json({ ...p, item: { ...item, unit: rows[0]?.unit ?? '', decimals: rows[0]?.decimals ?? 0 }, inward: side('in'), outward: side('out') })
    }
    const byItem = new Map<number, { id: number; name: string; unit: string; decimals: number; inQty: number; inValue: number; outQty: number; outValue: number }>()
    for (const r of rows) {
      const x = byItem.get(r.itemId) ?? { id: r.itemId, name: r.item, unit: r.unit, decimals: r.decimals, inQty: 0, inValue: 0, outQty: 0, outValue: 0 }
      x.inQty += r.inQty
      x.inValue += r.inValue
      x.outQty += r.outQty
      x.outValue += r.outValue
      byItem.set(r.itemId, x)
    }
    res.json({ ...p, items: [...byItem.values()].map((x) => ({ ...x, inRate: rate(x.inValue, x.inQty), outRate: rate(x.outValue, x.outQty) })) })
  })

  /** Reorder Status: items with a reorder level, what is in hand and on order against it, and what to order. */
  company.get('/reports/reorder', async (req, res) => {
    const p = await period(req)
    const levels = (await pool.query<{ id: number; reorderLevel: number; minOrderQty: number | null }>(
      `SELECT id, reorder_level "reorderLevel", min_order_qty "minOrderQty" FROM stock_items WHERE company_id = $1 AND reorder_level IS NOT NULL`,
      [cid(req)],
    )).rows
    const items = await stockPositions(pool, cid(req), p.from, p.to)
    const pending = async (type: 'Purchase Order' | 'Sales Order') => {
      const m = new Map<number, number>()
      for (const l of await pendingLines(pool, cid(req), { type, asOf: p.to })) m.set(l.itemId, (m.get(l.itemId) ?? 0) + l.pending)
      return m
    }
    const po = await pending('Purchase Order')
    const so = await pending('Sales Order')
    const lines = levels
      .map((l) => {
        const it = items.find((i) => i.id === l.id)!
        const x = { closingQty: it.closingQty, reorderLevel: l.reorderLevel, minOrderQty: l.minOrderQty, purchaseOrders: po.get(l.id) ?? 0, salesOrders: so.get(l.id) ?? 0 }
        return { id: it.id, name: it.name, unit: it.unit, decimals: it.decimals, perUnit: it.perUnit, conversion: it.conversion, ...x, ...reorderStatus(x) }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
    res.json({ ...p, lines })
  })
}
