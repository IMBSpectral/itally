/**
 * Reading a spreadsheet for import: an Excel workbook (.xlsx, its first sheet) or a CSV file, as rows
 * of cells. An .xlsx is a zip of XML parts; the parts needed (the workbook, its relationships, the
 * shared strings and the first sheet) are found through the zip's central directory and inflated.
 */
import { inflateRawSync } from 'node:zlib'
import { XMLParser } from 'fast-xml-parser'
import { ValidationError } from './books'

export type Cell = string | number | null

/** The files in a zip archive, by name. */
function unzip(buf: Buffer): Map<string, Buffer> {
  // the end of central directory record is within the last 64 KB + 22 bytes
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  if (eocd < 0) throw new ValidationError(['This is not an Excel workbook (.xlsx) or a CSV file'])
  const count = buf.readUInt16LE(eocd + 10)
  let at = buf.readUInt32LE(eocd + 16)
  const files = new Map<string, Buffer>()
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new ValidationError(['The workbook is damaged'])
    const method = buf.readUInt16LE(at + 10)
    const size = buf.readUInt32LE(at + 20)
    const nameLen = buf.readUInt16LE(at + 28)
    const extraLen = buf.readUInt16LE(at + 30)
    const commentLen = buf.readUInt16LE(at + 32)
    const local = buf.readUInt32LE(at + 42)
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8')
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const data = buf.subarray(start, start + size)
    files.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data))
    at += 46 + nameLen + extraLen + commentLen
  }
  return files
}

const asArray = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x])
const textOf = (x: unknown): string => {
  if (x === undefined || x === null) return ''
  if (typeof x !== 'object') return String(x)
  const o = x as Record<string, unknown>
  if ('#text' in o) return String(o['#text'])
  if ('t' in o) return asArray(o.t).map(textOf).join('')
  if ('r' in o) return asArray(o.r).map(textOf).join('') // rich text runs
  return ''
}
/** "C12" → column index 2 */
const columnOf = (ref: string) => {
  let n = 0
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** The first sheet of an .xlsx workbook as rows of cells (strings, numbers, empty as null). */
export function readXlsx(buf: Buffer): Cell[][] {
  const files = unzip(buf)
  const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false, trimValues: false })
  const part = (name: string) => {
    const f = files.get(name)
    return f ? xml.parse(f.toString('utf8')) : undefined
  }
  // the first sheet named in the workbook, through its relationship
  let sheetPath = 'xl/worksheets/sheet1.xml'
  const wb = part('xl/workbook.xml')
  const rels = part('xl/_rels/workbook.xml.rels')
  const first = asArray(wb?.workbook?.sheets?.sheet)[0] as Record<string, string> | undefined
  const rel = asArray(rels?.Relationships?.Relationship as Record<string, string>[]).find((r) => r['@Id'] === first?.['@r:id'])
  if (rel) sheetPath = rel['@Target'].startsWith('/') ? rel['@Target'].slice(1) : `xl/${rel['@Target']}`
  const shared = asArray(part('xl/sharedStrings.xml')?.sst?.si).map(textOf)
  const sheet = part(sheetPath)
  if (!sheet) throw new ValidationError(['The workbook has no sheet'])
  const rows: Cell[][] = []
  for (const r of asArray(sheet.worksheet?.sheetData?.row) as Record<string, unknown>[]) {
    const at = Number(r['@r'] ?? rows.length + 1) - 1
    const row: Cell[] = []
    for (const c of asArray(r.c) as Record<string, unknown>[]) {
      const col = c['@r'] ? columnOf(String(c['@r'])) : row.length
      const t = c['@t']
      const v = textOf(c.v)
      row[col] = t === 's' ? (shared[Number(v)] ?? '') : t === 'inlineStr' ? textOf(c.is) : t === 'str' || t === 'b' || t === 'e' ? v : v === '' ? null : Number(v)
    }
    rows[at] = Array.from(row, (x) => x ?? null)
  }
  return Array.from(rows, (r) => r ?? [])
}

/** A CSV file as rows of cells: commas, double-quoted fields with "" for a quote, CRLF or LF lines. */
export function readCsv(text: string): Cell[][] {
  const rows: Cell[][] = []
  let row: Cell[] = []
  let cell = ''
  let quoted = false
  const s = text.replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.map((r) => r.map((c) => (c === '' ? null : c)))
}

/** An uploaded spreadsheet: .xlsx if it is a zip, else CSV text. */
export function readSheet(buf: Buffer): Cell[][] {
  return buf[0] === 0x50 && buf[1] === 0x4b ? readXlsx(buf) : readCsv(buf.toString('utf8'))
}

/** An Excel date serial (days since 1899-12-30) or a typed date (d-m-y, d/m/y, y-m-d) as yyyy-mm-dd. */
export function dateOf(x: Cell): string | null {
  if (x === null || x === '') return null
  if (typeof x === 'number') return new Date(Date.UTC(1899, 11, 30) + Math.round(x) * 86_400_000).toISOString().slice(0, 10)
  const s = String(x).trim()
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  m = /^(\d{1,2})[- ]([A-Za-z]{3})[a-z]*[- ](\d{2,4})$/.exec(s)
  if (m && months.includes(m[2].toLowerCase())) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3]
    return `${y}-${String(months.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`
  }
  return null
}
