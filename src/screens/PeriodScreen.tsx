import { useState, type FormEvent } from 'react'
import { useApp } from '../App'
import { DateInput, Errors, Title, enterAdvances } from '../ui'

export function PeriodScreen() {
  const { company, period, setPeriod, pop } = useApp()
  const [from, setFrom] = useState(period.from)
  const [to, setTo] = useState(period.to)
  const [errors, setErrors] = useState<string[]>([])

  function save(e: FormEvent) {
    e.preventDefault()
    if (to < from) return setErrors(['The period ends before it starts'])
    setPeriod({ from, to })
    pop()
  }

  return (
    <form className="form narrow" onSubmit={save} onKeyDown={enterAdvances}>
      <Title>Change Period</Title>
      <label>
        From
        <DateInput value={from} onChange={setFrom} fyStart={company.fyStart} label="From" autoFocus />
      </label>
      <label>
        To
        <DateInput value={to} onChange={setTo} fyStart={company.fyStart} label="To" />
      </label>
      <Errors errors={errors} />
      <div className="actions">
        <button type="submit" className="primary">
          Apply
        </button>
      </div>
    </form>
  )
}
