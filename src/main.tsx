import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// This is an application, not a web page: stop the browser's own shortcuts (reload, print,
// find, zoom, view source…) from firing inside it. Screens still receive these keys, and
// text editing keys (Ctrl+C/V/X/Z, Ctrl+A in text fields) are left alone.
const BROWSER_CTRL_KEYS = new Set(['r', 'p', 'f', 'g', 'h', 'j', 'u', 's', 'o', 'n', 'd', 'e', 'l', '+', '-', '=', '0'])
window.addEventListener('keydown', (e) => {
  const fkey = /^F([1-9]|1[0-2])$/.test(e.key) // F5 reload, F3 find, F7 caret browsing, F12 dev tools…
  if (fkey || (e.ctrlKey && BROWSER_CTRL_KEYS.has(e.key.toLowerCase())) || (e.altKey && e.key === 'Home')) e.preventDefault()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
