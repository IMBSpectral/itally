import { useState } from 'react'
import { useApp } from '../App'
import { api, type AppConfig, type Company, type ImportResult } from '../api'
import { xlsx } from '../xlsx'
import { LANGUAGES, t, type Lang } from '../i18n'
import { amt, Errors, fmtDate, Menu, Title, enterAdvances, useLoad } from '../ui'
import { messages, useSubmit } from './Masters'
import type { BalanceSheet, ProfitAndLoss, TrialBalance } from '../../server/src/engine/reports'

/** F12 Configuration, Import from Excel, Split Company Data, and group companies. */

const OPTIONS: { key: keyof AppConfig; label: string; help: string }[] = [
  { key: 'showBalances', label: 'Show current balances of ledgers in voucher entry', help: 'The Cur Bal under each ledger as you pick it' },
  { key: 'warnNegativeCash', label: 'Warn on negative cash and bank balances', help: 'Asks before saving a voucher that takes cash or a bank account below zero' },
  { key: 'dayBookNarration', label: 'Show narrations in the Day Book', help: 'The narration under each voucher' },
]

/** F12: Configure. */
export function ConfigForm() {
  const { company, changed, config, language, setLanguage } = useApp()
  const [f, setF] = useState<AppConfig>(config)
  const { errors, ok, submit } = useSubmit(async () => {
    const { lastVoucherDate: _, ...rest } = f
    await api.setConfig(company.id, rest)
    changed()
    return 'Saved'
  })
  return (
    <form className="form narrow" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={ok && <span className="ok">{ok}</span>}>Configuration (F12)</Title>
      <label>
        {t('Language (this computer)')}
        <select value={language} onChange={(e) => setLanguage(e.target.value as Lang)} aria-label="Language">
          {(Object.keys(LANGUAGES) as Lang[]).map((l) => <option key={l} value={l}>{LANGUAGES[l]}</option>)}
        </select>
        <span className="muted">menus, titles and buttons; the books' own names stay as entered (the अ button by a name field writes Roman letters in Devanagari)</span>
      </label>
      <label>
        Date of a new voucher
        <select value={f.voucherDate} onChange={(e) => setF({ ...f, voucherDate: e.target.value as AppConfig['voucherDate'] })} aria-label="Date of a new voucher">
          <option value="today">Today (within the period)</option>
          <option value="last">The last voucher's date</option>
        </select>
      </label>
      {OPTIONS.map((o) => (
        <label key={o.key} className="check" title={o.help}>
          <input type="checkbox" checked={!!f[o.key]} onChange={(e) => setF({ ...f, [o.key]: e.target.checked })} aria-label={o.label} /> {o.label}
        </label>
      ))}
      <Errors errors={errors} />
      <div className="actions"><button type="submit" className="primary"><b>Ctrl+A</b> Save</button></div>
    </form>
  )
}

const TEMPLATES: Record<ImportResult['kind'], { title: string; head: string[]; sample: (string | number | null)[][] }> = {
  ledgers: {
    title: 'Ledgers', head: ['Name', 'Under', 'Opening Balance', 'Dr/Cr', 'GSTIN', 'State', 'PAN', 'Address', 'Pincode', 'Email', 'Phone', 'Credit Days'],
    sample: [['Ram Traders', 'Sundry Debtors', 15000, 'Dr', '', 'Maharashtra', '', '', '', '', '', 30], ['Office Rent', 'Indirect Expenses', null, null, '', '', '', '', '', '', '', null]],
  },
  'stock-items': {
    title: 'Stock items', head: ['Name', 'Under', 'Unit', 'Opening Qty', 'Opening Rate', 'Opening Value', 'Godown', 'HSN', 'GST Rate', 'Batches'],
    sample: [['Steel Bolt M8', '', 'Nos', 500, 2.5, null, '', '7318', 18, 'No']],
  },
  vouchers: {
    title: 'Vouchers', head: ['Date', 'Voucher Type', 'Voucher No', 'Ledger', 'Debit', 'Credit', 'Narration', 'Item', 'Qty', 'Rate', 'Godown', 'Batch', 'Mfg Date', 'Expiry'],
    sample: [
      ['01-04-2026', 'Payment', 1, 'Office Rent', 25000, null, 'April rent'], [null, null, null, 'Cash', null, 25000, null],
      ['02-04-2026', 'Purchase', 1, 'Purchases', 1250, null, 'Bolts', 'Steel Bolt M8', 500, 2.5, null, null, null, null], [null, null, null, 'Ram Traders', null, 1250, null],
    ],
  },
}

/** Alt+Y, Import from Excel: ledgers, stock items or vouchers from an .xlsx or CSV file whose first row names the columns. */
export function ImportScreen() {
  const { company, changed } = useApp()
  const [kind, setKind] = useState<ImportResult['kind']>('ledgers')
  const [result, setResult] = useState<ImportResult | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const t = TEMPLATES[kind]
  const template = () => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([xlsx(t.title, [{ cells: t.head, bold: true }, ...t.sample.map((cells) => ({ cells }))])], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
    a.download = `${t.title} template.xlsx`
    a.click()
  }
  return (
    <div className="form">
      <Title>Import from Excel</Title>
      <div className="inline">
        <label>
          Import
          <select value={kind} onChange={(e) => { setKind(e.target.value as ImportResult['kind']); setResult(null) }} aria-label="What to import">
            <option value="ledgers">Ledgers</option>
            <option value="stock-items">Stock items</option>
            <option value="vouchers">Vouchers</option>
          </select>
        </label>
        <label>
          File (.xlsx or .csv)
          <input type="file" accept=".xlsx,.csv,text/csv" disabled={busy} aria-label="File to import"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (!f) return
              setErrors([])
              setResult(null)
              setBusy(true)
              try {
                const bytes = new Uint8Array(await f.arrayBuffer())
                let bin = ''
                for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
                setResult(await api.importSheet(company.id, kind, btoa(bin)))
                changed()
              } catch (err) {
                setErrors(messages(err))
              } finally {
                setBusy(false)
              }
            }} />
        </label>
        <button type="button" onClick={template}>Download the template</button>
      </div>
      <p className="muted">Columns: {t.head.join(', ')}. The first row names them; they may be in any order and named a little differently. {kind === 'vouchers' && 'A row with a date starts a voucher; the rows under it with the date blank are its other lines.'}</p>
      {busy && <p className="muted">Importing…</p>}
      <Errors errors={errors} />
      {result && (
        <>
          <p className="ok">{result.created} of {kind === 'vouchers' ? 'the vouchers' : `${result.rows} rows`} imported{result.failed.length ? `; ${result.failed.length} not` : ''}.</p>
          {result.failed.length > 0 && (
            <table className="report">
              <thead><tr><th className="num">Row</th><th>Name</th><th>Why not</th></tr></thead>
              <tbody>{result.failed.map((f) => <tr key={f.row}><td className="num">{f.row}</td><td>{f.label}</td><td className="errors-inline">{f.errors.join('; ')}</td></tr>)}</tbody>
            </table>
          )}
        </>
      )}
    </div>
  )
}

/** Alt+Y, Split Company Data: two new companies at a date, the books up to it and from it. */
export function SplitScreen() {
  const { company, period, openCompany } = useApp()
  const [date, setDate] = useState(() => {
    const mid = new Date(Date.parse(period.from) + (Date.parse(period.to) - Date.parse(period.from)) / 2)
    return `${mid.toISOString().slice(0, 8)}01`
  })
  const [made, setMade] = useState<{ first: Company; second: Company } | null>(null)
  const { errors, ok, submit } = useSubmit(async () => {
    const r = await api.splitCompany(company.id, date)
    setMade({ first: { ...company, id: r.first.id, name: r.first.name }, second: { ...company, id: r.second.id, name: r.second.name, booksBegin: date } })
    return 'Split'
  })
  return (
    <form className="form narrow" onSubmit={submit} onKeyDown={enterAdvances}>
      <Title right={ok && <span className="ok">{ok}</span>}>Split Company Data</Title>
      <label>
        Split from
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Split from" />
      </label>
      <p className="muted">
        Two new companies are made: "{company.name} (up to {fmtDate(new Date(Date.parse(date) - 86_400_000).toISOString().slice(0, 10))})" with the books before this date, and
        "{company.name} (from {fmtDate(date)})" beginning on it, whose opening balances, pending bills and stock are the first's closing ones. This company stays as it is.
      </p>
      <Errors errors={errors} />
      {made ? (
        <Menu items={[
          { label: `Open ${made.second.name}`, hotkey: 'O', onPick: () => openCompany(made.second) },
          { label: `Open ${made.first.name}`, hotkey: 'U', onPick: () => openCompany(made.first) },
        ]} />
      ) : (
        <div className="actions"><button type="submit" className="primary"><b>Ctrl+A</b> Split</button></div>
      )}
    </form>
  )
}

/** Group companies on the Select Company screen: make one, or show its members' books together. */
export function GroupCompanies({ companies }: { companies: Company[] }) {
  const { data: groups, error } = useLoad(() => api.groupCompanies(), [])
  const [list, setList] = useState<typeof groups>(null)
  const [making, setMaking] = useState(false)
  const [name, setName] = useState('')
  const [members, setMembers] = useState<number[]>([])
  const [open, setOpen] = useState<{ id: number; name: string } | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const shown = list ?? groups
  if (open) return <GroupReport group={open} onClose={() => setOpen(null)} />
  return (
    <div className="panel">
      <div className="panel-title">Group Companies</div>
      {error && <Errors errors={[error]} />}
      <Menu autoFocus={false} items={[
        ...(shown ?? []).map((g, i) => ({ label: `${g.name}  (${g.members.map((m) => m.name).join(', ')})`, hotkey: 'ABCDEF'[i] ?? '', onPick: () => setOpen(g) })),
        { label: 'Create Group Company', hotkey: 'G', onPick: () => setMaking(true) },
      ]} />
      {making && (
        <form className="form" onSubmit={async (e) => {
          e.preventDefault()
          setErrors([])
          try {
            await api.createGroupCompany({ name, members })
            setList(await api.groupCompanies())
            setMaking(false)
            setName('')
            setMembers([])
          } catch (err) {
            setErrors(messages(err))
          }
        }}>
          <label>
            Name
            <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} aria-label="Group company name" />
          </label>
          <fieldset>
            <legend>Member companies</legend>
            {companies.map((c) => (
              <label key={c.id} className="check">
                <input type="checkbox" checked={members.includes(c.id)} disabled={c.secured}
                  onChange={(e) => setMembers((m) => (e.target.checked ? [...m, c.id] : m.filter((x) => x !== c.id)))} /> {c.name}{c.secured ? ' (has users: cannot join)' : ''}
              </label>
            ))}
          </fieldset>
          <Errors errors={errors} />
          <div className="actions">
            <button type="button" onClick={() => setMaking(false)}>Cancel</button>
            <button type="submit" className="primary">Create</button>
          </div>
        </form>
      )}
    </div>
  )
}

/** A group company's consolidated statements for a period. */
function GroupReport({ group, onClose }: { group: { id: number; name: string }; onClose: () => void }) {
  const [report, setReport] = useState<'trial-balance' | 'profit-loss' | 'balance-sheet'>('balance-sheet')
  const [from, setFrom] = useState('2026-04-01')
  const [to, setTo] = useState('2027-03-31')
  const { data, error } = useLoad(() => api.groupReport(group.id, report, from, to), [group.id, report, from, to])
  return (
    <div className="panel wide">
      <div className="panel-title">{group.name}: consolidated</div>
      <div className="inline">
        <select value={report} onChange={(e) => setReport(e.target.value as typeof report)} aria-label="Statement">
          <option value="balance-sheet">Balance Sheet</option>
          <option value="profit-loss">Profit &amp; Loss A/c</option>
          <option value="trial-balance">Trial Balance</option>
        </select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
        <button type="button" onClick={onClose}>Back</button>
      </div>
      {error && <Errors errors={[error]} />}
      {data && <p className="muted">Members: {data.members.map((m) => m.name).join(', ')}. Groups and ledgers of the same name are shown as one; nothing between the members is eliminated.</p>}
      {data && report === 'trial-balance' && <GroupTb tb={data as unknown as TrialBalance} />}
      {data && report === 'profit-loss' && <GroupPl pl={data as unknown as ProfitAndLoss} />}
      {data && report === 'balance-sheet' && <GroupBs bs={data as unknown as BalanceSheet} />}
    </div>
  )
}

const side = (p: number) => (p ? `${amt(Math.abs(p))} ${p > 0 ? 'Dr' : 'Cr'}` : '')
function GroupTb({ tb }: { tb: TrialBalance }) {
  return (
    <table className="report">
      <thead><tr><th>Particulars</th><th className="num">Closing balance</th></tr></thead>
      <tbody>
        {tb.rows.map((r) => (
          <>
            <tr key={r.groupId} className="group-row"><td>{r.name}</td><td className="num">{side(r.closing)}</td></tr>
            {r.ledgers.map((l) => <tr key={`${r.groupId}/${l.id}`} className="sub-row"><td style={{ paddingLeft: '1.5em' }}>{l.name}</td><td className="num">{side(l.closing)}</td></tr>)}
          </>
        ))}
        {tb.primaryLedgers.map((l) => <tr key={`p${l.id}`}><td>{l.name}</td><td className="num">{side(l.closing)}</td></tr>)}
      </tbody>
      <tfoot>
        <tr><td>Total</td><td className="num total">{amt(tb.totalDr)} Dr · {amt(tb.totalCr)} Cr</td></tr>
        {tb.openingDifference !== 0 && <tr><td>Difference in opening balances</td><td className="num">{side(tb.openingDifference)}</td></tr>}
      </tfoot>
    </table>
  )
}
function GroupPl({ pl }: { pl: ProfitAndLoss }) {
  const lines = (s: ProfitAndLoss['tradingDr']) => s.map((x) => <tr key={x.groupId ?? x.name}><td>{x.name}</td><td className="num">{amt(x.amount)}</td></tr>)
  return (
    <table className="report">
      <tbody>
        {lines(pl.tradingCr)}
        {lines(pl.tradingDr)}
        <tr className="group-row"><td>Gross profit</td><td className="num">{amt(pl.grossProfit)}</td></tr>
        {lines(pl.indirectIncomes)}
        {lines(pl.indirectExpenses)}
        <tr className="group-row"><td>{pl.netProfit >= 0 ? 'Net profit' : 'Net loss'}</td><td className="num total">{amt(Math.abs(pl.netProfit))}</td></tr>
      </tbody>
    </table>
  )
}
function GroupBs({ bs }: { bs: BalanceSheet }) {
  return (
    <table className="report">
      <thead><tr><th>Liabilities</th><th className="num" /><th>Assets</th><th className="num" /></tr></thead>
      <tbody>
        {Array.from({ length: Math.max(bs.liabilities.length + 1, bs.assets.length) }, (_, i) => {
          const l = bs.liabilities[i]
          const a = bs.assets[i]
          return (
            <tr key={i}>
              <td>{l?.name ?? (i === bs.liabilities.length ? 'Profit & Loss A/c' : '')}</td>
              <td className="num">{l ? amt(l.amount) : i === bs.liabilities.length ? amt(bs.profitAndLoss.total) : ''}</td>
              <td>{a?.name ?? ''}</td>
              <td className="num">{a ? amt(a.amount) : ''}</td>
            </tr>
          )
        })}
      </tbody>
      <tfoot>
        {bs.openingDifference !== 0 && <tr><td>Difference in opening balances</td><td className="num">{amt(bs.openingDifference)}</td><td /><td /></tr>}
        <tr><td>Total</td><td className="num total">{amt(bs.totalLiabilities)}</td><td>Total</td><td className="num total">{amt(bs.totalAssets)}</td></tr>
      </tfoot>
    </table>
  )
}
