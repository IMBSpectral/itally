/**
 * AI Assist (Ctrl+Space): a question about the books, answered by Claude from what the user is
 * looking at (the screen's text) and a short summary of the company's position. Off until the
 * company switches it on with its own Anthropic API key; the key is never sent back to the
 * screens nor put in backups. The answer explains and points; it never posts or alters anything.
 */
import Anthropic from '@anthropic-ai/sdk'
import { pool } from './db'
import { getCompany, ValidationError } from './books'
import { moneyMap, reviewQueue } from './intelligence'

const MODEL = 'claude-opus-5-5'
const SCREEN_LIMIT = 60_000 // characters of the screen's text sent with a question

export async function aiSettings(companyId: number) {
  const r = (await pool.query<{ enabled: boolean; key: string | null }>(`SELECT enabled, api_key key FROM ai_settings WHERE company_id = $1`, [companyId])).rows[0]
  return { enabled: r?.enabled ?? false, apiKeySet: !!r?.key }
}

/** Switch AI Assist on or off; a key left blank keeps the saved one. */
export async function setAiSettings(companyId: number, s: { enabled: boolean; apiKey?: string | null }) {
  const cur = (await pool.query<{ key: string | null }>(`SELECT api_key key FROM ai_settings WHERE company_id = $1`, [companyId])).rows[0]
  const key = s.apiKey?.trim() || cur?.key || null
  if (s.enabled && !key) throw new ValidationError(['Give the Anthropic API key (from console.anthropic.com, API keys) to switch AI Assist on'])
  await pool.query(`INSERT INTO ai_settings (company_id, enabled, api_key, updated_at) VALUES ($1,$2,$3, now())
                    ON CONFLICT (company_id) DO UPDATE SET enabled = $2, api_key = $3, updated_at = now()`, [companyId, s.enabled, key])
}

const SYSTEM = `You are the assistant inside Books, an accounting app for Indian businesses (double-entry books, GST, TDS, payroll, inventory).
You answer questions about the company's books from the screen the user is on and the summary given. Be brief and specific: quote the figures, name the ledgers, vouchers or reports to look at, and the keys that open them where you know them.
You cannot post, alter, delete or pay anything; when something should change, say what the user should do. If the screen and summary don't hold the answer, say so plainly rather than guess.
Amounts are in Indian rupees; write them in the Indian style (₹1,25,000.00). For tax questions, give the general rule and suggest confirming with a chartered accountant where the case is unusual.`

/**
 * Ask Claude a question about what is on the screen. The request carries the screen's text, the
 * Money Map figures and the review queue's open items. On a policy decline the API retries on a
 * fallback model (server-side fallbacks).
 */
export async function askAi(companyId: number, question: string, screen: { title?: string; text?: string }, client?: Anthropic) {
  const r = (await pool.query<{ enabled: boolean; key: string | null }>(`SELECT enabled, api_key key FROM ai_settings WHERE company_id = $1`, [companyId])).rows[0]
  if (!client && (!r?.enabled || !r.key)) throw new ValidationError(['AI Assist is off: switch it on with an API key (Alt+K, AI Assist)'])
  if (!question.trim()) throw new ValidationError(['Ask a question'])
  const c = (await getCompany(pool, companyId))!
  const map = await moneyMap(companyId, 30)
  const queue = await reviewQueue(companyId)
  const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const summary = [
    `Company: ${c.name}${c.gstin ? `, GSTIN ${c.gstin}` : ''}; books from ${c.booksBegin}. Today: ${map.asOf}.`,
    `Cash and bank now ${rupees(map.cashNow)}; next 30 days: collections due ${rupees(map.expected)}, payments due ${rupees(map.planned)}, projected ${rupees(map.projected)}.`,
    queue.open.length ? `Open review items:\n${queue.open.slice(0, 15).map((s) => `- ${s.title}: ${s.detail}`).join('\n')}` : 'No open review items.',
  ].join('\n')
  const text = (screen.text ?? '').slice(0, SCREEN_LIMIT)
  const api = client ?? new Anthropic({ apiKey: r!.key! })
  const response = await api.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `<summary>\n${summary}\n</summary>\n<screen title="${(screen.title ?? '').replace(/"/g, "'")}">\n${text}${(screen.text ?? '').length > SCREEN_LIMIT ? '\n[the rest of the screen is not included]' : ''}\n</screen>\n\n${question.trim()}`,
    }],
  })
  if (response.stop_reason === 'refusal') return { answer: 'Claude declined to answer this question.', model: response.model }
  const answer = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim()
  return { answer: answer || 'No answer came back.', model: response.model }
}
