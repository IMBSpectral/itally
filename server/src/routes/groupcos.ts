/** Group companies: their members, and the consolidated Trial Balance, Profit & Loss A/c and Balance Sheet. */
import { Router } from 'express'
import { z } from 'zod'
import { alterGroupCompany, createGroupCompany, deleteGroupCompany, groupReport, listGroupCompanies } from '../groupcos'

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const body = z.object({ name: z.string(), members: z.array(z.number().int().positive()) })

export const groupCompaniesRouter = Router()
groupCompaniesRouter.get('/', async (_req, res) => res.json(await listGroupCompanies()))
groupCompaniesRouter.post('/', async (req, res) => {
  const b = body.parse(req.body)
  res.status(201).json({ id: await createGroupCompany(b.name, b.members) })
})
groupCompaniesRouter.put('/:id', async (req, res) => {
  const b = body.parse(req.body)
  await alterGroupCompany(Number(req.params.id), b.name, b.members)
  res.status(204).end()
})
groupCompaniesRouter.delete('/:id', async (req, res) => {
  await deleteGroupCompany(Number(req.params.id))
  res.status(204).end()
})
/** ?from=&to= */
groupCompaniesRouter.get('/:id/reports/:report', async (req, res) => {
  const report = z.enum(['trial-balance', 'profit-loss', 'balance-sheet']).parse(req.params.report)
  const q = z.object({ from: date, to: date }).parse(req.query)
  res.json(await groupReport(Number(req.params.id), report, q.from, q.to))
})
