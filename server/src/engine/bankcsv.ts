import { toPaise } from './money'
import type { StatementLine } from './bank'

/** Split one CSV line, honouring double-quoted fields ("1,23,456.00"). */
function cells(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  out.push(cur.trim())
  return out
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** Bank statement dates: 05/04/2026, 05-04-26, 5-Apr-2026, 05 Apr 26, 2026-04-05. Day comes first. */
export function statementDate(s: string): string | null {
  const t = s.trim()
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t)
  let y: number, mo: number, d: number
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t))) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
  else if ((m = /^(\d{1,2})[ /.-]([A-Za-z]{3})[A-Za-z]*[ /.-](\d{2}|\d{4})$/.exec(t))) {
    ;[d, y] = [Number(m[1]), Number(m[3])]
    mo = MONTHS.indexOf(m[2].toLowerCase()) + 1
    if (!mo) return null
  } else return null
  if (y < 100) y += 2000
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null
  return dt.toISOString().slice(0, 10)
}

const money = (s: string) => {
  const t = s.replace(/[₹\s]/g, '').replace(/^\((.*)\)$/, '-$1').replace(/(Cr|CR|Dr|DR)$/, '')
  return t && t !== '-' ? toPaise(t) : 0
}

/**
 * Read a bank statement CSV. Finds the header row (the first with a date column and either
 * an amount column or withdrawal/deposit columns) and returns one line per transaction:
 * + = deposit (credited by the bank), - = withdrawal. Rows that aren't transactions are skipped.
 */
export function parseStatementCsv(text: string): { lines: StatementLine[]; skipped: number } {
  const rows = text.split(/\r?\n/).filter((l) => l.trim()).map(cells)
  const find = (hdr: string[], ...names: RegExp[]) => hdr.findIndex((h) => names.some((n) => n.test(h.trim())))
  let at = -1
  let col = { date: -1, desc: -1, debit: -1, credit: -1, amount: -1 }
  for (let i = 0; i < rows.length && at < 0; i++) {
    const h = rows[i]
    const c = {
      date: find(h, /^(txn |transaction |value )?date$/i, /^date/i),
      desc: find(h, /narration|description|particulars|remarks|details/i),
      debit: find(h, /withdraw|^debit|^dr\b|paid out/i),
      credit: find(h, /deposit|^credit|^cr\b|paid in/i),
      amount: find(h, /^amount/i),
    }
    if (c.date >= 0 && (c.amount >= 0 || (c.debit >= 0 && c.credit >= 0))) {
      at = i
      col = c
    }
  }
  if (at < 0) throw new Error('No header row with a date and amount (or withdrawal and deposit) columns')
  const lines: StatementLine[] = []
  let skipped = 0
  for (const r of rows.slice(at + 1)) {
    const date = statementDate(r[col.date] ?? '')
    let amount = 0
    try {
      amount = col.amount >= 0 ? money(r[col.amount] ?? '') : money(r[col.credit] ?? '') - money(r[col.debit] ?? '')
    } catch {
      amount = 0
    }
    if (!date || !amount) {
      skipped++
      continue
    }
    lines.push({ date, amount, description: col.desc >= 0 ? r[col.desc] : undefined })
  }
  return { lines, skipped }
}
