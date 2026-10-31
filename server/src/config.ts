/**
 * F12 Configuration: a company's choices for entering vouchers and showing reports, as Tally's F12.
 * Stored as JSON on the company; anything not set takes its default.
 */
import { pool } from './db'
import { ValidationError } from './books'

export const CONFIG_DEFAULTS = {
  voucherDate: 'today' as 'today' | 'last', // a new voucher's date: today, or the last voucher's date
  showBalances: true, // current balances beside ledgers in voucher entry
  warnNegativeCash: true, // ask before saving a voucher that takes cash or a bank below zero
  dayBookNarration: true, // narrations under each voucher in the Day Book
}
export type Config = typeof CONFIG_DEFAULTS

/** The configuration, and the date of the latest voucher (a new voucher's date when so configured). */
export async function getConfig(companyId: number): Promise<Config & { lastVoucherDate: string | null }> {
  const { rows } = await pool.query<{ config: Partial<Config>; last: string | null }>(
    `SELECT config, (SELECT to_char(max(date), 'YYYY-MM-DD') FROM vouchers v WHERE v.company_id = c.id AND NOT v.cancelled) last FROM companies c WHERE id = $1`, [companyId],
  )
  return { ...CONFIG_DEFAULTS, ...(rows[0]?.config ?? {}), lastVoucherDate: rows[0]?.last ?? null }
}

export async function setConfig(companyId: number, patch: Record<string, unknown>) {
  const errors: string[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in CONFIG_DEFAULTS)) errors.push(`Unknown setting ${k}`)
    else if (k === 'voucherDate' ? !['today', 'last'].includes(v as string) : typeof v !== 'boolean') errors.push(`${k}: not a valid choice`)
  }
  if (errors.length) throw new ValidationError(errors)
  await pool.query(`UPDATE companies SET config = config || $2::jsonb WHERE id = $1`, [companyId, JSON.stringify(patch)])
}
