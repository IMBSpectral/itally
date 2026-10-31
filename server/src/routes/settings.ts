import { Router } from 'express'
import { z } from 'zod'
import { pool } from '../db'

/** The settings the app may store, and the shape of each value. */
const SETTINGS = {
  lastCompany: z.number().int().nullable(),
} as const
const key = z.enum(Object.keys(SETTINGS) as [keyof typeof SETTINGS])

export const settingsRouter = Router()

settingsRouter.get('/:key', async (req, res) => {
  const k = key.parse(req.params.key)
  const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [k])
  res.json({ value: rows[0]?.value ?? null })
})

settingsRouter.put('/:key', async (req, res) => {
  const k = key.parse(req.params.key)
  const value = SETTINGS[k].parse(req.body?.value)
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [k, JSON.stringify(value)],
  )
  res.status(204).end()
})
