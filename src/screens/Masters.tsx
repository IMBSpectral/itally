import { useEffect, useState, type FormEvent } from 'react'
import { useApp } from '../App'
import { api, ApiError } from '../api'
import { formatINR, toPaise } from '../../server/src/engine/money'
import { DEFAULT_GROUPS } from '../../server/src/engine/groups'
import { GST_STATES, gstinError, stateCode, stateName, TAX_TYPES, type Taxability, type TaxType } from '../../server/src/engine/gst'
import { GstDetails } from './Classifications'
import { TdsNaturePicker } from './Tds'
import { formatForexField } from './Forex'
import { parseForex, pickRate, toBase } from '../../server/src/engine/forex'
import { DEDUCTEE_TYPES, type DeducteeType } from '../../server/src/engine/tds'
import { DevanagariButton } from './Transliterate'
import { advanceFrom, DateInput, Errors, Picker, Title, enterAdvances, useActive, useConfirm, useLoad } from '../ui'

/** A GST rate typed as a percentage ("18", "0.25") in hundredths of a percent; blank is none. */
export function parseRate(s: string): number | null {
  if (!s.trim()) return null
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s.trim()) || Number(s) > 100) throw new ApiError('', ['GST rate is a percentage, like 18'])
  return Math.round(Number(s) * 100)
}
export const rateText = (r: number | null | undefined) => (r == null ? '' : String(r / 100))
export const STATE_OPTIONS = GST_STATES.map((s) => ({ id: Number(s.code), name: s.name, hint: s.code }))

export const messages = (err: unknown) => (err instanceof ApiError && err.errors.length ? err.errors : [String((err as Error).message ?? err)])

export function useSubmit(fn: () => Promise<string>) {
  const [errors, setErrors] = useState<string[]>([])
  const [ok, setOk] = useState<string | null>(null)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setErrors([])
    fn()
      .then(setOk)
      .catch((err) => {
        setOk(null)
        setErrors(messages(err))
      })
  }
  return { errors, setErrors, ok, submit }
}

/** Alt+D on an alteration screen asks, then deletes (Tally's key for delete). */
export function useDeleteKey(enabled: boolean, ask: (text: string, yes: () => void) => void, text: string, run: () => void) {
  const active = useActive()
  useEffect(() => {
    if (!enabled || !active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault()
        ask(text, run)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
}

/**
 * Ledger creation and alteration. Opened from a voucher with Alt+C, it hands the new ledger
 * back (`onCreated`) and closes, the way Tally returns to the voucher.
 */
export function LedgerForm({ id, initialName = '', onCreated }: { id?: number; initialName?: string; onCreated?: (id: number) => void }) {
  const { company, changed, pop, features } = useApp()
  const { data: groups } = useLoad(() => api.groups(company.id), [company.id])
  const [name, setName] = useState(initialName)
  const [groupId, setGroupId] = useState<number | null>(null)
  const [primary, setPrimary] = useState(false) // the Profit & Loss A/c has no group
  const [opening, setOpening] = useState('')
  const [side, setSide] = useState<'Dr' | 'Cr'>('Dr')
  const [billwiseChoice, setBillwiseChoice] = useState<boolean | null>(null) // null: follow the group
  const [costChoice, setCostChoice] = useState<boolean | null>(null) // null: follow the group
  const [interestRate, setInterestRate] = useState('') // % a year; blank = no interest calculation
  const [interestOn, setInterestOn] = useState<'balance' | 'bills'>('balance')
  const [reverseCharge, setReverseCharge] = useState(false)
  const [mailing, setMailing] = useState({ mailingName: '', address: '', pincode: '', country: '', phone: '', email: '', pan: '' })
  const setMail = (k: keyof typeof mailing, v: string) => setMailing((m) => ({ ...m, [k]: v }))
  const [creditDays, setCreditDays] = useState('')
  const [openingBills, setOpeningBills] = useState<OpeningBillRow[]>([])
  const [gstin, setGstin] = useState('')
  const [stateId, setStateId] = useState<number | null>(null) // GST state code
  const [taxType, setTaxType] = useState<TaxType | ''>('')
  const [gstRate, setGstRate] = useState('')
  const [cessRate, setCessRate] = useState('')
  const [hsn, setHsn] = useState('')
  const [classificationId, setClassificationId] = useState<number | null>(null)
  const [taxability, setTaxability] = useState<Taxability>('Taxable')
  const [tdsNatureId, setTdsNatureId] = useState<number | null>(null)
  const [deducteeType, setDeducteeType] = useState<DeducteeType | ''>('')
  const [currencyId, setCurrencyId] = useState<number | null>(null) // kept in a foreign currency
  const [openingForex, setOpeningForex] = useState('') // its opening balance in that currency, as typed
  const [loadedForex, setLoadedForex] = useState<number | null>(null) // as loaded, until the currency's decimals are known
  const [confirm, ask] = useConfirm()
  const { data: currencies } = useLoad(
    () => (features.multiCurrency ? api.rates(company.id, company.booksBegin) : Promise.resolve([])),
    [company.id, features.multiCurrency],
  )
  const currency = currencies?.find((c) => c.id === currencyId)
  useEffect(() => {
    if (currency && loadedForex !== null) {
      setOpeningForex(formatForexField(loadedForex, currency.decimals))
      setLoadedForex(null)
    }
  }, [currency, loadedForex])

  useEffect(() => {
    if (!id) return
    api.ledger(company.id, id).then((l) => {
      setName(l.name)
      setGroupId(l.groupId)
      setPrimary(l.groupId === null)
      setOpening(l.opening ? formatINR(Math.abs(l.opening)).replace(/,/g, '') : '')
      setSide(l.opening < 0 ? 'Cr' : 'Dr')
      setBillwiseChoice(l.billwise)
      setCostChoice(l.costCentres ?? false)
      setInterestRate(rateText(l.interestRate))
      setInterestOn(l.interestOn ?? 'balance')
      setReverseCharge(!!l.reverseCharge)
      setMailing({
        mailingName: l.mailingName ?? '', address: l.address ?? '', pincode: l.pincode ?? '', country: l.country ?? '',
        phone: l.phone ?? '', email: l.email ?? '', pan: l.pan ?? '',
      })
      setCreditDays(l.creditDays ? String(l.creditDays) : '')
      setGstin(l.gstin ?? '')
      setStateId(stateCode(l.state) ? Number(stateCode(l.state)) : null)
      setTaxType(l.gstTaxType ?? '')
      setGstRate(rateText(l.gstRate))
      setCessRate(l.cessRate ? rateText(l.cessRate) : '')
      setHsn(l.hsn ?? '')
      setClassificationId(l.gstClassificationId ?? null)
      setTaxability(l.taxability ?? 'Taxable')
      setTdsNatureId(l.tdsNatureId ?? null)
      setDeducteeType(l.deducteeType ?? '')
      setCurrencyId(l.currencyId ?? null)
      setLoadedForex(l.currencyId && l.openingForex ? Math.abs(l.openingForex) : null)
      setOpeningBills(
        l.openingBills.map((b) => ({
          name: b.name,
          billDate: b.billDate,
          amount: formatINR(Math.abs(b.amount)).replace(/,/g, ''),
          side: b.amount < 0 ? 'Cr' : 'Dr',
        })),
      )
    })
  }, [company.id, id])

  const under = (gid: number | null, names: string[]) => {
    for (let g = groups?.find((x) => x.id === gid); g; g = groups?.find((x) => x.id === g!.parentId)) if (names.includes(g.name)) return true
    return false
  }
  const isParty = under(groupId, ['Sundry Debtors', 'Sundry Creditors'])
  const isTax = under(groupId, ['Duties & Taxes'])
  // a rate and HSN/SAC fit sales, purchase, income and expense ledgers (services, freight)
  const isTaxable = !primary && groupId !== null && !isParty && !isTax && !under(groupId, ['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c', 'Stock-in-Hand'])
  // like Tally, party ledgers keep bills unless told otherwise
  const billwise = billwiseChoice ?? isParty
  // once the company has cost centres, income and expense ledgers are split across them by default
  const { data: costMasters } = useLoad(() => api.costMasters(company.id), [company.id])
  const hasCentres = !!costMasters?.centres.length
  const nature = (() => {
    let g = groups?.find((x) => x.id === groupId)
    while (g && g.parentId !== null) g = groups?.find((x) => x.id === g!.parentId)
    return g?.nature
  })()
  // TDS natures of payment on expense ledgers, TCS natures of goods on sales ledgers, either on a tax ledger
  const natureKinds: ('TDS' | 'TCS')[] = [
    ...(features.tds && ((isTax && !taxType) || (isTaxable && nature === 'Expenses')) ? ['TDS' as const] : []),
    ...(features.tcs && ((isTax && !taxType) || (isTaxable && nature === 'Income')) ? ['TCS' as const] : []),
  ]
  const costCentres = costChoice ?? (hasCentres && (nature === 'Income' || nature === 'Expenses'))
  const openingPaise = (() => {
    try {
      return opening.trim() ? toPaise(opening) : 0
    } catch {
      return 0
    }
  })()

  // interest suits balance-sheet ledgers: parties, loans, banks
  const bearsInterest = nature === 'Assets' || nature === 'Liabilities'
  // mailing details too (not on cash, stock or tax ledgers)
  const hasMailing = !primary && bearsInterest && !isTax && !under(groupId, ['Cash-in-Hand', 'Stock-in-Hand'])
  function interestFields() {
    if (!bearsInterest || !interestRate.trim()) return { interestRate: null, interestOn: 'balance' as const }
    const s = interestRate.trim()
    if (!/^\d{1,4}(\.\d{1,2})?$/.test(s) || Number(s) <= 0) throw new ApiError('', ['Interest rate is a yearly percentage, like 18'])
    return { interestRate: Math.round(Number(s) * 100), interestOn: billwise ? interestOn : ('balance' as const) }
  }

  const { errors, setErrors, ok, submit } = useSubmit(async () => {
    if (groupId === null && !primary) throw new ApiError('', ['Choose the group this ledger is under'])
    const fx = bearsInterest && currency ? parseForex(openingForex.trim() || '0', currency.decimals) : null
    if (bearsInterest && currency && fx === null) throw new ApiError('', [`The opening balance in ${currency.symbol} is not an amount`])
    // an opening balance given only in the currency comes to rupees at the standard rate on the books' first day
    const rate = pickRate(currency?.rates, 'standard')
    const p = opening.trim() ? toPaise(opening) : fx && rate ? toBase(fx, rate, currency!.decimals) : 0
    if (creditDays.trim() && !/^\d+$/.test(creditDays.trim())) throw new ApiError('', ['Credit period is a number of days'])
    const body = {
      name,
      groupId,
      opening: side === 'Dr' ? p : -p,
      ...(primary ? {} : { billwise, creditDays: creditDays.trim() ? Number(creditDays) : null, costCentres }),
      ...(primary ? {} : interestFields()),
      // GST details that fit the group; the rest are cleared
      gstin: isParty && gstin.trim() ? gstin.trim().toUpperCase() : null,
      state: isParty && stateId !== null ? stateName(String(stateId).padStart(2, '0')) ?? null : null,
      gstTaxType: isTax && taxType ? taxType : null,
      gstRate: isTaxable && taxability === 'Taxable' ? parseRate(gstRate) : null,
      cessRate: isTaxable && taxability === 'Taxable' && cessRate.trim() ? parseRate(cessRate) : null,
      hsn: isTaxable && hsn.trim() ? hsn.trim() : null,
      gstClassificationId: isTaxable ? classificationId : null,
      taxability: isTaxable ? taxability : undefined,
      // TDS: a party's deductee type; the nature of payment of an expense ledger or a TDS ledger
      deducteeType: isParty && deducteeType ? deducteeType : null,
      tdsNatureId: natureKinds.length ? tdsNatureId : null,
      reverseCharge: nature === 'Expenses' && reverseCharge,
      currencyId: bearsInterest ? currencyId : null,
      openingForex: bearsInterest && currency ? (side === 'Dr' ? fx! : -fx!) : 0,
      // mailing details for parties, banks and loans; the rest are cleared
      ...(hasMailing ? mailing : { mailingName: null, address: null, pincode: null, country: null, phone: null, email: null, pan: null }),
    }
    const bills = openingBills
      .filter((b) => b.name.trim() || b.amount.trim())
      .map((b) => ({ name: b.name, billDate: b.billDate, amount: (b.side === 'Dr' ? 1 : -1) * toPaise(b.amount || '0') }))
    if (id) {
      await api.alterLedger(company.id, id, body)
      if (billwise) await api.setOpeningBills(company.id, id, bills)
      changed()
      pop()
      return ''
    }
    const r = await api.createLedger(company.id, body)
    if (billwise && bills.length) await api.setOpeningBills(company.id, r.id, bills)
    changed()
    if (onCreated) {
      onCreated(r.id)
      pop()
      return ''
    }
    setName('')
    setOpening('')
    setOpeningForex('')
    setOpeningBills([])
    ;(document.querySelector('.screen:not([hidden]) .form input') as HTMLInputElement | null)?.focus()
    return `Ledger "${name}" created`
  })

  useDeleteKey(!!id && !primary, ask, `Delete ledger "${name}"?`, () =>
    api
      .deleteLedger(company.id, id!)
      .then(() => {
        changed()
        pop()
      })
      .catch((e) => setErrors(messages(e))),
  )

  const options = (groups ?? []).map((g) => ({
    id: g.id,
    name: g.name,
    hint: g.parentId ? groups!.find((p) => p.id === g.parentId)?.name : 'Primary',
  }))

  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || (id && !primary && <span className="muted">Alt+D delete</span>)}>
        {id ? 'Ledger Alteration' : 'Ledger Creation'}
      </Title>
      {confirm}
      <label>
        Name
        <input autoFocus required value={name} readOnly={primary} onChange={(e) => setName(e.target.value)} />
        {!primary && <DevanagariButton value={name} onChange={setName} />}
      </label>
      <label>
        Under
        {primary ? <span className="muted">Primary</span> : <Picker options={options} value={groupId} onChange={setGroupId} placeholder="Group" />}
      </label>
      {features.multiCurrency && bearsInterest && !!currencies?.length && (
        <label>
          Currency of ledger
          <select value={currencyId ?? ''} onChange={(e) => setCurrencyId(e.target.value ? Number(e.target.value) : null)} aria-label="Currency of ledger">
            <option value="">₹ Indian Rupee</option>
            {currencies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.symbol} {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {bearsInterest && currency && (
        <label>
          Opening balance in {currency.symbol}
          <input
            className="amount"
            inputMode="decimal"
            value={openingForex}
            onChange={(e) => setOpeningForex(e.target.value)}
            placeholder={`rupees below; blank = at the standard rate`}
            aria-label="Opening balance in the currency"
          />
        </label>
      )}
      <label>
        Opening balance
        <span className="inline">
          <input className="amount" inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} aria-label="Opening balance" />
          <select value={side} onChange={(e) => setSide(e.target.value as 'Dr' | 'Cr')} aria-label="Opening side">
            <option>Dr</option>
            <option>Cr</option>
          </select>
        </span>
      </label>
      {!primary && (
        <>
          <label>
            Maintain balances bill-by-bill
            <select
              value={billwise ? 'Yes' : 'No'}
              onChange={(e) => setBillwiseChoice(e.target.value === 'Yes')}
              onKeyDown={(e) => {
                if (e.key === 'y' || e.key === 'Y') setBillwiseChoice(true)
                if (e.key === 'n' || e.key === 'N') setBillwiseChoice(false)
              }}
              aria-label="Maintain balances bill-by-bill"
            >
              <option>Yes</option>
              <option>No</option>
            </select>
          </label>
          {(hasCentres || costCentres) && (
            <label>
              Cost centres are applicable
              <select
                value={costCentres ? 'Yes' : 'No'}
                onChange={(e) => setCostChoice(e.target.value === 'Yes')}
                onKeyDown={(e) => {
                  if (e.key === 'y' || e.key === 'Y') setCostChoice(true)
                  if (e.key === 'n' || e.key === 'N') setCostChoice(false)
                }}
                aria-label="Cost centres are applicable"
              >
                <option>Yes</option>
                <option>No</option>
              </select>
            </label>
          )}
          {bearsInterest && (
            <label>
              Interest rate (% a year)
              <input className="amount" inputMode="decimal" value={interestRate} onChange={(e) => setInterestRate(e.target.value)} placeholder="none" aria-label="Interest rate" />
            </label>
          )}
          {bearsInterest && interestRate.trim() && billwise && (
            <label>
              Calculate interest on
              <select
                value={interestOn}
                onChange={(e) => setInterestOn(e.target.value as 'balance' | 'bills')}
                aria-label="Calculate interest on"
              >
                <option value="balance">Balance</option>
                <option value="bills">Overdue bills</option>
              </select>
            </label>
          )}
          {billwise && (
            <label>
              Default credit period (days)
              <input className="amount" inputMode="numeric" value={creditDays} onChange={(e) => setCreditDays(e.target.value)} aria-label="Credit period" />
            </label>
          )}
        </>
      )}
      {isParty && (
        <>
          <label>
            GSTIN/UIN
            <input
              value={gstin}
              onChange={(e) => setGstin(e.target.value.toUpperCase())}
              // the state follows from a valid GSTIN
              onBlur={() => !gstinError(gstin) && stateId === null && setStateId(Number(gstin.slice(0, 2)))}
              placeholder="blank if unregistered"
              aria-label="GSTIN"
            />
            {gstin.trim() && gstinError(gstin) && <span className="muted">{gstinError(gstin)}</span>}
          </label>
          <label>
            State
            <Picker options={STATE_OPTIONS} value={stateId} onChange={setStateId} placeholder="State (place of supply)" />
          </label>
        </>
      )}
      {hasMailing && (
        <fieldset className="mailing">
          <legend>Mailing details</legend>
          <label>
            Mailing name
            <input value={mailing.mailingName} onChange={(e) => setMail('mailingName', e.target.value)} placeholder={name} aria-label="Mailing name" />
          </label>
          <label>
            Address
            <textarea
              rows={2}
              value={mailing.address}
              onChange={(e) => setMail('address', e.target.value)}
              // Enter moves on, as in every field; Shift+Enter starts a new line
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  advanceFrom(e.currentTarget)
                }
              }}
              aria-label="Address"
            />
          </label>
          <label>
            Country
            <input value={mailing.country} onChange={(e) => setMail('country', e.target.value)} placeholder="India" aria-label="Country" />
          </label>
          <label>
            PIN code
            <input value={mailing.pincode} onChange={(e) => setMail('pincode', e.target.value)} inputMode="numeric" aria-label="PIN code" />
          </label>
          <label>
            Phone
            <input value={mailing.phone} onChange={(e) => setMail('phone', e.target.value)} aria-label="Phone" />
          </label>
          <label>
            E-mail
            <input value={mailing.email} onChange={(e) => setMail('email', e.target.value)} type="email" aria-label="E-mail" />
          </label>
          <label>
            PAN
            <input
              value={mailing.pan}
              onChange={(e) => setMail('pan', e.target.value.toUpperCase())}
              placeholder={isParty && gstin.length === 15 ? gstin.slice(2, 12) : ''}
              aria-label="PAN"
            />
          </label>
        </fieldset>
      )}
      {(features.tds || features.tcs) && isParty && (
        <label>
          {features.tcs ? (features.tds ? 'TDS deductee / TCS buyer type' : 'TCS buyer type') : 'TDS deductee type'}
          <select value={deducteeType} onChange={(e) => setDeducteeType(e.target.value as DeducteeType | '')} aria-label="TDS deductee type">
            <option value="">Not applicable</option>
            {DEDUCTEE_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
      )}
      {natureKinds.length > 0 && <TdsNaturePicker value={tdsNatureId} onChange={setTdsNatureId} kinds={natureKinds} />}
      {isTax && (
        <label>
          GST tax type
          <select value={taxType} onChange={(e) => setTaxType(e.target.value as TaxType | '')} aria-label="GST tax type">
            <option value="">Not GST</option>
            {TAX_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
      )}
      {isTaxable && (
        <>
          <GstDetails
            classificationId={classificationId}
            setClassificationId={setClassificationId}
            taxability={taxability}
            setTaxability={setTaxability}
            hsn={hsn}
            setHsn={setHsn}
            gstRate={gstRate}
            setGstRate={setGstRate}
            cessRate={cessRate}
            setCessRate={setCessRate}
            ratePlaceholder="for services"
          />
          {nature === 'Expenses' && (
            <label>
              Reverse charge (you pay the GST)
              <select
                value={reverseCharge ? 'Yes' : 'No'}
                onChange={(e) => setReverseCharge(e.target.value === 'Yes')}
                onKeyDown={(e) => {
                  if (e.key === 'y' || e.key === 'Y') setReverseCharge(true)
                  if (e.key === 'n' || e.key === 'N') setReverseCharge(false)
                }}
                aria-label="Reverse charge"
              >
                <option>No</option>
                <option>Yes</option>
              </select>
            </label>
          )}
        </>
      )}
      {billwise && openingPaise !== 0 && (
        <OpeningBillsEditor rows={openingBills} onChange={setOpeningBills} fyStart={company.fyStart} defaultSide={side} defaultDate={company.booksBegin} />
      )}
      <Errors errors={errors} />
      <div className="actions">
        <button type="submit" className="primary">
          <b>Enter</b> {id ? 'Save' : 'Create'}
        </button>
      </div>
    </form>
  )
}

interface OpeningBillRow {
  name: string
  billDate: string
  amount: string
  side: 'Dr' | 'Cr'
}

/** The bills that make up an opening balance; whatever they don't cover stays on account. */
function OpeningBillsEditor({
  rows,
  onChange,
  fyStart,
  defaultSide,
  defaultDate,
}: {
  rows: OpeningBillRow[]
  onChange: (rows: OpeningBillRow[]) => void
  fyStart: string
  defaultSide: 'Dr' | 'Cr'
  defaultDate: string
}) {
  const set = (i: number, patch: Partial<OpeningBillRow>) => onChange(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)))
  const shown = rows.length ? rows : []
  return (
    <fieldset className="opening-bills">
      <legend>Opening bills (bill-wise breakup of the opening balance)</legend>
      {shown.map((r, i) => (
        <div className="inline" key={i}>
          <input value={r.name} placeholder="Bill name" aria-label={`Opening bill ${i + 1} name`} onChange={(e) => set(i, { name: e.target.value })} />
          <DateInput value={r.billDate} onChange={(d) => set(i, { billDate: d })} fyStart={fyStart} label={`Opening bill ${i + 1} date`} />
          <input className="amount" inputMode="decimal" value={r.amount} aria-label={`Opening bill ${i + 1} amount`} onChange={(e) => set(i, { amount: e.target.value })} />
          <select value={r.side} aria-label={`Opening bill ${i + 1} side`} onChange={(e) => set(i, { side: e.target.value as 'Dr' | 'Cr' })}>
            <option>Dr</option>
            <option>Cr</option>
          </select>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rows, { name: '', billDate: defaultDate, amount: '', side: defaultSide }])}>
        Add bill
      </button>
    </fieldset>
  )
}

export function GroupForm({ id }: { id?: number }) {
  const { company, changed, pop } = useApp()
  const [version, setVersion] = useState(0)
  const { data: groups } = useLoad(() => api.groups(company.id), [company.id, version])
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState<number | null>(null)
  const [confirm, ask] = useConfirm()

  useEffect(() => {
    const g = id && groups?.find((x) => x.id === id)
    if (g) {
      setName(g.name)
      setParentId(g.parentId)
    }
    // load the group once its list arrives
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, groups === null])

  const { errors, setErrors, ok, submit } = useSubmit(async () => {
    if (parentId === null) throw new ApiError('', ['Choose the parent group'])
    if (id) {
      await api.alterGroup(company.id, id, { name, parentId })
      changed()
      pop()
      return ''
    }
    await api.createGroup(company.id, { name, parentId })
    changed()
    setVersion((v) => v + 1)
    setName('')
    return `Group "${name}" created`
  })

  useDeleteKey(!!id, ask, `Delete group "${name}"?`, () =>
    api
      .deleteGroup(company.id, id!)
      .then(() => {
        changed()
        pop()
      })
      .catch((e) => setErrors(messages(e))),
  )

  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || (id && <span className="muted">Alt+D delete</span>)}>
        {id ? 'Group Alteration' : 'Group Creation'}
      </Title>
      {confirm}
      <label>
        Name
        <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
        <DevanagariButton value={name} onChange={setName} />
      </label>
      <label>
        Under
        <Picker
          options={(groups ?? []).filter((g) => g.id !== id).map((g) => ({ id: g.id, name: g.name, hint: g.nature }))}
          value={parentId}
          onChange={setParentId}
          placeholder="Group"
        />
      </label>
      <p className="muted">A group takes its nature (asset, liability, income or expense) from the group it sits under.</p>
      <Errors errors={errors} />
      <div className="actions">
        <button type="submit" className="primary">
          <b>Enter</b> {id ? 'Save' : 'Create'}
        </button>
      </div>
    </form>
  )
}

/** "List of Ledgers" / "List of Groups" for alteration; picking one opens its form in place. */
export function MasterPick({ kind }: { kind: 'ledger' | 'group' }) {
  const { company, period, replace } = useApp()
  const { data } = useLoad<{ id: number; name: string; hint?: string }[]>(
    () =>
      kind === 'ledger'
        ? api.ledgers(company.id, period).then((ls) => ls.map((l) => ({ id: l.id, name: l.name, hint: l.group ?? 'Primary' })))
        : // predefined groups can't be altered, so only list the company's own
          api.groups(company.id).then((gs) => gs.filter((g) => !DEFAULT_GROUP_NAMES.has(g.name)).map((g) => ({ id: g.id, name: g.name, hint: g.nature }))),
    [company.id, kind],
  )
  return (
    <div className="form narrow">
      <Title>{kind === 'ledger' ? 'Alter Ledger' : 'Alter Group'}</Title>
      {data && data.length === 0 && <p className="muted">No groups of your own yet; predefined groups can't be altered.</p>}
      <label>
        Name of {kind}
        <Picker options={data ?? []} value={null} onChange={(id) => replace({ k: kind, id })} autoFocus />
      </label>
    </div>
  )
}

const DEFAULT_GROUP_NAMES = new Set(DEFAULT_GROUPS.map((g) => g.name))

/** Closing stock valuation for Stock-in-Hand ledgers (accounts-only mode). */
export function StockValue() {
  const { company, period, changed } = useApp()
  const { data: ledgers } = useLoad(() => api.ledgers(company.id, period), [company.id, period])
  const [ledgerId, setLedgerId] = useState<number | null>(null)
  const [asOf, setAsOf] = useState(period.to)
  const [value, setValue] = useState('')
  const stock = (ledgers ?? []).filter((l) => l.group === 'Stock-in-Hand')

  const { errors, ok, submit } = useSubmit(async () => {
    if (ledgerId === null) throw new ApiError('', ['Choose a stock ledger'])
    await api.setStockValue(company.id, { ledgerId, asOf, value: toPaise(value) })
    changed()
    return 'Closing stock saved'
  })

  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={ok && <span className="ok">{ok}</span>}>Closing Stock</Title>
      {ledgers && stock.length === 0 && <p className="muted">Create a ledger under Stock-in-Hand first.</p>}
      <label>
        Stock ledger
        <Picker options={stock.map((l) => ({ id: l.id, name: l.name }))} value={ledgerId} onChange={setLedgerId} autoFocus />
      </label>
      <label>
        Value as on
        <DateInput value={asOf} onChange={setAsOf} fyStart={company.fyStart} label="Value as on" />
      </label>
      <label>
        Closing value
        <input className="amount" inputMode="decimal" required value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <Errors errors={errors} />
      <div className="actions">
        <button type="submit" className="primary">
          <b>Enter</b> Save
        </button>
      </div>
    </form>
  )
}
