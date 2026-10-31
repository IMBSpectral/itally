/**
 * e-Invoice and e-Way Bill: the register of vouchers that need them, each voucher's document and
 * problems, the JSON files the portals take by upload, and what the portals gave back.
 */
import type { Router, Request } from 'express'
import { z } from 'zod'
import { ValidationError } from '../books'
import { eDocRegister, edocInput, edocStatus, EINVOICE_TYPES, saveEDocument } from '../edocs'
import { einvoiceJson, einvoiceProblems, ewayBill, ewayBillFile, ewayProblems } from '../engine/edocs'

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
