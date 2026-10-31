import { useEffect, useMemo, useRef, useState } from 'react'
import { useVoucherTypeFields } from './VoucherTypes'
import { newVoucherDate, useApp, voucherKey } from '../App'
import { api, ApiError, type PendingLine, type PendingType, type Voucher } from '../api'
import { formatINR } from '../../server/src/engine/money'
import { COSTED_TYPES, LINKS, needsParty, ORDER_TYPES, STOCK_DIRECTION, TWO_WAY_TYPES, valueOf } from '../../server/src/engine/inventory'
import { parseShortDate } from '../../server/src/engine/dates'
import type { VoucherType } from '../../server/src/engine/voucher'
import { DateInput, Errors, fmtDate, Picker, Title, useActive, useConfirm, useLoad } from '../ui'
import { END, Field, parseMoney, parseQty, plain, qtyField } from './Invoice'
import { BatchFields } from './BatchFields'

interface Row {
  itemId: number | null
  godownId: number | null
  qty: string // the count, on Physical Stock
  rate: string
  amount: string
  due: string // order lines: as typed (14, 14-10, 14-Oct …)
  orderId: number | null // the order a note's line delivers
  side: 1 | -1 // Stock Journal: -1 consumed (source), +1 produced (destination)
  batch?: string // an item kept in batches
  mfgDate?: string
  expiryDate?: string
  role?: 'by-product' | 'scrap' | null // a Manufacturing Journal: made alongside the main product
  costShare?: number | null // a by-product's share of the cost, hundredths of a percent
}
const emptyRow = (godownId: number | null, side: 1 | -1): Row => ({
  itemId: null,
  godownId,
  qty: '',
  rate: '',
  amount: '',
  due: '',
  orderId: null,
  side,
})
const NONE = 0 // "Not Applicable" in the order list

/**
 * Inventory vouchers, Tally's way: Sales/Purchase Orders and Delivery/Receipt Notes take a party
 * and item lines; a note can be made against the party's pending order, which fills its lines.
 * A Stock Journal has a Source (consumption) and a Destination (production) list; Physical
 * Stock takes what was counted, and the books follow the count. None of them post to ledgers.
 */
export function StockVoucherEntry({ type, id }: { type: VoucherType; id?: number }) {
  const { company, period, push, pop, replace, changed, version, config } = useApp()
  const vtype = useVoucherTypeFields()
  const active = useActive()
  const [confirm, ask] = useConfirm()
  const formRef = useRef<HTMLFormElement>(null)
  const dateRef = useRef<HTMLInputElement>(null)
  const narrationRef = useRef<HTMLTextAreaElement>(null)
  const dir = STOCK_DIRECTION[type] // orders and notes; none on a journal or a count
  const journal = TWO_WAY_TYPES.includes(type) // a consumption and a production list
  const party = needsParty(type)
  const costed = COSTED_TYPES.includes(type) // what is made takes the cost of what is consumed
  const takesCost = type === 'Manufacturing Journal' || type === 'Material In'
  const [extra, setExtra] = useState('') // additional cost: labour, power, job work charges
  const SIDES: Partial<Record<VoucherType, [string, string]>> = {
    'Stock Journal': ['Source (Consumption)', 'Destination (Production)'],
    'Manufacturing Journal': ['Components (Consumption)', 'Production'],
    'Material Out': ['Sent from', "To the job worker's godown (or back to the principal)"],
    'Material In': ['Consumed at the job worker', 'Received'],
  }
  const physical = type === 'Physical Stock'
  const isOrder = ORDER_TYPES.includes(type)
  const orderType = LINKS[type]?.order as PendingType | undefined // what a note is made against

  const { data: ledgers } = useLoad(() => api.ledgers(company.id, period), [company.id, period, version])
  const { data: items } = useLoad(() => api.stockItems(company.id), [company.id, version])
  const { data: godowns } = useLoad(() => api.godowns(company.id), [company.id, version])
  const { data: rates } = useLoad(() => api.stockRates(company.id, period), [company.id, period, version])
  const mainGodown = godowns?.find((g) => g.isDefault)?.id ?? null

  const [date, setDate] = useState(() => newVoucherDate(period, config))
  const [number, setNumber] = useState<number | string | null>(null)
  const [editVersion, setEditVersion] = useState<number | undefined>()
  const [partyId, setPartyId] = useState<number | null>(null)
  const [againstId, setAgainstId] = useState<number | null>(null)
  const [pending, setPending] = useState<PendingLine[]>([])
  const [rows, setRows] = useState<Row[]>(() => (journal ? [emptyRow(null, -1), emptyRow(null, 1)] : [emptyRow(null, dir ?? 1)]))
  const [narration, setNarration] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [saved, setSaved] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<string | null>(null)
  const snapshot = () => JSON.stringify({ date, partyId, rows, narration })

  const itemById = new Map((items ?? []).map((s) => [s.id, s]))
  const rateOf = (itemId: number) => {
    const avg = rates?.find((r) => r.id === itemId)?.rate
    if (avg) return avg
    const s = itemById.get(itemId)
    return s?.openingQty ? Math.round((s.openingValue * 1000) / s.openingQty) : 0
  }

  useEffect(() => {
    if (!id || !items) return
    api.voucher(company.id, id).then((v: Voucher) => {
      const loadedRows: Row[] = (v.inventory ?? []).map((l) => {
        const d = itemById.get(l.itemId)?.decimals ?? 3
        const shown = (q: number) => qtyField(q, itemById.get(l.itemId) ?? { decimals: d })
        return {
          itemId: l.itemId,
          godownId: l.godownId,
          qty: physical ? shown(l.counted ?? 0) : shown(l.qty),
          rate: plain(l.rate),
          amount: physical ? '' : plain(Math.abs(l.amount)),
          due: l.dueDate ? fmtDate(l.dueDate) : '',
          orderId: l.orderId ?? null,
          side: l.qty < 0 ? -1 : 1,
          batch: l.batch ?? '', mfgDate: l.mfgDate ?? '', expiryDate: l.expiryDate ?? '',
          role: l.role ?? null, costShare: l.costShare ?? null,
        }
      })
      if (journal && !loadedRows.some((r) => r.side === 1)) loadedRows.push(emptyRow(mainGodown, 1))
      setDate(v.date)
      setNumber(v.docNo ?? v.number)
      setEditVersion(v.version)
      setNarration(v.narration)
      setExtra(v.additionalCost ? plain(v.additionalCost) : '')
      setPartyId(v.partyId ?? null)
      setAgainstId(loadedRows.find((r) => r.orderId)?.orderId ?? null)
      setRows(loadedRows)
      setLoaded(
        JSON.stringify({
          date: v.date,
          partyId: v.partyId ?? null,
          rows: loadedRows,
          narration: v.narration,
        }),
      )
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id, id, items === null])

  useEffect(() => {
    if (mainGodown !== null) setRows((rs) => rs.map((r) => (r.godownId === null ? { ...r, godownId: mainGodown } : r)))
  }, [mainGodown])

  // a note offers the party's pending orders
  useEffect(() => {
    if (!orderType || partyId === null) return setPending([])
    api
      .pending(company.id, orderType, { partyId, excludeVoucher: id })
      .then((r) => {
        setPending(r.lines)
        // asked right after the party, as Tally asks for the order number (a new note only)
        if (r.lines.length && !id) focusIn('[data-field="against"] input')
      })
      .catch(() => setPending([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id, orderType, partyId, id])
  const orders = [...new Map(pending.map((l) => [l.voucherId, l])).values()]

  const dirty = id ? loaded !== null && snapshot() !== loaded : partyId !== null || narration.trim() !== '' || rows.some((r) => r.itemId !== null)

  useEffect(() => {
    if (!active) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'F2' && !e.altKey) {
        e.preventDefault()
        dateRef.current?.focus()
        return
      }
      if (e.altKey && (e.key === 'c' || e.key === 'C')) {
        const el = document.activeElement as HTMLInputElement | null
        const field = el?.closest<HTMLElement>('[data-field]')
        if (!field || !el?.closest('.picker')) return
        e.preventDefault()
        const [kind, n] = (field.dataset.field ?? '').split(':')
        if (kind === 'item')
          push({
            k: 'stock-item',
            name: el.value,
            onCreated: (itemId) => setRow(Number(n), { itemId }),
          })
        if (kind === 'party') push({ k: 'ledger', name: el.value, onCreated: setPartyId })
        return
      }
      const listOpen = !!formRef.current?.querySelector('.picker-list')
      const quit = e.key === 'Escape' || (e.ctrlKey && (e.key === 'q' || e.key === 'Q'))
      if (quit && !listOpen && dirty) {
        e.preventDefault()
        e.stopImmediatePropagation()
        ask(id ? 'Quit without saving the changes?' : `Quit? The ${type} will not be saved.`, pop)
        return
      }
      if (e.altKey && (e.key === 'p' || e.key === 'P') && id) {
        e.preventDefault()
        e.stopImmediatePropagation()
        push({ k: 'voucher-print', id })
        return
      }
      const vk = voucherKey(e)
      if (vk) {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (!id && vk.type !== type) replace({ k: 'voucher', type: vk.type })
      }
      if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        trySave()
      }
      if (e.altKey && (e.key === 'b' || e.key === 'B') && type === 'Manufacturing Journal') {
        e.preventDefault()
        fillFromBom()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  })

  function setRow(i: number, patch: Partial<Row>) {
    setRows((rs) =>
      rs.map((r, n) => {
        if (n !== i) return r
        const next = { ...r, ...patch }
        if (('qty' in patch || 'rate' in patch) && !('amount' in patch) && !physical) {
          const q = parseQty(next.qty, next.itemId ? itemById.get(next.itemId) : undefined)
          const rate = parseMoney(next.rate)
          if (q !== null && rate !== null) next.amount = plain(valueOf(q, rate))
        }
        // picking an item: its average cost as a starting rate
        if ('itemId' in patch && patch.itemId && !next.rate && !physical) next.rate = plain(rateOf(patch.itemId))
        return next
      }),
    )
  }

  const focusIn = (selector: string) => setTimeout(() => formRef.current?.querySelector<HTMLElement>(selector)?.focus(), 0)

  /** Enter at the end of a line: the next line of the same list. */
  function rowDone(i: number) {
    const side = rows[i].side
    const isLast = rows.slice(i + 1).every((r) => r.side !== side)
    if (isLast) setRows((rs) => [...rs.slice(0, i + 1), emptyRow(mainGodown, side), ...rs.slice(i + 1)])
    focusIn(`[data-field="item:${i + 1}"] input`)
  }

  /** End of List: drop the empty line; the Source list moves to the Destination, the rest to narration. */
  function listDone(i: number) {
    const side = rows[i].side
    const kept = rows.filter((r, n) => n !== i || r.itemId !== null)
    if (journal && side === -1) {
      setRows(kept)
      const first = kept.findIndex((r) => r.side === 1)
      return focusIn(`[data-field="item:${first}"] input`)
    }
    // one product made from the materials: it carries their cost, as in Tally
    const made = kept.filter((r) => r.side === 1 && r.itemId !== null)
    if (journal && made.length === 1 && !made[0].amount.trim()) {
      const cost = kept.filter((r) => r.side === -1).reduce((t, r) => t + (parseMoney(r.amount) ?? 0), 0) + (parseMoney(extra) ?? 0)
      const q = parseQty(made[0].qty, itemById.get(made[0].itemId!))
      made[0].amount = plain(cost)
      if (q) made[0].rate = plain(Math.round((cost * 1000) / q))
    }
    setRows(kept)
    setTimeout(() => narrationRef.current?.focus(), 0) // after the picker has moved on and the empty line is gone
  }

  /** A note made against an order: its pending lines become the note's lines. */
  function pickOrder(orderId: number) {
    setAgainstId(orderId || null)
    if (!orderId) return
    const lines = pending.filter((l) => l.voucherId === orderId)
    setRows(
      lines.map((l) => ({
        itemId: l.itemId,
        godownId: l.godownId,
        qty: qtyField(l.pending, itemById.get(l.itemId) ?? l),
        rate: plain(l.rate),
        amount: plain(valueOf(l.pending, l.rate)),
        due: '',
        orderId,
        side: (orderType && STOCK_DIRECTION[orderType]) ?? dir ?? 1,
      })),
    )
    focusIn('[data-field="item:0"] input')
  }

  // an item made in more than one way: which bill of materials Alt+B fills from
  const [bomChoices, setBomChoices] = useState<string[]>([])
  const [bomName, setBomName] = useState('')

  /** Manufacturing Journal: the components of the first item produced, for its quantity, from its bill of materials. */
  async function fillFromBom() {
    const made = rows.find((r) => r.side === 1 && r.itemId !== null && !r.role)
    if (!made) return setErrors(['Choose the item produced and its quantity first'])
    const q = parseQty(made.qty, itemById.get(made.itemId!))
    if (!q) return setErrors(['Enter the quantity produced first'])
    // an item with several bills of materials: the one named, else ask
    const names = await api.bomNames(company.id, made.itemId!)
    const name = names.length > 1 ? (names.includes(bomName) ? bomName : '') : names[0]
    if (names.length > 1 && !name) {
      setBomChoices(names)
      setBomName(names[0])
      return setErrors([`${itemById.get(made.itemId!)?.name} has ${names.length} bills of materials: choose one, then Alt+B again`])
    }
    const bom = name ? await api.bom(company.id, made.itemId!, name) : null
    if (!bom) return setErrors([`${itemById.get(made.itemId!)?.name} has no bill of materials (Create, Bill of Materials)`])
    setErrors([])
    const per = (qty: number) => Math.round((qty * q) / bom.makesQty)
    const godown = made.godownId ?? mainGodown
    const parts: Row[] = bom.components.map((c) => {
      const need = per(c.qty)
      const rate = rateOf(c.itemId)
      return { ...emptyRow(godown, -1), itemId: c.itemId, qty: qtyField(need, itemById.get(c.itemId) ?? { decimals: 3 }), rate: plain(rate), amount: plain(valueOf(need, rate)) }
    })
    const alongside: Row[] = [
      ...(bom.byProducts ?? []).map((x) => ({ ...emptyRow(godown, 1), itemId: x.itemId, qty: qtyField(per(x.qty), itemById.get(x.itemId) ?? { decimals: 3 }), role: 'by-product' as const, costShare: x.costShare })),
      ...(bom.scrap ?? []).map((x) => ({ ...emptyRow(godown, 1), itemId: x.itemId, qty: qtyField(per(x.qty), itemById.get(x.itemId) ?? { decimals: 3 }), role: 'scrap' as const })),
    ]
    setRows((rs) => [...parts, ...rs.filter((r) => r.side === 1 && !r.role), ...alongside])
  }

  function build() {
    const inventory = rows
      .filter((r) => r.itemId !== null || r.qty.trim() || r.amount.trim())
      .map((r, n) => {
        const q = parseQty(r.qty, r.itemId ? itemById.get(r.itemId) : undefined)
        const at = `Item line ${n + 1}`
        if (r.itemId === null) throw new ApiError('', [`${at}: choose a stock item`])
        if (r.godownId === null) throw new ApiError('', [`${at}: choose a godown`])
        if (physical) {
          if (q === null || q < 0) throw new ApiError('', [`${at}: enter the quantity counted`])
          return {
            itemId: r.itemId,
            godownId: r.godownId,
            qty: 0,
            rate: 0,
            amount: 0,
            counted: q,
          }
        }
        if (!q) throw new ApiError('', [`${at}: enter the quantity`])
        let dueDate: string | null = null
        if (isOrder && r.due.trim()) {
          dueDate = parseShortDate(r.due, date, company.fyStart)
          if (!dueDate) throw new ApiError('', [`${at}: the due date "${r.due}" is not a date`])
        }
        const side = dir ?? r.side
        return {
          itemId: r.itemId,
          godownId: r.godownId,
          qty: side * Math.abs(q),
          rate: parseMoney(r.rate) ?? 0,
          amount: side * Math.abs(parseMoney(r.amount) ?? 0),
          ...(dueDate ? { dueDate } : {}),
          ...(r.orderId ? { orderId: r.orderId } : {}),
          ...(itemById.get(r.itemId)?.batches ? { batch: r.batch?.trim() || null, mfgDate: r.mfgDate || null, expiryDate: r.expiryDate || null } : {}),
          ...(r.role && side > 0 ? { role: r.role, costShare: r.role === 'by-product' ? (r.costShare ?? null) : null } : {}),
        }
      })
    if (party && partyId === null) throw new ApiError('', ['Choose the party'])
    return {
      type,
      date,
      narration,
      entries: [],
      inventory,
      ...(party ? { partyId } : {}),
      ...(takesCost ? { additionalCost: parseMoney(extra) ?? 0 } : {}),
    }
  }

  async function save() {
    setErrors([])
    const body = build()
    const v = id
      ? await api.alterVoucher(company.id, id, {
          ...body,
          ...vtype.fields,
          version: editVersion!,
        })
      : await api.postVoucher(company.id, { ...body, ...vtype.fields })
    changed()
    if (id) return pop()
    setSaved(`${v.type} No. ${v.docNo ?? v.number} saved`)
    vtype.clear()
    setPartyId(null)
    setAgainstId(null)
    setRows(journal ? [emptyRow(mainGodown, -1), emptyRow(mainGodown, 1)] : [emptyRow(mainGodown, dir ?? 1)])
    setNarration('')
    setExtra('')
    focusIn(party ? '[data-field="party"] input' : '[data-field="item:0"] input')
  }
  const trySave = () =>
    save().catch((e) => {
      setSaved(null)
      setErrors(e instanceof ApiError && e.errors.length ? e.errors : [e.message])
    })

  const partyOptions = useMemo(
    () =>
      (ledgers ?? [])
        .filter((l) => l.group !== 'Stock-in-Hand' && !['Sales Accounts', 'Purchase Accounts'].includes(l.primaryGroup ?? ''))
        .map((l) => ({ id: l.id, name: l.name, hint: l.group ?? 'Primary' })),
    [ledgers],
  )
  const itemOptions = useMemo(
    () => [
      { id: END, name: 'End of List' },
      ...(items ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        hint: s.group ?? s.unit,
      })),
    ],
    [items],
  )
  const godownOptions = (godowns ?? []).map((g) => ({
    id: g.id,
    name: g.name,
  }))
  const manyGodowns = godownOptions.length > 1 || journal || physical
  const orderOptions = [
    { id: NONE, name: 'Not Applicable' },
    ...orders.map((o) => ({
      id: o.voucherId,
      name: `${o.type} No. ${o.docNo ?? o.number}`,
      hint: fmtDate(o.date),
    })),
  ]

  const table = (side: 1 | -1, title?: string) => {
    const mine = rows.map((r, i) => ({ r, i })).filter((x) => !journal || x.r.side === side)
    const total = mine.reduce((t, { r }) => t + (parseMoney(r.amount) ?? 0), 0)
    const cols = 2 + (manyGodowns ? 1 : 0) + (physical ? 0 : 3) + (isOrder ? 1 : 0)
    return (
      <table className="vch-table inv-table">
        {title && <caption>{title}</caption>}
        <thead>
          <tr>
            <th>Name of Item</th>
            {manyGodowns && <th>Godown</th>}
            <th className="num">{physical ? 'Counted' : 'Quantity'}</th>
            {!physical && <th className="num">Rate</th>}
            <th>per</th>
            {!physical && <th className="num">Amount</th>}
            {isOrder && <th>Due on</th>}
          </tr>
        </thead>
        <tbody>
          {mine.map(({ r, i }) => {
            const s = r.itemId ? itemById.get(r.itemId) : undefined
            const last = physical ? 'qty' : isOrder ? 'due' : 'amount'
            return (
              <tr key={i} className="vch-row">
                <td data-field={`item:${i}`}>
                  <Picker
                    options={itemOptions}
                    value={r.itemId}
                    onChange={(itemId) => (itemId === END ? listDone(i) : setRow(i, { itemId }))}
                    placeholder="Stock item"
                    autoFocus={!party && !id && i === 0} // no party to ask for: start on the first item
                  />
                  {r.role && (
                    <span className="badge muted-badge" title={r.role === 'scrap' ? 'valued at the rate typed; comes off the cost' : 'takes its share of the cost'}>
                      {r.role === 'scrap' ? 'Scrap' : `By-product${r.costShare != null ? ` · ${r.costShare / 100}% of the cost` : ''}`}
                    </span>
                  )}
                  {s?.batches && r.itemId !== null && !isOrder && (
                    <BatchFields itemId={r.itemId} line={i} inward={(dir ?? r.side) > 0} value={{ batch: r.batch ?? '', mfgDate: r.mfgDate ?? '', expiryDate: r.expiryDate ?? '' }}
                      onChange={(patch) => setRow(i, patch)} />
                  )}
                </td>
                {manyGodowns && (
                  <td>
                    <Picker options={godownOptions} value={r.godownId} onChange={(godownId) => setRow(i, { godownId })} placeholder="Godown" />
                  </td>
                )}
                <td className="num">
                  <Field
                    value={r.qty}
                    onChange={(qty) => setRow(i, { qty })}
                    onDone={last === 'qty' ? () => rowDone(i) : undefined}
                    label={`Item ${i + 1} ${physical ? 'counted' : 'quantity'}`}
                  />
                </td>
                {!physical && (
                  <td className="num">
                    <Field value={r.rate} onChange={(rate) => setRow(i, { rate })} label={`Item ${i + 1} rate`} />
                  </td>
                )}
                <td className="muted">{s?.unit}</td>
                {!physical && (
                  <td className="num">
                    <Field
                      value={r.amount}
                      onChange={(amount) => setRow(i, { amount })}
                      onDone={last === 'amount' ? () => rowDone(i) : undefined}
                      label={`Item ${i + 1} amount`}
                    />
                  </td>
                )}
                {isOrder && (
                  <td>
                    <input
                      className="date"
                      aria-label={`Item ${i + 1} due on`}
                      placeholder="due"
                      value={r.due}
                      onChange={(e) => setRow(i, { due: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return
                        e.preventDefault()
                        rowDone(i)
                      }}
                    />
                  </td>
                )}
              </tr>
            )
          })}
          {mine.length === 0 && (
            <tr>
              <td colSpan={cols}>
                <button type="button" onClick={() => setRows((rs) => [...rs, emptyRow(mainGodown, side)])}>
                  Add item line
                </button>
              </td>
            </tr>
          )}
        </tbody>
        {!physical && (
          <tfoot>
            <tr>
              <td className="muted" colSpan={cols - (isOrder ? 2 : 1)}>
                Total
              </td>
              <td className="num total">{formatINR(total)}</td>
              {isOrder && <td />}
            </tr>
          </tfoot>
        )}
      </table>
    )
  }

  const hint = physical
    ? 'F2 date · enter what was counted; the books follow · Ctrl+A accept'
    : 'F2 date · Alt+C new item/ledger · End of List closes a list · Ctrl+A accept'
  return (
    <form
      ref={formRef}
      className="voucher"
      onSubmit={(e) => {
        e.preventDefault()
        trySave()
      }}
    >
      <Title right={(saved && <span className="ok">{saved}</span>) || <span className="muted">{hint}</span>}>
        {id ? `${type} Alteration` : `${type} Creation`}
      </Title>
      {confirm}
      <div className="vch-head">
        <span className={`vch-type t-${type.replace(' ', '')}`}>{type}</span>
        <span>No. {number ?? 'auto'}</span>
        <span className="spacer" />
        <span className="muted">Date</span>
        <DateInput value={date} onChange={setDate} fyStart={company.fyStart} label="Date" inputRef={dateRef} />
      </div>

      {party && (
        <div className="inv-head">
          <label data-field="party">
            Party A/c name
            <Picker
              options={partyOptions}
              value={partyId}
              onChange={(p) => {
                setPartyId(p)
                setAgainstId(null)
              }}
              placeholder="Party"
              autoFocus={!id}
            />
          </label>
          {orderType && (orders.length > 0 || againstId) && (
            <label data-field="against">
              Order No(s).
              <Picker options={orderOptions} value={againstId ?? NONE} onChange={pickOrder} placeholder="Not Applicable" />
            </label>
          )}
        </div>
      )}

      {journal ? (
        <div className="journal-sides">
          {table(-1, SIDES[type]![0])}
          {table(1, SIDES[type]![1])}
        </div>
      ) : (
        table(dir ?? 1)
      )}
      {type === 'Manufacturing Journal' && (
        <div className="actions">
          {bomChoices.length > 1 && (
            <select value={bomName} onChange={(e) => setBomName(e.target.value)} aria-label="Bill of materials">
              {bomChoices.map((n) => <option key={n}>{n}</option>)}
            </select>
          )}
          <button type="button" onClick={fillFromBom}>
            <b>Alt+B</b> Components from the bill of materials
          </button>
        </div>
      )}
      {takesCost && (
        <label className="inline-field">
          {type === 'Material In' ? 'Job work charges' : 'Additional cost (labour, power…)'}
          <input className="amount" inputMode="decimal" value={extra} onChange={(e) => setExtra(e.target.value)} aria-label="Additional cost" />
        </label>
      )}
      {costed && <p className="muted">What is consumed goes out at average cost; what is made or received takes that cost{takesCost ? ' plus the additional cost' : ''} when saved.</p>}

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
        <button type="submit" className="primary">
          <b>Ctrl+A</b> Accept
        </button>
      </div>
    </form>
  )
}
