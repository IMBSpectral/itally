import type { Router, Request } from 'express'
import { z } from 'zod'
import { pool } from '../db'

const ENTITIES = ['voucher', 'ledger', 'group', 'company', 'stock item', 'stock group', 'unit', 'godown', 'cost category', 'cost centre',
  'voucher type', 'stock category', 'GST classification', 'TDS nature of payment', 'currency'] as const

export function addEditLogRoutes(company: Router, cid: (req: Request) => number) {
  /** The Edit Log, newest first: who changed what and when (without the snapshots). */
  company.get('/edit-log', async (req, res) => {
    const q = z
      .object({
        entity: z.enum(ENTITIES).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(5000).default(500),
      })
      .parse(req.query)
    const { rows } = await pool.query(
      `SELECT id, to_char(at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI:SS') "at", actor, entity, entity_id "entityId",
              action, label, (data ->> 'version')::int "version"
         FROM edit_log
        WHERE company_id = $1 AND ($2::text IS NULL OR entity = $2)
          AND ($3::date IS NULL OR at >= $3::date) AND ($4::date IS NULL OR at < $4::date + 1)
        ORDER BY id DESC LIMIT $5`,
      [cid(req), q.entity ?? null, q.from ?? null, q.to ?? null, q.limit],
    )
    res.json(rows)
  })

  /** Every recorded version of one voucher or master, oldest first, with its full state. */
  company.get('/edit-log/:entity/:id', async (req, res) => {
    const entity = z.enum(ENTITIES).parse(req.params.entity)
    const { rows } = await pool.query(
      `SELECT id, to_char(at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI:SS') "at", actor, action, label, data
         FROM edit_log WHERE company_id = $1 AND entity = $2 AND entity_id = $3 ORDER BY id`,
      [cid(req), entity, Number(req.params.id)],
    )
    res.json(rows)
  })
}
