import { useApp } from '../App'
import { xlsx, type CellValue, type SheetRow } from '../xlsx'
import { api } from '../api'
import { amountInWords } from '../../server/src/engine/words'
import { amt, Errors, fmtDate, useLoad } from '../ui'
import { qty as itemQty } from './Inventory'
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

/** An invoice line's quantity in its item's unit ("2 Box 5 Nos" in a compound unit). */
const printQty = (q: number, s?: { unit: string; decimals: number; perUnit: string | null; conversion: number | null }) =>
  s ? itemQty(q, s.unit, s.decimals, s) : (q / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 })

/**
 * A voucher laid out as a document to print or save as PDF (Alt+P): company, voucher type and
 * number, the entries with bill references, narration, and the total in words.
 */
const TRADE_TYPES = ['Sales', 'Purchase', 'Credit Note', 'Debit Note', 'Sales Order', 'Purchase Order', 'Delivery Note', 'Receipt Note']

export function VoucherPrint({ id }: { id: number }) {
  const { company } = useApp()
  const { data: v, error } = useLoad(() => api.voucher(company.id, id), [company.id, id])
  // the party's mailing block on invoices, notes and orders: the voucher's party, else its first line
  const partyId = v && TRADE_TYPES.includes(v.type) ? (v.partyId ?? v.entries[0]?.ledgerId ?? null) : null
  const { data: items } = useLoad(async () => (v?.inventory?.length ? api.stockItems(company.id) : []), [company.id, v?.id])
  const { data: party } = useLoad(async () => (partyId ? api.ledger(company.id, partyId) : null), [company.id, partyId])
  // the seller block: the company's mailing details (Alt+K, Company Details) and GSTIN
  const { data: me } = useLoad(() => api.company(company.id), [company.id])
  // an invoice or note with an IRN or e-Way Bill carries them, and the IRP's signed QR code
  const { data: edoc } = useLoad(
    async () => (v && ['Sales', 'Purchase', 'Credit Note', 'Debit Note'].includes(v.type) ? (await api.eDocument(company.id, v.id).catch(() => null))?.record ?? null : null),
    [company.id, v?.id],
  )
  const [qr, setQr] = useState('')
  useEffect(() => {
    if (edoc?.signedQr && !edoc.irnCancelled) QRCode.toDataURL(edoc.signedQr, { errorCorrectionLevel: 'L', margin: 1, width: 180 }).then(setQr, () => setQr(''))
    else setQr('')
  }, [edoc?.signedQr, edoc?.irnCancelled])
  if (error) return <Errors errors={[error]} />
  if (!v) return <p className="muted">Loading…</p>
  const stock = !v.entries.length && !!v.inventory?.length // an order, note, stock journal or count
  const total = stock ? v.inventory!.reduce((t, l) => t + Math.abs(l.amount), 0) : v.entries.reduce((t, e) => t + Math.max(e.amount, 0), 0)
  const qty = (q: number) => (q / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 })
  return (
    <div className="print-doc" data-email-subject={`${v.type} No. ${v.docNo ?? v.number}`} data-email-to={party?.email ?? ''} data-voucher-id={v.id}>
      <div className="print-actions muted small">Alt+P print or save as PDF · Esc back</div>
      <header>
        <h1>{me?.mailingName || company.name}</h1>
        {me?.address && <div className="doc-address">{[...me.address.split('\n'), me.pincode].filter(Boolean).join(', ')}</div>}
        {(me?.gstin || me?.phone || me?.email) && (
          <div className="doc-address">{[me.gstin && `GSTIN/UIN: ${me.gstin}`, me.phone && `Phone: ${me.phone}`, me.email].filter(Boolean).join(' · ')}</div>
        )}
        <h2>{v.printTitle || (v.type === 'Sales' && me?.gstin ? 'Tax Invoice' : `${v.type} Voucher`)}</h2>
      </header>
      <div className="doc-meta">
        <span>
          No. <b>{v.docNo ?? v.number}</b>
        </span>
        <span>
          Dated <b>{fmtDate(v.date)}</b>
        </span>
      </div>
      {v.cancelled && <p className="doc-cancelled">CANCELLED</p>}
      {edoc && (edoc.irn || edoc.ewbNo) && (
        <div className="doc-irn">
          <div>
            {edoc.irn && (
              <>
                <div>
                  IRN: <span className="mono">{edoc.irn}</span> {edoc.irnCancelled && <b>(cancelled)</b>}
                </div>
                {edoc.ackNo && (
                  <div>
                    Ack No.: {edoc.ackNo}
                    {edoc.ackDate ? ` · Ack Date: ${edoc.ackDate}` : ''}
                  </div>
                )}
              </>
            )}
            {edoc.ewbNo && (
              <div>
                e-Way Bill No.: {edoc.ewbNo}
                {edoc.ewbValidUpto ? ` · valid up to ${edoc.ewbValidUpto}` : ''}
              </div>
            )}
          </div>
          {qr && <img src={qr} alt="e-Invoice QR code" width={120} height={120} />}
        </div>
      )}
      {party ? (
        <div className="doc-party">
          <span className="muted">{['Purchase', 'Debit Note', 'Receipt Note', 'Purchase Order'].includes(v.type) ? 'Supplier' : 'Buyer'}</span>
          <b>{party.mailingName || party.name}</b>
          {party.address && <span className="pre">{party.address}</span>}
          {(party.state || party.pincode || party.country) && (
            <span>{[party.state, party.pincode, party.country && party.country !== 'India' ? party.country : ''].filter(Boolean).join(' · ')}</span>
          )}
          {party.gstin && <span>GSTIN/UIN: {party.gstin}</span>}
          {party.pan && <span>PAN: {party.pan}</span>}
        </div>
      ) : (
        v.party && (
          <p>
            <span className="muted">Party:</span> <b>{v.party}</b>
          </p>
        )
      )}
      {stock ? (
        <table className="doc-table">
          <thead>
            <tr>
              <th>Item</th>
              <th className="num">{v.type === 'Physical Stock' ? 'Counted' : 'Quantity'}</th>
              <th className="num">Rate</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {v.inventory!.map((l, i) => (
              <tr key={i}>
                <td>
                  {l.item}
                  {(l.against || l.dueDate) && (
                    <div className="small muted">
                      {l.against ? `against ${l.against}` : ''}
                      {l.dueDate ? ` due ${fmtDate(l.dueDate)}` : ''}
                    </div>
                  )}
                </td>
                <td className="num">
                  {v.type === 'Physical Stock' ? qty(l.counted ?? 0) : `${l.qty < 0 ? 'out ' : v.type === 'Stock Journal' ? 'in ' : ''}${qty(Math.abs(l.qty))}`}
                </td>
                <td className="num">{amt(l.rate)}</td>
                <td className="num">{amt(Math.abs(l.amount))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <>
          {/* an item invoice lists its items before the ledger lines */}
          {v.inventory?.length ? (
            <table className="doc-table">
              <thead>
                <tr>
                  <th>Description of Goods</th>
                  <th className="num">Quantity</th>
                  <th className="num">Rate</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {v.inventory.map((l, i) => (
                  <tr key={i}>
                    <td>{l.item}</td>
                    <td className="num">{printQty(Math.abs(l.qty), items?.find((x) => x.id === l.itemId))}</td>
                    <td className="num">{amt(l.rate)}</td>
                    <td className="num">{amt(Math.abs(l.amount))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <table className="doc-table">
            <thead>
              <tr>
                <th>Particulars</th>
                <th className="num">Debit</th>
                <th className="num">Credit</th>
              </tr>
            </thead>
            <tbody>
              {v.entries.map((e, i) => (
                <tr key={i}>
                  <td>
                    {e.ledger}
                    {e.bills?.map((b, k) => (
                      <div key={k} className="small muted">
                        {b.type}
                        {b.name ? ` ${b.name}` : ''} {amt(Math.abs(b.amount))}
                        {b.dueDate ? `, due ${fmtDate(b.dueDate)}` : ''}
                      </div>
                    ))}
                  </td>
                  <td className="num">{e.amount > 0 ? amt(e.amount) : ''}</td>
                  <td className="num">{e.amount < 0 ? amt(-e.amount) : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td className="num total">{amt(total)}</td>
                <td className="num total">{amt(total)}</td>
              </tr>
            </tfoot>
          </table>
        </>
      )}
      {v.narration && (
        <p>
          <span className="muted">Narration:</span> {v.narration}
        </p>
      )}
      {(!stock || v.type.endsWith('Order')) && (
        <p>
          <span className="muted">Amount (in words):</span> <b>{amountInWords(total)}</b>
        </p>
      )}
      <div className="doc-sign">
        <span>Receiver's Signature</span>
        <span>Authorised Signatory</span>
      </div>
    </div>
  )
}

/**
 * Alt+E: the screen's report tables as an Excel workbook (or CSV). Amounts go out as numbers,
 * Dr positive and Cr negative, so they add up; headings and totals are bold.
 */
export function exportScreen(companyName: string, format: 'xlsx' | 'csv' = 'xlsx') {
  const screen = document.querySelector<HTMLElement>('.screen:not([hidden])')
  const tables = [...(screen?.querySelectorAll<HTMLTableElement>('table.report, table.doc-table') ?? [])]
  if (!screen || !tables.length) return false
  const title = screen.querySelector('h2')?.textContent?.trim() || 'Report'
  const note = screen.querySelector('.title-right')?.textContent?.trim() ?? ''
  const value = (raw: string): CellValue => {
    const text = raw
      .replace(/\s*\n\s*/g, ' ')
      .replace(/^[▸▾]\s*/, '')
      .trim()
    const m = /^(-?)([\d,]+\.\d{2})(?: (Dr|Cr))?$/.exec(text)
    return m ? (m[1] || m[3] === 'Cr' ? -1 : 1) * Number(m[2].replace(/,/g, '')) : text
  }
  const cell = (c: Element) => {
    const input = c.querySelector('input, select') as HTMLInputElement | null
    return value(input ? input.value : (c as HTMLElement).innerText)
  }
  const rows: SheetRow[] = [{ cells: [companyName], bold: true }, { cells: [title], bold: true }, { cells: [note] }, { cells: [] }]
  for (const t of tables) {
    for (const r of t.rows)
      rows.push({
        cells: [...r.cells].map(cell),
        bold: r.parentElement?.tagName !== 'TBODY',
      })
    // two-sided statements (Balance Sheet, P&L) keep their totals just below the table
    let totals: Element | null = t.nextElementSibling
    while (totals && totals.tagName !== 'TABLE' && !totals.classList.contains('totals-row')) totals = totals.nextElementSibling
    if (totals?.tagName === 'TABLE') totals = null
    if (totals)
      rows.push({
        cells: [...totals.children].flatMap((x) => ['Total', value((x as HTMLElement).innerText.replace(/^Total\s*/, ''))]),
        bold: true,
      })
    rows.push({ cells: [] })
  }
  const base = `${companyName} - ${title}`.replace(/[\\/:*?"<>|]+/g, '')
  const blob =
    format === 'xlsx'
      ? new Blob([xlsx(title, rows)], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        })
      : new Blob(
          [
            '﻿' +
              rows
                .map((r) =>
                  r.cells.map((c) => (c === null ? '' : typeof c === 'number' ? c.toFixed(2) : /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','),
                )
                .join('\r\n'),
          ],
          { type: 'text/csv;charset=utf-8' },
        )
  const url = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), {
    href: url,
    download: `${base}.${format}`,
  })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return true
}
