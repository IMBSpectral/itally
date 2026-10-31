import { Fragment, useEffect, useRef, useState } from 'react'
import { useApp } from '../App'
import { api, ApiError, type AttendanceTypeDef, type PayHeadDef, type PayrollFill, type PaySlab, type Statutory } from '../api'
import { formatINR, toPaise } from '../../server/src/engine/money'
import { PAY_TYPES, sideOf, STATUTORY, type PayType } from '../../server/src/engine/payroll'
import { amt, DateInput, Errors, fmtDate, MONTHS, Picker, Title, enterAdvances, useActive, useConfirm, useLoad } from '../ui'
import { messages, useDeleteKey, useSubmit } from './Masters'

/** Payroll masters, the Payroll and Attendance vouchers, and the payroll reports. */

const usePayroll = () => {
  const { company, version } = useApp()
  return useLoad(() => api.payroll(company.id), [company.id, version])
}
const rupees = (p: number | null | undefined) => (p == null ? '' : String(p / 100))
const money = (s: string) => (s.trim() ? toPaise(s) : null)
const pct = (r: number) => String(r / 100)
const qty = (t: number) => String(t / 1000)
const monthOf = (d: string) => {
  const end = new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0)).toISOString().slice(0, 10)
  return { from: d.slice(0, 8) + '01', to: end }
}
const periodText = (from: string, to: string) => (from.slice(0, 7) === to.slice(0, 7) && from.endsWith('-01') && monthOf(from).to === to
  ? `${MONTHS[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}` : `${fmtDate(from)} to ${fmtDate(to)}`)

/** Alt+J on a report: save its file (an ECR text, a CSV) for the portal. */
function useAltJ(fn: (() => void) | null) {
  const active = useActive()
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === 'j' || e.key === 'J') && ref.current) {
        e.preventDefault()
        ref.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])
}
function save(name: string, text: string, type = 'text/plain') {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = name
  a.click()
}
const csv = (rows: unknown[][]) =>
  rows.map((l) => l.map((v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''))).join(',')).join('\r\n') + '\r\n'

// ------------------------------------------------------------------ employee groups and employees

export function EmployeeGroupForm({ id }: { id?: number }) {
  const { company, changed, pop } = useApp()
  const [confirm, ask] = useConfirm()
  const { data } = usePayroll()
  const [f, setF] = useState({ name: '', categoryId: null as number | null, parentId: null as number | null })
  const current = id ? data?.groups.find((g) => g.id === id) : undefined
  useEffect(() => {
    if (current) setF({ name: current.name, categoryId: current.categoryId, parentId: current.parentId })
  }, [current])
  const { errors, setErrors, ok, submit } = useSubmit(async () => {
    if (id) await api.alterEmployeeGroup(company.id, id, f)
    else await api.createEmployeeGroup(company.id, f)
    changed()
    if (id) pop()
    else setF({ name: '', categoryId: f.categoryId, parentId: f.parentId })
    return `Employee group "${f.name}" saved`
  })
  useDeleteKey(!!id, ask, `Delete employee group "${f.name}"?`, () => api.deleteEmployee(company.id, id!).then(() => (changed(), pop())).catch((e) => setErrors(messages(e))))
  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || (id && <span className="muted">Alt+D delete</span>)}>{id ? 'Employee Group Alteration' : 'Employee Group Creation'}</Title>
      <label>
        Name
        <input autoFocus required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Factory Staff" aria-label="Name" />
      </label>
      <label>
        Under
        <Picker options={[{ id: 0, name: 'Primary' }, ...(data?.groups ?? []).filter((g) => g.id !== id).map((g) => ({ id: g.id, name: g.name }))]} value={f.parentId ?? 0}
          onChange={(v) => setF({ ...f, parentId: v || null })} />
      </label>
      {!f.parentId && (
        <label>
          Employee category
          <select value={f.categoryId ?? ''} onChange={(e) => setF({ ...f, categoryId: Number(e.target.value) || null })} aria-label="Employee category">
            {(data?.categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      )}
      <p className="muted">Employee categories are the company's cost categories, and employees its cost centres, so the cost centre reports show salaries by employee.</p>
      <Errors errors={errors} />
      <div className="actions"><button type="submit" className="primary"><b>Ctrl+A</b> Save</button></div>
      {confirm}
    </form>
  )
}

const BLANK_EMPLOYEE = {
  name: '', groupId: null as number | null, categoryId: null as number | null, number: '', designation: '', department: '', location: '', gender: '' as '' | 'Male' | 'Female' | 'Other',
  dateOfBirth: '', dateOfJoining: '', dateOfLeaving: '', pan: '', uan: '', pfNumber: '', esiNumber: '', pran: '', bankName: '', accountNo: '', ifsc: '', taxRegime: 'new' as 'new' | 'old',
}

export function EmployeeForm({ id }: { id?: number }) {
  const { company, period, changed, pop } = useApp()
  const [confirm, ask] = useConfirm()
  const { data } = usePayroll()
  const [f, setF] = useState({ ...BLANK_EMPLOYEE, dateOfJoining: period.from })
  const current = id ? data?.employees.find((e) => e.id === id) : undefined
  useEffect(() => {
    if (!current) return
    const s = (v: string | null | undefined) => v ?? ''
    setF({
      name: current.name, groupId: current.parentId, categoryId: current.categoryId, number: s(current.number), designation: s(current.designation), department: s(current.department),
      location: s(current.location), gender: current.gender ?? '', dateOfBirth: s(current.dateOfBirth), dateOfJoining: current.dateOfJoining, dateOfLeaving: s(current.dateOfLeaving),
      pan: s(current.pan), uan: s(current.uan), pfNumber: s(current.pfNumber), esiNumber: s(current.esiNumber), pran: s(current.pran), bankName: s(current.bankName),
      accountNo: s(current.accountNo), ifsc: s(current.ifsc), taxRegime: current.taxRegime ?? 'new',
    })
  }, [current])
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }))
  const { errors, setErrors, ok, submit } = useSubmit(async () => {
    const n = (s: string) => s.trim() || null
    const body = {
      name: f.name, groupId: f.groupId, categoryId: f.categoryId, number: n(f.number), designation: n(f.designation), department: n(f.department), location: n(f.location),
      gender: f.gender || null, dateOfBirth: f.dateOfBirth || null, dateOfJoining: f.dateOfJoining, dateOfLeaving: f.dateOfLeaving || null, pan: n(f.pan), uan: n(f.uan),
      pfNumber: n(f.pfNumber), esiNumber: n(f.esiNumber), pran: n(f.pran), bankName: n(f.bankName), accountNo: n(f.accountNo), ifsc: n(f.ifsc), taxRegime: f.taxRegime,
    }
    if (id) await api.alterEmployee(company.id, id, body)
    else await api.createEmployee(company.id, body)
    changed()
    if (id) pop()
    else setF({ ...BLANK_EMPLOYEE, groupId: f.groupId, categoryId: f.categoryId, dateOfJoining: f.dateOfJoining })
    return `Employee "${f.name}" saved`
  })
  useDeleteKey(!!id, ask, `Delete employee "${f.name}"?`, () => api.deleteEmployee(company.id, id!).then(() => (changed(), pop())).catch((e) => setErrors(messages(e))))
  const text = (k: keyof typeof f, label: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label>
      {label}
      <input value={f[k] as string} onChange={(e) => set(k, e.target.value as never)} aria-label={label} {...extra} />
    </label>
  )
  // date of birth and leaving may be left blank, which the short-date field can't be
  const date = (k: 'dateOfBirth' | 'dateOfJoining' | 'dateOfLeaving', label: string) => (
    <label>
      {label}
      {k === 'dateOfJoining' ? <DateInput label={label} value={f[k]} onChange={(d) => set(k, d)} fyStart={company.fyStart} />
        : <input type="date" value={f[k]} onChange={(e) => set(k, e.target.value)} aria-label={label} />}
    </label>
  )
  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || (id && <span className="muted">Alt+D delete</span>)}>{id ? 'Employee Alteration' : 'Employee Creation'}</Title>
      {text('name', 'Name', { autoFocus: true, required: true })}
      <label>
        Under
        <Picker options={[{ id: 0, name: 'Primary' }, ...(data?.groups ?? []).map((g) => ({ id: g.id, name: g.name }))]} value={f.groupId ?? 0} onChange={(v) => set('groupId', v || null)} />
      </label>
      {!f.groupId && (
        <label>
          Employee category
          <select value={f.categoryId ?? ''} onChange={(e) => set('categoryId', Number(e.target.value) || null)} aria-label="Employee category">
            {(data?.categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      )}
      <h3 className="sub">General information</h3>
      <div className="inline">
        {date('dateOfJoining', 'Date of joining')}
        {text('number', 'Employee number')}
        {text('designation', 'Designation')}
      </div>
      <div className="inline">
        {text('department', 'Function / department')}
        {text('location', 'Location')}
        <label>
          Gender
          <select value={f.gender} onChange={(e) => set('gender', e.target.value as typeof f.gender)} aria-label="Gender">
            <option value="">Not given</option>
            <option>Male</option>
            <option>Female</option>
            <option>Other</option>
          </select>
        </label>
      </div>
      <div className="inline">
        {date('dateOfBirth', 'Date of birth')}
        {id ? date('dateOfLeaving', 'Date of leaving') : null}
      </div>
      <h3 className="sub">Payment details</h3>
      <div className="inline">
        {text('bankName', 'Bank')}
        {text('accountNo', 'Account number')}
        {text('ifsc', 'IFSC')}
      </div>
      <h3 className="sub">Statutory details</h3>
      <div className="inline">
        {text('pan', 'PAN')}
        <label>
          Tax regime
          <select value={f.taxRegime} onChange={(e) => set('taxRegime', e.target.value as 'new' | 'old')} aria-label="Tax regime">
            <option value="new">New (section 115BAC)</option>
            <option value="old">Old</option>
          </select>
        </label>
        {text('uan', 'UAN (PF)')}
      </div>
      <div className="inline">
        {text('pfNumber', 'PF account number')}
        {text('esiNumber', 'ESI IP number')}
        {text('pran', 'PRAN (NPS)')}
      </div>
      <Errors errors={errors} />
      <div className="actions"><button type="submit" className="primary"><b>Ctrl+A</b> Save</button></div>
      {confirm}
    </form>
  )
}

// ------------------------------------------------------------------ attendance / production types

const KINDS: AttendanceTypeDef['kind'][] = ['attendance', 'leave with pay', 'leave without pay', 'production']
const kindText = (k: AttendanceTypeDef['kind']) => (k === 'attendance' ? 'Attendance / leave with pay' : k === 'leave with pay' ? 'Leave with pay' : k === 'leave without pay' ? 'Leave without pay' : 'Production')

export function AttendanceTypeForm({ id }: { id?: number }) {
  const { company, changed, pop } = useApp()
  const [confirm, ask] = useConfirm()
  const { data } = usePayroll()
  const [f, setF] = useState<Omit<AttendanceTypeDef, 'id'>>({ name: '', kind: 'attendance', unit: 'Days' })
  const current = id ? data?.attendanceTypes.find((t) => t.id === id) : undefined
  useEffect(() => {
    if (current) setF({ name: current.name, kind: current.kind, unit: current.unit })
  }, [current])
  const { errors, setErrors, ok, submit } = useSubmit(async () => {
    if (id) await api.alterAttendanceType(company.id, id, f)
    else await api.createAttendanceType(company.id, f)
    changed()
    if (id) pop()
    else setF({ name: '', kind: f.kind, unit: f.unit })
    return `"${f.name}" saved`
  })
  useDeleteKey(!!id, ask, `Delete "${f.name}"?`, () => api.deleteAttendanceType(company.id, id!).then(() => (changed(), pop())).catch((e) => setErrors(messages(e))))
  return (
    <form className="form narrow" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || (id && <span className="muted">Alt+D delete</span>)}>
        {id ? 'Attendance/Production Type Alteration' : 'Attendance/Production Type Creation'}
      </Title>
      <label>
        Name
        <input autoFocus required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Present" aria-label="Name" />
      </label>
      <label>
        Type
        <select value={f.kind} onChange={(e) => {
          const kind = e.target.value as AttendanceTypeDef['kind']
          setF({ ...f, kind, unit: kind === 'production' ? (f.unit === 'Days' ? 'Nos' : f.unit) : f.unit === 'Nos' ? 'Days' : f.unit })
        }} aria-label="Type">
          {KINDS.map((k) => <option key={k} value={k}>{kindText(k)}</option>)}
        </select>
      </label>
      <label>
        Unit
        <input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} aria-label="Unit" />
      </label>
      <Errors errors={errors} />
      <div className="actions"><button type="submit" className="primary"><b>Ctrl+A</b> Save</button></div>
      {confirm}
    </form>
  )
}

// ------------------------------------------------------------------ pay heads

const CALCULATIONS: { id: PayHeadDef['calculation']; label: string }[] = [
  { id: 'user', label: 'As user defined value' },
  { id: 'flat', label: 'Flat rate' },
  { id: 'attendance', label: 'On attendance' },
  { id: 'production', label: 'On production' },
  { id: 'computed', label: 'As computed value' },
]
/** What a statutory pay head starts with: Tally's own defaults (Karnataka's professional tax). */
const STATUTORY_DEFAULTS: Partial<Record<Statutory, { slabs: PaySlab[]; ceiling?: number; rounding?: PayHeadDef['rounding'] }>> = {
  pf: { slabs: [{ upTo: null, rate: 1200, value: 0 }] },
  eps: { slabs: [{ upTo: null, rate: 833, value: 0 }], ceiling: 1500000 },
  'epf-employer': { slabs: [{ upTo: null, rate: 1200, value: 0 }] },
  edli: { slabs: [{ upTo: null, rate: 50, value: 0 }], ceiling: 1500000 },
  'pf-admin': { slabs: [{ upTo: null, rate: 50, value: 0 }] },
  esi: { slabs: [{ upTo: null, rate: 75, value: 0 }], ceiling: 2100000, rounding: 'up' },
  'esi-employer': { slabs: [{ upTo: null, rate: 325, value: 0 }], ceiling: 2100000, rounding: 'up' },
  pt: { slabs: [{ upTo: 2499900, rate: 0, value: 0 }, { upTo: null, rate: 0, value: 20000 }] },
  nps: { slabs: [{ upTo: null, rate: 1000, value: 0 }] },
  'nps-employer': { slabs: [{ upTo: null, rate: 1000, value: 0 }] },
}
type SlabRow = { upTo: string; rate: string; value: string }
const slabRows = (s: PaySlab[]): SlabRow[] => s.map((x) => ({ upTo: rupees(x.upTo), rate: pct(x.rate), value: rupees(x.value) }))

export function PayHeadForm({ id }: { id?: number }) {
  const { company, period, changed, pop, version } = useApp()
  const [confirm, ask] = useConfirm()
  const { data } = usePayroll()
  const { data: groups } = useLoad(() => api.groups(company.id), [company.id, version])
  const { data: ledgers } = useLoad(() => api.ledgers(company.id, period), [company.id, version])
  const groupId = (name: string) => groups?.find((g) => g.name === name)?.id ?? null
  const blank = {
    name: '', payType: 'Earnings for Employees' as PayType, groupId: null as number | null, statutory: '' as Statutory | '', calculation: 'flat' as PayHeadDef['calculation'],
    attendanceTypeId: null as number | null, perDayDays: '', formula: [] as { payHeadId: number | null; sign: 1 | -1 }[], ceiling: '', slabs: [] as SlabRow[],
    rounding: 'normal' as PayHeadDef['rounding'], roundTo: '1', expenseLedgerId: null as number | null, taxComponent: null as PayHeadDef['taxComponent'],
  }
  const [f, setF] = useState(blank)
  const current = id ? data?.payHeads.find((h) => h.id === id) : undefined
  useEffect(() => {
    if (!current) return
    setF({
      name: current.name, payType: current.payType, groupId: current.groupId, statutory: current.statutory ?? '', calculation: current.calculation,
      attendanceTypeId: current.attendanceTypeId, perDayDays: current.perDayDays ? String(current.perDayDays) : '', formula: current.formula, ceiling: rupees(current.ceiling),
      slabs: slabRows(current.slabs), rounding: current.rounding, roundTo: rupees(current.roundTo), expenseLedgerId: current.expenseLedgerId, taxComponent: current.taxComponent ?? null,
    })
  }, [current])
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }))
  const side = sideOf(f.payType)
  const statutoryOptions = (Object.keys(STATUTORY) as Statutory[]).filter((s) => STATUTORY[s].side === side)
  const pickStatutory = (s: Statutory | '') => {
    const d = s ? STATUTORY_DEFAULTS[s] : undefined
    setF((x) => ({
      ...x, statutory: s,
      ...(s ? { calculation: 'computed' as const } : {}),
      ...(d ? { slabs: slabRows(d.slabs), ceiling: rupees(d.ceiling ?? null), rounding: d.rounding ?? 'normal' } : {}),
    }))
  }
  const { errors, setErrors, ok, submit } = useSubmit(async () => {
    const group = f.groupId ?? groupId(side === 'earning' ? 'Indirect Expenses' : 'Current Liabilities')
    if (!group) throw new ApiError('', ['Choose the group the pay head ledger sits under'])
    const body: Omit<PayHeadDef, 'id'> = {
      name: f.name, groupId: group, payType: f.payType, statutory: f.statutory || null, calculation: f.calculation, attendanceTypeId: f.attendanceTypeId,
      perDayDays: f.perDayDays.trim() ? Number(f.perDayDays) : null,
      formula: f.formula.filter((t) => t.payHeadId).map((t) => ({ payHeadId: t.payHeadId!, sign: t.sign })),
      ceiling: money(f.ceiling),
      slabs: f.slabs.filter((s) => s.rate.trim() || s.value.trim()).map((s) => ({ upTo: money(s.upTo), rate: Math.round(Number(s.rate || 0) * 100), value: money(s.value) ?? 0 })),
      rounding: f.rounding, roundTo: money(f.roundTo) ?? 100, expenseLedgerId: f.expenseLedgerId, taxComponent: side === 'earning' ? f.taxComponent : null,
    }
    if (id) await api.alterPayHead(company.id, id, body)
    else await api.createPayHead(company.id, body)
    changed()
    if (id) pop()
    else setF(blank)
    return `Pay head "${f.name}" saved`
  })
  useDeleteKey(!!id, ask, `Delete pay head "${f.name}"?`, () => api.deletePayHead(company.id, id!).then(() => (changed(), pop())).catch((e) => setErrors(messages(e))))
  const heads = (data?.payHeads ?? []).filter((h) => h.id !== id).map((h) => ({ id: h.id, name: h.name, hint: h.payType }))
  const types = (data?.attendanceTypes ?? []).filter((t) => (t.kind === 'production') === (f.calculation === 'production'))
  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || (id && <span className="muted">Alt+D delete</span>)}>{id ? 'Pay Head Alteration' : 'Pay Head Creation'}</Title>
      <label>
        Name
        <input autoFocus required value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Basic Salary" aria-label="Name" />
      </label>
      <div className="inline">
        <label>
          Pay head type
          <select value={f.payType} onChange={(e) => setF((x) => ({ ...x, payType: e.target.value as PayType, statutory: '' }))} aria-label="Pay head type">
            {PAY_TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </label>
        <label>
          Statutory pay type
          <select value={f.statutory} onChange={(e) => pickStatutory(e.target.value as Statutory | '')} aria-label="Statutory pay type">
            <option value="">Not applicable</option>
            {statutoryOptions.map((s) => <option key={s} value={s}>{STATUTORY[s].label}</option>)}
          </select>
        </label>
      </div>
      <label>
        Under
        <Picker options={(groups ?? []).map((g) => ({ id: g.id, name: g.name }))} value={f.groupId ?? groupId(side === 'earning' ? 'Indirect Expenses' : 'Current Liabilities')}
          onChange={(v) => set('groupId', v)} />
      </label>
      {side === 'earning' && f.payType === 'Earnings for Employees' && (
        <label>
          Income tax component
          <select value={f.taxComponent ?? ''} onChange={(e) => set('taxComponent', (e.target.value || null) as PayHeadDef['taxComponent'])} aria-label="Income tax component">
            <option value="">Other earnings</option>
            <option value="basic">Basic salary (and DA)</option>
            <option value="hra">House rent allowance</option>
          </select>
        </label>
      )}
      {side === 'employer' && (
        <label>
          Expense ledger (the employer's cost)
          <Picker options={(ledgers ?? []).filter((l) => l.primaryGroup !== null).map((l) => ({ id: l.id, name: l.name, hint: l.group ?? '' }))} value={f.expenseLedgerId}
            onChange={(v) => set('expenseLedgerId', v)} placeholder="Employer's PF Contribution" />
        </label>
      )}
      {f.statutory !== 'income-tax' && (
        <label>
          Calculation type
          <select value={f.calculation} onChange={(e) => set('calculation', e.target.value as PayHeadDef['calculation'])} aria-label="Calculation type">
            {CALCULATIONS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
      )}
      {f.statutory === 'income-tax' && (
        <p className="muted">Computed each month: the year's salary so far plus this month's for the months left, less the standard deduction, taxed in the employee's regime (with the 87A rebate and 4% cess), less the tax already deducted, spread over the months left.</p>
      )}
      {(f.calculation === 'attendance' || f.calculation === 'production') && (
        <div className="inline">
          <label>
            {f.calculation === 'production' ? 'Production type' : 'Attendance / leave type'}
            <select value={f.attendanceTypeId ?? ''} onChange={(e) => set('attendanceTypeId', Number(e.target.value) || null)} aria-label="Attendance type">
              <option value="">Choose</option>
              {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          {f.calculation === 'attendance' && (
            <label>
              Days in a month (blank: the calendar's)
              <input className="amount" inputMode="numeric" value={f.perDayDays} onChange={(e) => set('perDayDays', e.target.value)} aria-label="Days in a month" />
            </label>
          )}
        </div>
      )}
      {f.calculation === 'computed' && f.statutory !== 'income-tax' && (
        <>
          <h3 className="sub">Compute on</h3>
          {f.formula.map((t, i) => (
            <div className="inline" key={i}>
              <label>
                {i === 0 ? 'Pay head' : 'and'}
                <select value={t.sign} onChange={(e) => set('formula', f.formula.map((x, k) => (k === i ? { ...x, sign: Number(e.target.value) as 1 | -1 } : x)))} aria-label="Add or subtract">
                  <option value={1}>Add</option>
                  <option value={-1}>Subtract</option>
                </select>
              </label>
              <label>
                &nbsp;
                <Picker options={heads} value={t.payHeadId} onChange={(v) => set('formula', f.formula.map((x, k) => (k === i ? { ...x, payHeadId: v } : x)))} />
              </label>
            </div>
          ))}
          <div className="actions">
            <button type="button" onClick={() => set('formula', [...f.formula, { payHeadId: null, sign: 1 }])}>Add a pay head</button>
          </div>
          <div className="inline">
            <label>
              {f.statutory === 'esi' || f.statutory === 'esi-employer' ? 'Wage limit (no ESI above it)' : 'Ceiling on the base (blank: none)'}
              <input className="amount" inputMode="decimal" value={f.ceiling} onChange={(e) => set('ceiling', e.target.value)} aria-label="Ceiling" />
            </label>
          </div>
          <h3 className="sub">Slabs</h3>
          <table className="report">
            <thead><tr><th className="num">Base up to (blank: and above)</th><th className="num">Rate %</th><th className="num">Value</th></tr></thead>
            <tbody>
              {f.slabs.map((s, i) => (
                <tr key={i}>
                  {(['upTo', 'rate', 'value'] as const).map((k) => (
                    <td key={k}><input className="amount" inputMode="decimal" value={s[k]} aria-label={`Slab ${i + 1} ${k}`}
                      onChange={(e) => set('slabs', f.slabs.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="actions">
            <button type="button" onClick={() => set('slabs', [...f.slabs, { upTo: '', rate: '', value: '' }])}>Add a slab</button>
          </div>
        </>
      )}
      <div className="inline">
        <label>
          Rounding
          <select value={f.rounding} onChange={(e) => set('rounding', e.target.value as PayHeadDef['rounding'])} aria-label="Rounding">
            <option value="normal">Normal</option>
            <option value="up">Upward</option>
            <option value="down">Downward</option>
            <option value="none">Not applicable</option>
          </select>
        </label>
        {f.rounding !== 'none' && (
          <label>
            Rounding limit (₹)
            <input className="amount" inputMode="decimal" value={f.roundTo} onChange={(e) => set('roundTo', e.target.value)} aria-label="Rounding limit" />
          </label>
        )}
      </div>
      <Errors errors={errors} />
      <div className="actions"><button type="submit" className="primary"><b>Ctrl+A</b> Save</button></div>
      {confirm}
    </form>
  )
}

// ------------------------------------------------------------------ salary details

export function SalaryDetailsForm({ centreId: initial }: { centreId?: number }) {
  const { company, period, changed } = useApp()
  const { data } = usePayroll()
  const [centreId, setCentreId] = useState<number | null>(initial ?? null)
  const [from, setFrom] = useState(period.from)
  const [rows, setRows] = useState<{ payHeadId: number | null; rate: string }[]>([])
  const headOf = new Map((data?.payHeads ?? []).map((h) => [h.id, h]))
  // the revision in force on the date (or the latest before it) starts the form
  useEffect(() => {
    if (!data || !centreId) return
    const s = data.salary.filter((x) => x.centreId === centreId && x.effectiveFrom <= from).at(-1)
    setRows([...(s?.lines ?? []).map((l) => ({ payHeadId: l.payHeadId, rate: rupees(l.rate) })), { payHeadId: null, rate: '' }])
  }, [data, centreId, from])
  const { errors, ok, submit } = useSubmit(async () => {
    if (!centreId) throw new ApiError('', ['Choose the employee or employee group'])
    await api.setSalary(company.id, centreId, from, rows.filter((r) => r.payHeadId).map((r) => ({ payHeadId: r.payHeadId!, rate: money(r.rate) })))
    changed()
    return 'Salary details saved'
  })
  const people = [...(data?.groups ?? []).map((g) => ({ id: g.id, name: g.name, hint: 'group' })), ...(data?.employees ?? []).map((e) => ({ id: e.id, name: e.name, hint: e.designation ?? 'employee' }))]
  const history = (data?.salary ?? []).filter((x) => x.centreId === centreId)
  const takesRate = (id: number | null) => {
    const h = id ? headOf.get(id) : undefined
    return !h || (h.calculation !== 'computed' && h.statutory !== 'income-tax')
  }
  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={ok && <span className="ok">{ok}</span>}>Salary Details</Title>
      <div className="inline">
        <label>
          Employee or group
          <Picker options={people} value={centreId} onChange={setCentreId} autoFocus={!initial} />
        </label>
        <label>
          Effective from
          <DateInput label="Effective from" value={from} onChange={setFrom} fyStart={company.fyStart} />
        </label>
      </div>
      {history.length > 0 && <p className="muted">Revisions: {history.map((h) => fmtDate(h.effectiveFrom)).join(', ')}. An employee with none of their own takes their group's.</p>}
      <table className="report">
        <thead><tr><th>Pay head</th><th>Type</th><th>Calculation</th><th className="num">Rate</th></tr></thead>
        <tbody>
          {rows.map((r, i) => {
            const h = r.payHeadId ? headOf.get(r.payHeadId) : undefined
            return (
              <tr key={i}>
                <td>
                  <Picker options={(data?.payHeads ?? []).map((x) => ({ id: x.id, name: x.name, hint: x.payType }))} value={r.payHeadId}
                    onChange={(v) => setRows((x) => { const n = x.map((y, k) => (k === i ? { ...y, payHeadId: v } : y)); return i === x.length - 1 ? [...n, { payHeadId: null, rate: '' }] : n })} />
                </td>
                <td>{h?.payType ?? ''}</td>
                <td>{h ? (h.statutory ? STATUTORY[h.statutory].label : CALCULATIONS.find((c) => c.id === h.calculation)?.label) : ''}</td>
                <td className="num">
                  {takesRate(r.payHeadId) ? (
                    <input className="amount" inputMode="decimal" value={r.rate} aria-label={`Rate ${i + 1}`} placeholder={h?.calculation === 'production' ? 'per unit' : h ? 'a month' : ''}
                      onChange={(e) => setRows((x) => x.map((y, k) => (k === i ? { ...y, rate: e.target.value } : y)))} />
                  ) : <span className="muted">computed</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="muted">Pay heads are worked out in this order; a computed one takes the heads it is computed on from above it. Clear every line to remove this revision.</p>
      <Errors errors={errors} />
      <div className="actions"><button type="submit" className="primary"><b>Ctrl+A</b> Save</button></div>
    </form>
  )
}

/** Loans and advances to employees: given, recovered through the payroll, outstanding. */
export function LoansView() {
  const { company, changed, version } = useApp()
  const { data: masters } = usePayroll()
  const { data, error } = useLoad(() => api.loans(company.id), [company.id, version])
  const [confirm, ask] = useConfirm()
  const [f, setF] = useState({ employeeId: null as number | null, payHeadId: null as number | null, givenOn: '', amount: '', instalment: '', recoverFrom: '', note: '' })
  const { errors, setErrors, ok, submit } = useSubmit(async () => {
    await api.createLoan(company.id, {
      employeeId: f.employeeId ?? 0, payHeadId: f.payHeadId ?? 0, givenOn: f.givenOn, amount: money(f.amount) ?? 0, instalment: money(f.instalment) ?? 0,
      recoverFrom: f.recoverFrom || f.givenOn, note: f.note,
    })
    changed()
    setF({ ...f, amount: '', instalment: '', note: '' })
    return 'Loan saved'
  })
  if (error) return <Errors errors={[error]} />
  const loanHeads = (masters?.payHeads ?? []).filter((h) => h.payType === 'Loans and Advances')
  return (
    <form className="form wide" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || <span className="muted">Ctrl+A saves a new loan</span>}>Loans and Advances</Title>
      <table className="report">
        <thead><tr><th>Employee</th><th>Pay head</th><th>Given on</th><th className="num">Amount</th><th className="num">Instalment</th><th>From</th><th className="num">Recovered</th><th className="num">Outstanding</th><th /></tr></thead>
        <tbody>
          {(data ?? []).map((l) => (
            <tr key={l.id}>
              <td>{l.employee}</td><td>{l.payHead}</td><td>{fmtDate(l.givenOn)}</td><td className="num">{amt(l.amount)}</td><td className="num">{amt(l.instalment)}</td>
              <td>{fmtDate(l.recoverFrom)}</td><td className="num">{amt(l.recovered)}</td><td className="num total">{amt(l.outstanding)}</td>
              <td><button type="button" className="small" onClick={() => ask(`Delete the loan to ${l.employee}?`, () => api.deleteLoan(company.id, l.id).then(changed, (e) => setErrors(messages(e))))}>Delete</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 className="sub">New loan</h3>
      <div className="inline">
        <label>
          Employee
          <Picker options={(masters?.employees ?? []).map((e) => ({ id: e.id, name: e.name }))} value={f.employeeId} onChange={(v) => setF({ ...f, employeeId: v })} placeholder="Employee" />
        </label>
        <label>
          Recovered through
          <Picker options={loanHeads.map((h) => ({ id: h.id, name: h.name }))} value={f.payHeadId} onChange={(v) => setF({ ...f, payHeadId: v })} placeholder="a Loans and Advances pay head" />
        </label>
      </div>
      <div className="inline">
        <label>Given on<input type="date" required value={f.givenOn} onChange={(e) => setF({ ...f, givenOn: e.target.value })} aria-label="Given on" /></label>
        <label>Amount<input className="amount" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} aria-label="Loan amount" /></label>
        <label>Monthly instalment<input className="amount" required value={f.instalment} onChange={(e) => setF({ ...f, instalment: e.target.value })} aria-label="Instalment" /></label>
        <label>Recover from<input type="date" value={f.recoverFrom} onChange={(e) => setF({ ...f, recoverFrom: e.target.value })} aria-label="Recover from" /></label>
      </div>
      <label>Note<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} aria-label="Note" /></label>
      <p className="muted">Each Payroll voucher's Auto Fill deducts the instalment (or what is left) on the pay head until the loan is repaid; type another amount in the voucher to change a month's.</p>
      <Errors errors={errors} />
      <div className="actions"><button type="submit" className="primary"><b>Ctrl+A</b> Save</button></div>
      {confirm}
    </form>
  )
}

/** The old regime: an employee's declarations for the year (rent for the HRA exemption, Chapter VI-A). */
export function TaxDeclarationsForm() {
  const { company, period, changed } = useApp()
  const { data: masters } = usePayroll()
  const fy = `${period.from.slice(5) >= '04-01' ? period.from.slice(0, 4) : Number(period.from.slice(0, 4)) - 1}-04-01`
  const [employeeId, setEmployeeId] = useState<number | null>(null)
  const blank = { rentPaid: '', metro: false, sec80c: '', sec80d: '', sec80ccd1b: '', sec24b: '', other: '' }
  const [f, setF] = useState(blank)
  useEffect(() => {
    if (!employeeId) return
    api.declarations(company.id, employeeId, fy).then((d) => setF(d ? {
      rentPaid: rupees(d.rentPaid), metro: d.metro, sec80c: rupees(d.sec80c), sec80d: rupees(d.sec80d), sec80ccd1b: rupees(d.sec80ccd1b), sec24b: rupees(d.sec24b), other: rupees(d.other),
    } : blank))
  }, [employeeId, fy]) // eslint-disable-line react-hooks/exhaustive-deps
  const { errors, ok, submit } = useSubmit(async () => {
    if (!employeeId) throw new ApiError('Choose the employee', ['Choose the employee'])
    const p = (s: string) => money(s) ?? 0
    await api.setDeclarations(company.id, employeeId, fy, { rentPaid: p(f.rentPaid), metro: f.metro, sec80c: p(f.sec80c), sec80d: p(f.sec80d), sec80ccd1b: p(f.sec80ccd1b), sec24b: p(f.sec24b), other: p(f.other) })
    changed()
    return 'Declarations saved'
  })
  const emp = masters?.employees.find((e) => e.id === employeeId)
  const field = (k: Exclude<keyof typeof blank, 'metro'>, label: string) => (
    <label>{label}<input className="amount" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} aria-label={label} /></label>
  )
  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || <span className="muted">financial year from {fmtDate(fy)}</span>}>Income Tax Declarations</Title>
      <label>
        Employee
        <Picker options={(masters?.employees ?? []).map((e) => ({ id: e.id, name: e.name, hint: e.taxRegime === 'old' ? 'old regime' : 'new regime' }))} value={employeeId} onChange={setEmployeeId} placeholder="Employee" />
      </label>
      {emp && emp.taxRegime !== 'old' && <p className="errors-inline">{emp.name} is under the new regime, which allows none of these; they count once the employee is moved to the old regime.</p>}
      {field('rentPaid', 'Rent paid in the year (HRA exemption)')}
      <label className="check"><input type="checkbox" checked={f.metro} onChange={(e) => setF({ ...f, metro: e.target.checked })} /> Lives in a metro city (Delhi, Mumbai, Kolkata, Chennai): 50% of Basic, else 40%</label>
      {field('sec80c', '80C: PF, PPF, ELSS, life insurance, tuition fees (up to ₹1,50,000)')}
      {field('sec80d', '80D: health insurance (up to ₹1,00,000 with parents)')}
      {field('sec80ccd1b', '80CCD(1B): own NPS contribution (up to ₹50,000)')}
      {field('sec24b', '24(b): interest on a home loan (up to ₹2,00,000)')}
      {field('other', 'Other deductions (80E, 80G …)')}
      <p className="muted">The income tax pay head's projection for the year takes these off the salary, after the standard deduction; the payroll voucher works out the month's tax with them.</p>
      <Errors errors={errors} />
      <div className="actions"><button type="submit" className="primary"><b>Ctrl+A</b> Save</button></div>
    </form>
  )
}

/** Arrears of a back-dated salary revision: what each month's pay comes to now, against what was paid. */
export function ArrearsView() {
  const { company, period, version } = useApp()
  const { data, error } = useLoad(() => api.payrollArrears(company.id, period), [company.id, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={<span className="muted">{periodText(period.from, period.to)} · Alt+F2 months</span>}>Salary Arrears</Title>
      {!data.rows.length && <p className="muted">The salary details in force pay what was paid for these months: nothing is in arrears.</p>}
      {data.rows.length > 0 && (
        <table className="report">
          <thead><tr><th>Employee</th><th>Month</th><th className="num">Paid</th><th className="num">Due now</th><th className="num">Arrears</th></tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={`${r.id}/${r.month}`}><td>{r.name}</td><td>{r.month}</td><td className="num">{amt(r.paid)}</td><td className="num">{amt(r.due)}</td><td className="num">{amt(r.arrears)}</td></tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={4}>Total</td><td className="num total">{amt(data.rows.reduce((s, r) => s + r.arrears, 0))}</td></tr></tfoot>
        </table>
      )}
      <p className="muted">Pay them with the next Payroll voucher: pick the arrears pay head (an earnings head whose amount is typed) and these months, then Ctrl+F.</p>
    </div>
  )
}

const DUES = [{ id: 'pf', label: 'Provident Fund' }, { id: 'esi', label: "Employees' State Insurance" }, { id: 'pt', label: 'Professional Tax' }, { id: 'income-tax', label: 'Income tax (TDS on salary)' }, { id: 'nps', label: 'National Pension System' }]

/** Statutory Payment: what a period's payroll owes to PF, ESI, PT, TDS or NPS, paid with one Payment voucher. */
export function StatutoryPaymentView() {
  const { company, period, version, changed } = useApp()
  const [kind, setKind] = useState('pf')
  const { data, error } = useLoad(() => api.statutoryDues(company.id, period, kind), [company.id, period, version, kind])
  const { data: ledgers } = useLoad(() => api.ledgers(company.id, period), [company.id, version])
  const [bankId, setBankId] = useState<number | null>(null)
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const { errors, ok, submit } = useSubmit(async () => {
    if (!data?.total) throw new ApiError('Nothing is due for this period', ['Nothing is due for this period'])
    if (!bankId) throw new ApiError('Choose the bank or cash ledger it is paid from', ['Choose the bank or cash ledger it is paid from'])
    await api.postVoucher(company.id, {
      type: 'Payment', date, narration: `${DUES.find((d) => d.id === kind)!.label} for ${periodText(period.from, period.to)}`,
      entries: [...data.lines.filter((l) => l.due).map((l) => ({ ledgerId: l.ledgerId, amount: l.due })), { ledgerId: bankId, amount: -data.total }],
    } as never)
    changed()
    return `Paid ${amt(data.total)}`
  })
  if (error) return <Errors errors={[error]} />
  return (
    <form className="form wide" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || <span className="muted">{periodText(period.from, period.to)} · Ctrl+A posts the Payment</span>}>Statutory Payment</Title>
      <div className="inline">
        <label>
          Pay
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="What to pay">
            {DUES.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
        </label>
        {data && <span className="muted">due by {fmtDate(data.dueDate)}</span>}
      </div>
      {data && (
        <table className="report">
          <thead><tr><th>Pay head</th><th className="num">Booked</th><th className="num">Paid</th><th className="num">To pay</th></tr></thead>
          <tbody>
            {data.lines.map((l) => <tr key={l.ledgerId}><td>{l.name}</td><td className="num">{amt(l.booked)}</td><td className="num">{amt(l.paid)}</td><td className="num">{amt(l.due)}</td></tr>)}
          </tbody>
          <tfoot><tr><td colSpan={3}>Total</td><td className="num total">{amt(data.total)}</td></tr></tfoot>
        </table>
      )}
      {data?.challan && (
        <p className="muted">
          PF challan (TRRN): A/c 1 {amt(data.challan.ac1)} · A/c 2 {amt(data.challan.ac2)} · A/c 10 {amt(data.challan.ac10)} · A/c 21 {amt(data.challan.ac21)} · A/c 22 {amt(data.challan.ac22)}
        </p>
      )}
      <div className="inline">
        <label>
          Paid from
          <Picker options={(ledgers ?? []).filter((l) => l.primaryGroup === 'Current Assets' && /Bank|Cash/.test(l.group ?? '')).map((l) => ({ id: l.id, name: l.name, hint: l.group ?? '' }))}
            value={bankId} onChange={setBankId} placeholder="Bank" />
        </label>
        <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Payment date" /></label>
      </div>
      <Errors errors={errors} />
      <div className="actions"><button type="submit" className="primary"><b>Ctrl+A</b> Pay</button></div>
    </form>
  )
}

/** Alter a payroll master: pick it, then its form. */
export function PayrollPick({ kind }: { kind: 'employee' | 'employee-group' | 'attendance-type' | 'pay-head' }) {
  const { replace } = useApp()
  const { data } = usePayroll()
  const options =
    kind === 'employee' ? (data?.employees ?? []).map((e) => ({ id: e.id, name: e.name, hint: e.designation ?? '' }))
      : kind === 'employee-group' ? (data?.groups ?? []).map((g) => ({ id: g.id, name: g.name }))
        : kind === 'attendance-type' ? (data?.attendanceTypes ?? []).map((t) => ({ id: t.id, name: t.name, hint: kindText(t.kind) }))
          : (data?.payHeads ?? []).map((h) => ({ id: h.id, name: h.name, hint: h.payType }))
  const title = { employee: 'Employee', 'employee-group': 'Employee Group', 'attendance-type': 'Attendance/Production Type', 'pay-head': 'Pay Head' }[kind]
  return (
    <div className="form narrow">
      <Title>Alter {title}</Title>
      <label>
        {title}
        <Picker options={options} value={null} onChange={(id) => replace({ k: kind, id })} autoFocus />
      </label>
    </div>
  )
}

// ------------------------------------------------------------------ the Attendance voucher

export function AttendanceVoucher({ id }: { id?: number }) {
  const { company, period, changed, pop } = useApp()
  const { data } = usePayroll()
  const [date, setDate] = useState(period.to)
  const [narration, setNarration] = useState('')
  const [rows, setRows] = useState<{ employeeId: number | null; typeId: number | null; value: string }[]>([{ employeeId: null, typeId: null, value: '' }])
  const [version, setVersion] = useState<number | undefined>()
  const [number, setNumber] = useState<string | null>(null)
  useEffect(() => {
    if (!id) return
    api.voucher(company.id, id).then((v) => {
      setDate(v.date)
      setNarration(v.narration)
      setVersion(v.version)
      setNumber(v.docNo ?? String(v.number))
      setRows([...(v.attendance ?? []).map((a) => ({ employeeId: a.employeeId, typeId: a.typeId, value: qty(a.value) })), { employeeId: null, typeId: null, value: '' }])
    })
  }, [company.id, id])
  const fillAll = (typeId: number) => {
    const { from, to } = monthOf(date)
    const on = (data?.employees ?? []).filter((e) => e.dateOfJoining <= to && (!e.dateOfLeaving || e.dateOfLeaving >= from))
    setRows([...rows.filter((r) => r.employeeId), ...on.filter((e) => !rows.some((r) => r.employeeId === e.id && r.typeId === typeId)).map((e) => ({ employeeId: e.id, typeId, value: '' })),
      { employeeId: null, typeId: null, value: '' }])
  }
  const { errors, ok, submit } = useSubmit(async () => {
    const attendance = rows.filter((r) => r.employeeId && r.typeId && r.value.trim()).map((r) => ({ employeeId: r.employeeId!, typeId: r.typeId!, value: Math.round(Number(r.value) * 1000) }))
    if (attendance.some((a) => !Number.isFinite(a.value))) throw new ApiError('', ['Give the days, hours or units as a number'])
    const body = { type: 'Attendance' as const, date, narration, entries: [], attendance }
    if (id) await api.alterVoucher(company.id, id, { ...body, version: version! })
    else await api.postVoucher(company.id, body)
    changed()
    if (id) pop()
    else setRows([{ employeeId: null, typeId: null, value: '' }])
    return 'Attendance saved'
  })
  const typeOf = new Map((data?.attendanceTypes ?? []).map((t) => [t.id, t]))
  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={ok && <span className="ok">{ok}</span>}>Attendance {id ? `No. ${number} (alteration)` : ''}</Title>
      <div className="inline">
        <label>
          Date
          <DateInput label="Date" value={date} onChange={setDate} fyStart={company.fyStart} autoFocus />
        </label>
        <label>
          Fill every employee with
          <select value="" onChange={(e) => e.target.value && fillAll(Number(e.target.value))} aria-label="Fill every employee with">
            <option value="">Choose a type</option>
            {(data?.attendanceTypes ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
      </div>
      <table className="report">
        <thead><tr><th>Employee</th><th>Attendance / production type</th><th className="num">Value</th><th>Unit</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <Picker options={(data?.employees ?? []).map((e) => ({ id: e.id, name: e.name, hint: e.number ?? '' }))} value={r.employeeId}
                  onChange={(v) => setRows((x) => { const n = x.map((y, k) => (k === i ? { ...y, employeeId: v } : y)); return i === x.length - 1 ? [...n, { employeeId: null, typeId: null, value: '' }] : n })} />
              </td>
              <td>
                <select value={r.typeId ?? ''} onChange={(e) => setRows((x) => x.map((y, k) => (k === i ? { ...y, typeId: Number(e.target.value) || null } : y)))} aria-label={`Type ${i + 1}`}>
                  <option value="">Choose</option>
                  {(data?.attendanceTypes ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </td>
              <td className="num">
                <input className="amount" inputMode="decimal" value={r.value} aria-label={`Value ${i + 1}`} onChange={(e) => setRows((x) => x.map((y, k) => (k === i ? { ...y, value: e.target.value } : y)))} />
              </td>
              <td>{r.typeId ? typeOf.get(r.typeId)?.unit : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <label>
        Narration
        <input value={narration} onChange={(e) => setNarration(e.target.value)} aria-label="Narration" />
      </label>
      <Errors errors={errors} />
      <div className="actions"><button type="submit" className="primary"><b>Ctrl+A</b> Save</button></div>
    </form>
  )
}

// ------------------------------------------------------------------ the Payroll voucher

/**
 * Tally's Payroll voucher with Auto Fill (Ctrl+F): the period, the ledger the net pay is
 * credited to, and every employee's pay worked out from their salary details and attendance.
 * Amounts of user-defined pay heads are typed in the grid and the pay worked out again.
 */
export function PayrollVoucher({ id }: { id?: number }) {
  const { company, period, changed, pop, version: appVersion } = useApp()
  const { data } = usePayroll()
  const { data: ledgers } = useLoad(() => api.ledgers(company.id, period), [company.id, appVersion])
  // today, kept inside the period
  const today = new Date().toISOString().slice(0, 10)
  const start = today < period.from ? period.from : today > period.to ? period.to : today
  const [date, setDate] = useState(start)
  const [range, setRange] = useState(() => monthOf(start))
  const [payableId, setPayableId] = useState<number | null>(null)
  const [groupId, setGroupId] = useState<number | null>(null)
  const [narration, setNarration] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  // arrears of a back-dated revision, paid with this voucher on an earnings head
  const [arrears, setArrears] = useState<{ payHeadId: number | null; from: string; to: string }>({ payHeadId: null, from: '', to: '' })
  const [fill, setFill] = useState<PayrollFill | null>(null)
  const [fillErrors, setFillErrors] = useState<string[]>([])
  const [vVersion, setVVersion] = useState<number | undefined>()
  const [number, setNumber] = useState<string | null>(null)
  const active = useActive()

  // an alteration: the ledger credited with the net pay is the one that isn't a pay head or an employer's expense
  useEffect(() => {
    if (!id || !data) return
    api.voucher(company.id, id).then((v) => {
      setDate(v.date)
      setRange(monthOf(v.date))
      setNarration(v.narration)
      setVVersion(v.version)
      setNumber(v.docNo ?? String(v.number))
      const heads = new Set(data.payHeads.flatMap((h) => [h.id, h.expenseLedgerId ?? 0]))
      setPayableId(v.entries.find((e) => !heads.has(e.ledgerId) && e.amount < 0)?.ledgerId ?? null)
    })
  }, [company.id, id, data])
  useEffect(() => {
    if (!payableId && ledgers) setPayableId(ledgers.find((l) => /salary payable/i.test(l.name))?.id ?? null)
  }, [ledgers, payableId])

  const run = () => {
    if (!ledgers) return // still loading: the payable ledger is chosen once they are here
    if (!payableId) return setFillErrors(['Choose the ledger the net pay is credited to (Salary Payable)'])
    const typed = Object.entries(values).filter(([, v]) => v.trim()).map(([k, v]) => {
      const [employeeId, payHeadId] = k.split('/').map(Number)
      return { employeeId, payHeadId, amount: toPaise(v) }
    })
    const withArrears = arrears.payHeadId && arrears.from && arrears.to ? { arrears: { payHeadId: arrears.payHeadId, from: arrears.from, to: arrears.to } } : {}
    api.payrollFill(company.id, { ...range, date, payableLedgerId: payableId, groupId, values: typed, voucherId: id, ...withArrears })
      .then((r) => (setFill(r), setFillErrors([])), (e) => setFillErrors(messages(e)))
  }
  const runRef = useRef(run)
  runRef.current = run
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        runRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  const { errors, ok, submit } = useSubmit(async () => {
    if (!fill) throw new ApiError('', ['Auto Fill (Ctrl+F) first'])
    const bad = fill.employees.filter((e) => e.errors.length)
    if (bad.length) throw new ApiError('', bad.map((e) => `${e.name}: ${e.errors.join('; ')}`))
    if (!fill.entries.length) throw new ApiError('', ['Nobody is paid for this period'])
    const body = { type: 'Payroll' as const, date, narration: narration || `Salary for ${periodText(range.from, range.to)}`, entries: fill.entries }
    if (id) await api.alterVoucher(company.id, id, { ...body, version: vVersion! })
    else await api.postVoucher(company.id, body)
    changed()
    if (id) pop()
    else {
      setFill(null)
      setValues({})
      setNarration('')
    }
    return `Payroll for ${periodText(range.from, range.to)} saved`
  })
  const heads = new Map((data?.payHeads ?? []).map((h) => [h.id, h]))
  const columns = fill?.heads.slice().sort((a, b) => ['earning', 'deduction', 'employer'].indexOf(sideOf(a.payType)) - ['earning', 'deduction', 'employer'].indexOf(sideOf(b.payType))) ?? []
  const userHeads = (data?.payHeads ?? []).filter((h) => h.calculation === 'user' && h.statutory === null)
  const order = (t: PayType) => ['earning', 'deduction', 'employer'].indexOf(sideOf(t))
  const cols = [...columns, ...userHeads.filter((h) => !columns.some((c) => c.id === h.id))].sort((a, b) => order(a.payType) - order(b.payType))
  return (
    <form className="form wide" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || <span className="muted">Ctrl+F Auto Fill</span>}>Payroll {id ? `No. ${number} (alteration)` : ''}</Title>
      <div className="inline">
        <label>
          Date
          <DateInput label="Date" value={date} onChange={(d) => (setDate(d), setRange(monthOf(d)))} fyStart={company.fyStart} autoFocus />
        </label>
        <label>
          Pay period from
          <DateInput label="Pay period from" value={range.from} onChange={(d) => setRange({ ...range, from: d })} fyStart={company.fyStart} />
        </label>
        <label>
          to
          <DateInput label="Pay period to" value={range.to} onChange={(d) => setRange({ ...range, to: d })} fyStart={company.fyStart} />
        </label>
      </div>
      <div className="inline">
        <label>
          Net pay credited to
          <Picker options={(ledgers ?? []).filter((l) => l.primaryGroup !== null && !heads.has(l.id)).map((l) => ({ id: l.id, name: l.name, hint: l.group ?? '' }))}
            value={payableId} onChange={setPayableId} placeholder="Salary Payable" />
        </label>
        <label>
          Employee group
          <Picker options={[{ id: 0, name: 'All employees' }, ...(data?.groups ?? []).map((g) => ({ id: g.id, name: g.name }))]} value={groupId ?? 0} onChange={(v) => setGroupId(v || null)} />
        </label>
      </div>
      <div className="inline">
        <label>
          Arrears paid on
          <Picker options={[{ id: 0, name: 'No arrears' }, ...(data?.payHeads ?? []).filter((h) => h.payType === 'Earnings for Employees' && h.calculation === 'user').map((h) => ({ id: h.id, name: h.name }))]}
            value={arrears.payHeadId ?? 0} onChange={(v) => setArrears({ ...arrears, payHeadId: v || null })} />
        </label>
        {arrears.payHeadId && (
          <>
            <label>
              for months from
              <input type="date" value={arrears.from} onChange={(e) => setArrears({ ...arrears, from: e.target.value })} aria-label="Arrears from" />
            </label>
            <label>
              to
              <input type="date" value={arrears.to} onChange={(e) => setArrears({ ...arrears, to: e.target.value })} aria-label="Arrears to" />
            </label>
          </>
        )}
      </div>
      <div className="actions">
        <button type="button" onClick={run}><b>Ctrl+F</b> Auto Fill</button>
      </div>
      <Errors errors={fillErrors} />
      {fill && (
        <table className="report">
          <thead>
            <tr>
              <th>Employee</th>
              <th className="num">Days</th>
              {cols.map((c) => <th key={c.id} className="num">{c.name}</th>)}
              <th className="num">Net pay</th>
            </tr>
          </thead>
          <tbody>
            {fill.employees.map((e) => (
              <tr key={e.id}>
                <td>{e.name}{e.errors.length ? <div className="errors-inline small">{e.errors.join('; ')}</div> : null}</td>
                <td className="num">{e.payableDays}</td>
                {cols.map((c) => {
                  const a = e.lines.find((l) => l.payHeadId === c.id)?.amount ?? 0
                  const user = heads.get(c.id)?.calculation === 'user' && !heads.get(c.id)?.statutory
                  return (
                    <td key={c.id} className="num">
                      {user ? (
                        <input className="amount" inputMode="decimal" aria-label={`${e.name} ${c.name}`} value={values[`${e.id}/${c.id}`] ?? (a ? String(a / 100) : '')}
                          onChange={(ev) => setValues({ ...values, [`${e.id}/${c.id}`]: ev.target.value })} onBlur={run} />
                      ) : amt(a)}
                    </td>
                  )
                })}
                <td className="num"><b>{amt(e.net)}</b></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>Total</td>
              {cols.map((c) => <td key={c.id} className="num total">{amt(fill.employees.reduce((s, e) => s + (e.lines.find((l) => l.payHeadId === c.id)?.amount ?? 0), 0))}</td>)}
              <td className="num total">{amt(fill.employees.reduce((s, e) => s + e.net, 0))}</td>
            </tr>
          </tfoot>
        </table>
      )}
      {fill && (
        <details>
          <summary>Accounting entries ({fill.entries.length})</summary>
          <table className="report">
            <tbody>
              {fill.entries.map((e, i) => (
                <tr key={i}>
                  <td>{ledgers?.find((l) => l.id === e.ledgerId)?.name}</td>
                  <td className="num">{e.amount > 0 ? formatINR(e.amount) : ''}</td>
                  <td className="num">{e.amount < 0 ? formatINR(-e.amount) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <label>
        Narration
        <input value={narration} onChange={(e) => setNarration(e.target.value)} placeholder={`Salary for ${periodText(range.from, range.to)}`} aria-label="Narration" />
      </label>
      <Errors errors={errors} />
      <div className="actions"><button type="submit" className="primary"><b>Ctrl+A</b> Save</button></div>
    </form>
  )
}

// ------------------------------------------------------------------ reports

export function PaySheetView() {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.paySheet(company.id, period), [company.id, period, version])
  useAltJ(data ? () => save(`PaySheet_${period.from}_${period.to}.csv`, csv([
    ['Employee', ...data.columns.map((c) => c.name), 'Earnings', 'Deductions', 'Net pay'],
    ...data.rows.map((r) => [r.name, ...data.columns.map((c) => ((r.amounts[c.id] ?? 0) / 100).toFixed(2)), (r.earnings / 100).toFixed(2), (r.deductions / 100).toFixed(2), (r.net / 100).toFixed(2)]),
  ]), 'text/csv') : null)
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const side = (s: string) => data.columns.filter((c) => c.side === s)
  return (
    <div>
      <Title right={<span className="muted">{periodText(period.from, period.to)} · Enter a payslip · Alt+J CSV</span>}>Pay Sheet</Title>
      <table className="report">
        <thead>
          <tr>
            <th rowSpan={2}>Employee</th>
            {side('earning').length > 0 && <th colSpan={side('earning').length + 1} className="num">Earnings</th>}
            {side('deduction').length > 0 && <th colSpan={side('deduction').length + 1} className="num">Deductions</th>}
            <th rowSpan={2} className="num">Net pay</th>
            {side('employer').length > 0 && <th colSpan={side('employer').length} className="num">Employer</th>}
          </tr>
          <tr>
            {side('earning').map((c) => <th key={c.id} className="num">{c.name}</th>)}
            {side('earning').length > 0 && <th className="num">Total</th>}
            {side('deduction').map((c) => <th key={c.id} className="num">{c.name}</th>)}
            {side('deduction').length > 0 && <th className="num">Total</th>}
            {side('employer').map((c) => <th key={c.id} className="num">{c.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.employeeId} className="clickable" tabIndex={0} onClick={() => push({ k: 'payslip', employeeId: r.employeeId })}
              onKeyDown={(e) => e.key === 'Enter' && push({ k: 'payslip', employeeId: r.employeeId })}>
              <td>{r.name}</td>
              {side('earning').map((c) => <td key={c.id} className="num">{amt(r.amounts[c.id] ?? 0)}</td>)}
              {side('earning').length > 0 && <td className="num">{amt(r.earnings)}</td>}
              {side('deduction').map((c) => <td key={c.id} className="num">{amt(r.amounts[c.id] ?? 0)}</td>)}
              {side('deduction').length > 0 && <td className="num">{amt(r.deductions)}</td>}
              <td className="num"><b>{amt(r.net)}</b></td>
              {side('employer').map((c) => <td key={c.id} className="num">{amt(r.amounts[c.id] ?? 0)}</td>)}
            </tr>
          ))}
          {!data.rows.length && <tr className="muted"><td colSpan={2 + data.columns.length}>No salary booked in this period (Payroll voucher, F10)</td></tr>}
        </tbody>
        {data.rows.length > 0 && (
          <tfoot>
            <tr>
              <td>Total</td>
              {side('earning').map((c) => <td key={c.id} className="num total">{amt(data.totals[c.id])}</td>)}
              {side('earning').length > 0 && <td className="num total">{amt(data.earnings)}</td>}
              {side('deduction').map((c) => <td key={c.id} className="num total">{amt(data.totals[c.id])}</td>)}
              {side('deduction').length > 0 && <td className="num total">{amt(data.deductions)}</td>}
              <td className="num total">{amt(data.net)}</td>
              {side('employer').map((c) => <td key={c.id} className="num total">{amt(data.totals[c.id])}</td>)}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}

export function PayslipView({ employeeId: initial }: { employeeId?: number }) {
  const { company, period, version } = useApp()
  const { data: masters } = usePayroll()
  const [employeeId, setEmployeeId] = useState<number | null>(initial ?? null)
  const { data, error } = useLoad(() => (employeeId ? api.payslip(company.id, employeeId, period) : Promise.resolve(null)), [company.id, employeeId, period, version])
  if (!employeeId)
    return (
      <div className="form narrow">
        <Title>Payslip</Title>
        <label>
          Employee
          <Picker options={(masters?.employees ?? []).map((e) => ({ id: e.id, name: e.name, hint: e.number ?? '' }))} value={null} onChange={setEmployeeId} autoFocus />
        </label>
      </div>
    )
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const e = data.employee
  const rows = Math.max(data.earnings.length, data.deductions.length)
  return (
    <div className="payslip">
      <Title right={<span className="muted">Alt+P print · Alt+M e-mail</span>}>Payslip: {periodText(data.from, data.to)}</Title>
      <p><b>{data.company}</b></p>
      <table className="report">
        <tbody>
          <tr><td>Employee</td><td><b>{e.name}</b>{e.number ? ` (${e.number})` : ''}</td><td>Designation</td><td>{e.designation ?? ''}</td></tr>
          <tr><td>Group</td><td>{data.group ?? ''}</td><td>Date of joining</td><td>{fmtDate(e.dateOfJoining)}</td></tr>
          <tr><td>PAN</td><td>{e.pan ?? ''}</td><td>UAN</td><td>{e.uan ?? ''}</td></tr>
          <tr><td>Bank</td><td>{[e.bankName, e.accountNo].filter(Boolean).join(' · ')}</td><td>ESI IP No.</td><td>{e.esiNumber ?? ''}</td></tr>
          {data.attendance.length > 0 && (
            <tr><td>Attendance</td><td colSpan={3}>{data.attendance.map((a) => `${a.name}: ${qty(a.value)} ${a.unit}`).join(' · ')}</td></tr>
          )}
        </tbody>
      </table>
      <table className="report">
        <thead><tr><th>Earnings</th><th className="num">Amount</th><th>Deductions</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {Array.from({ length: rows }, (_, i) => (
            <tr key={i}>
              <td>{data.earnings[i]?.name ?? ''}</td>
              <td className="num">{data.earnings[i] ? formatINR(data.earnings[i].amount) : ''}</td>
              <td>{data.deductions[i]?.name ?? ''}</td>
              <td className="num">{data.deductions[i] ? formatINR(data.deductions[i].amount) : ''}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td>Total earnings</td><td className="num total">{formatINR(data.totalEarnings)}</td><td>Total deductions</td><td className="num total">{formatINR(data.totalDeductions)}</td></tr>
          <tr><td colSpan={2} /><td><b>Net pay</b></td><td className="num total"><b>{formatINR(data.net)}</b></td></tr>
        </tfoot>
      </table>
      {data.employer.length > 0 && <p className="muted">Employer's contributions: {data.employer.map((l) => `${l.name} ${formatINR(l.amount)}`).join(' · ')}</p>}
    </div>
  )
}

export function AttendanceSheetView() {
  const { company, period, version } = useApp()
  const { data, error } = useLoad(() => api.attendanceSheet(company.id, period), [company.id, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={<span className="muted">{periodText(period.from, period.to)}</span>}>Attendance Sheet</Title>
      <table className="report">
        <thead><tr><th>Employee</th>{data.columns.map((c) => <th key={c.id} className="num">{c.name} ({c.unit})</th>)}</tr></thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.employeeId}><td>{r.name}</td>{data.columns.map((c) => <td key={c.id} className="num">{r.values[c.id] ? qty(r.values[c.id]) : ''}</td>)}</tr>
          ))}
          {!data.rows.length && <tr className="muted"><td colSpan={1 + data.columns.length}>No attendance recorded in this period (Attendance voucher, F10)</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

export function PayrollRegisterView() {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.payrollRegister(company.id, period), [company.id, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const sum = (k: 'earnings' | 'deductions' | 'employer' | 'net') => data.vouchers.reduce((s, v) => s + v[k], 0)
  return (
    <div>
      <Title right={<span className="muted">{periodText(period.from, period.to)} · Enter opens the voucher</span>}>Payroll Register</Title>
      <table className="report">
        <thead><tr><th>Date</th><th>Vch No.</th><th>Narration</th><th className="num">Employees</th><th className="num">Earnings</th><th className="num">Deductions</th><th className="num">Net pay</th><th className="num">Employer</th></tr></thead>
        <tbody>
          {data.vouchers.map((v) => (
            <tr key={v.id} className={v.cancelled ? 'muted' : 'clickable'} tabIndex={0} onClick={() => !v.cancelled && push({ k: 'voucher', type: 'Payroll', id: v.id })}
              onKeyDown={(e) => e.key === 'Enter' && !v.cancelled && push({ k: 'voucher', type: 'Payroll', id: v.id })}>
              <td>{fmtDate(v.date)}</td><td>{v.docNo}</td><td>{v.cancelled ? '(cancelled)' : v.narration}</td><td className="num">{v.employees || ''}</td>
              <td className="num">{amt(v.earnings)}</td><td className="num">{amt(v.deductions)}</td><td className="num">{amt(v.net)}</td><td className="num">{amt(v.employer)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td colSpan={4}>Total</td><td className="num total">{amt(sum('earnings'))}</td><td className="num total">{amt(sum('deductions'))}</td><td className="num total">{amt(sum('net'))}</td><td className="num total">{amt(sum('employer'))}</td></tr>
        </tfoot>
      </table>
    </div>
  )
}

export function PfView() {
  const { company, period, version } = useApp()
  const { data, error } = useLoad(() => api.pfReport(company.id, period), [company.id, period, version])
  useAltJ(data ? () => save(`ECR_${period.from.slice(0, 7)}.txt`, data.ecr + '\n') : null)
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={<span className="muted">{periodText(period.from, period.to)} · Alt+J ECR file</span>}>Provident Fund</Title>
      <Errors errors={data.problems} />
      <table className="report">
        <thead><tr><th>UAN</th><th>Member</th><th className="num">Gross</th><th className="num">EPF wages</th><th className="num">EPS wages</th><th className="num">EPF (employee)</th><th className="num">EPS</th><th className="num">EPF (employer)</th><th className="num">EDLI</th><th className="num">Admin</th><th className="num">NCP days</th></tr></thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.employeeId}><td>{r.uan ?? ''}</td><td>{r.name}</td><td className="num">{amt(r.gross)}</td><td className="num">{amt(r.epfWages)}</td><td className="num">{amt(r.epsWages)}</td>
              <td className="num">{amt(r.epf)}</td><td className="num">{amt(r.eps)}</td><td className="num">{amt(r.epfEmployer)}</td><td className="num">{amt(r.edli)}</td><td className="num">{amt(r.admin)}</td><td className="num">{r.ncpDays || ''}</td></tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td colSpan={3}>Total</td><td className="num total">{amt(data.totals.epfWages)}</td><td /><td className="num total">{amt(data.totals.epf)}</td><td className="num total">{amt(data.totals.eps)}</td>
            <td className="num total">{amt(data.totals.epfEmployer)}</td><td className="num total">{amt(data.totals.edli)}</td><td className="num total">{amt(data.totals.admin)}</td><td /></tr>
        </tfoot>
      </table>
      <p className="muted">The ECR file is the EPFO's electronic challan-cum-return text (fields separated by #~#), for upload on the employer portal.</p>
    </div>
  )
}

export function EsiView() {
  const { company, period, version } = useApp()
  const { data, error } = useLoad(() => api.esiReport(company.id, period), [company.id, period, version])
  useAltJ(data ? () => save(`ESI_${period.from.slice(0, 7)}.csv`, csv([
    ['IP Number', 'IP Name', 'No of Days for which wages paid/payable during the month', 'Total Monthly Wages', 'Reason Code for Zero workings days', 'Last Working Day'],
    ...data.rows.map((r) => [r.ipNumber ?? '', r.name, r.days, (r.wages / 100).toFixed(2), '', '']),
  ]), 'text/csv') : null)
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={<span className="muted">{periodText(period.from, period.to)} · Alt+J monthly contribution file</span>}>Employees' State Insurance</Title>
      <Errors errors={data.problems} />
      <table className="report">
        <thead><tr><th>IP number</th><th>Insured person</th><th className="num">Days</th><th className="num">Wages</th><th className="num">Employee (0.75%)</th><th className="num">Employer (3.25%)</th></tr></thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.employeeId}><td>{r.ipNumber ?? ''}</td><td>{r.name}</td><td className="num">{r.days}</td><td className="num">{amt(r.wages)}</td><td className="num">{amt(r.employee)}</td><td className="num">{amt(r.employer)}</td></tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td colSpan={3}>Total</td><td className="num total">{amt(data.totals.wages)}</td><td className="num total">{amt(data.totals.employee)}</td><td className="num total">{amt(data.totals.employer)}</td></tr>
        </tfoot>
      </table>
    </div>
  )
}

export function ProfessionalTaxView() {
  const { company, period, version } = useApp()
  const { data, error } = useLoad(() => api.ptReport(company.id, period), [company.id, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={<span className="muted">{periodText(period.from, period.to)}</span>}>Professional Tax</Title>
      <table className="report">
        <thead><tr><th>Month</th><th>Employee</th><th className="num">Gross salary</th><th className="num">Professional tax</th></tr></thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={`${r.employeeId}/${r.month}`}><td>{MONTHS[Number(r.month.slice(5)) - 1]} {r.month.slice(0, 4)}</td><td>{r.name}</td><td className="num">{amt(r.gross)}</td><td className="num">{amt(r.pt)}</td></tr>
          ))}
        </tbody>
        <tfoot><tr><td colSpan={3}>Total</td><td className="num total">{amt(data.total)}</td></tr></tfoot>
      </table>
    </div>
  )
}

export function NpsView() {
  const { company, period, version } = useApp()
  const { data, error } = useLoad(() => api.npsReport(company.id, period), [company.id, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={<span className="muted">{periodText(period.from, period.to)}</span>}>National Pension System</Title>
      <Errors errors={data.problems} />
      <table className="report">
        <thead><tr><th>PRAN</th><th>Subscriber</th><th className="num">Employee</th><th className="num">Employer</th><th className="num">Total</th></tr></thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.employeeId}><td>{r.pran ?? ''}</td><td>{r.name}</td><td className="num">{amt(r.employee)}</td><td className="num">{amt(r.employer)}</td><td className="num">{amt(r.employee + r.employer)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Income tax on salary for the financial year: the projection per employee, Form 16 Part B on Enter, and Form 24Q's Annexure I (Alt+J) for a quarter. */
export function SalaryTaxView() {
  const { company, period, version } = useApp()
  const fy = `${period.to.slice(5) >= '04-01' ? period.to.slice(0, 4) : Number(period.to.slice(0, 4)) - 1}-04-01`
  const { data, error } = useLoad(() => api.salaryTax(company.id, fy, period.to), [company.id, fy, period.to, version])
  const [open, setOpen] = useState<number | null>(null)
  const quarterOf = (month: string) => {
    const m = Number(month.slice(5))
    return m >= 4 && m <= 6 ? 1 : m <= 9 && m >= 7 ? 2 : m >= 10 ? 3 : 4
  }
  const q = quarterOf(period.to.slice(0, 7))
  useAltJ(data ? () => save(`24Q_Q${q}_${fy.slice(0, 4)}.csv`, csv([
    ['Employee reference', 'PAN of employee', 'Name of employee', 'Section', 'Date of payment/credit', 'Amount paid/credited', 'TDS', 'Date of deduction'],
    ...data.rows.flatMap((r) => r.months.filter((m) => quarterOf(m.month) === q).map((m) => [r.employeeId, r.pan ?? 'PANNOTAVBL', r.name, '192',
      `${m.date.slice(8)}/${m.date.slice(5, 7)}/${m.date.slice(0, 4)}`, (m.taxable / 100).toFixed(2), (m.tax / 100).toFixed(2), `${m.date.slice(8)}/${m.date.slice(5, 7)}/${m.date.slice(0, 4)}`])),
  ]), 'text/csv') : null)
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={<span className="muted">FY {fy.slice(0, 4)}-{String(Number(fy.slice(2, 4)) + 1).padStart(2, '0')} as of {fmtDate(period.to)} · Enter Form 16 Part B · Alt+J Form 24Q Q{q}</span>}>
        Income Tax on Salary
      </Title>
      <Errors errors={data.problems} />
      <table className="report">
        <thead><tr><th>Employee</th><th>PAN</th><th>Regime</th><th className="num">Taxable so far</th><th className="num">Projected</th><th className="num">Taxable income</th><th className="num">Tax for the year</th><th className="num">Deducted</th><th className="num">Balance</th></tr></thead>
        <tbody>
          {data.rows.map((r) => (
            <Fragment key={r.employeeId}>
              <tr className="clickable" tabIndex={0} onClick={() => setOpen(open === r.employeeId ? null : r.employeeId)}
                onKeyDown={(e) => e.key === 'Enter' && setOpen(open === r.employeeId ? null : r.employeeId)}>
                <td>{r.name}</td><td>{r.pan ?? ''}</td><td>{r.regime}</td><td className="num">{amt(r.taxable)}</td><td className="num">{amt(r.projected)}</td>
                <td className="num">{amt(r.taxableIncome)}</td><td className="num">{amt(r.tax)}</td><td className="num">{amt(r.deducted)}</td><td className="num">{amt(r.balance)}</td>
              </tr>
              {open === r.employeeId && (
                <tr className="sub-row">
                  <td colSpan={9}>
                    <b>Form 16 Part B (projection)</b>
                    <table className="report">
                      <tbody>
                        <tr><td>1. Gross salary (section 17(1))</td><td className="num">{formatINR(r.projected)}</td></tr>
                        <tr><td>2. Less: standard deduction (section 16(ia))</td><td className="num">{formatINR(r.standardDeduction)}</td></tr>
                        <tr><td>3. Total taxable income</td><td className="num">{formatINR(r.taxableIncome)}</td></tr>
                        <tr><td>4. Tax on total income, with rebate u/s 87A, surcharge and health and education cess</td><td className="num">{formatINR(r.tax)}</td></tr>
                        <tr><td>5. Tax deducted at source (section 192)</td><td className="num">{formatINR(r.deducted)}</td></tr>
                        <tr><td>6. Tax payable / (refundable)</td><td className="num">{formatINR(r.balance)}</td></tr>
                      </tbody>
                    </table>
                    <span className="muted">{r.months.map((m) => `${MONTHS[Number(m.month.slice(5)) - 1]}: ${formatINR(m.taxable)} paid, ${formatINR(m.tax)} TDS`).join(' · ')}</span>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      <p className="muted">Slabs of FY 2025-26 onwards. Exemptions and Chapter VI-A deductions under the old regime are not declared here, so its projection is before them.</p>
    </div>
  )
}

export function GratuityView() {
  const { company, period, version } = useApp()
  const { data, error } = useLoad(() => api.gratuity(company.id, period.to), [company.id, period.to, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={<span className="muted">as of {fmtDate(period.to)}</span>}>Gratuity</Title>
      {!data.payHead && <p className="muted">Create a pay head of type Gratuity, computed on the wages it is paid on (Basic and DA), to value it.</p>}
      <table className="report">
        <thead><tr><th>Employee</th><th>Joined</th><th>Left</th><th className="num">Years of service</th><th className="num">Last month's wages</th><th className="num">Gratuity</th><th className="num">Payable now</th></tr></thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.employeeId}><td>{r.name}</td><td>{fmtDate(r.joining)}</td><td>{r.leaving ? fmtDate(r.leaving) : ''}</td><td className="num">{r.years}</td>
              <td className="num">{amt(r.wages)}</td><td className="num">{amt(r.amount)}</td><td className="num">{r.eligible ? amt(r.payable) : <span className="muted">under 5 years</span>}</td></tr>
          ))}
        </tbody>
        <tfoot><tr><td colSpan={5}>Provision (all employees) / payable</td><td className="num total">{amt(data.provision)}</td><td className="num total">{amt(data.total)}</td></tr></tfoot>
      </table>
      <p className="muted">15 days' wages (at 26 working days a month) for each completed year of service, more than six months counting as a year; due after five years; at most ₹20 lakh.</p>
    </div>
  )
}

