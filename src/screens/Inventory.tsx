import { Fragment, useEffect, useState } from 'react'
import { useApp } from '../App'
import { api, ApiError, type InventoryMaster, type StockLine } from '../api'
import { formatINR, toPaise } from '../../server/src/engine/money'
import { formatCompound, formatQty, parseCompound, toMilli, valueOf } from '../../server/src/engine/inventory'
import { amt, Errors, fmtDate, Picker, Title, enterAdvances, useActive, useConfirm, useLoad } from '../ui'
import { messages, parseRate, rateText, useDeleteKey, useSubmit } from './Masters'
import { qtyField } from './Invoice'
import { periodNote } from './Books'
import { UQC_CODES, uqcOf } from '../../server/src/engine/gst-returns'
import type { Taxability } from '../../server/src/engine/gst'
import { DevanagariButton } from './Transliterate'
import { GstDetails } from './Classifications'

const plain = (p: number) => (p ? formatINR(p).replace(/,/g, '') : '')
const plainQty = (q: number, decimals: number) => (q ? formatQty(q, decimals).replace(/,/g, '') : '')
/** A quantity with its unit; in a compound unit as "2 Box 5 Nos". */
export const qty = (q: number | undefined, unit?: string, decimals = 0, compound?: { perUnit?: string | null; conversion?: number | null }) =>
  !q ? '' : compound?.perUnit && compound?.conversion ? formatCompound(q, { perUnit: compound.perUnit, conversion: compound.conversion, unit: unit ?? '' }, decimals) : `${formatQty(q, decimals)} ${unit ?? ''}`

/** What each inventory master is called on screen. */
export const MASTER_NAMES: Record<InventoryMaster, string> = {
  units: 'Unit',
  'stock-groups': 'Stock Group',
  godowns: 'Godown',
  'stock-items': 'Stock Item',
  'stock-categories': 'Stock Category',
}

/** After a create: clear the form for the next one, as Tally does, or hand the new id back. */
export function useAfterSave(onCreated?: (id: number) => void) {
  const { changed, pop } = useApp()
  return (id: number | undefined, created: number, label: string, clear: () => void) => {
    changed()
    if (id) {
      pop()
      return ''
    }
    if (onCreated) {
      onCreated(created)
      pop()
      return ''
    }
    clear()
    ;(document.querySelector('.screen:not([hidden]) .form input') as HTMLInputElement | null)?.focus()
    return `${label} created`
  }
}

function useMasterDelete(kind: InventoryMaster, id: number | undefined, label: string, setErrors: (e: string[]) => void) {
  const { company, changed, pop } = useApp()
  const [confirm, ask] = useConfirm()
  useDeleteKey(!!id, ask, `Delete ${MASTER_NAMES[kind].toLowerCase()} "${label}"?`, () =>
    api
      .deleteMaster(company.id, kind, id!)
      .then(() => {
        changed()
        pop()
      })
      .catch((e) => setErrors(messages(e))),
  )
  return confirm
}

/** Unit of measure: symbol, formal name and how many decimal places quantities may have. */
export function UnitForm({ id, initialSymbol = '', onCreated }: { id?: number; initialSymbol?: string; onCreated?: (id: number) => void }) {
  const { company } = useApp()
  const [symbol, setSymbol] = useState(initialSymbol)
  const [name, setName] = useState('')
  const [decimals, setDecimals] = useState('0')
  // a compound unit: first unit, conversion, second unit ("Box of 12 Nos")
  const [compound, setCompound] = useState(false)
  const [firstId, setFirstId] = useState<number | null>(null)
  const [conversion, setConversion] = useState('')
  const [secondId, setSecondId] = useState<number | null>(null)
  const [uqc, setUqc] = useState('')
  const { data: units } = useLoad(() => api.units(company.id), [company.id])
  const simple = (units ?? []).filter((u) => !u.secondUnitId && u.id !== id).map((u) => ({ id: u.id, name: u.symbol, hint: u.name }))
  const after = useAfterSave(onCreated)
  useEffect(() => {
    if (!id) return
    api.units(company.id).then((us) => {
      const u = us.find((x) => x.id === id)
      if (!u) return
      setSymbol(u.symbol)
      setName(u.name)
      setDecimals(String(u.decimals))
      setCompound(!!u.secondUnitId)
      setFirstId(u.firstUnitId)
      setConversion(u.conversion ? String(u.conversion) : '')
      setSecondId(u.secondUnitId)
      setUqc(u.uqc ?? '')
    })
  }, [company.id, id])

  const { errors, setErrors, ok, submit } = useSubmit(async () => {
    if (compound) {
      if (!/^\d+$/.test(conversion.trim())) throw new ApiError('', ['Conversion: how many second units make one first unit'])
      const r = await api.saveMaster(company.id, 'units', id, { symbol: '', firstUnitId: firstId, conversion: Number(conversion), secondUnitId: secondId })
      return after(id, r.id, 'Compound unit', () => {
        setFirstId(null)
        setConversion('')
        setSecondId(null)
      })
    }
    if (!/^[0-3]$/.test(decimals.trim())) throw new ApiError('', ['Decimal places: 0 to 3'])
    const r = await api.saveMaster(company.id, 'units', id, { symbol, name, decimals: Number(decimals), uqc: uqc.trim() || null })
    return after(id, r.id, `Unit "${symbol}"`, () => {
      setSymbol('')
      setName('')
      setDecimals('0')
    })
  })
  const confirm = useMasterDelete('units', id, symbol, setErrors)

  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || (id && <span className="muted">Alt+D delete</span>)}>{id ? 'Unit Alteration' : 'Unit Creation'}</Title>
      {confirm}
      <label>
        Type
        <select
          value={compound ? 'Compound' : 'Simple'}
          disabled={!!id}
          onChange={(e) => setCompound(e.target.value === 'Compound')}
          onKeyDown={(e) => {
            if (e.key === 's' || e.key === 'S') setCompound(false)
            if (e.key === 'c' || e.key === 'C') setCompound(true)
          }}
          autoFocus={!id && !initialSymbol}
          aria-label="Type"
        >
          <option>Simple</option>
          <option>Compound</option>
        </select>
      </label>
      {compound ? (
        <>
          <label>
            First unit
            <Picker options={simple} value={firstId} onChange={setFirstId} placeholder="Box" />
          </label>
          <label>
            Conversion
            <input className="amount" inputMode="numeric" value={conversion} onChange={(e) => setConversion(e.target.value)} placeholder="12" aria-label="Conversion" />
          </label>
          <label>
            Second unit
            <Picker options={simple} value={secondId} onChange={setSecondId} placeholder="Nos" />
          </label>
          {firstId && secondId && conversion && (
            <p className="muted">
              {simple.find((u) => u.id === firstId)?.name} of {conversion} {simple.find((u) => u.id === secondId)?.name}: quantities are kept in{' '}
              {simple.find((u) => u.id === secondId)?.name} and entered as 2-5 (2 {simple.find((u) => u.id === firstId)?.name}, 5{' '}
              {simple.find((u) => u.id === secondId)?.name})
            </p>
          )}
        </>
      ) : (
        <>
          <label>
            Symbol
            <input autoFocus={!!initialSymbol || !!id} required value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="Nos, Kg, Ltr" />
          </label>
          <label>
            Formal name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Numbers, Kilograms" />
          </label>
          <label>
            GST unit (UQC)
            <input value={uqc} onChange={(e) => setUqc(e.target.value.toUpperCase())} list="uqc-codes" placeholder={uqcOf(symbol)} aria-label="UQC" />
            <datalist id="uqc-codes">
              {UQC_CODES.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <span className="muted">blank: {uqcOf(symbol)}</span>
          </label>
          <label>
            Number of decimal places
            <input className="amount" inputMode="numeric" value={decimals} onChange={(e) => setDecimals(e.target.value)} aria-label="Number of decimal places" />
          </label>
        </>
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

/** Stock Group or Godown: both are a name placed under another of their kind (or Primary). */
export function TreeForm({ kind, id }: { kind: 'stock-groups' | 'godowns' | 'stock-categories'; id?: number }) {
  const { company, version } = useApp()
  const { data: nodes } = useLoad(
    () => (kind === 'godowns' ? api.godowns(company.id) : kind === 'stock-categories' ? api.stockCategories(company.id) : api.stockGroups(company.id)),
    [company.id, kind, version],
  )
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState<number | null>(0) // 0 = Primary
  const [thirdParty, setThirdParty] = useState<'' | 'ours' | 'theirs'>('') // godowns: whose stock it holds
  const after = useAfterSave()
  const label = MASTER_NAMES[kind]
  useEffect(() => {
    const n = id && nodes?.find((x) => x.id === id)
    if (n) {
      setName(n.name)
      setParentId(n.parentId ?? 0)
      setThirdParty(('thirdParty' in n ? (n.thirdParty as '' | 'ours' | 'theirs' | null) : null) ?? '')
    }
    // load the master once its list arrives
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, nodes === null])

  const { errors, setErrors, ok, submit } = useSubmit(async () => {
    const r = await api.saveMaster(company.id, kind, id, { name, parentId: parentId || null, ...(kind === 'godowns' ? { thirdParty: thirdParty || null } : {}) })
    return after(id, r.id, `${label} "${name}"`, () => setName(''))
  })
  const confirm = useMasterDelete(kind, id, name, setErrors)
  const options = [
    { id: 0, name: 'Primary' },
    ...(nodes ?? []).filter((n) => n.id !== id).map((n) => ({ id: n.id, name: n.name, hint: nodes!.find((p) => p.id === n.parentId)?.name ?? 'Primary' })),
  ]

  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || (id && <span className="muted">Alt+D delete</span>)}>
        {label} {id ? 'Alteration' : 'Creation'}
      </Title>
      {confirm}
      <label>
        Name
        <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
        <DevanagariButton value={name} onChange={setName} />
      </label>
      <label>
        Under
        <Picker options={options} value={parentId} onChange={setParentId} placeholder={label} />
      </label>
      {kind === 'godowns' && (
        <label>
          Whose stock it holds
          <select value={thirdParty} onChange={(e) => setThirdParty(e.target.value as typeof thirdParty)} aria-label="Whose stock it holds">
            <option value="">Our own stock</option>
            <option value="ours">Our stock with a third party (job worker)</option>
            <option value="theirs">A third party's stock with us (job work in)</option>
          </select>
        </label>
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

/**
 * Stock Item: its group, unit and opening stock (quantity, rate, value). Opened from an invoice
 * with Alt+C, it hands the new item back and closes.
 */
export function StockItemForm({ id, initialName = '', onCreated }: { id?: number; initialName?: string; onCreated?: (id: number) => void }) {
  const { company, push, version, features } = useApp()
  const active = useActive()
  const { data: groups } = useLoad(() => api.stockGroups(company.id), [company.id, version])
  const { data: units } = useLoad(() => api.units(company.id), [company.id, version])
  const { data: godowns } = useLoad(() => api.godowns(company.id), [company.id, version])
  const { data: categories } = useLoad(() => api.stockCategories(company.id), [company.id, version])
  const [categoryId, setCategoryId] = useState<number | null>(0) // 0 = Not Applicable
  const [name, setName] = useState(initialName)
  const [groupId, setGroupId] = useState<number | null>(0)
  const [unitId, setUnitId] = useState<number | null>(null)
  const [openingQty, setOpeningQty] = useState('')
  const [rate, setRate] = useState('')
  const [value, setValue] = useState('')
  const [valueTyped, setValueTyped] = useState(false)
  const [godownId, setGodownId] = useState<number | null>(null)
  const [hsn, setHsn] = useState('')
  const [gstRate, setGstRate] = useState('')
  const [cessRate, setCessRate] = useState('')
  const [classificationId, setClassificationId] = useState<number | null>(null)
  const [taxability, setTaxability] = useState<Taxability>('Taxable')
  const [reorderLevel, setReorderLevel] = useState('')
  const [minOrderQty, setMinOrderQty] = useState('')
  const [batches, setBatches] = useState(false)
  const after = useAfterSave(onCreated)
  const unit = units?.find((u) => u.id === unitId)
  // a compound unit's opening stock is typed as 2-5 (2 Box 5 Nos)
  const toQty = (text: string) => (unit?.conversion ? parseCompound(text, { conversion: unit.conversion }) : toMilli(text))

  useEffect(() => {
    if (!id) return
    api.stockItems(company.id).then((items) => {
      const s = items.find((x) => x.id === id)
      if (!s) return
      setName(s.name)
      setGroupId(s.groupId ?? 0)
      setUnitId(s.unitId)
      setOpeningQty(s.conversion ? qtyField(s.openingQty, s) : plainQty(s.openingQty, s.decimals))
      setValue(plain(s.openingValue))
      setValueTyped(true)
      setRate(s.openingQty ? plain(Math.round((s.openingValue * 1000) / s.openingQty)) : '')
      setGodownId(s.openingGodownId)
      setHsn(s.hsn ?? '')
      setGstRate(rateText(s.gstRate))
      setCessRate(s.cessRate ? rateText(s.cessRate) : '')
      setClassificationId(s.gstClassificationId ?? null)
      setTaxability(s.taxability ?? 'Taxable')
      setCategoryId(s.categoryId ?? 0)
      const shown = (q: number | null) => (q === null ? '' : s.conversion ? qtyField(q, s) : plainQty(q, s.decimals))
      setReorderLevel(shown(s.reorderLevel))
      setMinOrderQty(shown(s.minOrderQty))
      setBatches(!!s.batches)
    })
  }, [company.id, id])

  // Alt+C on the Units field creates a unit, as in Tally
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.altKey && (e.key === 'c' || e.key === 'C'))) return
      const el = document.activeElement as HTMLInputElement | null
      if (!el?.closest('[data-field="unit"]')) return
      e.preventDefault()
      // what was typed becomes the new unit's symbol
      push({ k: 'unit', symbol: el.value, onCreated: setUnitId })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // quantity × rate fills the value until the value is typed over
  const computed = (() => {
    try {
      return openingQty.trim() && rate.trim() ? valueOf(toQty(openingQty), toPaise(rate)) : null
    } catch {
      return null
    }
  })()
  const shownValue = valueTyped ? value : computed !== null ? plain(computed) : value

  const { errors, setErrors, ok, submit } = useSubmit(async () => {
    if (unitId === null) throw new ApiError('', ['Choose the unit (Alt+C creates one)'])
    const body = {
      name,
      groupId: groupId || null,
      unitId,
      openingQty: openingQty.trim() ? toQty(openingQty) : 0,
      openingValue: shownValue.trim() ? toPaise(shownValue) : 0,
      openingGodownId: godownId,
      hsn: hsn.trim() || null,
      gstRate: taxability === 'Taxable' ? parseRate(gstRate) : null,
      cessRate: taxability === 'Taxable' && cessRate.trim() ? parseRate(cessRate) : null,
      gstClassificationId: classificationId,
      taxability,
      categoryId: categoryId || null,
      reorderLevel: reorderLevel.trim() ? toQty(reorderLevel) : null,
      minOrderQty: minOrderQty.trim() ? toQty(minOrderQty) : null,
      batches,
    }
    const r = await api.saveMaster(company.id, 'stock-items', id, body)
    return after(id, r.id, `Stock item "${name}"`, () => {
      setName('')
      setOpeningQty('')
      setRate('')
      setValue('')
      setValueTyped(false)
    })
  })
  const confirm = useMasterDelete('stock-items', id, name, setErrors)

  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || <span className="muted">{id ? 'Alt+D delete' : 'Alt+C on Units: new unit'}</span>}>
        {id ? 'Stock Item Alteration' : 'Stock Item Creation'}
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
          options={[{ id: 0, name: 'Primary' }, ...(groups ?? []).map((g) => ({ id: g.id, name: g.name, hint: groups!.find((p) => p.id === g.parentId)?.name ?? 'Primary' }))]}
          value={groupId}
          onChange={setGroupId}
          placeholder="Stock group"
        />
      </label>
      {features.stockCategories !== false && (categories?.length ?? 0) > 0 && (
        <label>
          Category
          <Picker options={[{ id: 0, name: 'Not Applicable' }, ...(categories ?? []).map((c) => ({ id: c.id, name: c.name }))]} value={categoryId} onChange={setCategoryId} placeholder="Category" />
        </label>
      )}
      <label data-field="unit">
        Units
        <Picker options={(units ?? []).map((u) => ({ id: u.id, name: u.symbol, hint: u.name }))} value={unitId} onChange={setUnitId} placeholder="Unit" />
      </label>
      {features.gst !== false && (
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
        />
      )}
      <label>
        Maintain in batches
        <select value={batches ? 'Yes' : 'No'} onChange={(e) => setBatches(e.target.value === 'Yes')} aria-label="Maintain in batches">
          <option>No</option>
          <option>Yes</option>
        </select>
        {batches && <span className="muted">each line names its batch; goods coming in carry the dates of manufacture and expiry. The opening stock is batch "Opening Stock".</span>}
      </label>
      <div className="inline">
        <label>
          Reorder level
          <input className="amount" inputMode="decimal" value={reorderLevel} onChange={(e) => setReorderLevel(e.target.value)} aria-label="Reorder level" />
          <span className="muted">{unit?.symbol}</span>
        </label>
        <label>
          Minimum order
          <input className="amount" inputMode="decimal" value={minOrderQty} onChange={(e) => setMinOrderQty(e.target.value)} aria-label="Minimum order quantity" />
          <span className="muted">{unit?.symbol}</span>
        </label>
      </div>
      <fieldset className="opening-bills">
        <legend>Opening balance</legend>
        <div className="inline">
          <label>
            Quantity
            <input className="amount" inputMode="decimal" value={openingQty} onChange={(e) => setOpeningQty(e.target.value)} aria-label="Opening quantity" />
            <span className="muted">{unit?.symbol}</span>
          </label>
          <label>
            Rate
            <input className="amount" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} aria-label="Opening rate" />
          </label>
          <label>
            Value
            <input
              className="amount"
              inputMode="decimal"
              value={shownValue}
              onChange={(e) => {
                setValue(e.target.value)
                setValueTyped(true)
              }}
              aria-label="Opening value"
            />
          </label>
        </div>
        {godowns && godowns.length > 1 && (
          <label>
            Godown
            <Picker options={godowns.map((g) => ({ id: g.id, name: g.name }))} value={godownId ?? godowns.find((g) => g.isDefault)?.id ?? null} onChange={setGodownId} />
          </label>
        )}
      </fieldset>
      <Errors errors={errors} />
      <div className="actions">
        <button type="submit" className="primary">
          <b>Enter</b> {id ? 'Save' : 'Create'}
        </button>
      </div>
    </form>
  )
}

/** List of an inventory master for alteration (or a stock item to see its vouchers); picking opens it in place. */
export function InventoryPick({ kind, next = 'alter' }: { kind: InventoryMaster; next?: 'alter' | 'vouchers' | 'query' }) {
  const { company, replace } = useApp()
  const { data } = useLoad<{ id: number; name: string; hint?: string }[]>(async () => {
    if (kind === 'units') return (await api.units(company.id)).map((u) => ({ id: u.id, name: u.symbol, hint: u.name }))
    if (kind === 'stock-items') return (await api.stockItems(company.id)).map((s) => ({ id: s.id, name: s.name, hint: s.group ?? 'Primary' }))
    const nodes = kind === 'godowns' ? await api.godowns(company.id) : kind === 'stock-categories' ? await api.stockCategories(company.id) : await api.stockGroups(company.id)
    return nodes.map((n) => ({ id: n.id, name: n.name, hint: nodes.find((p) => p.id === n.parentId)?.name ?? 'Primary' }))
  }, [company.id, kind])
  const open = (id: number) => {
    if (next === 'vouchers') return replace({ k: 'stock-item-vouchers', itemId: id })
    if (next === 'query') return replace({ k: 'stock-query', itemId: id })
    replace(
      kind === 'units' ? { k: 'unit', id } : kind === 'stock-items' ? { k: 'stock-item', id } : { k: 'tree-master', kind, id },
    )
  }
  return (
    <div className="form narrow">
      <Title>{next === 'vouchers' ? 'Stock Item Vouchers' : next === 'query' ? 'Stock Query' : `Alter ${MASTER_NAMES[kind]}`}</Title>
      {data && data.length === 0 && <p className="muted">None created yet.</p>}
      <label>
        Name of {MASTER_NAMES[kind].toLowerCase()}
        <Picker options={data ?? []} value={null} onChange={open} autoFocus />
      </label>
    </div>
  )
}

/**
 * Stock Summary: closing quantity, rate and value of every item at average cost, by stock group.
 * Alt+F1 shows the detailed view (opening, inwards, outwards). Enter on a group opens it; on an
 * item, its vouchers.
 */
export function StockSummaryView({ groupId }: { groupId?: number }) {
  const { company, period, version, push } = useApp()
  const active = useActive()
  const [detailed, setDetailed] = useState(false)
  const { data, error } = useLoad(() => api.stockSummary(company.id, period, groupId), [company.id, period, version, groupId])
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 'F1') {
        e.preventDefault()
        setDetailed((d) => !d)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>

  const q = (l: StockLine, k: 'openingQty' | 'inQty' | 'outQty' | 'closingQty') => (l.kind === 'item' ? qty(l[k], l.unit, l.decimals, l) : '')
  return (
    <div>
      <Title right={<>{periodNote(data)} <span className="muted">· Alt+F1 {detailed ? 'condensed' : 'detailed'}</span></>}>
        Stock Summary{data.group ? `: ${data.group.name}` : ''}
      </Title>
      <table className="report">
        <thead>
          {detailed ? (
            <tr>
              <th>Particulars</th>
              <th className="num">Opening Qty</th>
              <th className="num">Opening Value</th>
              <th className="num">Inwards Qty</th>
              <th className="num">Inwards Value</th>
              <th className="num">Outwards Qty</th>
              <th className="num">Outwards Value</th>
              <th className="num">Closing Qty</th>
              <th className="num">Closing Value</th>
            </tr>
          ) : (
            <tr>
              <th>Particulars</th>
              <th className="num">Quantity</th>
              <th className="num">Rate</th>
              <th className="num">Value</th>
            </tr>
          )}
        </thead>
        <tbody>
          {data.lines.map((l) => (
            <Fragment key={`${l.kind}${l.id}`}>
              <tr
                className={`clickable ${l.kind === 'group' ? 'group-row' : ''}`}
                onClick={() => push(l.kind === 'group' ? { k: 'stock-summary', groupId: l.id } : { k: 'stock-item-vouchers', itemId: l.id })}
              >
                <td>{l.name}</td>
                {detailed ? (
                  <>
                    <td className="num">{q(l, 'openingQty')}</td>
                    <td className="num">{amt(l.openingValue)}</td>
                    <td className="num">{q(l, 'inQty')}</td>
                    <td className="num">{amt(l.inValue)}</td>
                    <td className="num">{q(l, 'outQty')}</td>
                    <td className="num">{amt(l.outValue)}</td>
                    <td className={`num ${(l.closingQty ?? 0) < 0 ? 'neg' : ''}`}>{q(l, 'closingQty')}</td>
                    <td className="num">{amt(l.closingValue)}</td>
                  </>
                ) : (
                  <>
                    <td className={`num ${(l.closingQty ?? 0) < 0 ? 'neg' : ''}`}>{q(l, 'closingQty')}</td>
                    <td className="num">{l.kind === 'item' && l.closingQty ? amt(l.rate ?? 0) : ''}</td>
                    <td className="num">{amt(l.closingValue)}</td>
                  </>
                )}
              </tr>
              {detailed &&
                l.godowns &&
                l.godowns.length > 1 &&
                l.godowns.map((g) => (
                  <tr key={`${l.id}-${g.godown}`} className="detail muted">
                    <td className="indent">{g.godown}</td>
                    <td colSpan={6} />
                    <td className="num">{qty(g.qty, l.unit, l.decimals, l)}</td>
                    <td />
                  </tr>
                ))}
            </Fragment>
          ))}
          {data.lines.length === 0 && (
            <tr>
              <td colSpan={detailed ? 9 : 4} className="muted">
                No stock items{data.group ? ' in this group' : ''}. Create them under Create → Stock Item.
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td>Grand Total</td>
            {detailed ? (
              <>
                <td />
                <td className="num total">{amt(data.total.openingValue)}</td>
                <td />
                <td className="num total">{amt(data.total.inValue)}</td>
                <td />
                <td className="num total">{amt(data.total.outValue)}</td>
                <td />
                <td className="num total">{amt(data.total.closingValue)}</td>
              </>
            ) : (
              <>
                <td />
                <td />
                <td className="num total">{amt(data.total.closingValue)}</td>
              </>
            )}
          </tr>
        </tfoot>
      </table>
      {data.negative.length > 0 && <p className="errors">Negative stock: {data.negative.join(', ')}</p>}
    </div>
  )
}

/** Stock Item Vouchers: every movement of one item with a running quantity; Enter opens the voucher. */
export function StockItemVouchersView({ itemId }: { itemId: number }) {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.stockItemVouchers(company.id, itemId, period), [company.id, itemId, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const { unit, decimals } = data.item
  const p = data.position
  const q = (n: number) => qty(n, unit, decimals, data.item)
  return (
    <div>
      <Title right={periodNote(data)}>Stock Item Vouchers: {data.item.name}</Title>
      <table className="report">
        <thead>
          <tr>
            <th>Date</th>
            <th>Particulars</th>
            <th>Vch Type</th>
            <th className="num">Vch No.</th>
            <th>Godown</th>
            <th className="num">Inwards</th>
            <th className="num">Outwards</th>
            <th className="num">Value</th>
            <th className="num">Closing Qty</th>
          </tr>
        </thead>
        <tbody>
          <tr className="muted">
            <td />
            <td>Opening Balance</td>
            <td colSpan={6} />
            <td className="num">{q(p.openingQty)}</td>
          </tr>
          {data.lines.map((l, i) => (
            <tr key={i} className="clickable" onClick={() => push({ k: 'voucher', type: l.type, id: l.voucherId })}>
              <td>{fmtDate(l.date)}</td>
              <td>{l.party}</td>
              <td>{l.type}</td>
              <td className="num">{l.docNo ?? l.number}</td>
              <td>{l.godown}</td>
              <td className="num">{l.qty > 0 ? q(l.qty) : ''}</td>
              <td className="num">{l.qty < 0 ? q(-l.qty) : ''}</td>
              <td className="num">{amt(Math.abs(l.amount))}</td>
              <td className={`num ${l.balance < 0 ? 'neg' : ''}`}>{q(l.balance)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td />
            <td>Totals</td>
            <td colSpan={3} />
            <td className="num total">{q(p.inQty)}</td>
            <td className="num total">{q(p.outQty)}</td>
            <td />
            <td className="num total">{q(p.closingQty)}</td>
          </tr>
          <tr>
            <td />
            <td className="muted" colSpan={7}>
              Closing value at average cost {p.closingQty ? `(${formatINR(p.rate)} per ${unit})` : ''}
            </td>
            <td className="num total">{amt(p.closingValue)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
