import path from 'node:path'
import express, { type ErrorRequestHandler } from 'express'
import { ZodError } from 'zod'
import { pool } from './db'
import { ValidationError } from './books'
import { companiesRouter } from './routes/companies'
import { settingsRouter } from './routes/settings'
import { groupCompaniesRouter } from './routes/groupcos'

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ValidationError) return res.status(422).json({ error: err.message, errors: err.errors })
  if (err instanceof ZodError)
    return res.status(400).json({ error: 'Invalid request', errors: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' })
  // a database rule that the engine didn't catch first (e.g. the commit-time balance check)
  if (err?.code === '23514' || err?.code === 'P0001') return res.status(422).json({ error: err.message })
  console.error(err)
  res.status(500).json({ error: 'Internal error' })
}

/**
 * @param staticDir the built front end (desktop app): served at / so the window loads one
 *   origin and needs no proxy. Unknown non-API paths fall back to index.html.
 */
export function createApp(staticDir?: string) {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '10mb' })) // an e-mailed document with its attachments

  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1')
    res.json({ ok: true })
  })
  app.use('/api/companies', companiesRouter)
  app.use('/api/settings', settingsRouter)
  app.use('/api/group-companies', groupCompaniesRouter)
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }))
  if (staticDir) {
    app.use(express.static(staticDir, { index: 'index.html' }))
    app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(path.join(staticDir, 'index.html')) : next()))
  }
  app.use(errorHandler)
  return app
}
