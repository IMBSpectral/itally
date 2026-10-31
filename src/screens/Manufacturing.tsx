import { useEffect, useState } from 'react'
import { useApp } from '../App'
import { api, ApiError } from '../api'
import { formatINR } from '../../server/src/engine/money'
import { Errors, fmtDate, Picker, Title, enterAdvances, useLoad } from '../ui'
import { useSubmit } from './Masters'
import { parseQty, qtyField } from './Invoice'

/** Bills of materials, Cost Estimation and the job work reports. */

/** Create / Alter, Bill of Materials: what a quantity of an item is made from. */
export function BomForm({ itemId: initial }: { itemId?: number }) {
  const { company, changed, version } = useApp()
  const { data: items } = useLoad(() => api.stockItems(company.id), [company.id, version])
  const [itemId, setItemId] = useState<number | null>(initial ?? null)
  const [name, setName] = useState('Main')
  const [names, setNames] = useState<string[]>([])
  const [makes, setMakes] = useState('1')
  const [rows, setRows] = useState<{ itemId: number | null; qty: string }[]>([{ itemId: null, qty: '' }])
  // made alongside: by-products with their share of the cost, and scrap
  const [extras, setExtras] = useState<{ itemId: number | null; qty: string; kind: 'by-product' | 'scrap'; share: string }[]>([])
  const byId = new Map((items ?? []).map((i) => [i.id, i]))
  const q3 = (id: number, q: number) => qtyField(q, byId.get(id) ?? { decimals: 3 })
  useEffect(() => {
    if (!itemId || !items) return
    api.bomNames(company.id, itemId).then(setNames)
    api.bom(company.id, itemId, name).then((b) => {
      setMakes(b ? q3(itemId, b.makesQty) : '1')
      setRows([...(b?.components ?? []).map((c) => ({ itemId: c.itemId, qty: q3(c.itemId, c.qty) })), { itemId: null, qty: '' }])
      setExtras([
        ...(b?.byProducts ?? []).map((x) => ({ itemId: x.itemId, qty: q3(x.itemId, x.qty), kind: 'by-product' as const, share: x.costShare == null ? '' : String(x.costShare / 100) })),
        ...(b?.scrap ?? []).map((x) => ({ itemId: x.itemId, qty: q3(x.itemId, x.qty), kind: 'scrap' as const, share: '' })),
      ])
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id, itemId, name, items === null])
  const { errors, ok, submit } = useSubmit(async () => {
    if (!itemId) throw new ApiError('', ['Choose the item it makes'])
    const makesQty = parseQty(makes, byId.get(itemId))
    if (!makesQty) throw new ApiError('', ['Give the quantity the components make'])
    const components = rows.filter((r) => r.itemId).map((r, i) => {
      const q = parseQty(r.qty, byId.get(r.itemId!))
      if (!q) throw new ApiError('', [`Component ${i + 1}: give the quantity`])
      return { itemId: r.itemId!, qty: q }
    })
    const made = extras.filter((x) => x.itemId).map((x, i) => {
      const q = parseQty(x.qty, byId.get(x.itemId!))
      if (!q) throw new ApiError('', [`By-product or scrap ${i + 1}: give the quantity`])
      return { ...x, itemId: x.itemId!, qty: q }
    })
    await api.setBom(company.id, itemId, {
      name, makesQty, components,
      byProducts: made.filter((x) => x.kind === 'by-product').map((x) => ({ itemId: x.itemId, qty: x.qty, costShare: x.share.trim() ? Math.round(Number(x.share) * 100) : null })),
      scrap: made.filter((x) => x.kind === 'scrap').map((x) => ({ itemId: x.itemId, qty: x.qty })),
    })
    changed()
    return components.length ? `Bill of materials "${name}" of ${byId.get(itemId)?.name} saved` : `Bill of materials "${name}" removed`
  })
  const options = (items ?? []).map((i) => ({ id: i.id, name: i.name, hint: i.unit }))
  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={ok && <span className="ok">{ok}</span>}>Bill of Materials</Title>
      <div className="inline">
        <label>
          Stock item made
          <Picker options={options} value={itemId} onChange={setItemId} autoFocus={!initial} />
        </label>
        <label>
          Name of the bill of materials
          <input list="bom-names" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name of the bill of materials" />
          <datalist id="bom-names">{names.map((n) => <option key={n} value={n} />)}</datalist>
        </label>
        <label>
          Quantity it makes ({itemId ? byId.get(itemId)?.unit : 'unit'})
          <input className="amount" inputMode="decimal" value={makes} onChange={(e) => setMakes(e.target.value)} aria-label="Quantity it makes" />
        </label>
      </div>
      <table className="report">
        <thead><tr><th>Component</th><th className="num">Quantity</th><th>Unit</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <Picker options={options.filter((o) => o.id !== itemId)} value={r.itemId}
                  onChange={(v) => setRows((x) => { const n = x.map((y, k) => (k === i ? { ...y, itemId: v } : y)); return i === x.length - 1 ? [...n, { itemId: null, qty: '' }] : n })} />
              </td>
              <td className="num">
                <input className="amount" inputMode="decimal" value={r.qty} aria-label={`Component ${i + 1} quantity`}
                  onChange={(e) => setRows((x) => x.map((y, k) => (k === i ? { ...y, qty: e.target.value } : y)))} />
              </td>
              <td className="muted">{r.itemId ? byId.get(r.itemId)?.unit : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 className="sub">Made alongside it</h3>
      <table className="report">
        <thead><tr><th>By-product or scrap</th><th>Kind</th><th className="num">Quantity</th><th className="num">Share of the cost %</th></tr></thead>
        <tbody>
          {[...extras, { itemId: null, qty: '', kind: 'by-product' as const, share: '' }].map((x, i) => {
            const set = (patch: Partial<typeof x>) => setExtras((xs) => (i === xs.length ? [...xs, { ...x, ...patch }] : xs.map((y, k) => (k === i ? { ...y, ...patch } : y))))
            return (
              <tr key={i}>
                <td><Picker options={options.filter((o) => o.id !== itemId)} value={x.itemId} onChange={(v) => set({ itemId: v })} placeholder="Item" /></td>
                <td>
                  <select value={x.kind} onChange={(e) => set({ kind: e.target.value as 'by-product' | 'scrap' })} aria-label={`Line ${i + 1} kind`}>
                    <option value="by-product">By-product</option>
                    <option value="scrap">Scrap</option>
                  </select>
                </td>
                <td className="num"><input className="amount" inputMode="decimal" value={x.qty} onChange={(e) => set({ qty: e.target.value })} aria-label={`Line ${i + 1} quantity`} /></td>
                <td className="num">
                  {x.kind === 'by-product' && <input className="amount" inputMode="decimal" value={x.share} onChange={(e) => set({ share: e.target.value })} placeholder="by value" aria-label={`Line ${i + 1} share`} />}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="muted">
        An item can have several bills of materials (by name); the Manufacturing Journal asks which. A by-product with a share takes that share of the cost; scrap is valued at
        the rate typed on it in the voucher, and that value comes off the cost. Clear every component to remove this bill of materials.
      </p>
      <Errors errors={errors} />
      <div className="actions"><button type="submit" className="primary"><b>Ctrl+A</b> Save</button></div>
    </form>
  )
}

/** Cost Estimation: what a quantity of an item costs to make from its components at their current cost. */
export function CostEstimationView() {
  const { company, period, version } = useApp()
  const { data: items } = useLoad(() => api.stockItems(company.id), [company.id, version])
  const [itemId, setItemId] = useState<number | null>(null)
  const [qty, setQty] = useState('1')
  const item = itemId ? items?.find((i) => i.id === itemId) : undefined
  const byId = new Map((items ?? []).map((i) => [i.id, i]))
  const q = item ? parseQty(qty, item) : null
  const { data, error } = useLoad(
    () => (itemId && q ? api.costEstimation(company.id, itemId, q, period.to) : Promise.resolve(null)),
    [company.id, itemId, q, period.to, version],
  )
  return (
    <div>
      <Title right={<span className="muted">at average cost as on {fmtDate(period.to)}</span>}>Cost Estimation</Title>
      <div className="inline form">
        <label>
          Stock item
          <Picker options={(items ?? []).map((i) => ({ id: i.id, name: i.name, hint: i.unit }))} value={itemId} onChange={setItemId} autoFocus />
        </label>
        <label>
          Quantity
          <input className="amount" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} aria-label="Quantity" />
        </label>
      </div>
      {error && <Errors errors={[error]} />}
      {data && (
        <table className="report">
          <thead><tr><th>Component</th><th className="num">Quantity</th><th className="num">Rate</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {data.lines.map((l, i) => (
              <tr key={i} className={l.level > 1 ? 'sub-row' : undefined}>
                <td style={{ paddingLeft: `${(l.level - 1) * 1.5}em` }}>{l.item}{l.made ? <span className="muted"> (from its components)</span> : null}</td>
                <td className="num">{qtyField(l.qty, byId.get(l.itemId))} {l.unit}</td>
                <td className="num">{l.rate ? formatINR(l.rate) : <span className="errors-inline">no cost</span>}</td>
                <td className="num">{l.level === 1 ? formatINR(l.amount) : <span className="muted">{formatINR(l.amount)}</span>}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td colSpan={3}>Estimated cost of {qtyField(data.qty, item)} {data.unit}</td><td className="num total">{formatINR(data.total)}</td></tr>
            <tr><td colSpan={3}>Per {data.unit} (its current average cost: {data.currentRate ? formatINR(data.currentRate) : 'none yet'})</td><td className="num total">{formatINR(data.perUnit)}</td></tr>
          </tfoot>
        </table>
      )}
    </div>
  )
}

/** Job Work Reports: job work orders with what is pending, our stock with job workers, principals' stock with us. */
export function JobWorkView() {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.jobWork(company.id, period.to), [company.id, period.to, version])
  const { data: items } = useLoad(() => api.stockItems(company.id), [company.id, version])
  const byId = new Map((items ?? []).map((i) => [i.id, i]))
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const orders = (title: string, lines: typeof data.outOrders, done: string) => (
    <>
      <h3 className="sub">{title}</h3>
      <table className="report">
        <thead><tr><th>Date</th><th>Order No.</th><th>Party</th><th>Item</th><th className="num">Ordered</th><th className="num">{done}</th><th className="num">Pending</th><th>Due on</th></tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr key={`${l.voucherId}/${l.itemId}`} className="clickable" tabIndex={0} onClick={() => push({ k: 'voucher', type: l.type, id: l.voucherId })}
              onKeyDown={(e) => e.key === 'Enter' && push({ k: 'voucher', type: l.type, id: l.voucherId })}>
              <td>{fmtDate(l.date)}</td><td>{l.docNo}</td><td>{l.party}</td><td>{l.item}</td>
              <td className="num">{qtyField(l.ordered, l)} {l.unit}</td><td className="num">{l.done ? `${qtyField(l.done, l)} ${l.unit}` : ''}</td>
              <td className="num">{l.pending ? <b>{qtyField(l.pending, l)} {l.unit}</b> : <span className="muted">done</span>}</td><td>{l.dueDate ? fmtDate(l.dueDate) : ''}</td>
            </tr>
          ))}
          {!lines.length && <tr className="muted"><td colSpan={8}>None</td></tr>}
        </tbody>
      </table>
    </>
  )
  const stock = (title: string, rows: typeof data.withUs, valued: boolean) => (
    <>
      <h3 className="sub">{title}</h3>
      <table className="report">
        <thead><tr><th>Godown</th><th>Item</th><th className="num">Quantity</th>{valued && <th className="num">Value</th>}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.godownId}/${r.itemId}`}><td>{r.godown}</td><td>{r.item}</td><td className="num">{qtyField(r.qty, byId.get(r.itemId))} {r.unit}</td>{valued && <td className="num">{formatINR(r.value ?? 0)}</td>}</tr>
          ))}
          {!rows.length && <tr className="muted"><td colSpan={valued ? 4 : 3}>None</td></tr>}
        </tbody>
      </table>
    </>
  )
  return (
    <div>
      <Title right={<span className="muted">as on {fmtDate(period.to)} · Enter opens the order</span>}>Job Work Reports</Title>
      {orders('Job Work Out Orders (goods a job worker processes for us)', data.outOrders, 'Received')}
      {stock('Our stock with job workers', data.withJobWorkers, true)}
      {orders('Job Work In Orders (goods we process for a principal)', data.inOrders, 'Sent back')}
      {stock("Principals' stock with us (not in our stock)", data.withUs, false)}
    </div>
  )
}
