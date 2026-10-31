/**
 * GST Classifications: an HSN/SAC with its rate and taxability, defined once and picked on stock
 * items and ledgers. GST reads the classification's details over the master's own, so one change
 * of rate reaches every item under it (posted invoices keep the breakup they were saved with).
 */
import { pool, withTx } from './db'
import { ValidationError } from './books'
import { TAXABILITY, type Taxability } from './engine/gst'

export interface ClassificationInput {
  name: string
  hsn?: string | null
  description?: string | null
  taxability?: Taxability
  gstRate?: number | null // hundredths of a percent
}

export async function listClassifications(companyId: number) {
  return (await pool.query(
    `SELECT c.id, c.name, c.hsn, c.description, c.taxability, c.gst_rate "gstRate",
            (SELECT count(*)::int FROM stock_items s WHERE s.gst_classification_id = c.id)
              + (SELECT count(*)::int FROM ledgers l WHERE l.gst_classification_id = c.id) used
       FROM gst_classifications c WHERE c.company_id = $1 ORDER BY lower(c.name)`,
    [companyId],
  )).rows
}

function check(c: ClassificationInput) {
  const errors: string[] = []
  const taxability = c.taxability ?? 'Taxable'
  if (!c.name.trim()) errors.push('A GST classification needs a name')
  if (!TAXABILITY.includes(taxability)) errors.push('Taxability is Taxable, Exempt, Nil Rated or Non-GST')
  const hsn = c.hsn?.trim()
  if (hsn && !/^[0-9]{4,8}$/.test(hsn)) errors.push(`"${hsn}" is not an HSN/SAC code (4 to 8 digits)`)
  if (c.gstRate != null && (!Number.isInteger(c.gstRate) || c.gstRate < 0 || c.gstRate > 10000)) errors.push('GST rate must be between 0% and 100%')
  if (taxability === 'Taxable' && c.gstRate == null) errors.push('A taxable classification needs its GST rate')
  if (taxability !== 'Taxable' && c.gstRate) errors.push(`An ${taxability === 'Exempt' ? 'exempt' : taxability} supply has no GST rate`)
  if (errors.length) throw new ValidationError(errors)
}
const values = (c: ClassificationInput) => {
  const taxability = c.taxability ?? 'Taxable'
  return [c.name.trim(), c.hsn?.trim() || null, c.description?.trim() || null, taxability, taxability === 'Taxable' ? c.gstRate : null]
}
const taken = (name: string) => (err: { code?: string }) => {
  if (err.code === '23505') throw new ValidationError([`The name "${name}" is already used by another GST classification`])
  throw err
}

export async function createClassification(companyId: number, c: ClassificationInput) {
  check(c)
  const { rows } = await pool
    .query<{ id: number }>(
      `INSERT INTO gst_classifications (company_id, name, hsn, description, taxability, gst_rate) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [companyId, ...values(c)],
    )
    .catch(taken(c.name))
  return rows[0].id
}

export async function alterClassification(companyId: number, id: number, c: ClassificationInput) {
  check(c)
  const { rowCount } = await pool
    .query(`UPDATE gst_classifications SET name = $3, hsn = $4, description = $5, taxability = $6, gst_rate = $7 WHERE id = $1 AND company_id = $2`, [
      id, companyId, ...values(c),
    ])
    .catch(taken(c.name))
  if (!rowCount) throw new ValidationError([`Unknown GST classification ${id}`])
}

export async function deleteClassification(companyId: number, id: number) {
  return withTx(async (tx) => {
    const c = (await tx.query<{ name: string }>(`SELECT name FROM gst_classifications WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, companyId])).rows[0]
    if (!c) throw new ValidationError([`Unknown GST classification ${id}`])
    const used = (await tx.query(
      `SELECT 1 FROM stock_items WHERE gst_classification_id = $1 UNION ALL SELECT 1 FROM ledgers WHERE gst_classification_id = $1 LIMIT 1`, [id],
    )).rowCount
    if (used) throw new ValidationError([`${c.name} is used by stock items or ledgers; pick another classification on them first`])
    await tx.query(`DELETE FROM gst_classifications WHERE id = $1`, [id])
  })
}
