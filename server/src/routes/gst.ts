/**
 * GST: the company's registration, what the invoice screen needs to work out tax, and the
 * returns (GSTR-1, GSTR-3B, and GSTR-1 as the portal's JSON for one month).
 */
import type { Router, Request } from 'express'
import { z } from 'zod'
import { pool } from '../db'
import { getCompany, gstContext, setCompanyGst, ValidationError } from '../books'
import { alterClassification, createClassification, deleteClassification, listClassifications } from '../classifications'
import { TAXABILITY } from '../engine/gst'
import { gstr1, gstr1Json, gstr3b, gstr3bLate } from '../engine/gst-returns'
import { today } from '../engine/clock'
import {
  amendedVouchers, createGstRegistration, deleteGstRegistration, gstRegistrations, keralaFloodCess, registrationOf, cmp08, gstAdvances, gstChallanReconciliation, gstParties, gstr4, gstr9, gstVouchers, importPortalDocs, issued, reconcile2b, reconcileGstr1, setGstChallans,
  setGstParties, setImsActions,
} from '../gst-more'

type Period = { from: string; to: string }

async function registration(companyId: number) {
  const c = await getCompany(pool, companyId)
  if (!c?.gstin) throw new ValidationError(['Set the company GSTIN first (GST Reports → Registration)'])
  return c
}

const classification = z.object({
  name: z.string().trim().min(1),
  hsn: z.string().nullish(),
  description: z.string().nullish(),
  taxability: z.enum(TAXABILITY).optional(),
  gstRate: z.number().int().nullish(),
})

export function addGstRoutes(company: Router, cid: (req: Request) => number, period: (req: Request) => Promise<Period>) {
  /** GST Classifications: HSN/SAC, rate and taxability, picked on stock items and ledgers. */
  company.get('/gst-classifications', async (req, res) => res.json(await listClassifications(cid(req))))
  company.post('/gst-classifications', async (req, res) => res.status(201).json({ id: await createClassification(cid(req), classification.parse(req.body)) }))
  company.put('/gst-classifications/:id', async (req, res) => {
    await alterClassification(cid(req), Number(req.params.id), classification.parse(req.body))
    res.status(204).end()
  })
  company.delete('/gst-classifications/:id', async (req, res) => {
    await deleteClassification(cid(req), Number(req.params.id))
    res.status(204).end()
  })

  company.put('/gst', async (req, res) => {
    await setCompanyGst(cid(req), z.object({ gstin: z.string().nullish(), state: z.string().nullish(), gstType: z.enum(['Regular', 'Composition']).optional(), compositionRate: z.number().int().nullish() }).parse(req.body))
    res.status(204).end()
  })

  /** Ledgers and items as GST sees them, for working out an invoice's tax on screen. */
  company.get('/gst-context', async (req, res) => {
    const c = await gstContext(pool, cid(req))
    res.json({ ...c, ledgers: [...c.ledgers.values()], items: [...c.items.values()] })
  })

  /** Months whose GSTR-1 has been filed: their invoices changed later are reported as amendments. */
  company.get('/gst/filings', async (req, res) => {
    res.json((await pool.query(`SELECT month, filed_at "filedAt" FROM gst_filings WHERE company_id = $1 ORDER BY month`, [cid(req)])).rows)
  })
  company.put('/gst/filings/:month', async (req, res) => {
    const month = z.string().regex(/^\d{4}-\d{2}$/, 'Use yyyy-mm').parse(req.params.month)
    await pool.query(`INSERT INTO gst_filings (company_id, month) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [cid(req), month])
    res.status(204).end()
  })
  company.delete('/gst/filings/:month', async (req, res) => {
    await pool.query(`DELETE FROM gst_filings WHERE company_id = $1 AND month = $2`, [cid(req), req.params.month])
    res.status(204).end()
  })

  /** ?registration=: a further GST registration's returns (0, or absent: the company's own GSTIN) */
  const reg = (req: Request) => z.coerce.number().int().min(0).default(0).parse(req.query.registration)
  company.get('/reports/gstr1', async (req, res) => {
    const p = await period(req)
    const r = reg(req)
    const c = r ? await registrationOf(cid(req), r) : await registration(cid(req))
    const filed = (await pool.query(`SELECT 1 FROM gst_filings WHERE company_id = $1 AND month = $2`, [cid(req), p.from.slice(0, 7)])).rowCount! > 0
    res.json({
      ...p, gstin: c.gstin, filed: !r && filed, ...gstr1(await gstVouchers(cid(req), p, r), await issued(cid(req), p, r), r ? [] : await amendedVouchers(cid(req), p)),
      advances: await gstAdvances(cid(req), p),
    })
  })

  company.get('/reports/gstr3b', async (req, res) => {
    const p = await period(req)
    const r = reg(req)
    const c = r ? await registrationOf(cid(req), r) : await registration(cid(req))
    const advances = (await gstAdvances(cid(req), p, r)).totals.net
    const vouchers = await gstVouchers(cid(req), p, r)
    const r3 = gstr3b(vouchers, advances)
    // 5.1: filed (and paid) on the date given, by default today; the late fee's cap goes by last year's turnover
    const filedOn = typeof req.query.filedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.filedOn) ? req.query.filedOn : today()
    const fyStart = `${Number(p.from.slice(0, 4)) - (Number(p.from.slice(5, 7)) < 4 ? 1 : 0)}-04-01`
    const lastYear = await gstVouchers(cid(req), { from: `${Number(fyStart.slice(0, 4)) - 1}-04-01`, to: `${fyStart.slice(0, 4)}-03-31` }, r)
    const turnover = lastYear.filter((v) => v.gst.side === 'outward').reduce((t, v) => t + (v.type === 'Credit Note' ? -1 : 1) * v.gst.lines.reduce((s, l) => s + l.taxable, 0), 0)
    const nil = !vouchers.some((v) => v.gst.side !== 'adjustment' && v.gst.lines.length)
    const late = gstr3bLate(p.from.slice(0, 7), filedOn, { ...r3.cash, cess: r3.cess.cash }, nil, turnover)
    res.json({ ...p, gstin: c.gstin, advances, ...r3, late })
  })

  company.get('/gst-registrations', async (req, res) => res.json(await gstRegistrations(cid(req))))
  company.post('/gst-registrations', async (req, res) =>
    res.status(201).json({ id: await createGstRegistration(cid(req), z.object({ name: z.string(), gstin: z.string() }).parse(req.body)) }))
  company.delete('/gst-registrations/:id', async (req, res) => {
    await deleteGstRegistration(cid(req), Number(req.params.id))
    res.status(204).end()
  })
  company.get('/reports/kerala-flood-cess', async (req, res) => {
    const p = await period(req)
    res.json({ ...p, ...(await keralaFloodCess(cid(req), p, reg(req))) })
  })

  /** A GSTR-2B (POST /gst/portal/2b) or a filed GSTR-1 (/gst/portal/gstr1) downloaded from the portal, as its JSON. */
  company.post('/gst/portal/:source', async (req, res) => {
    const source = z.enum(['2b', 'gstr1']).parse(req.params.source)
    res.status(201).json(await importPortalDocs(cid(req), source === '2b' ? '2B' : 'GSTR-1', req.body))
  })
  const month = (req: Request) => z.string().regex(/^\d{4}-\d{2}$/, 'Give the month as yyyy-mm').parse(req.query.month)
  company.get('/reports/gstr2b-reconciliation', async (req, res) => res.json(await reconcile2b(cid(req), month(req), reg(req))))
  company.get('/reports/gstr1-reconciliation', async (req, res) => res.json(await reconcileGstr1(cid(req), month(req), reg(req))))
  /** IMS: [{ id, action: Accepted | Rejected | Pending }] for GSTR-2B documents */
  company.put('/gst/ims', async (req, res) => {
    await setImsActions(cid(req), z.array(z.object({ id: z.number().int(), action: z.enum(['Accepted', 'Rejected', 'Pending']) })).parse(req.body))
    res.status(204).end()
  })
  company.get('/reports/gst-advances', async (req, res) => {
    const p = await period(req)
    res.json({ ...p, ...(await gstAdvances(cid(req), p, reg(req))) })
  })
  const fy = (req: Request) => z.string().regex(/^\d{4}-\d{2}-01$/, 'Give the first day of the financial year').parse(req.query.fy)
  company.get('/reports/gstr9', async (req, res) => res.json(await gstr9(cid(req), fy(req), reg(req))))
  company.get('/reports/cmp08', async (req, res) =>
    res.json(await cmp08(cid(req), fy(req), z.coerce.number().int().min(1).max(4).parse(req.query.quarter) as 1 | 2 | 3 | 4)))
  company.get('/reports/gstr4', async (req, res) => res.json(await gstr4(cid(req), fy(req))))
  company.get('/reports/gst-challans', async (req, res) => {
    const p = await period(req)
    res.json({ ...p, ...(await gstChallanReconciliation(cid(req), p)) })
  })
  company.put('/gst-challans', async (req, res) => {
    const challan = z.object({ cpin: z.string().trim(), cin: z.string().trim().nullish().transform((c) => c || null), depositDate: z.string() }).nullable()
    await setGstChallans(cid(req), z.array(z.object({ voucherId: z.number().int(), challan })).parse(req.body))
    res.status(204).end()
  })
  company.get('/gst-parties', async (req, res) => res.json(await gstParties(cid(req))))
  company.put('/gst-parties', async (req, res) => {
    await setGstParties(cid(req), z.array(z.object({ ledgerId: z.number().int(), gstin: z.string().nullish().transform((g) => g ?? null), state: z.string().nullish().transform((s) => s ?? null) })).parse(req.body))
    res.status(204).end()
  })

  /** GSTR-1 for the portal's offline upload; the period must be one calendar month. */
  company.get('/reports/gstr1.json', async (req, res) => {
    const p = await period(req)
    const c = await registration(cid(req))
    const month = p.from.slice(0, 7)
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10)
    if (p.from !== `${month}-01` || p.to !== last) throw new ValidationError(['Choose one whole month as the period (Alt+F2) for the GSTR-1 file'])
    const fp = `${month.slice(5, 7)}${month.slice(0, 4)}`
    const r = reg(req)
    const gstin = r ? (await registrationOf(cid(req), r)).gstin! : c.gstin!
    const body = gstr1Json(gstr1(await gstVouchers(cid(req), p, r), await issued(cid(req), p, r), r ? [] : await amendedVouchers(cid(req), p)), gstin, fp)
    res.setHeader('content-disposition', `attachment; filename="GSTR1_${gstin}_${fp}.json"`)
    res.json(body)
  })
}
