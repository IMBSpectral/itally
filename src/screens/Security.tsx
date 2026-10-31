import { useEffect, useState, type FormEvent } from 'react'
import { useApp } from '../App'
import { api, ApiError, ROLES, setSession, type Company, type Role, type User } from '../api'
import { Errors, Title, enterAdvances, useActive, useConfirm, useLoad } from '../ui'
import { messages, useDeleteKey, useSubmit } from './Masters'

/**
 * Name and password for a secured company: when it is opened, and again if the session runs
 * out mid-work (then it sits over the open screens, so nothing typed is lost).
 */
export function SignIn({ company, over, onDone, onCancel }: { company: Company; over?: boolean; onDone: (u: User) => void; onCancel: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  async function submit(e: FormEvent) {
    e.preventDefault()
    setErrors([])
    try {
      const r = await api.login(company.id, username, password)
      setSession(company.id, r.token)
      onDone(r.user)
    } catch (err) {
      setPassword('')
      setErrors(messages(err))
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onCancel])
  return (
    <div className={`sign-in ${over ? 'over' : ''}`}>
      <form className="form narrow" onSubmit={submit} onKeyDown={enterAdvances}>
        <Title>{company.name}</Title>
        <p className="muted">{over ? 'Your session has ended; sign in again to carry on (Esc closes the company).' : 'This company has users and passwords. Esc goes back.'}</p>
        <label>
          User name
          <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" aria-label="User name" />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" aria-label="Password" />
        </label>
        <Errors errors={errors} />
        <div className="actions">
          <button type="submit" className="primary">
            <b>Enter</b> Sign in
          </button>
        </div>
      </form>
    </div>
  )
}

/** Users and Passwords (Alt+K → U): the company's users; Enter alters one, C creates one. */
export function UsersView() {
  const { company, user, version, push } = useApp()
  const active = useActive()
  const { data, error } = useLoad(() => api.users(company.id), [company.id, version, user?.id])
  const { data: levels } = useLoad(() => (data?.length ? api.securityLevels(company.id) : Promise.resolve([])), [company.id, version, data?.length])
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.altKey && !(e.target as HTMLElement).closest('input, select, textarea')) {
        e.preventDefault()
        push({ k: 'user' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  if (error) return <Errors errors={[error]} />
  return (
    <div>
      <Title right={<span className="muted">C create · Enter alter</span>}>Users and Passwords</Title>
      {data && data.length === 0 && (
        <p className="muted">
          This company is open to anyone using this app. Creating the first user, the Owner (press C), secures it: from then on it asks for a name and
          password, each user's role decides what they can do, and the Edit Log names who made each change.
        </p>
      )}
      {data && data.length > 0 && (
        <table className="report">
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Can</th>
            </tr>
          </thead>
          <tbody>
            {data.map((u) => (
              <tr key={u.id} className="clickable" onClick={() => push({ k: 'user', id: u.id })}>
                <td>
                  {u.username}
                  {u.id === user?.id ? ' (you)' : ''}
                </td>
                <td>{levels?.find((l) => l.id === u.levelId)?.name ?? u.role}</td>
                <td className="muted">{u.levelId ? `${u.role}, less what the level takes away` : CAN[u.role]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && data.length > 0 && <SecurityLevels />}
    </div>
  )
}

const REPORTS: [string, string][] = [
  ['balance-sheet', 'Balance Sheet'], ['profit-loss', 'Profit & Loss A/c'], ['trial-balance', 'Trial Balance'], ['cash-flow', 'Cash Flow'], ['funds-flow', 'Funds Flow'],
  ['ratios', 'Ratio Analysis'], ['stock-summary', 'Stock Summary'], ['gstr1', 'GSTR-1'], ['gstr3b', 'GSTR-3B'], ['gstr9', 'GSTR-9'], ['tds-computation', 'TDS Computation'],
  ['pay-sheet', 'Pay Sheet'], ['payslip', 'Payslip'], ['salary-tax', 'Income Tax on Salary'], ['budget-variance', 'Budget Variance'], ['bills', 'Outstandings'],
]
const LEVEL_TYPES = ['Sales', 'Purchase', 'Payment', 'Receipt', 'Contra', 'Journal', 'Credit Note', 'Debit Note', 'Payroll', 'Stock Journal', 'Manufacturing Journal', 'Physical Stock']

/** Security levels of the company's own: a role less voucher types and reports, and a limit on back-dating. */
function SecurityLevels() {
  const { company, version, changed } = useApp()
  const { data } = useLoad(() => api.securityLevels(company.id), [company.id, version])
  const blank = { name: '', baseRole: 'Data Entry' as Exclude<Role, 'Owner'>, deniedVouchers: [] as string[], deniedReports: [] as string[], backDays: '' }
  const [f, setF] = useState(blank)
  const [editing, setEditing] = useState<number | null>(null)
  const { errors, setErrors, ok, submit } = useSubmit(async () => {
    const body = { ...f, backDays: f.backDays.trim() ? Number(f.backDays) : null }
    if (editing) await api.alterSecurityLevel(company.id, editing, body)
    else await api.createSecurityLevel(company.id, body)
    changed()
    setF(blank)
    setEditing(null)
    return `Security level "${body.name}" saved`
  })
  const toggle = (k: 'deniedVouchers' | 'deniedReports', v: string) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] })
  return (
    <form className="form wide" onSubmit={submit}>
      <h3 className="sub">Security levels</h3>
      {(data ?? []).length > 0 && (
        <table className="report">
          <thead><tr><th>Level</th><th>Based on</th><th>Not allowed</th><th className="num">Days back</th><th /></tr></thead>
          <tbody>
            {data!.map((l) => (
              <tr key={l.id}>
                <td>{l.name}</td><td>{l.baseRole}</td>
                <td className="muted">{[...l.deniedVouchers, ...l.deniedReports.map((r) => REPORTS.find((x) => x[0] === r)?.[1] ?? r)].join(', ') || 'nothing more'}</td>
                <td className="num">{l.backDays ?? ''}</td>
                <td>
                  <button type="button" className="small" onClick={() => (setEditing(l.id), setF({ ...l, backDays: l.backDays == null ? '' : String(l.backDays) }))}>Alter</button>{' '}
                  <button type="button" className="small" onClick={() => api.deleteSecurityLevel(company.id, l.id).then(changed, (e) => setErrors(messages(e)))}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="inline">
        <label>Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Billing Clerk" aria-label="Level name" /></label>
        <label>
          Based on
          <select value={f.baseRole} onChange={(e) => setF({ ...f, baseRole: e.target.value as Exclude<Role, 'Owner'> })} aria-label="Based on">
            {(['Accountant', 'Data Entry', 'Viewer'] as const).map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
        <label>Days back a voucher may be dated<input className="amount" value={f.backDays} onChange={(e) => setF({ ...f, backDays: e.target.value })} placeholder="any" aria-label="Days back" /></label>
      </div>
      <fieldset>
        <legend>Voucher types it may not enter or alter</legend>
        {LEVEL_TYPES.map((t) => <label key={t} className="check"><input type="checkbox" checked={f.deniedVouchers.includes(t)} onChange={() => toggle('deniedVouchers', t)} /> {t}</label>)}
      </fieldset>
      <fieldset>
        <legend>Reports it may not see</legend>
        {REPORTS.map(([k, label]) => <label key={k} className="check"><input type="checkbox" checked={f.deniedReports.includes(k)} onChange={() => toggle('deniedReports', k)} /> {label}</label>)}
      </fieldset>
      <Errors errors={errors} />
      {ok && <span className="ok">{ok}</span>}
      <div className="actions"><button type="submit">{editing ? 'Save the level' : 'Create the level'}</button></div>
    </form>
  )
}

const CAN: Record<Role, string> = {
  Owner: 'everything, including users and passwords',
  Accountant: 'everything except users and passwords',
  'Data Entry': 'see everything; create vouchers and masters (no alteration or deletion)',
  Viewer: 'see everything; change nothing',
}

/** Create or alter a user. The first user is the Owner, and creating them signs you in as them. */
export function UserForm({ id }: { id?: number }) {
  const { company, user, changed, pop, signedIn } = useApp()
  const { data: users } = useLoad(() => api.users(company.id), [company.id])
  const first = users !== null && users.length === 0
  const [username, setUsername] = useState('')
  const [role, setRole] = useState<Role>('Accountant')
  const [levelId, setLevelId] = useState<number | null>(null)
  const { data: levels } = useLoad(() => (users?.length ? api.securityLevels(company.id) : Promise.resolve([])), [company.id, users?.length])
  const level = levels?.find((l) => l.id === levelId)
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [confirm, ask] = useConfirm()
  useEffect(() => {
    const u = id && users?.find((x) => x.id === id)
    if (u) {
      setUsername(u.username)
      setRole(u.role)
      setLevelId(u.levelId ?? null)
    }
    if (first) setRole('Owner')
  }, [id, users, first])

  const { errors, setErrors, submit } = useSubmit(async () => {
    if ((!id || password) && password !== again) throw new ApiError('', ['The two passwords differ'])
    if (id) {
      await api.alterUser(company.id, id, { role: level?.baseRole ?? role, password: password || null, levelId })
    } else {
      await api.createUser(company.id, { username, password, role: level?.baseRole ?? role, levelId })
      if (first) {
        // the company is secured now: carry on as its Owner
        const r = await api.login(company.id, username, password)
        signedIn(r.user, r.token)
      }
    }
    changed()
    pop()
    return ''
  })
  useDeleteKey(!!id && id !== user?.id, ask, `Delete user "${username}"?`, () =>
    api
      .deleteUser(company.id, id!)
      .then(() => {
        changed()
        pop()
      })
      .catch((e) => setErrors(messages(e))),
  )

  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={id && id !== user?.id && <span className="muted">Alt+D delete</span>}>{id ? 'User Alteration' : 'User Creation'}</Title>
      {confirm}
      {first && <p className="muted">The first user is the Owner. Once created, this company asks for a name and password when it opens.</p>}
      <label>
        User name
        <input autoFocus={!id} required readOnly={!!id} value={username} onChange={(e) => setUsername(e.target.value)} aria-label="User name" />
      </label>
      <label>
        Role
        <select autoFocus={!!id} value={role} disabled={first} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
          {ROLES.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
        <span className="muted">{CAN[role]}</span>
      </label>
      {!first && (levels ?? []).length > 0 && role !== 'Owner' && (
        <label>
          Security level
          <select value={levelId ?? 0} onChange={(e) => { const l = levels!.find((x) => x.id === Number(e.target.value)); setLevelId(l?.id ?? null); if (l) setRole(l.baseRole) }} aria-label="Security level">
            <option value={0}>The role as it is</option>
            {levels!.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.baseRole})</option>)}
          </select>
        </label>
      )}
      <label>
        {id ? 'New password (blank keeps it)' : 'Password'}
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" aria-label="Password" />
      </label>
      <label>
        Repeat password
        <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" aria-label="Repeat password" />
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

/** Change Password (Alt+K → P): the signed-in user's own password. */
export function ChangePassword() {
  const { company, pop } = useApp()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const { errors, submit } = useSubmit(async () => {
    if (next !== again) throw new ApiError('', ['The two new passwords differ'])
    await api.changePassword(company.id, current, next)
    pop()
    return ''
  })
  return (
    <form className="form narrow" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title>Change Password</Title>
      <label>
        Current password
        <input autoFocus type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" aria-label="Current password" />
      </label>
      <label>
        New password
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" aria-label="New password" />
      </label>
      <label>
        Repeat new password
        <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" aria-label="Repeat new password" />
      </label>
      <Errors errors={errors} />
      <div className="actions">
        <button type="submit" className="primary">
          <b>Enter</b> Change
        </button>
      </div>
    </form>
  )
}
