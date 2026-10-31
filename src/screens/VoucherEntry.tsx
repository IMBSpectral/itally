import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useVoucherTypeFields } from './VoucherTypes'
import { newVoucherDate, useApp, voucherKey } from '../App'
import { api, ApiError, type Bill, type Cost, type Ledger, type PendingBill, type TdsSuggestion } from '../api'
import { formatINR, toPaise } from '../../server/src/engine/money'
import type { VoucherType } from '../../server/src/engine/voucher'
import { CASH_BANK_GROUPS } from '../../server/src/engine/groups'
import { STOCK_DIRECTION } from '../../server/src/engine/inventory'
import { DateInput, drcr, Errors, fmtDate, focusNext, Picker, Title, useActive, useConfirm, useLoad } from '../ui'
import { parseShortDate } from '../../server/src/engine/dates'
import { BillPanel, billSummary } from './BillPanel'
import { CostPanel, costSummary } from './CostPanel'
import { TdsHint } from './Tds'
import { defaultRate, ForexAmount, formatForexField, forexToRupeesField, rupeesToForexField } from './Forex'
import { formatRate, parseForex, parseRate } from '../../server/src/engine/forex'

type Side = 'Dr' | 'Cr'
interface Row {
  side: Side
  ledgerId: number | null
  amount: string // as typed, rupees
  bills?: Bill[] | null // bill-wise details, signed like the line
  costs?: Cost[] | null // cost centre split, signed like the line
  chequeNo?: string // a bank line's instrument
  chequeDate?: string | null // yyyy-mm-dd; blank = the voucher's date
  forex?: string // on a foreign-currency ledger: the amount in the currency, as typed ("0" = a forex adjustment in rupees)
  rate?: string // its rate of exchange, rupees for one unit
}

/** Receipts start with the party being credited; everything else starts with a debit. */
const firstSide = (t: VoucherType): Side => (t === 'Receipt' ? 'Cr' : 'Dr')
const flip = (s: Side): Side => (s === 'Dr' ? 'Cr' : 'Dr')

function parse(a: string): number | null {
  if (!a.trim()) return null
  try {
    return toPaise(a)
  } catch {
    return null
  }
}

/** Paise as typed in an amount field (1050.00, no grouping). */
const plainAmount = (p: number) => formatINR(p).replace(/,/g, '')
/** Vouchers that carry the supplier's own invoice number (GSTR-2B matches on it). */
const SUPPLIER_REF: string[] = ['Purchase', 'Debit Note']

/**
 * Double-entry voucher screen. Each line is Dr/Cr + ledger + amount; when a line is complete
 * and the voucher doesn't balance, a new line on the other side is filled with the difference.
 */
export function VoucherEntry({ type: initialType, id }: { type: VoucherType; id?: number }) {
  const { company, period, push, pop, replace, changed, version, features, config } = useApp()
  const vtype = useVoucherTypeFields() // a voucher type of the company's own, and a hand-typed number
  const active = useActive()
  const [confirm, ask] = useConfirm()
  const formRef = useRef<HTMLFormElement>(null)
  const dateRef = useRef<HTMLInputElement>(null)
  const [type, setType] = useState<VoucherType>(initialType)
  const [date, setDate] = useState(() => newVoucherDate(period, config))
  const [narration, setNarration] = useState('')
  const [rows, setRows] = useState<Row[]>([{ side: firstSide(initialType), ledgerId: null, amount: '' }])
  const [errors, setErrors] = useState<string[]>([])
  const [saved, setSaved] = useState<string | null>(null)
  const [editVersion, setEditVersion] = useState<number | undefined>()
  const [number, setNumber] = useState<number | string | null>(null)
  const [loaded, setLoaded] = useState<string | null>(null) // the altered voucher as first loaded
  const narrationRef = useRef<HTMLTextAreaElement>(null)
  const firstLedger = useRef<HTMLInputElement>(null)
  // bill-wise details panel: which line it is open for, and that ledger's open bills
  const [billFor, setBillFor] = useState<{ line: number; pending: PendingBill[]; defaultName: string } | null>(null)
  // cost allocations panel: the line it is open for
  const [costFor, setCostFor] = useState<number | null>(null)
  // bank details (cheque number and date) for a bank line
  const [chequeFor, setChequeFor] = useState<number | null>(null)
  const [postDated, setPostDated] = useState(false)
  const [optional, setOptional] = useState(false) // Ctrl+L: kept, but out of the books
  const [applicableUpto, setApplicableUpto] = useState('') // a Reversing Journal: effective in scenarios up to this date
  const [refNo, setRefNo] = useState('') // Purchase, Debit Note: the supplier's invoice number and date
  const [refDate, setRefDate] = useState('')
  const [advanceRate, setAdvanceRate] = useState('') // a Receipt in advance for services: its GST rate
  const [costTrack, setCostTrack] = useState('') // F11 cost tracking: the job or consignment
  const [held, setHeld] = useState(false) // post-dated, waiting for its date
  const [gstAdjustment, setGstAdjustment] = useState<'itc-reversal' | 'itc-reclaim' | ''>('') // a Journal reversing or reclaiming ITC
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  const { data: ledgers } = useLoad(() => api.ledgers(company.id, period), [company.id, period, version])
  const { data: costMasters } = useLoad(() => api.costMasters(company.id), [company.id, version])
  // currencies with the rates in force on the voucher's date
  const { data: rates } = useLoad(
    () => (features.multiCurrency ? api.rates(company.id, date) : Promise.resolve([])),
    [company.id, date, version, features.multiCurrency],
  )

  // altering an existing voucher
  useEffect(() => {
    if (!id) return
    Promise.all([api.voucher(company.id, id), api.currencies(company.id)]).then(([v, currencies]) => {
      const decimalsOf = (ledgerId: number) => currencies.find((c) => c.id === ledgers?.find((l) => l.id === ledgerId)?.currencyId)?.decimals ?? 2
      setType(v.type)
      setDate(v.date)
      setNarration(v.narration)
      setPostDated(!!v.postDated)
      setOptional(!!v.optional && v.type !== 'Memorandum')
      setApplicableUpto(v.applicableUpto ?? '')
      setRefNo(v.refNo ?? '')
      setRefDate(v.refDate ?? '')
      setAdvanceRate(v.advanceRate != null ? String(v.advanceRate / 100) : '')
      setCostTrack(v.costTrack ?? '')
      setHeld(!!v.held)
      setGstAdjustment(v.gstAdjustment ?? '')
      setNumber(v.docNo ?? v.number)
      setEditVersion(v.version)
      const loadedRows: Row[] = v.entries.map((e) => ({
        side: e.amount > 0 ? 'Dr' : 'Cr',
        ledgerId: e.ledgerId,
        amount: formatINR(Math.abs(e.amount)).replace(/,/g, ''),
        bills: e.bills ?? null,
        costs: e.costs?.map((c) => ({ centreId: c.centreId, amount: c.amount })) ?? null,
        ...(e.chequeNo || e.chequeDate ? { chequeNo: e.chequeNo ?? '', chequeDate: e.chequeDate ?? null } : {}),
        ...(e.forex != null ? { forex: formatForexField(Math.abs(e.forex), decimalsOf(e.ledgerId)), rate: e.forexRate ? formatRate(e.forexRate) : '' } : {}),
      }))
      setRows(loadedRows)
      setLoaded(JSON.stringify({ date: v.date, narration: v.narration, rows: loadedRows }))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id, id, !!ledgers])

  // Ctrl+A accepts; F2 goes to the date; Alt+C creates a ledger for the current line;
  // Esc / Ctrl+Q ask before throwing away a half-entered voucher;
  // F4–F9 switch the type of a new voucher (Tally's behaviour)
  useEffect(() => {
    if (!active) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'F2' && !e.altKey) {
        e.preventDefault()
        dateRef.current?.focus()
        return
      }
      // Ctrl+L: optional, as in Tally (a browser keeps Ctrl+L for its address bar; the button does it there)
      if (e.ctrlKey && (e.key === 'l' || e.key === 'L') && type !== 'Memorandum' && type !== 'Reversing Journal') {
        e.preventDefault()
        setOptional((x) => !x)
        return
      }
      // Ctrl+T: post-dated, as in Tally (listed as such until its date arrives)
      if (e.ctrlKey && (e.key === 't' || e.key === 'T')) {
        e.preventDefault()
        setPostDated((x) => !x)
        return
      }
      // Esc in the bank details closes them; the line moves on
      if (e.key === 'Escape' && chequeFor !== null) {
        e.preventDefault()
        e.stopImmediatePropagation()
        const line = chequeFor
        setChequeFor(null)
        finishLine(line)
        return
      }
      if (e.altKey && (e.key === 'c' || e.key === 'C')) {
        const row = (document.activeElement as HTMLElement | null)?.closest('.vch-row')
        const rowsEls = [...(formRef.current?.querySelectorAll('.vch-row') ?? [])]
        const i = row ? rowsEls.indexOf(row) : -1
        if (i < 0) return
        e.preventDefault()
        // what was typed in the ledger field becomes the new ledger's name, as in Tally
        const typed = (document.activeElement as HTMLInputElement).closest('.picker') ? (document.activeElement as HTMLInputElement).value : ''
        push({ k: 'ledger', name: typed, onCreated: (ledgerId) => update(i, { ledgerId }) })
        return
      }
      // Esc in the cost panel closes just the panel, keeping the split the line had
      if (e.key === 'Escape' && costFor !== null && !formRef.current?.querySelector('.picker-list')) {
        e.preventDefault()
        e.stopImmediatePropagation()
        const line = costFor
        setCostFor(null)
        billsStep(line)
        return
      }
      // Esc in the bill-wise panel closes just the panel; the line's amount stays on account
      if (e.key === 'Escape' && billFor && !formRef.current?.querySelector('.picker-list')) {
        e.preventDefault()
        e.stopImmediatePropagation()
        const line = billFor.line
        setBillFor(null)
        lineDone(line)
        return
      }
      const quit = e.key === 'Escape' || (e.ctrlKey && (e.key === 'q' || e.key === 'Q'))
      // an open ledger list takes Esc first
      if (quit && !formRef.current?.querySelector('.picker-list') && dirty) {
        e.preventDefault()
        e.stopImmediatePropagation()
        ask(id ? 'Quit without saving the changes?' : 'Quit? The voucher will not be saved.', pop)
        return
      }
      const vk = voucherKey(e)
      if (e.altKey && (e.key === 'p' || e.key === 'P') && id) {
        e.preventDefault()
        e.stopImmediatePropagation() // the saved voucher as a document
        push({ k: 'voucher-print', id })
        return
      }
      // Ctrl+V: item invoice mode for Sales, Purchase and the notes (in the narration it still pastes)
      if (e.ctrlKey && (e.key === 'v' || e.key === 'V') && !id && type in STOCK_DIRECTION && !(e.target as HTMLElement).closest('textarea')) {
        e.preventDefault()
        e.stopImmediatePropagation()
        const go = () => replace({ k: 'voucher', type, invoice: true })
        if (dirty) ask('Switch to invoice mode? What is entered here will be lost.', go)
        else go()
        return
      }
      if (vk && id) {
        e.preventDefault()
        e.stopImmediatePropagation() // the type of an existing voucher can't change
      } else if (vk && vk.type in STOCK_DIRECTION && vk.type !== type) {
        e.preventDefault()
        e.stopImmediatePropagation()
        replace({ k: 'voucher', type: vk.type }) // opens as an invoice when the company keeps stock
      } else if (vk) {
        e.preventDefault()
        e.stopImmediatePropagation()
        reset(vk.type)
      }
      if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        trySave()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  })

  // a new voucher is dirty once anything is entered; an alteration once it differs from what was loaded
  const dirty = id
    ? loaded !== null && JSON.stringify({ date, narration, rows }) !== loaded
    : narration.trim() !== '' || rows.some((r) => r.ledgerId !== null || r.amount.trim() !== '')

  const options = useMemo(() => {
    // a quick filter on the immediate group; the server's rules are the authority
    const isCashBank = (l: Ledger) => CASH_BANK_GROUPS.includes(l.group ?? '')
    return (ledgers ?? [])
      .filter((l) => l.group !== 'Stock-in-Hand')
      .filter((l) => type !== 'Contra' || isCashBank(l))
      .map((l) => ({ id: l.id, name: l.name, hint: l.group ?? 'Primary' }))
  }, [ledgers, type])

  const totals = rows.reduce(
    (t, r) => {
      const p = parse(r.amount)
      if (p) t[r.side] += p
      return t
    },
    { Dr: 0, Cr: 0 },
  )

  /** Start a fresh voucher; `keepNotice` keeps the "saved" message after a successful save. */
  function reset(t: VoucherType, keepNotice = false) {
    if (!keepNotice) setSaved(null)
    setType(t)
    setRows([{ side: firstSide(t), ledgerId: null, amount: '' }])
    setBillFor(null)
    setCostFor(null)
    setChequeFor(null)
    setPostDated(false)
    setOptional(false)
    setApplicableUpto('')
    setRefNo('')
    setRefDate('')
    setAdvanceRate('')
    setCostTrack('')
    setHeld(false)
    setGstAdjustment('')
    setNarration('')
    setErrors([])
    setTimeout(() => firstLedger.current?.focus(), 0)
  }

  function update(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, n) => (n === i ? { ...r, ...patch } : r)))
  }

  /** After an amount: the cost allocations where cost centres apply, then the bill-wise details. */
  function amountDone(i: number) {
    const r = rowsRef.current[i]
    const l = r.ledgerId ? ledgerById.get(r.ledgerId) : undefined
    if (l?.costCentres && costMasters?.centres.length && parse(r.amount)) return setCostFor(i)
    billsStep(i)
  }

  /** On a bill-wise ledger, open the bill-wise details before moving on. */
  async function billsStep(i: number) {
    const r = rowsRef.current[i]
    const l = r.ledgerId ? ledgerById.get(r.ledgerId) : undefined
    const p = parse(r.amount)
    if (!l?.billwise || !p) return lineDone(i)
    const [out, next] = await Promise.all([
      api.outstanding(company.id, l.id, { from: period.from, to: date }, id),
      number ? Promise.resolve(number) : api.nextNumber(company.id, type),
    ])
    setBillFor({ line: i, pending: out.bills, defaultName: String(next) })
  }

  /** A bank line on a Payment, Receipt or Contra asks for its cheque first (the next leaf is suggested for a payment). */
  async function lineDone(i: number) {
    const r = rowsRef.current[i]
    const l = r.ledgerId ? ledgerById.get(r.ledgerId) : undefined
    const bank = l && ['Bank Accounts', 'Bank OD A/c'].includes(l.group ?? '') && ['Payment', 'Receipt', 'Contra'].includes(type)
    if (!bank || !parse(r.amount)) return finishLine(i)
    if (r.chequeNo === undefined) {
      const next = r.side === 'Cr' ? await api.nextCheque(company.id, l!.id).catch(() => null) : null
      update(i, { chequeNo: next ?? '' })
      rowsRef.current = rowsRef.current.map((x, n) => (n === i ? { ...x, chequeNo: next ?? '' } : x))
    }
    setChequeFor(i)
  }

  /** After a line is complete: add a balancing line, or go to narration when balanced. */
  function finishLine(i: number) {
    const rs = rowsRef.current.slice()
    const sum = rs.reduce(
      (t, r) => {
        const p = parse(r.amount)
        if (p) t[r.side] += p
        return t
      },
      { Dr: 0, Cr: 0 },
    )
    const diff = sum.Dr - sum.Cr
    if (diff === 0) {
      // drop an empty trailing line and move on
      const cleaned = rs.filter((r) => r.ledgerId !== null || parse(r.amount))
      setRows(cleaned.length ? cleaned : rs)
      setTimeout(() => narrationRef.current?.focus(), 0)
      return
    }
    if (i === rs.length - 1) {
      const side: Side = diff > 0 ? 'Cr' : 'Dr'
      rs.push({ side, ledgerId: null, amount: formatINR(Math.abs(diff)).replace(/,/g, '') })
      setRows(rs)
    }
    // focus the next line's ledger
    setTimeout(() => {
      const els = formRef.current?.querySelectorAll<HTMLInputElement>('.vch-row .picker input') ?? []
      els[i + 1]?.focus()
    }, 0)
  }

  async function save() {
    setErrors([])
    const entries = rows
      .filter((r) => r.ledgerId !== null || r.amount.trim())
      .map((r, n) => {
        const p = parse(r.amount)
        if (r.ledgerId === null) throw new ApiError('', [`Line ${n + 1}: choose a ledger`])
        if (p === null || p === 0) throw new ApiError('', [`Line ${n + 1}: enter an amount`])
        const c = currencyOf(r.ledgerId)
        let fx = {}
        if (c) {
          const f = parseForex(r.forex ?? '', c.decimals)
          if (f === null) throw new ApiError('', [`Line ${n + 1}: enter the amount in ${c.symbol}`])
          const rate = f ? parseRate(r.rate ?? '') : null
          if (f && !rate) throw new ApiError('', [`Line ${n + 1}: enter the rate of exchange for ${c.symbol}`])
          fx = { forex: r.side === 'Dr' ? Math.abs(f) : -Math.abs(f), forexRate: rate }
        }
        return {
          ...fx,
          ledgerId: r.ledgerId,
          amount: r.side === 'Dr' ? p : -p,
          bills: r.bills?.length ? r.bills : undefined,
          costs: r.costs?.length ? r.costs : undefined,
          ...(r.chequeNo?.trim() ? { chequeNo: r.chequeNo.trim(), chequeDate: r.chequeDate || date } : {}),
        }
      })
    const reversing = type === 'Reversing Journal'
    const body = {
      type, date, narration, entries, postDated, optional: optional && type !== 'Memorandum' && !reversing, gstAdjustment: type === 'Journal' && gstAdjustment ? gstAdjustment : null,
      ...(reversing ? { applicableUpto: applicableUpto || date } : {}),
      ...(SUPPLIER_REF.includes(type) ? { refNo: refNo.trim() || null, refDate: refDate || null } : {}),
      ...(type === 'Receipt' ? { advanceRate: advanceRate.trim() ? Math.round(Number(advanceRate) * 100) : null } : {}),
      ...(features.costTracking ? { costTrack: costTrack.trim() || null } : {}),
    }
    const v = id ? await api.alterVoucher(company.id, id, { ...body, ...vtype.fields, version: editVersion! }) : await api.postVoucher(company.id, { ...body, ...vtype.fields })
    changed()
    if (id) return pop()
    reset(type, true)
    setSaved(`${v.type} No. ${v.docNo ?? v.number} saved`)
    vtype.clear()
  }

  const trySave = () => {
    const run = () =>
      save().catch((e) => {
        setSaved(null)
        setErrors(e instanceof ApiError && e.errors.length ? e.errors : [e.message])
      })
    // F12: ask before a new voucher takes cash or a bank account below zero
    const below = config.warnNegativeCash && !id && !optional && type !== 'Memorandum' && type !== 'Reversing Journal'
      ? rows.flatMap((r) => {
          const l = r.ledgerId !== null ? ledgerById.get(r.ledgerId) : undefined
          const p = parse(r.amount)
          if (!l || !p || !['Cash-in-Hand', 'Bank Accounts'].includes(l.group ?? '')) return []
          const after = l.closing + (r.side === 'Dr' ? p : -p)
          return after < 0 ? [`${l.name} goes to ${drcr(after)}`] : []
        })
      : []
    if (below.length) ask(`${below.join('; ')}. Save anyway?`, run)
    else run()
  }

  const ledgerById = new Map((ledgers ?? []).map((l) => [l.id, l]))
  const currencyOf = (ledgerId: number | null) => {
    const cid = ledgerId ? ledgerById.get(ledgerId)?.currencyId : null
    return cid ? rates?.find((c) => c.id === cid) : undefined
  }
  /** A ledger picked on a line: on a foreign-currency one, its rate for this voucher, and the rupees already there in the currency. */
  function pickLedger(i: number, ledgerId: number | null) {
    const c = currencyOf(ledgerId)
    if (!c) return update(i, { ledgerId, forex: undefined, rate: undefined })
    const r = rowsRef.current[i]
    const rate = r.rate || defaultRate(rates, c.id, type)
    const p = parse(r.amount)
    const rt = parseRate(rate)
    update(i, { ledgerId, rate, forex: r.forex ?? (p && rt ? rupeesToForexField(p, rt, c.decimals) : '') })
    // the rupee field the picker moved to gives way to the amount in the currency
    setTimeout(() => {
      const el = formRef.current?.querySelectorAll('.vch-row')[i]?.querySelector<HTMLInputElement>('.forex-amount input')
      el?.focus()
      el?.select()
    }, 0)
  }
  /** The amount in the currency or its rate changed: the rupees follow (an amount of 0 keeps the rupees typed). */
  function forexChanged(i: number, forex: string, rate: string) {
    const c = currencyOf(rowsRef.current[i].ledgerId)!
    const f = parseForex(forex, c.decimals)
    const rt = parseRate(rate)
    const patch: Partial<Row> = { forex, rate }
    if (f && rt) patch.amount = forexToRupeesField(Math.abs(f), rt, c.decimals)
    update(i, patch)
    rowsRef.current = rowsRef.current.map((x, n) => (n === i ? { ...x, ...patch } : x))
  }

  // TDS: the lines as they stand, without the TDS ledgers' own (they are what is being worked out)
  const tdsEntries = rows.flatMap((r) => {
    const p = parse(r.amount)
    return r.ledgerId !== null && p ? [{ ledgerId: r.ledgerId, amount: r.side === 'Dr' ? p : -p }] : []
  })
  /** Alt+T: book the TDS (TCS) due on each nature's tax ledger and take it off the party's credit (add it to the buyer's debit). */
  function deductTds(found: TdsSuggestion[]) {
    let rs = rowsRef.current.filter((r) => r.ledgerId !== null || parse(r.amount))
    for (const s of found) {
      const at = rs.findIndex((r) => r.ledgerId === s.ledgerId)
      const before = at >= 0 ? (rs[at].side === 'Cr' ? parse(rs[at].amount) ?? 0 : -(parse(rs[at].amount) ?? 0)) : 0
      const line: Row = { side: 'Cr', ledgerId: s.ledgerId, amount: plainAmount(s.due) }
      rs = at >= 0 ? rs.map((r, n) => (n === at ? { ...r, ...line } : r)) : [...rs, line]
      const tcs = s.kind === 'TCS'
      const party = rs.findIndex((r) => r.ledgerId === s.partyId && r.side === (tcs ? 'Dr' : 'Cr'))
      if (party >= 0) rs = rs.map((r, n) => (n === party ? { ...r, amount: plainAmount((parse(r.amount) ?? 0) + (tcs ? 1 : -1) * (s.due - before)) } : r))
    }
    setRows(rs)
    setTimeout(() => narrationRef.current?.focus(), 0)
  }

  return (
    <form
      ref={formRef}
      className="voucher"
      onSubmit={(e) => {
        e.preventDefault()
        trySave()
      }}
    >
      <Title right={(saved && <span className="ok">{saved}</span>) || <span className="muted">F2 date · Alt+C new ledger · Ctrl+T post-dated · Ctrl+L optional · Ctrl+A accept</span>}>
        {id ? 'Alteration' : 'Accounting Voucher Creation'}
      </Title>
      {confirm}
      <div className="vch-head">
        <span className={`vch-type t-${type.replace(' ', '')}`}>{type}</span>
        <span>No. {number ?? 'auto'}</span>
        {postDated && <span className="badge">{held ? `Post-dated: out of the books until ${fmtDate(date)}` : 'Post-dated'}</span>}
        {features.costTracking && (
          <label className="inline-field">
            Cost track
            <input size={10} value={costTrack} onChange={(e) => setCostTrack(e.target.value)} placeholder="—" aria-label="Cost track" />
          </label>
        )}
        {(optional || type === 'Memorandum' || type === 'Reversing Journal') && (
          <span className="badge muted-badge">{type === 'Memorandum' || type === 'Reversing Journal' ? 'Not in the books' : 'Optional'}</span>
        )}
        {SUPPLIER_REF.includes(type) && (
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
        {type === 'Receipt' && (
          <label className="inline-field" title="An advance for services, taxed on receipt (GSTR-1 table 11A): its GST rate">
            Advance GST rate %
            <input size={4} inputMode="decimal" value={advanceRate} onChange={(e) => setAdvanceRate(e.target.value)} placeholder="—" aria-label="Advance GST rate" />
          </label>
        )}
        {type === 'Reversing Journal' && (
          <label className="inline-field">
            Applicable up to
            <input type="date" value={applicableUpto} min={date} onChange={(e) => setApplicableUpto(e.target.value)} aria-label="Applicable up to" />
          </label>
        )}
        <span className="spacer" />
        <span className="muted">Date</span>
        <DateInput value={date} onChange={setDate} fyStart={company.fyStart} label="Date" inputRef={dateRef} />
      </div>

      <table className="vch-table">
        <thead>
          <tr>
            <th style={{ width: 60 }}>Dr/Cr</th>
            <th>Particulars</th>
            <th className="num">Debit</th>
            <th className="num">Credit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const l = r.ledgerId ? ledgerById.get(r.ledgerId) : undefined
            return [
              <tr key={i} className="vch-row">
                <td>
                  <select
                    value={r.side}
                    onChange={(e) => update(i, { side: e.target.value as Side })}
                    onKeyDown={(e) => {
                      // Tally: type D or C for the side, Enter moves on to the ledger
                      if (e.key === 'd' || e.key === 'D') update(i, { side: 'Dr' })
                      if (e.key === 'c' || e.key === 'C') update(i, { side: 'Cr' })
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        focusNext(e.currentTarget)
                      }
                    }}
                    aria-label={`Line ${i + 1} side`}
                  >
                    <option>Dr</option>
                    <option>Cr</option>
                  </select>
                </td>
                <td>
                  <Picker
                    options={options}
                    value={r.ledgerId}
                    onChange={(ledgerId) => pickLedger(i, ledgerId)}
                    placeholder="Ledger"
                    autoFocus={i === 0 && !id}
                    inputRef={i === 0 ? firstLedger : undefined}
                  />
                  {l && config.showBalances && <div className="cur-bal">Cur Bal: {drcr(l.closing) || 'nil'}</div>}
                  {r.bills?.length ? <div className="cur-bal">{billSummary(r.bills)}</div> : null}
                  {r.costs?.length ? <div className="cur-bal">{costSummary(r.costs, costMasters)}</div> : null}
                  {r.chequeNo?.trim() && chequeFor !== i ? (
                    <div className="cur-bal">
                      Cheque {r.chequeNo} · {fmtDate(r.chequeDate || date)}
                    </div>
                  ) : null}
                </td>
                {(['Dr', 'Cr'] as const).map((s) => {
                  const label = `Line ${i + 1} ${s === 'Dr' ? 'debit' : 'credit'}`
                  const c = currencyOf(r.ledgerId)
                  const adjustment = c && parseForex(r.forex ?? '', c.decimals) === 0
                  return (
                    <td key={s} className="num">
                      {r.side === s && c && (
                        <ForexAmount currency={c} forex={r.forex ?? ''} rate={r.rate ?? ''} onChange={(forex, rate) => forexChanged(i, forex, rate)} onDone={() => amountDone(i)} label={label} />
                      )}
                      {r.side === s && (!c || adjustment) && <AmountInput value={r.amount} onChange={(amount) => update(i, { amount })} onDone={() => amountDone(i)} label={label} />}
                      {r.side === s && c && !adjustment && <div className="cur-bal">= ₹{r.amount || '0.00'}</div>}
                    </td>
                  )
                })}
              </tr>,
              chequeFor === i && l && (
                <tr key={`cheque-${i}`}>
                  <td />
                  <td colSpan={3}>
                    <div className="bill-panel cheque-panel">
                      <div className="bill-head">
                        <b>Bank details for: {l.name}</b>
                        <span className="muted">Enter moves on · Esc skips</span>
                      </div>
                      <label>
                        Cheque / DD No.
                        <input
                          autoFocus
                          value={r.chequeNo ?? ''}
                          aria-label="Cheque number"
                          onChange={(e) => update(i, { chequeNo: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter') return
                            e.preventDefault()
                            e.stopPropagation()
                            focusNext(e.currentTarget)
                          }}
                        />
                      </label>
                      <label>
                        Cheque date
                        <ChequeDate
                          value={r.chequeDate || date}
                          fyStart={company.fyStart}
                          onChange={(d) => {
                            update(i, { chequeDate: d })
                            // finishLine reads the ref in this same keystroke, before a re-render
                            rowsRef.current = rowsRef.current.map((x, n) => (n === i ? { ...x, chequeDate: d } : x))
                          }}
                          onDone={() => {
                            setChequeFor(null)
                            finishLine(i)
                          }}
                        />
                      </label>
                    </div>
                  </td>
                </tr>
              ),
              costFor === i && l && costMasters && (
                <tr key={`costs-${i}`}>
                  <td />
                  <td colSpan={3}>
                    <CostPanel
                      ledger={l.name}
                      amount={(parse(r.amount) ?? 0) * (r.side === 'Dr' ? 1 : -1)}
                      masters={costMasters}
                      initial={r.costs}
                      onDone={(costs) => {
                        update(i, { costs })
                        setCostFor(null)
                        rowsRef.current = rowsRef.current.map((x, n) => (n === i ? { ...x, costs } : x))
                        billsStep(i)
                      }}
                    />
                  </td>
                </tr>
              ),
              billFor?.line === i && l && (
                <tr key={`bills-${i}`}>
                  <td />
                  <td colSpan={3}>
                    <BillPanel
                      ledger={l.name}
                      amount={(parse(r.amount) ?? 0) * (r.side === 'Dr' ? 1 : -1)}
                      voucherDate={date}
                      fyStart={company.fyStart}
                      pending={billFor.pending}
                      initial={r.bills}
                      defaultName={billFor.defaultName}
                      onDone={(bills) => {
                        update(i, { bills })
                        setBillFor(null)
                        rowsRef.current = rowsRef.current.map((x, n) => (n === i ? { ...x, bills } : x))
                        lineDone(i)
                      }}
                    />
                  </td>
                </tr>
              ),
            ]
          })}
        </tbody>
        <tfoot>
          <tr>
            <td />
            <td className="muted">
              {totals.Dr !== totals.Cr && `Difference: ${formatINR(Math.abs(totals.Dr - totals.Cr))}`}
            </td>
            <td className="num total">{formatINR(totals.Dr)}</td>
            <td className="num total">{formatINR(totals.Cr)}</td>
          </tr>
        </tfoot>
      </table>
      <TdsHint voucherId={id} date={date} entries={tdsEntries} onDeduct={deductTds} />

      {type === 'Journal' && (
        <label className="gst-adjustment">
          GST adjustment
          <select value={gstAdjustment} onChange={(e) => setGstAdjustment(e.target.value as typeof gstAdjustment)} aria-label="GST adjustment">
            <option value="">Not applicable</option>
            <option value="itc-reversal">Reversal of input tax credit (GSTR-3B 4B)</option>
            <option value="itc-reclaim">Reclaim of input tax credit (GSTR-3B 4D)</option>
          </select>
        </label>
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
        <button type="button" onClick={() => setRows((rs) => [...rs, { side: flip(rs[rs.length - 1]?.side ?? 'Dr'), ledgerId: null, amount: '' }])}>
          Add line
        </button>
        {/* Ctrl+T does this in the desktop app; a browser keeps Ctrl+T for a new tab */}
        <button type="button" onClick={() => setPostDated((x) => !x)} aria-pressed={postDated}>
          {postDated ? 'Not post-dated' : 'Post-dated'}
        </button>
        {type !== 'Memorandum' && type !== 'Reversing Journal' && (
          <button type="button" onClick={() => setOptional((x) => !x)} aria-pressed={optional}>
            {optional ? (id ? 'Make regular' : 'Not optional') : 'Optional'}
          </button>
        )}
        <button type="submit" className="primary">
          <b>Ctrl+A</b> Accept
        </button>
      </div>
    </form>
  )
}

/** The cheque's date: Enter accepts it and closes the bank details. */
function ChequeDate({ value, fyStart, onChange, onDone }: { value: string; fyStart: string; onChange: (d: string) => void; onDone: () => void }) {
  const [text, setText] = useState(fmtDate(value))
  const [bad, setBad] = useState(false)
  return (
    <input
      className={`date ${bad ? 'bad' : ''}`}
      aria-label="Cheque date"
      value={text}
      onFocus={(e) => e.target.select()}
      onChange={(e) => {
        setText(e.target.value)
        setBad(false)
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        e.stopPropagation()
        const iso = parseShortDate(text, value, fyStart)
        if (!iso) return setBad(true)
        onChange(iso)
        onDone()
      }}
    />
  )
}

function AmountInput({ value, onChange, onDone, label }: { value: string; onChange: (v: string) => void; onDone: () => void; label: string }) {
  return (
    <input
      className="amount"
      inputMode="decimal"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onDone()
        }
      }}
    />
  )
}
