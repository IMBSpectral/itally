import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { pool, withTx } from './db'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

/** Apply every migration in src/migrations that hasn't run yet, in name order. */
export async function migrate(log = console.log) {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  )
  const done = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  )
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  for (const f of files) {
    if (done.has(f)) continue
    const sql = await readFile(path.join(dir, f), 'utf8')
    await withTx(async (tx) => {
      await tx.query(sql)
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f])
    })
    log(`migrated ${f}`)
  }
}
