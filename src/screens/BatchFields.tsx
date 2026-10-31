import { useApp } from '../App'
import { api } from '../api'
import { useLoad } from '../ui'

/** The batch of an item line (items kept in batches): its name, picked from those in stock or typed new; on goods coming in, the dates. */
export function BatchFields({ itemId, line, value, onChange, inward }: {
  itemId: number
  line: number
  value: { batch: string; mfgDate: string; expiryDate: string }
  onChange: (patch: Partial<{ batch: string; mfgDate: string; expiryDate: string }>) => void
  inward: boolean
}) {
  const { company, period, version } = useApp()
  const { data } = useLoad(() => api.batches(company.id, period.to, itemId), [company.id, period.to, itemId, version])
  const list = `batches-${line}`
  return (
    <div className="batch-fields">
      <input list={list} size={12} value={value.batch} onChange={(e) => onChange({ batch: e.target.value })} placeholder="Batch" aria-label={`Item ${line + 1} batch`} />
      <datalist id={list}>
        {(data?.batches ?? []).map((b) => (
          <option key={`${b.batch}/${b.godown}`} value={b.batch}>{`${b.qty / 1000} ${b.unit} in ${b.godown}${b.expiryDate ? `, expires ${b.expiryDate}` : ''}`}</option>
        ))}
      </datalist>
      {inward && (
        <>
          <input type="date" value={value.mfgDate} onChange={(e) => onChange({ mfgDate: e.target.value })} title="Date of manufacture" aria-label={`Item ${line + 1} manufactured on`} />
          <input type="date" value={value.expiryDate} onChange={(e) => onChange({ expiryDate: e.target.value })} title="Expiry date" aria-label={`Item ${line + 1} expires on`} />
        </>
      )}
    </div>
  )
}
