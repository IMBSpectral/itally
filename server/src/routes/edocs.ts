/**
 * e-Invoice and e-Way Bill: the register of vouchers that need them, each voucher's document and
 * problems, the JSON files the portals take by upload, and what the portals gave back.
 */
import type { Router, Request } from 'express'
import { z } from 'zod'
import { ValidationError } from '../books'
import { eDocRegister, edocInput, edocStatus, EINVOICE_TYPES, saveEDocument } from '../edocs'
import { einvoiceJson, einvoiceProblems, ewayBill, ewayBillFile, ewayProblems } from '../engine/edocs'
import { cancelEwayBill, cancelIrn, generateEwayBill, generateIrn, gspLog, gspSettings, setGspSettings, testGsp, updateVehicle } from '../gsp'
import { getCompany } from '../books'
import { pool } from '../db'

type Period = { from: string; to: string }
const text = z.string().nullish()
const transport = z.object({
  mode: z.enum(['1', '2', '3', '4']),
  distance: z.number().int(),
  transporterId: text,
  transporterName: text,
  vehicleNo: text,
  vehicleType: z.enum(['R', 'O']).optional(),
  docNo: text,
  docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
})
const update = z.object({
  transport: transport.nullish(),
  irn: text, ackNo: text, ackDate: text, signedQr: text, irnCancelled: z.boolean().optional(), ewbNo: text, ewbDate: text, ewbValidUpto: text,
})
const ids = (req: Request) => z.array(z.coerce.number().int().positive()).min(1, 'Choose the vouchers').parse(String(req.query.ids ?? '').split(',').filter(Boolean))

export function addEDocRoutes(company: Router, cid: (req: Request) => number, period: (req: Request) => Promise<Period>) {
  company.get('/e-documents', async (req, res) => res.json({ ...(await period(req)), vouchers: await eDocRegister(cid(req), await period(req)) }))

  company.get('/vouchers/:id/e-document', async (req, res) => {
    const { input, record } = await edocInput(cid(req), Number(req.params.id))
    const status = edocStatus(input, record)
    res.json({
      input, record, ...status,
      einvoiceJson: status.einvoice.problems.length ? null : einvoiceJson(input),
      ewayJson: status.eway.problems.length ? null : ewayBillFile([ewayBill(input)]),
    })
  })

  company.put('/vouchers/:id/e-document', async (req, res) => {
    res.json(await saveEDocument(cid(req), Number(req.params.id), update.parse(req.body)))
  })

  /** The IRP's upload: an array of e-Invoices. Refused, with the reasons, if any voucher isn't ready. */
  company.get('/e-invoice.json', async (req, res) => {
    const docs = []
    const errors: string[] = []
    for (const id of ids(req)) {
      const { input } = await edocInput(cid(req), id)
      const problems = (EINVOICE_TYPES as readonly string[]).includes(input.type) ? einvoiceProblems(input) : ['not a sale or a note']
      if (problems.length) errors.push(...problems.map((p) => `${input.type} No. ${input.number}: ${p}`))
      else docs.push(einvoiceJson(input))
    }
    if (errors.length) throw new ValidationError(errors)
    res.setHeader('content-disposition', `attachment; filename="e-invoice-${new Date().toISOString().slice(0, 10)}.json"`)
    res.json(docs)
  })

  // ---------------------------------------------------------------- through the API (GSP or NIC)
  const reason = z.enum(['1', '2', '3', '4'])
  company.get('/gsp/settings', async (req, res) => res.json(await gspSettings(cid(req))))
  company.put('/gsp/settings', async (req, res) => {
    const b = z.object({
      environment: z.enum(['sandbox', 'production']), einvoiceBase: z.string(), ewayBase: z.string(), clientId: z.string(), clientSecret: z.string().optional(),
      einvoiceUser: z.string(), einvoicePassword: z.string().optional(), ewayUser: z.string().nullish(), ewayPassword: z.string().nullish(),
      publicKey: z.string(), ewayPublicKey: z.string().nullish(), extraHeaders: z.record(z.string(), z.string()).optional(),
    }).parse(req.body)
    await setGspSettings(cid(req), b)
    res.status(204).end()
  })
  company.post('/gsp/test', async (req, res) => {
    const c = (await getCompany(pool, cid(req)))!
    if (!c.gstin) throw new ValidationError(['Set the company GSTIN first'])
    res.json(await testGsp(cid(req), c.gstin))
  })
  company.get('/gsp/log', async (req, res) => res.json(await gspLog(cid(req))))
  company.post('/vouchers/:id/irn', async (req, res) => res.json(await generateIrn(cid(req), Number(req.params.id))))
  company.post('/vouchers/:id/irn/cancel', async (req, res) => {
    const b = z.object({ reason, remark: z.string().default('') }).parse(req.body)
    res.json(await cancelIrn(cid(req), Number(req.params.id), b.reason, b.remark))
  })
  company.post('/vouchers/:id/ewb', async (req, res) => res.json(await generateEwayBill(cid(req), Number(req.params.id))))
  company.post('/vouchers/:id/ewb/cancel', async (req, res) => {
    const b = z.object({ reason, remark: z.string().default('') }).parse(req.body)
    res.json(await cancelEwayBill(cid(req), Number(req.params.id), b.reason, b.remark))
  })
  company.post('/vouchers/:id/ewb/vehicle', async (req, res) => {
    const b = z.object({ vehicleNo: z.string().min(4), fromPlace: z.string().min(1), fromState: z.string().regex(/^\d{1,2}$/), reason, remark: z.string().default('') }).parse(req.body)
    res.json(await updateVehicle(cid(req), Number(req.params.id), b))
  })
  /** Generate the IRNs (and, where due, e-Way Bills) of many vouchers; each succeeds or fails on its own. */
  company.post('/e-documents/generate', async (req, res) => {
    const b = z.object({ ids: z.array(z.number().int().positive()).min(1), what: z.enum(['irn', 'ewb']) }).parse(req.body)
    const out = []
    for (const id of b.ids) {
      try {
        out.push({ id, ok: true, record: b.what === 'irn' ? await generateIrn(cid(req), id) : await generateEwayBill(cid(req), id) })
      } catch (e) {
        out.push({ id, ok: false, errors: (e as ValidationError).errors ?? [String(e)] })
      }
    }
    res.json(out)
  })

  /** The e-Way Bill portal's bulk upload. */
  company.get('/e-way-bill.json', async (req, res) => {
    const bills = []
    const errors: string[] = []
    for (const id of ids(req)) {
      const { input } = await edocInput(cid(req), id)
      const problems = ewayProblems(input)
      if (problems.length) errors.push(...problems.map((p) => `${input.type} No. ${input.number}: ${p}`))
      else bills.push(ewayBill(input))
    }
    if (errors.length) throw new ValidationError(errors)
    res.setHeader('content-disposition', `attachment; filename="e-way-bill-${new Date().toISOString().slice(0, 10)}.json"`)
    res.json(ewayBillFile(bills))
  })
}
