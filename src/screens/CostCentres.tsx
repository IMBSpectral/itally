import { useEffect, useState } from 'react'
import { useApp } from '../App'
import { api } from '../api'
import { formatINR } from '../../server/src/engine/money'
import { amt, enterAdvances, Errors, Picker, Title, useConfirm, useLoad } from '../ui'
import { messages, useDeleteKey, useSubmit } from './Masters'
import { useAfterSave } from './Inventory'
import { periodNote } from './Books'

type Kind = 'cost-categories' | 'cost-centres'
const NAMES: Record<Kind, string> = { 'cost-categories': 'Cost Category', 'cost-centres': 'Cost Centre' }

function useCostDelete(kind: Kind, id: number | undefined, label: string, setErrors: (e: string[]) => void) {
  const { company, changed, pop } = useApp()
  const [confirm, ask] = useConfirm()
  useDeleteKey(!!id, ask, `Delete ${NAMES[kind].toLowerCase()} "${label}"?`, () =>
    api
      .deleteCostMaster(company.id, kind, id!)
      .then(() => {
        changed()
        pop()
      })
      .catch((e) => setErrors(messages(e))),
  )
  return confirm
}

/** Cost Category: a way of grouping cost centres (Tally's "Primary Cost Category" is always there). */
export function CostCategoryForm({ id }: { id?: number }) {
  const { company, version } = useApp()
  const { data } = useLoad(() => api.costMasters(company.id), [company.id, version])
  const [name, setName] = useState('')
  const after = useAfterSave()
  useEffect(() => {
    const c = id && data?.categories.find((x) => x.id === id)
    if (c) setName(c.name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, data === null])
  const { errors, setErrors, ok, submit } = useSubmit(async () => {
    const r = await api.saveCostMaster(company.id, 'cost-categories', id, { name })
    return after(id, r.id, `Cost category "${name}"`, () => setName(''))
  })
  const confirm = useCostDelete('cost-categories', id, name, setErrors)
  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || (id && <span className="muted">Alt+D delete</span>)}>
        Cost Category {id ? 'Alteration' : 'Creation'}
      </Title>
      {confirm}
      <label>
        Name
        <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <Errors errors={errors} />
      <div className="actions">
        <button type="submit" className="primary">
          <b>Enter</b> {id ? 'Save' : 'Create'}
        </button>
      </div>
    </form>
  )
}

/** Cost Centre: its category and the centre it sits under (a sub-centre keeps its parent's category). */
export function CostCentreForm({ id, initialName = '' }: { id?: number; initialName?: string }) {
  const { company, version } = useApp()
  const { data } = useLoad(() => api.costMasters(company.id), [company.id, version])
  const [name, setName] = useState(initialName)
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [parentId, setParentId] = useState<number | null>(0) // 0 = Primary
  const after = useAfterSave()
  useEffect(() => {
    if (!data) return
    const c = id && data.centres.find((x) => x.id === id)
    if (c) {
      setName(c.name)
      setCategoryId(c.categoryId)
      setParentId(c.parentId ?? 0)
    } else if (categoryId === null) setCategoryId(data.categories.find((k) => k.isDefault)?.id ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, data === null])
  const { errors, setErrors, ok, submit } = useSubmit(async () => {
    const r = await api.saveCostMaster(company.id, 'cost-centres', id, { name, categoryId, parentId: parentId || null })
    return after(id, r.id, `Cost centre "${name}"`, () => {
      setName('')
      setParentId(0)
    })
  })
  const confirm = useCostDelete('cost-centres', id, name, setErrors)
  const centres = (data?.centres ?? []).filter((c) => c.id !== id && (categoryId === null || c.categoryId === categoryId))
  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || (id && <span className="muted">Alt+D delete</span>)}>
        Cost Centre {id ? 'Alteration' : 'Creation'}
      </Title>
      {confirm}
      <label>
        Name
        <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {(data?.categories.length ?? 0) > 1 && (
        <label>
          Category
          <Picker
            options={(data?.categories ?? []).map((k) => ({ id: k.id, name: k.name }))}
            value={categoryId}
            onChange={(k) => {
              setCategoryId(k)
              setParentId(0) // the parent must be in the same category
            }}
            placeholder="Cost category"
          />
        </label>
      )}
      <label>
        Under
        <Picker
          options={[{ id: 0, name: 'Primary' }, ...centres.map((c) => ({ id: c.id, name: c.name, hint: data!.centres.find((p) => p.id === c.parentId)?.name ?? 'Primary' }))]}
          value={parentId}
          onChange={setParentId}
          placeholder="Primary"
        />
      </label>
      <Errors errors={errors} />
      <div className="actions">
        <button type="submit" className="primary">
          <b>Enter</b> {id ? 'Save' : 'Create'}
        </button>
      </div>
    </form>
  )
}

/** Pick a category or centre to alter, or a centre for its break-up. */
export function CostPick({ kind, next = 'alter' }: { kind: Kind; next?: 'alter' | 'breakup' }) {
  const { company, replace } = useApp()
  const { data } = useLoad(() => api.costMasters(company.id), [company.id])
  const options =
    kind === 'cost-categories'
      ? (data?.categories ?? []).map((k) => ({ id: k.id, name: k.name }))
      : (data?.centres ?? []).map((c) => ({ id: c.id, name: c.name, hint: data!.categories.find((k) => k.id === c.categoryId)?.name }))
  const open = (id: number) =>
    replace(next === 'breakup' ? { k: 'centre-breakup', centreId: id } : kind === 'cost-categories' ? { k: 'cost-category', id } : { k: 'cost-centre', id })
  return (
    <div className="form narrow">
      <Title>{next === 'breakup' ? 'Cost Centre Break-up' : `Alter ${NAMES[kind]}`}</Title>
      {data && options.length === 0 && <p className="muted">None created yet.</p>}
      <label>
        Name of {NAMES[kind].toLowerCase()}
        <Picker options={options} value={null} onChange={open} autoFocus />
      </label>
    </div>
  )
}

/** Pick a ledger or group for its cost centre break-up. */
export function CostBreakupPick({ of }: { of: 'ledger' | 'group' }) {
  const { company, period, replace } = useApp()
  const { data } = useLoad<{ id: number; name: string; hint?: string }[]>(
    async () =>
      of === 'ledger'
        ? (await api.ledgers(company.id, period)).filter((l) => l.costCentres).map((l) => ({ id: l.id, name: l.name, hint: l.group ?? '' }))
        : (await api.groups(company.id)).map((g) => ({ id: g.id, name: g.name, hint: g.nature })),
    [company.id, of],
  )
  return (
    <div className="form narrow">
      <Title>{of === 'ledger' ? 'Ledger Break-up' : 'Group Break-up'}</Title>
      {data && data.length === 0 && <p className="muted">No ledger has cost centres yet.</p>}
      <label>
        Name of {of}
        <Picker options={data ?? []} value={null} onChange={(id) => replace({ k: 'cost-breakup', ...(of === 'ledger' ? { ledgerId: id } : { groupId: id }) })} autoFocus />
      </label>
    </div>
  )
}

const DrCr = ({ dr, cr, bold }: { dr: number; cr: number; bold?: boolean }) => (
  <>
    <td className={`num ${bold ? 'total' : ''}`}>{amt(dr)}</td>
    <td className={`num ${bold ? 'total' : ''}`}>{amt(cr)}</td>
  </>
)

/** Category Summary: every category with its centres (sub-centres indented, included in their parent). */
export function CostSummaryView() {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.costSummary(company.id, period), [company.id, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={periodNote(data)}>Category Summary</Title>
      <table className="report">
        <thead>
          <tr>
            <th>Particulars</th>
            <th className="num">Debit</th>
            <th className="num">Credit</th>
          </tr>
        </thead>
        <tbody>
          {data.categories.map((k) => [
            <tr key={`k${k.id}`} className="group-row">
              <td>{k.name}</td>
              <DrCr {...k.total} bold />
            </tr>,
            ...k.lines.map((l) => (
              <tr key={l.id} className="clickable" onClick={() => push({ k: 'centre-breakup', centreId: l.id })}>
                <td style={{ paddingLeft: 30 + l.depth * 18 }}>{l.name}</td>
                <DrCr dr={l.dr} cr={l.cr} />
              </tr>
            )),
            k.lines.length === 0 && (
              <tr key={`e${k.id}`} className="muted">
                <td className="indent">No cost centres</td>
                <td />
                <td />
              </tr>
            ),
          ])}
        </tbody>
      </table>
    </div>
  )
}

/** Cost Centre Break-up: the ledgers booked to one centre. Enter opens a ledger's vouchers. */
export function CentreBreakupView({ centreId }: { centreId: number }) {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.centreBreakup(company.id, centreId, period), [company.id, centreId, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <BreakupTable
      title={`Cost Centre Break-up: ${data.centre.name}`}
      period={data}
      lines={data.lines}
      total={data.total}
      open={(id) => push({ k: 'statement', ledgerId: id })}
    />
  )
}

/** Ledger or Group Break-up: the amounts by cost centre. Enter opens a centre's break-up. */
export function CostBreakupView(which: { ledgerId: number } | { groupId: number }) {
  const { company, period, version, push } = useApp()
  const key = 'ledgerId' in which ? `l${which.ledgerId}` : `g${which.groupId}`
  const { data, error } = useLoad(() => api.costBreakup(company.id, which, period), [company.id, key, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <BreakupTable
      title={`${'ledgerId' in which ? 'Ledger' : 'Group'} Break-up: ${data.title}`}
      period={data}
      lines={data.lines}
      total={data.total}
      open={(id) => push({ k: 'centre-breakup', centreId: id })}
      category
    />
  )
}

function BreakupTable({
  title, period, lines, total, open, category,
}: {
  title: string
  period: { from: string; to: string }
  lines: { id: number; name: string; category?: string; dr: number; cr: number }[]
  total: { dr: number; cr: number }
  open: (id: number) => void
  category?: boolean
}) {
  return (
    <div>
      <Title right={periodNote(period)}>{title}</Title>
      {lines.length === 0 ? (
        <p className="muted">Nothing allocated in this period.</p>
      ) : (
        <table className="report">
          <thead>
            <tr>
              <th>Particulars</th>
              {category && <th>Category</th>}
              <th className="num">Debit</th>
              <th className="num">Credit</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="clickable" onClick={() => open(l.id)}>
                <td>{l.name}</td>
                {category && <td className="muted">{l.category}</td>}
                <DrCr dr={l.dr} cr={l.cr} />
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Grand Total</td>
              {category && <td />}
              <td className="num total">{formatINR(total.dr)}</td>
              <td className="num total">{formatINR(total.cr)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  )
}
