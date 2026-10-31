import { useEffect, useState } from 'react'
import { useApp } from '../App'
import { api, ApiError, type BudgetLineDef, type ScenarioDef } from '../api'
import { toPaise } from '../../server/src/engine/money'
import { amt, Errors, fmtDate, Picker, Title, enterAdvances, useConfirm, useLoad } from '../ui'
import { messages, useDeleteKey, useSubmit } from './Masters'
import { periodNote } from './Books'

/** Budgets, scenarios, Budget Variance and the Reversing Journal Register. */

type Kind = BudgetLineDef['kind']
const KINDS: Kind[] = ['group', 'ledger', 'cost centre']
type Row = { kind: Kind; targetId: number | null; type: 'nett' | 'closing'; amount: string; side: 'Dr' | 'Cr' }
const blankRow = (kind: Kind = 'ledger'): Row => ({ kind, targetId: null, type: 'nett', amount: '', side: 'Dr' })

/** Create / Alter, Budget: its period and parent, and the amounts for groups, ledgers and cost centres. */
export function BudgetForm({ id }: { id?: number }) {
  const { company, period, changed, pop } = useApp()
  const [confirm, ask] = useConfirm()
  const { data: budgets } = useLoad(() => api.budgets(company.id), [company.id])
  const { data: groups } = useLoad(() => api.groups(company.id), [company.id])
  const { data: ledgers } = useLoad(() => api.ledgers(company.id, period), [company.id, period])
  const { data: costs } = useLoad(() => api.costMasters(company.id), [company.id])
  const [f, setF] = useState({ name: '', parentId: null as number | null, from: period.from, to: period.to })
  const [rows, setRows] = useState<Row[]>([blankRow()])
  useEffect(() => {
    if (!id) return
    api.budget(company.id, id).then((b) => {
      setF({ name: b.name, parentId: b.parentId, from: b.from, to: b.to })
      setRows([
        ...b.lines.map((l) => ({ kind: l.kind, targetId: l.targetId, type: l.type, amount: String(Math.abs(l.amount) / 100), side: l.amount < 0 ? ('Cr' as const) : ('Dr' as const) })),
        blankRow(),
      ])
    })
  }, [company.id, id])
  const options = (k: Kind) =>
    k === 'group'
      ? (groups ?? []).map((g) => ({ id: g.id, name: g.name }))
      : k === 'ledger'
        ? (ledgers ?? []).map((l) => ({ id: l.id, name: l.name, hint: l.group }))
        : (costs?.centres ?? []).map((c) => ({ id: c.id, name: c.name }))
  const set = (i: number, patch: Partial<Row>) =>
    setRows((rs) => {
      const next = rs.map((r, n) => (n === i ? { ...r, ...patch } : r))
      return i === rs.length - 1 && patch.targetId ? [...next, blankRow(next[i].kind)] : next
    })
  const { errors, setErrors, ok, submit } = useSubmit(async () => {
    const lines = rows
      .filter((r) => r.targetId !== null)
      .map((r, n) => {
        let p = 0
        try {
          p = toPaise(r.amount || '0')
        } catch {
          throw new ApiError('', [`Line ${n + 1}: "${r.amount}" is not an amount`])
        }
        return { kind: r.kind, targetId: r.targetId!, type: r.type, amount: r.side === 'Cr' ? -p : p }
      })
    const body = { ...f, lines }
    if (id) await api.alterBudget(company.id, id, body)
    else await api.createBudget(company.id, body)
    changed()
    if (id) pop()
    else {
      setF({ name: '', parentId: null, from: period.from, to: period.to })
      setRows([blankRow()])
    }
    return `Budget "${f.name}" saved`
  })
  useDeleteKey(!!id, ask, `Delete budget "${f.name}"?`, () =>
    api
      .deleteBudget(company.id, id!)
      .then(() => {
        changed()
        pop()
      })
      .catch((e) => setErrors(messages(e))),
  )
  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || (id && <span className="muted">Alt+D delete</span>)}>{id ? 'Budget Alteration' : 'Budget Creation'}</Title>
      <div className="inline">
        <label>
          Name
          <input autoFocus required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Budget 2026-27" aria-label="Name" />
        </label>
        <label>
          Under
          <select value={f.parentId ?? ''} onChange={(e) => setF({ ...f, parentId: e.target.value ? Number(e.target.value) : null })} aria-label="Under">
            <option value="">Primary</option>
            {(budgets ?? []).filter((b) => b.id !== id).map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </label>
        <label>
          From
          <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} aria-label="From" />
        </label>
        <label>
          To
          <input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} aria-label="To" />
        </label>
      </div>
      <table className="report">
        <thead>
          <tr><th>Budget for</th><th>Name</th><th>Type of budget</th><th className="num">Amount</th><th>Dr/Cr</th></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <select value={r.kind} onChange={(e) => set(i, { kind: e.target.value as Kind, targetId: null })} aria-label={`Line ${i + 1} kind`}>
                  {KINDS.map((k) => (
                    <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>
                  ))}
                </select>
              </td>
              <td><Picker options={options(r.kind)} value={r.targetId} onChange={(v) => set(i, { targetId: v })} /></td>
              <td>
                <select value={r.type} onChange={(e) => set(i, { type: e.target.value as Row['type'] })} aria-label={`Line ${i + 1} type`}>
                  <option value="nett">On nett transactions</option>
                  <option value="closing">On closing balance</option>
                </select>
              </td>
              <td className="num"><input className="amount" inputMode="decimal" value={r.amount} onChange={(e) => set(i, { amount: e.target.value })} aria-label={`Line ${i + 1} amount`} /></td>
              <td>
                <select value={r.side} onChange={(e) => set(i, { side: e.target.value as Row['side'] })} aria-label={`Line ${i + 1} side`}>
                  <option>Dr</option>
                  <option>Cr</option>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">Expenses are budgeted Dr, income Cr. Nett transactions are the period's movement; a closing balance is the balance at the budget's end.</p>
      <Errors errors={errors} />
      <div className="actions"><button type="submit" className="primary"><b>Ctrl+A</b> Save</button></div>
      {confirm}
    </form>
  )
}

/** Alter a budget, or (next = 'variance') show its Budget Variance. */
export function BudgetPick({ next }: { next?: 'variance' }) {
  const { company, replace } = useApp()
  const { data } = useLoad(() => api.budgets(company.id), [company.id])
  return (
    <div className="form narrow">
      <Title>{next ? 'Budget Variance' : 'Alter Budget'}</Title>
      {data && !data.length && <p className="muted">No budgets yet: create one (Create, Budget).</p>}
      <label>
        Budget
        <Picker options={(data ?? []).map((b) => ({ id: b.id, name: b.name, hint: `${fmtDate(b.from)} to ${fmtDate(b.to)}` }))} value={null}
          onChange={(id) => replace(next ? { k: 'budget-variance', id } : { k: 'budget', id })} autoFocus />
      </label>
    </div>
  )
}

/** Budget Variance: each line of a budget, the books' figure, and the variance (under a scenario, if one is chosen). */
export function BudgetVarianceView({ id }: { id: number }) {
  const { company, version } = useApp()
  const { data: scenarios } = useLoad(() => api.scenarios(company.id), [company.id])
  const [scenario, setScenario] = useState<number | null>(null)
  const { data, error } = useLoad(() => api.budgetVariance(company.id, id, scenario), [company.id, id, scenario, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const drcr = (p: number) => (p ? `${amt(Math.abs(p))} ${p < 0 ? 'Cr' : 'Dr'}` : '')
  return (
    <div>
      <Title right={<span className="muted">{fmtDate(data.budget.from)} to {fmtDate(data.budget.to)}</span>}>Budget Variance: {data.budget.name}</Title>
      {!!scenarios?.length && (
        <label className="inline">
          Scenario
          <select value={scenario ?? ''} onChange={(e) => setScenario(e.target.value ? Number(e.target.value) : null)} aria-label="Scenario">
            <option value="">Actuals (the books)</option>
            {scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      )}
      <table className="report">
        <thead>
          <tr><th>Particulars</th><th>Type</th><th className="num">Budget</th><th className="num">Actual</th><th className="num">Variance</th><th className="num">%</th></tr>
        </thead>
        <tbody>
          {data.lines.map((l) => (
            <tr key={`${l.kind}/${l.targetId}`}>
              <td>{l.name} <span className="muted small">({l.kind})</span></td>
              <td className="muted">{l.type === 'nett' ? 'Nett transactions' : 'Closing balance'}</td>
              <td className="num">{drcr(l.amount)}</td>
              <td className="num">{drcr(l.actual)}</td>
              <td className="num">{drcr(l.variance)}</td>
              <td className="num">{l.amount ? `${((l.actual / l.amount) * 100).toFixed(1)}%` : ''}</td>
            </tr>
          ))}
          {!data.lines.length && <tr className="muted"><td colSpan={6}>The budget has no amounts yet</td></tr>}
        </tbody>
      </table>
      <p className="muted">Variance is actual less budget; % is the actual as a share of the budget.</p>
    </div>
  )
}

const INCLUDES: ScenarioDef['include'][number][] = ['Reversing Journal', 'Optional', 'Memorandum']

/** Create / Alter, Scenario: whether the books are included, and which vouchers kept out of them are. */
export function ScenarioForm({ id }: { id?: number }) {
  const { company, changed, pop } = useApp()
  const [confirm, ask] = useConfirm()
  const { data } = useLoad(() => api.scenarios(company.id), [company.id])
  const [f, setF] = useState<Omit<ScenarioDef, 'id'>>({ name: '', includeActuals: true, include: ['Reversing Journal'] })
  const current = id ? data?.find((s) => s.id === id) : undefined
  useEffect(() => {
    if (current) setF({ name: current.name, includeActuals: current.includeActuals, include: current.include })
  }, [current])
  const { errors, setErrors, ok, submit } = useSubmit(async () => {
    if (id) await api.alterScenario(company.id, id, f)
    else await api.createScenario(company.id, f)
    changed()
    if (id) pop()
    else setF({ name: '', includeActuals: true, include: ['Reversing Journal'] })
    return `Scenario "${f.name}" saved`
  })
  useDeleteKey(!!id, ask, `Delete scenario "${f.name}"?`, () =>
    api
      .deleteScenario(company.id, id!)
      .then(() => {
        changed()
        pop()
      })
      .catch((e) => setErrors(messages(e))),
  )
  const toggle = (t: (typeof INCLUDES)[number]) => setF((x) => ({ ...x, include: x.include.includes(t) ? x.include.filter((y) => y !== t) : [...x.include, t] }))
  return (
    <form className="form narrow" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || (id && <span className="muted">Alt+D delete</span>)}>{id ? 'Scenario Alteration' : 'Scenario Creation'}</Title>
      <label>
        Name
        <input autoFocus required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Provisional" aria-label="Name" />
      </label>
      <label>
        Include actuals
        <select value={f.includeActuals ? 'Yes' : 'No'} onChange={(e) => setF({ ...f, includeActuals: e.target.value === 'Yes' })} aria-label="Include actuals">
          <option>Yes</option>
          <option>No</option>
        </select>
      </label>
      <fieldset>
        <legend>Include</legend>
        {INCLUDES.map((t) => (
          <label key={t} className="check">
            <input type="checkbox" checked={f.include.includes(t)} onChange={() => toggle(t)} /> {t === 'Optional' ? 'Optional vouchers' : t === 'Memorandum' ? 'Memorandum vouchers' : 'Reversing journals'}
          </label>
        ))}
      </fieldset>
      <p className="muted">Trial Balance, Profit &amp; Loss and Balance Sheet can then be shown under the scenario. A reversing journal counts up to its applicable-upto date.</p>
      <Errors errors={errors} />
      <div className="actions"><button type="submit" className="primary"><b>Ctrl+A</b> Save</button></div>
      {confirm}
    </form>
  )
}

export function ScenarioPick() {
  const { company, replace } = useApp()
  const { data } = useLoad(() => api.scenarios(company.id), [company.id])
  return (
    <div className="form narrow">
      <Title>Alter Scenario</Title>
      {data && !data.length && <p className="muted">No scenarios yet.</p>}
      <label>
        Scenario
        <Picker options={(data ?? []).map((s) => ({ id: s.id, name: s.name }))} value={null} onChange={(id) => replace({ k: 'scenario', id })} autoFocus />
      </label>
    </div>
  )
}

/** Reversing Journal Register: the period's reversing journals and how long each is effective. */
export function ReversingJournalsView() {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.reversingJournals(company.id, period), [company.id, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={periodNote(data)}>Reversing Journal Register</Title>
      <table className="report">
        <thead>
          <tr><th>Date</th><th>Vch No.</th><th>Particulars</th><th>Applicable up to</th><th className="num">Amount</th><th /></tr>
        </thead>
        <tbody>
          {data.vouchers.map((v) => (
            <tr key={v.id} className="clickable" tabIndex={0} onClick={() => push({ k: 'voucher', type: 'Reversing Journal', id: v.id })}
              onKeyDown={(e) => e.key === 'Enter' && push({ k: 'voucher', type: 'Reversing Journal', id: v.id })}>
              <td>{fmtDate(v.date)}</td><td>{v.docNo}</td><td>{v.particulars}{v.narration ? <div className="muted small">{v.narration}</div> : null}</td>
              <td>{fmtDate(v.applicableUpto)}</td><td className="num">{amt(v.amount)}</td>
              <td>{v.effective ? <span className="badge">effective</span> : <span className="muted">reversed</span>}</td>
            </tr>
          ))}
          {!data.vouchers.length && <tr className="muted"><td colSpan={6}>No reversing journals in this period</td></tr>}
        </tbody>
      </table>
      <p className="muted">Reversing journals stay out of the books; a scenario that includes them shows their effect up to the applicable-upto date.</p>
    </div>
  )
}
