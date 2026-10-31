import { useRef, useState } from 'react'
import { useApp } from '../App'
import { api, ApiError, authHeaders, type Company } from '../api'
import { Errors, Menu, Title } from '../ui'

/** Save a response body as a file the user downloads (works in the browser and the desktop app). */
export async function download(res: Response, fallbackName: string) {
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName
  const url = URL.createObjectURL(await res.blob())
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return name
}

/** Pick a backup file and restore it as a new company. */
export function useRestore(onRestored: (c: Company) => void) {
  const input = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const picker = (
    <input
      ref={input}
      type="file"
      accept=".tallybackup,application/gzip"
      hidden
      onChange={async (e) => {
        const f = e.target.files?.[0]
        e.target.value = ''
        if (!f) return
        setErrors([])
        setStatus(`Restoring ${f.name}…`)
        try {
          const c = await api.restore(await f.arrayBuffer())
          setStatus(`Restored as "${c.name}"`)
          onRestored(c)
        } catch (err) {
          setStatus(null)
          setErrors(err instanceof ApiError ? err.errors : [String(err)])
        }
      }}
    />
  )
  return { picker, pick: () => input.current?.click(), status, errors }
}

/** Alt+Y Data: back up the open company, or restore one from a backup file. */
export function DataScreen() {
  const { company, openCompany, push } = useApp()
  const [status, setStatus] = useState<string | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const restore = useRestore(openCompany)

  async function backup() {
    setErrors([])
    setStatus('Preparing the backup…')
    try {
      const res = await fetch(`/api/companies/${company.id}/backup`, { headers: authHeaders() })
      if (!res.ok) throw new ApiError((await res.json()).error ?? res.statusText)
      const name = await download(res, `${company.name}.tallybackup`)
      setStatus(`Backup saved as "${name}" in your downloads`)
    } catch (err) {
      setStatus(null)
      setErrors([err instanceof Error ? err.message : String(err)])
    }
  }

  return (
    <div className="gateway">
      <div className="panel">
        <div className="panel-title">Data</div>
        <Menu
          items={[
            { label: `Backup "${company.name}"`, hotkey: 'B', onPick: backup },
            { label: 'Restore from a backup file', hotkey: 'R', onPick: restore.pick },
            { heading: '' },
            { label: 'Import from Excel (ledgers, stock items, vouchers)', hotkey: 'I', onPick: () => push({ k: 'import' }) },
            { label: 'Split Company Data', hotkey: 'S', onPick: () => push({ k: 'split' }) },
          ]}
        />
        {restore.picker}
      </div>
      <div className="data-status">
        <Title>{''}</Title>
        {(status || restore.status) && <p className="ok">{restore.status ?? status}</p>}
        <Errors errors={[...errors, ...restore.errors]} />
        <p className="muted small">
          A backup is one file holding the whole company: masters, vouchers, bills, bank dates and the Edit Log. Restoring
          creates a separate company, so nothing you have now is overwritten.
        </p>
      </div>
    </div>
  )
}
