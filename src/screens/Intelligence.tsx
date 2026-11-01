import { useEffect, useRef, useState } from 'react'
import { useApp, type Screen } from '../App'
import { api, ApiError, type ReviewItem } from '../api'
import { amt, Errors, fmtDate, Title, enterAdvances, useLoad } from '../ui'
import { messages, useSubmit } from './Masters'

/** Money Map, AI Suggestions, Agents and Automations, AI Assist: worked out from the books; nothing here posts or pays. */

const lakh = (p: number) => (p / 100_00_000).toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

/** Money Map: cash now, what comes in and goes out in the next days, the projected closing, what to pay first. */
export function MoneyMapView() {
  const { company, version, push } = useApp()
  const [days, setDays] = useState(30)
  const [reserve, setReserve] = useState('0')
  const reservePaise = Math.max(0, Math.round(Number(reserve || 0) * 100_00_000))
  const { data, error } = useLoad(() => api.moneyMap(company.id, days, reservePaise), [company.id, version, days, reservePaise])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const tile = (label: string, value: number, tone: string, sub?: string) => (
    <div className={`bridge-tile ${tone}`}>
      <div className="label">{label}</div>
      <div className="value">{lakh(value)}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  )
  return (
    <div>
      <Title right={<span className="muted">as at {fmtDate(data.asOf)} · amounts in ₹ lakh</span>}>Money Map: Cash and Payment Control</Title>
      <div className="inline" style={{ marginBottom: 10 }}>
        <label>Next
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Horizon">
            {[7, 15, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
          </select>
        </label>
        <label>Reserve for contingencies (₹ lakh)<input className="amount" value={reserve} onChange={(e) => setReserve(e.target.value)} aria-label="Reserve" /></label>
      </div>
      <div className="bridge">
        {tile('Cash now', data.cashNow, '', `Bank ${lakh(data.bank)} · Cash ${lakh(data.cash)}`)}
        <span className="op">+</span>
        {tile('Expected collections', data.expected, 'in', `till ${fmtDate(data.until)}`)}
        <span className="op">−</span>
        {tile('Planned outflow', data.planned, 'out')}
        <span className="op">=</span>
        {tile('Projected closing', data.projected, data.projected < 0 ? 'out' : 'ok', `headroom after reserve ${lakh(data.headroom)}`)}
      </div>
      <p className="muted small">Collections are the receivable bills falling due (those already overdue counted as expected now) and post-dated receipts; a forecast, not cash in hand.</p>
      <div className="dash-cols">
        <div>
          <h3 className="sub">Expected collections</h3>
          <table className="report">
            <thead><tr><th>Customer</th><th>Due</th><th className="num">₹ lakh</th></tr></thead>
            <tbody>{data.collections.map((c) => <tr key={c.party}><td>{c.party}</td><td>{fmtDate(c.dueDate)}</td><td className="num">{lakh(c.amount)}</td></tr>)}</tbody>
            <tfoot><tr><td colSpan={2}>Total</td><td className="num total">{lakh(data.expected)}</td></tr></tfoot>
          </table>
        </div>
        <div>
          <h3 className="sub">Planned payments</h3>
          <table className="report">
            <thead><tr><th>Particulars</th><th className="num">₹ lakh</th></tr></thead>
            <tbody>{data.payments.map((p) => <tr key={p.what}><td>{p.what}</td><td className="num">{lakh(p.amount)}</td></tr>)}</tbody>
            <tfoot><tr><td>Total</td><td className="num total">{lakh(data.planned)}</td></tr></tfoot>
          </table>
        </div>
      </div>
      <h3 className="sub">Priority queue: what falls due first</h3>
      <table className="report">
        <thead><tr><th>Due</th><th>Payee</th><th>Bill</th><th className="num">Amount</th><th>Reason</th></tr></thead>
        <tbody>
          {data.priority.map((p) => (
            <tr key={`${p.ledgerId}/${p.bill}`} className="clickable" onClick={() => push({ k: 'statement', ledgerId: p.ledgerId })}>
              <td>{fmtDate(p.dueDate)}</td><td>{p.party}</td><td>{p.bill}</td><td className="num">{amt(p.amount)}</td><td className={p.overdueDays ? 'warn' : ''}>{p.reason}</td>
            </tr>
          ))}
          {!data.priority.length && <tr className="muted"><td colSpan={5}>Nothing falls due in this period</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

/** Where a review item opens. */
function screenOf(s: ReviewItem): Screen | null {
  const o = s.open
  if (!o) return null
  if (o.screen === 'voucher') return { k: 'voucher', type: o.type as never, id: o.id }
  if (o.screen === 'ledger') return { k: 'statement', ledgerId: o.id }
  if (o.screen === 'reconciliation') return { k: 'bank-reco', ledgerId: o.id }
  if (o.screen === 'gstr2b') return { k: 'gst-reco', source: '2B' }
  return { k: 'e-documents' }
}

/** AI Suggestions: the review queue. Each item is a check over the books; a person decides. */
export function ReviewView() {
  const { company, version, changed, push } = useApp()
  const { data, error } = useLoad(() => api.review(company.id), [company.id, version])
  const { data: drafts } = useLoad(() => api.collectionDrafts(company.id), [company.id, version])
  const [errors, setErrors] = useState<string[]>([])
  const [showDone, setShowDone] = useState(false)
  const set = (key: string, status: 'dismissed' | 'done' | 'open') => api.decide(company.id, key, status).then(changed, (e) => setErrors(messages(e)))
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Looking over the books…</p>
  const row = (s: ReviewItem & { status?: string }) => {
    const target = screenOf(s)
    return (
      <tr key={s.key}>
        <td><span className={`badge sev-${s.severity}`}>{s.severity}</span></td>
        <td className={target ? 'clickable' : ''} onClick={() => target && push(target)}><b>{s.title}</b><div className="muted small">{s.detail}</div></td>
        <td style={{ whiteSpace: 'nowrap' }}>
          {s.status ? (
            <button type="button" className="small" onClick={() => set(s.key, 'open')}>Reopen ({s.status})</button>
          ) : (
            <>
              <button type="button" className="small" onClick={() => set(s.key, 'done')}>Done</button>{' '}
              <button type="button" className="small" onClick={() => set(s.key, 'dismissed')}>Dismiss</button>
            </>
          )}
        </td>
      </tr>
    )
  }
  return (
    <div>
      <Title right={<span className="muted">checks over the books · nothing is posted or changed · Enter opens</span>}>AI Suggestions: Review Queue</Title>
      <Errors errors={errors} />
      {!data.open.length && <p className="ok">Nothing needs review: no possible duplicates, unreconciled bank entries, overdue collections, GST problems or e-Invoices due.</p>}
      {data.open.length > 0 && (
        <table className="report">
          <thead><tr><th>Priority</th><th>What</th><th /></tr></thead>
          <tbody>{data.open.map(row)}</tbody>
        </table>
      )}
      {data.decided.length > 0 && (
        <p><button type="button" className="linkish-dark" onClick={() => setShowDone(!showDone)}>{showDone ? 'Hide' : 'Show'} {data.decided.length} decided</button></p>
      )}
      {showDone && <table className="report"><tbody>{data.decided.map(row)}</tbody></table>}
      {drafts && drafts.length > 0 && (
        <>
          <h3 className="sub">Collection reminders, drafted</h3>
          <p className="muted small">Copy and send (or e-mail from the party's statement, Alt+M); nothing is sent from here.</p>
          {drafts.slice(0, 10).map((d) => (
            <details key={d.ledgerId}>
              <summary>{d.party}: {amt(d.total)} on {d.bills} bill{d.bills > 1 ? 's' : ''}</summary>
              <textarea readOnly rows={8} style={{ width: '100%' }} value={d.text} aria-label={`Reminder to ${d.party}`} />
            </details>
          ))}
        </>
      )}
    </div>
  )
}

/** Agents and Automations: the assistants, their schedules and what they last found. */
export function AgentsView() {
  const { company, version, changed, push } = useApp()
  const { data, error } = useLoad(() => api.agents(company.id), [company.id, version])
  const { data: log } = useLoad(() => api.agentLog(company.id), [company.id, version])
  const [errors, setErrors] = useState<string[]>([])
  const [ran, setRan] = useState('')
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const save = (kind: string, active: boolean, schedule: string) => api.setAgent(company.id, kind, { active, schedule }).then(changed, (e) => setErrors(messages(e)))
  return (
    <div>
      <Title right={<span className="muted">assistants suggest or draft; a person approves</span>}>Agents: Control Register</Title>
      <Errors errors={errors} />
      {ran && <p className="ok">{ran} <button type="button" className="small" onClick={() => push({ k: 'review' })}>Open the review queue</button></p>}
      <table className="report">
        <thead><tr><th>Assistant</th><th>Purpose</th><th>Schedule</th><th>Mode</th><th>State</th><th>Last result</th><th /></tr></thead>
        <tbody>
          {data.map((a) => (
            <tr key={a.kind}>
              <td><b>{a.name}</b></td>
              <td>{a.purpose}</td>
              <td>
                <input size={13} defaultValue={a.schedule} aria-label={`${a.name} schedule`} onBlur={(e) => e.target.value !== a.schedule && save(a.kind, a.active, e.target.value)} />
              </td>
              <td>{a.mode}</td>
              <td>
                <button type="button" className="small" onClick={() => save(a.kind, !a.active, a.schedule)}>{a.active ? '● Active' : '○ Paused'}</button>
              </td>
              <td className="muted small">{a.lastRun ? `${a.lastRun}: ${a.lastResult}` : 'not run yet'}</td>
              <td>
                <button type="button" className="small" onClick={() => api.runAgent(company.id, a.kind).then((r) => (setRan(`${a.name}: ${r.result}`), changed()), (e) => setErrors(messages(e)))}>Run now</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Schedules are "daily HH:MM" or "weekdays HH:MM", India time, while Books is running. None of the assistants posts, alters or pays: they add to the review queue or draft reminders.</p>
      {log && log.length > 0 && (
        <>
          <h3 className="sub">Log</h3>
          <table className="report">
            <tbody>{log.slice(0, 30).map((l) => <tr key={l.id}><td>{l.at}</td><td>{data.find((a) => a.kind === l.kind)?.name ?? l.kind}</td><td>{l.result}</td></tr>)}</tbody>
          </table>
        </>
      )}
    </div>
  )
}

/** Alt+K, AI Assist: switch it on with an Anthropic API key (never shown again). */
export function AiSettingsForm() {
  const { company, version, changed } = useApp()
  const { data } = useLoad(() => api.aiSettings(company.id), [company.id, version])
  const [enabled, setEnabled] = useState(false)
  const [key, setKey] = useState('')
  useEffect(() => {
    if (data) setEnabled(data.enabled)
  }, [data])
  const { errors, ok, submit } = useSubmit(async () => {
    await api.setAiSettings(company.id, { enabled, apiKey: key || null })
    setKey('')
    changed()
    return enabled ? 'AI Assist is on: Ctrl+Space on any screen' : 'AI Assist is off'
  })
  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || <span className="muted">Ctrl+A save</span>}>AI Assist</Title>
      <p className="muted">
        Ctrl+Space on any screen asks Claude (Anthropic) about it. The question goes with the text of the screen you are on and a short summary (cash, dues, open review
        items) to Anthropic's API, under your own API key. It explains and points; it never posts or changes anything.
      </p>
      <label className="check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Use AI Assist in this company</label>
      <label>Anthropic API key<input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={data?.apiKeySet ? 'saved (leave blank to keep)' : 'sk-ant-…'} aria-label="API key" /></label>
      <Errors errors={errors} />
      <div className="actions"><button type="submit" className="primary"><b>Ctrl+A</b> Save</button></div>
    </form>
  )
}

/** Ctrl+Space: ask about the screen underneath. */
export function AiAssistPanel({ onClose }: { onClose: () => void }) {
  const { company, push } = useApp()
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [thread, setThread] = useState<{ q: string; a: string }[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => input.current?.focus(), [])
  const ask = async () => {
    const screen = document.querySelector<HTMLElement>('.screen:not([hidden])')
    const title = screen?.querySelector('h2')?.textContent ?? ''
    setBusy(true)
    setErrors([])
    try {
      const r = await api.aiAsk(company.id, { question: q, title, text: screen?.innerText ?? '' })
      setThread((t) => [...t, { q, a: r.answer }])
      setQ('')
    } catch (e) {
      setErrors(e instanceof ApiError ? messages(e) : [String(e)])
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="ai-panel" role="dialog" aria-label="AI Assist" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
      <div className="ai-head"><b>✦ AI Assist</b><span className="muted small">about this screen · Esc closes</span><button type="button" className="small" onClick={onClose}>Close</button></div>
      <div className="ai-thread">
        {thread.map((t, i) => (
          <div key={i}><p className="ai-q">{t.q}</p><p className="ai-a pre">{t.a}</p></div>
        ))}
        {!thread.length && <p className="muted small">Ask about what you see: "Why is cash short this month?", "Which bills of Apex are overdue?", "Is GST on this invoice right?"</p>}
      </div>
      <Errors errors={errors} />
      {errors.some((e) => /AI Assist is off/.test(e)) && <button type="button" onClick={() => (onClose(), push({ k: 'ai-settings' }))}>Switch it on</button>}
      <textarea ref={input} rows={2} value={q} disabled={busy} onChange={(e) => setQ(e.target.value)} placeholder={busy ? 'Asking…' : 'Ask, then Enter'} aria-label="Question"
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && q.trim()) { e.preventDefault(); ask() } }} />
    </div>
  )
}

/** Home's line about the review queue. */
export function ReviewBanner() {
  const { company, version, push } = useApp()
  const { data } = useLoad(() => api.review(company.id), [company.id, version])
  if (!data?.open.length) return null
  const kinds = [...new Set(data.open.map((s) => ({ duplicate: 'possible duplicate', bank: 'bank match', overdue: 'overdue collection', gst: 'GST problem', gstr2b: 'GSTR-2B mismatch',
    einvoice: 'e-Invoice due', cash: 'cash below zero' })[s.kind]))]
  return (
    <button type="button" className="review-banner wide" onClick={() => push({ k: 'review' })}>
      ✦ <b>{data.open.length} item{data.open.length > 1 ? 's' : ''} need review:</b> {kinds.slice(0, 3).join(', ')} <span className="muted">· open</span>
    </button>
  )
}
