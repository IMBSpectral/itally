/** Intelligence over HTTP: Money Map, the review queue, collection drafts, the assistants, AI Assist. */
import type { Router, Request } from 'express'
import { z } from 'zod'
import { AGENTS, agentLog, collectionDrafts, decide, listAgents, moneyMap, reviewQueue, runAgent, setAgent, type AgentKind } from '../intelligence'
import { aiSettings, askAi, setAiSettings } from '../ai'

export function addIntelligenceRoutes(company: Router, cid: (req: Request) => number) {
  /** ?days=30&reserve= (paise) */
  company.get('/money-map', async (req, res) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(365).default(30), reserve: z.coerce.number().int().min(0).default(0) }).parse(req.query)
    res.json(await moneyMap(cid(req), q.days, q.reserve))
  })
  company.get('/review', async (req, res) => res.json(await reviewQueue(cid(req))))
  company.put('/review', async (req, res) => {
    const b = z.object({ key: z.string().min(1), status: z.enum(['dismissed', 'done', 'open']) }).parse(req.body)
    await decide(cid(req), b.key, b.status, (res.locals.user as { username?: string } | undefined)?.username)
    res.status(204).end()
  })
  company.get('/collection-drafts', async (req, res) => res.json(await collectionDrafts(cid(req))))

  const kind = (req: Request) => z.enum(Object.keys(AGENTS) as [AgentKind, ...AgentKind[]]).parse(req.params.kind)
  company.get('/agents', async (req, res) => res.json(await listAgents(cid(req))))
  company.put('/agents/:kind', async (req, res) => {
    await setAgent(cid(req), kind(req), z.object({ active: z.boolean(), schedule: z.string() }).parse(req.body))
    res.status(204).end()
  })
  company.post('/agents/:kind/run', async (req, res) => res.json(await runAgent(cid(req), kind(req))))
  company.get('/agents/log', async (req, res) => res.json(await agentLog(cid(req))))

  company.get('/ai/settings', async (req, res) => res.json(await aiSettings(cid(req))))
  company.put('/ai/settings', async (req, res) => {
    await setAiSettings(cid(req), z.object({ enabled: z.boolean(), apiKey: z.string().nullish() }).parse(req.body))
    res.status(204).end()
  })
  company.post('/ai/ask', async (req, res) => {
    const b = z.object({ question: z.string().max(4000), title: z.string().max(300).optional(), text: z.string().optional() }).parse(req.body)
    res.json(await askAi(cid(req), b.question, { title: b.title, text: b.text }))
  })
}
