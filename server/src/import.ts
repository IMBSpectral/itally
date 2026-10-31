/**
 * Import from Excel (or CSV), as Tally's: ledgers, stock items or vouchers from a sheet whose first
 * row names the columns. Column names are matched loosely ("Opening Balance", "opening", "Op Bal").
 * Each master stands or falls on its own; vouchers are posted together, each checked on its own,
 * and every row that failed is reported with the sheet's row number.
 */
import { pool } from './db'
import { createLedgers, loadGroups, postVouchers, ValidationError, type LedgerInput } from './books'
import { createStockItem, createUnit, defaultGodown } from './inventory'
import { STOCK_DIRECTION, type InventoryLine } from './engine/inventory'
import { dateOf, readSheet, type Cell } from './sheet'
import { VOUCHER_TYPES, isStockVoucher, type VoucherInput, type VoucherType } from './engine/voucher'
import { toPaise } from './engine/money'

export type ImportKind = 'ledgers' | 'stock-items' | 'vouchers'

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const COLUMNS: Record<ImportKind, Record<string, string[]>> = {
  ledgers: {
    name: ['name', 'ledger', 'ledgername', 'particulars'], group: ['group', 'under', 'parent', 'groupname'], opening: ['opening', 'openingbalance', 'opbal', 'openingbal'],
    side: ['drcr', 'type', 'balancetype'], gstin: ['gstin', 'gstinuin', 'gstno'], state: ['state', 'statename'], pan: ['pan', 'itpan', 'panno'], address: ['address'],
    pincode: ['pincode', 'pin'], email: ['email', 'emailid'], phone: ['phone', 'mobile', 'phoneno', 'contactno'], creditDays: ['creditdays', 'creditperiod'],
  },
  'stock-items': {
    name: ['name', 'item', 'stockitem', 'itemname'], group: ['group', 'under', 'stockgroup'], unit: ['unit', 'units', 'uom'], qty: ['openingqty', 'qty', 'quantity', 'openingquantity'],
    rate: ['openingrate', 'rate'], value: ['openingvalue', 'value', 'amount'], hsn: ['hsn', 'hsnsac', 'hsncode'], gstRate: ['gstrate', 'gst', 'taxrate', 'gstrate%'],
    godown: ['godown', 'location'], batches: ['batches', 'batchwise', 'maintaininbatches'],
  },
  vouchers: {
    date: ['date', 'voucherdate', 'vchdate'], type: ['vouchertype', 'type', 'vchtype'], number: ['voucherno', 'vchno', 'number', 'voucher', 'voucherNumber'],
    ledger: ['ledger', 'particulars', 'ledgername', 'account'], debit: ['debit', 'dr', 'debitamount'], credit: ['credit', 'cr', 'creditamount'],
    amount: ['amount'], side: ['drcr'], narration: ['narration', 'remarks', 'description'],
    item: ['item', 'stockitem', 'itemname'], qty: ['qty', 'quantity'], rate: ['rate', 'itemrate'], godown: ['godown', 'location'],
    batch: ['batch', 'batchno', 'batchname'], mfgDate: ['mfgdate', 'mfg', 'manufactured', 'mfdon'], expiryDate: ['expiry', 'expirydate', 'expireson'],
  },
}

/** The sheet's rows as records keyed by our field names, with the sheet's row number. */
function records(kind: ImportKind, rows: Cell[][]) {
  const headAt = rows.findIndex((r) => r.some((c) => c !== null && String(c).trim()))
  if (headAt < 0) throw new ValidationError(['The sheet is empty'])
  const head = rows[headAt].map(norm)
  const col: Record<string, number> = {}
  for (const [field, names] of Object.entries(COLUMNS[kind])) {
    const i = head.findIndex((h) => names.map(norm).includes(h))
    if (i >= 0) col[field] = i
  }
  const need = kind === 'vouchers' ? ['date'] : kind === 'ledgers' ? ['name', 'group'] : ['name', 'unit']
  const missing = need.filter((f) => !(f in col))
  if (missing.length) throw new ValidationError([`The first row must name the columns; missing: ${missing.join(', ')} (see the template)`])
  return rows
    .slice(headAt + 1)
    .map((r, i) => ({ row: headAt + i + 2, get: (f: string) => (f in col ? (r[col[f]] ?? null) : null), blank: !r.some((c) => c !== null && String(c).trim()) }))
    .filter((r) => !r.blank)
}

const money = (x: Cell) => {
  if (x === null || x === '') return 0
  if (typeof x === 'number') return Math.round(x * 100)
  return toPaise(String(x).replace(/,/g, '').replace(/\s*(dr|cr)$/i, '').trim() || '0')
}
const text = (x: Cell) => (x === null ? '' : String(x).trim())

export interface ImportResult {
  kind: ImportKind
  rows: number
  created: number
  failed: { row: number; label: string; errors: string[] }[]
}

/** Import a sheet (an .xlsx or CSV file's bytes) of ledgers, stock items or vouchers. */
export async function importSheet(companyId: number, kind: ImportKind, file: Buffer): Promise<ImportResult> {
  const recs = records(kind, readSheet(file))
  if (kind === 'ledgers') return importLedgers(companyId, recs)
  if (kind === 'stock-items') return importItems(companyId, recs)
  return importVouchers(companyId, recs)
}

type Rec = ReturnType<typeof records>[number]

async function importLedgers(companyId: number, recs: Rec[]): Promise<ImportResult> {
  const groups = await loadGroups(pool, companyId)
  const groupId = new Map([...groups.values()].map((g) => [g.name.toLowerCase(), g.id]))
  const failed: ImportResult['failed'] = []
  const inputs: { rec: Rec; input: LedgerInput }[] = []
  for (const r of recs) {
    const name = text(r.get('name'))
    try {
      const g = groupId.get(text(r.get('group')).toLowerCase())
      if (!g) throw new ValidationError([`Unknown group "${text(r.get('group'))}"`])
      const raw = r.get('opening')
      const cr = /cr/i.test(text(r.get('side'))) || /cr\s*$/i.test(text(raw))
      const amount = money(raw)
      const creditDays = text(r.get('creditDays'))
      inputs.push({
        rec: r,
        input: {
          name, groupId: g, opening: cr ? -Math.abs(amount) : amount, gstin: text(r.get('gstin')) || undefined, state: text(r.get('state')) || undefined,
          pan: text(r.get('pan')) || null, address: text(r.get('address')) || null, pincode: text(r.get('pincode')) || null, email: text(r.get('email')) || null,
          phone: text(r.get('phone')) || null, creditDays: creditDays ? Number(creditDays) : null,
        },
      })
    } catch (e) {
      failed.push({ row: r.row, label: name, errors: e instanceof ValidationError ? e.errors : [String((e as Error).message)] })
    }
  }
  const results = inputs.length ? await createLedgers(companyId, inputs.map((x) => x.input)) : []
  results.forEach((res, i) => {
    if (!res.ok) failed.push({ row: inputs[i].rec.row, label: inputs[i].input.name, errors: res.errors })
  })
  return { kind: 'ledgers', rows: recs.length, created: results.filter((r) => r.ok).length, failed: failed.sort((a, b) => a.row - b.row) }
}

async function importItems(companyId: number, recs: Rec[]): Promise<ImportResult> {
  const lookup = async (sql: string) => new Map((await pool.query<{ id: number; name: string }>(sql, [companyId])).rows.map((r) => [r.name.toLowerCase(), r.id]))
  const units = await lookup(`SELECT id, symbol AS name FROM units WHERE company_id = $1`)
  const stockGroups = await lookup(`SELECT id, name FROM stock_groups WHERE company_id = $1`)
  const godowns = await lookup(`SELECT id, name FROM godowns WHERE company_id = $1`)
  const main = await defaultGodown(pool, companyId)
  const failed: ImportResult['failed'] = []
  let created = 0
  for (const r of recs) {
    const name = text(r.get('name'))
    try {
      const unitName = text(r.get('unit'))
      // a unit not yet made is made, in whole numbers, as Tally's import does
      let unitId = units.get(unitName.toLowerCase())
      if (!unitId) units.set(unitName.toLowerCase(), (unitId = await createUnit(companyId, { symbol: unitName, name: unitName, decimals: 0 })))
      const groupName = text(r.get('group'))
      const groupId = groupName ? stockGroups.get(groupName.toLowerCase()) : null
      if (groupName && !groupId) throw new ValidationError([`Unknown stock group "${groupName}"`])
      const godownName = text(r.get('godown'))
      const godownId = godownName ? godowns.get(godownName.toLowerCase()) : main
      if (!godownId) throw new ValidationError([`Unknown godown "${godownName}"`])
      const qtyCell = r.get('qty')
      const qty = qtyCell === null ? 0 : Math.round(Number(String(qtyCell).replace(/,/g, '')) * 1000)
      if (!Number.isFinite(qty)) throw new ValidationError([`"${qtyCell}" is not a quantity`])
      const value = r.get('value') !== null ? money(r.get('value')) : Math.round((qty / 1000) * money(r.get('rate')))
      const gst = text(r.get('gstRate')).replace('%', '')
      await createStockItem(companyId, {
        name, unitId, groupId: groupId ?? null, openingQty: qty, openingValue: value, openingGodownId: godownId, hsn: text(r.get('hsn')) || null,
        gstRate: gst ? Math.round(Number(gst) * 100) : null, batches: /^(y|yes|true|1)$/i.test(text(r.get('batches'))),
      })
      created++
    } catch (e) {
      failed.push({ row: r.row, label: name, errors: e instanceof ValidationError ? e.errors : [String((e as Error).message)] })
    }
  }
  return { kind: 'stock-items', rows: recs.length, created, failed }
}

/**
 * Vouchers, a line per row: a row with a date (and type and number) starts a voucher, rows after it
 * with those blank, or the same, add its lines. Amounts go in Debit and Credit columns, or one
 * Amount column with Dr/Cr. A Sales or Purchase row can also name a stock item with its quantity
 * and rate (and godown, batch and the batch's dates); its value is quantity × rate.
 */
async function importVouchers(companyId: number, recs: Rec[]): Promise<ImportResult> {
  const ledgers = new Map((await pool.query<{ id: number; name: string }>(`SELECT id, name FROM ledgers WHERE company_id = $1`, [companyId])).rows.map((l) => [l.name.toLowerCase(), l.id]))
  const types = new Map(VOUCHER_TYPES.filter((t) => !isStockVoucher(t)).map((t) => [norm(t), t]))
  const items = new Map((await pool.query<{ id: number; name: string }>(`SELECT id, name FROM stock_items WHERE company_id = $1`, [companyId])).rows.map((i) => [i.name.toLowerCase(), i.id]))
  const godowns = new Map((await pool.query<{ id: number; name: string }>(`SELECT id, name FROM godowns WHERE company_id = $1`, [companyId])).rows.map((g) => [g.name.toLowerCase(), g.id]))
  const main = items.size ? await defaultGodown(pool, companyId) : 0
  type Building = {
    rows: Rec[]; key: string; date: string | null; type: VoucherType | null; narration: string; entries: { ledgerId: number; amount: number }[]; inventory: InventoryLine[]
    errors: string[]
  }
  const vouchers: Building[] = []
  let cur: Building | null = null
  for (const r of recs) {
    const d = r.get('date')
    const t = text(r.get('type'))
    const no = text(r.get('number'))
    const key = `${text(d)}|${t}|${no}`
    if (!cur || (d !== null && key !== cur.key)) {
      const date = dateOf(d)
      const type = types.get(norm(t || 'Journal')) ?? null
      cur = { rows: [], key, date, type, narration: '', entries: [], inventory: [], errors: [] }
      if (!date) cur.errors.push(d === null ? 'A voucher starts with its date' : `"${d}" is not a date`)
      if (!type) cur.errors.push(`"${t}" is not an accounting voucher type`)
      vouchers.push(cur)
    }
    cur.rows.push(r)
    const n = text(r.get('narration'))
    if (n && !cur.narration) cur.narration = n
    const itemName = text(r.get('item'))
    if (itemName) {
      const line = itemLine(r, itemName, cur.type)
      if (typeof line === 'string') cur.errors.push(`Row ${r.row}: ${line}`)
      else cur.inventory.push(line)
    }
    const ledgerName = text(r.get('ledger'))
    if (!ledgerName) continue
    const ledgerId = ledgers.get(ledgerName.toLowerCase())
    if (!ledgerId) {
      cur.errors.push(`Row ${r.row}: unknown ledger "${ledgerName}"`)
      continue
    }
    try {
      let amount = money(r.get('debit')) - money(r.get('credit'))
      if (!amount && r.get('amount') !== null) {
        const a = money(r.get('amount'))
        amount = /cr/i.test(text(r.get('side'))) || /cr\s*$/i.test(text(r.get('amount'))) ? -Math.abs(a) : a
      }
      if (!amount) cur.errors.push(`Row ${r.row}: no amount`)
      else cur.entries.push({ ledgerId, amount })
    } catch {
      cur.errors.push(`Row ${r.row}: the amount is not a number`)
    }
  }
  const failed: ImportResult['failed'] = []
  const ok = vouchers.filter((v) => !v.errors.length)
  for (const v of vouchers.filter((v) => v.errors.length)) failed.push({ row: v.rows[0].row, label: `${v.type ?? 'Voucher'} ${v.date ?? ''}`.trim(), errors: v.errors })
  const results = ok.length
    ? await postVouchers(companyId, ok.map((v): VoucherInput => ({ type: v.type!, date: v.date!, narration: v.narration, entries: v.entries, ...(v.inventory.length ? { inventory: v.inventory } : {}) })))
    : []
  results.forEach((res, i) => {
    if (!res.ok) failed.push({ row: ok[i].rows[0].row, label: `${ok[i].type} ${ok[i].date}`, errors: res.errors })
  })
  return { kind: 'vouchers', rows: recs.length, created: results.filter((r) => r.ok).length, failed: failed.sort((a, b) => a.row - b.row) }

  /** A row's stock item line, or what is wrong with it. */
  function itemLine(r: Rec, name: string, type: VoucherType | null): InventoryLine | string {
    const dir = type ? STOCK_DIRECTION[type] : undefined
    if (!dir) return `a ${type ?? 'voucher'} cannot carry stock items`
    const itemId = items.get(name.toLowerCase())
    if (!itemId) return `unknown stock item "${name}"`
    const godownName = text(r.get('godown'))
    const godownId = godownName ? godowns.get(godownName.toLowerCase()) : main
    if (!godownId) return `unknown godown "${godownName}"`
    const qty = Math.round(Math.abs(Number(String(r.get('qty') ?? '').replace(/,/g, ''))) * 1000)
    if (!qty) return `no quantity for ${name}`
    let rate: number
    try {
      rate = money(r.get('rate'))
    } catch {
      return 'the rate is not a number'
    }
    const dates: Record<string, string> = {}
    for (const f of ['mfgDate', 'expiryDate'] as const) {
      const d = r.get(f)
      if (d === null || text(d) === '') continue
      const iso = dateOf(d)
      if (!iso) return `"${d}" is not a date`
      dates[f] = iso
    }
    const batch = text(r.get('batch'))
    return { itemId, godownId, qty: dir * qty, rate, amount: dir * Math.round((qty / 1000) * rate), ...(batch ? { batch } : {}), ...dates }
  }
}
