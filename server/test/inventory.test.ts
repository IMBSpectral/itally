import { test } from 'node:test'
import assert from 'node:assert/strict'
import { averageCost, formatQty, toMilli, validateInventory, valueOf } from '../src/engine/inventory'
import { DEFAULT_GROUPS, type GroupNode } from '../src/engine/groups'

test('quantities: thousandths, exact, Indian grouping', () => {
  assert.equal(toMilli('2.5'), 2500)
  assert.equal(toMilli('1,250.125'), 1250125)
  assert.equal(toMilli(3), 3000)
  assert.throws(() => toMilli('1.2345'))
  assert.equal(formatQty(1250500, 1), '1,250.5')
  assert.equal(formatQty(12345678000), '1,23,45,678')
  assert.equal(formatQty(-2000), '-2')
  assert.equal(valueOf(2500, 4000), 10000) // 2.5 units at ₹40 = ₹100
})

test('average cost: opening plus inwards, closing and outwards at the average rate', () => {
  // 10 at ₹100 opening, 30 bought at ₹120 → average ₹115; 25 sold → 15 left worth ₹1,725
  const p = averageCost({ openingQty: 10000, openingValue: 100000, inQty: 30000, inValue: 360000, outQty: 25000 })
  assert.equal(p.rate, 11500)
  assert.equal(p.closingQty, 15000)
  assert.equal(p.closingValue, 172500)
  assert.equal(p.outValue, 287500)
  // nothing to average: falls back
  assert.equal(averageCost({ openingQty: 0, openingValue: 0, inQty: 0, inValue: 0, outQty: 2000 }, 5000).closingValue, -10000)
})

function ctx() {
  const groups = new Map<number, GroupNode>()
  const ids = new Map<string, number>()
  DEFAULT_GROUPS.forEach((g, i) => ids.set(g.name, i + 1))
  DEFAULT_GROUPS.forEach((g, i) =>
    groups.set(i + 1, { id: i + 1, name: g.name, parentId: g.parent ? ids.get(g.parent)! : null, nature: g.nature, affectsGrossProfit: g.affectsGrossProfit }),
  )
  const ledgers = new Map([
    [1, { id: 1, name: 'Party', groupId: ids.get('Sundry Debtors')! }],
    [2, { id: 2, name: 'Sales', groupId: ids.get('Sales Accounts')! }],
    [3, { id: 3, name: 'Freight', groupId: ids.get('Indirect Incomes')! }],
  ])
  return {
    items: new Map([[1, { id: 1, name: 'Rice', decimals: 2 }], [2, { id: 2, name: 'Bags', decimals: 0 }]]),
    godowns: new Set([7]),
    ledgers,
    groups,
  }
}

test('item invoice rules: direction, unit precision, and items matching the sales ledger', () => {
  const c = ctx()
  const sale = (inventory: { itemId: number; godownId: number; qty: number; rate: number; amount: number }[], salesAmount: number) => ({
    type: 'Sales' as const,
    date: '2026-04-10',
    entries: [{ ledgerId: 1, amount: -salesAmount + 5000 }, { ledgerId: 2, amount: salesAmount }, { ledgerId: 3, amount: -5000 }],
    inventory,
  })
  // 2.5 kg rice at ₹40 + 3 bags at ₹10 = ₹130, booked to Sales (freight is a separate ledger)
  const ok = sale([{ itemId: 1, godownId: 7, qty: -2500, rate: 4000, amount: -10000 }, { itemId: 2, godownId: 7, qty: -3000, rate: 1000, amount: -3000 }], -13000)
  assert.deepEqual(validateInventory(ok, c), [])
  const has = (errs: string[], re: RegExp) => assert.ok(errs.some((e) => re.test(e)), errs.join(' | '))
  has(validateInventory(sale([{ itemId: 1, godownId: 7, qty: 2500, rate: 4000, amount: 10000 }], -10000), c), /moves stock out/)
  has(validateInventory(sale([{ itemId: 2, godownId: 7, qty: -2500, rate: 1000, amount: -2500 }], -2500), c), /allows 0 decimal places/)
  has(validateInventory(sale([{ itemId: 1, godownId: 7, qty: -1000, rate: 4000, amount: -4000 }], -5000), c), /items total 40, but the Sales Accounts ledgers carry 50/)
  has(validateInventory(sale([{ itemId: 9, godownId: 7, qty: -1000, rate: 1, amount: -1 }], -1), c), /unknown stock item/)
  has(validateInventory(sale([{ itemId: 1, godownId: 8, qty: -1000, rate: 1, amount: -1 }], -1), c), /unknown godown/)
  has(validateInventory({ type: 'Journal', date: '2026-04-10', entries: [], inventory: [{ itemId: 1, godownId: 7, qty: 1000, rate: 1, amount: 1 }] }, c), /cannot carry stock/)
})
