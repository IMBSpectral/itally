import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useVoucherTypeFields } from './VoucherTypes'
import { newVoucherDate, useApp, voucherKey } from '../App'
import { api, ApiError, type Bill, type Cost, type Ledger, type PendingBill, type PendingLine, type PendingType, type TdsSuggestion, type Voucher } from '../api'
import { formatINR, toPaise } from '../../server/src/engine/money'
import { formatQty, LINKS, parseCompound, STOCK_DIRECTION, toMilli, valueOf } from '../../server/src/engine/inventory'
import { isStockVoucher, type VoucherType } from '../../server/src/engine/voucher'
import { AttendanceVoucher, PayrollVoucher } from './Payroll'
import { placeOfSupply, stateCode, stateName, suggestedTaxes, type GstContext } from '../../server/src/engine/gst'
import { DateInput, drcr, Errors, fmtDate, focusNext, Picker, Title, useActive, useConfirm, useLoad } from '../ui'
import { BillPanel, billSummary } from './BillPanel'
import { VoucherEntry } from './VoucherEntry'
import { StockVoucherEntry } from './StockVoucher'
import { defaultRate } from './Forex'
import { TdsHint } from './Tds'
import { BatchFields } from './BatchFields'
import { CostPanel, costSummary } from './CostPanel'
import { formatForex, formatRate, parseRate, toForex } from '../../server/src/engine/forex'

/** Tally's "End of List": the first choice in an item or ledger list, it closes that list. */
export const END = -1
export const plain = (p: number) => (p ? formatINR(p).replace(/,/g, '') : '')

export function parseMoney(a: string): number | null {
  if (!a.trim()) return null
  try {
    return toPaise(a)
  } catch {
    return null
  }
}
/** The unit facts a quantity field needs: decimals, and for a compound unit its conversion. */
type QtyUnit = { decimals?: number; perUnit?: string | null; conversion?: number | null } | undefined
/** A quantity as typed: "2.5", or in a compound unit "2-5" (2 Box 5 Nos), in thousandths of the counting unit. */
export function parseQty(a: string, u?: QtyUnit): number | null {
  if (!a.trim()) return null
  try {
    return u?.conversion ? parseCompound(a, { conversion: u.conversion }) : toMilli(a)
  } catch {
    return null
  }
}
/** A quantity as it goes back into a field (no grouping; "2-5" in a compound unit). */
export function qtyField(q: number, u?: QtyUnit): string {
  const abs = Math.abs(q)
  if (!u?.conversion) return formatQty(abs, u?.decimals ?? 3).replace(/,/g, '')
  const per = u.conversion * 1000
  const whole = Math.floor(abs / per)
  const rest = abs - whole * per
  return rest ? `${whole}-${formatQty(rest, u.decimals ?? 0).replace(/,/g, '')}` : String(whole)
}
export const today = () => new Date().toLocaleDateString('en-CA')

/** The voucher types that carry items, and the ledger group their items are booked to. */
const ITEM_LEDGER_GROUP: Partial<Record<VoucherType, string>> = {
  Sales: 'Sales Accounts',
  'Credit Note': 'Sales Accounts',
  Purchase: 'Purchase Accounts',
  'Debit Note': 'Purchase Accounts',
}
export const carriesItems = (t: VoucherType) => t in ITEM_LEDGER_GROUP

/**
 * Opens a voucher in the right mode. Sales, Purchase and the notes open as an item invoice once
 * the company has stock items (Ctrl+V switches between invoice and voucher mode, as in Tally);
 * an existing voucher opens as an invoice when it has item lines.
 */
export function VoucherScreen({ type, id, invoice }: { type: VoucherType; id?: number; invoice?: boolean }) {
  const { company } = useApp()
  const stock = isStockVoucher(type)
  const { data: mode } = useLoad(async () => {
    if (stock) return true
    if (invoice !== undefined) return invoice
    if (id) return !!(await api.voucher(company.id, id)).inventory?.length
    return carriesItems(type) && (await api.stockItems(company.id)).length > 0
  }, [company.id, type, id, invoice])
  if (type === 'Payroll') return <PayrollVoucher id={id} />
  if (type === 'Attendance') return <AttendanceVoucher id={id} />
  if (mode === null) return <p className="muted">Loading…</p>
  if (stock) return <StockVoucherEntry key={type} type={type} id={id} />
  return mode && carriesItems(type) ? <InvoiceEntry key={type} type={type} id={id} /> : <VoucherEntry type={type} id={id} />
}

interface ItemRow {
  itemId: number | null
  godownId: number | null
  qty: string
  rate: string
  amount: string
  orderId?: number | null // the order this line delivers
  trackingId?: number | null // the delivery/receipt note it bills
  against?: string | null // "Delivery Note No. 3", for the screen
  batch?: string // an item kept in batches
  mfgDate?: string
  expiryDate?: string
}
interface ExtraRow {
  ledgerId: number | null
  amount: string // + adds to the invoice (tax, freight), - takes off (discount)
}
const emptyItem = (godownId: number | null): ItemRow => ({ itemId: null, godownId, qty: '', rate: '', amount: '' })

/**
 * Item invoice (Tally's "As Invoice" mode): party, the sales or purchase ledger, item lines
 * (item, godown, quantity, rate, amount), then additional ledgers such as tax or freight.
 * The ledger entries are built from these; the party's bill-wise details open before narration.
 */
export function InvoiceEntry({ type, id }: { type: VoucherType; id?: number }) {
  const { company, period, push, pop, replace, changed, version, features, config } = useApp()
  const vtype = useVoucherTypeFields()
  const active = useActive()
  const [confirm, ask] = useConfirm()
  const formRef = useRef<HTMLFormElement>(null)
  const dateRef = useRef<HTMLInputElement>(null)
  const narrationRef = useRef<HTMLTextAreaElement>(null)
  const dir = STOCK_DIRECTION[type]!
  const itemGroup = ITEM_LEDGER_GROUP[type]!

  const { data: ledgers } = useLoad(() => api.ledgers(company.id, period), [company.id, period, version])
  const { data: items } = useLoad(() => api.stockItems(company.id), [company.id, version])
  const { data: godowns } = useLoad(() => api.godowns(company.id), [company.id, version])
  const mainGodown = godowns?.find((g) => g.isDefault)?.id ?? null
  const { data: gst } = useLoad(() => api.gstContext(company.id), [company.id, version])
  const gstCtx = useMemo<GstContext | null>(
    () =>
      gst && {
        companyGstin: gst.companyGstin,
        companyState: gst.companyState,
        ledgers: new Map(gst.ledgers.map((l) => [l.id, l])),
        items: new Map(gst.items.map((i) => [i.id, i])),
      },
    [gst],
  )
  const isTaxLine = (x: ExtraRow) => x.ledgerId !== null && !!gstCtx?.ledgers.get(x.ledgerId)?.taxType

  const [date, setDate] = useState(() => newVoucherDate(period, config))
  const [number, setNumber] = useState<number | string | null>(null)
  const [editVersion, setEditVersion] = useState<number | undefined>()
  const [partyId, setPartyId] = useState<number | null>(null)
  const [salesId, setSalesId] = useState<number | null>(null)
  // the sales (or purchase) ledger's split across cost centres, when it keeps them
  const [salesCosts, setSalesCosts] = useState<Cost[] | null>(null)
  const [costsOpen, setCostsOpen] = useState(false)
  const { data: costMasters } = useLoad(() => api.costMasters(company.id), [company.id, version])
  const [rows, setRows] = useState<ItemRow[]>([emptyItem(null)])
  const [extras, setExtras] = useState<ExtraRow[]>([])
  const [bills, setBills] = useState<Bill[] | null>(null)
  const [billFor, setBillFor] = useState<{ pending: PendingBill[]; defaultName: string } | null>(null)
  const [narration, setNarration] = useState('')
  const [refNo, setRefNo] = useState('') // a purchase: the supplier's invoice number and date (GSTR-2B matches on them)
  const [refDate, setRefDate] = useState('')
  const [costTrack, setCostTrack] = useState('') // F11 cost tracking: the job or consignment
  const [shipping, setShipping] = useState({ port: '', no: '', date: '' }) // an export's shipping bill
  const [optional, setOptional] = useState(false) // Ctrl+L: kept, but out of the books
  const [errors, setErrors] = useState<string[]>([])
  const [saved, setSaved] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<string | null>(null)
  const [fxRate, setFxRate] = useState('') // a party kept in a foreign currency: the invoice's rate of exchange
  const { data: rates } = useLoad(
    () => (features.multiCurrency ? api.rates(company.id, date) : Promise.resolve([])),
    [company.id, date, version, features.multiCurrency],
  )
  const snapshot = () => JSON.stringify({ date, partyId, salesId, rows, extras, bills, narration })
  // Tally's tracking: the party's notes still to be invoiced and orders still to be delivered
  const links = LINKS[type]
  const [docs, setDocs] = useState<PendingLine[]>([])
  const [againstId, setAgainstId] = useState<number | null>(null)
  useEffect(() => {
    if (!links || partyId === null) return setDocs([])
    const kinds = [links.note, links.order].filter(Boolean) as PendingType[]
    Promise.all(kinds.map((k) => api.pending(company.id, k, { partyId, excludeVoucher: id })))
      .then((rs) => {
        const lines = rs.flatMap((r) => r.lines)
        setDocs(lines)
        // offered right after the party, before the sales ledger (a new invoice only)
        if (lines.length && !id) focusIn('[data-field="against"] input')
      })
      .catch(() => setDocs([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id, partyId, id])

  const ledgerById = new Map((ledgers ?? []).map((l) => [l.id, l]))
  const itemById = new Map((items ?? []).map((s) => [s.id, s]))

  // altering: split the saved entries back into party, item ledger and additional ledgers
  useEffect(() => {
    if (!id || !ledgers) return
    api.voucher(company.id, id).then((v: Voucher) => {
      const isItemLedger = (lid: number) => ledgerById.get(lid)?.primaryGroup === itemGroup
      const sales = v.entries.find((e) => isItemLedger(e.ledgerId))
      const party = v.entries.find((e) => e !== sales && Math.sign(e.amount) === -dir) ?? v.entries.find((e) => e !== sales)
      const loadedRows = (v.inventory ?? []).map((l) => {
        const d = itemById.get(l.itemId)?.decimals ?? 3
        return { itemId: l.itemId, godownId: l.godownId, qty: qtyField(l.qty, itemById.get(l.itemId) ?? { decimals: d }), rate: plain(l.rate), amount: plain(Math.abs(l.amount)),
          orderId: l.orderId ?? null, trackingId: l.trackingId ?? null, against: l.against ?? null, batch: l.batch ?? '', mfgDate: l.mfgDate ?? '', expiryDate: l.expiryDate ?? '' }
      })
      const loadedExtras = v.entries.filter((e) => e !== sales && e !== party).map((e) => ({ ledgerId: e.ledgerId, amount: plain(e.amount * dir) }))
      setDate(v.date)
      setNumber(v.docNo ?? v.number)
      setEditVersion(v.version)
      setNarration(v.narration)
      setRefNo(v.refNo ?? '')
      setRefDate(v.refDate ?? '')
      setCostTrack(v.costTrack ?? '')
      setSalesCosts(sales?.costs?.length ? sales.costs : null)
      setShipping(v.shippingBill ?? { port: '', no: '', date: '' })
      setOptional(!!v.optional)
      setPartyId(party?.ledgerId ?? null)
      setSalesId(sales?.ledgerId ?? null)
      setRows(loadedRows.length ? loadedRows : [emptyItem(mainGodown)])
      setExtras(loadedExtras)
      setBills(party?.bills ?? null)
      setFxRate(party?.forexRate ? formatRate(party.forexRate) : '')
      setLoaded(JSON.stringify({ date: v.date, partyId: party?.ledgerId ?? null, salesId: sales?.ledgerId ?? null, rows: loadedRows, extras: loadedExtras, bills: party?.bills ?? null, narration: v.narration }))
    })
    // load once the ledgers and items are known
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id, id, ledgers === null, items === null])

  // new lines go to the main location until another godown is chosen
  useEffect(() => {
    if (mainGodown !== null) setRows((rs) => rs.map((r) => (r.godownId === null ? { ...r, godownId: mainGodown } : r)))
  }, [mainGodown])

  const itemsTotal = rows.reduce((t, r) => t + (parseMoney(r.amount) ?? 0), 0)
  const salesLedger = salesId !== null ? ledgerById.get(salesId) : undefined
  // a split made before the items changed no longer adds up: it has to be made again
  const costsFor = (amount: number) => {
    const total = (salesCosts ?? []).reduce((t, c) => t + c.amount, 0)
    if (total !== amount) throw new ApiError('', [`The cost centre split of ${salesLedger?.name} comes to ${formatINR(Math.abs(total))}, not ${formatINR(Math.abs(amount))}: open it again (Cost centres)`])
    return salesCosts!
  }
  const extrasTotal = extras.reduce((t, r) => t + (parseMoney(r.amount) ?? 0), 0)
  const total = itemsTotal + extrasTotal
  const party = partyId ? ledgerById.get(partyId) : undefined
  const partyCurrency = party?.currencyId ? rates?.find((c) => c.id === party.currencyId) : undefined
  const abroad = !!party?.country?.trim() && !/^india$/i.test(party.country.trim())
  // a foreign-currency party starts at the rate in force for this kind of voucher
  useEffect(() => {
    if (partyCurrency && !fxRate) setFxRate(defaultRate(rates, partyCurrency.id, type))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partyCurrency?.id, partyId])
  const fxRateValue = parseRate(fxRate)

  const dirty = id
    ? loaded !== null && snapshot() !== loaded
    : partyId !== null || narration.trim() !== '' || rows.some((r) => r.itemId !== null) || extras.some((r) => r.ledgerId !== null)

  useEffect(() => {
    if (!active) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'F2' && !e.altKey) {
        e.preventDefault()
        dateRef.current?.focus()
        return
      }
      // Alt+C creates what the current field lists: a stock item on an item line, otherwise a ledger
      if (e.altKey && (e.key === 'c' || e.key === 'C')) {
        const el = document.activeElement as HTMLInputElement | null
        const field = el?.closest<HTMLElement>('[data-field]')
        if (!field || !el?.closest('.picker')) return
        e.preventDefault()
        const [kind, n] = (field.dataset.field ?? '').split(':')
        const at = Number(n)
        if (kind === 'item') push({ k: 'stock-item', name: el.value, onCreated: (itemId) => setRow(at, { itemId }) })
        else
          push({
            k: 'ledger',
            name: el.value,
            onCreated: (ledgerId) =>
              kind === 'party' ? setPartyId(ledgerId) : kind === 'sales' ? setSalesId(ledgerId) : setExtras((xs) => xs.map((x, i) => (i === at ? { ...x, ledgerId } : x))),
          })
        return
      }
      const listOpen = !!formRef.current?.querySelector('.picker-list')
      if (e.key === 'Escape' && billFor && !listOpen) {
        e.preventDefault()
        e.stopImmediatePropagation()
        setBillFor(null)
        narrationRef.current?.focus()
        return
      }
      const quit = e.key === 'Escape' || (e.ctrlKey && (e.key === 'q' || e.key === 'Q'))
      if (quit && !listOpen && dirty) {
        e.preventDefault()
        e.stopImmediatePropagation()
        ask(id ? 'Quit without saving the changes?' : 'Quit? The invoice will not be saved.', pop)
        return
      }
      if (e.altKey && (e.key === 'p' || e.key === 'P') && id) {
        e.preventDefault()
        e.stopImmediatePropagation()
        push({ k: 'voucher-print', id })
        return
      }
      // Ctrl+V: voucher mode for this type (a new voucher only); in the narration it still pastes
      if (e.ctrlKey && (e.key === 'v' || e.key === 'V') && !id && !(e.target as HTMLElement).closest('textarea')) {
        e.preventDefault()
        e.stopImmediatePropagation()
        const go = () => replace({ k: 'voucher', type, invoice: false })
        if (dirty) ask('Switch to voucher mode? What is entered here will be lost.', go)
        else go()
        return
      }
      const vk = voucherKey(e)
      if (vk) {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (!id && vk.type !== type) replace({ k: 'voucher', type: vk.type })
      }
      if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault()
        setOptional((x) => !x)
      }
      if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        trySave()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  })

  function setRow(i: number, patch: Partial<ItemRow>) {
    setRows((rs) =>
      rs.map((r, n) => {
        if (n !== i) return r
        const next = { ...r, ...patch }
        // quantity × rate makes the amount (typing an amount keeps it)
        if (('qty' in patch || 'rate' in patch) && !('amount' in patch)) {
          const q = parseQty(next.qty, next.itemId ? itemById.get(next.itemId) : undefined)
          const rate = parseMoney(next.rate)
          if (q !== null && rate !== null) next.amount = plain(valueOf(q, rate))
        }
        // picking an item: its opening rate as a starting point
        if ('itemId' in patch && patch.itemId && !next.rate) {
          const s = itemById.get(patch.itemId)
          if (s?.openingQty) next.rate = plain(Math.round((s.openingValue * 1000) / s.openingQty))
        }
        return next
      }),
    )
  }

  const focusIn = (selector: string) => setTimeout(() => formRef.current?.querySelector<HTMLElement>(selector)?.focus(), 0)

  /** The invoice is made against a note or an order: its pending lines become the item lines. */
  function pickAgainst(docId: number) {
    setAgainstId(docId || null)
    if (!docId) return
    const lines = docs.filter((l) => l.voucherId === docId)
    const note = lines[0]?.type === links?.note
    setRows(
      lines.map((l) => ({
        itemId: l.itemId, godownId: l.godownId, qty: qtyField(l.pending, itemById.get(l.itemId) ?? l), rate: plain(l.rate),
        amount: plain(valueOf(l.pending, l.rate)), against: `${l.type} No. ${l.docNo ?? l.number}`,
        ...(note ? { trackingId: docId } : { orderId: docId }),
      })),
    )
  }

  /** Enter on an item line's amount: open the next item line. */
  function itemDone(i: number) {
    if (i === rows.length - 1) setRows((rs) => [...rs, emptyItem(mainGodown)])
    focusIn(`[data-field="item:${i + 1}"] input`)
  }

  /** The GST lines this invoice should carry, given its items and other lines (none without a GSTIN). */
  function taxesFor(others: ExtraRow[]) {
    if (!gstCtx?.companyGstin || partyId === null) return []
    const inventory = rows
      .filter((r) => r.itemId !== null)
      .map((r) => ({ itemId: r.itemId!, godownId: r.godownId ?? 0, qty: dir * Math.abs(parseQty(r.qty, itemById.get(r.itemId!)) ?? 0), rate: 0, amount: dir * Math.abs(parseMoney(r.amount) ?? 0) }))
    const entries = [
      { ledgerId: partyId, amount: 0 },
      ...(salesId !== null ? [{ ledgerId: salesId, amount: dir * itemsTotal }] : []),
      ...others.map((x) => ({ ledgerId: x.ledgerId!, amount: dir * (parseMoney(x.amount) ?? 0) })),
    ]
    return suggestedTaxes({ type, date, entries, inventory }, gstCtx)
  }

  /** The additional lines with the tax worked out again (Tally recalculates its GST ledgers the same way). */
  function withTaxes(xs: ExtraRow[]) {
    const filled = xs.filter((x) => x.ledgerId !== null)
    const others = filled.filter((x) => !isTaxLine(x))
    const taxes = taxesFor(others)
    if (!taxes.length) return filled
    return [...others, ...taxes.map((t) => ({ ledgerId: t.ledgerId, amount: plain(t.amount) }))]
  }

  /** End of List on the items: drop the empty line, add the tax lines, go to the additional ledgers. */
  function itemsDone(i: number) {
    setRows((rs) => rs.filter((r, n) => n !== i || r.itemId !== null))
    const next = [...withTaxes(extras), { ledgerId: null, amount: '' }]
    setExtras(next)
    focusIn(`[data-field="extra:${next.length - 1}"] input`)
  }

  function extraDone(i: number) {
    if (i === extras.length - 1) setExtras((xs) => [...xs, { ledgerId: null, amount: '' }])
    focusIn(`[data-field="extra:${i + 1}"] input`)
  }

  /** End of List on the additional ledgers: the party's bill-wise details, then narration. */
  async function extrasDone(i: number) {
    setExtras(withTaxes(extras.filter((x, n) => n !== i || x.ledgerId !== null)))
    if (party?.billwise && total) {
      const [out, next] = await Promise.all([
        api.outstanding(company.id, party.id, { from: period.from, to: date }, id),
        number ? Promise.resolve(number) : api.nextNumber(company.id, type),
      ])
      setBillFor({ pending: out.bills, defaultName: String(next) })
      return
    }
    narrationRef.current?.focus()
  }

  /**
   * The party's bills for the invoice's amount. A single bill follows a changed total; several
   * bills that no longer add up reopen the bill-wise details.
   */
  function billsFor(amount: number) {
    if (!bills?.length) return bills
    if (bills.reduce((t, b) => t + b.amount, 0) === amount) return bills
    if (bills.length === 1) return [{ ...bills[0], amount }]
    extrasDone(-1)
    throw new ApiError('', ['The invoice total changed: split it across the bills again'])
  }

  function build() {
    const inventory = rows
      .filter((r) => r.itemId !== null || r.qty.trim() || r.amount.trim())
      .map((r, n) => {
        const q = parseQty(r.qty, r.itemId ? itemById.get(r.itemId) : undefined)
        const a = parseMoney(r.amount) ?? 0
        if (r.itemId === null) throw new ApiError('', [`Item line ${n + 1}: choose a stock item`])
        if (!q) throw new ApiError('', [`Item line ${n + 1}: enter the quantity`])
        if (r.godownId === null) throw new ApiError('', [`Item line ${n + 1}: choose a godown`])
        return {
          itemId: r.itemId, godownId: r.godownId, qty: dir * Math.abs(q), rate: parseMoney(r.rate) ?? 0, amount: dir * Math.abs(a),
          ...(r.trackingId ? { trackingId: r.trackingId } : r.orderId ? { orderId: r.orderId } : {}),
          ...(itemById.get(r.itemId)?.batches ? { batch: r.batch?.trim() || null, mfgDate: r.mfgDate || null, expiryDate: r.expiryDate || null } : {}),
        }
      })
    if (partyId === null) throw new ApiError('', ['Choose the party account'])
    if (inventory.length && salesId === null) throw new ApiError('', [`Choose the ${itemGroup === 'Sales Accounts' ? 'sales' : 'purchase'} ledger`])
    const lines = extras
      .filter((x) => x.ledgerId !== null || x.amount.trim())
      .map((x, n) => {
        const a = parseMoney(x.amount)
        if (x.ledgerId === null) throw new ApiError('', [`Additional line ${n + 1}: choose a ledger`])
        if (!a) throw new ApiError('', [`Additional line ${n + 1}: enter an amount`])
        return { ledgerId: x.ledgerId, amount: dir * a }
      })
    if (partyCurrency && !fxRateValue) throw new ApiError('', [`Enter the rate of exchange for ${partyCurrency.symbol}`])
    const fx = partyCurrency ? { forex: toForex(-dir * total, fxRateValue!, partyCurrency.decimals), forexRate: fxRateValue } : {}
    const entries = [
      { ledgerId: partyId, amount: -dir * total, bills: party?.billwise && bills?.length ? billsFor(-dir * total) : undefined, ...fx },
      ...(inventory.length ? [{ ledgerId: salesId!, amount: dir * itemsTotal, ...(salesCosts?.length ? { costs: costsFor(dir * itemsTotal) } : {}) }] : []),
      ...lines,
    ]
    const ref = type === 'Purchase' || type === 'Debit Note' ? { refNo: refNo.trim() || null, refDate: refDate || null } : {}
    const exported = abroad && type === 'Sales' && shipping.no.trim() ? { shippingBill: { port: shipping.port.trim().toUpperCase(), no: shipping.no.trim(), date: shipping.date } } : {}
    return { type, date, narration, entries, inventory, optional, ...ref, ...exported, ...(features.costTracking ? { costTrack: costTrack.trim() || null } : {}) }
  }

  // TDS (194Q on purchases) and TCS (on sales of the goods of section 206C): the lines as they stand
  const tdsEntries =
    partyId === null
      ? []
      : [
          { ledgerId: partyId, amount: -dir * total },
          ...(salesId !== null && itemsTotal ? [{ ledgerId: salesId, amount: dir * itemsTotal }] : []),
          ...extras.flatMap((x) => (x.ledgerId !== null && parseMoney(x.amount) ? [{ ledgerId: x.ledgerId, amount: dir * parseMoney(x.amount)! }] : [])),
        ]
  /** Alt+T: the tax due as a line on each nature's tax ledger, a credit; the invoice total follows. */
  function bookTds(found: TdsSuggestion[]) {
    setExtras((xs) => {
      let next = xs.filter((x) => x.ledgerId !== null || x.amount.trim())
      for (const s of found) {
        const line = { ledgerId: s.ledgerId, amount: plain(-dir * s.due) }
        next = next.some((x) => x.ledgerId === s.ledgerId) ? next.map((x) => (x.ledgerId === s.ledgerId ? line : x)) : [...next, line]
      }
      return next
    })
    setTimeout(() => narrationRef.current?.focus(), 0)
  }

  async function save() {
    setErrors([])
    const body = build()
    const v = id ? await api.alterVoucher(company.id, id, { ...body, ...vtype.fields, version: editVersion! }) : await api.postVoucher(company.id, { ...body, ...vtype.fields })
    changed()
    if (id) return pop()
    setSaved(`${v.type} No. ${v.docNo ?? v.number} saved`)
    vtype.clear()
    setFxRate('')
    setPartyId(null) // the sales ledger stays: the next invoice usually uses it too
    setAgainstId(null)
    setRows([emptyItem(mainGodown)])
    setExtras([])
    setBills(null)
    setBillFor(null)
    setOptional(false)
    setNarration('')
    setRefNo('')
    setRefDate('')
    setCostTrack('')
    focusIn('[data-field="party"] input')
  }

  const trySave = () =>
    save().catch((e) => {
      setSaved(null)
      setErrors(e instanceof ApiError && e.errors.length ? e.errors : [e.message])
    })

  const partyOptions = useMemo(
    () => (ledgers ?? []).filter((l) => l.group !== 'Stock-in-Hand' && l.primaryGroup !== itemGroup).map((l) => ({ id: l.id, name: l.name, hint: l.group ?? 'Primary' })),
    [ledgers, itemGroup],
  )
  const salesOptions = useMemo(() => (ledgers ?? []).filter((l) => l.primaryGroup === itemGroup).map((l) => ({ id: l.id, name: l.name, hint: l.group ?? '' })), [ledgers, itemGroup])
  const itemOptions = useMemo(() => [{ id: END, name: 'End of List' }, ...(items ?? []).map((s) => ({ id: s.id, name: s.name, hint: s.group ?? s.unit }))], [items])
  const extraOptions = useMemo(
    () => [{ id: END, name: 'End of List' }, ...(ledgers ?? []).filter((l: Ledger) => l.group !== 'Stock-in-Hand').map((l) => ({ id: l.id, name: l.name, hint: l.group ?? 'Primary' }))],
    [ledgers],
  )
  const godownOptions = (godowns ?? []).map((g) => ({ id: g.id, name: g.name }))
  const manyGodowns = godownOptions.length > 1
  const ledgerWord = itemGroup === 'Sales Accounts' ? 'Sales ledger' : 'Purchase ledger'

  return (
    <form
      ref={formRef}
      className="voucher"
      onSubmit={(e) => {
        e.preventDefault()
        trySave()
      }}
    >
      <Title right={(saved && <span className="ok">{saved}</span>) || <span className="muted">F2 date · Alt+C new item/ledger · Ctrl+V voucher mode · Ctrl+A accept</span>}>
        {id ? 'Alteration (Invoice)' : 'Invoice Creation'}
      </Title>
      {confirm}
      <div className="vch-head">
        <span className={`vch-type t-${type.replace(' ', '')}`}>{type}</span>
        <span>No. {number ?? 'auto'}</span>
        {optional && <span className="badge muted-badge">Optional</span>}
        {features.costTracking && (
          <label className="inline-field">
            Cost track
            <input size={10} value={costTrack} onChange={(e) => setCostTrack(e.target.value)} placeholder="—" aria-label="Cost track" />
          </label>
        )}
        {(type === 'Purchase' || type === 'Debit Note') && (
          <>
            <label className="inline-field">
              Supplier invoice no.
              <input size={14} maxLength={16} value={refNo} onChange={(e) => setRefNo(e.target.value)} aria-label="Supplier invoice no." />
            </label>
            <label className="inline-field">
              Date
              <input type="date" value={refDate} onChange={(e) => setRefDate(e.target.value)} aria-label="Supplier invoice date" />
            </label>
          </>
        )}
        {abroad && type === 'Sales' && (
          <>
            <label className="inline-field">
              Port code
              <input size={7} maxLength={6} value={shipping.port} onChange={(e) => setShipping({ ...shipping, port: e.target.value })} placeholder="INNSA1" aria-label="Port code" />
            </label>
            <label className="inline-field">
              Shipping bill no.
              <input size={8} maxLength={7} inputMode="numeric" value={shipping.no} onChange={(e) => setShipping({ ...shipping, no: e.target.value })} aria-label="Shipping bill no." />
            </label>
            <label className="inline-field">
              Date
              <input type="date" value={shipping.date} onChange={(e) => setShipping({ ...shipping, date: e.target.value })} aria-label="Shipping bill date" />
            </label>
          </>
        )}
        <span className="spacer" />
        <span className="muted">Date</span>
        <DateInput value={date} onChange={setDate} fyStart={company.fyStart} label="Date" inputRef={dateRef} />
      </div>

      <div className="inv-head">
        <label data-field="party">
          Party A/c name
          <Picker
            options={partyOptions}
            value={partyId}
            onChange={(p) => {
              if (p !== partyId) {
                setAgainstId(null)
                setFxRate('') // the next party's currency brings its own rate
              }
              setPartyId(p)
            }}
            placeholder="Party"
            autoFocus={!id}
          />
          {party && config.showBalances && <span className="cur-bal">Cur Bal: {drcr(party.closing) || 'nil'}</span>}
          {bills?.length ? <span className="cur-bal">{billSummary(bills)}</span> : null}
        </label>
        {partyCurrency && (
          <label data-field="rate">
            Rate of exchange (₹ per {partyCurrency.symbol})
            <input className="amount" inputMode="decimal" value={fxRate} onChange={(e) => setFxRate(e.target.value)} aria-label="Rate of exchange" />
            <span className="cur-bal">
              {fxRateValue ? `Invoice value ${formatForex(toForex(total, fxRateValue, partyCurrency.decimals), partyCurrency)}` : 'Enter the rate'}
            </span>
          </label>
        )}
        {gstCtx?.companyGstin && party && (
          <span className="cur-bal gst-note">
            {(() => {
              const pos = placeOfSupply(gstCtx.ledgers.get(party.id), gstCtx)
              const home = stateCode(gstCtx.companyState) ?? gstCtx.companyGstin!.slice(0, 2)
              return `GST: ${pos === home ? 'CGST + SGST' : 'IGST'} · place of supply ${stateName(pos) ?? '—'}${gstCtx.ledgers.get(party.id)?.gstin ? '' : ' · unregistered'}`
            })()}
          </span>
        )}
        {docs.length > 0 && (
          <label data-field="against">
            {links?.note === 'Delivery Note' ? 'Delivery Note / Order No.' : 'Receipt Note / Order No.'}
            <Picker
              options={[
                { id: 0, name: 'Not Applicable' },
                ...[...new Map(docs.map((l) => [l.voucherId, l])).values()].map((l) => ({ id: l.voucherId, name: `${l.type} No. ${l.docNo ?? l.number}`, hint: fmtDate(l.date) })),
              ]}
              value={againstId ?? 0}
              onChange={pickAgainst}
              placeholder="Not Applicable"
            />
          </label>
        )}
        <label data-field="sales">
          {ledgerWord}
          <Picker options={salesOptions} value={salesId} onChange={(v) => (setSalesId(v), setSalesCosts(null))} placeholder={ledgerWord} />
          {salesCosts?.length ? <div className="cur-bal">{costSummary(salesCosts, costMasters)}</div> : null}
        </label>
        {salesLedger?.costCentres && costMasters?.centres.length ? (
          <button type="button" className="small" onClick={() => setCostsOpen(true)} disabled={!itemsTotal}>Cost centres</button>
        ) : null}
      </div>
      {costsOpen && salesLedger && costMasters && (
        <CostPanel ledger={salesLedger.name} amount={dir * itemsTotal} masters={costMasters} initial={salesCosts}
          onDone={(costs) => (setSalesCosts(costs?.length ? costs : null), setCostsOpen(false))} />
      )}

      <table className="vch-table inv-table">
        <thead>
          <tr>
            <th>Name of Item</th>
            {manyGodowns && <th>Godown</th>}
            <th className="num">Quantity</th>
            <th className="num">Rate</th>
            <th>per</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const s = r.itemId ? itemById.get(r.itemId) : undefined
            return (
              <tr key={i} className="vch-row">
                <td data-field={`item:${i}`}>
                  <Picker
                    options={itemOptions}
                    value={r.itemId}
                    onChange={(itemId) => (itemId === END ? itemsDone(i) : setRow(i, { itemId }))}
                    placeholder="Stock item"
                  />
                  {r.against && <span className="muted against">against {r.against}</span>}
                  {s?.batches && r.itemId !== null && (
                    <BatchFields itemId={r.itemId} line={i} inward={dir > 0} value={{ batch: r.batch ?? '', mfgDate: r.mfgDate ?? '', expiryDate: r.expiryDate ?? '' }}
                      onChange={(patch) => setRow(i, patch)} />
                  )}
                </td>
                {manyGodowns && (
                  <td>
                    <Picker options={godownOptions} value={r.godownId} onChange={(godownId) => setRow(i, { godownId })} placeholder="Godown" />
                  </td>
                )}
                <td className="num">
                  <Field value={r.qty} onChange={(qty) => setRow(i, { qty })} label={`Item ${i + 1} quantity`} />
                </td>
                <td className="num">
                  <Field value={r.rate} onChange={(rate) => setRow(i, { rate })} label={`Item ${i + 1} rate`} />
                </td>
                <td className="muted">{s?.unit}</td>
                <td className="num">
                  <Field value={r.amount} onChange={(amount) => setRow(i, { amount })} onDone={() => itemDone(i)} label={`Item ${i + 1} amount`} />
                </td>
              </tr>
            )
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={manyGodowns ? 6 : 5}>
                <button type="button" onClick={() => setRows([emptyItem(mainGodown)])}>
                  Add item line
                </button>
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td className="muted" colSpan={manyGodowns ? 5 : 4}>
              Items
            </td>
            <td className="num total">{formatINR(itemsTotal)}</td>
          </tr>
        </tfoot>
      </table>

      {extras.length > 0 && (
        <table className="vch-table inv-extras">
          <tbody>
            {extras.map((x, i) => (
              <tr key={i} className="vch-row">
                <td data-field={`extra:${i}`}>
                  <Picker
                    options={extraOptions}
                    value={x.ledgerId}
                    onChange={(ledgerId) => {
                      if (ledgerId === END) return extrasDone(i)
                      // a GST ledger picked by hand gets its tax filled in
                      const due = !x.amount.trim() && gstCtx?.ledgers.get(ledgerId)?.taxType ? taxesFor(extras.filter((y) => y.ledgerId !== null && !isTaxLine(y))).find((t) => t.ledgerId === ledgerId) : undefined
                      setExtras((xs) => xs.map((y, n) => (n === i ? { ...y, ledgerId, amount: due ? plain(due.amount) : y.amount } : y)))
                    }}
                    placeholder="Additional ledger (tax, freight, discount)"
                  />
                </td>
                <td className="num">
                  <Field
                    value={x.amount}
                    onChange={(amount) => setExtras((xs) => xs.map((y, n) => (n === i ? { ...y, amount } : y)))}
                    onDone={() => extraDone(i)}
                    label={`Additional ${i + 1} amount`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="inv-total">
        <span className="muted">Invoice total</span> <b>{formatINR(total)}</b>
      </div>
      <TdsHint voucherId={id} date={date} entries={tdsEntries} onDeduct={bookTds} />

      {billFor && party && (
        <BillPanel
          ledger={party.name}
          amount={-dir * total}
          voucherDate={date}
          fyStart={company.fyStart}
          pending={billFor.pending}
          initial={bills}
          defaultName={billFor.defaultName}
          onDone={(b) => {
            setBills(b)
            setBillFor(null)
            narrationRef.current?.focus()
          }}
        />
      )}

      <label className="narration">
        Narration
        <textarea
          ref={narrationRef}
          rows={2}
          value={narration}
          onChange={(e) => setNarration(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              trySave()
            }
          }}
        />
      </label>
      <Errors errors={errors} />
      <div className="actions">
        <button type="button" onClick={() => setExtras((xs) => [...xs, { ledgerId: null, amount: '' }])}>
          Add ledger line
        </button>
        <button type="button" onClick={() => setOptional((x) => !x)} aria-pressed={optional}>
          {optional ? (id ? 'Make regular' : 'Not optional') : 'Optional'}
        </button>
        <button type="submit" className="primary">
          <b>Ctrl+A</b> Accept
        </button>
      </div>
    </form>
  )
}

/** A number field: Enter moves on (or runs onDone, at the end of a line). */
export function Field({ value, onChange, onDone, label }: { value: string; onChange: (v: string) => void; onDone?: () => void; label: string }) {
  return (
    <input
      className="amount"
      inputMode="decimal"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        if (onDone) onDone()
        else focusNext(e.currentTarget)
      }}
    />
  )
}
