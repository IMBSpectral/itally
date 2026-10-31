/**
 * TDS and TCS: the deductor's details, natures of payment and of goods, what a voucher being entered
 * should deduct or collect, challans of payments, and the reports (Computation and Outstandings of
 * each, Forms 26Q, 27Q and 27EQ, Challan Reconciliation).
 */
import type { Router, Request } from 'express'
import { z } from 'zod'
import { pool } from '../db'
import { ValidationError } from '../books'
import {
  alterNature, challanReconciliation, createNature, deleteNature, getTdsSettings, listNatures, quarterlyReturn, setChallan, setChallans, setTdsSettings, suggestTds,
  tdsComputation, tdsOutstandings, type ReturnForm, listPartyRates, createPartyRate, deletePartyRate,
} from '../tds'
import { returnSheet } from '../engine/tds'

type Period = { from: string; to: string }

const nature = z.object({
  name: z.string().trim().min(1),
  kind: z.enum(['TDS', 'TCS']).default('TDS'),
  section: z.string().trim().min(1),
  collectionCode: z.string().trim().nullish().transform((c) => c || null),
  rateIndividual: z.number().int(),
  rateOther: z.number().int(),
  rateNoPan: z.number().int(),
  thresholdSingle: z.number().int().nullable(),
  thresholdAnnual: z.number().int().nullable(),
  excessOnly: z.boolean().default(false),
})
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const challan = z.object({ bsrCode: z.string().trim(), challanNo: z.string().trim(), challanDate: date }).nullable()

export function addTdsRoutes(company: Router, cid: (req: Request) => number, period: (req: Request) => Promise<Period>) {
  company.get('/tds', async (req, res) => res.json(await getTdsSettings(pool, cid(req))))
  company.put('/tds', async (req, res) => {
    const s = z.object({ tan: z.string().nullish(), deductorType: z.enum(['Government', 'Others']).default('Others'), responsible: z.string().nullish() }).parse(req.body)
    await setTdsSettings(cid(req), { tan: s.tan ?? null, deductorType: s.deductorType, responsible: s.responsible ?? null })
    res.status(204).end()
  })

  company.get('/tds-natures', async (req, res) => res.json(await listNatures(pool, cid(req))))
  // a party's own rates: section 197 certificates and treaty (DTAA) rates
  company.get('/tds/party-rates', async (req, res) => res.json(await listPartyRates(cid(req))))
  company.post('/tds/party-rates', async (req, res) => {
    const d = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    const b = z.object({ ledgerId: z.number().int(), natureId: z.number().int().nullable(), kind: z.enum(['certificate', 'dtaa']), rate: z.number().int(), certificateNo: z.string().nullish(),
      validFrom: d, validTo: d, limit: z.number().int().nullish() }).parse(req.body)
    res.status(201).json({ id: await createPartyRate(cid(req), b) })
  })
  company.delete('/tds/party-rates/:id', async (req, res) => {
    await deletePartyRate(cid(req), Number(req.params.id))
    res.status(204).end()
  })
  company.post('/tds-natures', async (req, res) => res.status(201).json({ id: await createNature(cid(req), nature.parse(req.body)) }))
  company.put('/tds-natures/:id', async (req, res) => {
    await alterNature(cid(req), Number(req.params.id), nature.parse(req.body))
    res.status(204).end()
  })
  company.delete('/tds-natures/:id', async (req, res) => {
    await deleteNature(cid(req), Number(req.params.id))
    res.status(204).end()
  })

  /** What a voucher being entered should deduct (POST its date and lines). */
  company.post('/tds/suggest', async (req, res) => {
    const v = z.object({ id: z.number().int().optional(), date, entries: z.array(z.object({ ledgerId: z.number().int(), amount: z.number().int() })) }).parse(req.body)
    res.json(await suggestTds(cid(req), v))
  })

  company.get('/vouchers/:id/tds-challan', async (req, res) => {
    const { rows } = await pool.query(
      `SELECT bsr_code "bsrCode", challan_no "challanNo", to_char(challan_date, 'YYYY-MM-DD') "challanDate"
         FROM tds_challans c JOIN vouchers v ON v.id = c.voucher_id WHERE c.voucher_id = $1 AND v.company_id = $2`,
      [Number(req.params.id), cid(req)],
    )
    res.json(rows[0] ?? null)
  })
  company.put('/vouchers/:id/tds-challan', async (req, res) => {
    await setChallan(cid(req), Number(req.params.id), challan.parse(req.body))
    res.status(204).end()
  })

  const kindOf = (req: Request) => z.enum(['TDS', 'TCS']).default('TDS').parse(req.query.kind)
  company.get('/reports/tds-computation', async (req, res) => {
    const p = await period(req)
    res.json({ ...p, lines: await tdsComputation(cid(req), p.from, p.to, kindOf(req)) })
  })
  company.get('/reports/tds-outstandings', async (req, res) => {
    const p = await period(req)
    res.json({ ...p, ...(await tdsOutstandings(cid(req), p.from, p.to, kindOf(req))) })
  })
  /** Forms 26Q, 27Q and 27EQ for ?fy=2026-04-01&quarter=1 (JSON); &format=csv for the deductee or collectee details as CSV. */
  // the 1961 Act's names and the 2025 Act's (Form 140 = 26Q, 144 = 27Q, 143 = 27EQ)
  const routes: [string, ReturnForm][] = [['26q', '26Q'], ['27q', '27Q'], ['27eq', '27EQ'], ['140', '26Q'], ['144', '27Q'], ['143', '27EQ']]
  for (const [path, form] of routes)
    company.get(`/reports/form-${path}`, async (req, res) => {
      const q = z.object({ fy: date, quarter: z.coerce.number().int().min(1).max(4), format: z.enum(['json', 'csv']).default('json') }).parse(req.query)
      if (!q.fy.endsWith('-04-01')) throw new ValidationError([`Form ${form} follows the April-March year`])
      const r = await quarterlyReturn(cid(req), q.fy, q.quarter as 1 | 2 | 3 | 4, form)
      if (q.format === 'json') return res.json(r)
      const { head, rows } = returnSheet(r)
      const cell = (v: unknown) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''))
      res.setHeader('content-type', 'text/csv; charset=utf-8')
      res.setHeader('content-disposition', `attachment; filename="${r.title.split(' ')[1]}-Q${q.quarter}-${q.fy.slice(0, 4)}.csv"`)
      res.send([head, ...rows].map((l) => l.map(cell).join(',')).join('\r\n') + '\r\n')
    })

  /** Challan Reconciliation: the period's payments of TDS and TCS, their challans and what they account for; PUT saves several challans at once. */
  company.get('/reports/challan-reconciliation', async (req, res) => {
    const p = await period(req)
    res.json({ ...p, ...(await challanReconciliation(cid(req), p.from, p.to)) })
  })
  company.put('/tds-challans', async (req, res) => {
    await setChallans(cid(req), z.array(z.object({ voucherId: z.number().int().positive(), challan })).parse(req.body))
    res.status(204).end()
  })
}
