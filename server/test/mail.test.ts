import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { SMTPServer } from 'smtp-server'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'
import { backupCompany, restoreCompany } from '../src/backup'

let server: Server
let base = ''
// a throwaway mail server: accepts one login, keeps what it is sent
const received: { from: string; to: string[]; data: string }[] = []
const smtp = new SMTPServer({
  authOptional: false,
  allowInsecureAuth: true,
  disabledCommands: ['STARTTLS'],
  onAuth: (auth, _s, cb) => (auth.username === 'books' && auth.password === 's3cret' ? cb(null, { user: 'books' }) : cb(new Error('Invalid login'))),
  onData: (stream, session, cb) => {
    let data = ''
    stream.on('data', (c) => (data += c))
    stream.on('end', () => {
      received.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '', to: session.envelope.rcptTo.map((r) => r.address), data })
      cb()
    })
  },
})
let smtpPort = 0
before(async () => {
  await migrate(() => {})
  server = createApp().listen(0)
  base = `http://localhost:${(server.address() as AddressInfo).port}/api`
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', () => r()))
  smtpPort = (smtp.server.address() as AddressInfo).port
})
after(async () => {
  server.close()
  await new Promise<void>((r) => smtp.close(() => r()))
  await pool.end()
})
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, body: res.status === 204 ? null : await res.json() }
}

test('e-mail: settings keep the password on the server, documents go out as HTML, every attempt is logged', async () => {
  const c = (await call('POST', '/companies', { name: `Mail ${Date.now()}`, booksBegin: '2026-04-01' })).body
  const at = `/companies/${c.id}`
  const msg = { to: ['buyer@example.com'], subject: 'Sales No. 1', html: '<h1>Invoice</h1><table><tr><td>Rice</td><td>1,200.00</td></tr></table>' }
  assert.match((await call('POST', `${at}/mail`, msg)).body.error, /Set up e-mail first/)

  assert.equal((await call('PUT', `${at}/mail/settings`, { host: '', port: 0, fromAddress: 'nope' })).status, 422)
  const settings = { host: '127.0.0.1', port: smtpPort, secure: false, username: 'books', password: 'wrong', fromAddress: 'accounts@example.in', fromName: 'Unique Foods' }
  assert.equal((await call('PUT', `${at}/mail/settings`, settings)).status, 204)
  const shown = (await call('GET', `${at}/mail/settings`)).body
  assert.equal(shown.hasPassword, true)
  assert.equal('password' in shown, false, 'the password is never sent back')

  const refused = await call('POST', `${at}/mail`, msg)
  assert.equal(refused.status, 422)
  assert.match(refused.body.error, /The mail server refused: .*Invalid login/)

  // a new password; then other changes without one keep it
  await call('PUT', `${at}/mail/settings`, { ...settings, password: 's3cret' })
  await call('PUT', `${at}/mail/settings`, { ...settings, password: undefined, fromName: 'Unique Foods LLP' })
  assert.equal((await call('POST', `${at}/mail`, { ...msg, to: ['not-an-address'] })).status, 422)
  const sent = await call('POST', `${at}/mail`, { ...msg, cc: ['owner@example.in'], attachments: [{ filename: 'invoice.html', content: Buffer.from(msg.html).toString('base64'), contentType: 'text/html' }] })
  assert.equal(sent.status, 200, JSON.stringify(sent.body))
  assert.deepEqual(sent.body.accepted, ['buyer@example.com', 'owner@example.in'])
  const got = received.at(-1)!
  assert.equal(got.from, 'accounts@example.in')
  assert.deepEqual(got.to, ['buyer@example.com', 'owner@example.in'])
  assert.match(got.data, /From: Unique Foods LLP <accounts@example.in>/)
  assert.match(got.data, /Subject: Sales No. 1/)
  assert.match(got.data, /filename=invoice.html/)

  const log = (await call('GET', `${at}/mail/log`)).body
  assert.deepEqual(log.map((l: { recipient: string; error: string | null }) => [l.recipient, l.error === null]), [
    ['buyer@example.com, owner@example.in', true],
    ['buyer@example.com', false],
  ])

  // a backup carries the settings but not the password
  const restored = await restoreCompany((await backupCompany(c.id)).file)
  const again = (await call('GET', `/companies/${restored.id}/mail/settings`)).body
  assert.deepEqual([again.host, again.fromName, again.hasPassword], ['127.0.0.1', 'Unique Foods LLP', false])
})
