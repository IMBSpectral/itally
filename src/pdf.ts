/**
 * A screen as a PDF, for e-mail attachments: its headings, lines of text and tables, set in
 * Courier (whose letters are all 0.6 em wide, so columns line up without font metrics) on A4,
 * turned to landscape when a table is wide. Written with the PDF's own standard fonts, so it
 * needs no library; letters outside Latin-1 (₹, Devanagari) are written as "Rs." and "?".
 */

type Block = { kind: 'heading'; text: string } | { kind: 'text'; text: string } | { kind: 'table'; rows: { cells: string[]; nums: boolean[] }[] }

const clean = (s: string) => s.replace(/[▸▾]/g, '').replace(/\s+/g, ' ').trim()
/** An element's words, leaving out its pickers and buttons. */
const textOf = (el: Element) => {
  const c = el.cloneNode(true) as Element
  c.querySelectorAll('select, option, button, input, textarea').forEach((x) => x.remove())
  return clean(c.textContent ?? '')
}

/** The headings, paragraphs and tables of a screen, in order. */
export function screenBlocks(screen: HTMLElement): Block[] {
  const out: Block[] = []
  const visible = (el: Element) => getComputedStyle(el).display !== 'none' && !el.closest('button, select, .print-actions, [data-drop]')
  const walk = (el: Element) => {
    if (!visible(el)) return
    if (el.tagName === 'TABLE') {
      const rows = [...el.querySelectorAll('tr')].filter(visible).map((tr) => {
        const cells = [...tr.children].filter(visible)
        return { cells: cells.map((c) => textOf(c)), nums: cells.map((c) => c.classList.contains('num')) }
      }).filter((r) => r.cells.some(Boolean))
      if (rows.length) out.push({ kind: 'table', rows })
      return
    }
    if (/^H[1-4]$/.test(el.tagName) || el.classList.contains('title')) {
      const t = textOf(el)
      if (t) out.push({ kind: 'heading', text: t })
      return
    }
    if (['P', 'LABEL', 'DT', 'DD', 'LI'].includes(el.tagName) || (el.children.length === 0 && clean(el.textContent ?? ''))) {
      const t = textOf(el)
      if (t) out.push({ kind: 'text', text: t })
      return
    }
    for (const c of el.children) walk(c)
  }
  walk(screen)
  return out
}

/** Latin-1 for the PDF's standard fonts. */
const latin = (s: string) => s.replace(/[▸▾]\s?/g, '').replace(/₹\s?/g, 'Rs. ').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\n\x20-\xff]/g, '?')
const esc = (s: string) => latin(s).replace(/[\\()]/g, (c) => `\\${c}`)

/** The blocks as lines of fixed-width text, tables in columns (numbers to the right). */
function layout(blocks: Block[], maxChars: number) {
  const lines: { text: string; bold: boolean }[] = []
  const wrap = (s: string) => {
    const words = s.split(' ')
    let cur = ''
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > maxChars) {
        lines.push({ text: cur, bold: false })
        cur = w
      } else cur = (cur + ' ' + w).trim()
    }
    if (cur) lines.push({ text: cur, bold: false })
  }
  for (const b of blocks) {
    if (b.kind === 'heading') {
      lines.push({ text: '', bold: false }, { text: b.text.slice(0, maxChars), bold: true })
    } else if (b.kind === 'text') wrap(b.text)
    else {
      const n = Math.max(...b.rows.map((r) => r.cells.length))
      const width = Array.from({ length: n }, (_, i) => Math.max(...b.rows.map((r) => (r.cells[i] ?? '').length), 1))
      // the first column gives way when the table is too wide
      const total = width.reduce((t, w) => t + w + 2, -2)
      if (total > maxChars) width[0] = Math.max(8, width[0] - (total - maxChars))
      for (const r of b.rows) {
        const text = width.map((w, i) => {
          const c = (r.cells[i] ?? '').slice(0, w)
          return r.nums[i] ? c.padStart(w) : c.padEnd(w)
        }).join('  ')
        lines.push({ text: text.trimEnd(), bold: false })
      }
      lines.push({ text: '', bold: false })
    }
  }
  return lines
}

/** The PDF file's bytes, base64, for a screen. */
export function screenPdf(screen: HTMLElement, footer = ''): string {
  const blocks = screenBlocks(screen)
  const widest = Math.max(0, ...blocks.map((b) => (b.kind === 'table' ? b.rows.reduce((m, r) => Math.max(m, r.cells.reduce((t, c) => t + c.length + 2, 0)), 0) : 0)))
  const landscape = widest > 100
  const [pw, ph] = landscape ? [842, 595] : [595, 842]
  const margin = 36
  const size = 9
  const lead = 11.5
  const maxChars = Math.floor((pw - 2 * margin) / (size * 0.6))
  const lines = layout(blocks, maxChars)
  const perPage = Math.floor((ph - 2 * margin - 2 * lead) / lead)
  const pages: (typeof lines)[] = []
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage))
  if (!pages.length) pages.push([])

  const objects: string[] = []
  const add = (s: string) => objects.push(s) // object n is objects[n - 1]
  add('<< /Type /Catalog /Pages 2 0 R >>')
  add('') // the page tree, once the pages are known
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>')
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>')
  const kids: number[] = []
  pages.forEach((page, p) => {
    let stream = 'BT\n'
    let y = ph - margin
    for (const l of page) {
      y -= lead
      if (l.text) stream += `/${l.bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${margin} ${y.toFixed(1)} Tm (${esc(l.text)}) Tj\n`
    }
    stream += `/F1 7 Tf 1 0 0 1 ${margin} ${margin - 12} Tm (${esc(`${footer}${footer ? '  -  ' : ''}page ${p + 1} of ${pages.length}`)}) Tj\nET`
    add(`<< /Length ${latin(stream).length} >>\nstream\n${stream}\nendstream`)
    const content = objects.length
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${content} 0 R >>`)
    kids.push(objects.length)
  })
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`

  // bytes: Latin-1, one byte a letter, so the cross-reference offsets are exact
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((o, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${latin(o)}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  let bin = ''
  for (let i = 0; i < pdf.length; i++) bin += String.fromCharCode(pdf.charCodeAt(i) & 0xff)
  return btoa(bin)
}
