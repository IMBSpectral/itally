/**
 * Voucher Types of the company's own (under a predefined one, with their numbering), company
 * features switched on and off (F11), and stock categories.
 */
import { pool, withTx } from './db'
import { ValidationError } from './books'
import { numberingProblems, type NumberingRule } from './engine/numbering'
import { VOUCHER_TYPES, type VoucherType } from './engine/voucher'

export interface VoucherTypeInput extends NumberingRule {
  name: string
  baseType: VoucherType
  abbreviation?: string
  printTitle?: string | null
  active?: boolean
  pos?: boolean // a Sales type used for POS invoicing (POS Register)
  gstRegistrationId?: number | null // a further GST registration its vouchers are of
}

const COLUMNS = `id, name, base_type "baseType", abbreviation, numbering, prefix, suffix, width, start_number "startNumber",
                 restart_yearly "restartYearly", print_title "printTitle", active, pos, gst_registration_id "gstRegistrationId"`

export async function listVoucherTypes(companyId: number) {
  return (await pool.query(
    `SELECT ${COLUMNS}, (SELECT count(*)::int FROM vouchers v WHERE v.voucher_type_id = t.id) used,
            (SELECT json_object_agg(to_char(c.fy_start, 'YYYY-MM-DD'), c.last) FROM voucher_type_counters c WHERE c.voucher_type_id = t.id) counters FROM voucher_types t WHERE company_id = $1 ORDER BY base_type, lower(name)`,
    [companyId],
  )).rows
}

function check(t: VoucherTypeInput) {
  const errors: string[] = []
  if (!t.name.trim()) errors.push('A voucher type needs a name')
  if ((VOUCHER_TYPES as readonly string[]).some((n) => n.toLowerCase() === t.name.trim().toLowerCase()))
    errors.push(`"${t.name}" is a predefined voucher type; give yours a name of its own (for example "${t.name} - Export")`)
  if (!VOUCHER_TYPES.includes(t.baseType)) errors.push('Choose the type of voucher it is (Sales, Payment …)')
  if (t.pos && t.baseType !== 'Sales') errors.push('POS invoicing is for a Sales voucher type')
  errors.push(...numberingProblems(t))
  if (errors.length) throw new ValidationError(errors)
}
const taken = (name: string) => (err: { code?: string }) => {
  if (err.code === '23505') throw new ValidationError([`The name "${name}" is already used by another voucher type`])
  throw err
}
const values = (t: VoucherTypeInput) => [
  t.name.trim(), t.baseType, t.abbreviation?.trim() ?? '', t.numbering, t.prefix.trim(), t.suffix.trim(), t.width, t.startNumber, t.restartYearly,
  t.printTitle?.trim() || null, t.active ?? true,
]

export async function createVoucherType(companyId: number, t: VoucherTypeInput) {
  check(t)
  const { rows } = await pool
    .query<{ id: number }>(
      `INSERT INTO voucher_types (company_id, name, base_type, abbreviation, numbering, prefix, suffix, width, start_number, restart_yearly, print_title, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [companyId, ...values(t)],
    )
    .catch(taken(t.name))
  if (t.pos) await pool.query(`UPDATE voucher_types SET pos = true WHERE id = $1`, [rows[0].id])
  if (t.gstRegistrationId) await setRegistration(pool, companyId, rows[0].id, t.gstRegistrationId)
  return rows[0].id
}

export async function alterVoucherType(companyId: number, id: number, t: VoucherTypeInput) {
  check(t)
  await withTx(async (tx) => {
    const cur = (await tx.query<{ baseType: string; used: number }>(
      `SELECT base_type "baseType", (SELECT count(*)::int FROM vouchers WHERE voucher_type_id = $1) used FROM voucher_types WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [id, companyId],
    )).rows[0]
    if (!cur) throw new ValidationError([`Unknown voucher type ${id}`])
    if (cur.used && cur.baseType !== t.baseType) throw new ValidationError(['Vouchers use this voucher type, so the type of voucher it is stays'])
    await tx.query(
      `UPDATE voucher_types SET name = $3, base_type = $4, abbreviation = $5, numbering = $6, prefix = $7, suffix = $8, width = $9, start_number = $10,
              restart_yearly = $11, print_title = $12, active = $13 WHERE id = $1 AND company_id = $2`,
      [id, companyId, ...values(t)],
    ).catch(taken(t.name))
    await tx.query(`UPDATE voucher_types SET pos = $2 WHERE id = $1`, [id, !!t.pos])
    const was = (await tx.query<{ reg: number | null }>(`SELECT gst_registration_id reg FROM voucher_types WHERE id = $1`, [id])).rows[0].reg
    if ((was ?? null) !== (t.gstRegistrationId ?? null)) {
      if (cur.used) throw new ValidationError(['Vouchers use this voucher type, so the GST registration it is of stays (their returns would change)'])
      await setRegistration(tx, companyId, id, t.gstRegistrationId ?? null)
    }
  })
}

async function setRegistration(db: { query: typeof pool.query }, companyId: number, id: number, reg: number | null) {
  if (reg && !(await db.query(`SELECT 1 FROM gst_registrations WHERE id = $1 AND company_id = $2`, [reg, companyId])).rowCount) throw new ValidationError([`Unknown GST registration ${reg}`])
  await db.query(`UPDATE voucher_types SET gst_registration_id = $2 WHERE id = $1`, [id, reg])
}

export async function deleteVoucherType(companyId: number, id: number) {
  const { rows } = await pool.query<{ name: string; used: number }>(
    `SELECT name, (SELECT count(*)::int FROM vouchers WHERE voucher_type_id = $1) used FROM voucher_types WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  )
  if (!rows[0]) throw new ValidationError([`Unknown voucher type ${id}`])
  if (rows[0].used) throw new ValidationError([`${rows[0].used} voucher(s) use ${rows[0].name}; set it not in use instead`])
  await pool.query(`DELETE FROM voucher_types WHERE id = $1`, [id])
}

/**
 * F11 Company Features. Every feature is on unless switched off (those in OFF_BY_DEFAULT the other
 * way round); switching one off hides its screens and fields, it never deletes what was recorded.
 */
export const FEATURES = {
  inventory: 'Maintain inventory (stock items, item invoices)',
  godowns: 'Maintain multiple godowns',
  orders: 'Use orders, delivery and receipt notes',
  stockCategories: 'Maintain stock categories',
  billwise: 'Maintain bill-wise details',
  costCentres: 'Maintain cost centres',
  interest: 'Calculate interest',
  gst: 'Enable GST',
  cheques: 'Enable cheque printing and post-dated vouchers',
  optional: 'Use optional and memorandum vouchers',
  edocs: 'Use e-Invoice and e-Way Bill',
  email: 'E-mail documents',
  incomeExpenditure: 'Income & Expenditure A/c instead of Profit & Loss (a non-profit organisation)',
  tds: 'Enable TDS (tax deducted at source)',
  tcs: 'Enable TCS (tax collected at source)',
  multiCurrency: 'Enable multi-currency (ledgers and vouchers in foreign currencies)',
  payroll: 'Maintain payroll (employees, pay heads, attendance, salary)',
  jobWork: 'Enable job order processing (job work in and out)',
  costTracking: 'Enable cost tracking (costs and sales of a job or consignment)',
} as const
export type Feature = keyof typeof FEATURES
const OFF_BY_DEFAULT = new Set<Feature>(['incomeExpenditure', 'tds', 'tcs', 'multiCurrency', 'payroll', 'jobWork', 'costTracking'])

export async function getFeatures(companyId: number): Promise<Record<Feature, boolean>> {
  const { rows } = await pool.query<{ features: Partial<Record<Feature, boolean>> }>(`SELECT features FROM companies WHERE id = $1`, [companyId])
  const set = rows[0]?.features ?? {}
  return Object.fromEntries(Object.keys(FEATURES).map((k) => [k, set[k as Feature] ?? !OFF_BY_DEFAULT.has(k as Feature)])) as Record<Feature, boolean>
}

export async function setFeatures(companyId: number, f: Partial<Record<string, boolean>>) {
  const unknown = Object.keys(f).filter((k) => !(k in FEATURES))
  if (unknown.length) throw new ValidationError([`Unknown feature ${unknown.join(', ')}`])
  await pool.query(`UPDATE companies SET features = features || $2::jsonb WHERE id = $1`, [companyId, JSON.stringify(f)])
}

// ------------------------------------------------------------------ stock categories

export async function createStockCategory(companyId: number, c: { name: string; parentId?: number | null }) {
  if (!c.name.trim()) throw new ValidationError(['A stock category needs a name'])
  if (c.parentId && !(await pool.query(`SELECT 1 FROM stock_categories WHERE id = $1 AND company_id = $2`, [c.parentId, companyId])).rowCount)
    throw new ValidationError(['Unknown stock category'])
  const { rows } = await pool
    .query<{ id: number }>(`INSERT INTO stock_categories (company_id, name, parent_id) VALUES ($1,$2,$3) RETURNING id`, [companyId, c.name.trim(), c.parentId ?? null])
    .catch((err) => {
      if (err.code === '23505') throw new ValidationError([`The name "${c.name}" is already used by another stock category`])
      throw err
    })
  return rows[0].id
}

export async function alterStockCategory(companyId: number, id: number, c: { name: string; parentId?: number | null }) {
  if (!c.name.trim()) throw new ValidationError(['A stock category needs a name'])
  await withTx(async (tx) => {
    if (!(await tx.query(`SELECT 1 FROM stock_categories WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, companyId])).rowCount)
      throw new ValidationError([`Unknown stock category ${id}`])
    // a category can't move under itself or one of its own
    for (let p = c.parentId ?? null; p !== null; ) {
      if (p === id) throw new ValidationError(['A stock category cannot sit under itself'])
      const r = (await tx.query<{ parentId: number | null }>(`SELECT parent_id "parentId" FROM stock_categories WHERE id = $1 AND company_id = $2`, [p, companyId])).rows[0]
      if (!r) throw new ValidationError(['Unknown stock category'])
      p = r.parentId
    }
    await tx.query(`UPDATE stock_categories SET name = $3, parent_id = $4 WHERE id = $1 AND company_id = $2`, [id, companyId, c.name.trim(), c.parentId ?? null])
      .catch((err) => {
        if (err.code === '23505') throw new ValidationError([`The name "${c.name}" is already used by another stock category`])
        throw err
      })
  })
}

export async function deleteStockCategory(companyId: number, id: number) {
  const used = (await pool.query(`SELECT 1 FROM stock_items WHERE category_id = $1 UNION ALL SELECT 1 FROM stock_categories WHERE parent_id = $1 LIMIT 1`, [id])).rowCount
  if (used) throw new ValidationError(['Stock items or categories are under this category'])
  await pool.query(`DELETE FROM stock_categories WHERE id = $1 AND company_id = $2`, [id, companyId])
}
