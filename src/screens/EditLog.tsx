import { useApp } from '../App'
import { api, type EditLogVersion } from '../api'
import { amt, Errors, fmtDate, Title, useLoad } from '../ui'

const when = (at: string) => `${fmtDate(at.slice(0, 10))} ${at.slice(11, 16)}`
const ACTION: Record<string, string> = { create: 'Created', alter: 'Altered', cancel: 'Cancelled', delete: 'Deleted' }

/** The Edit Log: every change, newest first. Enter on a row shows that item's history. */
export function EditLogView() {
  const { company, version, push } = useApp()
  const { data, error } = useLoad(() => api.editLog(company.id), [company.id, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={<span className="muted">every change is kept; nothing here can be edited</span>}>Edit Log</Title>
      <table className="report">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>What</th>
            <th>Change</th>
            <th className="num">Version</th>
          </tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.id} className="clickable" onClick={() => push({ k: 'edit-history', entity: r.entity, id: r.entityId, label: r.label })}>
              <td>{when(r.at)}</td>
              <td>{r.actor}</td>
              <td>
                <span className="muted small">{r.entity}</span> {r.label}
              </td>
              <td className={`log-${r.action}`}>{ACTION[r.action]}</td>
              <td className="num">{r.version ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.length === 0 && <p className="muted">No changes recorded yet.</p>}
    </div>
  )
}

type Snap = Record<string, unknown> & { entries?: { ledger: string; amount: number; bills?: { type: string; name: string | null; amount: number }[] | null }[] }

/** Every version of one voucher or master, oldest first, with what changed highlighted. */
export function EditHistoryView({ entity, id, label }: { entity: string; id: number; label: string }) {
  const { company } = useApp()
  const { data, error } = useLoad(() => api.editHistory(company.id, entity, id), [company.id, entity, id])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={<span className="muted">{data.length} version(s)</span>}>History: {label}</Title>
      {data.map((v, i) => (
        <Version key={v.id} v={v} prev={i > 0 ? (data[i - 1].data as Snap) : null} voucher={entity === 'voucher'} />
      ))}
    </div>
  )
}

function Version({ v, prev, voucher }: { v: EditLogVersion; prev: Snap | null; voucher: boolean }) {
  const d = v.data as Snap
  const changed = (k: string) => prev !== null && JSON.stringify(prev[k]) !== JSON.stringify(d[k])
  const fields = voucher ? ['date', 'narration', 'cancelled'] : Object.keys(d).filter((k) => !['id', 'created_at'].includes(k))
  return (
    <div className="log-version">
      <div className="log-head">
        <b className={`log-${v.action}`}>{ACTION[v.action]}</b>
        <span>{when(v.at)}</span>
        <span className="muted">by {v.actor}</span>
        {voucher && d.version !== undefined && <span className="muted">version {String(d.version)}</span>}
      </div>
      <table className="kv">
        <tbody>
          {fields.map((k) => (
            <tr key={k} className={changed(k) ? 'changed' : ''}>
              <td className="muted">{k}</td>
              <td>{d[k] === null || d[k] === undefined || d[k] === '' ? '—' : typeof d[k] === 'object' ? JSON.stringify(d[k]) : String(d[k])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {voucher && (
        <table className="report">
          <thead>
            <tr>
              <th>Ledger</th>
              <th className="num">Debit</th>
              <th className="num">Credit</th>
              <th>Bill-wise</th>
            </tr>
          </thead>
          <tbody>
            {(d.entries ?? []).map((e, n) => {
              const was = prev?.entries?.[n]
              const diff = prev !== null && (!was || was.ledger !== e.ledger || was.amount !== e.amount)
              return (
                <tr key={n} className={diff ? 'changed' : ''}>
                  <td>{e.ledger}</td>
                  <td className="num">{e.amount > 0 ? amt(e.amount) : ''}</td>
                  <td className="num">{e.amount < 0 ? amt(-e.amount) : ''}</td>
                  <td className="muted small">{(e.bills ?? []).map((b) => `${b.type}${b.name ? ' ' + b.name : ''} ${amt(Math.abs(b.amount))}`).join(' · ')}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
