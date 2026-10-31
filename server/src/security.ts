/**
 * Company security: users with a role, passwords stored as scrypt hashes, and session tokens.
 * A company is secured once it has a user; from then on every request for it needs a token.
 *
 *   Owner       everything, including users and passwords
 *   Accountant  everything except managing users
 *   Data Entry  see everything and create vouchers and masters; no alteration, cancellation or deletion
 *   Viewer      see everything, change nothing
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { pool, withTx } from './db'
import { ValidationError } from './books'

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>
export const ROLES = ['Owner', 'Accountant', 'Data Entry', 'Viewer'] as const
export type Role = (typeof ROLES)[number]
export interface SessionUser {
  id: number
  companyId: number
  username: string
  role: Role
  levelId?: number | null // a security level of the company's own
}

/** A security level: a role, less the voucher types and reports it takes away, and a limit on back-dating. */
export interface SecurityLevel {
  id: number
  name: string
  baseRole: Exclude<Role, 'Owner'>
  deniedVouchers: string[]
  deniedReports: string[]
  backDays: number | null
}
export type SecurityLevelInput = Omit<SecurityLevel, 'id'>

const SESSION_HOURS = 12

export async function hashPassword(password: string) {
  const salt = randomBytes(16)
  const hash = await scrypt(password, salt, 32)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}
async function verifyPassword(password: string, stored: string) {
  const [kind, salt, hash] = stored.split('$')
  if (kind !== 'scrypt' || !salt || !hash) return false
  const got = await scrypt(password, Buffer.from(salt, 'hex'), 32)
  const want = Buffer.from(hash, 'hex')
  return got.length === want.length && timingSafeEqual(got, want)
}
function checkPassword(password: string) {
  if (password.length < 6) throw new ValidationError(['A password needs at least 6 characters'])
}

export async function isSecured(companyId: number) {
  return !!(await pool.query(`SELECT 1 FROM users WHERE company_id = $1 LIMIT 1`, [companyId])).rowCount
}

export async function listUsers(companyId: number) {
  return (await pool.query<{ id: number; username: string; role: Role; levelId: number | null }>(
    `SELECT id, username, role, level_id "levelId" FROM users WHERE company_id = $1 ORDER BY lower(username)`,
    [companyId],
  )).rows
}

/** Add a user. The first user of a company must be its Owner; that is what secures it. */
export async function createUser(companyId: number, input: { username: string; password: string; role: Role; levelId?: number | null }) {
  const username = input.username.trim()
  if (!username) throw new ValidationError(['A user needs a name'])
  checkPassword(input.password)
  return withTx(async (tx) => {
    const first = !(await tx.query(`SELECT 1 FROM users WHERE company_id = $1 LIMIT 1`, [companyId])).rowCount
    if (first && (input.role !== 'Owner' || input.levelId)) throw new ValidationError(['The first user must be the Owner'])
    const role = input.levelId ? (await levelOf(tx, companyId, input.levelId)).baseRole : input.role
    const { rows } = await tx
      .query<{ id: number }>(`INSERT INTO users (company_id, username, password_hash, role, level_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [
        companyId, username, await hashPassword(input.password), role, input.levelId ?? null,
      ])
      .catch((err: { code?: string }) => {
        if (err.code === '23505') throw new ValidationError([`There is already a user "${username}"`])
        throw err
      })
    return rows[0].id
  })
}

/** Change a user's role and, optionally, set a new password (which ends their sessions). */
export async function alterUser(companyId: number, id: number, input: { role: Role; password?: string | null; levelId?: number | null }) {
  if (input.password) checkPassword(input.password)
  return withTx(async (tx) => {
    const cur = (await tx.query<{ role: Role }>(`SELECT role FROM users WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, companyId])).rows[0]
    if (!cur) throw new ValidationError(['No such user'])
    const role = input.levelId ? (await levelOf(tx, companyId, input.levelId)).baseRole : input.role
    if (cur.role === 'Owner' && role !== 'Owner') await keepAnOwner(tx, companyId, id)
    await tx.query(`UPDATE users SET role = $2, level_id = $3 WHERE id = $1`, [id, role, input.levelId ?? null])
    if (input.password) {
      await tx.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [id, await hashPassword(input.password)])
      await tx.query(`DELETE FROM sessions WHERE user_id = $1`, [id])
    }
  })
}

export async function deleteUser(companyId: number, id: number) {
  return withTx(async (tx) => {
    const cur = (await tx.query<{ role: Role }>(`SELECT role FROM users WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, companyId])).rows[0]
    if (!cur) throw new ValidationError(['No such user'])
    if (cur.role === 'Owner') await keepAnOwner(tx, companyId, id)
    await tx.query(`DELETE FROM users WHERE id = $1`, [id])
  })
}

async function keepAnOwner(tx: { query: typeof pool.query }, companyId: number, leaving: number) {
  const others = await tx.query(`SELECT 1 FROM users WHERE company_id = $1 AND role = 'Owner' AND id <> $2 LIMIT 1`, [companyId, leaving])
  if (!others.rowCount) throw new ValidationError(['The company must keep an Owner'])
}

/** Check a name and password; returns a session token. */
export async function login(companyId: number, username: string, password: string) {
  const u = (await pool.query<{ id: number; username: string; role: Role; password_hash: string }>(
    `SELECT id, username, role, password_hash FROM users WHERE company_id = $1 AND lower(username) = lower($2)`,
    [companyId, username.trim()],
  )).rows[0]
  // the same answer, and about the same time, whether the name or the password is wrong
  const ok = await verifyPassword(password, u?.password_hash ?? 'scrypt$00$00')
  if (!u || !ok) {
    await new Promise((r) => setTimeout(r, 300))
    throw new ValidationError(['Wrong user name or password'])
  }
  const token = randomBytes(32).toString('hex')
  await pool.query(`DELETE FROM sessions WHERE expires_at < now()`)
  await pool.query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`, [token, u.id, SESSION_HOURS])
  return { token, user: { id: u.id, companyId, username: u.username, role: u.role } satisfies SessionUser }
}

export async function logout(token: string) {
  await pool.query(`DELETE FROM sessions WHERE token = $1`, [token])
}

export async function sessionUser(token: string): Promise<SessionUser | undefined> {
  return (await pool.query<SessionUser>(
    `SELECT u.id, u.company_id "companyId", u.username, u.role, u.level_id "levelId" FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = $1 AND s.expires_at > now()`,
    [token],
  )).rows[0]
}

/** A user changing their own password, with the current one. */
export async function changePassword(user: SessionUser, current: string, next: string) {
  checkPassword(next)
  const row = (await pool.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [user.id])).rows[0]
  if (!row || !(await verifyPassword(current, row.password_hash))) throw new ValidationError(['The current password is wrong'])
  await pool.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [user.id, await hashPassword(next)])
}

// ------------------------------------------------------------------ security levels

const LEVEL_COLUMNS = `id, name, base_role "baseRole", denied_vouchers "deniedVouchers", denied_reports "deniedReports", back_days "backDays"`
type Q = { query: typeof pool.query }

async function levelOf(db: Q, companyId: number, id: number): Promise<SecurityLevel> {
  const l = (await db.query<SecurityLevel>(`SELECT ${LEVEL_COLUMNS} FROM security_levels WHERE id = $1 AND company_id = $2`, [id, companyId])).rows[0]
  if (!l) throw new ValidationError([`Unknown security level ${id}`])
  return l
}
export const getLevel = (companyId: number, id: number) => levelOf(pool, companyId, id)
export async function listLevels(companyId: number) {
  return (await pool.query<SecurityLevel>(`SELECT ${LEVEL_COLUMNS} FROM security_levels WHERE company_id = $1 ORDER BY lower(name)`, [companyId])).rows
}
function checkLevel(l: SecurityLevelInput) {
  const errors: string[] = []
  if (!l.name.trim()) errors.push('A security level needs a name')
  if (['owner', 'accountant', 'data entry', 'viewer'].includes(l.name.trim().toLowerCase())) errors.push(`"${l.name}" is a predefined role`)
  if (l.backDays !== null && (!Number.isInteger(l.backDays) || l.backDays < 0)) errors.push('Days back is a whole number')
  if (errors.length) throw new ValidationError(errors)
}
const taken = (name: string) => (err: { code?: string }) => {
  if (err.code === '23505') throw new ValidationError([`There is already a security level "${name}"`])
  throw err
}
export async function createLevel(companyId: number, l: SecurityLevelInput) {
  checkLevel(l)
  return (await pool.query<{ id: number }>(
    `INSERT INTO security_levels (company_id, name, base_role, denied_vouchers, denied_reports, back_days) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [companyId, l.name.trim(), l.baseRole, l.deniedVouchers, l.deniedReports, l.backDays],
  ).catch(taken(l.name))).rows[0].id
}
export async function alterLevel(companyId: number, id: number, l: SecurityLevelInput) {
  checkLevel(l)
  await withTx(async (tx) => {
    const r = await tx.query(`UPDATE security_levels SET name = $3, base_role = $4, denied_vouchers = $5, denied_reports = $6, back_days = $7 WHERE id = $1 AND company_id = $2`,
      [id, companyId, l.name.trim(), l.baseRole, l.deniedVouchers, l.deniedReports, l.backDays]).catch(taken(l.name))
    if (!r.rowCount) throw new ValidationError([`Unknown security level ${id}`])
    await tx.query(`UPDATE users SET role = $2 WHERE level_id = $1`, [id, l.baseRole])
  })
}
export async function deleteLevel(companyId: number, id: number) {
  if ((await pool.query(`SELECT 1 FROM users WHERE level_id = $1 LIMIT 1`, [id])).rowCount) throw new ValidationError(['Users have this security level; give them another first'])
  const { rowCount } = await pool.query(`DELETE FROM security_levels WHERE id = $1 AND company_id = $2`, [id, companyId])
  if (!rowCount) throw new ValidationError([`Unknown security level ${id}`])
}

/**
 * What a security level takes away from its role: the reports it names (/reports/<name>), the
 * voucher types it names (entering or altering them), and vouchers dated more than its days back.
 * Returns why the request is refused, or null.
 */
export function levelRefuses(l: SecurityLevel, method: string, path: string, body: unknown, today: string): string | null {
  const report = /^\/reports\/([^/]+)/.exec(path)?.[1]
  if (report && l.deniedReports.includes(report.replace(/\.json$/, ''))) return `${l.name} may not see this report`
  if ((method === 'POST' && path === '/vouchers') || (method === 'PUT' && /^\/vouchers\/\d+$/.test(path))) {
    const v = (body ?? {}) as { type?: string; date?: string }
    if (v.type && l.deniedVouchers.includes(v.type)) return `${l.name} may not enter ${v.type} vouchers`
    if (l.backDays !== null && v.date) {
      const earliest = new Date(Date.parse(today + 'T00:00:00Z') - l.backDays * 86_400_000).toISOString().slice(0, 10)
      if (v.date < earliest) return `${l.name} may date a voucher at most ${l.backDays} day(s) back (from ${earliest})`
    }
  }
  return null
}

/**
 * May this role make this request? Paths are relative to the company (e.g. "/vouchers/12").
 * Users and passwords are the Owner's; changing one's own password and signing out are anyone's.
 */
export function allowed(role: Role, method: string, path: string): boolean {
  if (/^\/(me|logout)(\/|$)/.test(path)) return true
  if (/^\/users(\/|$)/.test(path)) return role === 'Owner'
  if (role === 'Owner' || role === 'Accountant') return true
  const read = method === 'GET' || method === 'HEAD'
  if (role === 'Viewer') return read && path !== '/backup'
  // Data Entry: read, and create (a POST to a collection); no alteration, cancellation, deletion or restore
  if (read) return path !== '/backup'
  return method === 'POST' && /^\/(vouchers|ledgers|groups|units|stock-groups|godowns|stock-items|cost-categories|cost-centres)$/.test(path)
}
