/**
 * Tally-compatible XML over HTTP, so existing Tally integrations can talk to this server.
 * Request/response shapes follow Tally's published XML integration format:
 *   ENVELOPE > HEADER > TALLYREQUEST  ("Import Data" | "Export Data" | "Import" | "Export")
 * Amount sign in Tally XML is the reverse of ours: a negative AMOUNT / OPENINGBALANCE is a Debit.
 */
import express from 'express'
import { XMLParser } from 'fast-xml-parser'
import { pool } from '../db'
import { createCostCategory, createCostCentre } from '../costcentres'
import {
  alterVoucher,
  createLedgers,
  fyEnd,
  getCompany,
  ledgerBalances,
  loadGroups,
  loadLedgers,
  pendingBills,
  postVouchers,
  ValidationError,
  type LedgerInput,
} from '../books'
import { toPaise } from '../engine/money'
import { parseRate } from '../engine/forex'
import { balanceSheet, profitAndLoss, trialBalance } from '../engine/reports'
import { isUnder } from '../engine/groups'
import { isStockVoucher, VOUCHER_TYPES, type BillType, type VoucherInput, type VoucherType } from '../engine/voucher'
import { STOCK_DIRECTION, toMilli, type InventoryLine } from '../engine/inventory'
import { stateCode, type TaxType } from '../engine/gst'
import { isSecured } from '../security'
import { createGodown, createStockGroup, createStockItem, createUnit, stockPositions } from '../inventory'
import { UQC_CODES } from '../engine/gst-returns'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false, // keep "00012" and "20260401" as text
  trimValues: true,
  isArray: (name) =>
    [
      'TALLYMESSAGE', 'VOUCHER', 'LEDGER', 'ALLLEDGERENTRIES.LIST', 'LEDGERENTRIES.LIST', 'BILLALLOCATIONS.LIST',
      'UNIT', 'GODOWN', 'STOCKITEM', 'STOCKGROUP', 'ALLINVENTORYENTRIES.LIST', 'INVENTORYENTRIES.LIST',
      'BATCHALLOCATIONS.LIST', 'ACCOUNTINGALLOCATIONS.LIST',
      'COSTCATEGORY', 'COSTCENTRE', 'CATEGORYALLOCATIONS.LIST', 'COSTCENTREALLOCATIONS.LIST', 'BANKALLOCATIONS.LIST',
    ].includes(name),
})

type Node = Record<string, unknown>
const asText = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'object' ? String((v as Node)['#text'] ?? '') : String(v))
const list = (v: unknown): Node[] => (v === undefined ? [] : Array.isArray(v) ? (v as Node[]) : [v as Node])

export function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Our paise (+Dr) as a Tally XML amount (-Dr), e.g. 500000 -> "-5000.00". */
function tallyAmount(paise: number) {
  const v = -paise
  const abs = Math.abs(v)
  return `${v < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** Tally dates: "20260401", "1-Apr-2026" or "2026-04-01" -> "2026-04-01". */
export function tallyDate(s: string): string {
  const t = s.trim()
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(t) ?? /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/.exec(t)
  if (m) {
    const mon = MONTHS.indexOf(m[2].toLowerCase())
    if (mon >= 0) {
      const year = m[3].length === 2 ? `20${m[3]}` : m[3]
      return `${year}-${String(mon + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`
    }
  }
  throw new ValidationError([`Unrecognised date "${s}"`])
}
const compactDate = (iso: string) => iso.replace(/-/g, '')

function envelope(inner: string) {
  return `<ENVELOPE>\n${inner}\n</ENVELOPE>\n`
}

/** Resolve SVCURRENTCOMPANY by name; with no name, the only company on the server. */
async function resolveCompany(name: string) {
  const { rows } = name
    ? await pool.query<{ id: number }>(`SELECT id FROM companies WHERE lower(name) = lower($1)`, [name])
    : await pool.query<{ id: number }>(`SELECT id FROM companies`)
  if (rows.length !== 1)
    throw new ValidationError([name ? `Company "${name}" not found` : 'Name the company in SVCURRENTCOMPANY'])
  // the XML port has no sign-in, so a company with users is not served on it
  if (await isSecured(rows[0].id)) throw new ValidationError([`Company "${name}" has users and passwords; it is not served over XML`])
  return rows[0].id
}

interface Request {
  kind: 'import' | 'export'
  id: string // report or collection name
  vars: Record<string, string>
  messages: Node[]
}

function readRequest(xml: string): Request {
  let doc: Node
  try {
    doc = parser.parse(xml)
  } catch {
    throw new ValidationError(['Request is not well-formed XML'])
  }
  const env = doc.ENVELOPE as Node | undefined
  const header = env?.HEADER as Node | undefined
  if (!env || !header) throw new ValidationError(['Expected <ENVELOPE><HEADER>…'])
  const req = asText(header.TALLYREQUEST).toLowerCase()
  const body = (env.BODY ?? {}) as Node
  const kind = req.startsWith('import') ? 'import' : req.startsWith('export') ? 'export' : null
  if (!kind) throw new ValidationError([`Unsupported TALLYREQUEST "${asText(header.TALLYREQUEST)}"`])

  // two dialects: the newer HEADER/ID + BODY/DESC and the older BODY/EXPORTDATA|IMPORTDATA/REQUESTDESC
  const legacy = (body.IMPORTDATA ?? body.EXPORTDATA) as Node | undefined
  const desc = (legacy?.REQUESTDESC ?? body.DESC ?? {}) as Node
  const id = asText(header.ID) || asText(desc.REPORTNAME)
  const vars: Record<string, string> = {}
  for (const [k, v] of Object.entries((desc.STATICVARIABLES ?? {}) as Node)) vars[k.toUpperCase()] = asText(v)
  const data = (legacy?.REQUESTDATA ?? body.DATA ?? {}) as Node
  return { kind, id, vars, messages: list(data.TALLYMESSAGE) }
}

// ------------------------------------------------------------------ import

interface ImportTally {
  created: number
  altered: number
  errors: string[]
  lastVchId: number
}

async function importMessages(companyId: number, messages: Node[]): Promise<ImportTally> {
  const out: ImportTally = { created: 0, altered: 0, errors: [], lastVchId: 0 }
  // masters first so a voucher in the same request can use a ledger it creates
  await importInventoryMasters(companyId, messages, out)
  await importCostMasters(companyId, messages, out)
  await importLedgers(companyId, messages.flatMap((m) => list(m.LEDGER)), out)
  await importVouchers(companyId, messages.flatMap((m) => list(m.VOUCHER)), out)
  return out
}

/** Tally writes quantities with their unit: " 120.50 Kg" -> thousandths. */
const qtyOf = (s: string) => (s.trim() ? toMilli(s.trim().split(/\s+/)[0]) : 0)
/** "60.00/Kg" -> paise per unit. */
const rateOf = (s: string) => (s.trim() ? toPaise(s.trim().split('/')[0].trim()) : 0)

/** UNIT, GODOWN, STOCKGROUP and STOCKITEM masters, created one by one (each stands alone). */
async function importInventoryMasters(companyId: number, messages: Node[], out: ImportTally) {
  const each = async <T>(nodes: Node[], kind: string, create: (n: Node, name: string) => Promise<T>) => {
    for (const n of nodes) {
      const name = asText(n.NAME) || asText(n['@NAME'])
      try {
        await create(n, name)
        out.created++
      } catch (err) {
        out.errors.push(`${kind} "${name}": ${errMessage(err)}`)
      }
    }
  }
  const pick = async (sql: string, name: string, what: string) => {
    if (!name) return null
    const r = (await pool.query<{ id: number }>(sql, [companyId, name])).rows[0]
    if (!r) throw new ValidationError([`${what} "${name}" does not exist`])
    return r.id
  }
  // simple units first; a compound one (ISSIMPLEUNIT No) names its BASEUNITS, CONVERSION and ADDITIONALUNITS
  const units = messages.flatMap((m) => list(m.UNIT))
  const simple = (u: Node) => asText(u.ISSIMPLEUNIT) !== 'No'
  await each(units.filter(simple), 'Unit', (u, name) =>
    createUnit(companyId, {
      symbol: name, name: asText(u.ORIGINALNAME), decimals: Number(asText(u.DECIMALPLACES) || 0),
      // Tally keeps the GST unit as "NOS-NUMBERS"
      uqc: UQC_CODES.includes(asText(u.GSTREPUOM).slice(0, 3).toUpperCase()) ? asText(u.GSTREPUOM).slice(0, 3).toUpperCase() : null,
    }))
  await each(units.filter((u) => !simple(u)), 'Unit', async (u) =>
    createUnit(companyId, {
      symbol: '',
      firstUnitId: await pick(`SELECT id FROM units WHERE company_id = $1 AND lower(symbol) = lower($2)`, asText(u.BASEUNITS), 'Unit'),
      secondUnitId: await pick(`SELECT id FROM units WHERE company_id = $1 AND lower(symbol) = lower($2)`, asText(u.ADDITIONALUNITS), 'Unit'),
      conversion: Number(asText(u.CONVERSION)),
    }))
  await each(messages.flatMap((m) => list(m.GODOWN)), 'Godown', async (g, name) =>
    createGodown(companyId, { name, parentId: await pick(`SELECT id FROM godowns WHERE company_id = $1 AND lower(name) = lower($2)`, asText(g.PARENT), 'Godown') }))
  await each(messages.flatMap((m) => list(m.STOCKGROUP)), 'Stock group', async (g, name) =>
    createStockGroup(companyId, { name, parentId: await pick(`SELECT id FROM stock_groups WHERE company_id = $1 AND lower(name) = lower($2)`, asText(g.PARENT), 'Stock group') }))
  await each(messages.flatMap((m) => list(m.STOCKITEM)), 'Stock item', async (it, name) => {
    const parent = asText(it.PARENT)
    return createStockItem(companyId, {
      name,
      groupId: parent && parent !== 'Primary' ? await pick(`SELECT id FROM stock_groups WHERE company_id = $1 AND lower(name) = lower($2)`, parent, 'Stock group') : null,
      unitId: (await pick(`SELECT id FROM units WHERE company_id = $1 AND lower(symbol) = lower($2)`, asText(it.BASEUNITS), 'Unit'))!,
      openingQty: Math.abs(qtyOf(asText(it.OPENINGBALANCE))),
      // a negative OPENINGVALUE is a debit in Tally XML
      openingValue: Math.abs(asText(it.OPENINGVALUE) ? toPaise(asText(it.OPENINGVALUE)) : 0),
      reorderLevel: asText(it.REORDERBASE) ? Math.abs(qtyOf(asText(it.REORDERBASE))) : null,
      minOrderQty: asText(it.MINIMUMORDERBASE) ? Math.abs(qtyOf(asText(it.MINIMUMORDERBASE))) : null,
      ...gstOf(it),
    })
  })
}

/** COSTCATEGORY and COSTCENTRE masters (a centre names its CATEGORY and, if any, its PARENT). */
async function importCostMasters(companyId: number, messages: Node[], out: ImportTally) {
  const find = async (table: 'cost_categories' | 'cost_centres', name: string, what: string) => {
    if (!name || name === 'Primary') return null
    const r = (await pool.query<{ id: number }>(`SELECT id FROM ${table} WHERE company_id = $1 AND lower(name) = lower($2)`, [companyId, name])).rows[0]
    if (!r) throw new ValidationError([`${what} "${name}" does not exist`])
    return r.id
  }
  for (const [tag, kind] of [['COSTCATEGORY', 'Cost category'], ['COSTCENTRE', 'Cost centre']] as const)
    for (const n of messages.flatMap((m) => list(m[tag]))) {
      const name = asText(n.NAME) || asText(n['@NAME'])
      try {
        if (tag === 'COSTCATEGORY') await createCostCategory(companyId, { name })
        else
          await createCostCentre(companyId, {
            name,
            categoryId: await find('cost_categories', asText(n.CATEGORY) === 'Primary Cost Category' ? '' : asText(n.CATEGORY), 'Cost category'),
            parentId: await find('cost_centres', asText(n.PARENT), 'Cost centre'),
          })
        out.created++
      } catch (err) {
        out.errors.push(`${kind} "${name}": ${errMessage(err)}`)
      }
    }
}

/** Every value under `key`, at any depth (Tally nests GST details in several list levels). */
function findAll(node: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) for (const n of node) findAll(n, key, out)
  else if (node && typeof node === 'object')
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(...(Array.isArray(v) ? v : [v]))
      findAll(v, key, out)
    }
  return out
}

/** HSN/SAC and GST rate from a ledger's or item's GSTDETAILS (the integrated rate is the full rate). */
function gstOf(n: Node): { hsn?: string; gstRate?: number } {
  const hsn = findAll(n, 'HSNCODE').map(asText).find(Boolean)
  const igst = findAll(n, 'RATEDETAILS.LIST').find((r) => /integrated|igst/i.test(asText((r as Node).GSTRATEDUTYHEAD)))
  const rate = igst ? Number(asText((igst as Node).GSTRATE)) : NaN
  return { ...(hsn ? { hsn } : {}), ...(Number.isFinite(rate) && asText((igst as Node).GSTRATE) ? { gstRate: Math.round(rate * 100) } : {}) }
}

/**
 * A ledger's mailing details: TallyPrime nests them in LEDMAILINGDETAILS.LIST (older releases
 * keep them on the ledger), the address as ADDRESS lines.
 */
function mailingOf(l: Node) {
  const first = (key: string) => findAll(l, key).map(asText).find(Boolean) || undefined
  const address = findAll(l, 'ADDRESS').map(asText).filter(Boolean).join('\n') || undefined
  return {
    mailingName: first('MAILINGNAME'), address, pincode: first('PINCODE'),
    country: first('COUNTRYOFRESIDENCE') ?? first('COUNTRY') ?? first('COUNTRYNAME'),
    phone: first('LEDGERPHONE') ?? first('LEDGERMOBILE'), email: first('EMAIL'), pan: first('INCOMETAXNUMBER'),
  }
}

/** Tally's GST duty heads, as the tax a ledger holds. */
const DUTY_HEADS: Record<string, TaxType> = { 'integrated tax': 'IGST', 'central tax': 'CGST', 'state tax': 'SGST', 'ut tax': 'SGST', cess: 'Cess' }

/** Parse every LEDGER, then create the valid ones in one batch. */
async function importLedgers(companyId: number, nodes: Node[], out: ImportTally) {
  if (!nodes.length) return
  const groups = [...(await loadGroups(pool, companyId)).values()]
  const byName = new Map(groups.map((g) => [g.name.toLowerCase(), g.id]))
  const errors: (string | null)[] = []
  const inputs: { at: number; name: string; input: LedgerInput }[] = []
  nodes.forEach((l, at) => {
    const name = asText(l.NAME) || asText(l['@NAME'])
    try {
      const parent = asText(l.PARENT)
      const groupId = byName.get(parent.toLowerCase())
      if (!groupId) throw new ValidationError([`Group "${parent}" does not exist`])
      const opening = asText(l.OPENINGBALANCE)
      inputs.push({
        at,
        name,
        input: {
          name,
          groupId,
          opening: opening ? -toPaise(opening) : 0,
          gstin: asText(l.PARTYGSTIN) || undefined,
          // "Not Applicable" and foreign states are left out rather than refused
          state: stateCode(asText(l.LEDSTATENAME)) ? asText(l.LEDSTATENAME) : undefined,
          gstTaxType: asText(l.TAXTYPE) === 'GST' ? DUTY_HEADS[asText(l.GSTDUTYHEAD).toLowerCase()] : undefined,
          costCentres: asText(l.ISCOSTCENTRESON) === 'Yes',
          ...mailingOf(l),
          ...gstOf(l),
        },
      })
      errors[at] = null
    } catch (err) {
      errors[at] = `Ledger "${name}": ${errMessage(err)}`
    }
  })
  const results = await createLedgers(companyId, inputs.map((x) => x.input))
  results.forEach((r, k) => {
    if (r.ok) out.created++
    else errors[inputs[k].at] = `Ledger "${inputs[k].name}": ${r.errors.join('; ')}`
  })
  out.errors.push(...errors.filter((e): e is string => !!e))
}

/** Parse every VOUCHER; new ones post in one batch, ACTION="Alter" ones one by one. */
async function importVouchers(companyId: number, nodes: Node[], out: ImportTally) {
  if (!nodes.length) return
  const ledgers = new Map([...(await loadLedgers(pool, companyId)).values()].map((l) => [l.name.toLowerCase(), l.id]))
  const errors: (string | null)[] = []
  const creates: { at: number; label: string; input: VoucherInput }[] = []
  const alters: { at: number; label: string; input: VoucherInput; number: number }[] = []
  const refs = await stockRefs(companyId)
  const centres = new Map((await pool.query<{ id: number; name: string }>(`SELECT id, lower(name) "name" FROM cost_centres WHERE company_id = $1`, [companyId])).rows.map((c) => [c.name, c.id]))
  // ledgers kept in a foreign currency: their lines carry "$ 100.00 @ ₹ 83.00/$ = ₹ 8300.00"
  const currencyOf = new Map((await pool.query<{ id: number; decimals: number }>(
    `SELECT l.id, c.decimals FROM ledgers l JOIN currencies c ON c.id = l.currency_id WHERE l.company_id = $1`, [companyId])).rows.map((r) => [r.id, r.decimals]))
  nodes.forEach((v, at) => {
    const type = (asText(v.VOUCHERTYPENAME) || asText(v['@VCHTYPE'])) as VoucherType
    const label = `${type} ${asText(v.VOUCHERNUMBER) || asText(v.DATE)}`
    try {
      if (!VOUCHER_TYPES.includes(type)) throw new ValidationError([`Voucher type "${type}" does not exist`])
      const lines = [...list(v['ALLLEDGERENTRIES.LIST']), ...list(v['LEDGERENTRIES.LIST'])]
      const entries = lines.map((e) => {
        const n = asText(e.LEDGERNAME)
        const ledgerId = ledgers.get(n.toLowerCase())
        if (!ledgerId) throw new ValidationError([`Ledger "${n}" does not exist`])
        // Tally's bill-wise details: BILLALLOCATIONS.LIST under the ledger line, same sign rule
        const bills = list(e['BILLALLOCATIONS.LIST']).map((x) => ({
          type: (asText(x.BILLTYPE) || 'New Ref') as BillType,
          name: asText(x.NAME) || undefined,
          amount: -toPaise(asText(x.AMOUNT)),
        }))
        // cost centres: CATEGORYALLOCATIONS.LIST > COSTCENTREALLOCATIONS.LIST, same sign rule
        const costs = list(e['CATEGORYALLOCATIONS.LIST']).flatMap((k) =>
          list(k['COSTCENTREALLOCATIONS.LIST']).map((c) => {
            const centreId = centres.get(asText(c.NAME).toLowerCase())
            if (!centreId) throw new ValidationError([`Cost centre "${asText(c.NAME)}" does not exist`])
            return { centreId, amount: -toPaise(asText(c.AMOUNT)) }
          }),
        )
        // a bank line's instrument: BANKALLOCATIONS.LIST > INSTRUMENTNUMBER / INSTRUMENTDATE
        const bank = list(e['BANKALLOCATIONS.LIST'])[0]
        const chequeNo = bank ? asText(bank.INSTRUMENTNUMBER) : ''
        const chequeDate = bank && asText(bank.INSTRUMENTDATE) ? tallyDate(asText(bank.INSTRUMENTDATE)) : ''
        const fx = forexAmount(asText(e.AMOUNT))
        const amount = -toPaise(fx ? fx.rupees : asText(e.AMOUNT))
        const decimals = currencyOf.get(ledgerId)
        const forex = fx && decimals !== undefined && parseRate(fx.rate)
          ? { forex: Math.sign(amount) * Math.round(Math.abs(Number(fx.forex)) * 10 ** decimals), forexRate: parseRate(fx.rate)! }
          : {}
        return {
          ledgerId, amount, ...(bills.length ? { bills } : {}), ...(costs.length ? { costs } : {}),
          ...(chequeNo ? { chequeNo } : {}), ...(chequeDate ? { chequeDate } : {}), ...forex,
        }
      })
      // an item invoice: items in ALLINVENTORYENTRIES.LIST, each naming the sales/purchase ledger
      // it is booked to in ACCOUNTINGALLOCATIONS.LIST; those become ledger entries here
      // a Stock Journal lists what it consumes (OUT) and produces (IN) separately
      const journal = type === 'Stock Journal'
      const itemNodes = journal
        ? [...list(v['INVENTORYENTRIESOUT.LIST']).map((it) => ({ it, dir: -1 as const })), ...list(v['INVENTORYENTRIESIN.LIST']).map((it) => ({ it, dir: 1 as const }))]
        : [...list(v['ALLINVENTORYENTRIES.LIST']), ...list(v['INVENTORYENTRIES.LIST'])].map((it) => ({ it, dir: STOCK_DIRECTION[type] }))
      const inventory: InventoryLine[] = []
      if (itemNodes.length) {
        if (type === 'Physical Stock') throw new ValidationError(['Physical Stock is not imported over XML; enter the count in the app'])
        for (const { it, dir } of itemNodes) {
          if (!dir) throw new ValidationError([`A ${type} voucher cannot carry stock items`])
          const n = asText(it.STOCKITEMNAME)
          const itemId = refs.items.get(n.toLowerCase())
          if (!itemId) throw new ValidationError([`Stock item "${n}" does not exist`])
          const alloc = list(it['BATCHALLOCATIONS.LIST'])[0]
          const godownName = asText(alloc?.GODOWNNAME)
          const godownId = godownName ? refs.godowns.get(godownName.toLowerCase()) : refs.defaultGodown
          if (!godownId) throw new ValidationError([`Godown "${godownName}" does not exist`])
          const amount = Math.abs(toPaise(asText(it.AMOUNT) || '0'))
          // Tally names the batch of an item not kept in batches "Primary Batch"
          const batch = asText(alloc?.BATCHNAME)
          const mfgDate = asText(alloc?.MFDON)
          const expiryDate = asText(alloc?.EXPIRYPERIOD)
          inventory.push({
            itemId, godownId, qty: dir * Math.abs(itemQty(asText(it.ACTUALQTY) || asText(it.BILLEDQTY), refs.compound.get(itemId))), rate: rateOf(asText(it.RATE)), amount: dir * amount,
            ...(batch && batch !== 'Primary Batch' ? { batch } : {}),
            ...(mfgDate ? { mfgDate: tallyDate(mfgDate) } : {}), ...(expiryDate ? { expiryDate: tallyDate(expiryDate) } : {}),
          })
          for (const a of list(it['ACCOUNTINGALLOCATIONS.LIST'])) {
            const ln = asText(a.LEDGERNAME)
            const ledgerId = ledgers.get(ln.toLowerCase())
            if (!ledgerId) throw new ValidationError([`Ledger "${ln}" does not exist`])
            const amt = -toPaise(asText(a.AMOUNT))
            const same = entries.find((e) => e.ledgerId === ledgerId && !('bills' in e))
            if (same) same.amount += amt
            else entries.push({ ledgerId, amount: amt })
          }
        }
      }
      // an order or note names its party in PARTYLEDGERNAME; it has no ledger entries of its own
      let partyId: number | undefined
      if (isStockVoucher(type) && STOCK_DIRECTION[type]) {
        const pn = asText(v.PARTYLEDGERNAME)
        partyId = ledgers.get(pn.toLowerCase())
        if (!partyId) throw new ValidationError([pn ? `Ledger "${pn}" does not exist` : `A ${type} needs PARTYLEDGERNAME`])
      }
      const input: VoucherInput = {
        type, date: tallyDate(asText(v.DATE)), narration: asText(v.NARRATION), entries, ...(inventory.length ? { inventory } : {}),
        ...(partyId ? { partyId } : {}),
        ...(asText(v.ISPOSTDATED) === 'Yes' ? { postDated: true } : {}),
        ...(asText(v.ISOPTIONAL) === 'Yes' ? { optional: true } : {}),
        ...(asText(v.COSTTRACKNAME) ? { costTrack: asText(v.COSTTRACKNAME) } : {}),
        ...(asText(v.APPLICABLEUPTO) ? { applicableUpto: tallyDate(asText(v.APPLICABLEUPTO)) } : {}),
      }
      const number = Number(asText(v.VOUCHERNUMBER))
      if (asText(v['@ACTION']).toLowerCase() === 'alter' && number) alters.push({ at, label, input, number })
      else creates.push({ at, label, input })
      errors[at] = null
    } catch (err) {
      errors[at] = `Voucher ${label}: ${errMessage(err)}`
    }
  })

  const results = await postVouchers(companyId, creates.map((c) => c.input))
  results.forEach((r, k) => {
    if (r.ok) {
      out.created++
      out.lastVchId = r.id
    } else errors[creates[k].at] = `Voucher ${creates[k].label}: ${r.errors.join('; ')}`
  })

  for (const a of alters) {
    try {
      const { rows } = await pool.query<{ id: number }>(
        `SELECT id FROM vouchers WHERE company_id = $1 AND type = $2 AND number = $3`,
        [companyId, a.input.type, a.number],
      )
      if (!rows[0]) throw new ValidationError([`${a.input.type} No. ${a.number} does not exist`])
      await alterVoucher(companyId, rows[0].id, a.input)
      out.altered++
      out.lastVchId = rows[0].id
    } catch (err) {
      errors[a.at] = `Voucher ${a.label}: ${errMessage(err)}`
    }
  }
  out.errors.push(...errors.filter((e): e is string => !!e))
}

/** Stock items and godowns by lower-case name, for importing item invoices. */
async function stockRefs(companyId: number) {
  const items = (await pool.query<{ id: number; name: string }>(`SELECT id, name FROM stock_items WHERE company_id = $1`, [companyId])).rows
  const godowns = (await pool.query<{ id: number; name: string; is_default: boolean }>(`SELECT id, name, is_default FROM godowns WHERE company_id = $1`, [companyId])).rows
  // items in a compound unit (Box of 10 Nos): quantities come as "2 Box 5 Nos"
  const compound = (await pool.query<{ id: number; conversion: number; first: string; second: string }>(
    `SELECT s.id, u.conversion, f.symbol "first", n.symbol "second" FROM stock_items s JOIN units u ON u.id = s.unit_id
       JOIN units f ON f.id = u.first_unit_id JOIN units n ON n.id = u.second_unit_id WHERE s.company_id = $1`, [companyId])).rows
  return {
    compound: new Map(compound.map((c) => [c.id, c])),
    items: new Map(items.map((i) => [i.name.toLowerCase(), i.id])),
    godowns: new Map(godowns.map((g) => [g.name.toLowerCase(), g.id])),
    defaultGodown: godowns.find((g) => g.is_default)?.id,
  }
}

/**
 * A foreign-currency line's amount as Tally writes it, "-$ 100.00 @ ₹ 83.00/$ = -₹ 8300.00": the
 * foreign amount, the rate and the rupees (signed as an AMOUNT is); null for a plain amount.
 */
export function forexAmount(s: string) {
  const m = /^\s*(-?)\s*[^\d\s-]*\s*([\d,]+(?:\.\d+)?)\s*@\s*[^\d\s]*\s*([\d,]+(?:\.\d+)?)\s*\/[^=]*=\s*(-?)\s*[^\d\s-]*\s*([\d,]+(?:\.\d+)?)\s*$/.exec(s)
  if (!m) return null
  return { forex: `${m[1]}${m[2].replace(/,/g, '')}`, rate: m[3].replace(/,/g, ''), rupees: `${m[4]}${m[5].replace(/,/g, '')}` }
}

/** A quantity, in an item's compound unit as "2 Box 5 Nos" (or "2 Box", "25 Nos"), to thousandths of its second unit. */
export function itemQty(s: string, c?: { conversion: number; first: string; second: string }) {
  if (!c) return qtyOf(s)
  const two = /^\s*-?([\d.,]+)\s+(\S+)\s+([\d.,]+)\s+(\S+)\s*$/.exec(s)
  if (two) return toMilli(two[1].replace(/,/g, '')) * c.conversion + toMilli(two[3].replace(/,/g, ''))
  const one = /^\s*-?([\d.,]+)\s*(\S*)\s*$/.exec(s)
  if (!one) return qtyOf(s)
  const q = toMilli(one[1].replace(/,/g, ''))
  return one[2].toLowerCase() === c.first.toLowerCase() ? q * c.conversion : q
}

function errMessage(err: unknown) {
  if (err instanceof ValidationError) return err.errors.join('; ')
  return err instanceof Error ? err.message : String(err)
}

function importResponse(r: ImportTally) {
  return envelope(
    `<HEADER><VERSION>1</VERSION><STATUS>${r.errors.length && !r.created && !r.altered ? 0 : 1}</STATUS></HEADER>
<BODY><DATA><IMPORTRESULT>
<CREATED>${r.created}</CREATED><ALTERED>${r.altered}</ALTERED><DELETED>0</DELETED><LASTVCHID>${r.lastVchId}</LASTVCHID><LASTMID>0</LASTMID><COMBINED>0</COMBINED><IGNORED>0</IGNORED><ERRORS>${r.errors.length}</ERRORS><CANCELLED>0</CANCELLED>
${r.errors.map((e) => `<LINEERROR>${esc(e)}</LINEERROR>`).join('\n')}
</IMPORTRESULT></DATA></BODY>`,
  )
}

// ------------------------------------------------------------------ export

async function exportReport(companyId: number, id: string, vars: Record<string, string>) {
  const company = (await getCompany(pool, companyId))!
  const from = vars.SVFROMDATE ? tallyDate(vars.SVFROMDATE) : company.fyStart
  const to = vars.SVTODATE ? tallyDate(vars.SVTODATE) : fyEnd(company.fyStart)
  const key = id.toLowerCase()

  if (key === 'trial balance') {
    const tb = trialBalance(await loadGroups(pool, companyId), await ledgerBalances(pool, companyId, from, to))
    const row = (name: string, closing: number) =>
      `<DSPACCNAME><DSPDISPNAME>${esc(name)}</DSPDISPNAME></DSPACCNAME>
<DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA>${closing > 0 ? tallyAmount(closing) : ''}</DSPCLDRAMTA></DSPCLDRAMT><DSPCLCRAMT><DSPCLCRAMTA>${closing < 0 ? tallyAmount(closing) : ''}</DSPCLCRAMTA></DSPCLCRAMT></DSPACCINFO>`
    return envelope(
      [...tb.rows.map((r) => row(r.name, r.closing)), ...tb.primaryLedgers.map((l) => row(l.name, l.closing))].join('\n'),
    )
  }

  if (key === 'list of accounts' || key === 'ledger' || key === 'list of ledgers') {
    const groups = await loadGroups(pool, companyId)
    const balances = await ledgerBalances(pool, companyId, from, to)
    const gx = [...groups.values()]
      .map(
        (g) =>
          `<GROUP NAME="${esc(g.name)}"><NAME>${esc(g.name)}</NAME><PARENT>${g.parentId ? esc(groups.get(g.parentId)!.name) : ''}</PARENT><NATURE>${g.nature}</NATURE></GROUP>`,
      )
      .join('\n')
    const lx = balances
      .map(
        (b) =>
          `<LEDGER NAME="${esc(b.name)}"><NAME>${esc(b.name)}</NAME><PARENT>${b.groupId ? esc(groups.get(b.groupId)!.name) : ''}</PARENT><OPENINGBALANCE>${tallyAmount(b.opening)}</OPENINGBALANCE><CLOSINGBALANCE>${tallyAmount(b.stockValue ?? b.closing)}</CLOSINGBALANCE></LEDGER>`,
      )
      .join('\n')
    const inner = key === 'list of accounts' ? `${gx}\n${lx}` : lx
    return envelope(`<HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER>\n<BODY><DATA><COLLECTION>\n${inner}\n</COLLECTION></DATA></BODY>`)
  }

  // amounts as shown in the report, on their natural side
  const shown = (p: number) => (p / 100).toFixed(2)

  if (key === 'day book' || key === 'vouchers') {
    const { rows } = await pool.query(
      `SELECT v.type, COALESCE(v.doc_no, v.number::text) number, (SELECT name FROM voucher_types t WHERE t.id = v.voucher_type_id) "voucherType",
              to_char(v.date,'YYYYMMDD') date, v.narration, v.optional, v.post_dated "postDated", v.cost_track "costTrack", to_char(v.applicable_upto,'YYYYMMDD') "applicableUpto",
              (SELECT name FROM ledgers p WHERE p.id = v.party_ledger_id) party,
              CASE WHEN v.draft IS NULL
                   THEN COALESCE(json_agg(json_build_object('ledger', l.name, 'amount', e.amount, 'forex', e.forex, 'rate', e.forex_rate, 'currency', l.currency_id) ORDER BY e.line)
                                 FILTER (WHERE e.id IS NOT NULL), '[]')
                   ELSE (SELECT COALESCE(json_agg(json_build_object('ledger', d->>'ledger', 'amount', (d->>'amount')::bigint, 'forex', (d->>'forex')::bigint,
                                                                    'rate', (d->>'forexRate')::bigint, 'currency', (SELECT currency_id FROM ledgers WHERE id = (d->>'ledgerId')::int))), '[]')
                           FROM jsonb_array_elements(v.draft->'entries') d) END entries,
              (SELECT COALESCE(json_agg(json_build_object('item', s.name, 'unit', COALESCE((SELECT symbol FROM units WHERE id = u.second_unit_id), u.symbol), 'godown', g.name,
                                                          'conversion', u.conversion, 'first', (SELECT symbol FROM units WHERE id = u.first_unit_id),
                                                          'qty', i.qty, 'rate', i.rate, 'amount', i.amount,
                                                          'batch', i.batch, 'mfg', to_char(i.mfg, 'YYYYMMDD'), 'expiry', to_char(i.expiry, 'YYYYMMDD')) ORDER BY i.line), '[]')
                 FROM (SELECT line, item_id, godown_id, qty, rate, amount, batch, mfg_date mfg, expiry_date expiry FROM inventory_entries WHERE voucher_id = v.id
                       UNION ALL
                       SELECT n, (d->>'itemId')::int, (d->>'godownId')::int, (d->>'qty')::bigint, (d->>'rate')::bigint, (d->>'amount')::bigint, d->>'batch',
                              (d->>'mfgDate')::date, (d->>'expiryDate')::date
                         FROM jsonb_array_elements(v.draft->'inventory') WITH ORDINALITY x(d, n)) i
                 JOIN stock_items s ON s.id = i.item_id JOIN units u ON u.id = s.unit_id JOIN godowns g ON g.id = i.godown_id
                WHERE i.qty <> 0) items
         FROM vouchers v LEFT JOIN entries e ON e.voucher_id = v.id LEFT JOIN ledgers l ON l.id = e.ledger_id
        WHERE v.company_id = $1 AND v.date BETWEEN $2 AND $3 AND NOT v.cancelled
        GROUP BY v.id ORDER BY v.date, v.id`,
      [companyId, from, to],
    )
    type Item = { item: string; unit: string; godown: string; qty: number; rate: number; amount: number; batch: string | null; mfg: string | null; expiry: string | null
      conversion: number | null; first: string | null }
    const num = (q: number) => (q / 1000).toFixed(3).replace(/\.?0+$/, '')
    // a compound unit's quantity as "2 Box 5 Nos"
    const qty = (i: Item) => {
      const q = Math.abs(i.qty)
      if (!i.conversion || !i.first) return `${num(q)} ${esc(i.unit)}`
      const whole = Math.floor(q / (i.conversion * 1000))
      return `${whole} ${esc(i.first)} ${num(q - whole * i.conversion * 1000)} ${esc(i.unit)}`
    }
    const currencies = new Map((await pool.query<{ id: number; symbol: string; decimals: number }>(`SELECT id, symbol, decimals FROM currencies WHERE company_id = $1`, [companyId]))
      .rows.map((c) => [c.id, c]))
    type Line = { ledger: string; amount: number; forex: number | null; rate: number | null; currency: number | null }
    // a foreign-currency line: "-$ 100.00 @ ₹ 83.00/$ = -₹ 8300.00", signed as Tally signs an AMOUNT
    const amountOf = (e: Line) => {
      const c = e.currency ? currencies.get(e.currency) : undefined
      if (!c || !e.forex || !e.rate) return tallyAmount(e.amount)
      const neg = e.amount > 0 ? '-' : ''
      return `${neg}${c.symbol} ${(Math.abs(e.forex) / 10 ** c.decimals).toFixed(c.decimals)} @ ₹ ${(e.rate / 10000).toFixed(2)}/${c.symbol} = ${neg}₹ ${(Math.abs(e.amount) / 100).toFixed(2)}`
    }
    // an item line as Tally writes it; a Stock Journal lists what it consumes and produces apart
    const itemXml = (type: string, i: Item) => {
      const tag = type === 'Stock Journal' ? (i.qty < 0 ? 'INVENTORYENTRIESOUT.LIST' : 'INVENTORYENTRIESIN.LIST') : 'ALLINVENTORYENTRIES.LIST'
      return `<${tag}><STOCKITEMNAME>${esc(i.item)}</STOCKITEMNAME><ISDEEMEDPOSITIVE>${i.qty > 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><RATE>${shown(i.rate)}/${esc(i.unit)}</RATE>`
        + `<AMOUNT>${tallyAmount(i.amount)}</AMOUNT><ACTUALQTY>${qty(i)}</ACTUALQTY><BILLEDQTY>${qty(i)}</BILLEDQTY>`
        + `<BATCHALLOCATIONS.LIST><GODOWNNAME>${esc(i.godown)}</GODOWNNAME><BATCHNAME>${esc(i.batch ?? 'Primary Batch')}</BATCHNAME>`
        + `${i.mfg ? `<MFDON>${i.mfg}</MFDON>` : ''}${i.expiry ? `<EXPIRYPERIOD>${i.expiry}</EXPIRYPERIOD>` : ''}<ACTUALQTY>${qty(i)}</ACTUALQTY></BATCHALLOCATIONS.LIST></${tag}>`
    }
    const msgs = rows.map(
      (v: {
        type: string; number: string; voucherType: string | null; date: string; narration: string; optional: boolean; postDated: boolean; costTrack: string | null
        applicableUpto: string | null; party: string | null; entries: Line[]; items: Item[]
      }) =>
        `<TALLYMESSAGE><VOUCHER VCHTYPE="${esc(v.type)}"><DATE>${v.date}</DATE><VOUCHERTYPENAME>${esc(v.voucherType ?? v.type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${v.number}</VOUCHERNUMBER><NARRATION>${esc(v.narration)}</NARRATION>`
        + `${v.party ? `<PARTYLEDGERNAME>${esc(v.party)}</PARTYLEDGERNAME>` : ''}${v.optional ? '<ISOPTIONAL>Yes</ISOPTIONAL>' : ''}${v.postDated ? '<ISPOSTDATED>Yes</ISPOSTDATED>' : ''}`
        + `${v.costTrack ? `<COSTTRACKNAME>${esc(v.costTrack)}</COSTTRACKNAME>` : ''}${v.applicableUpto ? `<APPLICABLEUPTO>${v.applicableUpto}</APPLICABLEUPTO>` : ''}
${v.entries
  .map(
    (e) =>
      `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(e.ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${e.amount > 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${esc(amountOf(e))}</AMOUNT></ALLLEDGERENTRIES.LIST>`,
  )
  .join('\n')}
${v.type === 'Physical Stock' ? '' : v.items.map((i) => itemXml(v.type, i)).join('\n')}
</VOUCHER></TALLYMESSAGE>`,
    )
    return envelope(`<HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER>\n<BODY><DATA>\n${msgs.join('\n')}\n</DATA></BODY>`)
  }

  const data = (inner: string) => envelope(`<HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER>\n<BODY><DATA>\n${inner}\n</DATA></BODY>`)

  if (key === 'balance sheet') {
    const bs = balanceSheet(await loadGroups(pool, companyId), await ledgerBalances(pool, companyId, from, to))
    const row = (name: string, amount: number, side: 'Liabilities' | 'Assets') =>
      `<BSNAME><DSPACCNAME><DSPDISPNAME>${esc(name)}</DSPDISPNAME></DSPACCNAME></BSNAME><BSAMT><BSSUBAMT></BSSUBAMT><BSMAINAMT>${shown(amount)}</BSMAINAMT><BSSIDE>${side}</BSSIDE></BSAMT>`
    return data([
      ...bs.liabilities.map((x) => row(x.name, x.amount, 'Liabilities')),
      row('Profit & Loss A/c', bs.profitAndLoss.total, 'Liabilities'),
      ...(bs.openingDifference ? [row('Difference in opening balances', bs.openingDifference, 'Liabilities')] : []),
      ...bs.assets.map((x) => row(x.name, x.amount, 'Assets')),
    ].join('\n'))
  }

  if (key === 'profit and loss' || key === 'profit & loss a/c' || key === 'profit and loss a/c') {
    const pl = profitAndLoss(await loadGroups(pool, companyId), await ledgerBalances(pool, companyId, from, to))
    const row = (name: string, amount: number, side: 'Dr' | 'Cr') =>
      `<PLNAME><DSPACCNAME><DSPDISPNAME>${esc(name)}</DSPDISPNAME></DSPACCNAME></PLNAME><PLAMT><PLSUBAMT></PLSUBAMT><BSMAINAMT>${shown(amount)}</BSMAINAMT><PLSIDE>${side}</PLSIDE></PLAMT>`
    return data([
      row('Opening Stock', pl.openingStock, 'Dr'), ...pl.tradingDr.map((x) => row(x.name, x.amount, 'Dr')),
      row('Closing Stock', pl.closingStock, 'Cr'), ...pl.tradingCr.map((x) => row(x.name, x.amount, 'Cr')),
      row(pl.grossProfit >= 0 ? 'Gross Profit' : 'Gross Loss', Math.abs(pl.grossProfit), pl.grossProfit >= 0 ? 'Dr' : 'Cr'),
      ...pl.indirectExpenses.map((x) => row(x.name, x.amount, 'Dr')), ...pl.indirectIncomes.map((x) => row(x.name, x.amount, 'Cr')),
      row(pl.netProfit >= 0 ? 'Net Profit' : 'Net Loss', Math.abs(pl.netProfit), pl.netProfit >= 0 ? 'Dr' : 'Cr'),
    ].join('\n'))
  }

  if (key === 'stock summary') {
    const items = await stockPositions(pool, companyId, from, to)
    return data(items.map((i) =>
      `<DSPACCNAME><DSPDISPNAME>${esc(i.name)}</DSPDISPNAME></DSPACCNAME>
<DSPSTKINFO><DSPSTKCL><DSPCLQTY>${(i.closingQty / 1000).toFixed(3)} ${esc(i.unit)}</DSPCLQTY><DSPCLRATE>${shown(i.rate)}</DSPCLRATE><DSPCLAMTA>${shown(i.closingValue)}</DSPCLAMTA></DSPSTKCL></DSPSTKINFO>`).join('\n'))
  }

  if (key === 'ledger vouchers' || key === 'ledger outstandings') {
    const name = vars.LEDGERNAME ?? vars.SVLEDGERNAME ?? ''
    const ledger = (await pool.query<{ id: number }>(`SELECT id FROM ledgers WHERE company_id = $1 AND lower(name) = lower($2)`, [companyId, name])).rows[0]
    if (!ledger) throw new ValidationError([`Ledger "${name}" does not exist (send LEDGERNAME in STATICVARIABLES)`])
    const bal = (await ledgerBalances(pool, companyId, from, to)).find((b) => b.id === ledger.id)!
    const { rows } = await pool.query<{ date: string; type: string; number: string; amount: number; others: string }>(
      `SELECT to_char(v.date,'YYYYMMDD') date, v.type, COALESCE(v.doc_no, v.number::text) number, e.amount::float8 amount,
              (SELECT string_agg(l.name, ', ' ORDER BY o.line) FROM entries o JOIN ledgers l ON l.id = o.ledger_id WHERE o.voucher_id = v.id AND o.ledger_id <> $2) others
         FROM entries e JOIN vouchers v ON v.id = e.voucher_id
        WHERE v.company_id = $1 AND e.ledger_id = $2 AND v.date BETWEEN $3 AND $4 AND NOT v.cancelled ORDER BY v.date, v.id, e.line`,
      [companyId, ledger.id, from, to],
    )
    return data([
      `<LEDGERNAME>${esc(name)}</LEDGERNAME><OPENINGBALANCE>${tallyAmount(bal.opening)}</OPENINGBALANCE><CLOSINGBALANCE>${tallyAmount(bal.closing)}</CLOSINGBALANCE>`,
      ...rows.map((r) => `<DSPVCHDATE>${r.date}</DSPVCHDATE><DSPVCHLEDACCOUNT>${esc(r.others ?? '')}</DSPVCHLEDACCOUNT><DSPVCHTYPE>${esc(r.type)}</DSPVCHTYPE><DSPVCHNUMBER>${esc(r.number)}</DSPVCHNUMBER><DSPVCHDRAMT>${r.amount > 0 ? shown(r.amount) : ''}</DSPVCHDRAMT><DSPVCHCRAMT>${r.amount < 0 ? shown(-r.amount) : ''}</DSPVCHCRAMT>`),
    ].join('\n'))
  }

  if (key === 'bills receivable' || key === 'bills payable') {
    const groups = await loadGroups(pool, companyId)
    const ledgers = await loadLedgers(pool, companyId)
    const receivable = key === 'bills receivable'
    const bills = (await pendingBills(pool, companyId, to)).filter((b) => {
      const g = ledgers.get(b.ledgerId)?.groupId ?? null
      return g !== null && isUnder(groups, g, [receivable ? 'Sundry Debtors' : 'Sundry Creditors']) && (receivable ? b.pending > 0 : b.pending < 0)
    })
    const days = (d: string) => Math.max(0, Math.round((Date.parse(to) - Date.parse(d)) / 86_400_000))
    return data(bills.map((b) =>
      `<BILLFIXED><BILLDATE>${b.billDate.replace(/-/g, '')}</BILLDATE><BILLREF>${esc(b.name)}</BILLREF><BILLPARTY>${esc(b.ledger)}</BILLPARTY></BILLFIXED><BILLCL>${shown(Math.abs(b.pending))}</BILLCL><BILLDUE>${b.dueDate.replace(/-/g, '')}</BILLDUE><BILLOVERDUE>${b.dueDate < to ? days(b.dueDate) : 0}</BILLOVERDUE>`).join('\n'))
  }

  throw new ValidationError([`Report "${id}" is not available over XML`])
}

// ------------------------------------------------------------------ server

export async function handleXml(xml: string): Promise<string> {
  try {
    const r = readRequest(xml)
    const companyId = await resolveCompany(r.vars.SVCURRENTCOMPANY ?? '')
    if (r.kind === 'import') return importResponse(await importMessages(companyId, r.messages))
    return await exportReport(companyId, r.id, r.vars)
  } catch (err) {
    if (!(err instanceof ValidationError)) console.error(err)
    return envelope(`<HEADER><VERSION>1</VERSION><STATUS>0</STATUS></HEADER>\n<BODY><DATA><LINEERROR>${esc(errMessage(err))}</LINEERROR></DATA></BODY>`)
  }
}

export function createXmlApp() {
  const app = express()
  app.disable('x-powered-by')
  // Tally clients often send text/xml, application/xml or no type at all
  app.use(express.text({ type: () => true, limit: '20mb' }))
  app.get('/', (_req, res) => res.type('text/xml').send('<RESPONSE>Saral Server is Running</RESPONSE>'))
  app.post('/', async (req, res) => {
    res.type('text/xml; charset=utf-8').send(await handleXml(typeof req.body === 'string' ? req.body : ''))
  })
  return app
}
