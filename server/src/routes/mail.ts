import type { Router, Request } from 'express'
import { z } from 'zod'
import { getMailSettings, mailLog, sendMail, setMailSettings } from '../mail'

const address = z.string().trim()
const settings = z.object({
  host: z.string(),
  port: z.number().int(),
  secure: z.boolean().optional(),
  username: z.string().nullish(),
  password: z.string().nullish(),
  fromAddress: z.string(),
  fromName: z.string().nullish(),
})
const message = z.object({
  to: z.array(address).max(50),
  cc: z.array(address).max(50).optional(),
  subject: z.string().max(300),
  html: z.string().max(5_000_000),
  text: z.string().max(1_000_000).optional(),
  voucherId: z.number().int().nullish(),
  attachments: z.array(z.object({ filename: z.string().max(200), content: z.string(), contentType: z.string().optional() })).max(10).optional(),
})

/** E-mail settings (the password is write-only), sending, and the log of what was sent. */
export function addMailRoutes(company: Router, cid: (req: Request) => number) {
  company.get('/mail/settings', async (req, res) => res.json(await getMailSettings(cid(req))))
  company.put('/mail/settings', async (req, res) => {
    await setMailSettings(cid(req), settings.parse(req.body))
    res.status(204).end()
  })
  company.post('/mail', async (req, res) => res.json(await sendMail(cid(req), message.parse(req.body))))
  company.get('/mail/log', async (req, res) => res.json(await mailLog(cid(req))))
}
