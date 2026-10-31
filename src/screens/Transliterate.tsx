import { useApp } from '../App'
import { transliterate } from '../i18n'

/** By a name field when the screens are in Hindi: writes what was typed in Roman letters in Devanagari ("Sharma" शर्मा). */
export function DevanagariButton({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { language } = useApp()
  if (language !== 'hi') return null
  return (
    <button type="button" className="small" title="Write in Devanagari: Sharma शर्मा, Raam राम" disabled={!/[A-Za-z]/.test(value)}
      onClick={() => onChange(transliterate(value))}>
      अ
    </button>
  )
}
