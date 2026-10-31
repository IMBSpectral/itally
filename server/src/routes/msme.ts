/** MSME: the parties' MSME details (Party MSME Update) and MSME Form 1. */
import type { Router, Request } from 'express'
import { z } from 'zod'
import { ValidationError } from '../books'
import { MSME_ACTIVITIES, MSME_TYPES, msmeForm1, msmeInterest, msmeParties, setMsme } from '../msme'

const details = z.object({ type: z.enum(MSME_TYPES), udyamNo: z.string().nullish().transform((u) => u?.trim() || null), activity: z.enum(MSME_ACTIVITIES).default('Manufacturing') })

export function addMsmeRoutes(company: Router, cid: (req: Request) => number) {
  company.get('/msme', async (req, res) => res.json(await msmeParties(cid(req))))
  company.put('/msme', async (req, res) => {
    await setMsme(cid(req), z.array(z.object({ ledgerId: z.number().int().positive(), msme: details.nullable() })).parse(req.body))
    res.status(204).end()
  })
  /** ?fy=2026-04-01&half=1 (April-September) or 2 (October-March) */
  company.get('/reports/msme-form1', async (req, res) => {
    const q = z.object({ fy: z.string().regex(/^\d{4}-04-01$/), half: z.coerce.number().int().min(1).max(2) }).safeParse(req.query)
    if (!q.success) throw new ValidationError(['MSME Form 1 is for a half (1 or 2) of an April-March year'])
    res.json(await msmeForm1(cid(req), q.data.fy, q.data.half as 1 | 2))
  })
  /** ?asOf=&bankRate= (the RBI's bank rate, hundredths of a percent): interest on late payments to micro and small suppliers */
  company.get('/reports/msme-interest', async (req, res) => {
    const q = z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), bankRate: z.coerce.number().int().min(1).max(5000) }).parse(req.query)
    res.json(await msmeInterest(cid(req), q.asOf, q.bankRate))
  })
}
