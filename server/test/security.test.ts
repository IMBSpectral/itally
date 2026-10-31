import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { pool } from '../src/db'
import { migrate } from '../src/migrate'
import { createApp } from '../src/app'
import { createXmlApp } from '../src/xml/gateway'
import { allowed } from '../src/security'
import { setToday } from '../src/engine/clock'

let server: Server
let xml: Server
let base = ''
before(async () => {
  await migrate(() => {})
  server = createApp().listen(0)
  xml = createXmlApp().listen(0)
  base = `http://localhost:${(server.address() as AddressInfo).port}/api`
})
after(async () => {
  server.close()
  xml.close()
  await pool.end()
})

async function call(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {}
  if (body) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function company() {
  const c = (await call('POST', '/companies', { name: `Secure ${Date.now()}-${Math.random()}`, booksBegin: '2026-04-01' })).body
  const groups = (await call('GET', `/companies/${c.id}/groups`)).body as { id: number; name: string }[]
  const g = (n: string) => groups.find((x) => x.name === n)!.id
  const cash = ((await call('GET', `/companies/${c.id}/ledgers`)).body as { id: number; name: string }[]).find((l) => l.name === 'Cash')!.id
  const rent = (await call('POST', `/companies/${c.id}/ledgers`, { name: 'Rent', groupId: g('Indirect Expenses') })).body.id
  return { id: c.id as number, name: c.name as string, g, cash, rent }
}
const signIn = async (c: number, username: string, password: string) => (await call('POST', `/companies/${c}/login`, { username, password })).body.token as string

test('a company is open until its first user, the Owner; then every request needs a sign-in', async () => {
  const c = await company()
  const at = `/companies/${c.id}`
  assert.equal((await call('GET', `${at}/me`)).body.secured, false)
  assert.equal((await call('POST', `${at}/users`, { username: 'meera', password: 'secret1', role: 'Accountant' })).status, 422) // first must be Owner
  assert.equal((await call('POST', `${at}/users`, { username: 'Meera', password: 'secret1', role: 'Owner' })).status, 201)

  assert.equal((await call('GET', `${at}/ledgers`)).status, 401)
  assert.equal((await call('POST', `${at}/login`, { username: 'meera', password: 'wrong' })).status, 422)
  const token = await signIn(c.id, 'MEERA', 'secret1') // the name is not case-sensitive
  assert.equal((await call('GET', `${at}/ledgers`, undefined, token)).status, 200)
  assert.deepEqual((await call('GET', `${at}/me`, undefined, token)).body.user.role, 'Owner')
  assert.equal((await fetch(`${base}${at}/backup?token=${token}`)).status, 200) // a download link carries the token

  const other = await company()
  assert.equal((await call('POST', `/companies/${other.id}/users`, { username: 'x', password: 'secret1', role: 'Owner' })).status, 201)
  assert.equal((await call('GET', `/companies/${other.id}/ledgers`, undefined, token)).status, 401) // a session is for one company
  assert.equal(((await call('GET', '/companies')).body as { id: number; secured: boolean }[]).find((x) => x.id === c.id)!.secured, true)

  await call('POST', `${at}/logout`, undefined, token)
  assert.equal((await call('GET', `${at}/ledgers`, undefined, token)).status, 401)
})

test('roles: Viewer reads, Data Entry creates, Accountant alters, only the Owner manages users', async () => {
  const c = await company()
  const at = `/companies/${c.id}`
  await call('POST', `${at}/users`, { username: 'owner', password: 'secret1', role: 'Owner' })
  const owner = await signIn(c.id, 'owner', 'secret1')
  for (const [username, role] of [['vic', 'Viewer'], ['dee', 'Data Entry'], ['acc', 'Accountant']])
    assert.equal((await call('POST', `${at}/users`, { username, password: 'secret1', role }, owner)).status, 201)
  const [vic, dee, acc] = [await signIn(c.id, 'vic', 'secret1'), await signIn(c.id, 'dee', 'secret1'), await signIn(c.id, 'acc', 'secret1')]
  const pay = { type: 'Payment', date: '2026-05-01', entries: [{ ledgerId: c.rent, amount: 50000 }, { ledgerId: c.cash, amount: -50000 }] }

  assert.equal((await call('GET', `${at}/reports/trial-balance`, undefined, vic)).status, 200)
  assert.equal((await call('POST', `${at}/vouchers`, pay, vic)).status, 403)
  assert.equal((await call('GET', `${at}/backup`, undefined, vic)).status, 403)

  const v = await call('POST', `${at}/vouchers`, pay, dee)
  assert.equal(v.status, 201)
  assert.equal((await call('PUT', `${at}/vouchers/${v.body.id}`, { ...pay, version: 1 }, dee)).status, 403)
  assert.equal((await call('POST', `${at}/vouchers/${v.body.id}/cancel`, undefined, dee)).status, 403)
  assert.equal((await call('POST', `${at}/ledgers`, { name: 'Power', groupId: c.g('Indirect Expenses') }, dee)).status, 201)

  assert.equal((await call('PUT', `${at}/vouchers/${v.body.id}`, { ...pay, narration: 'May rent', version: 1 }, acc)).status, 200)
  assert.equal((await call('GET', `${at}/users`, undefined, acc)).status, 403)
  assert.equal((await call('PUT', `${at}/me/password`, { current: 'secret1', next: 'secret22' }, acc)).status, 204)

  // the Edit Log names whoever made each change
  const log = (await call('GET', `${at}/edit-log`, undefined, owner)).body as { actor: string; entity: string; action: string; label: string }[]
  const by = (entity: string, action: string, label?: string) => log.find((r) => r.entity === entity && r.action === action && (!label || r.label === label))?.actor
  assert.equal(by('voucher', 'create'), 'dee')
  assert.equal(by('voucher', 'alter'), 'acc')
  assert.equal(by('ledger', 'create', 'Power'), 'dee')
})

test('the company keeps an Owner; a new password ends that user\'s sessions', async () => {
  const c = await company()
  const at = `/companies/${c.id}`
  await call('POST', `${at}/users`, { username: 'owner', password: 'secret1', role: 'Owner' })
  const owner = await signIn(c.id, 'owner', 'secret1')
  const users = (await call('GET', `${at}/users`, undefined, owner)).body as { id: number }[]
  assert.equal((await call('PUT', `${at}/users/${users[0].id}`, { role: 'Viewer' }, owner)).status, 422)
  assert.equal((await call('DELETE', `${at}/users/${users[0].id}`, undefined, owner)).status, 400)
  const sam = (await call('POST', `${at}/users`, { username: 'sam', password: 'secret1', role: 'Accountant' }, owner)).body.id
  const samToken = await signIn(c.id, 'sam', 'secret1')
  assert.equal((await call('PUT', `${at}/users/${sam}`, { role: 'Accountant', password: 'newpass1' }, owner)).status, 204)
  assert.equal((await call('GET', `${at}/ledgers`, undefined, samToken)).status, 401)
  assert.ok(await signIn(c.id, 'sam', 'newpass1'))
  assert.equal((await call('POST', `${at}/users`, { username: 'short', password: '123', role: 'Viewer' }, owner)).status, 422)
})

test('secured companies stay off the XML port, and backups carry their users', async () => {
  const c = await company()
  await call('POST', `/companies/${c.id}/users`, { username: 'owner', password: 'secret1', role: 'Owner' })
  const res = await fetch(`http://localhost:${(xml.address() as AddressInfo).port}/`, {
    method: 'POST',
    body: `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>List of Accounts</REPORTNAME>
      <STATICVARIABLES><SVCURRENTCOMPANY>${c.name}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`,
  })
  assert.match(await res.text(), /not served over XML/)

  const { backupCompany, restoreCompany } = await import('../src/backup')
  const restored = await restoreCompany((await backupCompany(c.id)).file)
  assert.equal((await call('GET', `/companies/${restored.id}/ledgers`)).status, 401)
  assert.ok(await signIn(restored.id, 'owner', 'secret1'))
})

test('the role table', () => {
  assert.equal(allowed('Viewer', 'GET', '/vouchers'), true)
  assert.equal(allowed('Viewer', 'PUT', '/me/password'), true)
  assert.equal(allowed('Data Entry', 'POST', '/vouchers'), true)
  assert.equal(allowed('Data Entry', 'DELETE', '/vouchers/4'), false)
  assert.equal(allowed('Data Entry', 'PUT', '/reconciliation'), false)
  assert.equal(allowed('Accountant', 'DELETE', '/ledgers/9'), true)
  assert.equal(allowed('Accountant', 'POST', '/users'), false)
  assert.equal(allowed('Owner', 'DELETE', '/users/3'), true)
})

test('a security level of our own: a role less some voucher types and reports, and a limit on back-dating; it travels with a backup', async () => {
  setToday('2026-10-28')
  const c = await company()
  const at = `/companies/${c.id}`
  await call('POST', `${at}/users`, { username: 'owner', password: 'secret1', role: 'Owner' })
  const owner = await signIn(c.id, 'owner', 'secret1')
  const level = { name: 'Billing Clerk', baseRole: 'Data Entry', deniedVouchers: ['Payment', 'Journal'], deniedReports: ['profit-loss', 'gstr3b'], backDays: 3 }
  assert.equal((await call('POST', `${at}/users/levels`, { ...level, name: 'viewer' }, owner)).status, 422) // a predefined role's name
  const levelId = (await call('POST', `${at}/users/levels`, level, owner)).body.id
  await call('POST', `${at}/users`, { username: 'ravi', password: 'secret1', role: 'Data Entry', levelId }, owner)
  const ravi = await signIn(c.id, 'ravi', 'secret1')
  const ledgers: { id: number; name: string }[] = (await call('GET', `${at}/ledgers`, undefined, ravi)).body
  const cash = ledgers.find((l) => l.name === 'Cash')!.id
  const groups: { id: number; name: string }[] = (await call('GET', `${at}/groups`, undefined, owner)).body
  const sales = (await call('POST', `${at}/ledgers`, { name: 'Sales', groupId: groups.find((g) => g.name === 'Sales Accounts')!.id }, owner)).body.id
  const v = (type: string, date: string) => ({ type, date, entries: [{ ledgerId: cash, amount: 10000 }, { ledgerId: sales, amount: -10000 }] })
  assert.equal((await call('POST', `${at}/vouchers`, v('Receipt', '2026-10-27'), ravi)).status, 201)
  const pay = await call('POST', `${at}/vouchers`, v('Payment', '2026-10-27'), ravi)
  assert.deepEqual([pay.status, pay.body.error], [403, 'Billing Clerk may not enter Payment vouchers'])
  assert.match((await call('POST', `${at}/vouchers`, v('Receipt', '2026-10-20'), ravi)).body.error, /at most 3 day\(s\) back \(from 2026-10-25\)/)
  assert.equal((await call('GET', `${at}/reports/profit-loss?from=2026-04-01&to=2027-03-31`, undefined, ravi)).status, 403)
  assert.equal((await call('GET', `${at}/reports/trial-balance?from=2026-04-01&to=2027-03-31`, undefined, ravi)).status, 200)
  assert.equal((await call('DELETE', `${at}/users/levels/${levelId}`, undefined, owner)).status, 422) // in use
  assert.equal((await call('GET', `${at}/users/levels`, undefined, ravi)).status, 403) // the Owner's

  const { backupCompany, restoreCompany } = await import('../src/backup')
  const restored = await restoreCompany((await backupCompany(c.id)).file)
  const ravi2 = await signIn(restored.id, 'ravi', 'secret1')
  assert.equal((await call('POST', `/companies/${restored.id}/vouchers`, v('Journal', '2026-10-28'), ravi2)).status, 403)
  setToday(null)
})
