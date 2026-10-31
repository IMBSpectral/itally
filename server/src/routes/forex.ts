/**
 * Multi-currency: currency masters, Rates of Exchange by date, the Forex Gain/Loss report and the
 * Journal that adjusts it.
 */
import type { Router, Request } from 'express'
import { z } from 'zod'
import { pool } from '../db'
import { getVoucher } from '../books'
import { adjustForex, alterCurrency, createCurrency, deleteCurrency, forexGainLoss, listCurrencies, ratesOn, setRates } from '../forex'

type Period = { from: string; to: string }

const currency = z.object({
  symbol: z.string(),
  name: z.string(),
  decimals: z.number().int().default(2),
  decimalName: z.string().nullish().transform((v) => v || null),
})
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use yyyy-mm-dd')
const rate = z.number().int().nullable()

export function addForexRoutes(company: Router, cid: (req: Request) => number, period: (req: Request) => Promise<Period>) {
  company.get('/currencies', async (req, res) => res.json(await listCurrencies(pool, cid(req))))
  company.post('/currencies', async (req, res) => res.status(201).json({ id: await createCurrency(cid(req), currency.parse(req.body)) }))
  company.put('/currencies/:id', async (req, res) => {
    await alterCurrency(cid(req), Number(req.params.id), currency.parse(req.body))
    res.status(204).end()
  })
  company.delete('/currencies/:id', async (req, res) => {
    await deleteCurrency(cid(req), Number(req.params.id))
    res.status(204).end()
  })

  /** Rates in force on ?date= (default: the end of the period) for every currency. */
  company.get('/rates', async (req, res) => {
    const d = req.query.date ? date.parse(req.query.date) : (await period(req)).to
    res.json(await ratesOn(pool, cid(req), d))
  })
  company.put('/rates', async (req, res) => {
    const b = z.object({ date, rates: z.array(z.object({ currencyId: z.number().int(), standard: rate, selling: rate, buying: rate })) }).parse(req.body)
    await setRates(cid(req), b.date, b.rates)
    res.status(204).end()
  })

  /** Unadjusted forex gain or loss as on ?asOf= (default: the end of the period). */
  company.get('/reports/forex-gain-loss', async (req, res) => {
    const asOf = req.query.asOf ? date.parse(req.query.asOf) : (await period(req)).to
    res.json(await forexGainLoss(pool, cid(req), asOf))
  })
  company.post('/forex/adjust', async (req, res) => {
    const b = z.object({ date, ledgerId: z.number().int() }).parse(req.body)
    const r = await adjustForex(cid(req), b.date, b.ledgerId)
    res.status(201).json(await getVoucher(pool, cid(req), r.id))
  })
}
