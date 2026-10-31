import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useApp } from '../App'
import { api, ApiError, type VoucherTypeDef } from '../api'
import { VOUCHER_TYPES, type VoucherType } from '../../server/src/engine/voucher'
import { formatDocNo, fyStartOf } from '../../server/src/engine/numbering'
import { amt, Errors, fmtDate, Picker, Title, enterAdvances, useLoad } from '../ui'
import { useSubmit } from './Masters'
import { qty } from './Inventory'
import { periodNote } from './Books'

/** The voucher type a voucher screen was opened with, and the number typed for one numbered by hand. */
interface VoucherTypeState {
  def: VoucherTypeDef | null
  docNo: string
  setDocNo: (s: string) => void
}
const VoucherTypeCtx = createContext<VoucherTypeState>({ def: null, docNo: '', setDocNo: () => {} })

/** What a voucher screen adds to what it saves: the voucher type, and a hand-typed number. */
export function useVoucherTypeFields() {
  const { def, docNo, setDocNo } = useContext(VoucherTypeCtx)
  return {
    fields: def ? { voucherTypeId: def.id, ...(def.numbering === 'manual' ? { docNo } : {}) } : {},
    clear: () => setDocNo(''),
  }
}

/**
 * Wraps a voucher screen: names the voucher type above it and, for one numbered by hand, asks for
 * the number. Altering a voucher keeps its type; a hand number can be corrected.
 */
export function VoucherTypeProvider({ voucherTypeId, voucherId, children }: { voucherTypeId?: number | null; voucherId?: number; children: ReactNode }) {
  const { company, version } = useApp()
  const { data: types } = useLoad(() => api.voucherTypes(company.id), [company.id, version])
  const { data: existing } = useLoad(async () => (voucherId ? api.voucher(company.id, voucherId) : null), [company.id, voucherId])
  const [docNo, setDocNo] = useState('')
  const typeId = existing ? (existing.voucherTypeId ?? null) : (voucherTypeId ?? null)
  const def = types?.find((t) => t.id === typeId) ?? null
  useEffect(() => {
    if (existing?.voucherTypeId) setDocNo(existing.docNo ?? '')
  }, [existing])
  const today = new Date().toISOString().slice(0, 10)
  const last = def?.counters?.[def.restartYearly ? fyStartOf(today, company.fyStart) : '1900-01-01']
  const next = last === undefined ? (def?.startNumber ?? 1) : last + 1
  return (
    <VoucherTypeCtx.Provider value={{ def, docNo, setDocNo }}>
      {def && (
        <div className="vtype-bar">
          <span>
            Voucher type: <b>{def.name}</b>
          </span>
          {def.numbering === 'manual' ? (
            <label>
              Voucher No.
              <input value={docNo} onChange={(e) => setDocNo(e.target.value)} aria-label="Voucher number" />
            </label>
          ) : (
            !voucherId && <span className="muted">numbered on save, as {formatDocNo(def, next, today, company.fyStart)} …</span>
          )}
        </div>
      )}
      {children}
    </VoucherTypeCtx.Provider>
  )
}

const NUMBERING = [
  { id: 1, name: 'Automatic', value: 'auto' as const },
  { id: 2, name: 'Manual', value: 'manual' as const },
]

/** Create / Alter, Voucher Type: a voucher type of the company's own, under a predefined one, with its numbering. */
export function VoucherTypeForm({ id }: { id?: number }) {
  const { company, changed, pop } = useApp()
  const { data: types } = useLoad(() => api.voucherTypes(company.id), [company.id])
  const [f, setF] = useState({ name: '', baseType: 'Sales' as VoucherType, abbreviation: '', numbering: 'auto' as 'auto' | 'manual', prefix: '', suffix: '', width: '0', startNumber: '1',
    restartYearly: false, printTitle: '', active: true, pos: false, gstRegistrationId: null as number | null })
  const { data: registrations } = useLoad(() => api.gstRegistrations(company.id), [company.id])
  useEffect(() => {
    const t = id ? types?.find((x) => x.id === id) : undefined
    if (t) setF({ ...t, abbreviation: t.abbreviation, width: String(t.width), startNumber: String(t.startNumber), printTitle: t.printTitle ?? '', pos: !!t.pos, gstRegistrationId: t.gstRegistrationId ?? null })
  }, [id, types])
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }))
  const { errors, ok, submit } = useSubmit(async () => {
    if (!/^\d+$/.test(f.width) || !/^\d+$/.test(f.startNumber)) throw new ApiError('', ['Width and starting number are whole numbers'])
    const body = { ...f, width: Number(f.width), startNumber: Number(f.startNumber), printTitle: f.printTitle || null, pos: f.baseType === 'Sales' && f.pos }
    if (id) await api.alterVoucherType(company.id, id, body)
    else await api.createVoucherType(company.id, body)
    changed()
    if (id) pop()
    else setF((x) => ({ ...x, name: '', abbreviation: '' }))
    return `Voucher type "${f.name}" saved`
  })
  const used = id ? (types?.find((x) => x.id === id)?.used ?? 0) : 0
  const sample = formatDocNo({ prefix: f.prefix, suffix: f.suffix, width: Number(f.width) || 0 }, Number(f.startNumber) || 1, new Date().toISOString().slice(0, 10), company.fyStart)
  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={ok && <span className="ok">{ok}</span>}>{id ? 'Voucher Type Alteration' : 'Voucher Type Creation'}</Title>
      <label>
        Name
        <input autoFocus required value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Sales - Export" aria-label="Name" />
      </label>
      <label>
        Select type of voucher
        <Picker
          options={VOUCHER_TYPES.map((t, i) => ({ id: i + 1, name: t }))}
          value={VOUCHER_TYPES.indexOf(f.baseType) + 1 || null}
          onChange={(i) => !used && set('baseType', VOUCHER_TYPES[i - 1])}
          placeholder="Sales"
        />
        {used > 0 && <span className="muted">{used} vouchers use it, so it stays</span>}
      </label>
      <label>
        Abbreviation
        <input value={f.abbreviation} onChange={(e) => set('abbreviation', e.target.value)} aria-label="Abbreviation" />
      </label>
      <label>
        Method of voucher numbering
        <Picker options={NUMBERING} value={NUMBERING.find((n) => n.value === f.numbering)!.id} onChange={(i) => set('numbering', NUMBERING[i - 1].value)} placeholder="Automatic" />
      </label>
      {f.numbering === 'auto' && (
        <>
          <div className="inline">
            <label>
              Prefix
              <input value={f.prefix} onChange={(e) => set('prefix', e.target.value)} placeholder="INV/" aria-label="Prefix" />
            </label>
            <label>
              Starting number
              <input className="amount" inputMode="numeric" value={f.startNumber} onChange={(e) => set('startNumber', e.target.value)} aria-label="Starting number" />
            </label>
            <label>
              Width (zero-filled)
              <input className="amount" inputMode="numeric" value={f.width} onChange={(e) => set('width', e.target.value)} aria-label="Width" />
            </label>
            <label>
              Suffix
              <input value={f.suffix} onChange={(e) => set('suffix', e.target.value)} placeholder="/{FY}" aria-label="Suffix" />
            </label>
          </div>
          <label>
            Restart numbering each financial year
            <select value={f.restartYearly ? 'Yes' : 'No'} onChange={(e) => set('restartYearly', e.target.value === 'Yes')} aria-label="Restart each year">
              <option>No</option>
              <option>Yes</option>
            </select>
          </label>
          <p className="muted">
            The first voucher will be <b>{sample}</b>. {'{FY}'} stands for the financial year ({sample.includes('-') ? 'like 26-27' : 'the year'}).
          </p>
        </>
      )}
      {(registrations?.length ?? 0) > 1 && ['Sales', 'Purchase', 'Credit Note', 'Debit Note', 'Receipt', 'Journal'].includes(f.baseType) && (
        <label>
          GST registration
          <select value={f.gstRegistrationId ?? 0} onChange={(e) => set('gstRegistrationId', Number(e.target.value) || null)} aria-label="GST registration">
            {registrations!.map((r) => <option key={r.id} value={r.id}>{r.name}: {r.gstin}</option>)}
          </select>
        </label>
      )}
      {f.baseType === 'Sales' && (
        <label>
          Use for POS invoicing
          <select value={f.pos ? 'Yes' : 'No'} onChange={(e) => set('pos', e.target.value === 'Yes')} aria-label="Use for POS invoicing">
            <option>No</option>
            <option>Yes</option>
          </select>
        </label>
      )}
      <label>
        Print title
        <input value={f.printTitle} onChange={(e) => set('printTitle', e.target.value)} placeholder="Export Invoice" aria-label="Print title" />
      </label>
      <label>
        In use
        <select value={f.active ? 'Yes' : 'No'} onChange={(e) => set('active', e.target.value === 'Yes')} aria-label="In use">
          <option>Yes</option>
          <option>No</option>
        </select>
      </label>
      <Errors errors={errors} />
      <div className="actions">
        <button type="submit" className="primary">
          <b>Ctrl+A</b> Save
        </button>
      </div>
    </form>
  )
}

export function VoucherTypePick() {
  const { company, replace } = useApp()
  const { data } = useLoad(() => api.voucherTypes(company.id), [company.id])
  return (
    <div className="form narrow">
      <Title>Alter Voucher Type</Title>
      {data && !data.length && <p className="muted">No voucher types of your own yet (Create, Voucher Type).</p>}
      <label>
        Name of voucher type
        <Picker options={(data ?? []).map((t) => ({ id: t.id, name: t.name, hint: t.baseType }))} value={null} onChange={(id) => replace({ k: 'voucher-type', id })} autoFocus />
      </label>
    </div>
  )
}

/** F11, Company Features: switch parts of the product off; nothing recorded is lost. */
export function FeaturesForm() {
  const { company, changed } = useApp()
  const { data } = useLoad(() => api.features(company.id), [company.id])
  const [on, setOn] = useState<Record<string, boolean> | null>(null)
  useEffect(() => {
    if (data) setOn(data.features)
  }, [data])
  const { errors, ok, submit } = useSubmit(async () => {
    await api.setFeatures(company.id, on!)
    changed()
    return 'Saved'
  })
  if (!data || !on) return <p className="muted">Loading…</p>
  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={ok && <span className="ok">{ok}</span>}>Company Features (F11)</Title>
      {Object.entries(data.labels).map(([k, label], i) => (
        <label key={k}>
          {label}
          <select autoFocus={i === 0} value={on[k] ? 'Yes' : 'No'} onChange={(e) => setOn({ ...on, [k]: e.target.value === 'Yes' })} aria-label={label}>
            <option>Yes</option>
            <option>No</option>
          </select>
        </label>
      ))}
      <p className="muted">Switching a feature off hides its screens, menus and fields. What was recorded stays, and comes back when it is switched on.</p>
      <Errors errors={errors} />
      <div className="actions">
        <button type="submit" className="primary">
          <b>Ctrl+A</b> Save
        </button>
      </div>
    </form>
  )
}

/** Stock Category Summary: items by category across stock groups; Enter opens a category. */
export function StockCategorySummaryView({ categoryId }: { categoryId?: number }) {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.stockCategorySummary(company.id, period, categoryId), [company.id, period, version, categoryId])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={periodNote(data)}>Stock Category Summary{data.category ? `: ${data.category.name}` : ''}</Title>
      <table className="report">
        <thead>
          <tr>
            <th>Particulars</th>
            <th className="num">Opening Value</th>
            <th className="num">Inwards</th>
            <th className="num">Outwards</th>
            <th className="num">Closing Quantity</th>
            <th className="num">Closing Value</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l) => (
            <tr
              key={`${l.kind}${l.id}`}
              className={`clickable ${l.kind === 'category' ? 'group-row' : ''}`}
              onClick={() => push(l.kind === 'category' ? { k: 'stock-category-summary', categoryId: l.id } : { k: 'stock-query', itemId: l.id })}
            >
              <td>{l.name}</td>
              <td className="num">{amt(l.openingValue)}</td>
              <td className="num">{amt(l.inValue)}</td>
              <td className="num">{amt(l.outValue)}</td>
              <td className="num">{l.kind === 'item' ? qty(l.closingQty, l.unit, l.decimals) : ''}</td>
              <td className="num">{amt(l.closingValue)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Grand Total</td>
            <td className="num total">{amt(data.total.openingValue)}</td>
            <td className="num total">{amt(data.total.inValue)}</td>
            <td className="num total">{amt(data.total.outValue)}</td>
            <td />
            <td className="num total">{amt(data.total.closingValue)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="muted">Items without a category are listed by themselves.</p>
    </div>
  )
}

/** Stock Query: one item at a glance. */
export function StockQueryView({ itemId }: { itemId: number }) {
  const { company, period, version, push } = useApp()
  const { data: d, error } = useLoad(() => api.stockQuery(company.id, period, itemId), [company.id, period, version, itemId])
  if (error) return <Errors errors={[error]} />
  if (!d) return <p className="muted">Loading…</p>
  const it = d.item
  const q = (n: number | string) => qty(Number(n), it.unit, it.decimals, it)
  const moves = (title: string, rows: typeof d.sales) => (
    <>
      <h3 className="sub">{title}</h3>
      <table className="report">
        <tbody>
          {rows.map((r) => (
            <tr key={r.voucherId} className="clickable" onClick={() => push({ k: 'voucher-print', id: r.voucherId })}>
              <td>{fmtDate(r.date)}</td>
              <td>
                {r.type} No. {r.docNo}
              </td>
              <td>{r.party}</td>
              <td className="num">{q(r.qty)}</td>
              <td className="num">{amt(Number(r.rate))}</td>
            </tr>
          ))}
          {!rows.length && (
            <tr className="muted">
              <td colSpan={5}>None</td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  )
  return (
    <div>
      <Title right={periodNote(d)}>Stock Query: {it.name}</Title>
      <div className="query-grid">
        <div>
          <div className="muted">Group · Category</div>
          {d.group ?? 'Primary'} · {d.category ?? 'Not Applicable'}
        </div>
        <div>
          <div className="muted">HSN · GST rate</div>
          {d.hsn ?? '—'} · {d.gstRate === null || d.gstRate === undefined ? '—' : `${d.gstRate / 100}%`}
        </div>
        <div>
          <div className="muted">Closing stock</div>
          <b>{q(it.closingQty) || '0'}</b> worth {amt(it.closingValue) || '0.00'}
        </div>
        <div>
          <div className="muted">Average cost</div>
          {amt(it.rate)}
        </div>
        <div>
          <div className="muted">On purchase order · due to customers</div>
          {q(d.purchaseOrders) || '0'} · {q(d.salesOrders) || '0'}
        </div>
        {d.reorderLevel !== null && d.reorderLevel !== undefined && (
          <div>
            <div className="muted">Reorder level</div>
            {q(d.reorderLevel)}
          </div>
        )}
      </div>
      <h3 className="sub">By godown</h3>
      <table className="report">
        <tbody>
          {d.godowns.map((g) => (
            <tr key={g.godown}>
              <td>{g.godown}</td>
              <td className="num">{q(g.qty)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {moves('Last purchases', d.purchases)}
      {moves('Last sales', d.sales)}
    </div>
  )
}
