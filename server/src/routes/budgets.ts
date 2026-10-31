/** Budgets (masters and Budget Variance), scenarios, and the Reversing Journal Register. */
import type { Router, Request } from 'express'
import { z } from 'zod'
import { pool } from '../db'
import {
  alterBudget, alterScenario, budgetVariance, createBudget, createScenario, deleteBudget, deleteScenario, getBudget, listBudgets, listScenarios, SCENARIO_INCLUDES, scenarioView,
} from '../budgets'

type Period = { from: string; to: string }
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const budget = z.object({
  name: z.string(),
  parentId: z.number().int().positive().nullable().default(null),
  from: date,
  to: date,
  lines: z.array(z.object({ kind: z.enum(['group', 'ledger', 'cost centre']), targetId: z.number().int().positive(), type: z.enum(['nett', 'closing']), amount: z.number().int() })).default([]),
})
const scenario = z.object({ name: z.string(), includeActuals: z.boolean().default(true), include: z.array(z.enum(SCENARIO_INCLUDES)).default(['Reversing Journal']) })

export function addBudgetRoutes(company: Router, cid: (req: Request) => number, period: (req: Request) => Promise<Period>) {
  company.get('/budgets', async (req, res) => res.json(await listBudgets(cid(req))))
  company.get('/budgets/:id', async (req, res) => {
    const b = await getBudget(pool, cid(req), Number(req.params.id))
    if (!b) return res.status(404).json({ error: 'Unknown budget' })
    res.json(b)
  })
  company.post('/budgets', async (req, res) => res.status(201).json({ id: await createBudget(cid(req), budget.parse(req.body)) }))
  company.put('/budgets/:id', async (req, res) => {
    await alterBudget(cid(req), Number(req.params.id), budget.parse(req.body))
    res.status(204).end()
  })
  company.delete('/budgets/:id', async (req, res) => {
    await deleteBudget(cid(req), Number(req.params.id))
    res.status(204).end()
  })
  /** ?budget=id[&scenario=id] */
  company.get('/reports/budget-variance', async (req, res) => {
    const q = z.object({ budget: z.coerce.number().int().positive(), scenario: z.coerce.number().int().positive().optional() }).parse(req.query)
    const b = await getBudget(pool, cid(req), q.budget)
    const view = q.scenario && b ? await scenarioView(pool, cid(req), q.scenario, b.to) : null
    res.json(await budgetVariance(cid(req), q.budget, view))
  })

  company.get('/scenarios', async (req, res) => res.json(await listScenarios(pool, cid(req))))
  company.post('/scenarios', async (req, res) => res.status(201).json({ id: await createScenario(cid(req), scenario.parse(req.body)) }))
  company.put('/scenarios/:id', async (req, res) => {
    await alterScenario(cid(req), Number(req.params.id), scenario.parse(req.body))
    res.status(204).end()
  })
  company.delete('/scenarios/:id', async (req, res) => {
    await deleteScenario(cid(req), Number(req.params.id))
    res.status(204).end()
  })

  /** Reversing Journal Register: the period's reversing journals, the date each is effective to, and whether it still is on the period's last day. */
  company.get('/reports/reversing-journals', async (req, res) => {
    const p = await period(req)
    const { rows } = await pool.query<{ id: number; date: string; docNo: string; applicableUpto: string; narration: string; entries: { ledger: string; amount: number }[] }>(
      `SELECT id, to_char(date, 'YYYY-MM-DD') date, COALESCE(doc_no, number::text) "docNo", to_char(applicable_upto, 'YYYY-MM-DD') "applicableUpto", narration,
              draft -> 'entries' entries
         FROM vouchers WHERE company_id = $1 AND type = 'Reversing Journal' AND NOT cancelled AND date BETWEEN $2 AND $3 ORDER BY date, id`,
      [cid(req), p.from, p.to],
    )
    res.json({
      ...p,
      vouchers: rows.map((r) => ({
        ...r, effective: r.applicableUpto >= p.to,
        amount: (r.entries ?? []).reduce((t, e) => t + Math.max(0, Number(e.amount)), 0),
        particulars: (r.entries ?? []).map((e) => e.ledger).join(', '),
        entries: undefined,
      })),
    })
  })
}
