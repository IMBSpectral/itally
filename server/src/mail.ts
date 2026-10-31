/**
 * E-mail through the company's own SMTP server: documents and reports go out as HTML (the screen
 * as printed), every attempt is logged, and the password never leaves the server.
 */
import nodemailer from 'nodemailer'
import { pool } from './db'
import { ValidationError } from './books'

export interface MailSettings {
  host: string
  port: number
  secure: boolean
  username: string | null
  fromAddress: string
  fromName: string | null
  hasPassword: boolean
}
export interface MailSettingsInput {
  host: string
  port: number
  secure?: boolean
  username?: string | null
  password?: string | null // undefined: keep the stored one; null or '': none
  fromAddress: string
  fromName?: string | null
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export async function getMailSettings(companyId: number): Promise<MailSettings | null> {
  return (await pool.query<MailSettings>(
    `SELECT host, port, secure, username, from_address "fromAddress", from_name "fromName", password IS NOT NULL "hasPassword"
       FROM mail_settings WHERE company_id = $1`,
    [companyId],
  )).rows[0] ?? null
}

export async function setMailSettings(companyId: number, s: MailSettingsInput) {
  const errors: string[] = []
  if (!s.host.trim()) errors.push('Give the SMTP server (for example smtp.gmail.com)')
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) errors.push('The port is a number from 1 to 65535 (587 or 465 usually)')
  if (!EMAIL.test(s.fromAddress.trim())) errors.push(`"${s.fromAddress}" is not an e-mail address`)
  if (errors.length) throw new ValidationError(errors)
  const keep = s.password === undefined
  await pool.query(
    `INSERT INTO mail_settings (company_id, host, port, secure, username, password, from_address, from_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (company_id) DO UPDATE SET host = $2, port = $3, secure = $4, username = $5,
       password = CASE WHEN $9 THEN mail_settings.password ELSE $6 END, from_address = $7, from_name = $8`,
    [companyId, s.host.trim(), s.port, !!s.secure, s.username?.trim() || null, keep ? null : s.password || null, s.fromAddress.trim(), s.fromName?.trim() || null, keep],
  )
}

export interface Message {
  to: string[]
  cc?: string[]
  subject: string
  html: string
  text?: string
  voucherId?: number | null
  attachments?: { filename: string; content: string; contentType?: string }[] // content: base64
}

/** Send one message; the outcome is logged either way. A refusal comes back as the server's own words. */
export async function sendMail(companyId: number, m: Message) {
  const errors: string[] = []
  if (!m.to.length) errors.push('Give at least one recipient')
  for (const a of [...m.to, ...(m.cc ?? [])]) if (!EMAIL.test(a)) errors.push(`"${a}" is not an e-mail address`)
  if (!m.subject.trim()) errors.push('Give a subject')
  if (errors.length) throw new ValidationError(errors)
  const s = (await pool.query<{ host: string; port: number; secure: boolean; username: string | null; password: string | null; fromAddress: string; fromName: string | null }>(
    `SELECT host, port, secure, username, password, from_address "fromAddress", from_name "fromName" FROM mail_settings WHERE company_id = $1`,
    [companyId],
  )).rows[0]
  if (!s) throw new ValidationError(['Set up e-mail first (Alt+K, E-mail Settings): your SMTP server, port and sender address'])
  const transport = nodemailer.createTransport({
    host: s.host, port: s.port, secure: s.secure,
    ...(s.username ? { auth: { user: s.username, pass: s.password ?? '' } } : {}),
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  })
  const log = (error: string | null) =>
    pool.query(`INSERT INTO mail_log (company_id, recipient, subject, voucher_id, error) VALUES ($1,$2,$3,$4,$5)`, [
      companyId, [...m.to, ...(m.cc ?? [])].join(', '), m.subject, m.voucherId ?? null, error,
    ])
  try {
    const info = await transport.sendMail({
      from: s.fromName ? { name: s.fromName, address: s.fromAddress } : s.fromAddress,
      to: m.to, cc: m.cc, subject: m.subject, html: m.html, text: m.text,
      attachments: m.attachments?.map((a) => ({ filename: a.filename, content: Buffer.from(a.content, 'base64'), contentType: a.contentType })),
    })
    await log(null)
    return { messageId: info.messageId as string, accepted: info.accepted.map(String) }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await log(msg)
    throw new ValidationError([`The mail server refused: ${msg}`])
  } finally {
    transport.close()
  }
}

export async function mailLog(companyId: number, limit = 100) {
  return (await pool.query(
    `SELECT l.id, to_char(l.at, 'YYYY-MM-DD"T"HH24:MI:SS') "at", l.recipient, l.subject, l.error, l.voucher_id "voucherId",
            v.type || ' No. ' || COALESCE(v.doc_no, v.number::text) "voucher"
       FROM mail_log l LEFT JOIN vouchers v ON v.id = l.voucher_id WHERE l.company_id = $1 ORDER BY l.id DESC LIMIT $2`,
    [companyId, limit],
  )).rows
}
