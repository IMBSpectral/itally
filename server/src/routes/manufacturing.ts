/** Bills of materials, Cost Estimation and the job work reports. */
import type { Router, Request } from 'express'
import { z } from 'zod'
import { pool } from '../db'
import { costEstimation, getBom, bomNames, jobWorkReport, setBom } from '../manufacturing'

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export function addManufacturingRoutes(company: Router, cid: (req: Request) => number) {
  // ?name= one of the item's bills of materials (else its first)
  company.get('/stock-items/:id/bom', async (req, res) =>
    res.json(await getBom(pool, cid(req), Number(req.params.id), typeof req.query.name === 'string' && req.query.name ? req.query.name : undefined)))
  company.get('/stock-items/:id/boms', async (req, res) => res.json(await bomNames(pool, cid(req), Number(req.params.id))))
  company.put('/stock-items/:id/bom', async (req, res) => {
    const line = z.object({ itemId: z.number().int(), qty: z.number().int() })
    const b = z.object({
      name: z.string().max(60).optional(), makesQty: z.number().int(), components: z.array(line),
      byProducts: z.array(line.extend({ costShare: z.number().int().min(0).max(10000).nullable() })).optional(), scrap: z.array(line).optional(),
    }).parse(req.body)
    await setBom(cid(req), Number(req.params.id), b)
    res.status(204).end()
  })
  /** ?item=&qty= (thousandths)&asOf= */
  company.get('/reports/cost-estimation', async (req, res) => {
    const q = z.object({ item: z.coerce.number().int(), qty: z.coerce.number().int().positive(), asOf: date }).parse(req.query)
    res.json(await costEstimation(pool, cid(req), q.item, q.qty, q.asOf))
  })
  company.get('/reports/job-work', async (req, res) => {
    const q = z.object({ asOf: date }).parse(req.query)
    res.json(await jobWorkReport(pool, cid(req), q.asOf))
  })
}
