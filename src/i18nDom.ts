/**
 * Hindi on forms and reports without touching the books' data: the words directly inside labels,
 * column headings, legends, section headings and buttons are put in Hindi as the screens draw
 * them, and put back when the language goes back to English. Table cells, inputs and options are
 * never changed, so ledger and item names, amounts and a select's values stay as they are.
 */
import { HI_LABELS } from './i18nLabels'
import { t } from './i18n'

const TAGS = new Set(['LABEL', 'TH', 'LEGEND', 'BUTTON', 'H2', 'H3', 'B', 'SPAN'])
const original = new Map<Text, string>()

function translateNode(n: Text) {
  const p = n.parentElement
  if (!p || !TAGS.has(p.tagName)) return
  // a <b> or <span> only inside a button or a label (a key name, a hint), never in a cell
  if ((p.tagName === 'B' || p.tagName === 'SPAN') && !p.closest('button, label, th')) return
  const text = n.data
  const key = text.trim()
  // the words of forms, else those of menus and titles
  const hi = HI_LABELS[key] ?? (t(key) !== key ? t(key) : undefined)
  if (!hi) return
  original.set(n, text)
  n.data = text.replace(key, hi)
  // screens come and go: forget the words of those closed
  if (original.size > 4000) for (const x of original.keys()) if (!x.isConnected) original.delete(x)
}

function walk(root: Node) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = w.nextNode(); n; n = w.nextNode()) translateNode(n as Text)
}

let observer: MutationObserver | null = null

/** Hindi (true) or English (false) for the words on the page from now on. */
export function translatePage(on: boolean) {
  observer?.disconnect()
  observer = null
  if (!on) {
    for (const [n, text] of original) if (n.isConnected) n.data = text
    original.clear()
    return
  }
  walk(document.body)
  observer = new MutationObserver((changes) => {
    for (const c of changes) {
      if (c.type === 'characterData') translateNode(c.target as Text)
      else c.addedNodes.forEach((n) => (n.nodeType === Node.TEXT_NODE ? translateNode(n as Text) : walk(n)))
    }
  })
  observer.observe(document.body, { subtree: true, childList: true, characterData: true })
}
