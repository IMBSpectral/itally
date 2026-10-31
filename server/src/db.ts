import { AsyncLocalStorage } from 'node:async_hooks'
import pg from 'pg'
import { PGlite } from '@electric-sql/pglite'
import { env } from './env'

/**
 * The one database surface the app uses. Two backends implement it:
 *  - PostgreSQL over the network (`postgres://…`): the server / multi-user setup
 *  - PGlite, Postgres compiled to WebAssembly and run in-process (`pglite:<folder>` or
 *    `pglite:memory`): the desktop app, with the company data in a local folder
 * Both run the same SQL, triggers included.
 */
export interface QueryResult<R> {
  rows: R[]
  rowCount: number | null
}
export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<R = any>(text: string, params?: unknown[]): Promise<QueryResult<R>>
}
export interface Tx extends Queryable {
  release(): void
}
export interface Pool extends Queryable {
  connect(): Promise<Tx>
  end(): Promise<void>
}

// amounts are stored as bigint paise; return int8 (oid 20) as a JS number.
// Safe up to Number.MAX_SAFE_INTEGER paise (~90 trillion rupees).
const INT8 = 20
const toNumber = (v: string) => Number(v)

function pgPool(url: string): Pool {
  pg.types.setTypeParser(INT8, toNumber)
  return new pg.Pool({ connectionString: url, max: 10 }) as unknown as Pool
}

/** Hands out one turn at a time; PGlite is a single connection, so transactions take turns. */
class Turns {
  private tail: Promise<void> = Promise.resolve()
  take(): Promise<() => void> {
    let done!: () => void
    const mine = new Promise<void>((r) => (done = r))
    const before = this.tail
    this.tail = before.then(() => mine)
    return before.then(() => done)
  }
}

function pglitePool(where: string): Pool {
  const db = new PGlite(where === 'memory' ? undefined : where, { parsers: { [INT8]: toNumber } })
  const turns = new Turns()

  async function run<R>(text: string, params?: unknown[]): Promise<QueryResult<R>> {
    if (params === undefined) {
      // parameterless text may hold several statements (migrations); exec runs them all
      const results = await db.exec(text)
      const last = results[results.length - 1]
      return { rows: (last?.rows ?? []) as R[], rowCount: last?.affectedRows ?? last?.rows.length ?? 0 }
    }
    const r = await db.query<R>(text, params)
    return { rows: r.rows, rowCount: r.affectedRows || r.rows.length }
  }

  return {
    async query<R>(text: string, params?: unknown[]) {
      const release = await turns.take()
      try {
        return await run<R>(text, params)
      } finally {
        release()
      }
    },
    async connect() {
      const release = await turns.take()
      return { query: run, release }
    },
    async end() {
      await db.close()
    },
  }
}

/**
 * Who is making the change, for the Edit Log: set per request (runAs) and handed to the
 * database as app.actor inside each transaction. Without it the log says "local user".
 */
const actorStore = new AsyncLocalStorage<string>()
export const runAs = <T>(actor: string, fn: () => T) => actorStore.run(actor, fn)
const WRITE = /^\s*(insert|update|delete)\b/i

const url = env.databaseUrl
const base: Pool = url.startsWith('pglite:') ? pglitePool(url.slice('pglite:'.length)) : pgPool(url)
export const pool: Pool = {
  // a lone write made for a named user runs in its own transaction, so the log can name them
  query: (text, params) => (actorStore.getStore() && WRITE.test(text) ? withTx((tx) => tx.query(text, params)) : base.query(text, params)),
  connect: () => base.connect(),
  end: () => base.end(),
}

/** Run `fn` inside a transaction; rolls back on any thrown error. */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await base.connect()
  try {
    await client.query('BEGIN')
    const actor = actorStore.getStore()
    if (actor) await client.query(`SELECT set_config('app.actor', $1, true)`, [actor])
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
