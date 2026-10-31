import type { Router, Request } from 'express'
import { z } from 'zod'
import { pool } from '../db'
import { bookInterest, interestSummary, ledgerInterest } from '../interest'
import {
  alterCostCategory, alterCostCentre, categorySummary, centreBreakup, centresOf, createCostCategory, createCostCentre,
  deleteCostCategory, deleteCostCentre, listCostMasters,
} from '../costcentres'

type Period = { from: string; to: string }
const categoryBody = z.object({ name: z.string().trim().min(1) })
const centreBody = z.object({ name: z.string().trim().min(1), categoryId: z.number().int().nullish(), parentId: z.number().int().nullish() })

export function addCostCentreRoutes(company: Router, cid: (req: Request) => number, period: (req: Request) => Promise<Period>) {
  company.get('/cost-masters', async (req, res) => res.json(await listCostMasters(pool, cid(req))))

  company.post('/cost-categories', async (req, res) => res.status(201).json({ id: await createCostCategory(cid(req), categoryBody.parse(req.body)) }))
  company.put('/cost-categories/:id', async (req, res) => {
    await alterCostCategory(cid(req), Number(req.params.id), categoryBody.parse(req.body))
    res.status(204).end()
  })
  company.delete('/cost-categories/:id', async (req, res) => {
    await deleteCostCategory(cid(req), Number(req.params.id))
    res.status(204).end()
  })
  company.post('/cost-centres', async (req, res) => res.status(201).json({ id: await createCostCentre(cid(req), centreBody.parse(req.body)) }))
  company.put('/cost-centres/:id', async (req, res) => {
    await alterCostCentre(cid(req), Number(req.params.id), centreBody.parse(req.body))
    res.status(204).end()
  })
  company.delete('/cost-centres/:id', async (req, res) => {
    await deleteCostCentre(cid(req), Number(req.params.id))
    res.status(204).end()
  })

  /** Cost Category Summary: every category's centres with their debits and credits for the period. */
  company.get('/reports/cost-centres', async (req, res) => {
    const p = await period(req)
    res.json(await categorySummary(cid(req), p.from, p.to))
  })
  /** Cost Centre Break-up: the ledgers booked to one centre. */
  company.get('/reports/cost-centres/:id', async (req, res) => {
    const p = await period(req)
    const r = await centreBreakup(cid(req), Number(req.params.id), p.from, p.to)
    if (!r) return res.status(404).json({ error: 'Not found' })
    res.json(r)
  })
  /** Interest Calculations for one ledger: the stretches of days and the interest on each. */
  company.get('/reports/interest/ledger/:id', async (req, res) => {
    const p = await period(req)
    const r = await ledgerInterest(pool, cid(req), Number(req.params.id), p.from, p.to)
    if (!r) return res.status(404).json({ error: 'This ledger does not calculate interest' })
    res.json({ ...p, ...r })
  })
  /** Book a ledger's interest for the period with a Journal to an interest income or expense ledger. */
  company.post('/interest/book', async (req, res) => {
    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    const b = z.object({ ledgerId: z.number().int(), from: date, to: date, interestLedgerId: z.number().int(), date }).parse(req.body)
    res.status(201).json(await bookInterest(cid(req), b))
  })
  /** Interest Receivable / Payable, or a group's ledgers (?side= or ?groupId=). */
  company.get('/reports/interest', async (req, res) => {
    const p = await period(req)
    const side = z.enum(['receivable', 'payable']).optional().parse(req.query.side)
    const groupId = req.query.groupId ? Number(req.query.groupId) : undefined
    const r = await interestSummary(cid(req), p.from, p.to, { side, groupId })
    if (!r) return res.status(404).json({ error: 'Not found' })
    res.json(r)
  })
  /** Ledger Break-up and Group Break-up: one ledger's (or group's) amounts by cost centre. */
  company.get('/reports/cost-breakup', async (req, res) => {
    const p = await period(req)
    const q = z.union([z.object({ ledgerId: z.coerce.number().int() }), z.object({ groupId: z.coerce.number().int() })]).parse(req.query)
    const r = await centresOf(cid(req), q, p.from, p.to)
    if (!r) return res.status(404).json({ error: 'Not found' })
    res.json(r)
  })
}
