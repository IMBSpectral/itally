import { createContext, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { formatINR } from '../server/src/engine/money'
import { t } from './i18n'
import { parseShortDate } from '../server/src/engine/dates'

/** Whether the screen rendering this component is the one on top (hidden screens ignore keys). */
export const ActiveCtx = createContext(true)
export const useActive = () => useContext(ActiveCtx)

/**
 * A Tally-style "Yes or No" prompt answered from the keyboard: Y or Enter confirms,
 * N or Esc dismisses. Returns the prompt element to render and a function that asks.
 */
export function useConfirm() {
  const active = useActive()
  const [q, setQ] = useState<{ text: string; yes: () => void } | null>(null)
  useEffect(() => {
    if (!q || !active) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if (k === 'y' || k === 'enter') q.yes()
      else if (!(k === 'n' || k === 'escape')) return
      e.preventDefault()
      e.stopImmediatePropagation()
      setQ(null)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [q, active])
  const node = q && (
    <div className="confirm" role="alertdialog">
      {q.text} <b>Y</b>es / <b>N</b>o
    </div>
  )
  return [node, (text: string, yes: () => void) => setQ({ text, yes })] as const
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 2026-04-01 -> 1-Apr-26, Tally's date style. */
export function fmtDate(iso: string) {
  const [y, m, d] = iso.split('-')
  return `${Number(d)}-${MONTHS[Number(m) - 1]}-${y.slice(2)}`
}

export const amt = (p: number) => (p === 0 ? '' : formatINR(p))
export const drcr = (p: number) => (p === 0 ? '' : `${formatINR(p)} ${p > 0 ? 'Dr' : 'Cr'}`)

/** Load data for a screen; refetches when deps change. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setError(null)
    fn()
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return { data, error }
}

export type MenuItem =
  | { heading: string }
  | { label: string; hotkey: string; onPick: () => void }

/**
 * Tally-style keyboard menu: arrows move, Enter picks, and the highlighted letter
 * of each item picks it directly.
 */
export function Menu({ items, autoFocus = true }: { items: MenuItem[]; autoFocus?: boolean }) {
  const picks = items.filter((i): i is Extract<MenuItem, { label: string }> => 'label' in i)
  const [sel, setSel] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  function onKey(e: KeyboardEvent) {
    if (e.ctrlKey || e.altKey || e.metaKey) return
    if (e.key === 'ArrowDown') setSel((s) => (s + 1) % picks.length)
    else if (e.key === 'ArrowUp') setSel((s) => (s - 1 + picks.length) % picks.length)
    else if (e.key === 'Enter') picks[sel]?.onPick()
    else {
      const hit = picks.find((p) => p.hotkey.toLowerCase() === e.key.toLowerCase())
      if (!hit) return
      hit.onPick()
    }
    e.preventDefault()
  }

  return (
    <div className="menu" tabIndex={0} ref={ref} onKeyDown={onKey}>
      {items.map((i, n) =>
        'heading' in i ? (
          <div key={n} className="menu-heading">
            {t(i.heading)}
          </div>
        ) : (
          <div
            key={n}
            className={`menu-item ${picks[sel] === i ? 'sel' : ''}`}
            onMouseEnter={() => setSel(picks.indexOf(i))}
            onClick={i.onPick}
          >
            {highlight(i.label, i.hotkey)}
          </div>
        ),
      )}
    </div>
  )
}

function highlight(english: string, key: string) {
  // in another language the key stays the English one, shown beside the words
  const label = t(english)
  if (label !== english && key) return <>{label} <span className="muted">(<u>{key}</u>)</span></>
  const at = label.toLowerCase().indexOf(key.toLowerCase())
  if (at < 0) return label
  return (
    <>
      {label.slice(0, at)}
      <u>{label[at]}</u>
      {label.slice(at + 1)}
    </>
  )
}

export interface PickOption {
  id: number
  name: string
  hint?: string
}

/**
 * Type-to-filter picker (Tally's "List of Ledger Accounts" pop-up). The list shows while
 * focused; arrows move, Enter picks the highlighted item and moves focus on.
 */
export function Picker({
  options,
  value,
  onChange,
  placeholder,
  autoFocus,
  inputRef,
}: {
  options: PickOption[]
  value: number | null
  onChange: (id: number) => void
  placeholder?: string
  autoFocus?: boolean
  inputRef?: React.RefObject<HTMLInputElement>
}) {
  const ownRef = useRef<HTMLInputElement>(null)
  const ref = inputRef ?? ownRef
  const current = options.find((o) => o.id === value)
  const [text, setText] = useState(current?.name ?? '')
  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState(0)
  // Enter pressed before the options arrived (fast typing right after opening a screen)
  const [pendingEnter, setPendingEnter] = useState(false)
  useEffect(() => setText(current?.name ?? ''), [current?.name])
  // the highlight follows the current choice when it or the list changes (e.g. an item just
  // created with Alt+C arrives after focus came back), so Enter keeps it
  const optionIds = options.map((o) => o.id).join(',') // callers often pass a new array each render
  useEffect(() => {
    if (value !== null) setSel(Math.max(0, options.findIndex((o) => o.id === value)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionIds, value])

  const shown = useMemo(() => {
    const t = text.trim().toLowerCase()
    if (!open || !t || t === current?.name.toLowerCase()) return options
    return options.filter((o) => o.name.toLowerCase().includes(t))
  }, [options, text, open, current])

  function pick(o: PickOption | undefined) {
    if (!o) return
    onChange(o.id)
    setText(o.name)
    setOpen(false)
    // move to the next field the way Tally does after a selection
    if (ref.current) focusNext(ref.current)
  }

  useEffect(() => {
    if (pendingEnter && options.length) {
      setPendingEnter(false)
      pick(shown[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEnter, options.length])

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') setSel((s) => Math.min(s + 1, shown.length - 1))
    else if (e.key === 'ArrowUp') setSel((s) => Math.max(s - 1, 0))
    else if (e.key === 'Enter' && options.length === 0) setPendingEnter(true)
    else if (e.key === 'Enter') pick(shown[sel])
    else if (e.key === 'Escape' && open) setOpen(false)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div className="picker">
      <input
        ref={ref}
        value={text}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onFocus={(e) => {
          // typing replaces the current choice, as in Tally
          e.target.select()
          setOpen(true)
          setSel(Math.max(0, options.findIndex((o) => o.id === value)))
        }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => {
          setText(e.target.value)
          setOpen(true)
          setSel(0)
        }}
        onKeyDown={onKey}
      />
      {open && (
        <ul className="picker-list">
          {shown.length === 0 && <li className="muted">No match</li>}
          {shown.slice(0, 200).map((o, i) => (
            <li key={o.id} className={i === sel ? 'sel' : ''} onMouseDown={(e) => {
                e.preventDefault()
                pick(o)
              }}>
              <span>{o.name}</span>
              {o.hint && <span className="muted">{o.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Date field that takes Tally short forms ("14", "14-10", "14-Oct", "14.10.26") and shows the
 * result as 14-Oct-26. Enter accepts and moves on; an invalid entry turns red and stays put.
 */
export function DateInput({
  value,
  onChange,
  fyStart,
  label,
  autoFocus,
  inputRef,
}: {
  value: string
  onChange: (iso: string) => void
  fyStart: string
  label: string
  autoFocus?: boolean
  inputRef?: React.RefObject<HTMLInputElement>
}) {
  const [text, setText] = useState(fmtDate(value))
  const [bad, setBad] = useState(false)
  useEffect(() => {
    setText(fmtDate(value))
    setBad(false)
  }, [value])

  function commit() {
    const iso = parseShortDate(text, value, fyStart)
    if (!iso) {
      setBad(true)
      return false
    }
    setBad(false)
    setText(fmtDate(iso))
    if (iso !== value) onChange(iso)
    return true
  }

  return (
    <input
      ref={inputRef}
      className={`date ${bad ? 'bad' : ''}`}
      aria-label={label}
      aria-invalid={bad}
      title="Type 14, 14-10, 14-Oct or 14.10.26"
      autoFocus={autoFocus}
      value={text}
      onFocus={(e) => e.target.select()}
      onChange={(e) => {
        setText(e.target.value)
        setBad(false)
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        e.stopPropagation()
        // move on once the new date has rendered: when the date is a form's last field,
        // advancing submits it, and the submit must see the date just typed
        const el = e.currentTarget
        if (commit()) setTimeout(() => advanceFrom(el), 0)
      }}
    />
  )
}

/**
 * Move on from `el` the way Enter does in Tally: to the next field in its form, skipping
 * buttons that don't submit (Cancel, Add line), and submitting once nothing is left.
 * Outside a form it just focuses the next field on the screen.
 */
export function advanceFrom(el: HTMLElement) {
  const form = el.closest('form')
  if (!form) return focusNext(el)
  const fields = [...form.querySelectorAll<HTMLElement>('input, select, textarea, button')].filter(
    (f) => !f.hasAttribute('disabled') && !(f instanceof HTMLButtonElement && f.type !== 'submit'),
  )
  const next = fields[fields.indexOf(el) + 1]
  if (!next || next instanceof HTMLButtonElement) form.requestSubmit()
  else next.focus()
}

/** Form onKeyDown: Enter on an input or select advances (see advanceFrom) instead of submitting early. */
export function enterAdvances(e: KeyboardEvent<HTMLFormElement>) {
  const el = e.target as HTMLElement
  if (e.key !== 'Enter' || !(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) return
  e.preventDefault()
  advanceFrom(el)
}

/** Focus the next focusable field after `el` in its form. */
export function focusNext(el: HTMLElement) {
  const form = el.closest('form, .screen')
  if (!form) return
  const fields = [...form.querySelectorAll<HTMLElement>('input, select, textarea, button')].filter((f) => !f.hasAttribute('disabled'))
  const i = fields.indexOf(el)
  fields[i + 1]?.focus()
}

export function Title({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="title">
      <h2>{typeof children === 'string' ? t(children) : children}</h2>
      {right && <div className="title-right">{right}</div>}
    </div>
  )
}

export function Errors({ errors }: { errors: string[] }) {
  if (!errors.length) return null
  return (
    <div className="errors" role="alert">
      {errors.map((e, i) => (
        <div key={i}>{e}</div>
      ))}
    </div>
  )
}
