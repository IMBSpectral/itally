import { useEffect, useState } from 'react'
import { useApp } from '../App'
import { api, ApiError } from '../api'
import { Errors, Title, enterAdvances, useLoad } from '../ui'
import { screenPdf } from '../pdf'
import { useSubmit } from './Masters'

/** Alt+K, Company Details: the mailing name and address printed on invoices and sent in e-Invoices. */
export function CompanyDetailsForm() {
  const { company, changed } = useApp()
  const [f, setF] = useState({ mailingName: '', address: '', pincode: '', phone: '', email: '' })
  useEffect(() => {
    api.company(company.id).then((c) =>
      setF({ mailingName: c.mailingName ?? '', address: c.address ?? '', pincode: c.pincode ?? '', phone: c.phone ?? '', email: c.email ?? '' }),
    )
  }, [company.id])
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }))
  const { errors, ok, submit } = useSubmit(async () => {
    await api.setCompanyDetails(company.id, f)
    changed()
    return 'Saved'
  })
  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={ok && <span className="ok">{ok}</span>}>Company Details: {company.name}</Title>
      <label>
        Mailing name
        <input autoFocus value={f.mailingName} onChange={set('mailingName')} placeholder={company.name} aria-label="Mailing name" />
      </label>
      <label>
        Address (the last line is the town)
        <textarea rows={3} value={f.address} onChange={set('address')} aria-label="Address" />
      </label>
      <div className="inline">
        <label>
          PIN code
          <input inputMode="numeric" value={f.pincode} onChange={set('pincode')} aria-label="PIN code" />
        </label>
        <label>
          Phone
          <input value={f.phone} onChange={set('phone')} aria-label="Phone" />
        </label>
        <label>
          E-mail
          <input value={f.email} onChange={set('email')} aria-label="E-mail" />
        </label>
      </div>
      <p className="muted">The state and GSTIN are set under GST Registration.</p>
      <Errors errors={errors} />
      <div className="actions">
        <button type="submit" className="primary">
          <b>Ctrl+A</b> Save
        </button>
      </div>
    </form>
  )
}

/** Alt+K, E-mail Settings: the SMTP server documents go out through. */
export function MailSettingsForm() {
  const { company } = useApp()
  const [f, setF] = useState({ host: '', port: '587', secure: 'No', username: '', password: '', fromAddress: '', fromName: '' })
  const [hasPassword, setHasPassword] = useState(false)
  useEffect(() => {
    api.mailSettings(company.id).then((s) => {
      if (!s) return setF((x) => ({ ...x, fromName: company.name }))
      setF({ host: s.host, port: String(s.port), secure: s.secure ? 'Yes' : 'No', username: s.username ?? '', password: '', fromAddress: s.fromAddress, fromName: s.fromName ?? '' })
      setHasPassword(s.hasPassword)
    })
  }, [company.id, company.name])
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }))
  const { errors, ok, submit } = useSubmit(async () => {
    if (!/^\d+$/.test(f.port.trim())) throw new ApiError('', ['Port: a number (587, or 465 with SSL)'])
    await api.setMailSettings(company.id, {
      host: f.host, port: Number(f.port), secure: f.secure === 'Yes', username: f.username || null, fromAddress: f.fromAddress, fromName: f.fromName || null,
      // blank keeps the stored password
      ...(f.password ? { password: f.password } : {}),
    })
    if (f.password) setHasPassword(true)
    setF((x) => ({ ...x, password: '' }))
    return 'Saved'
  })
  const test = useSubmit(async () => {
    await api.sendMail(company.id, { to: [f.fromAddress], subject: `Test from Books: ${company.name}`, html: '<p>E-mail from Books works.</p>' })
    return `Test sent to ${f.fromAddress}`
  })
  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={(ok && <span className="ok">{ok}</span>) || (test.ok && <span className="ok">{test.ok}</span>)}>E-mail Settings</Title>
      <div className="inline">
        <label>
          SMTP server
          <input autoFocus value={f.host} onChange={set('host')} placeholder="smtp.gmail.com" aria-label="SMTP server" />
        </label>
        <label>
          Port
          <input className="amount" inputMode="numeric" value={f.port} onChange={set('port')} aria-label="Port" />
        </label>
        <label>
          SSL from the start (port 465)
          <select value={f.secure} onChange={set('secure')} aria-label="SSL">
            <option>No</option>
            <option>Yes</option>
          </select>
        </label>
      </div>
      <div className="inline">
        <label>
          User name
          <input value={f.username} onChange={set('username')} autoComplete="off" aria-label="User name" />
        </label>
        <label>
          Password {hasPassword && <span className="muted">(stored; blank keeps it)</span>}
          <input type="password" value={f.password} onChange={set('password')} autoComplete="new-password" aria-label="Password" />
        </label>
      </div>
      <div className="inline">
        <label>
          From address
          <input value={f.fromAddress} onChange={set('fromAddress')} aria-label="From address" />
        </label>
        <label>
          From name
          <input value={f.fromName} onChange={set('fromName')} aria-label="From name" />
        </label>
      </div>
      <p className="muted">
        Gmail and Google Workspace: smtp.gmail.com, 587, with an app password. Microsoft 365: smtp.office365.com, 587. The password stays on this computer's server and
        is never shown again or kept in backups.
      </p>
      <Errors errors={[...errors, ...test.errors]} />
      <div className="actions">
        <button type="submit" className="primary">
          <b>Ctrl+A</b> Save
        </button>
        <button type="button" onClick={(e) => test.submit(e)}>
          Send a test to the From address
        </button>
      </div>
    </form>
  )
}

/** The CSS properties a mail client needs to show a document as it looks on screen. */
const KEEP = [
  'font-weight', 'font-size', 'font-style', 'font-family', 'color', 'background-color', 'text-align', 'vertical-align', 'white-space',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-bottom',
  'border-top', 'border-right', 'border-bottom', 'border-left', 'border-collapse', 'width', 'max-width', 'display',
  'flex-direction', 'justify-content', 'align-items', 'gap', 'word-break',
]

/**
 * The current screen as a self-contained HTML document for e-mail: mail clients drop style sheets,
 * so each element carries its own computed style; screen-only hints (key help) are left out.
 */
export function captureScreen(): { html: string; title: string; to: string; voucherId: number | null; pdf: string } | null {
  const screen = document.querySelector<HTMLElement>('.screen:not([hidden])')
  if (!screen) return null
  const clone = screen.cloneNode(true) as HTMLElement
  const src = [screen, ...screen.querySelectorAll<HTMLElement>('*')]
  const dst = [clone, ...clone.querySelectorAll<HTMLElement>('*')]
  src.forEach((el, i) => {
    const cs = getComputedStyle(el)
    if (cs.display === 'none') return dst[i].setAttribute('data-drop', '')
    dst[i].setAttribute('style', KEEP.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';'))
    dst[i].removeAttribute('class')
  })
  clone.querySelectorAll('[data-drop], button, .print-actions, input, select, textarea').forEach((el) => el.remove())
  const doc = screen.querySelector<HTMLElement>('[data-email-subject]')
  const title = doc?.dataset.emailSubject ?? screen.querySelector('h1, h2, .title')?.textContent?.trim() ?? 'Report'
  return {
    html: `<!doctype html><html><body style="margin:0;padding:16px;background:#fff">${clone.innerHTML}</body></html>`,
    title,
    to: doc?.dataset.emailTo ?? '',
    voucherId: doc?.dataset.voucherId ? Number(doc.dataset.voucherId) : null,
    pdf: screenPdf(screen, title),
  }
}

/** Alt+M: send the screen it was pressed on (a voucher's print, a report, a statement) by e-mail. */
export function EmailScreen({ html, subject: initialSubject, to: initialTo, voucherId, pdf }: { html: string; subject: string; to: string; voucherId: number | null; pdf?: string }) {
  const { company, pop, push } = useApp()
  const [to, setTo] = useState(initialTo)
  const [cc, setCc] = useState('')
  const [subject, setSubject] = useState(`${initialSubject}: ${company.name}`)
  const [note, setNote] = useState('')
  const [attach, setAttach] = useState(!!pdf)
  const { data: settings } = useLoad(() => api.mailSettings(company.id), [company.id])
  const list = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)
  const { errors, ok, submit } = useSubmit(async () => {
    const intro = note.trim() ? `<p style="white-space:pre-wrap">${note.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</p><hr>` : ''
    const attachments = attach && pdf ? [{ filename: `${initialSubject.replace(/[\/:*?"<>|]+/g, ' ').trim() || 'Document'}.pdf`, content: pdf, contentType: 'application/pdf' }] : undefined
    const r = await api.sendMail(company.id, { to: list(to), cc: list(cc), subject, html: html.replace('<body style="margin:0;padding:16px;background:#fff">', (b) => b + intro), voucherId, attachments })
    setTimeout(pop, 900)
    return `Sent to ${r.accepted.join(', ')}`
  })
  return (
    <form className="form" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={ok && <span className="ok">{ok}</span>}>E-mail</Title>
      {settings === null && (
        <p className="warn">
          E-mail isn't set up yet.{' '}
          <button type="button" onClick={() => push({ k: 'mail-settings' })}>
            E-mail Settings
          </button>
        </p>
      )}
      <label>
        To
        <input autoFocus value={to} onChange={(e) => setTo(e.target.value)} placeholder="buyer@example.com, another@example.com" aria-label="To" />
      </label>
      <label>
        Cc
        <input value={cc} onChange={(e) => setCc(e.target.value)} aria-label="Cc" />
      </label>
      <label>
        Subject
        <input value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" />
      </label>
      <label>
        Message
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Please find the invoice below." aria-label="Message" />
      </label>
      {pdf && (
        <label className="check">
          <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} /> Attach it as a PDF too
        </label>
      )}
      <Errors errors={errors} />
      <div className="actions">
        <button type="submit" className="primary">
          <b>Ctrl+A</b> Send
        </button>
      </div>
      <h3 className="sub">What goes out</h3>
      <iframe title="E-mail preview" className="mail-preview" srcDoc={html} sandbox="" />
    </form>
  )
}

/** Alt+K, E-mail Log: what was sent, and what the mail server refused. */
export function MailLogView() {
  const { company, version } = useApp()
  const { data, error } = useLoad(() => api.mailLog(company.id), [company.id, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title>E-mail Log</Title>
      <table className="report">
        <thead>
          <tr>
            <th>When</th>
            <th>To</th>
            <th>Subject</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {data.map((l) => (
            <tr key={l.id}>
              <td>{l.at.replace('T', ' ')}</td>
              <td>{l.recipient}</td>
              <td>{l.subject}</td>
              <td className={l.error ? 'warn' : 'ok'}>{l.error ?? 'sent'}</td>
            </tr>
          ))}
          {!data.length && (
            <tr className="muted">
              <td colSpan={4}>Nothing sent yet (Alt+M on any screen)</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
