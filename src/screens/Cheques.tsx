import { useState } from 'react'
import { useApp } from '../App'
import { api, type ChequeLayout, type ChequeLine, type Voucher } from '../api'
import { formatINR } from '../../server/src/engine/money'
import { amountInWords } from '../../server/src/engine/words'
import { amt, drcr, Errors, fmtDate, Picker, Title, useLoad } from '../ui'
import { periodNote } from './Books'
import { messages } from './Masters'
import { qty } from './Inventory'

const STATUS: Record<ChequeLine['status'], string> = { cleared: 'Cleared', 'post-dated': 'Post-dated', pending: 'Not cleared' }

/**
 * Cheque Register: every cheque issued and received in the period, with its bank, date and
 * whether the bank has cleared it. In `print` mode it lists the issued cheques, and Enter
 * prints one (Banking → Cheque Printing); otherwise Enter opens the voucher.
 */
export function ChequeRegisterView({ bankId, print }: { bankId?: number; print?: boolean }) {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.cheques(company.id, period, bankId), [company.id, bankId, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const lines = print ? data.lines.filter((l) => l.amount < 0) : data.lines
  const count = (f: (l: ChequeLine) => boolean) => lines.filter(f).length
  return (
    <div>
      <Title right={periodNote(data)}>{print ? 'Cheque Printing' : 'Cheque Register'}</Title>
      {lines.length === 0 ? (
        <p className="muted">No cheques in this period. Bank lines on Payment, Receipt and Contra vouchers ask for the cheque number.</p>
      ) : (
        <table className="report">
          <thead>
            <tr>
              <th>Date</th>
              <th>Particulars</th>
              <th>Vch Type</th>
              <th className="num">Vch No.</th>
              {!bankId && <th>Bank</th>}
              <th>Cheque No.</th>
              <th>Cheque Date</th>
              <th className="num">Issued</th>
              <th className="num">Received</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr
                key={l.entryId}
                className="clickable"
                onClick={() => push(print ? { k: 'cheque-print', voucherId: l.voucherId, chequeNo: l.chequeNo } : { k: 'voucher', type: l.type, id: l.voucherId })}
              >
                <td>{fmtDate(l.date)}</td>
                <td>{l.party}</td>
                <td>{l.type}</td>
                <td className="num">{l.docNo ?? l.number}</td>
                {!bankId && <td>{l.bank}</td>}
                <td>{l.chequeNo}</td>
                <td>{l.chequeDate ? fmtDate(l.chequeDate) : ''}</td>
                <td className="num">{l.amount < 0 ? amt(-l.amount) : ''}</td>
                <td className="num">{l.amount > 0 ? amt(l.amount) : ''}</td>
                <td className={l.status === 'cleared' ? 'muted' : ''}>
                  {STATUS[l.status]}
                  {l.bankDate ? ` ${fmtDate(l.bankDate)}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={bankId ? 6 : 7}>
                {count((l) => l.amount < 0)} issued · {count((l) => l.amount > 0)} received · {count((l) => l.status !== 'cleared')} not cleared
              </td>
              <td className="num total">{formatINR(-lines.filter((l) => l.amount < 0).reduce((t, l) => t + l.amount, 0))}</td>
              <td className="num total">{formatINR(lines.filter((l) => l.amount > 0).reduce((t, l) => t + l.amount, 0))}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  )
}

/** The payee of a payment: the other side's main ledger (the largest debit). */
function payeeOf(v: Voucher, bankLedgerId: number) {
  const others = v.entries.filter((e) => e.ledgerId !== bankLedgerId && e.amount > 0)
  return others.sort((a, b) => b.amount - a.amount)[0]?.ledger ?? ''
}

/**
 * A cheque laid out on the CTS-2010 leaf (203 × 92 mm): date boxes, payee, amount in words and
 * figures, "A/c Payee" crossing and the signatory. Printed at actual size (Alt+P).
 */
export function ChequePrint({ voucherId, chequeNo }: { voucherId: number; chequeNo?: string | null }) {
  const { company } = useApp()
  const { data: v, error } = useLoad(() => api.voucher(company.id, voucherId), [company.id, voucherId])
  const bankId = v ? (v.entries.find((e) => e.amount < 0 && (chequeNo ? e.chequeNo === chequeNo : !!e.chequeNo)) ?? v.entries.find((e) => e.amount < 0))?.ledgerId : undefined
  const [savedAt, setSavedAt] = useState(0)
  const { data: saved } = useLoad(() => (bankId ? api.chequeLayout(company.id, bankId) : Promise.resolve(null)), [company.id, bankId, savedAt])
  const [editing, setEditing] = useState<ChequeLayout | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  if (error) return <Errors errors={[error]} />
  if (!v) return <p className="muted">Loading…</p>
  const bank = v.entries.find((e) => e.amount < 0 && (chequeNo ? e.chequeNo === chequeNo : !!e.chequeNo)) ?? v.entries.find((e) => e.amount < 0)!
  const amount = Math.abs(bank.amount)
  const day = (bank.chequeDate ?? v.date).split('-').reverse().join('') // DDMMYYYY
  // the bank's own layout, or the standard CTS-2010 leaf the stylesheet lays out
  const layout = editing ?? saved ?? null
  const at = (p?: { top: number; left: number }, extra: Record<string, string> = {}) => (layout && p ? { top: `${p.top}mm`, left: `${p.left}mm`, right: 'auto', ...extra } : undefined)
  const save = async (next: ChequeLayout | null) => {
    setErrors([])
    try {
      await api.setChequeLayout(company.id, bank.ledgerId, next)
      setEditing(null)
      setSavedAt((n) => n + 1)
    } catch (e) {
      setErrors(messages(e))
    }
  }
  const num = (label: string, value: number, set: (n: number) => void) => (
    <label key={label}>
      {label}
      <input className="amount" inputMode="decimal" size={4} value={value} onChange={(e) => set(Number(e.target.value) || 0)} aria-label={label} />
    </label>
  )
  const edit = editing
  const put = (patch: Partial<ChequeLayout>) => setEditing((x) => ({ ...(x ?? STANDARD_LAYOUT), ...patch }))
  return (
    <div>
      <div className="print-actions muted small">
        Alt+P print on the cheque leaf (actual size, no margins) · Esc back · Cheque {bank.chequeNo ?? '—'} on {bank.ledger} ·{' '}
        <button type="button" onClick={() => setEditing(edit ? null : (saved ?? STANDARD_LAYOUT))}>{edit ? 'Close the layout' : `Layout for ${bank.ledger}`}</button>
        {saved ? ' (its own layout)' : ' (standard CTS-2010 leaf)'}
      </div>
      {edit && (
        <div className="cheque-panel form">
          <div className="bill-head muted">Positions in mm from the top-left corner of the leaf</div>
          {num('Leaf width', edit.width, (n) => put({ width: n }))}
          {num('Leaf height', edit.height, (n) => put({ height: n }))}
          {(['date', 'payee', 'words', 'figures', 'sign'] as const).flatMap((k) => [
            num(`${k} top`, edit[k].top, (n) => put({ [k]: { ...edit[k], top: n } } as Partial<ChequeLayout>)),
            num(`${k} left`, edit[k].left, (n) => put({ [k]: { ...edit[k], left: n } } as Partial<ChequeLayout>)),
          ])}
          {num('words width', edit.words.width, (n) => put({ words: { ...edit.words, width: n } }))}
          {num('date box width', edit.dateBox, (n) => put({ dateBox: n }))}
          <label>
            A/c Payee crossing
            <select value={edit.crossing ? 'Yes' : 'No'} onChange={(e) => put({ crossing: e.target.value === 'Yes' })} aria-label="Crossing">
              <option>Yes</option>
              <option>No</option>
            </select>
          </label>
          <button type="button" className="primary" onClick={() => save(edit)}>Save the layout</button>
          {saved && <button type="button" onClick={() => save(null)}>Back to the standard leaf</button>}
          <Errors errors={errors} />
        </div>
      )}
      <div className="cheque" style={layout ? { width: `${layout.width}mm`, height: `${layout.height}mm` } : undefined}>
        {(!layout || layout.crossing) && <div className="cheque-crossing">A/c Payee</div>}
        <div className="cheque-date" style={at(layout?.date)}>
          {day.split('').map((d, i) => (
            <span key={i} style={layout ? { width: `${layout.dateBox}mm` } : undefined}>{d}</span>
          ))}
        </div>
        <div className="cheque-payee" style={at(layout?.payee)}>{payeeOf(v, bank.ledgerId)}</div>
        <div className="cheque-words" style={at(layout?.words, layout ? { width: `${layout.words.width}mm` } : {})}>{amountInWords(amount).replace(/^Rupees /, '')}</div>
        <div className="cheque-figure" style={at(layout?.figures, { textAlign: 'left' })}>{formatINR(amount)}/-</div>
        <div className="cheque-sign" style={at(layout?.sign)}>For {company.name}</div>
      </div>
    </div>
  )
}

/** The CTS-2010 leaf (203 x 92 mm) as the stylesheet lays it out, the start for a bank's own layout. */
const STANDARD_LAYOUT: ChequeLayout = {
  width: 203, height: 92, date: { top: 7, left: 155 }, payee: { top: 20, left: 18 }, words: { top: 29, left: 30, width: 120 }, figures: { top: 37, left: 153 },
  sign: { top: 62, left: 150 }, crossing: true, dateBox: 5.2,
}

/** Payment Advice: a letter to the payee saying what was paid, how, and which bills it settles. */
export function PaymentAdvice({ voucherId }: { voucherId: number }) {
  const { company } = useApp()
  const { data: v, error } = useLoad(() => api.voucher(company.id, voucherId), [company.id, voucherId])
  if (error) return <Errors errors={[error]} />
  if (!v) return <p className="muted">Loading…</p>
  const bank = v.entries.find((e) => e.amount < 0)!
  const party = v.entries.filter((e) => e.amount > 0).sort((a, b) => b.amount - a.amount)[0]
  const amount = Math.abs(bank.amount)
  return (
    <div className="print-doc">
      <div className="print-actions muted small">Alt+P print or save as PDF · Esc back</div>
      <header>
        <h1>{company.name}</h1>
        <h2>Payment Advice</h2>
      </header>
      <div className="doc-meta">
        <span>
          To <b>{party?.ledger}</b>
        </span>
        <span>
          Dated <b>{fmtDate(v.date)}</b>
        </span>
      </div>
      <p>
        We have made a payment of <b>{formatINR(amount)}</b> ({amountInWords(amount)})
        {bank.chequeNo ? (
          <>
            {' '}
            by cheque No. <b>{bank.chequeNo}</b> dated {fmtDate(bank.chequeDate ?? v.date)} drawn on {bank.ledger}
          </>
        ) : (
          <> through {bank.ledger}</>
        )}
        {party?.bills?.length ? ', against the bills below.' : '.'}
      </p>
      {party?.bills?.length ? (
        <table className="doc-table">
          <thead>
            <tr>
              <th>Bill</th>
              <th>Type</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {party.bills.map((b, i) => (
              <tr key={i}>
                <td>{b.name ?? 'On account'}</td>
                <td>{b.type}</td>
                <td className="num">{amt(Math.abs(b.amount))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {v.narration && (
        <p>
          <span className="muted">Narration:</span> {v.narration}
        </p>
      )}
      <div className="doc-sign">
        <span>Payment No. {v.docNo ?? v.number}</span>
        <span>Authorised Signatory</span>
      </div>
    </div>
  )
}

/** Pick a payment for its advice. */
export function PaymentAdvicePick() {
  const { company, period, replace } = useApp()
  const { data } = useLoad(() => api.vouchers(company.id, period, 'Payment'), [company.id, period])
  const options = (data ?? [])
    .filter((v) => !v.cancelled)
    .map((v) => {
      const party = v.entries.filter((e) => e.amount > 0).sort((a, b) => b.amount - a.amount)[0]
      return { id: v.id, name: `No. ${v.docNo ?? v.number} · ${party?.ledger ?? ''}`, hint: `${fmtDate(v.date)} · ${formatINR(party?.amount ?? 0)}` }
    })
  return (
    <div className="form narrow">
      <Title>Payment Advice</Title>
      {data && options.length === 0 && <p className="muted">No payments in this period.</p>}
      <label>
        Payment
        <Picker options={options} value={null} onChange={(id) => replace({ k: 'payment-advice', voucherId: id })} autoFocus />
      </label>
    </div>
  )
}

/** Deposit Slip: the cheques received into a bank and not yet cleared, to hand in with them. */
export function DepositSlipView({ bankId }: { bankId: number }) {
  const { company, period, version } = useApp()
  const { data, error } = useLoad(() => api.depositSlip(company.id, bankId, period), [company.id, bankId, period, version])
  const { data: ledgers } = useLoad(() => api.ledgers(company.id, period), [company.id])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  const bank = ledgers?.find((l) => l.id === bankId)?.name ?? ''
  return (
    <div className="print-doc">
      <div className="print-actions muted small">Alt+P print · Esc back</div>
      <header>
        <h1>{company.name}</h1>
        <h2>Deposit Slip: {bank}</h2>
      </header>
      {data.lines.length === 0 ? (
        <p className="muted">No cheques waiting to be deposited.</p>
      ) : (
        <table className="doc-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Cheque No.</th>
              <th>Cheque Date</th>
              <th>Received from</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((l, i) => (
              <tr key={l.entryId}>
                <td>{i + 1}</td>
                <td>{l.chequeNo}</td>
                <td>{l.chequeDate ? fmtDate(l.chequeDate) : fmtDate(l.date)}</td>
                <td>{l.party}</td>
                <td className="num">{amt(l.amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4}>
                Total ({data.lines.length} cheque{data.lines.length === 1 ? '' : 's'}): {amountInWords(data.total)}
              </td>
              <td className="num total">{formatINR(data.total)}</td>
            </tr>
          </tfoot>
        </table>
      )}
      <div className="doc-sign">
        <span>Depositor</span>
        <span>Bank's stamp</span>
      </div>
    </div>
  )
}

/** Post-Dated Summary: vouchers marked post-dated whose date hasn't come yet. */
export function PostDatedView() {
  const { company, version, push } = useApp()
  const { data, error } = useLoad(() => api.postDated(company.id), [company.id, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={<span className="muted">after {fmtDate(data.today)}</span>}>Post-Dated Vouchers</Title>
      {data.vouchers.length === 0 ? (
        <p className="muted">No post-dated vouchers ahead. Mark one with Ctrl+T in the voucher.</p>
      ) : (
        <table className="report">
          <thead>
            <tr>
              <th>Date</th>
              <th>Particulars</th>
              <th>Vch Type</th>
              <th className="num">Vch No.</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {data.vouchers.map((v) => (
              <tr key={v.id} className="clickable" onClick={() => push({ k: 'voucher', type: v.type, id: v.id })}>
                <td>{fmtDate(v.date)}</td>
                <td>{v.entries.map((e) => e.ledger).join(', ')}</td>
                <td>{v.type}</td>
                <td className="num">{v.docNo ?? v.number}</td>
                <td className="num">{amt(v.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** Optional Vouchers or the Memorandum Register: kept, but out of the books. Enter opens one (to make it regular). */
export function DraftsView({ kind }: { kind: 'optional' | 'memorandum' }) {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.drafts(company.id, kind, period), [company.id, kind, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={periodNote(data)}>{kind === 'optional' ? 'Optional Vouchers' : 'Memorandum Register'}</Title>
      {data.vouchers.length === 0 ? (
        <p className="muted">{kind === 'optional' ? 'No optional vouchers. Mark one with Ctrl+L (or the Optional button).' : 'No memorandum vouchers. Ctrl+F10 enters one.'}</p>
      ) : (
        <table className="report">
          <thead>
            <tr>
              <th>Date</th>
              <th>Particulars</th>
              <th>Vch Type</th>
              <th className="num">Vch No.</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {data.vouchers.map((v) => (
              <tr key={v.id} className="clickable" onClick={() => push({ k: 'voucher', type: v.type, id: v.id })}>
                <td>{fmtDate(v.date)}</td>
                <td>
                  {v.entries.map((e) => e.ledger).join(', ')}
                  {v.narration && <div className="muted small">{v.narration}</div>}
                </td>
                <td>{v.type}</td>
                <td className="num">{v.docNo ?? v.number}</td>
                <td className="num">{amt(v.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** Cancelled Vouchers: their numbers stay in the series; who cancelled them, from the Edit Log. */
export function CancelledView() {
  const { company, period, version } = useApp()
  const { data, error } = useLoad(() => api.cancelled(company.id, period), [company.id, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={periodNote(data)}>Cancelled Vouchers</Title>
      {data.vouchers.length === 0 ? (
        <p className="muted">No cancelled vouchers.</p>
      ) : (
        <table className="report">
          <thead>
            <tr>
              <th>Date</th>
              <th>Vch Type</th>
              <th className="num">Vch No.</th>
              <th>Narration</th>
              <th>Cancelled on</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {data.vouchers.map((v) => (
              <tr key={v.id}>
                <td>{fmtDate(v.date)}</td>
                <td>{v.type}</td>
                <td className="num">{v.docNo ?? v.number}</td>
                <td className="muted">{v.narration}</td>
                <td>{fmtDate(v.cancelledOn)}</td>
                <td>{v.by ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** Negative Ledgers: balance-sheet ledgers on the wrong side (Cash in credit, a supplier in debit). */
export function NegativeLedgersView() {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.negativeLedgers(company.id, period), [company.id, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={periodNote(data)}>Negative Ledgers</Title>
      {data.ledgers.length === 0 ? (
        <p className="muted">No ledger stands on the wrong side.</p>
      ) : (
        <table className="report">
          <thead>
            <tr>
              <th>Ledger</th>
              <th>Group</th>
              <th className="num">Closing Balance</th>
            </tr>
          </thead>
          <tbody>
            {data.ledgers.map((l) => (
              <tr key={l.id} className="clickable" onClick={() => push({ k: 'statement', ledgerId: l.id })}>
                <td>{l.name}</td>
                <td className="muted">{l.group}</td>
                <td className="num neg">{drcr(l.closing)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** Negative Stock: items that went out before they came in. */
export function NegativeStockView() {
  const { company, period, version, push } = useApp()
  const { data, error } = useLoad(() => api.negativeStock(company.id, period), [company.id, period, version])
  if (error) return <Errors errors={[error]} />
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div>
      <Title right={periodNote(data)}>Negative Stock</Title>
      {data.items.length === 0 ? (
        <p className="muted">No item is below zero.</p>
      ) : (
        <table className="report">
          <thead>
            <tr>
              <th>Stock Item</th>
              <th className="num">Closing Quantity</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((i) => (
              <tr key={i.id} className="clickable" onClick={() => push({ k: 'stock-item-vouchers', itemId: i.id })}>
                <td>{i.name}</td>
                <td className="num neg">{qty(i.closingQty, i.unit, i.decimals)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
