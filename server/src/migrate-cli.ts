// npm run migrate. Kept apart from migrate.ts: a "run when executed directly" check inside
// migrate.ts would also fire once the server is bundled into a single file.
import { pool } from './db'
import { migrate } from './migrate'

migrate()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
