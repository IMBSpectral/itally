import { useState, type FormEvent } from 'react'
import { api, type Company } from '../api'
import { DateInput, Errors, Menu, enterAdvances, fmtDate, useLoad } from '../ui'
import { useRestore } from './Data'
import { GroupCompanies } from './CompanyTools'

export function CompanySelect({ onOpen }: { onOpen: (c: Company) => void }) {
  const { data: companies, error } = useLoad(() => api.companies(), [])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [booksBegin, setBooksBegin] = useState('2026-04-01')
  const [errors, setErrors] = useState<string[]>([])
  const restore = useRestore(onOpen)

  async function create(e: FormEvent) {
    e.preventDefault()
    try {
      onOpen(await api.createCompany({ name, booksBegin }))
    } catch (err) {
      setErrors((err as { errors?: string[] }).errors ?? [String(err)])
    }
  }

  return (
    <div className="company-select">
      <h1 className="wordmark">Books</h1>
      {error && <Errors errors={[`Cannot reach the server: ${error}`]} />}
      {restore.picker}
      {restore.status && <p className="ok">{restore.status}</p>}
      <Errors errors={restore.errors} />
      {companies && !creating && (
        <div className="panel">
          <div className="panel-title">Select Company</div>
          <Menu
            items={[
              ...companies.map((c, i) => ({
                label: `${c.name}  (from ${fmtDate(c.booksBegin)})`,
                hotkey: String((i + 1) % 10),
                onPick: () => onOpen(c),
              })),
              ...(companies.length ? [{ heading: '' }] : []),
              { label: 'Create Company', hotkey: 'C', onPick: () => setCreating(true) },
              { label: 'Restore Company from backup', hotkey: 'R', onPick: restore.pick },
            ]}
          />
        </div>
      )}
      {companies && !creating && companies.length > 1 && <GroupCompanies companies={companies} />}
      {creating && (
        <form className="panel form" onSubmit={create} onKeyDown={enterAdvances}>
          <div className="panel-title">Company Creation</div>
          <label>
            Company name
            <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Books beginning from
            <DateInput value={booksBegin} onChange={setBooksBegin} fyStart={`${booksBegin.slice(0, 4)}-04-01`} label="Books beginning from" />
          </label>
          <Errors errors={errors} />
          <div className="actions">
            <button type="button" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button type="submit" className="primary">
              Create
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
