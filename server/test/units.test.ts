import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createCompany } from '../src/books'
import { alterUnit, createStockItem, createUnit, deleteUnit, stockPositions } from '../src/inventory'
import { formatCompound, parseCompound } from '../src/engine/inventory'
import { backupCompany, restoreCompany } from '../src/backup'

before(() => migrate(() => {}))
after(() => pool.end())

test('compound quantities read and write as "2 Box 5 Nos"', () => {
  const box = { perUnit: 'Box', conversion: 12, unit: 'Nos' }
  assert.equal(formatCompound(29000, box), '2 Box 5 Nos')
  assert.equal(formatCompound(24000, box), '2 Box')
  assert.equal(formatCompound(5000, box), '5 Nos')
  assert.equal(formatCompound(-29000, box), '-2 Box 5 Nos')
  assert.equal(formatCompound(1500, { perUnit: 'Bag', conversion: 50, unit: 'Kg' }, 1), '1.5 Kg')
  assert.deepEqual([parseCompound('2-5', box), parseCompound('2', box), parseCompound('-5', box), parseCompound('1,000', box)], [29000, 24000, 5000, 12000000])
  assert.throws(() => parseCompound('2-12', box), /under 12/)
  assert.throws(() => parseCompound('box', box), /Invalid quantity/)
})

test('compound units: made of two simple units, named after them; parts stay while used', async () => {
  const companyId = await createCompany({ name: `Units ${Date.now()}`, booksBegin: '2026-04-01' })
  const box = await createUnit(companyId, { symbol: 'Box' })
  const nos = await createUnit(companyId, { symbol: 'Nos' })
  const kg = await createUnit(companyId, { symbol: 'Kg', decimals: 2 })
  const boxOf12 = await createUnit(companyId, { symbol: '', firstUnitId: box, conversion: 12, secondUnitId: nos })
  const { rows } = await pool.query(`SELECT symbol, decimals FROM units WHERE id = $1`, [boxOf12])
  assert.deepEqual(rows[0], { symbol: 'Box of 12 Nos', decimals: 0 })
  await assert.rejects(createUnit(companyId, { symbol: '', firstUnitId: box, conversion: 1, secondUnitId: nos }), /2 or more/)
  await assert.rejects(createUnit(companyId, { symbol: '', firstUnitId: box, conversion: 12, secondUnitId: box }), /two different/)
  await assert.rejects(createUnit(companyId, { symbol: '', firstUnitId: boxOf12, conversion: 4, secondUnitId: nos }), /made of simple units/)
  await assert.rejects(deleteUnit(companyId, nos), /part of a compound unit/)
  const bagOf50 = await createUnit(companyId, { symbol: '', firstUnitId: box, conversion: 50, secondUnitId: kg })
  assert.equal((await pool.query(`SELECT decimals FROM units WHERE id = $1`, [bagOf50])).rows[0].decimals, 2, 'decimals of the second unit')

  // renaming a part renames the compound
  await alterUnit(companyId, box, { symbol: 'Carton' })
  assert.equal((await pool.query(`SELECT symbol FROM units WHERE id = $1`, [boxOf12])).rows[0].symbol, 'Carton of 12 Nos')

  // an item in "Carton of 12 Nos": quantities in Nos, reported with the carton
  const pens = await createStockItem(companyId, { name: 'Pens', unitId: boxOf12, openingQty: 29000, openingValue: 29000 })
  const [p] = await stockPositions(pool, companyId, '2026-04-01', '2027-03-31')
  assert.deepEqual([p.id, p.unit, p.perUnit, p.conversion, p.closingQty], [pens, 'Nos', 'Carton', 12, 29000])
  await assert.rejects(alterUnit(companyId, boxOf12, { symbol: '', firstUnitId: box, conversion: 10, secondUnitId: nos }), /second unit and conversion stay/)
  await assert.rejects(alterUnit(companyId, boxOf12, { symbol: 'Box' }), /between simple and compound/)

  const restored = await restoreCompany((await backupCompany(companyId)).file)
  const [r] = await stockPositions(pool, restored.id, '2026-04-01', '2027-03-31')
  assert.deepEqual([r.unit, r.perUnit, r.conversion, r.closingQty], ['Nos', 'Carton', 12, 29000])
})
